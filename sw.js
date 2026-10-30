const CACHE = 'inv-v6';
const FICHIERS = ['./', 'index.html', 'style.css', 'app.js', 'firebase-config.js', 'manifest.json', 'icon.svg',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(FICHIERS.map(f => c.add(f)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const h = new URL(e.request.url).hostname;
  // Seulement le site lui-même et les bibliothèques ; jamais les appels Firebase (données/connexion)
  if (h !== self.location.hostname && h !== 'www.gstatic.com' && h !== 'unpkg.com') return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copie = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copie));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
