const CACHE_DB_NAME = 'app-updates';
const CACHE_STORE = 'builds';
const SW_VERSION = 3;

function postToPage(type, payload) {
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then((clients) => {
            clients.forEach((client) => {
                client.postMessage({ type, payload });
            });
        })
        .catch((e) => {
            console.warn(`[SW] postToPage failed: ${e}`);
        });
}

self.addEventListener('install', (event) => {
    console.log(`[SW] Installed v${SW_VERSION}`);
    postToPage('installed', { version: SW_VERSION });
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log(`[SW] Activated v${SW_VERSION}`);
    event.waitUntil(clients.claim());
});

self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'ping') {
        reply(event, { type: 'pong', version: SW_VERSION });
        return;
    }

    if (data.type === 'has-build') {
        openDatabase()
            .then((db) => getBuildByUrl(db, data.url))
            .then((build) => {
                const ok = !!build;
                console.log(`[SW] has-build: url=${data.url} ok=${ok}`);
                postToPage('has-build', { url: data.url, ok });
                reply(event, { type: 'has-build', ok, url: data.url });
            })
            .catch((e) => {
                console.log(`[SW] has-build error ${e}`);
                reply(event, { type: 'has-build', ok: false, url: data.url, error: String(e) });
            });
        return;
    }

    if (data.type === 'store-build') {
        const payload = data.payload || {};
        openDatabase()
            .then((db) => putBuildInDb(db, payload.url, payload.files))
            .then(() => {
                console.log(`[SW] build stored: url=${payload.url}`);
                postToPage('build-stored', { url: payload.url });
                reply(event, { type: 'build-stored', ok: true, url: payload.url });
            })
            .catch((e) => {
                console.log(`[SW] build store failed ${e}`);
                reply(event, { type: 'build-stored', ok: false, url: payload.url, error: String(e) });
            });
        return;
    }

    console.log(`[SW] Unknown message type: ${data.type}`);
});

function reply(event, message) {
    if (event.ports && event.ports[0]) {
        event.ports[0].postMessage(message);
    } else {
        postToPage(message.type, message.payload || {});
    }
}

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (event.request.method !== 'GET') return;
    if (url.origin !== self.location.origin) return;

    if (event.request.mode === 'navigate') {
        console.log(`[SW] navigate ${url.pathname}${url.search}`);
        postToPage('navigate', { path: url.pathname + url.search });
    }

    event.respondWith(
        openDatabase()
            .then((db) => getActiveBuild(db))
            .then((build) => {
                if (!build) {
                    console.log('[SW] No active build, fetching network');
                    postToPage('no build', { path: url.pathname });
                    return fetch(event.request);
                }

                const path = url.pathname;
                const base = new URL(self.registration.scope).pathname;
                const fileName = resolveCacheFileName(path, base);
                const cachedKey = findCachedKey(build, fileName);
                const rawData = cachedKey ? build.files[cachedKey] : null;
                const fileData = toBufferSource(rawData);

                if (fileData) {
                    console.log(`[SW] Serving cached: ${cachedKey} (req ${url.pathname})`);
                    postToPage('serving', { key: cachedKey, path: url.pathname });
                    const contentType = getContentType(cachedKey);
                    return new Response(fileData, {
                        headers: { 'Content-Type': contentType }
                    });
                }

                console.log(`[SW] No cache for ${fileName}, fetching network`);
                postToPage('no cache', { fileName, path: url.pathname });
                const keys = Object.keys(build.files || {});
                console.log(`[SW] Build keys (${keys.length}): ${keys.slice(0, 10).join(', ')}`);
                postToPage('build keys', { keys: keys.slice(0, 10), count: keys.length });
                return fetch(event.request);
            })
            .catch((e) => {
                console.log(`[SW] DB error ${e}, fetching network`);
                postToPage('db error', { error: String(e), path: url.pathname });
                return fetch(event.request);
            })
    );
});

function toBufferSource(raw) {
    if (raw == null) return null;
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (raw instanceof Blob) return raw;
    if (typeof raw === 'string') return raw;
    console.log(`[SW] Unrecognized file data type: ${typeof raw}`);
    postToPage('response data type', { type: typeof raw });
    return null;
}

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
        request.onblocked = (event) => {
            console.warn('[SW] openDatabase blocked');
            reject(new Error('IndexedDB open blocked'));
        };
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

function getBuildByUrl(db, url) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(CACHE_STORE, 'readonly');
        const store = tx.objectStore(CACHE_STORE);
        const request = store.get(url);
        request.onsuccess = () => {
            db.close();
            resolve(request.result || null);
        };
        request.onerror = () => {
            db.close();
            reject(request.error);
        };
    });
}

function putBuildInDb(db, url, files) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(CACHE_STORE, 'readwrite');
        const store = tx.objectStore(CACHE_STORE);
        store.put({ url: url, files: files, timestamp: Date.now() });
        tx.oncomplete = () => {
            db.close();
            resolve();
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
    });
}

function resolveCacheFileName(path, base) {
    if (path === base || path === base.replace(/\/$/, '') || path === '/') {
        return 'index.html';
    }
    if (base.length > 1 && path.startsWith(base)) {
        return path.substring(base.length) || 'index.html';
    }
    return path.substring(1) || 'index.html';
}

function findCachedKey(build, fileName) {
    const files = build.files || {};
    if (files[fileName]) return fileName;

    const suffix = '/' + fileName;
    const keys = Object.keys(files);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key.startsWith('__MACOSX')) continue;
        if (key !== fileName && key.endsWith(suffix)) {
            console.log(`[SW] Fallback key: ${fileName} -> ${key}`);
            return key;
        }
    }
    return null;
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