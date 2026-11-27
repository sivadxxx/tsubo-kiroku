// ツボ記録：来院ごとに使ったツボを選んで残し、症状ごとに「効いたツボ」を集計する
import { openStore } from './store.js';
import { EFFECTS, effectMark, flatten, aggregate, sortAgg } from './stats.js';
import { createCloud, explain } from './cloud-firebase.js';
import { firebaseConfig } from './config.js';
import * as ms from './monshin.js';
import { makePdf } from './pdf.js';

const VERSION = '1.15';
// 最初から入れておく症状（問診票のチェック項目）。「リスト」でいつでも足せる・消せる
const SEED_SYMPTOMS = ['肩こり', '首のこり', '頭痛', 'めまい', 'ほてり', '目の疲れ', '動悸', '息切れ', '鼻づまり', '倦怠感', '背中の痛み', '腕の痛み', '腰痛', '胃痛', '腹痛', '便秘', '下痢', '生理痛', '股関節痛', '膝痛', '足の痛み', '足のむくみ', '足の痺れ', '冷え性', '不眠'];
const SIDES = [{ v: 'L', label: 'L' }, { v: 'R', label: 'R' }, { v: 'B', label: '両' }, { v: '', label: '中' }];
const sideLabel = v => (SIDES.find(s => s.v === (v || '')) || SIDES[3]).label;

let store;                 // いまの保存先。ログインしていないときは端末の中、ログイン中はクラウド
const db = { patients: new Map(), visits: new Map(), tsubo: new Map(), symptoms: new Map(), places: new Map(), staff: new Map(), meta: new Map() };

/* ---------- 小さな道具 ---------- */
const $ = s => document.querySelector(s);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
function fmtDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  const base = `${m}/${d}（${'日月火水木金土'[new Date(y, m - 1, d).getDay()]}）`;
  return y === new Date().getFullYear() ? base : `${y}/${base}`;
}
// 検索用：全角半角・大文字小文字・カタカナひらがなの違いをなくす
const norm = s => (s || '').normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/\s+/g, '');
const byName = (a, b) => a.name.localeCompare(b.name, 'ja');
const byCreated = (a, b) => a.created - b.created;
// 「リスト」で自分で並べた順（order）。まだ並べていないものは後ろに回し、rest の順で並べる
const ord = x => (typeof x.order === 'number' ? x.order : Infinity);
const byOrder = rest => (a, b) => (ord(a) === ord(b) ? rest(a, b) : ord(a) - ord(b));
const tsuboOrder = byOrder((a, b) => (a.group || '').localeCompare(b.group || '', 'ja') || byName(a, b));      // 並べていないツボは、グループ → 名前の順
function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600); }

/* ---------- 保存 ---------- */
async function put(kind, obj) {
  obj.updated = Date.now();
  db[kind].set(obj.id, obj);
  try { await store.put(kind, obj); } catch (e) { console.error(e); toast('保存できませんでした。もう一度お試しください'); }
}
async function del(kind, id) {
  db[kind].delete(id);
  try { await store.del(kind, id); } catch (e) { console.error(e); toast('削除できませんでした'); }
}
const metaGet = k => (db.meta.get(k) || {}).value;
const metaSet = (k, value) => put('meta', { id: k, value });

/* ---------- 記録の読み方 ---------- */
const visitOrder = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.created - b.created);
const visitsOf = pid => [...db.visits.values()].filter(v => v.patientId === pid).sort(visitOrder);
function visitsByPatient() {
  const m = new Map();
  for (const v of db.visits.values()) { if (!m.has(v.patientId)) m.set(v.patientId, []); m.get(v.patientId).push(v); }
  for (const l of m.values()) l.sort(visitOrder);
  return m;
}
// 名前で管理する場所の患者は名前、番号で管理する場所の患者は「No.〜」で表す
const patientName = p => (!p ? '（患者が見つかりません）' : p.name ? p.name : `No.${p.no || ''}${p.label ? '　' + p.label : ''}`);
const tsuboName = id => (db.tsubo.get(id) || { name: '（消したツボ）' }).name;
const symptomName = id => (id == null ? '症状を選んでいない記録' : (db.symptoms.get(id) || { name: '（消した症状）' }).name);
const activeTsubo = () => [...db.tsubo.values()].filter(t => !t.archived);
const activeSymptoms = () => [...db.symptoms.values()].filter(s => !s.archived);
// 担当者（施術をした人）。来院の記録ごとに1人選べる（選ばなくてもよい）。
// 担当者は、出ている場所をいくつでも持てる（placeIds）。場所の決まっていない担当者（placeIds が空・その場所がもうない）は、すべての場所で選べる。
// placeId は、場所を1つしか持てなかった版（1.5）の書き方。読むときだけ受け付ける
const staffName = id => (db.staff.get(id) || { name: '（消した担当者）' }).name;
const staffPlaces = s => (Array.isArray(s.placeIds) ? s.placeIds : s.placeId ? [s.placeId] : []).filter(id => db.places.has(id));
const setStaffPlaces = (s, ids) => { s.placeIds = places().map(pl => pl.id).filter(id => ids.includes(id)); delete s.placeId; };
const inStaffPlace = (s, placeId) => { const ps = staffPlaces(s); return !placeId || !ps.length || ps.includes(placeId); };
const activeStaff = placeId => [...db.staff.values()].filter(s => !s.archived && inStaffPlace(s, placeId)).sort(byOrder(byCreated));
// 新しい記録に最初から入れておく担当者：この患者の前回の担当者 → この端末で最後に選んだ担当者 → 1人しかいなければその人
function defaultStaff(last, placeId) {
  const act = activeStaff(placeId), ok = id => act.some(s => s.id === id);
  return last && ok(last.staffId) ? last.staffId : ok(metaGet('staff')) ? metaGet('staff') : act.length === 1 ? act[0].id : null;
}
// 場所（治療院・病院など）。患者は、どこか1つの場所に属する。場所の決まっていない患者（場所ができる前の記録）は、最初の場所に属するものとして扱う
const places = () => [...db.places.values()].sort((a, b) => a.created - b.created);
const placeOf = p => (db.places.has(p.placeId) ? p.placeId : places()[0].id);
const curPlace = () => db.places.get(metaGet('place')) || places()[0];
// 来院の中の症状が変わったら、ツボの行がさす症状をそろえる
function fixRows(v) {
  for (const r of v.rows) if (!v.symptoms.includes(r.symptomId)) r.symptomId = v.symptoms[0] || null;
}
// 問診の記録（talk）がある・録音中・まだ文字にしていない録音がある来院は、空ではない（自動で消さない）
const isEmptyVisit = v => v.rows.length === 0 && !(v.memo || '').trim() && !v.talk && !ms.isRecording(v.id) && !ms.hasClips(v.id) && !talkJobs.has(v.id);

/* ---------- 重ねて出す画面 ---------- */
function openDialog({ title, body, footer, full, onClose }) {
  const dlg = h('dialog', { class: full ? 'full' : '' },
    h('div', { class: 'in' },
      h('div', { class: 'row' }, h('h1', { class: 'grow' }, title), full ? h('button', { class: 'btn primary', onclick: () => dlg.close() }, '完了') : null),
      h('div', { class: 'scroll' }, body),
      footer ? h('div', { class: 'row wrap', style: 'justify-content:flex-end' }, footer) : null));
  dlg.addEventListener('close', () => { dlg.remove(); if (onClose) onClose(); setTimeout(() => { if (needRender && !busy()) render(); }, 50); });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}
function confirmDialog(message, okLabel = 'OK', danger = false) {
  return new Promise(res => {
    let ok = false;
    const dlg = openDialog({
      title: '確認',
      body: h('p', { style: 'white-space:pre-wrap' }, message),
      footer: [
        h('button', { class: 'btn', onclick: () => dlg.close() }, 'やめる'),
        h('button', { class: 'btn primary' + (danger ? ' danger-fill' : ''), style: danger ? 'background:var(--danger);border-color:var(--danger)' : '', onclick: () => { ok = true; dlg.close(); } }, okLabel),
      ],
      onClose: () => res(ok),
    });
  });
}

