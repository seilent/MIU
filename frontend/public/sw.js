// Service Worker for MIU Music Player PWA
const CACHE_NAME = 'miu-cache-v1';
const urlsToCache = [
  // We'll continue to cache static assets, but not main pages
  '/manifest.json',
  '/favicon.svg',
  '/app-icon-192.png',
  '/app-icon-512.png',
  '/images/DEFAULT.jpg'
];

// Pages to exclude from caching (main page and other dynamic pages)
const excludeFromCache = [
  '/',                    // Main page
  '/history',             // History page
  '/login'                // Login page
];

// Listen for messages from the client
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    console.log('Clearing cache from service worker');
    
    // Clear all caches
    event.waitUntil(
      caches.keys().then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => {
            return caches.delete(cacheName).then(() => {
              console.log(`Cache ${cacheName} deleted`);
            });
          })
        );
      })
    );
    
    // Send confirmation back to the client
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({ success: true });
    }
  }
});

// Install handler - cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});

// Activate handler - clean up old caches
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Fetch handler - serve from cache if available, otherwise fetch from network
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // Skip caching for:
  // 1. API requests
  // 2. Streaming audio
  // 3. Main pages that are in development
  // 4. Any URLs in the exclude list
  if (
    event.request.url.includes('/api/') || 
    event.request.url.includes('/music/stream') ||
    excludeFromCache.some(path => url.pathname === path || url.pathname.endsWith(path))
  ) {
    // For excluded paths, just fetch from network without caching
    return;
  }
  
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Cache hit - return response
        if (response) {
          return response;
        }
        
        // Clone the request because it's a one-time use
        const fetchRequest = event.request.clone();
        
        return fetch(fetchRequest).then(response => {
          // Check if valid response
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }
          
          // Clone the response because it's a one-time use
          const responseToCache = response.clone();
          
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
          
          return response;
        });
      })
  );
}); 