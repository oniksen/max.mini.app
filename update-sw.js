const CACHE_DB_NAME = 'app-updates';
const CACHE_STORE = 'builds';

self.addEventListener('install', (event) => {
    console.log('[SW] Installed');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[SW] Activated');
    event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (event.request.method !== 'GET') return;
    if (url.origin !== self.location.origin) return;

    event.respondWith(
        openDatabase()
            .then((db) => getActiveBuild(db))
            .then((build) => {
                if (!build) return fetch(event.request);

                const path = url.pathname;
                const fileName = path === '/' ? 'index.html' : path.substring(1);
                const fileData = build.files[fileName];

                if (fileData) {
                    const contentType = getContentType(fileName);
                    return new Response(fileData, {
                        headers: { 'Content-Type': contentType }
                    });
                }

                return fetch(event.request);
            })
            .catch(() => fetch(event.request))
    );
});

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(CACHE_DB_NAME, 2);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(CACHE_STORE)) {
                db.createObjectStore(CACHE_STORE, { keyPath: 'url' });
            }
        };
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

function getActiveBuild(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(CACHE_STORE, 'readonly');
        const store = tx.objectStore(CACHE_STORE);
        const request = store.getAll();
        request.onsuccess = (event) => {
            const builds = event.target.result;
            if (builds && builds.length > 0) {
                // Return the most recent build
                const latest = builds.sort((a, b) => b.timestamp - a.timestamp)[0];
                resolve(latest);
            } else {
                resolve(null);
            }
            db.close();
        };
        request.onerror = (event) => {
            db.close();
            reject(event.target.error);
        };
    });
}

function getContentType(fileName) {
    if (fileName.endsWith('.html')) return 'text/html';
    if (fileName.endsWith('.js')) return 'application/javascript';
    if (fileName.endsWith('.css')) return 'text/css';
    if (fileName.endsWith('.json')) return 'application/json';
    if (fileName.endsWith('.wasm')) return 'application/wasm';
    if (fileName.endsWith('.png')) return 'image/png';
    if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) return 'image/jpeg';
    if (fileName.endsWith('.svg')) return 'image/svg+xml';
    if (fileName.endsWith('.ico')) return 'image/x-icon';
    if (fileName.endsWith('.map')) return 'application/json';
    if (fileName.endsWith('.woff2')) return 'font/woff2';
    if (fileName.endsWith('.ttf')) return 'font/ttf';
    if (fileName.endsWith('.webmanifest')) return 'application/manifest+json';
    return 'application/octet-stream';
}