/* ---------- ドラッグでの並べ替え ---------- */
// ul の中の、data-id の付いた行を、つまみ（.grip）を引いて並べ替えられるようにする。指でもマウスでも同じ。
// 並びが変わったら onDone(並んだ順の id, キーで動かした行の id) を呼ぶ
let dragging = false;
function sortable(ul, onDone) {
  let d = null;
  const ids = () => [...ul.children].filter(li => li.dataset.id).map(li => li.dataset.id);
  const slide = (li, from) => {      // 場所をゆずった行を、元の位置からすべらせる
    li.style.transition = 'none'; li.style.transform = `translateY(${from - li.offsetTop}px)`;
    li.offsetHeight;
    li.style.transition = 'transform .15s'; li.style.transform = '';
  };
  const place = () => {
    const { li } = d, rows = [...ul.children].filter(x => x.dataset.id), last = rows[rows.length - 1];
    // 行の上の端を置きたい位置（リストの外には出さない）
    const top = Math.max(rows[0].offsetTop, Math.min(last.offsetTop + last.offsetHeight - li.offsetHeight, d.top0 + (d.y - d.y0) + (window.scrollY - d.sy0)));
    const mid = top + li.offsetHeight / 2;
    // 引いている行そのものは動かさず（動かすと指を離したことになる）、通りすぎた行のほうを反対側へ移す
    for (;;) {
      const prev = li.previousElementSibling, next = li.nextElementSibling;
      if (prev && prev.dataset.id && mid <= prev.offsetTop + prev.offsetHeight / 2) { const t = prev.offsetTop; li.after(prev); slide(prev, t); }
      else if (next && next.dataset.id && mid >= next.offsetTop + next.offsetHeight / 2) { const t = next.offsetTop; li.before(next); slide(next, t); }
      else break;
    }
    li.style.transform = `translateY(${top - li.offsetTop}px)`;
  };
  const tick = () => {               // 画面の上下の端まで引いたら、リストを送る（下はタブの分だけ手前から）。端に近いほど速く
    if (!ul.isConnected) { clearInterval(d.timer); d = null; dragging = false; return; }      // 引いているあいだに画面が変わった
    const now = performance.now();
    const over = d.y < 80 ? d.y - 80 : d.y > innerHeight - 140 ? d.y - (innerHeight - 140) : 0;
    const dt = Math.min(100, now - (d.t || now)); d.t = now;
    d.acc = over ? (d.acc || 0) + Math.max(-900, Math.min(900, over * 14)) * dt / 1000 : 0;      // 1px に満たない分は、次に回す
    const step = Math.trunc(d.acc);
    if (step) { d.acc -= step; window.scrollBy(0, step); place(); }
  };
  const end = e => {
    if (!d || e.pointerId !== d.id) return;
    clearInterval(d.timer);
    const { li, before } = d;
    d = null; dragging = false;
    li.classList.remove('dragging'); li.style.transform = ''; li.style.transition = '';
    if (ids().join() !== before) onDone(ids());
    else if (needRender && !busy()) render();
  };
  ul.addEventListener('pointerdown', e => {
    const grip = e.target.closest('.grip');
    if (!grip || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (d) end({ pointerId: d.id });      // 前のドラッグが終わりそこねていたら、ここで終わらせる
    const li = grip.closest('li');
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch (err) {}
    d = { li, id: e.pointerId, y0: e.clientY, y: e.clientY, sy0: window.scrollY, top0: li.offsetTop, before: ids().join() };
    dragging = true;
    li.style.transition = 'none';
    li.classList.add('dragging');
    d.timer = setInterval(tick, 16);
  });
  ul.addEventListener('pointermove', e => { if (d && e.pointerId === d.id) { d.y = e.clientY; place(); } });
  ul.addEventListener('pointerup', end);
  ul.addEventListener('pointercancel', end);
  ul.addEventListener('lostpointercapture', end);
  // キーボード：つまみに合わせて、上下の矢印キーで1つずつ動かす
  ul.addEventListener('keydown', e => {
    const grip = e.target.closest('.grip');
    if (!grip || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const li = grip.closest('li'), other = e.key === 'ArrowUp' ? li.previousElementSibling : li.nextElementSibling;
    if (!other || !other.dataset.id) return;
    if (e.key === 'ArrowUp') other.before(li); else other.after(li);
    onDone(ids(), li.dataset.id);
  });
  return ul;
}

/* ---------- 画面の切り替え ---------- */
let lastRoute = '';
function parseRoute() {
  const [name = '', arg = ''] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || 'patients', arg, key: name + '/' + arg };
}
function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
async function render() {
  const r = parseRoute();
  needRender = false;
  if (!db.places.size && r.name !== 'settings') {      // ログイン直後など、クラウドの記録がまだ届いていないとき
    $('#view').replaceChildren(h('p', { class: 'empty' }, user && syncError ? `クラウドから記録を読み込めませんでした（${syncError}）「設定」をご覧ください。` : '記録を読み込んでいます…'));
    lastRoute = r.key;
    return;
  }
  // 何も入れずに閉じた来院の記録は残さない
  const left = lastRoute.startsWith('v/') && lastRoute !== r.key ? db.visits.get(lastRoute.slice(2)) : null;
  if (left && isEmptyVisit(left)) await del('visits', left.id);
  const y = r.key === lastRoute ? window.scrollY : 0;
  const views = { patients: viewPatients, p: viewPatient, v: viewVisit, stats: viewStats, lists: viewLists, settings: viewSettings };
  const view = views[r.name] || viewPatients;
  $('#view').replaceChildren(...[].concat(view(r.arg)).flat(Infinity).filter(Boolean));
  const tab = { stats: 'stats', lists: 'lists', settings: 'settings' }[r.name] || 'rec';
  for (const a of document.querySelectorAll('#tabs a')) a.dataset.tab === tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  lastRoute = r.key;
  window.scrollTo(0, y);
  updateRecUi();
}
const topbar = (title, back, sub, right) => h('div', { class: 'top' },
  back ? h('button', { class: 'btn icon', 'aria-label': '戻る', onclick: () => go(back) }, '‹') : null,
  h('div', { class: 'grow' }, h('h1', null, title), sub ? h('span', { class: 'sub' }, sub) : null),
  right || null);

/* ---------- 患者の一覧 ---------- */
let patientQuery = '';
function viewPatients() {
  const idx = visitsByPatient();
  const place = curPlace();
  const mine = [...db.patients.values()].filter(p => placeOf(p) === place.id);
  const listEl = h('ul', { class: 'list' });
  const draw = () => {
    const q = norm(patientQuery);
    const rows = mine
      .map(p => { const vs = idx.get(p.id) || []; const last = vs[vs.length - 1]; return { p, vs, last, key: last ? last.date : ymd(new Date(p.created)) }; })
      .filter(x => !q || [x.p.no, x.p.label, x.p.name, x.p.yomi].some(s => norm(s).includes(q)))
      .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : b.p.created - a.p.created));
    listEl.replaceChildren(...rows.map(({ p, vs, last }) => h('li', null, h('button', { class: 'item', onclick: () => go('#/p/' + p.id) },
      h('span', { class: 'ttl' }, patientName(p)),
      h('span', { class: 'sub' }, last ? `最終 ${fmtDate(last.date)}・${vs.length}回${last.symptoms.length ? '・' + last.symptoms.map(symptomName).join('、') : ''}` : 'まだ記録がありません')))));
    if (!rows.length) listEl.append(h('li', { class: 'empty' }, mine.length ? '当てはまる患者がいません。' : place.mode === 'name' ? 'まず「患者を追加」から、患者の名前を登録してください。' : 'まず「患者を追加」から、カルテの番号を登録してください。'));
  };
  draw();
  const lastBackup = metaGet('lastBackup');
  const stale = !user && db.visits.size >= 5 && (!lastBackup || Date.now() - lastBackup > 30 * 864e5);
  return [
    topbar('ツボ記録', null, null, h('button', { class: 'btn primary', onclick: () => editPatient(null) }, '＋ 患者を追加')),
    h('div', { class: 'chips' },
      places().map(pl => h('button', { class: 'chip', 'aria-pressed': String(pl.id === place.id), onclick: async () => { patientQuery = ''; await metaSet('place', pl.id); render(); } }, pl.name)),
      h('button', { class: 'chip', style: 'color:var(--sub)', onclick: () => editPlace(null) }, '＋ 場所')),
    mine.length > 5 ? h('input', { type: 'search', placeholder: place.mode === 'name' ? '名前・よみでさがす' : '番号・呼び名でさがす', value: patientQuery, oninput: e => { patientQuery = e.target.value; draw(); } }) : null,
    stale ? h('button', { class: 'item', onclick: () => go('#/settings') }, h('span', { class: 'sub' }, lastBackup ? '控えを取ってから1か月以上たっています。「設定」から書き出しておくと安心です。' : 'まだ控えを取っていません。「設定」から書き出しておくと安心です。')) : null,
    user && syncError ? h('button', { class: 'item', onclick: () => go('#/settings') }, h('span', { class: 'sub', style: 'color:var(--danger)' }, `クラウドとのやりとりで問題が起きています（${syncError}）`)) : null,
    listEl,
  ];
}
function nextPatientNo(placeId) {
  let max = 0;
  for (const p of db.patients.values()) {
    if (placeOf(p) !== placeId) continue; const n = parseInt(norm(p.no), 10); if (n > max) max = n; }
  return String(max + 1);
}
function editPatient(p) {
  const isNew = !p;
  const place = isNew ? curPlace() : db.places.get(placeOf(p));
  const nameMode = place.mode === 'name';
  const no = h('input', { type: 'text', value: isNew ? nextPatientNo(place.id) : p.no || '', inputMode: 'numeric', autocomplete: 'off' });
  const label = h('input', { type: 'text', value: isNew ? '' : p.label || '', placeholder: 'イニシャルなど（空欄でもよい）', autocomplete: 'off' });
  const name = h('input', { type: 'text', value: isNew ? '' : p.name || '', placeholder: '例：山田 花子', autocomplete: 'off' });
  const yomi = h('input', { type: 'text', value: isNew ? '' : p.yomi || '', placeholder: 'ひらがな（さがすときに使います。空欄でもよい）', autocomplete: 'off' });
  const memo = h('textarea', { value: isNew ? '' : p.memo || '', placeholder: '主訴の覚え書きなど' });
  const save = async () => {
    const others = [...db.patients.values()].filter(x => placeOf(x) === place.id && (isNew || x.id !== p.id));
    const obj = isNew ? { id: uid(), created: Date.now() } : p;
    if (nameMode) {
      const v = name.value.trim().replace(/\s+/g, ' ');
      if (!v) { toast('名前を入れてください'); return; }
      if (others.some(x => x.name === v)) { toast(`「${v}」はすでに登録されています。同じ名前の方は、名前のあとに印を付けて区別してください`); return; }
      Object.assign(obj, { name: v, yomi: yomi.value.trim() });
    } else {
      const v = no.value.trim();
      if (!v) { toast('番号を入れてください'); return; }
      if (others.some(x => x.no === v)) { toast(`No.${v} はすでに登録されています`); return; }
      Object.assign(obj, { no: v, label: label.value.trim() });
    }
    Object.assign(obj, { placeId: place.id, memo: memo.value.trim() });
    await put('patients', obj);
    saved = obj.id; dlg.close();
  };
  let saved = null, removed = false;
  const dlg = openDialog({
    title: (isNew ? '患者を追加' : '患者の情報') + (db.places.size > 1 ? `（${place.name}）` : ''),
    body: [
      nameMode ? [h('label', { class: 'f' }, '名前', name), h('label', { class: 'f' }, 'よみ', yomi)]
        : [h('label', { class: 'f' }, 'カルテの番号（No）', no), h('label', { class: 'f' }, '呼び名', label)],
      h('label', { class: 'f' }, 'メモ', memo),
      h('p', { class: 'sub' }, nameMode ? (user ? '名前は、クラウド（読めるのはご自身のログインだけ）と、書き出した控え・CSV のファイルに入ります。' : '名前は、この端末の中と、書き出した控え・CSV のファイルに入ります。') + 'ファイルの置き場所や渡す相手にご注意ください。'
        : '氏名・住所・電話番号はここに入れず、GoodNotes の問診票に残してください。問診票の「No」の欄に同じ番号を書いておくと、すぐに照らし合わせられます。'),
      isNew ? null : h('button', { class: 'btn danger small', style: 'align-self:flex-start', onclick: async () => {
        const n = visitsOf(p.id).length;
        if (!await confirmDialog(`${patientName(p)} を削除します。${n ? `\nこの患者の記録 ${n} 回分も消え、元に戻せません。` : ''}`, '削除する', true)) return;
        try { await store.delMany({ patients: [p.id], visits: visitsOf(p.id).map(v => v.id) }); } catch (e) { console.error(e); toast('削除できませんでした'); return; }
        for (const v of visitsOf(p.id)) { await dropClips(v.id); db.visits.delete(v.id); }
        db.patients.delete(p.id);
        removed = true; dlg.close();
      } }, 'この患者を削除'),
    ],
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'やめる'), h('button', { class: 'btn primary', onclick: save }, '保存')],
    onClose: () => { if (removed) go('#/'); else if (saved && isNew) go('#/p/' + saved); else render(); },
  });
}

/* ---------- 場所（治療院・病院など） ---------- */
function editPlace(pl) {
  const isNew = !pl;
  const count = isNew ? 0 : [...db.patients.values()].filter(p => placeOf(p) === pl.id).length;
  const name = h('input', { type: 'text', value: isNew ? '' : pl.name, placeholder: '例：〇〇病院', autocomplete: 'off' });
  let mode = isNew ? 'no' : pl.mode || 'no';
  const modes = h('div', { class: 'seg' });
  const drawModes = () => modes.replaceChildren(...[['no', '番号で管理'], ['name', '名前で管理']].map(([m, l]) => h('button', { class: 'btn', 'aria-pressed': String(mode === m), onclick: () => { mode = m; drawModes(); } }, l)));
  drawModes();
  const dlg = openDialog({
    title: isNew ? '場所を追加' : '場所',
    body: [
      h('label', { class: 'f' }, '場所の名前', name),
      h('div', { class: 'f' }, h('span', { class: 'sub' }, '患者の管理のしかた'), modes),
      h('p', { class: 'sub' }, '「番号で管理」はカルテの番号と呼び名、「名前で管理」は患者の名前で登録します。ツボと症状のリストは、すべての場所で共通です。' + (count ? 'すでに登録した患者の表示は、その患者を開いて保存しなおすまで変わりません。' : '')),
      isNew ? null : count || db.places.size <= 1 ? h('p', { class: 'sub' }, count ? `患者が ${count}人 登録されているので、この場所は削除できません。` : '場所は1つ以上必要なので、削除できません。')
        : h('button', { class: 'btn danger small', style: 'align-self:flex-start', onclick: async () => { await del('places', pl.id); dlg.close(); } }, 'この場所を削除'),
    ],
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'やめる'), h('button', { class: 'btn primary', onclick: async () => {
      const t = name.value.trim();
      if (!t) { toast('場所の名前を入れてください'); return; }
      if (places().some(o => o.name === t && (isNew || o.id !== pl.id))) { toast(`「${t}」はすでにあります`); return; }
      const obj = isNew ? { id: uid(), created: Date.now() } : pl;
      Object.assign(obj, { name: t, mode });
      await put('places', obj);
      if (isNew) { await metaSet('place', obj.id); patientQuery = ''; }
      dlg.close();
    } }, '保存')],
    onClose: render,
  });
}

/* ---------- 患者ごとの画面 ---------- */
function viewPatient(id) {
  const p = db.patients.get(id);
  if (!p) return [topbar('記録', '#/'), h('p', { class: 'empty' }, 'この患者は見つかりません。')];
  const vs = visitsOf(id);
  const start = async () => {
    let v = vs.find(x => x.date === today());
    if (!v) {
      const last = vs[vs.length - 1];
      v = { id: uid(), patientId: id, date: today(), staffId: defaultStaff(last, placeOf(p)), symptoms: last ? last.symptoms.filter(s => db.symptoms.has(s)) : [], rows: [], memo: '', created: Date.now() };
      await put('visits', v);
    }
    go('#/v/' + v.id);
  };
  if (pv.id !== id) Object.assign(pv, { id, sort: 'good', sym: null, all: false });      // ほかの患者を開いたら、初めの状態に戻す
  return [
    topbar(patientName(p), '#/', null, h('button', { class: 'btn small', onclick: () => editPatient(p) }, '編集')),
    h('button', { class: 'btn primary big', onclick: start }, vs.some(x => x.date === today()) ? '今日の記録を開く' : '＋ 今日の施術を記録'),
    patientInfoCard(p, vs),
    patientTalkCard(vs),
    patientTsuboCard(vs),
    h('h2', null, `これまでの記録（${vs.length}回）`),
    vs.length ? h('ul', { class: 'list' }, vs.map((v, i) => h('li', null, h('button', { class: 'item', onclick: () => go('#/v/' + v.id) },
      h('span', { class: 'ttl' }, fmtDate(v.date), h('small', null, `${i + 1}回目` + (db.staff.has(v.staffId) ? `・担当 ${staffName(v.staffId)}` : '')), v.symptoms.map(s => h('span', { class: 'tag' }, symptomName(s))),
        v.talk ? h('span', { class: 'tag talk' }, '問診') : ms.hasClips(v.id) ? h('span', { class: 'tag talk' }, '未処理の録音') : null),
      h('span', { class: 'marks' }, v.rows.length ? v.rows.map(r => h('span', null, tsuboName(r.tsuboId), sideLabel(r.side) === '中' ? '' : ' ' + sideLabel(r.side), r.effect != null ? [' ', h('b', null, effectMark(r.effect))] : '')) : h('span', { class: 'sub' }, 'ツボの記録なし')),
      v.memo ? h('span', { class: 'sub' }, v.memo) : null))).reverse())
      : h('p', { class: 'empty' }, 'まだ記録がありません。'),
  ];
}
// 患者の画面の「使ったツボ」の並べ方・症状のしぼり込み・すべて見るか（ほかの患者を開くと初めに戻す）
const pv = { id: null, sort: 'good', sym: null, all: false };
const pvTalkOpen = new Set();      // 患者の画面で開いている、前の問診のまとめ（来院の id）。描き直しても閉じないように
// 項目名（小さく薄い字）と中身を縦に並べる
const infoItem = (label, ...body) => h('div', null, h('div', { class: 'sub' }, label), h('div', null, ...body));
function patientInfoCard(p, vs) {
  const first = vs[0], last = vs[vs.length - 1];
  // 名前があれば名前で、なければ番号で（patientName と同じ見分け方。場所の管理のしかたを変えたあとの患者もそのまま出す）
  const who = p.name ? [infoItem('名前', p.name), p.yomi ? infoItem('よみ', p.yomi) : null]
    : [infoItem('No', p.no || ''), p.label ? infoItem('呼び名', p.label) : null];
  return h('div', { class: 'card' },
    h('h2', null, '患者さんの情報'),
    who,
    db.places.size > 1 ? infoItem('場所', db.places.get(placeOf(p)).name) : null,
    infoItem('来院', vs.length ? [`初回 ${fmtDate(first.date)}`, `最終 ${fmtDate(last.date)}`, `${vs.length}回`].map((s, i) => [i ? ' ・ ' : '', h('span', { style: 'white-space:nowrap' }, s)])      // 「4」と「回」のあいだなどで折り返さない
      : h('span', { class: 'sub' }, 'まだ来院の記録がありません')),
    infoItem('メモ', p.memo ? h('div', { class: 'pre' }, p.memo) : h('span', { class: 'sub' }, 'メモはまだありません（「編集」から書けます）')));
}
// 問診のまとめ：いちばん新しいものは全文を開いて、それより前のものは閉じて並べる
function patientTalkCard(vs) {
  const list = vs.map((v, i) => ({ v, n: i + 1 })).filter(x => x.v.talk && (x.v.talk.summary || '').trim()).reverse();
  const title = x => `${fmtDate(x.v.date)}・${x.n}回目`;
  const openBtn = x => h('button', { class: 'btn', onclick: () => go('#/v/' + x.v.id) }, 'この日の記録をひらく');
  const body = x => h('div', { class: 'pre' }, x.v.talk.summary);
  if (!list.length) return h('div', { class: 'card' }, h('h2', null, '問診のまとめ'), h('p', { class: 'sub' }, '問診を録音すると、ここにまとめが出ます。'));
  const [top, ...older] = list;
  return h('div', { class: 'card' },
    h('h2', null, '問診のまとめ'),
    h('div', { class: 'row wrap', style: 'justify-content:space-between' }, h('b', null, title(top)), openBtn(top)),
    body(top),
    older.map(x => h('details', { class: 'talk-all', open: pvTalkOpen.has(x.v.id), ontoggle: e => { if (e.target.open) pvTalkOpen.add(x.v.id); else pvTalkOpen.delete(x.v.id); } },
      h('summary', null, title(x)), body(x), openBtn(x))));
}
// 使ったツボ：この患者の来院だけで集計する。行の書き方は、統計の「症状ごとの効いたツボ」とそろえる
function patientTsuboCard(vs) {
  const rows = flatten(vs);
  const syms = [...new Set(rows.map(r => r.symptomId).filter(s => s != null))];
  if (syms.length < 2 || !syms.includes(pv.sym)) pv.sym = null;
  const list = sortAgg(aggregate(pv.sym == null ? rows : rows.filter(r => r.symptomId === pv.sym), r => r.tsuboId), pv.sort);
  const TOP = 5;
  const shown = pv.all ? list : list.slice(0, TOP);
  const maxUsed = Math.max(1, ...list.map(a => a.used));
  const set = (k, val) => { pv[k] = val; render(); };
  return h('div', { class: 'card' },
    h('h2', null, '使ったツボ'),
    !list.length ? h('p', { class: 'sub' }, 'ツボを記録すると、ここに集計が出ます。') : [
      h('div', { class: 'seg', role: 'group', 'aria-label': '並べ方' }, [['good', '効いた順'], ['used', '使った順']].map(([k, l]) => h('button', { class: 'btn', 'aria-pressed': String(pv.sort === k), onclick: () => set('sort', k) }, l))),
      syms.length >= 2 ? h('div', { class: 'chips', role: 'group', 'aria-label': '症状でしぼる' },
        h('button', { class: 'chip', 'aria-pressed': String(pv.sym == null), onclick: () => set('sym', null) }, 'すべて'),
        syms.map(s => h('button', { class: 'chip', 'aria-pressed': String(pv.sym === s), onclick: () => set('sym', s) }, symptomName(s)))) : null,
      statLegend(),
      h('div', null, shown.map((a, i) => statRow(i + 1, tsuboName(a.key), a.evaluated ? ['効いた ', h('b', null, `${a.good}/${a.evaluated}`), `回（${Math.round(a.rate * 100)}%）`] : h('span', { class: 'sub' }, '効果を未入力'), a, maxUsed, `使った ${a.used}回`))),
      list.length > TOP ? h('button', { class: 'btn', onclick: () => set('all', !pv.all) }, pv.all ? `上位${TOP}つだけにする` : `すべて見る（${list.length}個）`) : null,
    ]);
}

