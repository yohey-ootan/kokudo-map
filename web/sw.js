// アプリとしてインストールしたときに使う Service Worker
//  - アプリ本体とライブラリは保存しておき、電波が弱くてもすぐ起動できるようにする
//  - 地図タイル（PMTiles）は部分読み込みなので保存せず、そのままネットから読む
const VERSION = "v2";
const SHELL = `shell-${VERSION}`;
const SHELL_FILES = ["./", "index.html", "visits.js", "pacman.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("shell-") && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || req.headers.has("range")) return;   // タイルの部分読み込みは素通し
  const url = new URL(req.url);

  // アプリ本体と索引：まずネット（最新を使う）、つながらなければ保存分
  if (url.origin === location.origin) {
    if (url.pathname.endsWith(".pmtiles")) return;
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match("index.html"))));
    return;
  }

  // 地図ライブラリ・フォント：保存分をすぐ使い、裏で更新
  if (/unpkg\.com|demotiles\.maplibre\.org/.test(url.host)) {
    e.respondWith(caches.open("libs").then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
