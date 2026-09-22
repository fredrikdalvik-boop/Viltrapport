// Service worker – gör att appen kan installeras och startar snabbare.
// Öka versionsnumret när du ändrar i listan nedan.
const CACHE = 'viltrapport-v2';

const APP_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './species.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/scene.svg',
];

const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Egna filer: hämta nytt först, använd sparad kopia om nätet saknas
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request, { ignoreSearch: true }))
    );
    return;
  }

  // Bibliotek från CDN: använd sparad kopia, hämta annars
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      }))
    );
  }

  // Allt annat (Supabase, kartbilder) går direkt till nätet
});
