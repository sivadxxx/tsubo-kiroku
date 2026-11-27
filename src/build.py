"""ツボ記録 をアプリとして入れるためのファイル（アイコン・manifest・オフライン用の sw.js）を作る。

  python3 src/build.py   … index.html・app.js などを直したあとにも実行する（sw.js の版が変わり、端末側が新しい内容に入れ替わる）
Pillow が必要。
"""
import os, json, hashlib
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.normpath(os.path.join(HERE, ".."))
ICONS = os.path.join(APP, "icons")
os.makedirs(ICONS, exist_ok=True)

BG, ACCENT, SOFT, INK = (250, 246, 241), (196, 99, 63), (235, 207, 174), (58, 47, 41)


def icon(size, pad=0.0):
    """ツボの印（二重丸）と、集計の棒。pad は、丸く切り抜かれるアイコン用の余白"""
    S = size * 4                                   # 大きく描いてから縮める（縁をなめらかにする）
    im = Image.new("RGB", (S, S), BG)
    d = ImageDraw.Draw(im)
    u = S * (1 - 2 * pad) / 100.0                  # 100 を一辺とする目盛り
    o = S * pad
    X = lambda v: o + v * u
    # 棒（左から低・中・高）
    for x, top, col in ((20, 62, SOFT), (42, 46, (224, 144, 107)), (64, 28, ACCENT)):
        d.rounded_rectangle([X(x), X(top), X(x + 16), X(82)], radius=u * 4, fill=col)
    # ツボの印
    cx, cy, r = X(30), X(34), u * 13
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=INK, width=int(u * 3.2))
    r2 = u * 4.6
    d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=INK)
    return im.resize((size, size), Image.LANCZOS)


icon(180).save(os.path.join(ICONS, "icon-180.png"))
icon(192).save(os.path.join(ICONS, "icon-192.png"))
icon(512).save(os.path.join(ICONS, "icon-512.png"))
icon(512, pad=0.12).save(os.path.join(ICONS, "icon-maskable-512.png"))

manifest = {
    "name": "ツボ記録", "short_name": "ツボ記録", "lang": "ja", "start_url": "./", "scope": "./",
    "display": "standalone", "orientation": "any", "background_color": "#FAF6F1", "theme_color": "#FAF6F1",
    "description": "来院ごとに使ったツボを選んで残し、症状ごとに効いたツボを集計します",
    "icons": [
        {"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
        {"src": "icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
    ],
}
with open(os.path.join(APP, "manifest.webmanifest"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=1)

# src/ の中（にせのクラウド・にせの AI）は動作確認用なので、入れない
ASSETS = ["index.html", "app.js", "store.js", "stats.js", "monshin.js", "pdf.js", "cloud-firebase.js", "config.js", "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png"]
import re
SDK_VERSION = re.search(r"SDK_VERSION = '([^']+)'", open(os.path.join(APP, "cloud-firebase.js"), encoding="utf-8").read()).group(1)
SDK = ["https://www.gstatic.com/firebasejs/%s/firebase-%s.js" % (SDK_VERSION, n) for n in ("app", "auth", "firestore")]
hsh = hashlib.sha1()
for a in ASSETS:
    hsh.update(open(os.path.join(APP, a), "rb").read())
sw = """// ツボ記録：オフライン用のキャッシュ（src/build.py が生成）
const CACHE = 'tsubo-kiroku-%s';
const ASSETS = %s;
const SDK = %s;       // 同期（Firebase）の部品。電波がなくても開けるように取っておく
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
""" % (hsh.hexdigest()[:12], json.dumps(["./"] + ASSETS), json.dumps(SDK))
with open(os.path.join(APP, "sw.js"), "w", encoding="utf-8") as f:
    f.write(sw)
print("ok", hsh.hexdigest()[:12])
