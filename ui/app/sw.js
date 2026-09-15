/* 古四音乐 Service Worker
   作用：应用外壳离线可用 + 二次访问加速
   策略：静态外壳 network-first —— 局域网内足够快，且保证服务端升级后立即生效
        （旧版 cache-first 会让 /assets/app.js 永远停在首次缓存，升级看不见）
        离线/网络异常时回退缓存 */
const CACHE = 'gusi-v8'
const SHELL = ['./', './index.html', './manifest.json', './assets/app.css', './assets/app.js', './assets/icon.png']

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return
  const url = new URL(e.request.url)
  if (url.origin !== self.location.origin) return
  // API / 媒体（音频、封面）：一律走网络，避免缓存脏数据与流量重复
  if (url.pathname.startsWith('/web/') || url.pathname.startsWith('/admin/')) return
  const isShell =
    url.pathname.startsWith('/assets/') ||
    url.pathname === '/manifest.json' ||
    url.pathname === '/icon.png' ||
    url.pathname === '/' ||
    url.pathname === '/index.html'
  if (!isShell) return
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok) {
          const clone = res.clone()
          caches.open(CACHE).then((c) => c.put(e.request, clone))
        }
        return res
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  )
})