/* ---------- 来院の記録 ---------- */
function viewVisit(id) {
  const v = db.visits.get(id);
  if (!v) return [topbar('記録', '#/'), h('p', { class: 'empty' }, 'この記録は見つかりません。')];
  const p = db.patients.get(v.patientId);
  const vs = visitsOf(v.patientId);
  const n = vs.findIndex(x => x.id === v.id) + 1;
  const prev = vs[n - 2];
  const save = () => put('visits', v);
  const saveSoon = debounce(save, 500);
  const change = async () => { await save(); render(); };
  const multi = v.symptoms.length >= 2;
  // 担当者：この場所で使える人を「リスト」の順に。いまは使わない人・ほかの場所の人でも、この記録に入っていれば出す
  const staffList = activeStaff(p ? placeOf(p) : null);
  if (db.staff.has(v.staffId) && !staffList.some(s => s.id === v.staffId)) staffList.push(db.staff.get(v.staffId));
  const staffEl = h('div', { class: 'chips', role: 'group', 'aria-label': '担当者' },
    staffList.length ? h('span', { class: 'sub', style: 'align-self:center;margin-right:2px' }, '担当者') : null,
    staffList.map(s => h('button', { class: 'chip', 'aria-pressed': String(v.staffId === s.id), onclick: async () => {
      v.staffId = v.staffId === s.id ? null : s.id;
      if (v.staffId) await metaSet('staff', s.id);
      change();
    } }, s.name)),
    h('button', { class: 'chip', style: 'color:var(--sub)', 'aria-label': '担当者を追加', onclick: () => addStaff(v) }, staffList.length ? '＋' : '＋ 担当者'));

  const aims = new Map();
  for (const x of db.visits.values()) for (const r of x.rows) if (r.aim) aims.set(r.aim, (aims.get(r.aim) || 0) + 1);
  const aimList = h('datalist', { id: 'aims' }, [...aims].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([a]) => h('option', { value: a })));

  const rowEl = (r, i) => h('div', { class: 'trow' },
    h('div', { class: 'row' },
      h('span', { class: 'num' }, i + 1),
      h('span', { class: 'nm grow' }, tsuboName(r.tsuboId)),
      h('button', { class: 'btn side', 'aria-label': '左右を切り替える', onclick: () => { r.side = SIDES[(SIDES.findIndex(s => s.v === (r.side || '')) + 1) % SIDES.length].v; change(); } }, sideLabel(r.side)),
      h('button', { class: 'btn icon', 'aria-label': 'このツボを消す', onclick: async () => {
        if ((r.effect != null || r.aim) && !await confirmDialog(`${tsuboName(r.tsuboId)} の行を消します。`, '消す', true)) return;
        v.rows.splice(v.rows.indexOf(r), 1); change();
      } }, '×')),
    multi ? h('select', { 'aria-label': 'どの症状に対して', onchange: e => { r.symptomId = e.target.value; save(); } }, v.symptoms.map(s => h('option', { value: s, selected: s === r.symptomId }, symptomName(s) + ' に対して'))) : null,
    h('input', { type: 'text', list: 'aims', placeholder: 'ねらい（例：上げやすく）', value: r.aim || '', autocomplete: 'off', oninput: e => { r.aim = e.target.value; saveSoon(); }, onchange: e => { r.aim = e.target.value.trim(); save(); } }),
    h('div', { class: 'eff', role: 'group', 'aria-label': '効果' }, EFFECTS.map(e => h('button', { class: 'btn', 'data-v': e.v, 'aria-pressed': String(r.effect === e.v), title: e.label, onclick: () => { r.effect = r.effect === e.v ? null : e.v; change(); } }, e.mark))));

  return [
    topbar(patientName(p), '#/p/' + v.patientId, `${n}回目`),
    h('input', { type: 'date', 'aria-label': '日付', value: v.date, onchange: e => { if (e.target.value) { v.date = e.target.value; change(); } } }),
    staffEl,
    talkCard(v, p, n),
    h('div', { class: 'card' },
      h('h2', null, '今日みる症状'),
      v.symptoms.length ? h('div', { class: 'chips' }, v.symptoms.map(s => h('span', { class: 'tag', style: 'font-size:14px;padding:4px 12px' }, symptomName(s)))) : h('p', { class: 'sub' }, '症状を選んでおくと、あとで「症状ごとの効いたツボ」が集計できます。'),
      h('button', { class: 'btn', onclick: () => pickSymptoms(v) }, v.symptoms.length ? '症状を選びなおす' : '症状を選ぶ')),
    h('div', { class: 'card' },
      h('h2', null, '使ったツボ'),
      v.rows.map(rowEl),
      h('button', { class: 'btn primary big', onclick: () => pickTsubo(v) }, '＋ ツボを選ぶ'),
      !v.rows.length && prev && prev.rows.length ? h('button', { class: 'btn', onclick: () => {
        v.rows = prev.rows.filter(r => db.tsubo.has(r.tsuboId)).map(r => ({ tsuboId: r.tsuboId, side: r.side, symptomId: r.symptomId, aim: r.aim || '', effect: null }));
        fixRows(v); change();
      } }, `前回（${fmtDate(prev.date)}）のツボを写す`) : null,
      v.rows.length ? h('p', { class: 'sub' }, '効果：' + EFFECTS.map(e => `${e.mark} ${e.label}`).join('　')) : null),
    h('div', { class: 'card' },
      h('h2', null, 'メモ'),
      h('textarea', { value: v.memo || '', placeholder: '気づいたこと（手書きのメモは GoodNotes へ）', oninput: e => { v.memo = e.target.value; saveSoon(); }, onchange: e => { v.memo = e.target.value; save(); } })),
    h('button', { class: 'btn danger small', style: 'align-self:flex-start', onclick: async () => {
      if (!await confirmDialog(`${fmtDate(v.date)} の記録を削除します。元に戻せません。`, '削除する', true)) return;
      await dropClips(v.id);
      await del('visits', v.id); go('#/p/' + v.patientId);
    } }, 'この日の記録を削除'),
    aimList,
  ];
}

/* ---------- 問診の録音 ---------- */
// 録音と OpenAI への問い合わせは monshin.js。ここでは、画面と、来院の記録（visit.talk）への保存を受け持つ。
// visit.talk = { summary: まとめ, transcript: 文字起こしの全文, at: 最後に作った時刻 }
const urlParams = new URLSearchParams(location.search);
const isMock = ['localhost', '127.0.0.1'].includes(location.hostname) && urlParams.has('mock');      // 動作確認用（にせの AI・にせのマイク）
// iPad のホーム画面アプリは、左上にウインドウのボタンが重なる（よける幅を教えてくれる仕組みが無い）。自分で見分けて、上のバーを右へよける
// 見分け方：ホーム画面から開いている・指でさわる端末・iPhone ではない（iPad は自分を Mac と名のることがあるので、名前では決めない）
const isIpadApp = ((navigator.standalone === true || matchMedia('(display-mode: standalone)').matches)
  && navigator.maxTouchPoints > 1 && !/iPhone|iPod|Android/.test(navigator.userAgent))
  || (isMock && urlParams.has('ipadwin'));      // ?mock&ipadwin は動作確認用
