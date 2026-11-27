// 問診の録音：録音と、OpenAI への問い合わせ（文字起こし・まとめ）だけを受け持つ。画面には依存しない。
// ・録音は、文字起こしが終わるまで、この端末の中（IndexedDB の tsubo-kiroku-rokuon）に置いておく
// ・API キーは呼び出すたびに受け取るだけで、ここでは覚えない。エラーの文やログにも出さない
// ・まとめ（summarize）だけを差し替えれば、ほかの会社の AI にも変えられる

const API = 'https://api.openai.com/v1';
export const TRANSCRIBE_MODEL = 'gpt-4o-transcribe-diarize';
// 整理に使う AI。最初のものが標準
export const MODELS = [
  { id: 'gpt-6.2-sol', label: 'gpt-6.2-sol（標準）' },
  { id: 'gpt-6.1-terra', label: 'gpt-6.1-terra（安い）' },
  { id: 'gpt-6.2-astra', label: 'gpt-6.2-astra（高性能・高い）' },
];
// 1本の録音の長さ（秒）。文字起こしの AI は、1回に読める量（16,000 トークン）と書ける量（2,000 トークン）が決まっているので、
// 会話が多くても収まるよう、短めに区切る（ファイルの大きさの上限 25MB には、32kbps なら 3 分で 1MB にも届かない）
export const SEGMENT_SEC = 180;

export const DEFAULT_PROMPT = `あなたは鍼灸院の問診記録を整理する助手です。
入力は、施術者と患者さんの会話を文字にしたものです。話者の名前（話者A・話者B など）が付いていることも、付いていないこともあります。付いている場合も、その名前は録音の区切りごとに入れ替わることがあります。聞き間違いも含まれます。

次の見出しごとに、箇条書きで簡潔にまとめてください。話に出なかった見出しは省きます。
【主訴】
【いつから・経過】
【悪くなるとき／楽になるとき】
【これまでの病気・けが・薬】
【生活（睡眠・食事・仕事・運動・ストレス）】
【患者さんの言葉で気になったもの】（短く引用する）
【次回たしかめたいこと】

守ること
・会話に出たことだけを書きます。推測で補わないでください。診断や治療方針を付け足さないでください。
・聞き取りがあやしいところには「（聞き取り不確か）」と添えます。
・氏名・住所・電話番号・勤務先の名前などは書きません。「患者さん」「ご家族」などに言い換えます。
・記号や飾り（# や ** など）は使わず、【】の見出しと「・」の箇条書きだけにします。`;

/* ---------- 失敗の知らせ ---------- */
// code：key（キーが違う）／net（電波がない）／limit（使いすぎ・残高不足）／model（AI の名前が使えない）／empty（中身がない）／other
export class AiError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail || ''; }
}
export function explainAi(e) {
  const code = e && e.code;
  return code === 'key' ? 'API キーが違うか、使えなくなっています。「設定」でキーを確かめてください。'
    : code === 'net' ? '電波がないか、OpenAI につながりませんでした。電波のあるところで、もう一度ためしてください。'
    : code === 'limit' ? '使いすぎか、残高が足りません（OpenAI の管理画面で、上限額と残高を確かめてください）。少し待ってから、もう一度ためしてください。'
    : code === 'model' ? '選んだ AI がいまは使えません。「設定」で、ほかの AI を選んでください。'
    : code === 'empty' ? 'AI から答えが返ってきませんでした。もう一度ためしてください。'
    : 'うまくいきませんでした' + (e && e.detail ? `（${e.detail}）` : '') + '。もう一度ためしてください。';
}
// 動作確認のときだけ、通信先を にせの AI（src/ai-mock.js）に差し替える
let doFetch = (url, init) => fetch(url, init);
export function setFetch(f) { doFetch = f; }

