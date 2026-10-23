// Service worker: lets the installed app open without a connection, and always checks for the
// newest app files when online (so updates show up on the next open, with no stale copies).
// Only this site's own files are handled; Firebase, fonts and the AI model use the browser's own caching.

const CACHE = 'qa-hub-v1';
const SHELL = [
  './', './index.html', './app.css', './manifest.webmanifest',
  './app.js', './config.js', './sync.js', './store.js', './model.js', './utils.js', './ui.js',
  './similarity.js', './semantic.js', './semantic-worker.js', './dialogs.js', './import.js', './logcall.js',
  './library.js', './overview.js', './changes.js', './inbox.js', './review.js', './themes.js', './reps.js',
  './insights.js', './calls.js', './complete.js', './rules.js', './calibrate.js', './summary.js', './seed.js', './notes.js',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // Cache what's available; a missing file shouldn't block installation.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Network first, revalidating with the server (no stale browser copy); fall back to the cache offline.
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return caches.match('./index.html');
      throw new Error('offline');
    }
  })());
});
