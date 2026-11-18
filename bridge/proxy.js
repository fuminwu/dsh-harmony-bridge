import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const HOP_BY_HOP = new Set([
  'proxy-connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
  'proxy-authenticate', 'proxy-authorization', 'connection', 'upgrade',
]);
const SHIM_TAG = '<script src="/__bridge/shim.js" defer data-dshb="1"></script>';

function stripBridgeCookie(header, cookieName) {
  if (typeof header !== 'string') return '';
  return header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${cookieName}=`))
    .join('; ');
}

function cleanResponseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key) || key === 'content-encoding' || key === 'etag' || key === 'set-cookie') continue;
    out[key] = value;
  }
  return out;
}

export function createProxy(config, cookieName) {
  const upstream = config.upstream;
  const isTls = upstream.protocol === 'https:';
  const port = Number(upstream.port || (isTls ? 443 : 80));
  const hostname = upstream.hostname;
  const client = isTls ? https : http;

  // DSH exchanges the launch token for a session cookie on GET /?token=…; the
  // bridge performs that exchange once, keeps the cookie jar, and never hands
  // upstream cookies (or the token) to the phone.
  const jar = new Map();
  let exchangePromise = null;
  const EXCHANGE_TIMEOUT_MS = 10000;
  const RESPONSE_TIMEOUT_MS = 120000;
  const SOCKET_IDLE_MS = 5 * 60 * 1000;

  function absorbCookies(setCookie) {
    if (!setCookie) return;
    for (const raw of [].concat(setCookie)) {
      const pair = String(raw).split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  function jarCookie() {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function fetchUpstreamCookie() {
    if (!config.dshToken || exchangePromise) return exchangePromise || Promise.resolve(false);
    exchangePromise = new Promise((resolve) => {
      const tokenUrl = new URL(upstream.href);
      tokenUrl.searchParams.set('token', config.dshToken);
      const req = client.request({
        hostname,
        port,
        method: 'GET',
        path: `${tokenUrl.pathname}${tokenUrl.search}`,
        headers: { host: upstream.host, 'accept-encoding': 'identity' },
      }, (res) => {
        absorbCookies(res.headers['set-cookie']);
        res.resume();
        res.on('end', () => resolve(jar.size > 0));
      });
      req.on('error', () => resolve(false));
      req.setTimeout(EXCHANGE_TIMEOUT_MS, () => req.destroy(new Error('exchange_timeout')));
      req.end();
    }).finally(() => { exchangePromise = null; });
    return exchangePromise;
  }

  function buildUpstreamUrl(reqUrl) {
    const incoming = new URL(reqUrl, 'http://bridge.invalid');
    const target = new URL(upstream.href);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    // The device token belongs to the bridge; never leak it upstream.
    target.searchParams.delete('dshb_token');
    return target;
  }

  function buildHeaders(req, target, forUpgrade) {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (key === 'host' || key === 'accept-encoding' || key === 'authorization') continue;
      if (key === 'cookie') {
        const kept = stripBridgeCookie(value, cookieName);
        if (kept) headers.cookie = kept;
        continue;
      }
      if (key === 'content-length') { headers['content-length'] = value; continue; }
      if (forUpgrade && (key === 'connection' || key === 'upgrade' || key.startsWith('sec-websocket'))) {
        headers[key] = value;
        continue;
      }
      if (HOP_BY_HOP.has(key)) continue;
      headers[key] = value;
    }
    const upstreamCookie = jarCookie();
    if (upstreamCookie) headers.cookie = headers.cookie ? `${headers.cookie}; ${upstreamCookie}` : upstreamCookie;
    headers.host = target.host;
    if (!forUpgrade) headers['accept-encoding'] = 'identity';
    return headers;
  }

  function sendUpstreamError(res) {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'upstream_unavailable' }));
  }

  async function readBodyWithLimit(stream, limit) {
    const chunks = [];
    let size = 0;
    let overflow = false;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > limit) overflow = true;
      if (!overflow) chunks.push(chunk);
    }
    return { overflow, buffer: overflow ? null : Buffer.concat(chunks) };
  }

  function injectShim(buffer) {
    const html = buffer.toString('utf8');
    const match = /<head\b[^>]*>/i.exec(html);
    if (!match) return Buffer.from(html, 'utf8');
    const idx = match.index + match[0].length;
    const patched = `${html.slice(0, idx)}${SHIM_TAG}${html.slice(idx)}`;
    return Buffer.from(patched, 'utf8');
  }

  async function handleHttp(req, res) {
    if (config.dshToken && jar.size === 0) await fetchUpstreamCookie();
    forwardHttp(req, res, 0);
  }

  function forwardHttp(req, res, attempt) {
    const target = buildUpstreamUrl(req.url);
    const headers = buildHeaders(req, target, false);
    const upstreamReq = client.request(
      { hostname, port, method: req.method, path: `${target.pathname}${target.search}`, headers },
      (upstreamRes) => {
        clearTimeout(responseTimer);
        absorbCookies(upstreamRes.headers['set-cookie']);
        if (config.dshToken && jar.size > 0 && upstreamRes.statusCode === 401 && attempt < 1
          && (req.method === 'GET' || req.method === 'HEAD')) {
          upstreamRes.resume();
          jar.clear();
          fetchUpstreamCookie().then(() => {
            if (!res.headersSent && !res.destroyed) forwardHttp(req, res, attempt + 1);
          });
          return;
        }
        const contentType = String(upstreamRes.headers['content-type'] || '');
        const injectable = config.inject !== false
          && req.method !== 'HEAD'
          && contentType.toLowerCase().includes('text/html');

        if (!injectable) {
          res.writeHead(upstreamRes.statusCode || 502, cleanResponseHeaders(upstreamRes.headers));
          upstreamRes.pipe(res);
          return;
        }

        readBodyWithLimit(upstreamRes, MAX_HTML_BYTES)
          .then(({ overflow, buffer }) => {
            if (res.writableEnded) return;
            const outHeaders = cleanResponseHeaders(upstreamRes.headers);
            delete outHeaders['content-length'];
            if (overflow || !buffer) {
              res.writeHead(upstreamRes.statusCode || 502, outHeaders);
              if (buffer) res.end(buffer);
              else res.end();
              return;
            }
            const body = injectShim(buffer);
            outHeaders['content-length'] = String(body.length);
            res.writeHead(upstreamRes.statusCode || 200, outHeaders);
            res.end(body);
          })
          .catch(() => sendUpstreamError(res));
      },
    );
    // Only the wait for response headers is bounded; slow bodies are not.
    const responseTimer = setTimeout(() => upstreamReq.destroy(new Error('upstream_timeout')), RESPONSE_TIMEOUT_MS);
    responseTimer.unref();
    upstreamReq.on('close', () => clearTimeout(responseTimer));
    upstreamReq.setTimeout(SOCKET_IDLE_MS, () => upstreamReq.destroy(new Error('upstream_idle')));
    upstreamReq.on('error', () => sendUpstreamError(res));
    req.pipe(upstreamReq);
  }

  /** Raw TCP/WS tunnel: headers are rewritten, frames are never parsed. */
  async function handleUpgrade(req, clientSocket, head) {
    if (config.dshToken && jar.size === 0) await fetchUpstreamCookie();
    if (clientSocket.destroyed) return;
    const target = buildUpstreamUrl(req.url);
    const headers = buildHeaders(req, target, true);
    const requestLines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`];
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const v of value) requestLines.push(`${key}: ${v}`);
      else requestLines.push(`${key}: ${value}`);
    }
    requestLines.push('', '');
    const handshake = Buffer.from(requestLines.join('\r\n'), 'utf8');

    const options = { host: hostname, port, rejectUnauthorized: true };
    const upstreamSocket = isTls
      ? tls.connect(options)
      : net.connect(options);

    const teardown = () => {
      clientSocket.destroy();
      upstreamSocket.destroy();
    };
    // Unref'd idle timer: resets on traffic, and never keeps a test/CLI process alive.
    const IDLE_MS = 5 * 60 * 1000;
    let idle = null;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(teardown, IDLE_MS);
      idle.unref();
    };
    armIdle();
    upstreamSocket.on('error', teardown);
    clientSocket.on('error', teardown);
    clientSocket.on('data', armIdle);
    upstreamSocket.on('data', armIdle);
    clientSocket.on('close', () => { clearTimeout(idle); upstreamSocket.destroy(); });
    upstreamSocket.on('close', () => { clearTimeout(idle); clientSocket.destroy(); });

    upstreamSocket.once(isTls ? 'secureConnect' : 'connect', () => {
      upstreamSocket.write(handshake);
      if (head && head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
  }

  return { handleHttp, handleUpgrade, buildUpstreamUrl, buildHeaders, injectShim, fetchUpstreamCookie, SHIM_TAG };
}
