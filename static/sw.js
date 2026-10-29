const CACHE = 'moja-kawa-shell-v5';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/core.js', '/store.js', '/cup.svg', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest', '/ai-instructions.md', '/fonts/BarlowCondensed-ExtraBold.ttf'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('moja-kawa-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // API always reaches the server. Offline records and pending edits live in IndexedDB.
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname === '/health') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match('/index.html')) || fetch(event.request)));
  } else if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.pathname)) || fetch(event.request)));
  }
});
