// 動作確認用の「にせもの」のクラウド（localhost で ?mock を付けたときだけ使う）。cloud-firebase.js と同じ形。
// ・パスワードは testpass1。メールアドレスが norules@ で始まると、クラウド側のルールが未設定のときと同じく読み書きを断る
// ・「クラウド」の中身は localStorage に置く。同じブラウザの別のタブが「別の端末」の役になる（ログインはタブごと）
const K = 'tsubo-kiroku-mock-cloud', UK = 'tsubo-kiroku-mock-user';
export async function createCloud() {
  const load = () => { try { return JSON.parse(localStorage.getItem(K)) || {}; } catch (e) { return {}; } };
  const save = d => localStorage.setItem(K, JSON.stringify(d));
  const err = code => Object.assign(new Error(code), { code });
  const later = fn => setTimeout(fn, 20);
  const listeners = new Set();                                 // { uid, kind, onChanges, onError }
  const deny = uid => uid.startsWith('u-norules@');
  const docs = (d, uid, kind) => ((d[uid] || {})[kind] || {});
  const notify = (uid, kind, changes) => { for (const l of listeners) if (l.uid === uid && l.kind === kind) l.onChanges(changes.map(c => ({ ...c, data: c.data && JSON.parse(JSON.stringify(c.data)) }))); };
  // 別のタブ（別の端末）の書き込みを受け取る
  window.addEventListener('storage', e => {
    if (e.key !== K) return;
    const a = JSON.parse(e.oldValue || '{}'), b = JSON.parse(e.newValue || '{}');
    for (const l of listeners) {
      const x = docs(a, l.uid, l.kind), y = docs(b, l.uid, l.kind), ch = [];
      for (const id of Object.keys(y)) if (JSON.stringify(x[id]) !== JSON.stringify(y[id])) ch.push({ type: x[id] ? 'modified' : 'added', id, data: y[id], local: false });
      for (const id of Object.keys(x)) if (!y[id]) ch.push({ type: 'removed', id, data: x[id], local: false });
      if (ch.length) l.onChanges(ch);
    }
  });
  const write = (uid, fn) => { const d = load(); d[uid] = d[uid] || {}; fn(d[uid]); save(d); };
  const user = () => { const e = sessionStorage.getItem(UK); return e ? { uid: 'u-' + e, email: e } : null; };
  return {
    ready: Promise.resolve(user()),
    async signIn(email, pw) { if (pw !== 'testpass1') throw err('auth/invalid-credential'); sessionStorage.setItem(UK, email.trim().toLowerCase()); return user(); },
    async signOut() { sessionStorage.removeItem(UK); },
    listen(uid, kind, onChanges, onError) {
      if (deny(uid)) { later(() => onError(err('permission-denied'))); return () => {}; }
      const l = { uid, kind, onChanges, onError };
      listeners.add(l);
      later(() => { if (listeners.has(l)) onChanges(Object.values(docs(load(), uid, kind)).map(o => ({ type: 'added', id: o.id, data: JSON.parse(JSON.stringify(o)), local: false }))); });
      return () => listeners.delete(l);
    },
    async set(uid, kind, obj) {
      if (deny(uid)) throw err('permission-denied');
      const had = !!docs(load(), uid, kind)[obj.id];
      write(uid, u => { u[kind] = u[kind] || {}; u[kind][obj.id] = JSON.parse(JSON.stringify(obj)); });
      later(() => notify(uid, kind, [{ type: had ? 'modified' : 'added', id: obj.id, data: obj, local: true }]));
    },
    async remove(uid, kind, id) {
      if (deny(uid)) throw err('permission-denied');
      write(uid, u => { if (u[kind]) delete u[kind][id]; });
      later(() => notify(uid, kind, [{ type: 'removed', id, data: null, local: true }]));
    },
    async commit(uid, ops) {
      if (deny(uid)) throw err('permission-denied');
      write(uid, u => { for (const { kind, obj } of ops) { u[kind] = u[kind] || {}; u[kind][obj.id] = JSON.parse(JSON.stringify(obj)); } });
      later(() => { for (const { kind, obj } of ops) notify(uid, kind, [{ type: 'added', id: obj.id, data: obj, local: true }]); });
    },
    async fetch(uid, kind) { if (deny(uid)) throw err('permission-denied'); return Object.values(docs(load(), uid, kind)).map(o => JSON.parse(JSON.stringify(o))); },
  };
}
