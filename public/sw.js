// Offline cache for the app shell.
//
// Served from public/ verbatim, so it is a classic script with no imports and
// no build-time substitution — every path is derived from self.location rather
// than hardcoded, which is what keeps it working at both "/" in dev and
// "/AudioMX-WebApp/" on Pages.
//
// Three decisions worth stating, because each one is a bug avoided:
//
//  1. No skipWaiting(), no precache manifest. An updated worker waits until
//     every tab closes. That is safe rather than slow: navigations are
//     network-first, so an open tab still receives fresh HTML, and fresh HTML
//     names content-hashed assets the old cache has never seen — they miss and
//     go to the network. Activating a new worker under a live page could drop
//     assets mid-exam instead.
//
//  2. clients.claim() is kept. Without skipWaiting it can only fire on a first
//     install, where there is no previous worker to displace — and it is what
//     makes the *first* visit populate the cache, instead of leaving the user
//     with nothing if they go offline right after.
//
//  3. Navigations are cached under their pathname with the query stripped. The
//     Epic OAuth round trip comes back to the scope root as
//     "?code=…&state=…"; keying on the full URL would write an authorisation
//     code into the cache, and would never hit on the next visit anyway.
//
// Patient audio is not the worker's business — it lives in IndexedDB.

const VERSION = "audiomx-v2";
const ROOT = new URL("./", self.location.href);

self.addEventListener("install", () => {
  // Nothing to precache: asset names are content-hashed and unknown here.
  // The cache fills as the first visit fetches.
});

self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter(name => name !== VERSION).map(name => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

/** Cache key for a navigation: same document whatever the query string. */
function navigationKey(url) {
  return new Request(new URL(url).origin + new URL(url).pathname);
}

async function put(key, response) {
  // Opaque and error responses are not worth persisting, and caching a
  // redirect or a 404 would outlive the problem that produced it.
  if (!response || !response.ok || response.type !== "basic") return;
  const cache = await caches.open(VERSION);
  await cache.put(key, response.clone());
}

/** Fresh HTML wins; the cache is only there for a dead network. */
async function networkFirst(request) {
  const key = navigationKey(request.url);
  try {
    const response = await fetch(request);
    await put(key, response);
    return response;
  } catch (error) {
    const cached = (await caches.match(key)) || (await caches.match(navigationKey(ROOT.href)));
    if (cached) return cached;
    throw error;
  }
}

/** For content-hashed assets: the name changes when the bytes do. */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  await put(request, response);
  return response;
}

/** Everything else same-origin: serve now, refresh for next time. */
async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then(response => put(request, response).then(() => response))
    .catch(() => undefined);
  return cached || (await network) || Promise.reject(new Error("offline and uncached"));
}

self.addEventListener("fetch", event => {
  const { request } = event;

  // Leave alone: writes, and anything not ours — Epic's FHIR API above all.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname)) return;

  // The product site's media is deliberately not cached. It is 5 MB of hero
  // frames and product photography belonging to a marketing page, and this
  // cache exists so a clinician can run an exam with no network. Filling it
  // with pictures of the device would push the code that actually has to work
  // offline out of a quota it shares.
  if (url.pathname.includes("/site/")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
  } else if (url.pathname.includes("/assets/")) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});
