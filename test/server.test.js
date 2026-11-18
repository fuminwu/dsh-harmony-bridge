import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { loadConfig } from '../bridge/config.js';
import { createAuth } from '../bridge/auth.js';
import { createNotifier } from '../bridge/notify.js';
import { createProxy } from '../bridge/proxy.js';
import { createBridge } from '../bridge/server.js';

const STATIC = {
  '/__bridge/': { body: Buffer.from('<html><head></head><body>shell</body></html>'), type: 'text/html' },
  '/__bridge/shim.js': { body: Buffer.from('/* shim */'), type: 'text/javascript' },
};

function makeConfig(overrides = {}) {
  const cfg = loadConfig({
    DSHB_UPSTREAM: 'http://127.0.0.1:3080',
    DSHB_DSH_TOKEN: 'upstream-secret',
  });
  return { ...cfg, ...overrides };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function startUpstream(handlers = {}) {
  const server = http.createServer((req, res) => {
    if (handlers.onRequest) return handlers.onRequest(req, res);
    if (req.url.includes('token=')) {
      res.writeHead(303, {
        location: './',
        'set-cookie': ['dsh-session=mock-session; Path=/; HttpOnly; SameSite=Strict'],
      });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>DSH</title></head><body>mock dsh</body></html>');
  });
  const upgraded = new Set();
  server.on('upgrade', (req, socket) => {
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    if (handlers.onUpgrade) return handlers.onUpgrade(req, socket);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${req.headers['sec-websocket-key'] || ''}\r\n\r\n`,
    );
  });
  server.upgradedSockets = upgraded;
  return server;
}

test('auth: pair code is single-use and expiring', () => {
  let now = 1_000_000;
  const auth = createAuth({
    secret: Buffer.from('test-secret'),
    pairTtlMs: 1000,
    deviceTtlMs: 5000,
    now: () => now,
  });
  const code = auth.pairCode();
  assert.equal(auth.hasPendingCode(), true, 'a fresh code is pending');
  assert.equal(auth.exchange('wrong'), null);
  assert.equal(auth.verify(auth.exchange(code)), true);
  assert.equal(auth.exchange(code), null, 'a code must not be reusable');
  assert.equal(auth.hasPendingCode(), false, 'no pending code after a successful exchange');
  assert.equal(auth.pairCode(), null, 'no code is issued after a successful exchange');

  const expired = createAuth({
    secret: Buffer.from('test-secret'), pairTtlMs: 1000, deviceTtlMs: 5000, now: () => now,
  });
  const stale = expired.pairCode();
  now += 2000;
  assert.equal(expired.exchange(stale), null, 'an expired code must be rejected');
  assert.notEqual(expired.pairCode(), stale, 'a fresh code is issued after expiry');
});

test('auth: tampered and expired device tokens are rejected', () => {
  let now = 1_000_000;
  const auth = createAuth({
    secret: Buffer.from('test-secret'),
    pairTtlMs: 1000,
    deviceTtlMs: 2000,
    now: () => now,
  });
  const token = auth.issueDeviceToken();
  assert.equal(auth.verify(token), true);
  const [payload, mac] = token.split('.');
  assert.equal(auth.verify(`${payload}.AAAA${mac.slice(4)}`), false);
  assert.equal(auth.verify('garbage'), false);
  now += 3000;
  assert.equal(auth.verify(token), false);
});

test('notifier: builds native payloads and publishes to subscribers', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const notifier = createNotifier(
    { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x', webhookKind: 'auto', webhookTemplate: '' },
    fetchImpl,
  );
  assert.equal(notifier.kind, 'wecom');
  const wecom = notifier.buildPayload('wecom', { title: 'T', body: 'B', kind: 'approval' }, '');
  assert.equal(wecom.msgtype, 'text');
  assert.match(wecom.text.content, /T\nB/);

  const chunks = [];
  const fakeRes = { writableEnded: false, writeHead() {}, write: (s) => chunks.push(s) };
  const unsubscribe = notifier.subscribe(fakeRes);
  const result = await notifier.publish({ kind: 'approval', title: 'approve?', body: 'run command' });
  unsubscribe();
  assert.equal(result.sent, true);
  assert.equal(calls.length, 1);
  assert.ok(chunks.some((c) => c.includes('approve?')), 'SSE subscribers receive the event');
  assert.equal(notifier.clientCount(), 0);
});

test('proxy: rewrites URL, strips bridge cookie, injects shim', () => {
  const cfg = makeConfig();
  const proxy = createProxy(cfg, 'dshb_device');
  const target = proxy.buildUpstreamUrl('/api/session?x=1&dshb_token=device');
  assert.equal(target.pathname, '/api/session');
  assert.equal(target.searchParams.get('token'), null, 'token is exchanged once, not injected per request');
  assert.equal(target.searchParams.get('dshb_token'), null, 'device token must not leak upstream');
  assert.equal(target.searchParams.get('x'), '1');

  const headers = proxy.buildHeaders({
    headers: {
      host: '127.0.0.1:3443',
      cookie: 'dshb_device=abc; dsh_sid=keep-me',
      authorization: 'Bearer device',
      'accept-encoding': 'gzip',
      'content-type': 'application/json',
    },
  }, target, false);
  assert.equal(headers.cookie, 'dsh_sid=keep-me');
  assert.equal(headers.authorization, undefined);
  assert.equal(headers['accept-encoding'], 'identity');
  assert.equal(headers.host, target.host);

  const injected = proxy.injectShim(Buffer.from('<HTML><HEAD></HEAD><BODY>x</BODY></HTML>')).toString();
  assert.ok(injected.includes(proxy.SHIM_TAG));
  assert.ok(injected.includes('</HEAD>'));
  const untouched = proxy.injectShim(Buffer.from('<p>no head</p>')).toString();
  assert.equal(untouched, '<p>no head</p>');
});

async function withBridge(t, { configOverrides = {}, upstreamHandlers = {}, deps = {} } = {}) {
  const upstream = startUpstream(upstreamHandlers);
  const upstreamPort = await listen(upstream);
  t.after(() => {
    for (const socket of upstream.upgradedSockets) socket.destroy();
    upstream.close();
  });
  const cfg = makeConfig({ upstream: new URL(`http://127.0.0.1:${upstreamPort}`), ...configOverrides });
  const bridge = createBridge(cfg, { staticFiles: STATIC, ...deps });
  const port = await listen(bridge.server);
  t.after(() => bridge.server.close());
  return { base: `http://127.0.0.1:${port}`, bridge, cfg };
}

test('server: health, pairing, authorization and HTML injection', async (t) => {
  const upstreamReq = [];
  const { base, bridge } = await withBridge(t, {
    upstreamHandlers: {
      onRequest: (req, res) => {
        upstreamReq.push({ url: req.url, cookie: req.headers.cookie });
        if (req.url.includes('token=')) {
          res.writeHead(303, {
            location: './',
            'set-cookie': ['dsh-session=mock-session; Path=/; HttpOnly; SameSite=Strict'],
          });
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head></head><body>mock dsh</body></html>');
      },
    },
  });

  const health = await fetch(`${base}/__bridge/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.upstreamTokenConfigured, true);
  assert.equal(health.upstream.startsWith('http://127.0.0.1:'), true);
  assert.ok(!JSON.stringify(health).includes('upstream-secret'), 'upstream token must never be exposed');

  const shell = await fetch(`${base}/__bridge/`);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /shell/);

  const unauth = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(unauth.status, 302);
  assert.equal(unauth.headers.get('location'), '/__bridge/');

  const badPair = await fetch(`${base}/__bridge/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'nope' }),
  });
  assert.equal(badPair.status, 401);

  const code = bridge.auth.pairCode();
  const paired = await fetch(`${base}/__bridge/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
  });
  assert.equal(paired.status, 200);
  const cookie = paired.headers.get('set-cookie');
  assert.match(cookie, /dshb_device=/);
  assert.match(cookie, /HttpOnly/);

  const session = await fetch(`${base}/__bridge/session`, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(session.status, 200);

  const page = await fetch(`${base}/`, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /mock dsh/);
  assert.match(html, /__bridge\/shim\.js/);
  assert.equal(upstreamReq.length, 2, 'one token exchange plus one page request');
  assert.match(upstreamReq[0].url, /token=upstream-secret/, 'the bridge performs the token exchange itself');
  assert.equal(upstreamReq[0].cookie, undefined, 'the exchange carries no cookie');
  assert.equal(upstreamReq[1].url, '/', 'the page request carries no token');
  assert.match(upstreamReq[1].cookie, /dsh-session=mock-session/, 'the bridge jar holds the session cookie');
  assert.ok(!upstreamReq[1].cookie.includes('upstream-secret'));
  assert.ok(!upstreamReq[1].cookie.includes('dshb_device'), 'bridge cookie must not reach DSH');
});

test('server: notify relays to webhook and rejects foreign origins', async (t) => {
  const calls = [];
  const { base, bridge } = await withBridge(t, {
    configOverrides: { webhook: 'https://example.com/hook' },
    deps: {
      fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; },
    },
  });
  const token = bridge.auth.issueDeviceToken();
  const cookie = `dshb_device=${token}`;

  const ok = await fetch(`${base}/__bridge/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ kind: 'approval', title: 'approve?', body: 'run ls' }),
  });
  assert.equal(ok.status, 202);
  assert.equal((await ok.json()).relayed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.com/hook');

  const foreign = await fetch(`${base}/__bridge/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, origin: 'https://evil.example' },
    body: JSON.stringify({ kind: 'test' }),
  });
  assert.equal(foreign.status, 403);
  assert.equal(calls.length, 1, 'rejected request must not reach the webhook');

  const noAuth = await fetch(`${base}/__bridge/notify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'test' }),
  });
  assert.equal(noAuth.status, 401);
});

