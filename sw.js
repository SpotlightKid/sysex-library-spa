// sw.js
// Service worker: "cache first" approach, cache name 'sysex-library-v1'

const CACHE_NAME = 'sysex-library-v1';
const FALLBACK_URL = './assets/img/notfound.svg';

// List of resources to pre-cache on install.
const PRECACHE_RESOURCES = [
  './',
  './index.html',
  './sw.js',
  './manifest.json',
  './assets/css/styles.css',
  './assets/css/uikit.min.css',
  './assets/js/app.js',
  './assets/js/search.js',
  './assets/js/idb.js',
  './assets/js/uikit-icons.min.js',
  './assets/js/uikit.min.js',
  './assets/img/favicon.ico',
  './assets/img/icon-192.png',
  './assets/img/icon-512.png',
  './assets/img/icon.svg',
  './assets/img/notfound.svg',
];

const addResourcesToCache = async (resources) => {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(resources);
};

const putInCache = async (request, response) => {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response);
};

const cacheFirst = async ({ request, preloadResponsePromise, fallbackUrl, event }) => {
  // Only handle GET requests
  if (request.method !== 'GET') {
    return fetch(request);
  }

  // First try the cache
  const responseFromCache = await caches.match(request);
  if (responseFromCache) {
    return responseFromCache;
  }

  // Next try navigation preload (if available)
  const preloadResponse = await preloadResponsePromise;
  if (preloadResponse) {
    event.waitUntil(putInCache(request, preloadResponse.clone()));
    return preloadResponse;
  }

  // Next try network
  try {
    const responseFromNetwork = await fetch(request);
    // Cache a clone
    event.waitUntil(putInCache(request, responseFromNetwork.clone()));
    return responseFromNetwork;
  } catch (error) {
    // fallback resource
    const fallbackResponse = await caches.match(fallbackUrl);
    if (fallbackResponse) {
      return fallbackResponse;
    }
    return new Response('Network error happened', {
      status: 408,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
};

// Enable navigation preload if supported
const enableNavigationPreload = async () => {
  if (self.registration && self.registration.navigationPreload) {
    try {
      await self.registration.navigationPreload.enable();
    } catch (e) {
      // ignore
      console.warn('Navigation preload enable failed', e);
    }
  }
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await addResourcesToCache(PRECACHE_RESOURCES);
      // Force the waiting Service Worker to become the active Service Worker
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Optionally, delete old caches here (not strictly necessary on first deploy)
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      );
      await enableNavigationPreload();
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle same-origin requests (optional)
  const requestUrl = new URL(event.request.url);

  // We can let browser handle external requests (e.g., CDN) -
  // but cache-first will handle them too if desired.
  // Here we use cache-first for all GETs within scope.
  event.respondWith(
    cacheFirst({
      request: event.request,
      preloadResponsePromise: event.preloadResponse,
      fallbackUrl: FALLBACK_URL,
      event
    })
  );
});
