/* 古四音乐 Service Worker：缓存应用外壳，加速二次访问 / 离线安装壳 */
const CACHE = 'gusi-v1'
const SHELL = ['./', './index.html', './manifest.json', './assets/app.css', './assets/app.js', './assets/icon.png']

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  )
})

// 只缓存静态资源（应用外壳）；API/媒体请求一律走网络，避免缓存脏数据
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET') return
  if (url.pathname.startsWith('/web/') || url.pathname.startsWith('/admin/')) return
  if (url.pathname.startsWith('/assets/') || url.pathname === '/manifest.json' || url.pathname === '/icon.png') {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        if (hit) return hit
        return fetch(e.request).then((res) => {
          if (res.ok) {
            const clone = res.clone()
            caches.open(CACHE).then((c) => c.put(e.request, clone))
          }
          return res
        })
      })
    )
  }
})