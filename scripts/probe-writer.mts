/**
 * 真实执笔 prompt 重放：用 prompts.buildChapterProsePrompt 组装与引擎完全一致的
 * messages（含风格档案/纪律块/分镜/意图），经本地服务端流式调用，观察上游行为。
 * 用法：npx tsx scripts/probe-writer.mjs [model]
 */
import fs from 'node:fs';
import { buildChapterProsePrompt } from '../src/services/prompts';
import { defaultStyleConfig } from '../src/mockData/initialBook';

const model = process.argv[2] || 'deepseek-v4-flash-0731';
const token = fs.readFileSync('.novel-data/api-token', 'utf-8').trim();

const chapter = {
  id: 'ch-speedtest-1',
  number: 1,
  title: '雨夜订单',
  summary:
    '暴雨夜，外卖员陈默接到一单跨江加急配送。送达时收件人已死在车里，现场被布置成单车事故；但陈默看见了尸体上尚未散尽的浓烈恐惧残影，以及一个站在雨里没有伞、身上却没有一丝湿意的男人。男人留下一句「你没看见」后离开。陈默报警，刑警贺兰到场问询；他隐瞒了男人的存在，只交出手机里的配送记录。回家路上，他发现那单外卖的备注栏多出一行自己从未见过的字：「想找到你妹妹，就别删那条记录。」',
  wordCount: 0,
  status: '细纲就绪',
  content: '',
  volumeNumber: 1,
  involvedCharacterIds: ['char-1', 'char-2'],
  involvedSettingIds: ['set-1', 'set-2'],
  beats: [],
  lastModified: '',
} as any;

const beats = [
  { order: 1, description: '暴雨夜接下跨江加急订单，骑手陈默冒雨出发，路上看见寻常人看不见的锈红色恐惧残影' },
  { order: 2, description: '送达桥洞下的黑色轿车，发现车主死亡，现场像单车事故；尸体上的恐惧残影浓得化不开' },
  { order: 3, description: '无伞男人出现，浑身干燥，留下一句「你没看见」后消失；陈默认出他与妹妹失踪前夜出现在江堤的是同一双鞋' },
  { order: 4, description: '报警后刑警贺兰问询，陈默隐瞒关键目击只交出配送记录；回家路上外卖备注栏多出那行字：想找到你妹妹，就别删那条记录' },
] as any[];

const characters = [
  {
    id: 'char-1',
    name: '陈默',
    role: '主角',
    description: '26 岁外卖骑手，寡言，观察力强。雨天能看见情绪残影，用后剧烈头痛。',
    status: '健康',
    realm: '普通人',
    location: '江州老城区',
  },
  {
    id: 'char-2',
    name: '贺兰',
    role: '配角',
    description: '市局刑警，直接，烟瘾大，对目击证词半信半疑。',
    status: '健康',
    location: '江州市局',
  },
] as any[];

const settings = [
  {
    id: 'set-1',
    name: '情绪残影',
    category: '能力规则',
    description: '只在雨天生效；浓度与情绪烈度成正比；深度读取后头痛并短暂失明。',
  },
  {
    id: 'set-2',
    name: '江州老城区',
    category: '地点',
    description: '骑楼、积水、修不好的高架、江堤夜市。',
  },
] as any[];

const messages = buildChapterProsePrompt(
  chapter,
  beats,
  characters,
  settings,
  defaultStyleConfig as any,
  '', // previousContext（第一章）
  '', // storyMemoryBlock
  '', // chapterIntentBlock
  '', // genrePackBlock
  3000 // targetWordCount
);

const totalChars = messages.map((m) => m.content).join('').length;
console.log(`[probe-writer] model=${model} messages=${messages.length} 总字符=${totalChars}`);

const res = await fetch('http://localhost:3001/api/llm/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-token': token },
  body: JSON.stringify({ model, stream: true, temperature: 0.8, messages }),
});
console.log(`[probe-writer] HTTP ${res.status}`);
if (!res.ok) {
  console.log((await res.text()).slice(0, 400));
  process.exit(0);
}
const reader = res.body!.getReader();
const dec = new TextDecoder();
let buf = '', content = '', finish: string | null = null, firstChunkMs: number | null = null;
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
      if (j.error) console.log(`[probe-writer] SSE错误帧: ${String(j.error).slice(0, 200)}`);
      if (j.chunk) { content += j.chunk; if (firstChunkMs == null) firstChunkMs = Date.now() - t0; }
      if (j.finish) finish = j.finish;
    } catch {}
  }
}
console.log(
  JSON.stringify({
    model,
    finish,
    chars: content.length,
    firstChunkMs,
    totalMs: Date.now() - t0,
    head: content.slice(0, 60),
  })
);
