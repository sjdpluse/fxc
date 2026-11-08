// Build-time placeholders are replaced by scripts/generate-worker.mjs.
const RELEASE = '__FXC_RELEASE__';
const ASSET_PATHS = __FXC_ASSETS__;
const APP_ROOT = new URL('./', self.location.href);
const CACHE_PREFIX = `fxc-shell:${APP_ROOT.pathname}:`;
const CACHE_NAME = CACHE_PREFIX + RELEASE;
const ASSETS = ASSET_PATHS.map((path) => new URL(path, APP_ROOT).href);
const ALLOWED_URLS = new Set(ASSETS);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Only the exact, public app-shell assets are eligible for offline caching.
  // Supabase requests, auth callbacks, queries, and all mutations bypass this worker.
  if (request.method !== 'GET' || url.origin !== APP_ROOT.origin || url.search || request.headers.has('authorization') || !ALLOWED_URLS.has(url.href)) return;
  const responsePromise = fetch(request).catch(async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    return Response.error();
  });
  event.respondWith(responsePromise);
});