document.documentElement.classList.toggle('ipad-win', isIpadApp);
const talkJobs = new Map();      // 来院の id → 文字起こし・まとめの途中（{ step: 'tr', i, n } か { step: 'sum' }）
const talkErrs = new Map();      // 来院の id → うまくいかなかった理由（AiError）
const talkNote = new Map();      // 来院の id → 録音を始められなかった・途中で止まったときの知らせ
let talkStarting = null;         // マイクの許可を待っている来院の id
const talkOpen = new Set();      // 「文字起こしの全文」を開いている来院の id（描き直しても閉じないように）
const aiKey = () => metaGet('aiKey') || '';
const aiModel = () => (ms.MODELS.some(m => m.id === metaGet('aiModel')) ? metaGet('aiModel') : ms.MODELS[0].id);
const aiPrompt = () => metaGet('aiPrompt') || ms.DEFAULT_PROMPT;
// 聞き間違いを直す手がかり：登録されている症状とツボの名前（患者に関することは渡さない）
const aiTerms = () => ({ symptoms: activeSymptoms().sort(byOrder(byCreated)).map(s => s.name), tsubo: activeTsubo().sort(tsuboOrder).map(t => t.name) });
const mmss = t => { const s = Math.floor(t / 1000); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
const hhmm = t => { const d = new Date(t); return `${d.getHours()}:${pad(d.getMinutes())}`; };
// 録音が止まっていた長さ：1分未満は「約◯秒」、それより長いと「約◯分◯秒」（0秒は書かない）
const gapLen = sec => { const m = Math.floor(sec / 60), s = sec % 60; return '約' + (m ? `${m}分` + (s ? `${s}秒` : '') : `${s}秒`); };
// 文字起こしに入れる、録音が止まっていた印（1つのあいだに1行）。まとめのいちばん上の合計は、全文のこの印から数える
const gapMark = g => { const d = new Date(g.at); return `（${d.getHours()}時${d.getMinutes()}分ごろ、${gapLen(g.sec)} 録音が止まっていました）`; };
const GAP_MARK = /（\d+時\d+分ごろ、約(?:(\d+)分)?(?:(\d+)秒)? 録音が止まっていました）/g;
const GAP_LINE = /^※ 録音が止まっていた時間があります（合計 約(?:(\d+)分)?(?:(\d+)秒)?）。その間の話は入っていません。\n*/;
const gapSecOf = text => [...String(text || '').matchAll(GAP_MARK)].reduce((n, m) => n + (Number(m[1]) || 0) * 60 + (Number(m[2]) || 0), 0);
const stripGapLine = text => String(text || '').replace(GAP_LINE, '');
const lineSec = text => { const m = String(text || '').match(GAP_LINE); return m ? (Number(m[1]) || 0) * 60 + (Number(m[2]) || 0) : 0; };
// まとめのいちばん上に、録音が止まっていた合計の1行を置く（すでにあれば置きかえる。AI には頼まない）
const withGapLine = (summary, sec) => { const body = stripGapLine(summary); return sec > 0 ? `※ 録音が止まっていた時間があります（合計 ${gapLen(sec)}）。その間の話は入っていません。\n\n${body}` : body; };
const longDate = s => { const [y, m, d] = s.split('-').map(Number); return `${y}年${m}月${d}日（${'日月火水木金土'[new Date(y, m - 1, d).getDay()]}）`; };
function refresh() { remoteChanged(); updateRecUi(); }
// 文字の量に合わせて、入力欄の高さを広げる
function grow(ta) { ta.style.height = 'auto'; ta.style.height = Math.max(180, ta.scrollHeight + 4) + 'px'; }

// 来院の記録を消すときに、その来院の録音も消す
async function dropClips(visitId) {
  if (ms.isRecording(visitId)) await ms.cancelRec();
  try { await ms.deleteClips(visitId); } catch (e) { console.error(e); }
  talkErrs.delete(visitId); talkNote.delete(visitId);
}
// 録音の状態が変わった（区切りを保存した・途中で止まった など）
function recChanged(e) {
  if (e.error === 'save') toast('録音を保存できませんでした。端末の空きを確かめてください');
  if (e.gap) toast(`隠していた ${gapLen(e.gap.sec)} は、録音が止まっていました`);
  if (e.stopped) {
    const t = e.stopped.why === 'ended' ? 'マイクが止まったため、録音を終えました。そこまでの分は残してあります。' : '録音が途中で止まりました。そこまでの分は残してあります。';
    talkNote.set(e.stopped.visitId, t); toast(t);
  }
  refresh();
}
async function startTalk(v) {
  if (ms.isRecording()) { toast('ほかの来院で録音中です'); return; }
  if (!metaGet('aiConsent')) {
    if (!await confirmDialog('会話は、文字にしてまとめるために OpenAI に送られます。患者さんの同意を得てから始めてください。', '同意を得たので始める')) return;
    await metaSet('aiConsent', true);
  }
  if (v.talk && !await confirmDialog('続きを録音すると、文字起こしは前の全文のあとに足し、まとめは全文から作り直します。手で直したまとめの内容は消えます。', '続きを録音する')) return;
  talkNote.delete(v.id); talkErrs.delete(v.id);
  talkStarting = v.id; refresh();
  try {
    await ms.startRec(v.id, { onChange: recChanged, segSec: (isMock && Number(urlParams.get('seg'))) || undefined, fakeMic: isMock });
  } catch (e) {
    console.error(e);
    const t = e.name === 'NotAllowedError' || e.name === 'SecurityError' ? 'マイクを使う許可がありません。iPad の「設定」で、Safari（またはこのアプリ）のマイクを許可してください。'
      : e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? 'マイクが見つかりません。'
      : e.message === 'unsupported' ? 'この端末（ブラウザ）では録音できません。'
      : '録音を始められませんでした。もう一度ためしてください。';
    talkNote.set(v.id, t); toast(t);
  }
  talkStarting = null;
  refresh();
}
async function stopTalk(id) { await ms.stopRec(); refresh(); processTalk(id); }
async function cancelTalk() {
  if (!await confirmDialog('いまの録音を捨てます。元に戻せません。', '捨てる', true)) return;
  await ms.cancelRec(); refresh();
}
// 来院の記録を、待たずに確かめて保存する（失敗したら録音を消さないため）
async function saveVisitNow(v) {
  v.updated = Date.now();
  db.visits.set(v.id, v);
  await store.put('visits', v);
}
// 残っている録音を文字にして、まとめを作り、来院の記録に入れる。うまくいったら、その来院の録音を消す（失敗したら残す）
async function processTalk(id) {
  if (talkJobs.has(id)) return;
  const key = aiKey();
  talkErrs.delete(id); talkNote.delete(id);
  if (!key) { talkErrs.set(id, new ms.AiError('key')); refresh(); return; }
  try {
    const clips = await ms.clipsOf(id);
    if (!clips.length) return;
    for (let i = 0; i < clips.length; i++) {
      talkJobs.set(id, { step: 'tr', i: i + 1, n: clips.length }); refresh();
      const c = clips[i];
      // 文字にできた分は録音といっしょに覚えておき、やり直すときに二重に払わない
      if (typeof c.text !== 'string') { c.text = await ms.transcribe(c.blob, { key, mime: c.mime, terms: aiTerms() }); await ms.putClip(c); }
    }
    // 録音が止まっていたあいだは、その1本の文の前に印の行を入れる
    const heard = clips.some(c => c.text.trim());
    const added = !heard ? '' : clips.map(c => [...(c.gaps || []).map(gapMark), c.text].filter(t => t.trim()).join('\n')).filter(Boolean).join('\n');
    let v = db.visits.get(id);
    if (!v) return;                    // その来院の記録が消された
    const old = v.talk || null;
    if (!added) {
      await ms.deleteClips(id);
      toast(old ? '会話が聞き取れなかったので、まとめはそのままです' : '会話が聞き取れませんでした');
      return;
    }
    const sep = `\n\n――― 続きの録音（${hhmm(clips[0].created)}）―――\n\n`;
    const transcript = old && old.transcript ? old.transcript + sep + added : added;
    // 全文を消してあるときは、前のまとめを手がかりに足して作る
    const input = old && !old.transcript && old.summary ? `（前の録音のまとめ。全文は消してあります）\n${stripGapLine(old.summary)}${sep}${added}` : transcript;
    // 止まっていた合計は全文の印から数える（全文を消してあるときは、前のまとめの1行の分も足す）
    const gapSec = gapSecOf(transcript) + (old && !old.transcript ? lineSec(old.summary) : 0);
    talkJobs.set(id, { step: 'sum' }); refresh();
    const summary = withGapLine(await ms.summarize(input, { key, model: aiModel(), prompt: aiPrompt(), terms: aiTerms() }), gapSec);
    v = db.visits.get(id);
    if (!v) return;
    v.talk = { summary, transcript, at: Date.now() };
    await saveVisitNow(v);
    await ms.deleteClips(id);
    toast('問診のまとめができました');
  } catch (e) {
    console.error(e instanceof ms.AiError ? `問診の録音：${e.code} ${e.detail}` : e);
    talkErrs.set(id, e instanceof ms.AiError ? e : new ms.AiError('other', '保存できませんでした'));
  } finally { talkJobs.delete(id); refresh(); }
}
async function resummarize(id) {
  const v = db.visits.get(id);
  if (!v || !v.talk || !v.talk.transcript || talkJobs.has(id)) return;
  if (!await confirmDialog('文字起こしの全文から、まとめを作り直します。手で直した内容は消えます。', '作り直す')) return;
  talkJobs.set(id, { step: 'sum' }); refresh();
  try {
    const summary = withGapLine(await ms.summarize(v.talk.transcript, { key: aiKey(), model: aiModel(), prompt: aiPrompt(), terms: aiTerms() }), gapSecOf(v.talk.transcript));
    const cur = db.visits.get(id);
    if (cur && cur.talk) { cur.talk = { ...cur.talk, summary, at: Date.now() }; await put('visits', cur); toast('まとめなおしました'); }
  } catch (e) { console.error(`問診の録音：${e.code || ''}`); toast(ms.explainAi(e)); }
  finally { talkJobs.delete(id); refresh(); }
}
async function sendPdf(v, p, n) {
  const t = v.talk;
  if (!t || !(t.summary || '').trim()) { toast('まとめが空です'); return; }
  let pdf;
  try { pdf = await makePdf({ title: '問診のまとめ', meta: [longDate(v.date), `${patientName(p)}・${n}回目`], body: t.summary }); }
  catch (e) { console.error(e); toast('PDF を作れませんでした'); return; }
  if (isMock) window.__lastPdf = pdf;         // 動作確認用
  await saveFile(`問診_${v.date.replace(/-/g, '')}.pdf`, pdf.blob, 'application/pdf');
}
function talkCard(v, p, n) {
  const key = aiKey(), job = talkJobs.get(v.id), pend = ms.pendingOf(v.id), err = talkErrs.get(v.id), note = talkNote.get(v.id);
  const here = ms.isRecording(v.id), other = ms.isRecording() && !here;
  const save = () => put('visits', v), saveSoon = debounce(save, 500);
  const toSettings = h('button', { class: 'btn', style: 'align-self:flex-start', onclick: () => go('#/settings') }, '設定をひらく');
  const out = [h('h2', null, '問診の録音')];
  if (here) out.push(
    h('div', { class: 'rec-now' }, h('span', { class: 'rec-dot', 'aria-hidden': 'true' }), '録音中', h('span', { 'data-rec-time': '' }, mmss(ms.elapsed()))),
    h('button', { class: 'btn primary big', onclick: () => stopTalk(v.id) }, '■ 止めてまとめる'),
    ms.rec.stuck ? h('p', { style: 'color:var(--danger)' }, 'マイクが止まっています。録音を止めて、もう一度始めてください。') : null,
    ms.rec.gaps.length ? h('p', { style: 'color:var(--danger)' }, `画面から隠していたあいだ、録音が止まっていました（合計 ${gapLen(ms.rec.gaps.reduce((n, g) => n + g.sec, 0))}）。その間の話は入っていません。`) : null,
    h('button', { class: 'btn small danger', style: 'align-self:flex-start', onclick: cancelTalk }, '取り消す'),
    h('p', { class: 'sub' }, '録音中も、ツボ選びなどの入力や、ほかの画面への移動ができます。'),
    h('p', { class: 'sub' }, 'ツボ記録を画面から隠すと、録音が止まります。細くしてでも、出したままにしてください。'));
  else if (job) out.push(h('p', { class: 'talk-busy' }, job.step === 'tr' ? `文字にしています…（${job.i}/${job.n}）` : 'まとめています…'), h('p', { class: 'sub' }, 'このあいだも、ほかの入力ができます。'));
  else if (pend.n) out.push(
    h('p', null, `まだ文字にしていない録音があります（${pend.n}本・${pend.ms < 60000 ? '1分未満' : `約${Math.round(pend.ms / 60000)}分`}）`),
    err ? h('p', { style: 'color:var(--danger)' }, ms.explainAi(err)) : note ? h('p', { class: 'sub' }, note) : null,
    !key && !(err && err.code === 'key') ? h('p', { class: 'sub' }, '「設定」で OpenAI の API キーを入れると、文字にしてまとめられます。') : null,
    !key ? toSettings : null,
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn primary', disabled: !key, onclick: () => processTalk(v.id) }, err ? 'もう一度ためす' : '文字にしてまとめる'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!await confirmDialog(`まだ文字にしていない録音（${pend.n}本）を捨てます。元に戻せません。`, '捨てる', true)) return;
        await dropClips(v.id); refresh();
      } }, '録音を捨てる')));

  const t = v.talk;
  if (t) {
    const ta = h('textarea', { class: 'talk', value: t.summary || '', 'aria-label': '問診のまとめ', oninput: e => { t.summary = e.target.value; grow(e.target); saveSoon(); }, onchange: e => { t.summary = e.target.value; save(); } });
    requestAnimationFrame(() => { if (ta.isConnected) grow(ta); });
    out.push(
      h('p', { class: 'sub' }, `まとめ（${hhmm(t.at)} 作成。直すと、そのまま保存されます）`),
      ta,
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', onclick: () => sendPdf(v, p, n) }, 'GoodNotes へ送る'),
        h('button', { class: 'btn', onclick: async () => {
          try { await navigator.clipboard.writeText(t.summary || ''); toast('まとめをコピーしました'); } catch (e) { toast('コピーできませんでした'); }
        } }, 'コピー'),
        h('button', { class: 'btn', disabled: !key || !t.transcript || !!job || here, onclick: () => resummarize(v.id) }, 'まとめなおす')),
      h('details', { class: 'talk-all', open: talkOpen.has(v.id), ontoggle: e => { if (e.target.open) talkOpen.add(v.id); else talkOpen.delete(v.id); } },
        h('summary', null, '文字起こしの全文'),
        t.transcript ? [h('div', { class: 'transcript' }, t.transcript),
          h('button', { class: 'btn small danger', onclick: async () => {
            if (!await confirmDialog('文字起こしの全文を消します。まとめは残ります。元に戻せません。', '全文を消す', true)) return;
            const cur = db.visits.get(v.id); if (!cur || !cur.talk) return;
            cur.talk = { ...cur.talk, transcript: '' }; await put('visits', cur); render();
          } }, '全文を消す')]
          : h('p', { class: 'sub' }, '全文は消してあります。'),
      ),
      h('button', { class: 'btn small danger', style: 'align-self:flex-start', disabled: !!job, onclick: async () => {
        if (!await confirmDialog('この来院の問診の記録（まとめと全文）を消します。元に戻せません。', '消す', true)) return;
        const cur = db.visits.get(v.id); if (!cur) return;
        delete cur.talk; await put('visits', cur); render();
      } }, '問診の記録を消す'));
  }
  if (!here && !job && !pend.n) {
    if (!key) out.push(h('p', { class: 'sub' }, '設定で OpenAI の API キーを入れると、問診を録音して文章にまとめられます。'), toSettings);
    else if (other) out.push(h('p', { class: 'sub' }, 'ほかの来院で録音しています。一度に録音できるのは1つの来院だけです。'), h('button', { class: 'btn', style: 'align-self:flex-start', onclick: () => go('#/v/' + ms.rec.visitId) }, '録音中の記録へ'));
    else if (talkStarting) out.push(h('p', { class: 'sub' }, 'マイクを準備しています…（許可を聞かれたら「許可」を押してください）'));
    else out.push(
      note ? h('p', { style: 'color:var(--danger)' }, note) : null,
      h('button', { class: t ? 'btn' : 'btn big', style: t ? 'align-self:flex-start' : '', onclick: () => startTalk(v) }, h('span', { class: 'rec-dot', 'aria-hidden': 'true' }), t ? '続きを録音する' : '録音を始める'));
  }
  return h('div', { class: 'card' }, out);
}
// 録音中にほかの画面へ移ったときの帯と、経過時間の表示（画面を描き直さず、その文字だけを書き換える）
let recTick = null;
function updateRecUi() {
  const on = ms.isRecording(), r = parseRoute();
  const away = on && !(r.name === 'v' && r.arg === ms.rec.visitId);
  const bar = $('#recbar');
  if (bar) bar.hidden = !away;
  document.body.classList.toggle('recbar', away);
  const t = mmss(ms.elapsed());
  for (const el of document.querySelectorAll('[data-rec-time]')) el.textContent = t;
  if (on && !recTick) recTick = setInterval(updateRecUi, 500);
  if (!on && recTick) { clearInterval(recTick); recTick = null; }
}