// キーは Authorization の見出しにだけ入れる。エラーの文に、キーの一部が入っていることがあるので消してから使う
const scrub = s => String(s || '').replace(/(sk|key)[-_][A-Za-z0-9_\-*.]{3,}/gi, '（キー）').slice(0, 160);
async function call(path, key, init) {
  let res;
  try { res = await doFetch(API + path, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + key } }); }
  catch (e) { throw new AiError('net'); }
  if (res.ok) { try { return await res.json(); } catch (e) { throw new AiError('other', '答えが読めません'); } }
  let body = {};
  try { body = await res.json(); } catch (e) {}
  const err = body.error || {};
  if (res.status === 401 || res.status === 403) throw new AiError('key');
  if (res.status === 429) throw new AiError('limit');
  // モデルが使えない：見つからない（404・model_not_found）か、終了・非推奨で断られた（返し方はドキュメントに書かれていないので、文の中身でも見る）
  if (res.status === 404 || res.status === 410 || err.code === 'model_not_found' || err.code === 'model_deprecated'
    || (res.status === 400 && /deprecat|shut ?down|no longer (available|supported)|does not exist/i.test(err.message || ''))) throw new AiError('model');
  throw new AiError('other', `${res.status}${err.message ? ' ' + scrub(err.message) : ''}`);
}

/* ---------- OpenAI への問い合わせ ---------- */
// キーが通るかを、課金のない呼び出し（モデルの情報を読む）で確かめる
export async function checkKey(key, model) {
  await call('/models/' + encodeURIComponent(model || MODELS[0].id), key, { method: 'GET' });
  return true;
}
const extOf = mime => (/mp4|m4a|aac/.test(mime) ? 'mp4' : /webm/.test(mime) ? 'webm' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'mp4');
// 1本の録音を文字にする。話者を分けるモデルでは、話者ごとに「話者A：…」の行にして返す。
// 話者を分けるモデルが使えなくなったら（2027-02-26 に終了予定）、gpt-transcribe でやり直し、このページを開いているあいだは gpt-transcribe を使う。
// gpt-transcribe は話者を分けないので、1かたまりの文で返す。用語のヒント（terms：症状とツボの名前）は gpt-transcribe にだけ渡せる
export const FALLBACK_MODEL = 'gpt-transcribe';
let diarizeGone = false;
export async function transcribe(blob, { key, mime, terms } = {}) {
  const type = mime || blob.type || 'audio/mp4';
  const file = new File([blob], 'rokuon.' + extOf(type), { type: type.split(';')[0] });
  if (!diarizeGone) {
    try { return await transcribeDiarized(file, key); } catch (e) {
      if (!(e instanceof AiError && e.code === 'model')) throw e;
      diarizeGone = true;
      console.info(`問診の録音：${TRANSCRIBE_MODEL} が使えないため、${FALLBACK_MODEL} に切り替えました`);
    }
  }
  return transcribePlain(file, key, terms);
}
// 用語のヒント：1語ずつ1行。< > と改行が入っているとリクエストごと断られるので除く（数の上限はドキュメントにないので、多すぎないよう 100 語まで）
const keywordsOf = (terms = {}) => [...new Set([...(terms.symptoms || []), ...(terms.tsubo || [])]
  .map(t => String(t).replace(/[<>\r\n]/g, ' ').trim()).filter(Boolean))].slice(0, 100);
