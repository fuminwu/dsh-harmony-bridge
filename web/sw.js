const SHELL = [
  '/__bridge/',
  '/__bridge/index.html',
  '/__bridge/app.js',
  '/__bridge/style.css',
  '/__bridge/icon.svg',
  '/__bridge/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open('dshb-shell-v1').then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== 'dshb-shell-v1').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Only the PWA shell is cached. DSH data, APIs and WebSocket traffic are never stored.
  if (!SHELL.includes(url.pathname)) return;
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open('dshb-shell-v1').then((c) => c.put(event.request, copy));
        }
        return resp;
      })
      .catch(() => caches.match(event.request)),
  );
});
