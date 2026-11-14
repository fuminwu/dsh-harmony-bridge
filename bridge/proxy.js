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
    if (HOP_BY_HOP.has(key) || key === 'content-encoding' || key === 'etag') continue;
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

  function buildUpstreamUrl(reqUrl) {
    const incoming = new URL(reqUrl, 'http://bridge.invalid');
    const target = new URL(upstream.href);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    if (config.dshToken && !target.searchParams.has('token')) {
      target.searchParams.set('token', config.dshToken);
    }
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
    const idx = html.toLowerCase().lastIndexOf('</head>');
    if (idx === -1) return Buffer.from(html, 'utf8');
    const patched = `${html.slice(0, idx)}${SHIM_TAG}${html.slice(idx)}`;
    return Buffer.from(patched, 'utf8');
  }

  function handleHttp(req, res) {
    const target = buildUpstreamUrl(req.url);
    const headers = buildHeaders(req, target, false);
    const upstreamReq = client.request(
      { hostname, port, method: req.method, path: `${target.pathname}${target.search}`, headers },
      (upstreamRes) => {
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
    const idle = setTimeout(() => upstreamReq.destroy(new Error('upstream_timeout')), 30000);
    idle.unref();
    upstreamReq.on('close', () => clearTimeout(idle));
    upstreamReq.on('error', () => sendUpstreamError(res));
    req.pipe(upstreamReq);
  }

  /** Raw TCP/WS tunnel: headers are rewritten, frames are never parsed. */
  function handleUpgrade(req, clientSocket, head) {
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

  return { handleHttp, handleUpgrade, buildUpstreamUrl, buildHeaders, injectShim, SHIM_TAG };
}
