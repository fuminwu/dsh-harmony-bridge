/* Injected into the upstream DSH Web UI. Observes only; never intercepts DSH traffic. */
(() => {
  if (window.__dshbShim) return;
  window.__dshbShim = true;

  const APPROVAL_WORDS = /批准|允许|同意|确认|approve|allow|confirm|permit/i;
  const COOLDOWN_MS = 30000;
  const seen = new WeakSet();
  let lastSent = 0;
  let extraSelectors = '';

  const style = document.createElement('style');
  style.setAttribute('data-dshb', 'style');
  style.textContent = `
    @media (max-width: 820px) {
      html { -webkit-text-size-adjust: 100%; }
      body { overflow-x: hidden; }
      input, textarea, select, [contenteditable="true"] { font-size: 16px; }
      button, [role="button"], a.btn { min-height: 40px; }
      pre, code { max-width: 100%; overflow-x: auto; }
    }
    .dshb-fold { max-height: 13rem; overflow: hidden; position: relative; }
    .dshb-fold::after {
      content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 3rem;
      background: linear-gradient(transparent, rgba(127,127,127,.18)); pointer-events: none;
    }
    .dshb-more {
      display: block; margin: .35rem 0 .75rem; padding: .4rem .75rem; min-height: 40px;
      font: inherit; font-size: 13px; cursor: pointer; border-radius: 8px;
      border: 1px solid rgba(127,127,127,.45); background: rgba(127,127,127,.10); color: inherit;
    }
    .dshb-home {
      position: fixed; right: 12px; bottom: calc(12px + env(safe-area-inset-bottom)); z-index: 2147483000;
      width: 44px; height: 44px; border-radius: 50%; border: 1px solid rgba(127,127,127,.5);
      background: rgba(28,32,40,.88); color: #fff; font-size: 18px; line-height: 1; cursor: pointer;
      display: grid; place-items: center;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  function report(kind, title, body) {
    const now = Date.now();
    if (now - lastSent < 2500) return;
    lastSent = now;
    fetch('/__bridge/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ kind, title, body: String(body || '').slice(0, 300) }),
    }).catch(() => {});
  }

  function foldLongBlocks(root) {
    if (!window.matchMedia('(max-width: 820px)').matches) return;
    const blocks = (root || document).querySelectorAll('pre');
    for (const pre of blocks) {
      if (pre.dataset.dshbFolded || pre.closest('[data-dshb]')) continue;
      const lines = (pre.textContent || '').split('\n').length;
      if (lines < 24) continue;
      pre.dataset.dshbFolded = '1';
      pre.classList.add('dshb-fold');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dshb-more';
      button.textContent = `展开全部 ${lines} 行 / show all`;
      button.addEventListener('click', () => {
        const folded = pre.classList.toggle('dshb-fold');
        button.textContent = folded ? `展开全部 ${lines} 行 / show all` : '收起 / collapse';
      });
      pre.after(button);
    }
  }

  function scan(root) {
    const scope = root && root.querySelectorAll ? root : document;
    let candidates = [];
    try {
      candidates = scope.querySelectorAll('button:not([disabled]), [role="button"]');
    } catch { return; }
    for (const el of candidates) {
      if (seen.has(el) || el.closest('[data-dshb]')) continue;
      const label = (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 120);
      if (label && APPROVAL_WORDS.test(label)) {
        seen.add(el);
        report('approval', 'DSH 等待审批 / approval needed', label);
      }
    }
    if (extraSelectors) {
      try {
        for (const el of scope.querySelectorAll(extraSelectors)) {
          if (seen.has(el)) continue;
          seen.add(el);
          const label = (el.textContent || '').trim().slice(0, 200);
          if (label) report('custom', 'DSH 通知 / custom event', label);
        }
      } catch { /* invalid selector is ignored on purpose */ }
    }
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        scan(node);
        foldLongBlocks(node);
      }
    }
    scan(document);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  const home = document.createElement('button');
  home.type = 'button';
  home.className = 'dshb-home';
  home.setAttribute('data-dshb', 'home');
  home.setAttribute('aria-label', '返回 bridge 首页');
  home.textContent = '⌂';
  home.addEventListener('click', () => { location.href = '/__bridge/?stay=1'; });
  document.body.appendChild(home);

  fetch('/__bridge/config', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((cfg) => { extraSelectors = cfg.notifySelectors || ''; })
    .catch(() => {});

  scan(document);
  foldLongBlocks(document);
  setTimeout(() => { if (COOLDOWN_MS) scan(document); }, 3000);
})();
