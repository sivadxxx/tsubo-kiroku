// 記録の保存先。いまは、この端末の中（IndexedDB）だけに保存する。
// 画面側は loadAll / put / del / putMany しか使わないので、あとで保存先（クラウドなど）を足すときは、ここだけ差し替えればよい。
const DB = 'tsubo-kiroku';
const VER = 2;                                  // 2：場所（places）を追加
export const KINDS = ['patients', 'visits', 'tsubo', 'symptoms', 'places', 'meta'];

export async function openStore() {
  const idb = await new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => { for (const k of KINDS) if (!r.result.objectStoreNames.contains(k)) r.result.createObjectStore(k, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  // 1回の書き込みをひとまとまりで行い、途中で失敗したら全部なかったことにする
  const write = fn => new Promise((res, rej) => {
    const t = idb.transaction(KINDS, 'readwrite');
    fn(t);
    t.oncomplete = () => res();
    t.onerror = t.onabort = () => rej(t.error);
  });
  const all = k => new Promise((res, rej) => {
    const r = idb.transaction(k).objectStore(k).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  // 端末の空きが減ったときに、ブラウザが勝手に記録を消さないよう頼んでおく
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  return {
    async loadAll() { const out = {}; for (const k of KINDS) out[k] = await all(k); return out; },
    put: (kind, obj) => write(t => t.objectStore(kind).put(obj)),
    del: (kind, id) => write(t => t.objectStore(kind).delete(id)),
    putMany: byKind => write(t => { for (const k of Object.keys(byKind)) for (const o of byKind[k]) t.objectStore(k).put(o); }),
    delMany: byKind => write(t => { for (const k of Object.keys(byKind)) for (const id of byKind[k]) t.objectStore(k).delete(id); }),
  };
}
