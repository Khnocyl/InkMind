/**
 * 连章开篇去同质：防止第 N 章前段复读第 N-1 章的开场意象/句式。
 * - 写前：注入「上章开篇指纹」到前情包
 * - 写后：本地粗检开篇重合度
 */

/** 取正文开篇（跳过空白/章题行） */
export function takeContentOpening(content: string, maxChars = 280): string {
  let t = (content || '').replace(/^\uFEFF/, '').trim();
  if (!t) return '';
  // 去掉可能的章题行
  t = t.replace(/^第\s*\d+\s*章[^\n]{0,40}\n+/, '');
  t = t.trim();
  if (t.length <= maxChars) return t;
  // 尽量在句号处截断
  const slice = t.slice(0, maxChars);
  const punct = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
    slice.lastIndexOf('\n')
  );
  if (punct > maxChars * 0.45) return slice.slice(0, punct + 1);
  return slice;
}

/** 从文本抽 2～4 字中文片语，用于「禁止复用」列表 */
export function extractImageryPhrases(text: string, limit = 12): string[] {
  const cleaned = (text || '').replace(/\s+/g, '');
  if (!cleaned) return [];
  const hits = cleaned.match(/[\u4e00-\u9fff]{2,4}/g) || [];
  const stop = new Set([
    '一个',
    '没有',
    '已经',
    '因为',
    '所以',
    '但是',
    '如果',
    '可以',
    '什么',
    '自己',
    '他们',
    '我们',
    '时候',
    '地方',
    '知道',
    '觉得',
    '开始',
    '继续',
    '突然',
    '只是',
    '还是',
    '这个',
    '那个',
    '这里',
    '那里',
    '出来',
    '进去',
    '上去',
    '下来',
    '不能',
    '不会',
    '不是',
    '而已',
    '之后',
    '之前',
    '于是',
    '终于',
  ]);
  const freq = new Map<string, number>();
  for (const h of hits) {
    if (stop.has(h)) continue;
    // 过滤纯数字/序数感
    if (/^[一二三四五六七八九十百千]+$/.test(h)) continue;
    freq.set(h, (freq.get(h) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([p]) => p)
    .slice(0, limit);
}

/** bigram 集合，用于重合度 */
function charBigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, '');
  const set = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) {
    set.add(t.slice(i, i + 2));
  }
  return set;
}

export interface OpeningEchoResult {
  /** 0–100，越高越像 */
  score: number;
  /** 是否建议判为需改写 */
  flagged: boolean;
  sharedPhrases: string[];
  prevOpeningPreview: string;
  currOpeningPreview: string;
  detail: string;
}

/**
 * 比较本章开篇与上章开篇的重合度。
 * flagged：score≥38 或共享意象≥3
 */
export function scoreOpeningEcho(
  previousContent: string | undefined | null,
  currentContent: string | undefined | null,
  options?: { openingChars?: number; flagScore?: number }
): OpeningEchoResult {
  const n = options?.openingChars ?? 260;
  const flagScore = options?.flagScore ?? 38;
  const prevOpening = takeContentOpening(previousContent || '', n);
  const currOpening = takeContentOpening(currentContent || '', n);

  if (!prevOpening || !currOpening || currOpening.length < 40) {
    return {
      score: 0,
      flagged: false,
      sharedPhrases: [],
      prevOpeningPreview: prevOpening.slice(0, 80),
      currOpeningPreview: currOpening.slice(0, 80),
      detail: '开篇过短或无上章正文，跳过同质检测',
    };
  }

  const a = charBigrams(prevOpening);
  const b = charBigrams(currOpening);
  let inter = 0;
  for (const x of b) {
    if (a.has(x)) inter += 1;
  }
  const union = a.size + b.size - inter || 1;
  const jaccard = inter / union;
  // 另：片语命中
  const prevPhrases = extractImageryPhrases(prevOpening, 16);
  const currFlat = currOpening.replace(/\s+/g, '');
  const sharedPhrases = prevPhrases.filter((p) => p.length >= 2 && currFlat.includes(p));
  const phraseBoost = Math.min(30, sharedPhrases.length * 6);
  const score = Math.min(100, Math.round(jaccard * 100 + phraseBoost));

  const flagged = score >= flagScore || sharedPhrases.length >= 3;

  return {
    score,
    flagged,
    sharedPhrases: sharedPhrases.slice(0, 8),
    prevOpeningPreview: prevOpening.slice(0, 100),
    currOpeningPreview: currOpening.slice(0, 100),
    detail: flagged
      ? `开篇与上章前段相似度 ${score}（共享意象：${sharedPhrases.slice(0, 5).join('、') || '句式重合'}）——应换场景切口/信息/动作，禁止同氛围复读`
      : `开篇同质度 ${score}，可接受`,
  };
}

/** 写入前情 Prompt 的反复读块 */
export function formatAntiEchoPromptBlock(previousContent: string | undefined | null): string {
  const opening = takeContentOpening(previousContent || '', 240);
  if (!opening) {
    return '【反开篇复读】上章暂无正文开篇样本；仍禁止与上章梗概开场同构（同地点同动作同氛围重开）。';
  }
  const phrases = extractImageryPhrases(opening, 10);
  const lines = [
    '【反开篇复读 — 铁律】',
    '下一章开头 300 字内严禁：',
    '1. 重写上章已写过的开场氛围、同一环境建立镜头、同一套感官堆叠；',
    '2. 用「又是……」「依旧……」「晨光/夜色再次……」式同构起笔；',
    '3. 复述上章已交代的人设/世界观说明书；',
    '4. 章首应直接落在【上章章末现场之后的下一步】：新信息、新动作、新冲突切口。',
    '',
    '【上章开篇原文（仅供对照，禁止仿写/扩写此段）】',
    opening,
  ];
  if (phrases.length) {
    lines.push('');
    lines.push(`【上章开篇高频意象（尽量避开）】${phrases.join('、')}`);
  }
  return lines.join('\n');
}
