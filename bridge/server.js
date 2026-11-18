import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createAuth } from './auth.js';
import { createNotifier } from './notify.js';
import { createProxy } from './proxy.js';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const STATIC = {
  '/__bridge/': ['index.html', 'text/html; charset=utf-8'],
  '/__bridge/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/__bridge/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/__bridge/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/__bridge/shim.js': ['mobile-shim.js', 'text/javascript; charset=utf-8'],
  '/__bridge/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/__bridge/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/__bridge/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
};

function loadStatic() {
  const cache = {};
  for (const [route, [file, type]] of Object.entries(STATIC)) {
    cache[route] = { body: fs.readFileSync(path.join(WEB_DIR, file)), type };
  }
  return cache;
}

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req, limit = 8192) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('payload_too_large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function originAllowed(req, config) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (config.origin) return origin === config.origin;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function createBridge(config, deps = {}) {
  const staticFiles = deps.staticFiles || loadStatic();
  const auth = createAuth({
    secret: config.secret,
    pairTtlMs: config.pairTtlMs,
    deviceTtlMs: config.deviceTtlMs,
    now: deps.now,
  });
  const notifier = createNotifier(config, deps.fetch);
  const proxy = createProxy(config, auth.COOKIE_NAME);

  async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://bridge.invalid');
    } catch {
      return json(res, 400, { error: 'bad_request' });
    }
    const pathname = url.pathname;

    if (Object.hasOwn(staticFiles, pathname)) {
      const file = staticFiles[pathname];
      res.writeHead(200, {
        'Content-Type': file.type,
        'Cache-Control': pathname.endsWith('sw.js') ? 'no-cache' : 'no-store',
        ...(pathname.endsWith('sw.js') ? { 'Service-Worker-Allowed': '/__bridge/' } : {}),
      });
      return res.end(req.method === 'HEAD' ? undefined : file.body);
    }

    if (pathname === '/__bridge/health') {
      return json(res, 200, {
        ok: true,
        pairCodePending: auth.hasPendingCode(),
        upstream: config.upstream.origin,
        upstreamTokenConfigured: Boolean(config.dshToken),
        webhookConfigured: Boolean(config.webhook),
      });
    }

    if (pathname === '/__bridge/config') {
      return json(res, 200, {
        autoOpen: config.autoOpen,
        notifySelectors: config.notifySelectors,
        webhookEnabled: Boolean(config.webhook),
        injection: config.inject !== false,
      });
    }

    if (pathname === '/__bridge/pair') {
      if (!originAllowed(req, config)) return json(res, 403, { error: 'origin_rejected' });
      let code = url.searchParams.get('code');
      if (req.method === 'POST') {
        try {
          const body = await readJson(req);
          code = body.code || code;
        } catch {
          return json(res, 400, { error: 'invalid_body' });
        }
      }
      const token = auth.exchange(code);
      if (!token) return json(res, 401, { error: 'invalid_or_expired_code' });
      return json(res, 200, { token, expiresIn: Math.floor(config.deviceTtlMs / 1000) }, {
        'Set-Cookie': auth.cookieFor(token, config.deviceTtlMs, Boolean(config.tlsCert && config.tlsKey)),
      });
    }

    if (pathname === '/__bridge/session') {
      if (!auth.isAuthorized(req, url)) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { ok: true });
    }

    if (pathname === '/__bridge/events') {
      if (!auth.isAuthorized(req, url)) return json(res, 401, { error: 'unauthorized' });
      const unsubscribe = notifier.subscribe(res);
      req.on('close', unsubscribe);
      return undefined;
    }

    if (pathname === '/__bridge/notify') {
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      if (!originAllowed(req, config)) return json(res, 403, { error: 'origin_rejected' });
      if (!auth.isAuthorized(req, url)) return json(res, 401, { error: 'unauthorized' });
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json(res, 400, { error: 'invalid_body' });
      }
      const result = await notifier.publish(body);
      return json(res, 202, { accepted: true, relayed: result.sent === true });
    }

    if (pathname.startsWith('/__bridge/')) {
      return json(res, 404, { error: 'not_found' });
    }

    if (!auth.isAuthorized(req, url)) {
      res.writeHead(302, {
        Location: '/__bridge/',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    return proxy.handleHttp(req, res);
  }

  const options = (config.tlsCert && config.tlsKey)
    ? { cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }
    : null;
  const server = options ? https.createServer(options, handler) : http.createServer(handler);

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://bridge.invalid');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname.startsWith('/__bridge/') || !originAllowed(req, config) || !auth.isAuthorized(req, url)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    proxy.handleUpgrade(req, socket, head).catch(() => socket.destroy());
  });

  return { server, auth, notifier, proxy, config, staticFiles };
}

export function start(config = loadConfig()) {
  const bridge = createBridge(config);
  const { server, auth } = bridge;
  server.listen(config.port, config.bind, () => {
    const scheme = config.tlsCert ? 'https' : 'http';
    const lan = config.bind === '127.0.0.1' ? ' (local only)' : '';
    process.stdout.write(`\n  dsh-harmony-bridge\n`);
    process.stdout.write(`  address   ${scheme}://${config.bind}:${config.port}/__bridge/${lan}\n`);
    process.stdout.write(`  upstream  ${config.upstream.origin}\n`);
    process.stdout.write(`  pair code ${auth.pairCode()}\n`);
    process.stdout.write(`  webhook   ${config.webhook ? 'configured' : 'off'}\n\n`);
    process.stdout.write('  Open the address on your phone and enter this one-time code.\n');
    process.stdout.write('  The code expires in 5 minutes and can be used once.\n\n');
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return bridge;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
