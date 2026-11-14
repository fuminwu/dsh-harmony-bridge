(() => {
  const $ = (id) => document.getElementById(id);
  const pairCard = $('pairCard');
  const mainCard = $('mainCard');
  const pairMsg = $('pairMsg');
  const statusList = $('status');
  const events = $('events');
  const eventHint = $('eventHint');
  let source = null;

  function setMsg(text, bad = false) {
    pairMsg.textContent = text || '';
    pairMsg.classList.toggle('bad', bad);
  }

  function showConnected() {
    pairCard.hidden = true;
    mainCard.hidden = false;
  }

  function showPair() {
    pairCard.hidden = false;
    mainCard.hidden = true;
  }

  async function loadStatus() {
    try {
      const health = await fetch('/__bridge/health', { cache: 'no-store' }).then((r) => r.json());
      const cfg = await fetch('/__bridge/config', { cache: 'no-store' }).then((r) => r.json());
      statusList.replaceChildren();
      const rows = [
        ['上游 / upstream', health.upstream],
        ['上游 token / upstream token', health.upstreamTokenConfigured ? '电脑侧保管' : '未配置'],
        ['锁屏推送 / webhook', health.webhookConfigured ? '已配置' : '未配置'],
        ['界面适配 / injection', cfg.injection ? '开启' : '关闭'],
      ];
      for (const [k, v] of rows) {
        const li = document.createElement('li');
        li.textContent = `${k}：${v}`;
        statusList.appendChild(li);
      }
    } catch {
      statusList.textContent = '状态读取失败';
    }
  }

  function addEvent(evt) {
    const li = document.createElement('li');
    const time = new Date(evt.ts || Date.now()).toLocaleTimeString();
    li.textContent = `[${time}] ${evt.title || 'DSH'} — ${evt.body || evt.kind || ''}`;
    events.prepend(li);
    while (events.children.length > 20) events.lastChild.remove();
    eventHint.textContent = '最近事件 / recent events';
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification(evt.title || 'DSH', { body: evt.body || '' }); } catch { /* no-op */ }
    }
  }

  function connectEvents() {
    if (source) source.close();
    if (typeof EventSource === 'undefined') return;
    source = new EventSource('/__bridge/events');
    source.addEventListener('dsh', (e) => {
      try { addEvent(JSON.parse(e.data)); } catch { /* no-op */ }
    });
    source.onerror = () => { source.close(); };
  }

  $('pairForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('code').value.trim();
    if (!code) return;
    setMsg('正在配对…');
    try {
      const resp = await fetch('/__bridge/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setMsg(`配对失败：${data.error || resp.status}。请核对终端里的码是否已过期。`, true);
        return;
      }
      setMsg('配对成功');
      showConnected();
      await loadStatus();
      connectEvents();
    } catch {
      setMsg('连不上桥，请确认电脑端进程还在运行。', true);
    }
  });

  $('testNotify').addEventListener('click', async () => {
    try {
      await fetch('/__bridge/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'test', title: 'DSH Bridge', body: '测试通知 / test event' }),
      });
      setMsg('');
    } catch { /* no-op */ }
  });

  $('forget').addEventListener('click', () => {
    document.cookie = 'dshb_device=; Path=/; Max-Age=0; SameSite=Strict';
    showPair();
    setMsg('已清除。需要重新用终端里的新配对码连接。');
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/__bridge/sw.js', { scope: '/__bridge/' }).catch(() => {});
  }

  async function boot() {
    try {
      const [session, cfg] = await Promise.all([
        fetch('/__bridge/session', { cache: 'no-store' }),
        fetch('/__bridge/config', { cache: 'no-store' }).then((r) => r.json()),
      ]);
      if (!session.ok) { showPair(); return; }
      showConnected();
      loadStatus();
      connectEvents();
      const stay = new URLSearchParams(location.search).has('stay');
      if (cfg.autoOpen && !stay && !sessionStorage.getItem('dshb-auto-open')) {
        sessionStorage.setItem('dshb-auto-open', '1');
        location.replace('/');
      }
    } catch {
      showPair();
    }
  }

  boot();
})();
