// ツボ記録：来院ごとに使ったツボを選んで残し、症状ごとに「効いたツボ」を集計する
import { openStore } from './store.js';
import { EFFECTS, effectMark, flatten, aggregate, sortAgg } from './stats.js';

const VERSION = '1.0';
// 最初から入れておく症状（問診票のチェック項目）。「リスト」でいつでも足せる・消せる
const SEED_SYMPTOMS = ['肩こり', '首のこり', '頭痛', 'めまい', 'ほてり', '目の疲れ', '動悸', '息切れ', '鼻づまり', '倦怠感', '背中の痛み', '腕の痛み', '腰痛', '胃痛', '腹痛', '便秘', '下痢', '生理痛', '股関節痛', '膝痛', '足の痛み', '足のむくみ', '足の痺れ', '冷え性', '不眠'];
const SIDES = [{ v: 'L', label: 'L' }, { v: 'R', label: 'R' }, { v: 'B', label: '両' }, { v: '', label: '中' }];
const sideLabel = v => (SIDES.find(s => s.v === (v || '')) || SIDES[3]).label;

let store;
const db = { patients: new Map(), visits: new Map(), tsubo: new Map(), symptoms: new Map(), meta: new Map() };

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
const patientName = p => (p ? `No.${p.no}${p.label ? '　' + p.label : ''}` : '（患者が見つかりません）');
const tsuboName = id => (db.tsubo.get(id) || { name: '（消したツボ）' }).name;
const symptomName = id => (id == null ? '症状を選んでいない記録' : (db.symptoms.get(id) || { name: '（消した症状）' }).name);
const activeTsubo = () => [...db.tsubo.values()].filter(t => !t.archived);
const activeSymptoms = () => [...db.symptoms.values()].filter(s => !s.archived);
// 来院の中の症状が変わったら、ツボの行がさす症状をそろえる
function fixRows(v) {
  for (const r of v.rows) if (!v.symptoms.includes(r.symptomId)) r.symptomId = v.symptoms[0] || null;
}
const isEmptyVisit = v => v.rows.length === 0 && !(v.memo || '').trim();

/* ---------- 重ねて出す画面 ---------- */
function openDialog({ title, body, footer, full, onClose }) {
  const dlg = h('dialog', { class: full ? 'full' : '' },
    h('div', { class: 'in' },
      h('div', { class: 'row' }, h('h1', { class: 'grow' }, title), full ? h('button', { class: 'btn primary', onclick: () => dlg.close() }, '完了') : null),
      h('div', { class: 'scroll' }, body),
      footer ? h('div', { class: 'row wrap', style: 'justify-content:flex-end' }, footer) : null));
  dlg.addEventListener('close', () => { dlg.remove(); if (onClose) onClose(); });
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

/* ---------- 画面の切り替え ---------- */
let lastRoute = '';
function parseRoute() {
  const [name = '', arg = ''] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || 'patients', arg, key: name + '/' + arg };
}
function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
async function render() {
  const r = parseRoute();
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
}
const topbar = (title, back, sub, right) => h('div', { class: 'top' },
  back ? h('button', { class: 'btn icon', 'aria-label': '戻る', onclick: () => go(back) }, '‹') : null,
  h('div', { class: 'grow' }, h('h1', null, title), sub ? h('span', { class: 'sub' }, sub) : null),
  right || null);

