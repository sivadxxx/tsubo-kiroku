// 集計（画面に依存しない計算だけ）
// 効果は 3=◎ 2=○ 1=△ 0=×、未入力は null。「効いた」は ◎ と ○。
export const EFFECTS = [
  { v: 3, mark: '◎', label: 'よく効いた' },
  { v: 2, mark: '○', label: '効いた' },
  { v: 1, mark: '△', label: '少し変化' },
  { v: 0, mark: '×', label: '変化なし' },
];
export const effectMark = v => (EFFECTS.find(e => e.v === v) || { mark: '' }).mark;

// 来院の記録を「ツボ1つ＝1行」に開く。from（YYYY-MM-DD）より前の来院は除く
export function flatten(visits, from) {
  const out = [];
  for (const v of visits) {
    if (from && v.date < from) continue;
    for (const r of v.rows || []) {
      out.push({ date: v.date, patientId: v.patientId, visitId: v.id, symptomId: r.symptomId || null, tsuboId: r.tsuboId, side: r.side || '', aim: r.aim || '', effect: r.effect == null ? null : r.effect });
    }
  }
  return out;
}

// keyFn でまとめて、使った回数・効果の内訳・効いた回数・効いた割合・患者の人数を出す
export function aggregate(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    let a = m.get(k);
    if (!a) { a = { key: k, used: 0, evaluated: 0, counts: [0, 0, 0, 0], good: 0, patients: new Set() }; m.set(k, a); }
    a.used++;
    a.patients.add(r.patientId);
    if (r.effect != null) { a.evaluated++; a.counts[r.effect]++; if (r.effect >= 2) a.good++; }
  }
  return [...m.values()].map(a => ({ ...a, patients: a.patients.size, rate: a.evaluated ? a.good / a.evaluated : null }));
}

// by: 'good'（効いた回数）・'rate'（効いた割合）・'used'（使った回数）
export function sortAgg(list, by) {
  const rate = a => (a.rate == null ? -1 : a.rate);
  const cmp = {
    good: (a, b) => b.good - a.good || rate(b) - rate(a) || b.used - a.used,
    rate: (a, b) => rate(b) - rate(a) || b.evaluated - a.evaluated || b.used - a.used,
    used: (a, b) => b.used - a.used || b.good - a.good,
  }[by] || (() => 0);
  return [...list].sort(cmp);
}
