import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_VERSION = 1;
const COOKIE_NAME = 'dshb_device';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest();
}

/**
 * Pairing is a one-shot, short-lived code printed to the operator's terminal.
 * A successful exchange issues an independent device token; the upstream DSH
 * token never leaves the host process.
 */
export function createAuth({ secret, pairTtlMs, deviceTtlMs, now = () => Date.now() }) {
  let pending = {
    code: b64url(randomBytes(6)),
    expiresAt: now() + pairTtlMs,
  };

  function pairCode() {
    if (pending && pending.expiresAt <= now()) {
      pending = { code: b64url(randomBytes(6)), expiresAt: now() + pairTtlMs };
    }
    return pending ? pending.code : null;
  }

  function hasPendingCode() {
    return Boolean(pending) && pending.expiresAt > now();
  }

  function exchange(code) {
    if (!pending || !code || pending.expiresAt <= now()) return null;
    const expected = Buffer.from(pending.code);
    const given = Buffer.from(String(code));
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    pending = null;
    return issueDeviceToken();
  }

  function issueDeviceToken() {
    const payload = b64url(JSON.stringify({ v: TOKEN_VERSION, exp: now() + deviceTtlMs }));
    const mac = b64url(sign(secret, payload));
    return `${payload}.${mac}`;
  }

  function verify(token) {
    if (typeof token !== 'string') return false;
    const dot = token.indexOf('.');
    if (dot < 1) return false;
    const payload = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    let expected;
    let given;
    try {
      expected = sign(secret, payload);
      given = Buffer.from(mac, 'base64url');
    } catch {
      return false;
    }
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return claims.v === TOKEN_VERSION && typeof claims.exp === 'number' && claims.exp > now();
    } catch {
      return false;
    }
  }

  function readToken(req, url) {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice(7).trim();
    }
    const fromQuery = url.searchParams.get('dshb_token');
    if (fromQuery) return fromQuery;
    const cookie = req.headers.cookie || '';
    for (const part of cookie.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === COOKIE_NAME) return rest.join('=');
    }
    return null;
  }

  function isAuthorized(req, url) {
    return verify(readToken(req, url));
  }

  function cookieFor(token, maxAgeMs, secure = false) {
    const secureFlag = secure ? '; Secure' : '';
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secureFlag}`;
  }

  return { pairCode, hasPendingCode, exchange, issueDeviceToken, verify, isAuthorized, readToken, cookieFor, COOKIE_NAME };
}