async function transcribePlain(file, key, terms) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('model', FALLBACK_MODEL);
  fd.append('languages[]', 'ja');               // gpt-transcribe では language の代わりに languages を使う（両方は送らない）
  for (const k of keywordsOf(terms)) fd.append('keywords[]', k);
  const r = await call('/audio/transcriptions', key, { method: 'POST', body: fd });      // 答えは { text, languages, usage }
  return String(r.text || '').trim();
}
async function transcribeDiarized(file, key) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('model', TRANSCRIBE_MODEL);
  fd.append('response_format', 'diarized_json');
  fd.append('chunking_strategy', 'auto');          // 30 秒より長い録音では必ず要る
  fd.append('language', 'ja');
  const r = await call('/audio/transcriptions', key, { method: 'POST', body: fd });
  const segs = Array.isArray(r.segments) ? r.segments : [];
  if (!segs.length) return (r.text || '').trim();
  // 同じ話者が続くところは1行にまとめる
  const lines = [];
  for (const s of segs) {
    const t = String(s.text || '').trim();
    if (!t) continue;
    const who = '話者' + (s.speaker || '?');
    if (lines.length && lines[lines.length - 1].who === who) lines[lines.length - 1].text += t;
    else lines.push({ who, text: t });
  }
  return lines.map(l => `${l.who}：${l.text}`).join('\n');
}
// 文字起こしを、見出しと箇条書きに整理する。terms は、聞き間違いを直す手がかりにする言葉（症状とツボの名前）
export async function summarize(transcript, { key, model, prompt, terms = {} } = {}) {
  const hint = [
    terms.symptoms && terms.symptoms.length ? '症状：' + terms.symptoms.join('、') : '',
    terms.tsubo && terms.tsubo.length ? 'ツボ：' + terms.tsubo.join('、') : '',
  ].filter(Boolean).join('\n');
  const input = (hint ? `聞き間違いを直す手がかり（このアプリに登録されている言葉）\n${hint}\n\n` : '') + `――― ここから会話の文字起こし ―――\n${transcript}`;
  const r = await call('/responses', key, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || MODELS[0].id,
      instructions: prompt || DEFAULT_PROMPT,
      input,
      reasoning: { effort: 'low' },
      max_output_tokens: 8000,
      store: false,              // OpenAI 側に答えを残さない
    }),
  });
  // 答えの文は output の中の message → output_text にある（いくつかに分かれていることがある）
  const text = (Array.isArray(r.output) ? r.output : [])
    .filter(o => o && o.type === 'message')
    .flatMap(o => (Array.isArray(o.content) ? o.content : []))
    .filter(c => c && c.type === 'output_text')
    .map(c => c.text || '').join('').trim();
  if (!text) throw new AiError(r.status === 'incomplete' ? 'other' : 'empty', r.status === 'incomplete' ? '答えが長すぎて途中で止まりました' : '');
  return text.replace(/\*\*/g, '').replace(/^#+\s*/gm, '');
}

/* ---------- 録音の一時保存（IndexedDB：tsubo-kiroku-rokuon） ---------- */
// 1本ずつ { id, visitId, seq, blob, mime, created, dur（長さ ms）, text（文字にできたら、その文） } で置く
let clipDb = null;
const index = new Map();         // id → { visitId, dur, created }（画面からすぐ数えられるように、中身なしで持っておく）
function openClips() {
  if (clipDb) return clipDb;
  clipDb = new Promise((res, rej) => {
    const r = indexedDB.open('tsubo-kiroku-rokuon', 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('clips')) r.result.createObjectStore('clips', { keyPath: 'id' }); };
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => d.close(); res(d); };
    r.onerror = () => rej(r.error);
    r.onblocked = () => {};
  });
  clipDb.catch(() => { clipDb = null; });
  return clipDb;
}
const tx = async (mode, fn) => {
  const d = await openClips();
  return new Promise((res, rej) => {
    const t = d.transaction('clips', mode), s = t.objectStore('clips');
    let out;
    fn(s, v => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error);
  });
};
// アプリを開いたときに、残っている録音の一覧を読む
export async function initClips() {
  const all = await tx('readonly', (s, done) => { const r = s.getAll(); r.onsuccess = () => done(r.result); });
  index.clear();
  for (const c of all || []) index.set(c.id, { visitId: c.visitId, dur: c.dur || 0, created: c.created });
}
export async function putClip(c) {
  await tx('readwrite', s => s.put(c));
  index.set(c.id, { visitId: c.visitId, dur: c.dur || 0, created: c.created });
}
export async function clipsOf(visitId) {
  const all = await tx('readonly', (s, done) => { const r = s.getAll(); r.onsuccess = () => done(r.result); });
  return (all || []).filter(c => c.visitId === visitId).sort((a, b) => a.created - b.created || a.seq - b.seq);
}
// その来院の録音を消す。since を渡すと、その時刻からあとに録ったものだけ
export async function deleteClips(visitId, since = 0) {
  const ids = [...index].filter(([, c]) => c.visitId === visitId && c.created >= since).map(([id]) => id);
  if (!ids.length) return;
  await tx('readwrite', s => { for (const id of ids) s.delete(id); });
  for (const id of ids) index.delete(id);
}
// まだ文字にしていない録音の本数と長さ（ms）
export function pendingOf(visitId) {
  let n = 0, ms = 0;
  for (const c of index.values()) if (c.visitId === visitId) { n++; ms += c.dur; }
  return { n, ms };
}
export const hasClips = visitId => [...index.values()].some(c => c.visitId === visitId);