/* ---------- 患者の一覧 ---------- */
let patientQuery = '';
function viewPatients() {
  const idx = visitsByPatient();
  const listEl = h('ul', { class: 'list' });
  const draw = () => {
    const q = norm(patientQuery);
    const rows = [...db.patients.values()]
      .map(p => { const vs = idx.get(p.id) || []; const last = vs[vs.length - 1]; return { p, vs, last, key: last ? last.date : ymd(new Date(p.created)) }; })
      .filter(x => !q || norm(x.p.no).includes(q) || norm(x.p.label).includes(q))
      .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : b.p.created - a.p.created));
    listEl.replaceChildren(...rows.map(({ p, vs, last }) => h('li', null, h('button', { class: 'item', onclick: () => go('#/p/' + p.id) },
      h('span', { class: 'ttl' }, patientName(p)),
      h('span', { class: 'sub' }, last ? `最終 ${fmtDate(last.date)}・${vs.length}回${last.symptoms.length ? '・' + last.symptoms.map(symptomName).join('、') : ''}` : 'まだ記録がありません')))));
    if (!rows.length) listEl.append(h('li', { class: 'empty' }, db.patients.size ? '当てはまる患者がいません。' : 'まず「患者を追加」から、カルテの番号を登録してください。'));
  };
  draw();
  const lastBackup = metaGet('lastBackup');
  const stale = db.visits.size >= 5 && (!lastBackup || Date.now() - lastBackup > 30 * 864e5);
  return [
    topbar('ツボ記録', null, null, h('button', { class: 'btn primary', onclick: () => editPatient(null) }, '＋ 患者を追加')),
    db.patients.size > 5 ? h('input', { type: 'search', placeholder: '番号・呼び名でさがす', value: patientQuery, oninput: e => { patientQuery = e.target.value; draw(); } }) : null,
    stale ? h('button', { class: 'item', onclick: () => go('#/settings') }, h('span', { class: 'sub' }, lastBackup ? '控えを取ってから1か月以上たっています。「控え」から書き出しておくと安心です。' : 'まだ控えを取っていません。「控え」から書き出しておくと安心です。')) : null,
    listEl,
  ];
}
function nextPatientNo() {
  let max = 0;
  for (const p of db.patients.values()) { const n = parseInt(norm(p.no), 10); if (n > max) max = n; }
  return String(max + 1);
}
function editPatient(p) {
  const isNew = !p;
  const no = h('input', { type: 'text', value: isNew ? nextPatientNo() : p.no, inputMode: 'numeric', autocomplete: 'off' });
  const label = h('input', { type: 'text', value: isNew ? '' : p.label || '', placeholder: 'イニシャルなど（空欄でもよい）', autocomplete: 'off' });
  const memo = h('textarea', { value: isNew ? '' : p.memo || '', placeholder: '主訴の覚え書きなど' });
  const save = async () => {
    const v = no.value.trim();
    if (!v) { toast('番号を入れてください'); return; }
    if ([...db.patients.values()].some(x => x.no === v && (isNew || x.id !== p.id))) { toast(`No.${v} はすでに登録されています`); return; }
    const obj = isNew ? { id: uid(), created: Date.now() } : p;
    Object.assign(obj, { no: v, label: label.value.trim(), memo: memo.value.trim() });
    await put('patients', obj);
    saved = obj.id; dlg.close();
  };
  let saved = null, removed = false;
  const dlg = openDialog({
    title: isNew ? '患者を追加' : '患者の情報',
    body: [
      h('label', { class: 'f' }, 'カルテの番号（No）', no),
      h('label', { class: 'f' }, '呼び名', label),
      h('label', { class: 'f' }, 'メモ', memo),
      h('p', { class: 'sub' }, '氏名・住所・電話番号はここに入れず、GoodNotes の問診票に残してください。問診票の「No」の欄に同じ番号を書いておくと、すぐに照らし合わせられます。'),
      isNew ? null : h('button', { class: 'btn danger small', style: 'align-self:flex-start', onclick: async () => {
        const n = visitsOf(p.id).length;
        if (!await confirmDialog(`${patientName(p)} を削除します。${n ? `\nこの患者の記録 ${n} 回分も消え、元に戻せません。` : ''}`, '削除する', true)) return;
        try { await store.delMany({ patients: [p.id], visits: visitsOf(p.id).map(v => v.id) }); } catch (e) { console.error(e); toast('削除できませんでした'); return; }
        for (const v of visitsOf(p.id)) db.visits.delete(v.id);
        db.patients.delete(p.id);
        removed = true; dlg.close();
      } }, 'この患者を削除'),
    ],
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'やめる'), h('button', { class: 'btn primary', onclick: save }, '保存')],
    onClose: () => { if (removed) go('#/'); else if (saved && isNew) go('#/p/' + saved); else render(); },
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
      v = { id: uid(), patientId: id, date: today(), symptoms: last ? last.symptoms.filter(s => db.symptoms.has(s)) : [], rows: [], memo: '', created: Date.now() };
      await put('visits', v);
    }
    go('#/v/' + v.id);
  };
  return [
    topbar(patientName(p), '#/', p.memo || null, h('button', { class: 'btn small', onclick: () => editPatient(p) }, '編集')),
    h('button', { class: 'btn primary big', onclick: start }, vs.some(x => x.date === today()) ? '今日の記録を開く' : '＋ 今日の施術を記録'),
    h('h2', null, `これまでの記録（${vs.length}回）`),
    vs.length ? h('ul', { class: 'list' }, vs.map((v, i) => h('li', null, h('button', { class: 'item', onclick: () => go('#/v/' + v.id) },
      h('span', { class: 'ttl' }, fmtDate(v.date), h('small', null, `${i + 1}回目`), v.symptoms.map(s => h('span', { class: 'tag' }, symptomName(s)))),
      h('span', { class: 'marks' }, v.rows.length ? v.rows.map(r => h('span', null, tsuboName(r.tsuboId), sideLabel(r.side) === '中' ? '' : ' ' + sideLabel(r.side), r.effect != null ? [' ', h('b', null, effectMark(r.effect))] : '')) : h('span', { class: 'sub' }, 'ツボの記録なし')),
      v.memo ? h('span', { class: 'sub' }, v.memo) : null))).reverse())
      : h('p', { class: 'empty' }, 'まだ記録がありません。'),
  ];
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
      await del('visits', v.id); go('#/p/' + v.patientId);
    } }, 'この日の記録を削除'),
    aimList,
  ];
}

