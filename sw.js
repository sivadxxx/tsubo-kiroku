// ツボ記録：オフライン用のキャッシュ（src/build.py が生成）
const CACHE = 'tsubo-kiroku-f066ccb6d761';
const ASSETS = ["./", "index.html", "app.js", "store.js", "stats.js", "monshin.js", "pdf.js", "cloud-firebase.js", "config.js", "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png"];
const SDK = ["https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js", "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js", "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js"];       // 同期（Firebase）の部品。電波がなくても開けるように取っておく
self.addEventListener('install', e => {
  // ブラウザが手元に持っている古い写しは使わず、必ず公開先から取り直す
  const get = u => fetch(new Request(u, { cache: 'reload' })).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r; });
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(ASSETS.concat(SDK).map(u => get(u).then(r => c.put(u, r))))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('tsubo-kiroku-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || (new URL(req.url).origin !== location.origin && SDK.indexOf(req.url) < 0)) return;      // ログインや記録のやり取り（通信）には手を出さない
  // 画面本体も部品も、この版として保存した一式から出す。新しい版は、次に開いたときに一式ごと入れ替わる
  const hit = caches.open(CACHE).then(c => req.mode === 'navigate' ? c.match('index.html') : c.match(req));
  e.respondWith(hit.then(r => r || fetch(req)));
});