/* ---------- 録音 ---------- */
// 録音の状態は、ここで持つ（画面は描き直されるので、DOM には置かない）。一度に録音できるのは1つの来院だけ
// gaps：今回の録音で、音が録れていなかったあいだ（{ at: 始まった時刻 ms, sec: 秒 }）。gapOpen：いま録れていない。
// stuck：画面に戻って5秒たっても、マイクが止まったまま（画面で、録音のやり直しをすすめる）
export const rec = { visitId: null, startedAt: 0, seq: 0, saving: 0, gaps: [], gapOpen: false, stuck: false };
let stream = null, mr = null, segTimer = null, wake = null, fakeCtx = null, onChange = () => {}, segMs = SEGMENT_SEC * 1000, stopping = null, mimeType = '';
// 録れていないあいだを見つけるための状態（下の「録れていないあいだ」）
let beat = null, lastTick = 0, lastHidden = false, visibleSince = 0, gapStart = 0, curGaps = [], carry = [], lastClip = null, fakeMuted = false, canSleep = false;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
export const isRecording = id => !!rec.visitId && (id == null || rec.visitId === id);
export const elapsed = () => (rec.visitId ? Date.now() - rec.startedAt : 0);

function pickMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return ['audio/mp4', 'audio/webm;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t)) || '';
}
async function keepAwake() {
  try { if (navigator.wakeLock && document.visibilityState === 'visible') wake = await navigator.wakeLock.request('screen'); } catch (e) { wake = null; }
}
document.addEventListener('visibilitychange', () => { if (rec.visitId && document.visibilityState === 'visible') keepAwake(); });

/* ---------- 録れていないあいだ ---------- */
// iPad では、アプリを画面から隠すと、マイクが止められ（track が muted になる）、ページごと止まることもある。
// 隠しているあいだは録れないので、その時間を記録に残す。手がかりは2つ：
// ・マイクの muted（mute / unmute の知らせと、確かめたときの track.muted）
// ・1秒ごとの見回り。前の見回りから15秒以上あいていて、そのとき画面が隠れていた（か、隠れたところから戻った）なら、ページが止まっていたとみなす
// 見回りのほうは、指でさわる端末（iPad・iPhone）だけで使う。パソコンのブラウザは、隠れたタブの見回りを遅らせるだけで、録音は続いているため。
// 2つが重なっても、1回隠していたあいだは1つにまとめる（始まりは早いほうにする）。3秒に満たないものは数えない。
const muted = () => fakeMuted || (stream ? stream.getAudioTracks().some(t => t.muted) : false);
// 録れていないあいだは、それが終わった1本に入れる（区切りをまたいでも切らないので、1回隠していたあいだは1行になり、秒数も二重にならない）
function addGap(start, end) {
  if (end - start < 3000) return null;
  const g = { at: start, sec: Math.round((end - start) / 1000) };
  rec.gaps.push(g); curGaps.push(g);
  return g;
}
function check(back = false) {
  if (!rec.visitId) return;
  const now = Date.now(), prev = lastTick, wasHidden = lastHidden;
  const hidden = document.visibilityState === 'hidden';
  lastTick = now; lastHidden = hidden;
  if (hidden) visibleSince = 0; else if (!visibleSince) visibleSince = now;
  let start = gapStart, closed = null;
  if (canSleep && prev && now - prev >= 15000 && (wasHidden || back)) start = start ? Math.min(start, prev) : prev;
  if (muted()) { if (!start) start = now; gapStart = start; }
  else { gapStart = 0; if (start) closed = addGap(start, now); }
  const stuck = !!gapStart && !!visibleSince && now - visibleSince > 5000;
  const changed = rec.gapOpen !== !!gapStart || rec.stuck !== stuck;
  rec.gapOpen = !!gapStart; rec.stuck = stuck;
  if (closed) onChange({ gap: closed });
  else if (changed) onChange({});
}
const onVis = () => check(document.visibilityState === 'visible');
const onMute = () => check();
// 録音を止めるときに、開いたままのあいだを、いま閉じる（最後の1本に入る）
function closeOpenGap() {
  if (gapStart) addGap(gapStart, Date.now());
  gapStart = 0;
}

