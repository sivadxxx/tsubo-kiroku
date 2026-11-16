// ツボ記録：ログインと、クラウドの保存先（Firebase Authentication + Cloud Firestore）
//
// データの形（ログインした本人の下に、種類ごとに置く）
//   kiroku/{本人のID}/places/{id}    場所
//   kiroku/{本人のID}/patients/{id}  患者
//   kiroku/{本人のID}/visits/{id}    来院の記録（使ったツボ・効果を含む）
//   kiroku/{本人のID}/tsubo/{id}     ツボのリスト
//   kiroku/{本人のID}/symptoms/{id}  症状のリスト
//   kiroku/{本人のID}/staff/{id}     担当者のリスト
// 読み書きできるのは、ツボマップ3D の管理者（owner）本人のログインだけ。Firebase 側のルールで守る（ツボマップ3D と同じ Firebase なので、ルールは1つ。README を参照）。
export const SDK_VERSION = '12.15.0';
const BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}/`;

export async function createCloud(config) {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(BASE + 'firebase-app.js'), import(BASE + 'firebase-auth.js'), import(BASE + 'firebase-firestore.js'),
  ]);
  const app = initializeApp(config);
  const auth = A.getAuth(app);
  auth.languageCode = 'ja';
  // 記録は端末にも残し、電波がなくても読み書きできるようにする（つながったときに送る）
  const db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });

  const col = (uid, kind) => F.collection(db, 'kiroku', uid, kind);
  const ref = (uid, kind, id) => F.doc(db, 'kiroku', uid, kind, id);
  const clean = o => JSON.parse(JSON.stringify(o));          // undefined を落とし、画面側のオブジェクトと切り離す
  const who = u => (u ? { uid: u.uid, email: u.email || '' } : null);
  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'unavailable' })), ms))]);

  return {
    // 開いたときに、すでにログインしているか（していなければ null）
    ready: new Promise(res => { const off = A.onAuthStateChanged(auth, u => { off(); res(who(u)); }, () => res(null)); }),
    signIn: async (email, pw) => who((await A.signInWithEmailAndPassword(auth, email.trim(), pw)).user),
    // clear=true のときは、端末にためた写しも消す（このあと画面を読み込み直すこと）
    async signOut(clear) {
      if (clear && navigator.onLine) { try { await within(F.waitForPendingWrites(db), 5000); } catch (e) {} }   // まだ送っていない書き込みを送りきる
      await A.signOut(auth);
      if (clear) { try { await F.terminate(db); await F.clearIndexedDbPersistence(db); } catch (e) {} }
    },
    // 変化を見張る。onChanges には [{ type: 'added'|'modified'|'removed', id, data, local }] が届く（local は、この端末の書き込みによる変化）
    listen: (uid, kind, onChanges, onError) => F.onSnapshot(col(uid, kind),
      snap => onChanges(snap.docChanges().map(c => ({ type: c.type, id: c.doc.id, data: { ...c.doc.data(), id: c.doc.id }, local: c.doc.metadata.hasPendingWrites }))),
      onError),
    // 1件の書き込み・削除（電波がないときは端末にたまり、つながったときに送られる）
    set: (uid, kind, obj) => F.setDoc(ref(uid, kind, obj.id), clean(obj)),
    remove: (uid, kind, id) => F.deleteDoc(ref(uid, kind, id)),
    // まとめて書き込み、クラウドに届いたことを確かめてから戻る
    async commit(uid, ops) {
      for (let i = 0; i < ops.length; i += 400) {
        const b = F.writeBatch(db);
        for (const { kind, obj } of ops.slice(i, i + 400)) b.set(ref(uid, kind, obj.id), clean(obj));
        await within(b.commit(), 60000);
      }
    },
    // クラウドにある内容を、（端末の写しではなく）クラウドから直接読む
    fetch: async (uid, kind) => (await within(F.getDocsFromServer(col(uid, kind)), 30000)).docs.map(d => ({ ...d.data(), id: d.id })),
  };
}

// エラーを、画面に出す言葉に直す
export function explain(e) {
  const code = e && e.code || '';
  const t = {
    'auth/invalid-credential': 'メールアドレスかパスワードが違います。',
    'auth/wrong-password': 'メールアドレスかパスワードが違います。',
    'auth/user-not-found': 'メールアドレスかパスワードが違います。',
    'auth/invalid-email': 'メールアドレスの形が正しくありません。',
    'auth/missing-password': 'パスワードを入れてください。',
    'auth/too-many-requests': '試した回数が多すぎます。しばらく待ってから、もう一度お試しください。',
    'auth/network-request-failed': '通信できませんでした。電波の状態を確かめてください。',
    'auth/user-disabled': 'このアカウントは止められています。',
    'permission-denied': 'クラウド側で許可されていません。',
    'unavailable': '通信できませんでした。電波の状態を確かめてください。',
  }[code];
  return t || ('うまくいきませんでした（' + (code || (e && e.message) || e) + '）');
}
