/**
 * 模型探针：区分「推理烧尽型」与「正常输出型」。
 * 用小 max_tokens（服务端 NOVEL_LLM_MAX_TOKENS=2048）要求长正文：
 * - 正常模型：finish=length 但有实际正文字符
 * - 推理烧尽：finish=length 且 0 字符（预算全花在 reasoning）
 */
const token = (await import('node:fs')).readFileSync('.novel-data/api-token', 'utf-8').trim();
const BASE = 'http://localhost:3001/api/llm/generate';

async function probe(model, big = false) {
  const userContent = big
    ? `${bigContext()}\n\n---\n根据以上上下文，写一段约3000字的雨夜追逐场景正文，直接开始，不要解释。`
    : '写一段约1200字的都市异能雨夜追逐场景，从主角起跑开始写，直接给正文。';
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-token': token },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.7,
      messages: [
        { role: 'system', content: '你是网文作者。直接输出正文，不要任何解释、前言或思考过程。' },
        { role: 'user', content: userContent },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    return { model, verdict: `HTTP ${res.status}: ${t.slice(0, 120)}` };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', content = '', sawReasoning = false, finish = null, firstChunkMs = null;
  const t0 = Date.now();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data: ')) continue;
      const d = s.slice(6).trim();
      if (d === '[DONE]') continue;
      try {
        const j = JSON.parse(d);
        if (j.error) return { model, verdict: `SSE错误帧: ${String(j.error).slice(0, 150)}` };
        // 服务端只透传 content chunk；reasoning 无法从这里看到，
        // 用「finish=length + 0 字符」作为推理烧尽的特征
        if (j.chunk) { content += j.chunk; if (firstChunkMs == null) firstChunkMs = Date.now() - t0; }
        if (j.finish) finish = j.finish;
      } catch {}
    }
  }
  let verdict;
  if (!finish) verdict = content ? '无结束帧但有内容' : '流结束无内容且无结束帧';
  else if (finish === 'length') verdict = content ? '截断但有正文 → 正常输出型' : '截断且0字符 → 推理烧尽型';
  else verdict = content ? `正常完成(${finish})` : `完成但空内容(${finish})`;
  return { model, verdict, chars: content.length, firstChunkMs, tail: content.slice(-40) };
}

const candidates = process.argv.slice(2);
const big = candidates[0] === '--big';
if (big) candidates.shift();

/** 模拟真实写章的巨型上下文（约 1.4 万字），触发「复杂输入自动思考」 */
function bigContext() {
  const para =
    '雨水的气味渗进骑楼每一道裂缝，霓虹在积水里碎成流动的光斑。' +
    '陈默数着巷口第七根电线杆，湿透的外卖箱贴在背后，像一块渐冷的铁。' +
    '残影在他视野边缘浮动——恐惧是锈红色的，从桥洞深处一圈圈漾开。' +
    '他想起贺兰说过的话：江州每年有一百二十起落水案，结案率九成七。' +
    '剩下的百分之三去了哪里，没有人回答。高压锅般的闷雷滚过天际线。';
  return Array.from({ length: 60 }, (_, i) => `【上下文${i + 1}】${para}`).join('\n');
}

for (const m of candidates) {
  const r = await probe(m, big).catch((e) => ({ model: m, verdict: 'PROBE_FAIL: ' + e.message }));
  console.log(JSON.stringify(r));
}