// 1本ぶんのレコーダーを作って始める。止まったら、その1本をすぐ保存する
function startOne() {
  const opts = { audioBitsPerSecond: 32000 };
  if (mimeType) opts.mimeType = mimeType;
  const r = new MediaRecorder(stream, opts);
  const chunks = [], t0 = Date.now(), visitId = rec.visitId, seq = rec.seq++;
  const myGaps = curGaps = [];       // この1本のあいだに終わった「録れていないあいだ」
  r.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  r.onstop = () => {
    const dur = Date.now() - t0;
    // 1秒に満たない切れ端は残さない（録れていないあいだは、次の1本か、最後に保存した1本に回す）
    if (!chunks.length || dur < 800) { carry.push(...myGaps); return; }
    const type = r.mimeType || mimeType || chunks[0].type || 'audio/mp4';
    const gaps = [...carry.splice(0), ...myGaps].map(g => ({ ...g }));
    const clip = { id: uid(), visitId, seq, blob: new Blob(chunks, { type }), mime: type, created: t0, dur };
    if (gaps.length) clip.gaps = gaps;
    lastClip = clip;
    rec.saving++;
    const p = putClip(clip)
      .catch(e => { console.error(e); onChange({ error: 'save' }); })
      .finally(() => { rec.saving--; onChange({}); });
    saves.push(p);
  };
  r.onerror = () => finish('broken');
  r.start();             // 細かく区切らず、止めたときに1本のファイルとして受け取る
  mr = r;
  clearTimeout(segTimer);
  segTimer = setTimeout(rotate, segMs);
}
let saves = [];
// 同じマイクの流れのまま、レコーダーだけを作り直す（区切った断片は、1本ずつ単体で読めるファイルになる）
function rotate() {
  if (!rec.visitId || !mr) return;
  const old = mr;
  startOne();
  try { old.stop(); } catch (e) {}
}

// 動作確認用：マイクのない環境で、にせの音（ピーという音）の流れを作る。
// 音を鳴らす装置のない環境では AudioContext の時計が進まず、何も録れないので、使えるときは音のデータを直に流す部品を使う
function fakeStream() {
  if (typeof MediaStreamTrackGenerator === 'function' && typeof AudioData === 'function') {
    const gen = new MediaStreamTrackGenerator({ kind: 'audio' }), w = gen.writable.getWriter();
    const rate = 48000, n = 480;
    let ts = 0, ph = 0;
    const iv = setInterval(() => {
      for (let k = 0; k < 5; k++) {
        const d = new Float32Array(n);
        for (let i = 0; i < n; i++) { d[i] = 0.2 * Math.sin(ph); ph += 2 * Math.PI * 330 / rate; }
        w.write(new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: 1, timestamp: ts, data: d })).catch(() => {});
        ts += n / rate * 1e6;
      }
    }, 50);
    fakeCtx = { close: async () => clearInterval(iv) };
    return new MediaStream([gen]);
  }
  fakeCtx = new (window.AudioContext || window.webkitAudioContext)();
  fakeCtx.resume().catch(() => {});
  const osc = fakeCtx.createOscillator(), dest = fakeCtx.createMediaStreamDestination();
  osc.frequency.value = 330; osc.connect(dest); osc.start();
  return dest.stream;
}