// 来院の記録の画面から、担当者をその場で足す（足した人が、この記録の担当者になる）
function addStaff(v) {
  const p = db.patients.get(v.patientId), placeId = p ? placeOf(p) : null;
  const name = h('input', { type: 'text', placeholder: '担当者の名前', autocomplete: 'off' });
  const save = async () => {
    const t = name.value.trim().replace(/\s+/g, ' ');
    if (!t) { toast('名前を入れてください'); return; }
    let s = [...db.staff.values()].find(x => x.name === t);
    if (!s) s = { id: uid(), name: t, placeIds: placeId ? [placeId] : [], created: Date.now() };
    else if (!inStaffPlace(s, placeId)) { setStaffPlaces(s, [...staffPlaces(s), placeId]); toast(`「${t}」はほかの場所に登録されていたので、この場所でも選べるようにしました`); }
    s.archived = false;
    await put('staff', s);
    v.staffId = s.id;
    await put('visits', v);
    await metaSet('staff', s.id);
    dlg.close();
  };
  name.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) save(); });
  const dlg = openDialog({
    title: '担当者を追加',
    body: [h('label', { class: 'f' }, '名前', name), h('p', { class: 'sub' }, (placeId && db.places.size > 1 ? `「${db.places.get(placeId).name}」の担当者として登録します。` : '施術を担当した人を登録します。') + '名前や場所の変更は「リスト」→「担当者」でできます。')],
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'やめる'), h('button', { class: 'btn primary', onclick: save }, '追加')],
    onClose: render,
  });
}

function pickSymptoms(v) {
  const usedByPatient = new Set(visitsOf(v.patientId).flatMap(x => x.symptoms));
  const chips = h('div', { class: 'chips' });
  const draw = () => {
    // この患者で使ったことのある症状を先に。あとは「リスト」の順（並べていなければ登録した順。最初は問診票の並び）
    const list = activeSymptoms().sort((a, b) => (usedByPatient.has(b.id) - usedByPatient.has(a.id)) || byOrder(byCreated)(a, b));
    chips.replaceChildren(...list.map(s => h('button', { class: 'chip', 'aria-pressed': String(v.symptoms.includes(s.id)), onclick: async () => {
      v.symptoms = v.symptoms.includes(s.id) ? v.symptoms.filter(x => x !== s.id) : [...v.symptoms, s.id];
      fixRows(v); await put('visits', v); draw();
    } }, s.name)));
  };
  draw();
  const name = h('input', { type: 'text', placeholder: '新しい症状を追加', autocomplete: 'off' });
  const add = async () => {
    const t = name.value.trim(); if (!t) return;
    let s = [...db.symptoms.values()].find(x => x.name === t);
    if (!s) { s = { id: uid(), name: t, archived: false, created: Date.now() }; }
    s.archived = false; await put('symptoms', s);
    if (!v.symptoms.includes(s.id)) { v.symptoms.push(s.id); fixRows(v); await put('visits', v); }
    name.value = ''; draw();
  };
  name.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) add(); });
  openDialog({ title: '今日みる症状', full: true, body: [chips, h('div', { class: 'row' }, h('div', { class: 'grow' }, name), h('button', { class: 'btn', onclick: add }, '追加'))], onClose: render });
}

function pickTsubo(v) {
  let q = '', group = '';
  // 並び：効いた順（これまでの記録から）か、「リスト」で並べた順か。リストを並べ替えてあれば、まずはリストの順にする
  let sortBy = metaGet('pickSort') || ([...db.tsubo.values()].some(t => typeof t.order === 'number') ? 'list' : 'good');
  let target = v.symptoms.length ? ((v.rows[v.rows.length - 1] || {}).symptomId || v.symptoms[0]) : null;
  // これまでの記録（この来院を除く）から、よく使う順・この症状で効いた順に並べる
  const rows = flatten([...db.visits.values()].filter(x => x.id !== v.id));
  const usedAll = new Map(aggregate(rows, r => r.tsuboId).map(a => [a.key, a.used]));
  let goodHere = new Map();
  const rescore = () => { goodHere = new Map(aggregate(rows.filter(r => r.symptomId === target), r => r.tsuboId).map(a => [a.key, a.good])); };
  rescore();

  const targetEl = h('div', { class: 'chips' }), groupEl = h('div', { class: 'chips' }), listEl = h('div', null);
  const search = h('input', { type: 'search', placeholder: '名前でさがす・追加する', autocomplete: 'off', oninput: e => { q = e.target.value; draw(); } });
  const sortSel = h('select', { 'aria-label': '並び順', style: 'width:auto;flex:none', onchange: async e => { sortBy = e.target.value; draw(); await metaSet('pickSort', sortBy); } },
    [['good', '効いた順'], ['list', 'リストの順']].map(([val, l]) => h('option', { value: val, selected: sortBy === val }, l)));
  const toggle = async (t, side) => {
    const i = v.rows.findIndex(r => r.tsuboId === t.id && (r.side || '') === side);
    if (i < 0) v.rows.push({ tsuboId: t.id, side, symptomId: target, aim: '', effect: null });
    else if (v.rows[i].effect != null || v.rows[i].aim) { toast('ねらい・効果が入っている行は、記録の画面で消してください'); return; }
    else v.rows.splice(i, 1);
    await put('visits', v); draw();
  };
  const draw = () => {
    targetEl.replaceChildren(...(v.symptoms.length >= 2 ? v.symptoms.map(s => h('button', { class: 'chip', 'aria-pressed': String(s === target), onclick: () => { target = s; rescore(); draw(); } }, symptomName(s) + ' に対して')) : []));
    const groups = [...new Set(activeTsubo().sort(tsuboOrder).map(t => t.group).filter(Boolean))];      // グループも「リスト」に出てくる順
    if (group && !groups.includes(group)) group = '';
    groupEl.replaceChildren(...(groups.length ? [h('button', { class: 'chip', 'aria-pressed': String(!group), onclick: () => { group = ''; draw(); } }, 'すべて'), ...groups.map(g => h('button', { class: 'chip', 'aria-pressed': String(g === group), onclick: () => { group = g; draw(); } }, g))] : []));
    const nq = norm(q);
    const list = activeTsubo()
      .filter(t => (!group || t.group === group) && (!nq || norm(t.name).includes(nq) || norm(t.yomi).includes(nq)))
      .sort(sortBy === 'list' ? tsuboOrder : (a, b) => (goodHere.get(b.id) || 0) - (goodHere.get(a.id) || 0) || (usedAll.get(b.id) || 0) - (usedAll.get(a.id) || 0) || byOrder(byName)(a, b));
    const exact = [...db.tsubo.values()].find(t => norm(t.name) === nq);
    listEl.replaceChildren(...[
      ...list.map(t => h('div', { class: 'pick' },
        h('div', { class: 'grow' }, h('div', { class: 'nm' }, t.name), goodHere.get(t.id) ? h('div', { class: 'sub' }, `この症状で効いた ${goodHere.get(t.id)}回`) : null),
        h('div', { class: 'sides' }, SIDES.map(s => h('button', { class: 'btn', 'aria-pressed': String(v.rows.some(r => r.tsuboId === t.id && (r.side || '') === s.v)), 'aria-label': `${t.name} ${s.label}`, onclick: () => toggle(t, s.v) }, s.label))))),
      q.trim() && !exact ? h('button', { class: 'btn', style: 'margin-top:10px;width:100%', onclick: async () => {
        await put('tsubo', { id: uid(), name: q.trim(), yomi: '', group: group || '', archived: false, created: Date.now() }); draw();
      } }, `＋「${q.trim()}」をツボのリストに追加`) : null,
      exact && exact.archived ? h('button', { class: 'btn', style: 'margin-top:10px;width:100%', onclick: async () => { exact.archived = false; await put('tsubo', exact); draw(); } }, `「${exact.name}」をもう一度使えるようにする`) : null,
      !list.length && !q.trim() ? h('p', { class: 'empty' }, 'まだツボが登録されていません。上の欄に名前を入れると、その場で追加できます。まとめて登録するときは「リスト」から。') : null,
    ].filter(Boolean));
  };
  draw();
  openDialog({ title: 'ツボを選ぶ', full: true, body: [h('div', { class: 'row' }, h('div', { class: 'grow' }, search), sortSel), targetEl, groupEl, h('p', { class: 'sub' }, 'L＝左　R＝右　両＝両側　中＝正中・左右なし（もう一度押すと取り消し）'), listEl], onClose: render });
}

/* ---------- 統計 ---------- */
const stats = { mode: 'symptom', symptomId: undefined, tsuboId: undefined, period: 'all', sort: 'good', place: 'all', staff: 'all', rank: 'all', back: 0 };
// ツボランキングの期間。こよみの区切り（その日・月曜からの1週間・その月・その年）で、back は、いくつ前までさかのぼるか
const RANK_PERIODS = [['day', '今日'], ['week', '今週'], ['month', '今月'], ['year', '今年'], ['all', '全期間']];
function rankRange(kind, back) {
  if (kind === 'all') return null;
  const now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const mon = d - (now.getDay() + 6) % 7;      // 今週の月曜
  const [from, to] = {
    day: [new Date(y, m, d - back), new Date(y, m, d - back)],
    week: [new Date(y, m, mon - 7 * back), new Date(y, m, mon - 7 * back + 6)],
    month: [new Date(y, m - back, 1), new Date(y, m - back + 1, 0)],
    year: [new Date(y - back, 0, 1), new Date(y - back, 11, 31)],
  }[kind];
  const label = kind === 'day' ? fmtDate(ymd(from)) : kind === 'week' ? `${fmtDate(ymd(from))}〜${fmtDate(ymd(to))}` : `${from.getFullYear()}年` + (kind === 'month' ? `${from.getMonth() + 1}月` : '');
  return { from: ymd(from), to: ymd(to), label };
}
// 集計の1行：順位・名前・右の数字・効果の内訳の棒（棒の長さは使った回数に合わせ、いちばん多いものが端まで）
const statRow = (rank, name, val, a, maxUsed, sub) => h('div', { class: 'stat' },
  h('span', { class: 'rank' }, rank),
  h('div', { class: 'head' }, h('span', { class: 'nm' }, name), h('span', { class: 'val' }, val)),
  h('div', null,
    h('div', { class: 'bar', style: `width:${Math.max(6, a.used / maxUsed * 100)}%`, role: 'img', 'aria-label': EFFECTS.map(e => `${e.mark}${a.counts[e.v]}回`).join(' ') + ` 未入力${a.used - a.evaluated}回` },
      EFFECTS.map(e => a.counts[e.v] ? h('i', { class: 'e' + e.v, style: `flex:${a.counts[e.v]}`, title: `${e.mark} ${a.counts[e.v]}回` }) : null),
      a.used - a.evaluated ? h('i', { style: `flex:${a.used - a.evaluated}`, title: `未入力 ${a.used - a.evaluated}回` }) : null),
    h('div', { class: 'sub' }, sub + EFFECTS.filter(e => a.counts[e.v]).map(e => `　${e.mark}${a.counts[e.v]}`).join(''))));