function pickSymptoms(v) {
  const usedByPatient = new Set(visitsOf(v.patientId).flatMap(x => x.symptoms));
  const chips = h('div', { class: 'chips' });
  const draw = () => {
    // この患者で使ったことのある症状を先に。あとは登録した順（最初は問診票の並び）
    const list = activeSymptoms().sort((a, b) => (usedByPatient.has(b.id) - usedByPatient.has(a.id)) || a.created - b.created);
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
  let target = v.symptoms.length ? ((v.rows[v.rows.length - 1] || {}).symptomId || v.symptoms[0]) : null;
  // これまでの記録（この来院を除く）から、よく使う順・この症状で効いた順に並べる
  const rows = flatten([...db.visits.values()].filter(x => x.id !== v.id));
  const usedAll = new Map(aggregate(rows, r => r.tsuboId).map(a => [a.key, a.used]));
  let goodHere = new Map();
  const rescore = () => { goodHere = new Map(aggregate(rows.filter(r => r.symptomId === target), r => r.tsuboId).map(a => [a.key, a.good])); };
  rescore();

  const targetEl = h('div', { class: 'chips' }), groupEl = h('div', { class: 'chips' }), listEl = h('div', null);
  const search = h('input', { type: 'search', placeholder: 'ツボの名前でさがす・追加する', autocomplete: 'off', oninput: e => { q = e.target.value; draw(); } });
  const toggle = async (t, side) => {
    const i = v.rows.findIndex(r => r.tsuboId === t.id && (r.side || '') === side);
    if (i < 0) v.rows.push({ tsuboId: t.id, side, symptomId: target, aim: '', effect: null });
    else if (v.rows[i].effect != null || v.rows[i].aim) { toast('ねらい・効果が入っている行は、記録の画面で消してください'); return; }
    else v.rows.splice(i, 1);
    await put('visits', v); draw();
  };
  const draw = () => {
    targetEl.replaceChildren(...(v.symptoms.length >= 2 ? v.symptoms.map(s => h('button', { class: 'chip', 'aria-pressed': String(s === target), onclick: () => { target = s; rescore(); draw(); } }, symptomName(s) + ' に対して')) : []));
    const groups = [...new Set(activeTsubo().map(t => t.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
    if (group && !groups.includes(group)) group = '';
    groupEl.replaceChildren(...(groups.length ? [h('button', { class: 'chip', 'aria-pressed': String(!group), onclick: () => { group = ''; draw(); } }, 'すべて'), ...groups.map(g => h('button', { class: 'chip', 'aria-pressed': String(g === group), onclick: () => { group = g; draw(); } }, g))] : []));
    const nq = norm(q);
    const list = activeTsubo()
      .filter(t => (!group || t.group === group) && (!nq || norm(t.name).includes(nq) || norm(t.yomi).includes(nq)))
      .sort((a, b) => (goodHere.get(b.id) || 0) - (goodHere.get(a.id) || 0) || (usedAll.get(b.id) || 0) - (usedAll.get(a.id) || 0) || byName(a, b));
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
  openDialog({ title: 'ツボを選ぶ', full: true, body: [search, targetEl, groupEl, h('p', { class: 'sub' }, 'L＝左　R＝右　両＝両側　中＝正中・左右なし（もう一度押すと取り消し）'), listEl], onClose: render });
}

/* ---------- 統計 ---------- */
const stats = { mode: 'symptom', symptomId: undefined, tsuboId: undefined, period: 'all', sort: 'good' };
function viewStats() {
  const from = stats.period === 'all' ? null : (() => { const d = new Date(); d.setMonth(d.getMonth() - Number(stats.period)); return ymd(d); })();
  const visits = [...db.visits.values()].filter(v => !from || v.date >= from);
  const rows = flatten(visits);
  const set = (k, val) => { stats[k] = val; render(); };
  const head = [
    topbar('統計'),
    h('div', { class: 'seg' }, [['symptom', '症状ごとの効いたツボ'], ['tsubo', 'ツボごとの効いた症状']].map(([m, l]) => h('button', { class: 'btn', 'aria-pressed': String(stats.mode === m), onclick: () => set('mode', m) }, l))),
    h('div', { class: 'nums' },
      h('div', null, h('b', null, new Set(visits.map(v => v.patientId)).size), h('span', null, '患者')),
      h('div', null, h('b', null, visits.length), h('span', null, '来院')),
      h('div', null, h('b', null, rows.length), h('span', null, 'ツボ（のべ）'))),
  ];
  const period = h('select', { 'aria-label': '期間', onchange: e => set('period', e.target.value) }, [['all', '全期間'], ['3', '直近3か月'], ['12', '直近1年']].map(([val, l]) => h('option', { value: val, selected: stats.period === val }, l)));
  if (!rows.length) return [...head, period, h('p', { class: 'empty' }, 'この期間の記録がまだありません。施術を記録すると、ここに集計が出ます。')];

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
      h('div', { class: 'legend' }, EFFECTS.map(e => h('span', { class: 'key' }, h('i', { class: 'e' + e.v }), `${e.mark} ${e.label}`)), h('span', { class: 'key' }, h('i', { class: 'en' }), '効果を未入力')),
      h('div', null, list.map((a, i) => h('div', { class: 'stat' },
        h('span', { class: 'rank' }, i + 1),
        h('div', { class: 'head' },
          h('span', { class: 'nm' }, otherName(a.key)),
          h('span', { class: 'val' }, a.evaluated ? ['効いた ', h('b', null, `${a.good}/${a.evaluated}`), `回（${Math.round(a.rate * 100)}%）`] : h('span', { class: 'sub' }, '効果を未入力'))),
        h('div', null,
          h('div', { class: 'bar', style: `width:${Math.max(6, a.used / maxUsed * 100)}%`, role: 'img', 'aria-label': EFFECTS.map(e => `${e.mark}${a.counts[e.v]}回`).join(' ') + ` 未入力${a.used - a.evaluated}回` },
            EFFECTS.map(e => a.counts[e.v] ? h('i', { class: 'e' + e.v, style: `flex:${a.counts[e.v]}`, title: `${e.mark} ${a.counts[e.v]}回` }) : null),
            a.used - a.evaluated ? h('i', { style: `flex:${a.used - a.evaluated}`, title: `未入力 ${a.used - a.evaluated}回` }) : null),
          h('div', { class: 'sub' }, `使った ${a.used}回・${a.patients}人` + EFFECTS.filter(e => a.counts[e.v]).map(e => `　${e.mark}${a.counts[e.v]}`).join(''))))))),
    h('p', { class: 'sub' }, `「効いた」は ◎ と ○ の合計です。割合は、効果を入れた回数に対するものです。この${bySym ? '症状' : 'ツボ'}の記録は、のべ ${total}回です。回数が少ないうちは、割合は目安としてご覧ください。`),
  ];
}

/* ---------- リスト（ツボ・症状） ---------- */
let listKind = 'tsubo';
function viewLists() {
  const isT = listKind === 'tsubo';
  const word = isT ? 'ツボ' : '症状';
  const used = new Map();
  for (const v of db.visits.values()) {
    if (isT) for (const r of v.rows) used.set(r.tsuboId, (used.get(r.tsuboId) || 0) + 1);
    else for (const s of v.symptoms) used.set(s, (used.get(s) || 0) + 1);
  }
  const items = [...db[isT ? 'tsubo' : 'symptoms'].values()].sort((a, b) => (a.archived - b.archived) || (isT ? (a.group || '').localeCompare(b.group || '', 'ja') || byName(a, b) : a.created - b.created));
  const name = h('input', { type: 'text', placeholder: `新しい${word}の名前`, autocomplete: 'off' });
  const add = async () => {
    const t = name.value.trim(); if (!t) return;
    if (items.some(x => x.name === t)) { toast(`「${t}」はすでにあります`); return; }
    await put(isT ? 'tsubo' : 'symptoms', isT ? { id: uid(), name: t, yomi: '', group: '', archived: false, created: Date.now() } : { id: uid(), name: t, archived: false, created: Date.now() });
    render();
  };
  name.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) add(); });
  return [
    topbar('リスト'),
    h('div', { class: 'seg' }, [['tsubo', `ツボ（${db.tsubo.size}）`], ['symptoms', `症状（${db.symptoms.size}）`]].map(([k, l]) => h('button', { class: 'btn', 'aria-pressed': String(listKind === k), onclick: () => { listKind = k; render(); } }, l))),
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, name), h('button', { class: 'btn primary', onclick: add }, '追加')),
      h('button', { class: 'btn small', style: 'align-self:flex-start', onclick: () => bulkAdd(isT) }, 'まとめて追加')),
    items.length ? h('ul', { class: 'list' }, items.map(x => h('li', null, h('button', { class: 'item' + (x.archived ? ' off' : ''), onclick: () => editItem(isT, x, used.get(x.id) || 0) },
      h('span', { class: 'ttl' }, x.name, x.yomi ? h('small', null, x.yomi) : null, x.group ? h('span', { class: 'tag' }, x.group) : null),
      h('span', { class: 'sub' }, (x.archived ? '使わない（選ぶ画面に出ません）・' : '') + (used.get(x.id) ? `記録 ${used.get(x.id)}回` : 'まだ使っていません'))))))
      : h('p', { class: 'empty' }, `まだ${word}がありません。上の欄から追加してください。`),
  ];
}
function editItem(isT, x, usedCount) {
  const kind = isT ? 'tsubo' : 'symptoms';
  const name = h('input', { type: 'text', value: x.name, autocomplete: 'off' });
  const yomi = h('input', { type: 'text', value: x.yomi || '', placeholder: 'ひらがな（さがすときに使います）', autocomplete: 'off' });
  const group = h('input', { type: 'text', value: x.group || '', list: 'groups', placeholder: '例：下肢、背部', autocomplete: 'off' });
  const groups = h('datalist', { id: 'groups' }, [...new Set([...db.tsubo.values()].map(t => t.group).filter(Boolean))].map(g => h('option', { value: g })));
  const off = h('input', { type: 'checkbox', checked: !!x.archived });
  const dlg = openDialog({
    title: isT ? 'ツボ' : '症状',
    body: [
      h('label', { class: 'f' }, '名前', name),
      isT ? h('label', { class: 'f' }, 'よみ', yomi) : null,
      isT ? h('label', { class: 'f' }, 'グループ', group) : null,
      isT ? groups : null,
      h('label', { class: 'check' }, off, '使わない（選ぶ画面に出さない。過去の記録と統計には残ります）'),
      usedCount ? h('p', { class: 'sub' }, `記録で ${usedCount}回 使われているので、削除はできません。名前を変えると、過去の記録の表示も変わります。`)
        : h('button', { class: 'btn danger small', style: 'align-self:flex-start', onclick: async () => { await del(kind, x.id); dlg.close(); } }, '削除'),
    ],
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'やめる'), h('button', { class: 'btn primary', onclick: async () => {
      const t = name.value.trim();
      if (!t) { toast('名前を入れてください'); return; }
      if ([...db[kind].values()].some(o => o.name === t && o.id !== x.id)) { toast(`「${t}」はすでにあります`); return; }
      Object.assign(x, { name: t, archived: off.checked }, isT ? { yomi: yomi.value.trim(), group: group.value.trim() } : {});
      await put(kind, x); dlg.close();
    } }, '保存')],
    onClose: render,
  });
}
function bulkAdd(isT) {
  const kind = isT ? 'tsubo' : 'symptoms';
  const ta = h('textarea', { style: 'min-height:200px', placeholder: isT ? '申脈\n承山, しょうざん, 下肢\n膝伝' : '上腕のだるさ\nしびれ' });
  const dlg = openDialog({
    title: `${isT ? 'ツボ' : '症状'}をまとめて追加`,
    body: [h('p', { class: 'sub' }, isT ? '1行に1つ書きます。「名前, よみ, グループ」のようにカンマで区切ると、よみとグループも入ります（名前だけでもよい）。すでにある名前は飛ばします。' : '1行に1つ書きます。すでにある名前は飛ばします。'), ta],
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'やめる'), h('button', { class: 'btn primary', onclick: async () => {
      const have = new Set([...db[kind].values()].map(o => o.name));
      const add = [];
      for (const line of ta.value.split(/\r?\n/)) {
        const [n, y = '', g = ''] = line.split(/[,、，\t]/).map(s => s.trim());
        if (!n || have.has(n)) continue;
        have.add(n);
        add.push(isT ? { id: uid(), name: n, yomi: y, group: g, archived: false, created: Date.now(), updated: Date.now() } : { id: uid(), name: n, archived: false, created: Date.now(), updated: Date.now() });
      }
      try { await store.putMany({ [kind]: add }); } catch (e) { console.error(e); toast('保存できませんでした'); return; }
      for (const o of add) db[kind].set(o.id, o);
      toast(`${add.length}件 追加しました`); dlg.close();
    } }, '追加')],
    onClose: render,
  });
}