// 録音を始める。opts.segSec で区切りの長さ、opts.fakeMic でマイクがないときのにせの音（動作確認用）
export async function startRec(visitId, opts = {}) {
  if (rec.visitId) throw new Error('busy');
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('unsupported');
  onChange = opts.onChange || (() => {});
  segMs = Math.max(2, Number(opts.segSec) || SEGMENT_SEC) * 1000;
  try {
    const ask = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    // 動作確認の画面では、マイクの許可の問い合わせが返ってこないことがあるので、少し待ってあきらめる
    stream = await (opts.fakeMic ? Promise.race([ask, new Promise((res, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]) : ask);
  } catch (e) {
    if (!opts.fakeMic) throw e;
    stream = fakeStream();
  }
  mimeType = pickMime();
  rec.visitId = visitId; rec.startedAt = Date.now(); rec.seq = 0; saves = [];
  rec.gaps = []; rec.gapOpen = false; rec.stuck = false;
  gapStart = 0; carry = []; lastClip = null; fakeMuted = false; canSleep = navigator.maxTouchPoints > 1 || !!opts.fakeMic;
  lastTick = Date.now(); lastHidden = document.visibilityState === 'hidden'; visibleSince = lastHidden ? 0 : lastTick;
  for (const t of stream.getAudioTracks()) { t.onended = () => finish('ended'); t.onmute = onMute; t.onunmute = onMute; }
  document.addEventListener('visibilitychange', onVis);
  beat = setInterval(() => check(), 1000);
  // 動作確認用（?mock のにせのマイクのときだけ）：N 秒のあいだマイクが止まっていたことにする。open を付けると、止まったままにする
  if (opts.fakeMic) window.__recGap = (sec, open) => {
    fakeMuted = true; check();
    if (gapStart) gapStart = Math.min(gapStart, Date.now() - (Number(sec) || 0) * 1000);
    if (!open) { fakeMuted = false; check(); }
  };
  try { startOne(); } catch (e) { cleanup(); throw e; }
  keepAwake();
  onChange({});
}
function cleanup() {
  clearTimeout(segTimer); segTimer = null;
  clearInterval(beat); beat = null;
  document.removeEventListener('visibilitychange', onVis);
  delete window.__recGap;
  fakeMuted = false;
  if (stream) for (const t of stream.getTracks()) { t.onended = null; t.onmute = null; t.onunmute = null; t.stop(); }
  stream = null; mr = null;
  if (fakeCtx) { fakeCtx.close().catch(() => {}); fakeCtx = null; }
  if (wake) { wake.release().catch(() => {}); wake = null; }
}
// 録音を終える。why があれば、途中で止まった（マイクが外れた・レコーダーの不具合）
async function finish(why) {
  if (!rec.visitId) return stopping;
  if (stopping) return stopping;
  const visitId = rec.visitId, startedAt = rec.startedAt;
  stopping = (async () => {
    const last = mr;
    clearTimeout(segTimer);
    clearInterval(beat); beat = null;     // 止めているあいだに、見回りが新しいあいだを開かないように
    closeOpenGap();          // 止めるときに開いたままのあいだは、ここで閉じて、最後の1本に入れる
    if (last && last.state !== 'inactive') {
      // 止まった知らせが来ないときも、3秒であきらめて先へ進む（画面が止まらないように）
      await new Promise(res => { last.addEventListener('stop', () => setTimeout(res, 0), { once: true }); setTimeout(res, 3000); try { last.stop(); } catch (e) { res(); } });
    }
    cleanup();
    await Promise.allSettled(saves);
    // 最後の切れ端が短くて捨てた場合、その録れていないあいだは、最後に保存した1本に足す
    if (carry.length && lastClip) {
      lastClip.gaps = [...(lastClip.gaps || []), ...carry.splice(0).map(g => ({ ...g }))];
      try { await putClip(lastClip); } catch (e) { console.error(e); }
    }
    carry = []; gapStart = 0;
    rec.visitId = null; rec.startedAt = 0; rec.gapOpen = false; rec.stuck = false;
    stopping = null;
    const out = { visitId, startedAt, why };
    onChange(why ? { stopped: out } : {});
    return out;
  })();
  return stopping;
}
// 止めて、録った分を保存し終えるまで待つ
export const stopRec = () => finish('');
// 取り消す：止めて、今回録った分を捨てる
export async function cancelRec() {
  const r = await finish('');
  if (r) await deleteClips(r.visitId, r.startedAt);
  onChange({});
  return r;
}