const statLegend = () => h('div', { class: 'legend' }, EFFECTS.map(e => h('span', { class: 'key' }, h('i', { class: 'e' + e.v }), `${e.mark} ${e.label}`)), h('span', { class: 'key' }, h('i', { class: 'en' }), '効果を未入力'));
function viewStats() {
  const isRank = stats.mode === 'rank';
  const range = isRank ? rankRange(stats.rank, stats.back) : null;
  const from = isRank ? range && range.from : stats.period === 'all' ? null : (() => { const d = new Date(); d.setMonth(d.getMonth() - Number(stats.period)); return ymd(d); })();
  const to = range && range.to;
  if (!db.places.has(stats.place)) stats.place = 'all';
  const inPlace = v => { const p = db.patients.get(v.patientId); return stats.place === 'all' || (p && placeOf(p) === stats.place); };
  const staffOpts = [...db.staff.values()].filter(s => inStaffPlace(s, stats.place === 'all' ? null : stats.place)).sort(byOrder(byCreated));      // 場所でしぼっているときは、その場所の担当者だけ
  if (!staffOpts.some(s => s.id === stats.staff)) stats.staff = 'all';
  const visits = [...db.visits.values()].filter(v => (!from || v.date >= from) && (!to || v.date <= to) && inPlace(v) && (stats.staff === 'all' || v.staffId === stats.staff));
  const rows = flatten(visits);
  const set = (k, val) => { stats[k] = val; render(); };
  const head = [
    topbar('統計'),
    h('div', { class: 'seg' }, [['symptom', '症状ごとの', '効いたツボ'], ['tsubo', 'ツボごとの', '効いた症状'], ['rank', 'ツボ', 'ランキング']].map(([m, a, b]) => h('button', { class: 'btn', style: 'word-break:keep-all;overflow-wrap:anywhere', 'aria-pressed': String(stats.mode === m), onclick: () => set('mode', m) }, h('span', null, a, h('wbr'), b)))),
    h('div', { class: 'nums' },
      h('div', null, h('b', null, new Set(visits.map(v => v.patientId)).size), h('span', null, '患者')),
      h('div', null, h('b', null, visits.length), h('span', null, '来院')),
      h('div', null, h('b', null, rows.length), h('span', null, 'ツボ（のべ）'))),
    db.places.size > 1 || db.staff.size > 1 ? h('div', { class: 'row' },
      db.places.size > 1 ? h('div', { class: 'grow' }, h('select', { 'aria-label': '場所', onchange: e => set('place', e.target.value) }, [['all', 'すべての場所'], ...places().map(pl => [pl.id, pl.name])].map(([val, l]) => h('option', { value: val, selected: stats.place === val }, l)))) : null,
      db.staff.size > 1 ? h('div', { class: 'grow' }, h('select', { 'aria-label': '担当者', onchange: e => set('staff', e.target.value) }, [['all', 'すべての担当者'], ...staffOpts.map(s => [s.id, s.name])].map(([val, l]) => h('option', { value: val, selected: stats.staff === val }, l)))) : null) : null,
  ];
  if (isRank) {
    // すべてのツボを、使った回数の多い順に。同じ回数のツボは同じ順位
    const list = sortAgg(aggregate(rows, r => r.tsuboId), 'used');
    return [...head,
      h('div', { class: 'card' },
        h('div', { class: 'seg', role: 'group', 'aria-label': '期間' }, RANK_PERIODS.map(([k, l]) => h('button', { class: 'btn', style: 'padding:8px 2px', 'aria-pressed': String(stats.rank === k), onclick: () => { stats.rank = k; stats.back = 0; render(); } }, l))),
        range ? h('div', { class: 'row' },
          h('button', { class: 'btn icon', 'aria-label': '前の期間', onclick: () => set('back', stats.back + 1) }, '‹'),
          h('div', { class: 'grow', style: 'text-align:center;font-variant-numeric:tabular-nums' }, range.label),
          h('button', { class: 'btn icon', 'aria-label': '次の期間', disabled: !stats.back, onclick: () => set('back', stats.back - 1) }, '›')) : null,
        list.length ? [statLegend(), h('div', null, list.map((a, i) => statRow(list.findIndex(x => x.used === a.used) + 1, tsuboName(a.key), [h('b', null, a.used), '回'], a, list[0].used, `${a.patients}人`)))]
          : h('p', { class: 'empty' }, stats.place !== 'all' || stats.staff !== 'all' ? 'この条件に当てはまる記録がありません。' : range ? 'この期間の記録がありません。' : 'まだ記録がありません。施術を記録すると、ここにランキングが出ます。')),
      list.length ? h('p', { class: 'sub' }, `使ったツボは ${list.length}種類、のべ ${rows.length}回です。回数は、記録の1行を1回と数えます（同じ日に左と右を別々に記録すると2回）。`) : null,
    ];
  }
  const period = h('select', { 'aria-label': '期間', onchange: e => set('period', e.target.value) }, [['all', '全期間'], ['3', '直近3か月'], ['12', '直近1年']].map(([val, l]) => h('option', { value: val, selected: stats.period === val }, l)));
  if (!rows.length) return [...head, period, h('p', { class: 'empty' }, stats.place !== 'all' || stats.staff !== 'all' ? 'この条件に当てはまる記録がまだありません。' : 'この期間の記録がまだありません。施術を記録すると、ここに集計が出ます。')];

  const bySym = stats.mode === 'symptom';
  const keyOf = r => (bySym ? r.symptomId : r.tsuboId), otherOf = r => (bySym ? r.tsuboId : r.symptomId);
  const nameOf = bySym ? symptomName : tsuboName, otherName = bySym ? tsuboName : symptomName;
  const options = sortAgg(aggregate(rows, keyOf), 'used');
  const cur = bySym ? 'symptomId' : 'tsuboId';
  if (!options.some(o => o.key === stats[cur])) stats[cur] = options[0].key;
  const picker = h('select', { 'aria-label': bySym ? '症状' : 'ツボ', onchange: e => set(cur, e.target.value === '' ? null : e.target.value) },
    options.map(o => h('option', { value: o.key == null ? '' : o.key, selected: o.key === stats[cur] }, `${nameOf(o.key)}（${o.used}）`)));
  const sort = h('select', { 'aria-label': '並び順', onchange: e => set('sort', e.target.value) }, [['good', '効いた回数の多い順'], ['rate', '効いた割合の高い順'], ['used', '使った回数の多い順']].map(([val, l]) => h('option', { value: val, selected: stats.sort === val }, l)));
  const list = sortAgg(aggregate(rows.filter(r => keyOf(r) === stats[cur]), otherOf), stats.sort);
  const total = list.reduce((s, a) => s + a.used, 0);
  const maxUsed = Math.max(...list.map(a => a.used));      // 棒の長さは使った回数に合わせる（いちばん多いものが端まで）

  return [...head,
    h('div', { class: 'card' },
      h('label', { class: 'f' }, bySym ? '症状' : 'ツボ', picker),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, period), h('div', { class: 'grow' }, sort)),
      statLegend(),
      h('div', null, list.map((a, i) => statRow(i + 1, otherName(a.key), a.evaluated ? ['効いた ', h('b', null, `${a.good}/${a.evaluated}`), `回（${Math.round(a.rate * 100)}%）`] : h('span', { class: 'sub' }, '効果を未入力'), a, maxUsed, `使った ${a.used}回・${a.patients}人`)))),
    h('p', { class: 'sub' }, `「効いた」は ◎ と ○ の合計です。割合は、効果を入れた回数に対するものです。この${bySym ? '症状' : 'ツボ'}の記録は、のべ ${total}回です。回数が少ないうちは、割合は目安としてご覧ください。`),
  ];
}

/* ---------- リスト（ツボ・症状・担当者・場所） ---------- */
let listKind = 'tsubo';
const LIST_WORD = { tsubo: 'ツボ', symptoms: '症状', staff: '担当者' };
let staffPlace;            // 担当者を足すときの場所（'' は、すべての場所）。最初は、いま「記録」で開いている場所
const listSeg = () => h('div', { class: 'seg' }, [['tsubo', `ツボ（${db.tsubo.size}）`], ['symptoms', `症状（${db.symptoms.size}）`], ['staff', `担当者（${db.staff.size}）`], ['places', `場所（${db.places.size}）`]].map(([k, l]) => h('button', { class: 'btn', 'aria-pressed': String(listKind === k), onclick: () => { listKind = k; render(); } }, l)));
function viewPlaces() {
  const count = new Map();
  for (const p of db.patients.values()) count.set(placeOf(p), (count.get(placeOf(p)) || 0) + 1);
  return [
    topbar('リスト'),
    listSeg(),
    h('div', { class: 'card' },
      h('p', { class: 'sub' }, '治療院・病院など、患者を分けて管理する場所です。場所ごとに、患者を番号で管理するか、名前で管理するかを選べます。'),
      h('button', { class: 'btn primary', onclick: () => editPlace(null) }, '＋ 場所を追加')),
    h('ul', { class: 'list' }, places().map(pl => h('li', null, h('button', { class: 'item', onclick: () => editPlace(pl) },
      h('span', { class: 'ttl' }, pl.name),
      h('span', { class: 'sub' }, `${pl.mode === 'name' ? '名前で管理' : '番号で管理'}・患者 ${count.get(pl.id) || 0}人`))))),
  ];
}
function viewLists() {
  if (listKind === 'places') return viewPlaces();
  const kind = listKind, isT = kind === 'tsubo';
  const word = LIST_WORD[kind];
  const used = new Map(), count = id => used.set(id, (used.get(id) || 0) + 1);
  for (const v of db.visits.values()) {
    if (isT) for (const r of v.rows) count(r.tsuboId);
    else if (kind === 'symptoms') for (const s of v.symptoms) count(s);
    else if (v.staffId) count(v.staffId);
  }
  const isS = kind === 'staff', multi = db.places.size > 1;
  // 自分で並べた順。並べていないものは、ツボはグループ → 名前、症状は登録した順、担当者は場所ごと（すべての場所の人が先）。使わないものは下に
  const rank = s => places().findIndex(pl => pl.id === staffPlaces(s)[0]);
  const rest = isT ? tsuboOrder : byOrder(isS ? (a, b) => rank(a) - rank(b) || byCreated(a, b) : byCreated);
  const items = [...db[kind].values()].sort((a, b) => (a.archived - b.archived) || rest(a, b));
  const canSort = items.filter(x => !x.archived).length > 1;
  if (staffPlace === undefined || (staffPlace && !db.places.has(staffPlace))) staffPlace = curPlace().id;
  const placeSel = isS && multi ? h('select', { onchange: e => { staffPlace = e.target.value; } }, [...places().map(pl => [pl.id, pl.name]), ['', 'すべての場所']].map(([val, l]) => h('option', { value: val, selected: staffPlace === val }, l))) : null;
  const name = h('input', { type: 'text', placeholder: `新しい${word}の名前`, autocomplete: 'off' });
  const add = async () => {
    const t = name.value.trim(); if (!t) return;
    if (items.some(x => x.name === t)) { toast(`「${t}」はすでにあります`); return; }
    await put(kind, isT ? { id: uid(), name: t, yomi: '', group: '', archived: false, created: Date.now() } : { id: uid(), name: t, ...(isS ? { placeIds: staffPlace ? [staffPlace] : [] } : {}), archived: false, created: Date.now() });
    render();
  };
  name.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) add(); });
  return [
    topbar('リスト'),
    listSeg(),
    h('div', { class: 'card' },
      isS ? h('p', { class: 'sub' }, '施術を担当した人のリストです。来院の記録で選ぶと、だれが担当したかが残り、統計を担当者でしぼれます。' + (multi ? '来院の記録では、その場所に出ている担当者だけが並びます。複数の場所に出ている人は、追加したあとでその人を開くと、場所を足せます。' : '')) : null,
      placeSel ? h('label', { class: 'f' }, '登録する場所', placeSel) : null,
      h('div', { class: 'row' }, h('div', { class: 'grow' }, name), h('button', { class: 'btn primary', onclick: add }, '追加')),
      h('button', { class: 'btn small', style: 'align-self:flex-start', onclick: () => bulkAdd(kind) }, 'まとめて追加')),
    canSort ? h('p', { class: 'sub' }, '右のつまみ（≡）を上下に引くと、並べ替えられます。' + (isT ? 'ツボを選ぶ画面で「リストの順」にすると、この順に並びます。' : isS ? '来院の記録でも、この順に並びます。' : '症状を選ぶ画面でも、この順に並びます（その患者で使ったことのある症状が先）。')) : null,
    items.length ? sortable(h('ul', { class: 'list' }, items.map(x => h('li', { class: 'srow', 'data-id': x.archived || !canSort ? null : x.id },
      h('button', { class: 'item' + (x.archived ? ' off' : ''), onclick: () => editItem(kind, x, used.get(x.id) || 0) },
        h('span', { class: 'ttl' }, x.name, x.yomi ? h('small', null, x.yomi) : null, x.group ? h('span', { class: 'tag' }, x.group) : null, isS && multi ? (staffPlaces(x).length ? staffPlaces(x).map(id => h('span', { class: 'tag' }, db.places.get(id).name)) : h('span', { class: 'tag' }, 'すべての場所')) : null),
        h('span', { class: 'sub' }, (x.archived ? '使わない（選ぶ画面に出ません）・' : '') + (used.get(x.id) ? `記録 ${used.get(x.id)}回` : 'まだ使っていません'))),
      x.archived || !canSort ? null : h('button', { class: 'grip', 'aria-label': `${x.name} を並べ替える（上下の矢印キーでも動かせます）` })))), (ids, focusId) => reorder(kind, ids, focusId))
      : h('p', { class: 'empty' }, `まだ${word}がありません。上の欄から追加してください。`),
  ];
}
// 並べ替えた順を残す（順番の変わったものだけ書き込む）
async function reorder(kind, ids, focusId) {
  const changed = [];
  ids.forEach((id, i) => { const x = db[kind].get(id); if (x && x.order !== i) { x.order = i; x.updated = Date.now(); changed.push(x); } });
  try { await store.putMany({ [kind]: changed }); } catch (e) { console.error(e); toast('並び順を保存できませんでした'); }
  render();
  const grip = focusId && [...document.querySelectorAll('#view li[data-id]')].find(li => li.dataset.id === focusId);
  if (grip) grip.querySelector('.grip').focus();
}
function editItem(kind, x, usedCount) {
  const isT = kind === 'tsubo';
  const name = h('input', { type: 'text', value: x.name, autocomplete: 'off' });
  const yomi = h('input', { type: 'text', value: x.yomi || '', placeholder: 'ひらがな（さがすときに使います）', autocomplete: 'off' });
  const group = h('input', { type: 'text', value: x.group || '', list: 'groups', placeholder: '例：下肢、背部', autocomplete: 'off' });
  const groups = h('datalist', { id: 'groups' }, [...new Set([...db.tsubo.values()].map(t => t.group).filter(Boolean))].map(g => h('option', { value: g })));
  const off = h('input', { type: 'checkbox', checked: !!x.archived });
  const isS = kind === 'staff' && db.places.size > 1;
  // 担当者の出ている場所（いくつでも）。どれも選ばなければ、すべての場所
  const sel = new Set(kind === 'staff' ? staffPlaces(x) : []);
  const place = h('div', { class: 'chips', role: 'group', 'aria-label': '場所' });
  const drawPlaces = () => place.replaceChildren(
    h('button', { class: 'chip', 'aria-pressed': String(!sel.size), onclick: () => { sel.clear(); drawPlaces(); } }, 'すべての場所'),
    ...places().map(pl => h('button', { class: 'chip', 'aria-pressed': String(sel.has(pl.id)), onclick: () => { if (!sel.delete(pl.id)) sel.add(pl.id); drawPlaces(); } }, pl.name)));
  drawPlaces();
  const dlg = openDialog({
    title: LIST_WORD[kind],
    body: [
      h('label', { class: 'f' }, '名前', name),
      isT ? h('label', { class: 'f' }, 'よみ', yomi) : null,
      isT ? h('label', { class: 'f' }, 'グループ', group) : null,
      isT ? groups : null,
      isS ? h('div', { class: 'f' }, h('span', { class: 'sub' }, '出ている場所（いくつでも選べます）'), place) : null,
      isS ? h('p', { class: 'sub' }, '来院の記録では、選んだ場所でだけ、この担当者が並びます。「すべての場所」にすると、どの場所でも選べます。場所を変えても、過去の記録はそのままです。') : null,
      h('label', { class: 'check' }, off, '使わない（選ぶ画面に出さない。過去の記録と統計には残ります）'),
      usedCount ? h('p', { class: 'sub' }, `記録で ${usedCount}回 使われているので、削除はできません。名前を変えると、過去の記録の表示も変わります。`)
        : h('button', { class: 'btn danger small', style: 'align-self:flex-start', onclick: async () => { await del(kind, x.id); dlg.close(); } }, '削除'),
      kind === 'symptoms' && db.symptoms.size > 1 ? h('button', { class: 'btn small', style: 'align-self:flex-start', onclick: () => pickMerge(x, usedCount, () => dlg.close()) }, 'ほかの症状にまとめる') : null,
    ],
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'やめる'), h('button', { class: 'btn primary', onclick: async () => {
      const t = name.value.trim();
      if (!t) { toast('名前を入れてください'); return; }
      const same = [...db[kind].values()].find(o => o.name === t && o.id !== x.id);
      // 症状は、すでにある名前に変えようとしたら、その症状にまとめるかを聞く
      if (same && kind === 'symptoms') { if (await confirmDialog(`「${t}」はすでにあります。\n${mergeNote(x, same, usedCount)}`, 'まとめる') && await mergeSymptom(x, same)) dlg.close(); return; }
      if (same) { toast(`「${t}」はすでにあります`); return; }
      Object.assign(x, { name: t, archived: off.checked }, isT ? { yomi: yomi.value.trim(), group: group.value.trim() } : {});
      if (isS) setStaffPlaces(x, [...sel]);
      await put(kind, x); dlg.close();
    } }, '保存')],
    onClose: render,
  });
}
// 症状を1つにまとめる（例：「〜 右」「〜 左」を「〜」に）
const mergeNote = (from, to, usedCount) => `「${from.name}」を「${to.name}」にまとめます。\n\n` + (usedCount ? `「${from.name}」の記録（${usedCount}回）は「${to.name}」の記録になり、` : '') + `「${from.name}」はリストから消えます。元には戻せません。`;
function pickMerge(from, usedCount, onDone) {
  const others = [...db.symptoms.values()].filter(s => s.id !== from.id).sort((a, b) => (a.archived - b.archived) || byOrder(byCreated)(a, b));
  const sel = h('select', null, others.map(s => h('option', { value: s.id }, s.name + (s.archived ? '（使わない）' : ''))));
  const dlg = openDialog({
    title: '症状をまとめる',
    body: [
      h('p', { class: 'sub' }, `「${from.name}」を、ほかの症状にまとめます。` + (usedCount ? `「${from.name}」の記録（${usedCount}回）は、まとめる先の症状の記録になります。` : '') + `「${from.name}」はリストから消えます。`),
      h('label', { class: 'f' }, 'まとめる先', sel),
    ],
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'やめる'), h('button', { class: 'btn primary', onclick: async () => {
      const to = db.symptoms.get(sel.value);
      if (!to || !await confirmDialog(mergeNote(from, to, usedCount), 'まとめる')) return;
      if (await mergeSymptom(from, to)) { dlg.close(); onDone(); }
    } }, 'まとめる')],
  });
}
// from を選んだ来院の記録を to に付け替えてから、from をリストから消す
async function mergeSymptom(from, to) {
  const now = Date.now(), next = [];
  for (const v of db.visits.values()) {
    if (!v.symptoms.includes(from.id) && !v.rows.some(r => r.symptomId === from.id)) continue;
    next.push({ ...v, symptoms: [...new Set(v.symptoms.map(s => (s === from.id ? to.id : s)))], rows: v.rows.map(r => (r.symptomId === from.id ? { ...r, symptomId: to.id } : r)), updated: now });
  }
  try { await store.putMany({ visits: next }); } catch (e) { console.error(e); toast('まとめられませんでした。もう一度お試しください'); return false; }
  for (const v of next) db.visits.set(v.id, v);
  await del('symptoms', from.id);
  toast(`「${from.name}」を「${to.name}」にまとめました`);
  return true;
}
function bulkAdd(kind) {
  const isT = kind === 'tsubo';
  const ta = h('textarea', { style: 'min-height:200px', placeholder: isT ? '申脈\n承山, しょうざん, 下肢\n膝伝' : kind === 'staff' ? '1行に1人ずつ' : '上腕のだるさ\nしびれ' });
  const dlg = openDialog({
    title: `${LIST_WORD[kind]}をまとめて追加`,
    body: [h('p', { class: 'sub' }, isT ? '1行に1つ書きます。「名前, よみ, グループ」のようにカンマで区切ると、よみとグループも入ります（名前だけでもよい）。すでにある名前は飛ばします。' : '1行に1つ書きます。すでにある名前は飛ばします。' + (kind === 'staff' && db.places.size > 1 ? `「${staffPlace ? db.places.get(staffPlace).name : 'すべての場所'}」の担当者として登録します。` : '')), ta],
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'やめる'), h('button', { class: 'btn primary', onclick: async () => {
      const have = new Set([...db[kind].values()].map(o => o.name));
      const add = [];
      for (const line of ta.value.split(/\r?\n/)) {
        const [n, y = '', g = ''] = line.split(/[,、，\t]/).map(s => s.trim());
        if (!n || have.has(n)) continue;
        have.add(n);
        add.push(isT ? { id: uid(), name: n, yomi: y, group: g, archived: false, created: Date.now(), updated: Date.now() } : { id: uid(), name: n, ...(kind === 'staff' ? { placeIds: staffPlace ? [staffPlace] : [] } : {}), archived: false, created: Date.now(), updated: Date.now() });
      }
      try { await store.putMany({ [kind]: add }); } catch (e) { console.error(e); toast('保存できませんでした'); return; }
      for (const o of add) db[kind].set(o.id, o);
      toast(`${add.length}件 追加しました`); dlg.close();
    } }, '追加')],
    onClose: render,
  });
}