/* ---------- 控え（バックアップ・書き出し） ---------- */
async function saveFile(name, text, type) {
  const file = new File([text], name, { type });
  // iPad では共有の画面（「ファイルに保存」など）を出す。パソコンではそのままダウンロードする
  if (navigator.maxTouchPoints > 0 && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = h('a', { href: URL.createObjectURL(file), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return true;
}
const stamp = () => today().replace(/-/g, '');
function toCsv() {
  const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const lines = [['日付', '患者No', '回数', '症状', 'ツボ', '左右', 'ねらい', '効果'].map(q).join(',')];
  const idx = visitsByPatient();
  for (const v of [...db.visits.values()].sort(visitOrder)) {
    const p = db.patients.get(v.patientId), n = (idx.get(v.patientId) || []).indexOf(v) + 1;
    for (const r of v.rows) lines.push([v.date, p ? p.no : '', n, r.symptomId ? symptomName(r.symptomId) : '', tsuboName(r.tsuboId), sideLabel(r.side) === '中' ? '' : sideLabel(r.side), r.aim || '', effectMark(r.effect)].map(q).join(','));
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
    const kinds = ['patients', 'visits', 'tsubo', 'symptoms'];
    const count = k => (Array.isArray(data[k]) ? data[k].length : 0);
    if (!await confirmDialog(`控えを読み込みます。\n患者 ${count('patients')}人・来院 ${count('visits')}回・ツボ ${count('tsubo')}個・症状 ${count('symptoms')}個\n\nいまの記録は残したまま足します。同じ記録がある場合は、控えの内容で上書きします。`, '読み込む')) return;
    const byKind = {};
    for (const k of kinds) byKind[k] = (Array.isArray(data[k]) ? data[k] : []).filter(o => o && typeof o.id === 'string');
    try { await store.putMany(byKind); } catch (err) { console.error(err); toast('読み込めませんでした'); return; }
    for (const k of kinds) for (const o of byKind[k]) db[k].set(o.id, o);
    toast('読み込みました'); render();
  } });
  return [
    topbar('控え'),
    h('div', { class: 'card' },
      h('h2', null, '控え（バックアップ）'),
      h('p', null, '記録は、この端末の中だけに保存されています。端末の故障や買い替えに備えて、ときどき控えを書き出してください。'),
      h('p', { class: 'sub' }, lastBackup ? `最後に書き出した日：${fmtDate(ymd(new Date(lastBackup)))}` : 'まだ書き出していません。'),
      h('button', { class: 'btn primary', onclick: async () => {
        const data = { app: 'tsubo-kiroku', version: 1, exported: new Date().toISOString() };
        for (const k of ['patients', 'visits', 'tsubo', 'symptoms']) data[k] = [...db[k].values()];
        if (await saveFile(`ツボ記録-控え-${stamp()}.json`, JSON.stringify(data), 'application/json')) { await metaSet('lastBackup', Date.now()); render(); }
      } }, '控えを書き出す'),
      h('button', { class: 'btn', onclick: () => file.click() }, '控えを読み込む'), file),
    h('div', { class: 'card' },
      h('h2', null, '表計算ソフト用（CSV）'),
      h('p', null, 'ツボ1つを1行にした一覧です。Excel や Numbers で、自由に集計できます。'),
      h('button', { class: 'btn', disabled: !db.visits.size, onclick: () => saveFile(`ツボ記録-${stamp()}.csv`, toCsv(), 'text/csv') }, 'CSV を書き出す')),
    h('p', { class: 'sub' }, `患者 ${db.patients.size}人・来院 ${db.visits.size}回・ツボ ${db.tsubo.size}個・症状 ${db.symptoms.size}個　／　ツボ記録 ${VERSION}`),
  ];
}

/* ---------- はじまり ---------- */
async function main() {
  try {
    store = await openStore();
    const all = await store.loadAll();
    for (const k of Object.keys(db)) for (const o of all[k] || []) db[k].set(o.id, o);
  } catch (e) {
    console.error(e);
    $('#view').replaceChildren(h('p', { class: 'empty' }, '記録の保存場所を開けませんでした。プライベートブラウズを使っている場合は、通常の画面で開き直してください。'));
    return;
  }
  if (!metaGet('seeded')) {
    const seed = SEED_SYMPTOMS.map((name, i) => ({ id: uid(), name, archived: false, created: Date.now() + i, updated: Date.now() }));
    await store.putMany({ symptoms: seed });
    for (const s of seed) db.symptoms.set(s.id, s);
    await metaSet('seeded', true);
  }
  window.addEventListener('hashchange', render);
  render();
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && !local) navigator.serviceWorker.register('sw.js').catch(() => {});
}
main();
