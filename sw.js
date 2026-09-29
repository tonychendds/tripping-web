const CACHE = "tripping-shell-v3"
const BASE = new URL("./", self.location).pathname
const asset = (path) => `${BASE}${path}`
const PRECACHE = [
  BASE,
  asset("index.html"),
  asset("manifest.webmanifest"),
  asset("favicon.svg"),
  asset("favicon.ico"),
  asset("favicon-16x16.png"),
  asset("favicon-32x32.png"),
  asset("apple-touch-icon.png"),
  asset("icon.svg"),
  asset("icon-192.png"),
  asset("icon-512.png"),
  asset("icon-maskable-192.png"),
  asset("icon-maskable-512.png"),
]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  // Weather, Explore, and rates already keep their own copies. Leave those hosts alone.
  if (url.origin !== self.location.origin) return
  // Vite’s dev modules must stay live.
  if (url.pathname.startsWith("/src/") || url.pathname.startsWith("/@") || url.pathname.includes("node_modules")) return

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, asset("index.html")))
    return
  }
  event.respondWith(staleWhileRevalidate(request))
})

async function networkFirst(request, fallback) {
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(fallback, response.clone())
    return response
  } catch {
    return (await cache.match(fallback)) || (await cache.match(asset("index.html")))
  }
}

self.addEventListener("push", (event) => {
  const payload = event.data ? event.data.json() : {}
  const title = payload.title || "Tripping"
  const body = payload.body || "A flight on your trip changed."
  event.waitUntil(self.registration.showNotification(title, { body, icon: asset("icon-192.png") }))
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  event.waitUntil(self.clients.openWindow(BASE))
})

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  const fetched = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone())
      return response
    })
    .catch(() => cached)
  return cached || fetched
}