/* ---------- 控え（バックアップ・書き出し） ---------- */
// data は、文字列でも Blob（PDF など）でもよい
async function saveFile(name, data, type) {
  const file = new File([data], name, { type: type || data.type || '' });
  // iPad では共有の画面（「ファイルに保存」・GoodNotes など）を出す。パソコンではそのままダウンロードする
  if (navigator.maxTouchPoints > 0 && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; } catch (e) {
      if (e.name === 'AbortError') return false;
      // ファイルを作るのに時間がかかり、押したことが切れてしまった：もう一度押してもらって共有の画面を出す
      if (e.name === 'NotAllowedError') return shareLater(file);
    }
  }
  const a = h('a', { href: URL.createObjectURL(file), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return true;
}
function shareLater(file) {
  return new Promise(res => {
    let ok = false;
    const dlg = openDialog({
      title: 'ファイルができました',
      body: h('p', null, `${file.name} ができました。下のボタンで、共有の画面を出します。`),
      footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'やめる'), h('button', { class: 'btn primary', onclick: async () => {
        try { await navigator.share({ files: [file] }); ok = true; } catch (e) {}
        dlg.close();
      } }, '共有の画面を出す')],
      onClose: () => res(ok),
    });
  });
}
const stamp = () => today().replace(/-/g, '');
function toCsv() {
  const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const lines = [['日付', '場所', '患者', '担当者', '回数', '症状', 'ツボ', '左右', 'ねらい', '効果'].map(q).join(',')];
  const idx = visitsByPatient();
  for (const v of [...db.visits.values()].sort(visitOrder)) {
    const p = db.patients.get(v.patientId), n = (idx.get(v.patientId) || []).indexOf(v) + 1;
    for (const r of v.rows) lines.push([v.date, p ? db.places.get(placeOf(p)).name : '', p ? p.name || p.no || '' : '', db.staff.has(v.staffId) ? staffName(v.staffId) : '', n, r.symptomId ? symptomName(r.symptomId) : '', tsuboName(r.tsuboId), sideLabel(r.side) === '中' ? '' : sideLabel(r.side), r.aim || '', effectMark(r.effect)].map(q).join(','));
  }
  return '﻿' + lines.join('\r\n');
}
function viewSettings() {
  const lastBackup = metaGet('lastBackup');
  const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); if (data.app !== 'tsubo-kiroku') throw new Error('format'); } catch (err) { toast('ツボ記録の控えファイルではないようです'); return; }
    const kinds = DATA_KINDS;
    const count = k => (Array.isArray(data[k]) ? data[k].length : 0);
    if (!await confirmDialog(`控えを読み込みます。\n患者 ${count('patients')}人・来院 ${count('visits')}回・ツボ ${count('tsubo')}個・症状 ${count('symptoms')}個${count('staff') ? `・担当者 ${count('staff')}人` : ''}\n\nいまの記録は残したまま足します。同じ記録がある場合は、控えの内容で上書きします。`, '読み込む')) return;
    const byKind = {};
    for (const k of kinds) byKind[k] = (Array.isArray(data[k]) ? data[k] : []).filter(o => o && typeof o.id === 'string');
    try { await store.putMany(byKind); } catch (err) { console.error(err); toast('読み込めませんでした'); return; }
    for (const k of kinds) for (const o of byKind[k]) db[k].set(o.id, o);
    toast('読み込みました'); render();
  } });
  return [
    topbar('設定'),
    syncCard(),
    h('div', { class: 'card' },
      h('h2', null, '控え（バックアップ）'),
      h('p', null, user ? '記録はクラウドにも保存されています。控えは、念のための写しとして書き出せます。' : '記録は、この端末の中だけに保存されています。端末の故障や買い替えに備えて、ときどき控えを書き出してください。'),
      h('p', { class: 'sub' }, lastBackup ? `最後に書き出した日：${fmtDate(ymd(new Date(lastBackup)))}` : 'まだ書き出していません。'),
      h('button', { class: 'btn primary', onclick: async () => {
        const data = { app: 'tsubo-kiroku', version: 1, exported: new Date().toISOString() };
        for (const k of DATA_KINDS) data[k] = [...db[k].values()];
        if (await saveFile(`ツボ記録-控え-${stamp()}.json`, JSON.stringify(data), 'application/json')) { await metaSet('lastBackup', Date.now()); render(); }
      } }, '控えを書き出す'),
      h('button', { class: 'btn', onclick: () => file.click() }, '控えを読み込む'), file),
    h('div', { class: 'card' },
      h('h2', null, '表計算ソフト用（CSV）'),
      h('p', null, 'ツボ1つを1行にした一覧です。Excel や Numbers で、自由に集計できます。'),
      h('button', { class: 'btn', disabled: !db.visits.size, onclick: () => saveFile(`ツボ記録-${stamp()}.csv`, toCsv(), 'text/csv') }, 'CSV を書き出す')),
    aiCard(),
    h('p', { class: 'sub' }, `患者 ${db.patients.size}人・来院 ${db.visits.size}回・ツボ ${db.tsubo.size}個・症状 ${db.symptoms.size}個　／　ツボ記録 ${VERSION}${isIpadApp ? '（iPad 用の表示）' : ''}`),
  ];
}

// 問診の録音（AI）の設定。キー・AI・まとめ方は端末ごとの設定（meta）で、クラウドにも控えにも入らない
function aiCard() {
  const saved = aiKey();
  const keyIn = h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, 'aria-label': 'OpenAI の API キー', placeholder: saved ? '別のキーに替えるときだけ入れる' : 'API キー（sk- で始まる）' });
  const msg = h('p', { class: 'sub', hidden: true, role: 'status' });
  const say = (t, bad) => { msg.textContent = t; msg.style.color = bad ? 'var(--danger)' : ''; msg.hidden = false; };
  const saveKey = async () => {
    const k = keyIn.value.trim();
    if (!k) { toast('キーを入れてください'); return; }
    if (/\s/.test(k)) { toast('キーに空白が入っています。コピーしなおしてください'); return; }
    await metaSet('aiKey', k);
    keyIn.value = '';
    toast('キーを保存しました'); render();
  };
  keyIn.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) saveKey(); });
  const testBtn = h('button', { class: 'btn', onclick: async () => {
    const k = keyIn.value.trim() || aiKey();
    if (!k) { toast('キーを入れてください'); return; }
    testBtn.disabled = true; say('確かめています…');
    try { await ms.checkKey(k, aiModel()); say(keyIn.value.trim() ? 'つながりました。「保存」を押すと、このキーを使います。' : 'つながりました。このキーで使えます。'); }
    catch (e) { say(ms.explainAi(e), true); }
    testBtn.disabled = false;
  } }, 'つながるか試す');
  const model = h('select', { 'aria-label': '整理に使う AI', onchange: e => metaSet('aiModel', e.target.value) }, ms.MODELS.map(m => h('option', { value: m.id, selected: m.id === aiModel() }, m.label)));
  const prompt = h('textarea', { class: 'talk', value: aiPrompt(), 'aria-label': 'まとめ方の指示' });
  const savePrompt = debounce(() => { const t = prompt.value.trim(); metaSet('aiPrompt', !t || t === ms.DEFAULT_PROMPT ? null : prompt.value); }, 500);
  prompt.addEventListener('input', () => { grow(prompt); savePrompt(); });
  requestAnimationFrame(() => { if (prompt.isConnected) grow(prompt); });
  return h('div', { class: 'card' },
    h('h2', null, '問診の録音（AI）'),
    h('p', null, '問診の会話を録音して、OpenAI の AI で文字にし、見出しごとに整理します。使うには、OpenAI の API キーが要ります。'),
    saved ? h('div', { class: 'row wrap' }, h('span', { class: 'grow' }, `キー：保存済み（末尾 ${saved.slice(-4)}）`),
      h('button', { class: 'btn small danger', onclick: async () => {
        if (!await confirmDialog('この端末に保存した API キーを消します。', '消す', true)) return;
        await del('meta', 'aiKey'); render();
      } }, '消す')) : null,
    h('div', { class: 'row' }, h('div', { class: 'grow' }, keyIn), h('button', { class: 'btn primary', onclick: saveKey }, '保存')),
    h('div', { class: 'row wrap' }, testBtn), msg,
    h('label', { class: 'f' }, '整理に使う AI', model),
    h('label', { class: 'f' }, 'まとめ方の指示（AI に渡す文）', prompt),
    h('button', { class: 'btn small', style: 'align-self:flex-start', onclick: async () => {
      if (!await confirmDialog('まとめ方の指示を、はじめの文にもどします。', 'もどす')) return;
      await metaSet('aiPrompt', null); render();
    } }, 'はじめの指示にもどす'),
    h('p', { class: 'sub' }, 'キーは、この端末の中だけに保存され、クラウドや控え（バックアップ）には入りません。使う端末ごとに入れてください。'),
    h('p', { class: 'sub' }, '費用の目安：10分の録音で 15円前後（OpenAI の利用料。整理に使う AI で変わります）。OpenAI の管理画面で、月の上限額を決めておくと安心です。'),
    h('p', { class: 'sub' }, '録音は、文字にし終えるまでこの端末の中に置き、まとめを保存したら消します。音声は OpenAI に送るだけで、ほかには送りません。'));
}

