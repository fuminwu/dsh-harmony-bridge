const MAX_TEXT = 4000;

function clip(value, limit = 300) {
  const s = typeof value === 'string' ? value : String(value ?? '');
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

function detectKind(webhook) {
  if (webhook.includes('qyapi.weixin.qq.com')) return 'wecom';
  if (webhook.includes('open.feishu.cn') || webhook.includes('open.larksuite.com')) return 'feishu';
  if (webhook.includes('oapi.dingtalk.com')) return 'dingtalk';
  return 'generic';
}

function buildPayload(kind, event, template) {
  const title = clip(event.title || 'DSH', 120);
  const body = clip(event.body || event.kind || 'event', MAX_TEXT);
  const text = `${title}\n${body}`;
  if (template) {
    const rendered = template
      .replaceAll('{title}', JSON.stringify(title).slice(1, -1))
      .replaceAll('{body}', JSON.stringify(body).slice(1, -1))
      .replaceAll('{kind}', JSON.stringify(clip(event.kind, 40)).slice(1, -1));
    try {
      return JSON.parse(rendered);
    } catch {
      return { title, body, kind: clip(event.kind, 40) };
    }
  }
  switch (kind) {
    case 'wecom':
    case 'dingtalk':
      return { msgtype: 'text', text: { content: text } };
    case 'feishu':
      return { msg_type: 'text', content: { text } };
    default:
      return { title, body, kind: clip(event.kind, 40), ts: Date.now() };
  }
}

export function createNotifier(config, fetchImpl = globalThis.fetch) {
  const clients = new Set();
  const kind = config.webhookKind === 'auto'
    ? (config.webhook ? detectKind(config.webhook) : 'generic')
    : config.webhookKind;

  function subscribe(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    clients.add(res);
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 25000);
    ping.unref?.();
    return () => {
      clearInterval(ping);
      clients.delete(res);
    };
  }

  function broadcast(event) {
    const data = JSON.stringify(event);
    for (const res of clients) {
      if (!res.writableEnded) res.write(`event: dsh\ndata: ${data}\n\n`);
    }
  }

  async function deliver(event) {
    if (!config.webhook) return { sent: false, reason: 'not_configured' };
    const payload = buildPayload(kind, event, config.webhookTemplate);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const resp = await fetchImpl(config.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      return { sent: resp.ok, status: resp.status };
    } catch (err) {
      return { sent: false, reason: String(err?.message || err) };
    }
  }

  async function publish(raw) {
    const event = {
      kind: clip(raw?.kind || 'notice', 40),
      title: clip(raw?.title || 'DSH', 120),
      body: clip(raw?.body || '', MAX_TEXT),
      ts: Date.now(),
    };
    broadcast(event);
    const result = await deliver(event);
    return { event, ...result };
  }

  return { subscribe, broadcast, publish, buildPayload, kind, clientCount: () => clients.size };
}
