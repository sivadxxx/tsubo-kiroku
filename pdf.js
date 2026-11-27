// 文章を、A4 縦の PDF にする（外部の部品は使わない）。
// 1ページずつ <canvas> に文字を描いて JPEG にし、その画像を貼った最小限の PDF を組み立てる。
const W = 1240, H = 1754, M = 120;                 // ページの大きさと余白（px。A4 を 150dpi ほどで描く）
const FONT = '-apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';
const NO_HEAD = '、。，．,.）」』】〕！？!?ー・ぁぃぅぇぉっゃゅょァィゥェォッャュョ';     // 行の頭に来ないようにする文字

// 1つの段落を、幅に合わせて行に分ける。indent は2行目から下げる幅
function wrap(ctx, text, width, indent) {
  const lines = [];
  let line = '', w = width;
  for (const ch of [...text]) {
    if (line && ctx.measureText(line + ch).width > w && !NO_HEAD.includes(ch)) {
      lines.push(line); line = ''; w = width - indent;
    }
    line += ch;
  }
  lines.push(line);
  return lines;
}

// head：1ページ目の頭に出す行（[見出し, 小さな行...]）。body：本文（改行で段落）
export async function makePdf({ title, meta = [], body }) {
  const pages = [];
  let ctx, y;
  const newPage = () => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000'; ctx.textBaseline = 'top';
    pages.push(c); y = M;
  };
  const put = (text, size, bold, gap, indent = 0) => {
    ctx.font = `${bold ? '600 ' : ''}${size}px ${FONT}`;
    const lh = Math.round(size * 1.7);
    const lines = wrap(ctx, text, W - 2 * M, indent);
    lines.forEach((l, i) => {
      if (y + lh > H - M) { newPage(); ctx.font = `${bold ? '600 ' : ''}${size}px ${FONT}`; }
      ctx.fillText(l, M + (i ? indent : 0), y);
      y += lh;
    });
    y += gap;
  };
  newPage();
  put(title, 46, true, 8);
  for (const m of meta) put(m, 26, false, 0);
  ctx.fillRect(M, y + 16, W - 2 * M, 2);
  y += 48;
  for (const raw of String(body || '').split(/\r?\n/)) {
    const t = raw.trimEnd();
    if (!t.trim()) { y += 20; continue; }
    if (/^【/.test(t)) { y += 14; put(t, 31, true, 4); continue; }
    ctx.font = `30px ${FONT}`;
    put(t, 30, false, 2, /^[・\-]/.test(t) ? ctx.measureText('・').width : 0);
  }
  pages.forEach((c, i) => {      // ページの番号
    const x = c.getContext('2d');
    x.font = `22px ${FONT}`; x.fillStyle = '#666'; x.textAlign = 'center';
    x.fillText(`${i + 1} / ${pages.length}`, W / 2, H - M / 2 - 10);
  });
  const jpegs = [];
  for (const c of pages) {
    const b = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
    jpegs.push(new Uint8Array(await b.arrayBuffer()));
  }
  return { blob: buildPdf(jpegs), pages: pages.length, canvases: pages };
}

// JPEG を1ページに1枚ずつ貼った PDF を組み立てる
function buildPdf(jpegs) {
  const enc = new TextEncoder(), parts = [], offsets = [];
  let size = 0;
  const add = x => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); size += b.length; };
  const obj = (n, body) => { offsets[n] = size; add(`${n} 0 obj\n`); for (const b of [].concat(body)) add(b); add('\nendobj\n'); };
  const pw = 595.28, ph = 841.89;            // A4（pt）
  const n = jpegs.length, kids = jpegs.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  jpegs.forEach((j, i) => {
    const p = 3 + i * 3;
    const draw = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${p + 1} 0 R >> >> /Contents ${p + 2} 0 R >>`);
    obj(p + 1, [`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${j.length} >>\nstream\n`, j, '\nendstream']);
    obj(p + 2, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
  });
  const count = 3 + n * 3, xref = size;
  add(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let i = 1; i < count; i++) add(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  add(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