/* ---------- 同期（クラウド） ---------- */
// ログインすると、記録の置き場所が「端末の中」から「クラウド」に変わる。端末ごとの設定（いま開いている場所・控えの日付など）は端末に残す。
const DATA_KINDS = ['places', 'patients', 'visits', 'tsubo', 'symptoms', 'staff'];
const isLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname);
let localStore, cloud = null, cloudFailed = false, user = null, syncError = '', needRender = false, unsubs = [];
async function loadCloud() {
  if (isLocalhost && new URLSearchParams(location.search).has('mock')) return (await import('./src/cloud-mock.js')).createCloud();   // 動作確認用
  return createCloud(firebaseConfig);
}
function syncProblem(e) { console.error(e); syncError = explain(e); toast('クラウドに保存できませんでした。' + syncError); }
// クラウドを保存先にする。書き込みは待たずに戻る（電波がないときは端末にたまり、つながったときに送られる）
function cloudStore(me) {
  const bg = p => { p.catch(syncProblem); return Promise.resolve(); };
  return {
    put: (kind, obj) => (kind === 'meta' ? localStore.put(kind, obj) : bg(cloud.set(me, kind, obj))),
    del: (kind, id) => (kind === 'meta' ? localStore.del(kind, id) : bg(cloud.remove(me, kind, id))),
    putMany: byKind => { for (const k of Object.keys(byKind)) for (const o of byKind[k]) bg(cloud.set(me, k, o)); return Promise.resolve(); },
    delMany: byKind => { for (const k of Object.keys(byKind)) for (const id of byKind[k]) bg(cloud.remove(me, k, id)); return Promise.resolve(); },
  };
}
// 入力の途中や、重ねた画面を開いているあいだは描き直さない（入力が途切れないように）。あとで描き直す
const busy = () => dragging || !!document.querySelector('dialog[open]') || /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
function remoteChanged() { if (busy()) needRender = true; else render(); }

// この端末の中の記録を、クラウドの記録に合わせて1つにまとめる。クラウドに届いたことを確かめてから、端末の中の記録を消す
async function mergeLocalIntoCloud(me) {
  const remote = {}, local = {};
  for (const k of DATA_KINDS) remote[k] = await cloud.fetch(me, k);          // ルールが未設定なら、ここで断られる
  for (const k of DATA_KINDS) local[k] = [...db[k].values()].map(o => JSON.parse(JSON.stringify(o)));
  // 同じ名前の場所・ツボ・症状・担当者がクラウドにあれば、そちらを使う（端末ごとに同じものが二重にならないように）
  const remap = {};
  for (const k of ['places', 'tsubo', 'symptoms', 'staff']) {
    const ids = new Set(remote[k].map(o => o.id)), byNm = new Map(remote[k].map(o => [o.name, o.id]));
    remap[k] = new Map(local[k].filter(o => !ids.has(o.id) && byNm.has(o.name)).map(o => [o.id, byNm.get(o.name)]));
  }
  const to = (k, id) => remap[k].get(id) || id;
  const known = new Set([...local.places, ...remote.places].map(o => o.id));
  const first = [...local.places, ...remote.places].sort((a, b) => a.created - b.created)[0];
  for (const p of local.patients) p.placeId = to('places', known.has(p.placeId) ? p.placeId : first.id);
  for (const s of local.staff) { s.placeIds = [...new Set((Array.isArray(s.placeIds) ? s.placeIds : s.placeId ? [s.placeId] : []).map(x => to('places', x)))]; delete s.placeId; }
  for (const v of local.visits) {
    v.symptoms = [...new Set((v.symptoms || []).map(x => to('symptoms', x)))];
    if (v.staffId) v.staffId = to('staff', v.staffId);
    for (const r of v.rows || []) { r.tsuboId = to('tsubo', r.tsuboId); if (r.symptomId) r.symptomId = to('symptoms', r.symptomId); }
  }
  const usedPlaces = new Set([...local.patients.map(p => p.placeId), ...local.staff.flatMap(s => s.placeIds)]);
  const ops = [];
  for (const k of DATA_KINDS) {
    const byId = new Map(remote[k].map(o => [o.id, o]));
    for (const o of local[k]) {
      if (remap[k] && remap[k].has(o.id)) continue;                                       // 同じ名前のものがクラウドにある
      if (k === 'places' && remote.places.length && !usedPlaces.has(o.id)) continue;      // 患者も担当者もいない場所は持ち込まない
      const r = byId.get(o.id);
      if (r && (r.updated || 0) >= (o.updated || 0)) continue;                            // クラウドのほうが新しい
      ops.push({ kind: k, obj: o });
    }
  }
  if (!remote.places.length && !ops.some(o => o.kind === 'places')) ops.push({ kind: 'places', obj: { id: uid(), name: '治療院', mode: 'no', created: Date.now(), updated: Date.now() } });
  await cloud.commit(me, ops);
  for (const k of new Set(ops.map(o => o.kind))) {
    const ids = new Set((await cloud.fetch(me, k)).map(o => o.id));
    if (ops.some(o => o.kind === k && !ids.has(o.obj.id))) throw Object.assign(new Error('クラウドに届いていない記録があります'), { code: 'unavailable' });
  }
  await localStore.clearData();
  const n = k => ops.filter(o => o.kind === k).length;
  return { patients: n('patients'), visits: n('visits') };
}
// クラウドの記録を見張り、画面のもとになるデータ（db）に映す
async function enterCloud(u) {
  for (const off of unsubs) off();
  unsubs = [];
  for (const k of DATA_KINDS) db[k].clear();
  user = u; store = cloudStore(u.uid); syncError = '';
  let live = false;
  await new Promise(res => {
    const waiting = new Set(DATA_KINDS);
    const got = k => { waiting.delete(k); if (!waiting.size) res(); };
    for (const k of DATA_KINDS) unsubs.push(cloud.listen(u.uid, k, changes => {
      let remote = false;
      for (const c of changes) {
        if (c.type === 'removed') { if (db[k].delete(c.id) && !c.local) remote = true; }
        else if (!(c.local && db[k].has(c.id))) { db[k].set(c.id, c.data); if (!c.local) remote = true; }     // この端末の書き込みは、もう db に入っている
      }
      if (!live) got(k); else if (remote) remoteChanged();
    }, e => { console.error(e); syncError = explain(e); if (!live) got(k); else remoteChanged(); }));
    setTimeout(res, 8000);
  });
  live = true;
  await metaSet('sync', { uid: u.uid, email: u.email });
}
async function login(email, pw, say) {
  let u;
  try { u = await cloud.signIn(email, pw); } catch (e) { say(explain(e)); return; }
  try {
    const moved = await mergeLocalIntoCloud(u.uid);
    await enterCloud(u);
    toast(moved.patients || moved.visits ? `この端末の記録（患者 ${moved.patients}人・来院 ${moved.visits}回）をクラウドに移しました` : '同期を始めました');
    render();
  } catch (e) {
    console.error(e);
    try { await cloud.signOut(false); } catch (e2) {}
    say(e.code === 'permission-denied' ? 'ログインはできましたが、クラウド側の設定（ルール）がまだ済んでいないため、同期を始められませんでした。この端末の記録はそのままです。'
      : `同期を始められませんでした。この端末の記録はそのままです。（${explain(e)}）`);
  }
}
async function logout() {
  const offline = navigator.onLine ? '' : '\n\nいま電波がありません。まだクラウドに送っていない記録があると、失われます。電波のあるところで行ってください。';
  if (!await confirmDialog('ログアウトします。この端末では記録が見られなくなります（クラウドには残り、もう一度ログインすると戻ります）。' + offline, 'ログアウト', true)) return;
  await metaSet('sync', null);
  try { await cloud.signOut(true); } catch (e) { console.error(e); }
  location.hash = '#/settings';
  location.reload();
}
function syncCard() {
  if (user) return h('div', { class: 'card' },
    h('h2', null, '同期'),
    h('p', null, `同期しています：${user.email}`),
    h('p', { class: 'sub' }, '記録はクラウドに保存され、同じログインの端末にすぐ届きます。電波がないときは端末にためておき、つながったときに送ります。'),
    syncError ? h('p', { style: 'color:var(--danger)' }, `クラウドとのやりとりで問題が起きています：${syncError}`) : null,
    h('button', { class: 'btn', onclick: logout }, 'ログアウト'));
  if (!cloud) return h('div', { class: 'card' }, h('h2', null, '同期'), h('p', { class: 'sub' }, cloudFailed ? '同期の準備ができませんでした。電波のあるところで開き直してください。' : '同期の準備をしています…'));
  const email = h('input', { type: 'email', placeholder: 'メールアドレス', autocomplete: 'username', autocapitalize: 'off' });
  const pw = h('input', { type: 'password', placeholder: 'パスワード', autocomplete: 'current-password' });
  const msg = h('p', { style: 'color:var(--danger)', hidden: true });
  const label = 'ログインして同期を始める';
  const btn = h('button', { class: 'btn primary', onclick: async () => {
    btn.disabled = true; btn.textContent = 'ログインしています…'; msg.hidden = true;
    await login(email.value, pw.value, t => { msg.textContent = t; msg.hidden = false; });
    btn.disabled = false; btn.textContent = label;
  } }, label);
  return h('div', { class: 'card' },
    h('h2', null, '同期'),
    h('p', null, 'ログインすると、記録がクラウドに保存され、iPad・iPhone・Mac で同じ記録を使えます。ツボマップ3D と同じメールアドレスとパスワードでログインします。'),
    db.patients.size ? h('p', { class: 'sub' }, 'この端末に入っている記録は、ログインするとクラウドに移り、ほかの端末の記録と1つにまとまります。念のため、先に下の「控えを書き出す」をしておくと安心です。') : null,
    email, pw, btn, msg);
}

/* ---------- はじまり ---------- */
async function main() {
  try {
    localStore = await openStore({
      onBlocked: () => $('#view').replaceChildren(h('p', { class: 'empty' }, 'ほかのタブ（ウィンドウ）で、古い版のツボ記録が開いたままになっています。そのタブを閉じてください。閉じると、この画面は自動で開きます。')),
      onStale: () => location.reload(),          // このタブが古くなった：読み込み直して新しい版にする
    });
    store = localStore;
    const all = await localStore.loadAll();
    for (const k of Object.keys(db)) for (const o of all[k] || []) db[k].set(o.id, o);
  } catch (e) {
    console.error(e);
    $('#view').replaceChildren(h('p', { class: 'empty' }, '記録の保存場所を開けませんでした。プライベートブラウズを使っている場合は、通常の画面で開き直してください。'));
    return;
  }
  // 端末の中で使うときの最初の用意（症状の初期リストと、最初の場所）
  const prepareLocal = async () => {
    if (!metaGet('seeded')) {
      const seed = SEED_SYMPTOMS.map((name, i) => ({ id: uid(), name, archived: false, created: Date.now() + i, updated: Date.now() }));
      await localStore.putMany({ symptoms: seed });
      for (const s of seed) db.symptoms.set(s.id, s);
      await metaSet('seeded', true);
    }
    if (!db.places.size) await put('places', { id: uid(), name: '治療院', mode: 'no', created: Date.now() });
  };
  // 問診の録音：文字にしていない録音の一覧を読む。動作確認のときは、にせの AI を使う
  try { await ms.initClips(); } catch (e) { console.error(e); }
  if (isMock) ms.setFetch((await import('./src/ai-mock.js')).mockFetch);
  window.addEventListener('hashchange', render);
  window.addEventListener('beforeunload', e => { if (ms.isRecording()) { e.preventDefault(); e.returnValue = ''; } });      // 録音中に閉じかけたら、たずねる
  $('#recbar').addEventListener('click', () => { if (ms.isRecording()) go('#/v/' + ms.rec.visitId); });
  document.addEventListener('focusout', () => setTimeout(() => { if (needRender && !busy()) render(); }, 150));
  if ('serviceWorker' in navigator && !isLocalhost) {
    // 新しい版は、開いたあと裏で入る。まだ何もさわっていなければ、その場で読みなおして新しい版に切り替える（さわったあとは、作業を止めないよう知らせるだけ）
    const had = !!navigator.serviceWorker.controller;
    let touched = false;
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => { touched = true; }, { capture: true, passive: true });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!had) return;
      if (!touched && !ms.isRecording() && !busy()) location.reload();
      else toast('新しい版が入りました。閉じて開き直すと切り替わります');
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  if (metaGet('sync')) {
    // 前回ログインしていた：クラウドの記録を出す。端末の中の記録として使い始めてしまわないよう、準備できるまで待つ
    $('#view').replaceChildren(h('p', { class: 'empty' }, '記録を読み込んでいます…'));
    try {
      cloud = await loadCloud();
      const u = await cloud.ready;
      if (u) await enterCloud(u);
      else { await metaSet('sync', null); await prepareLocal(); }       // ログインが切れていた
    } catch (e) {
      console.error(e);
      $('#view').replaceChildren(h('p', { class: 'empty' }, '同期の準備ができませんでした。電波のあるところで開き直してください。'), h('button', { class: 'btn', style: 'align-self:center', onclick: () => location.reload() }, 'もう一度ためす'));
      return;
    }
    render();
  } else {
    await prepareLocal();
    render();
    const again = () => { if (parseRoute().name === 'settings' && !busy()) render(); };
    loadCloud().then(async c => {
      const u = await c.ready;
      if (u) { try { await c.signOut(false); } catch (e) {} }             // 同期を始める途中で止まったログインは、やり直してもらう
      cloud = c; again();
    }).catch(e => { console.error(e); cloudFailed = true; again(); });
  }
}
main();
