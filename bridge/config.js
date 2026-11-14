import { randomBytes } from 'node:crypto';

const DEFAULT_PAIR_TTL_MS = 5 * 60 * 1000;
const DEFAULT_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`invalid port value: ${value}`);
  }
  return n;
}

function parseUpstream(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`DSHB_UPSTREAM must be an absolute URL, got: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('DSHB_UPSTREAM must use http: or https:');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('DSHB_UPSTREAM must not contain a path prefix');
  }
  return url;
}

/**
 * All secrets come from the environment or are generated at startup.
 * Nothing is read from or written to the user's DSH home directory.
 */
export function loadConfig(env = process.env, secret = randomBytes(32)) {
  const upstream = parseUpstream(env.DSHB_UPSTREAM || 'http://127.0.0.1:3080');
  const cfg = {
    bind: env.DSHB_BIND || '127.0.0.1',
    port: parsePositiveInt(env.DSHB_PORT, 3443),
    upstream,
    dshToken: env.DSHB_DSH_TOKEN || '',
    webhook: env.DSHB_WEBHOOK || '',
    webhookKind: env.DSHB_WEBHOOK_KIND || 'auto',
    webhookTemplate: env.DSHB_WEBHOOK_TEMPLATE || '',
    pairTtlMs: DEFAULT_PAIR_TTL_MS,
    deviceTtlMs: DEFAULT_DEVICE_TTL_MS,
    secret,
    tlsCert: env.DSHB_TLS_CERT || '',
    tlsKey: env.DSHB_TLS_KEY || '',
    origin: env.DSHB_ORIGIN || '',
    autoOpen: env.DSHB_AUTO_OPEN === '1',
    inject: env.DSHB_INJECT !== '0',
    notifySelectors: env.DSHB_NOTIFY_SELECTORS || '',
  };
  if ((cfg.tlsCert && !cfg.tlsKey) || (!cfg.tlsCert && cfg.tlsKey)) {
    throw new Error('DSHB_TLS_CERT and DSHB_TLS_KEY must be set together');
  }
  if (cfg.webhook) {
    try {
      const u = new URL(cfg.webhook);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        throw new Error('unsupported protocol');
      }
    } catch {
      throw new Error('DSHB_WEBHOOK must be an absolute http(s) URL');
    }
  }
  return cfg;
}

export const PUBLIC_CONFIG_KEYS = ['autoOpen', 'notifySelectors', 'webhookKind'];
