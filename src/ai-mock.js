// 動作確認用の「にせもの」の AI（localhost で ?mock を付けたときだけ使う）。OpenAI の代わりに答えを返す fetch。
// monshin.js の問い合わせの組み立てと、答えの読み方が、そのまま試せる。
// ・キーが fail で始まると、キーが違うとき（401）と同じ答えを返す（本物と同じく、エラーの文にキーの一部が入る）
// ・キーが net で始まると、電波がないときと同じく、つながらない
// ・キーが limit で始まると、使いすぎ・残高不足（429）を返す
// ・キーが old で始まると、話者を分けるモデルには「モデルが見つからない」（404）を返し、gpt-transcribe には答える（切り替わりの確認用）
const wait = ms => new Promise(r => setTimeout(r, ms));
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let n = 0;
const LINES = [
  ['A', '今日はどうされましたか。'],
  ['B', '一週間くらい前から右の肩がこって、夕方になると頭痛もします。'],
  ['A', 'お仕事はパソコンが多いですか。'],
  ['B', 'はい、一日中です。夜もなかなか寝つけなくて。'],
  ['A', '薬は何か飲んでいますか。'],
  ['B', '頭痛のときだけ市販の痛み止めを飲みます。お風呂に入ると少し楽になります。'],
];
export async function mockFetch(url, init = {}) {
  const key = String((init.headers || {}).Authorization || '').replace(/^Bearer /, '');
  await wait(600);
  if (key.startsWith('net')) throw new TypeError('Load failed');
  if (key.startsWith('fail')) return json(401, { error: { message: `Incorrect API key provided: ${key.slice(0, 4)}****${key.slice(-4)}.`, type: 'invalid_request_error', code: 'invalid_api_key' } });
  if (key.startsWith('limit')) return json(429, { error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' } });
  const path = new URL(url).pathname;
  if (path.startsWith('/v1/models/')) {
    const id = decodeURIComponent(path.slice('/v1/models/'.length));
    return /^gpt-6/.test(id) ? json(200, { id, object: 'model', owned_by: 'system' }) : json(404, { error: { message: `The model '${id}' does not exist`, code: 'model_not_found' } });
  }
  if (path === '/v1/audio/transcriptions' && init.body.get('model') === 'gpt-transcribe') {
    // 話者を分けない文字起こし（gpt-transcribe）。language ではなく languages[] で送る決まり
    const fd = init.body;
    if (fd.get('language') || fd.get('response_format') || fd.getAll('languages[]').join() !== 'ja') return json(400, { error: { message: 'bad languages' } });
    if (fd.getAll('keywords[]').some(k => /[<>\r\n]/.test(k))) return json(400, { error: { message: 'bad keywords' } });
    const f = fd.get('file');
    if (!(f instanceof Blob) || !f.size) return json(400, { error: { message: 'no file' } });
    const i = (n++ % 3) * 2;
    return json(200, { text: LINES.slice(i, i + 2).map(l => l[1]).join(''), languages: [{ code: 'ja' }], usage: { type: 'tokens', input_tokens: 50, output_tokens: 40, total_tokens: 90 } });
  }
  // キーが old で始まると、話者を分けるモデルが終了したときと同じく「モデルが見つからない」を返す
  if (path === '/v1/audio/transcriptions' && key.startsWith('old')) return json(404, { error: { message: "The model 'gpt-4o-transcribe-diarize' does not exist or you do not have access to it.", type: 'invalid_request_error', code: 'model_not_found' } });
  if (path === '/v1/audio/transcriptions') {
    const fd = init.body;
    const need = { model: 'gpt-4o-transcribe-diarize', response_format: 'diarized_json', chunking_strategy: 'auto' };
    for (const [k, v] of Object.entries(need)) if (fd.get(k) !== v) return json(400, { error: { message: `bad ${k}` } });
    const f = fd.get('file');
    if (!(f instanceof Blob) || !f.size) return json(400, { error: { message: 'no file' } });
    const i = (n++ % 3) * 2;      // 区切りごとに、会話の続きを返す
    const segs = LINES.slice(i, i + 2).map(([speaker, text], j) => ({ id: 'seg_' + j, type: 'transcript.text.segment', start: j * 3, end: j * 3 + 3, speaker, text }));
    return json(200, { task: 'transcribe', duration: 6, text: segs.map(s => s.text).join(' '), segments: segs });
  }
  if (path === '/v1/responses') {
    const body = JSON.parse(init.body);
    if (!body.model || !body.instructions || !body.input) return json(400, { error: { message: 'bad request' } });
    const lines = (body.input.split('――― ここから会話の文字起こし ―――\n')[1] || '').split('\n').filter(l => l.startsWith('話者')).length;
    const text = `【主訴】\n・右の肩のこり。夕方に頭痛\n【いつから・経過】\n・一週間ほど前から\n【悪くなるとき／楽になるとき】\n・お風呂に入ると少し楽\n【これまでの病気・けが・薬】\n・頭痛のときに市販の痛み止め\n【生活（睡眠・食事・仕事・運動・ストレス）】\n・一日中パソコンの仕事\n・寝つきが悪い\n【患者さんの言葉で気になったもの】\n・「夜もなかなか寝つけなくて」\n【次回たしかめたいこと】\n・頭痛の回数（にせの AI：${body.model}・会話 ${lines}行から作成）`;
    return json(200, { id: 'resp_mock', object: 'response', status: 'completed', model: body.model, output: [{ type: 'reasoning', id: 'rs_1', summary: [] }, { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] });
  }
  return json(404, { error: { message: 'not found' } });
}