test('server: every real static asset is served from disk', async (t) => {
  const upstream = startUpstream();
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const cfg = makeConfig({ upstream: new URL(`http://127.0.0.1:${upstreamPort}`) });
  const bridge = createBridge(cfg); // no staticFiles override: exercises loadStatic()
  const port = await listen(bridge.server);
  t.after(() => bridge.server.close());

  const routes = [
    '/__bridge/', '/__bridge/index.html', '/__bridge/app.js', '/__bridge/style.css',
    '/__bridge/shim.js', '/__bridge/manifest.webmanifest', '/__bridge/icon.svg', '/__bridge/sw.js',
  ];
  for (const route of routes) {
    const resp = await fetch(`http://127.0.0.1:${port}${route}`);
    assert.equal(resp.status, 200, route);
    assert.ok((await resp.arrayBuffer()).byteLength > 0, route);
  }
  const sw = await fetch(`http://127.0.0.1:${port}/__bridge/sw.js`);
  assert.equal(sw.headers.get('service-worker-allowed'), '/__bridge/');
});

test('server: websocket upgrade is tunneled to upstream', async (t) => {
  let upgradeSeen = null;
  const { base, bridge } = await withBridge(t, {
    upstreamHandlers: {
      onUpgrade: (req, socket) => {
        upgradeSeen = { url: req.url, key: req.headers['sec-websocket-key'], cookie: req.headers.cookie };
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
        );
      },
    },
  });
  const token = bridge.auth.issueDeviceToken();
  const port = Number(new URL(base).port);

  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        'GET /api/stream HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        `Cookie: dshb_device=${token}\r\n\r\n`,
      );
    });
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) { socket.destroy(); resolve(buf); }
    });
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); reject(new Error('upgrade timeout')); }, 3000).unref();
  });

  assert.match(response, /101 Switching Protocols/);
  assert.ok(upgradeSeen, 'upstream received the upgrade');
  assert.ok(!String(upgradeSeen.url).includes('token='), 'no token in the upgrade URL');
  assert.match(upgradeSeen.cookie, /dsh-session=mock-session/, 'upgrade carries the bridge-managed session cookie');
  assert.ok(!/dshb_device/.test(upgradeSeen.cookie), 'bridge cookie stripped from upgrade too');
});
