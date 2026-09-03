/**
 * 文风统计指纹（本地、不调 LLM）
 * 可量化特征层：句长、对白比、节奏与片语。
 */

import type { StyleFingerprint } from '../types/novel';

const STOP = new Set([
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
  '只是',
  '还是',
  '这个',
  '那个',
  '这里',
  '那里',
  '出来',
  '进去',
  '不能',
  '不会',
  '不是',
  '而已',
  '之后',
  '之前',
  '于是',
  '终于',
  '然后',
  '或者',
  '虽然',
  '而且',
  '以及',
  '就是',
  '还有',
  '这样',
  '那样',
  '怎么',
  '为什么',
]);

function splitSentences(text: string): string[] {
  const t = text.replace(/\r\n/g, '\n').trim();
  if (!t) return [];
  return t
    .split(/(?<=[。！？…!?])\s*|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function dialogueCharCount(text: string): number {
  // 中英文引号配对粗算
  let n = 0;
  const pairs: [string, string][] = [
    ['“', '”'],
    ['「', '」'],
    ['『', '』'],
    ['"', '"'],
    ["'", "'"],
  ];
  for (const [L, R] of pairs) {
    let i = 0;
    while (i < text.length) {
      const a = text.indexOf(L, i);
      if (a < 0) break;
      const b = text.indexOf(R, a + L.length);
      if (b < 0) break;
      n += b - a - L.length;
      i = b + R.length;
    }
  }
  return n;
}

function topPhrases(text: string, limit = 12): string[] {
  const cleaned = text.replace(/\s+/g, '');
  const hits = cleaned.match(/[\u4e00-\u9fff]{2,3}/g) || [];
  const freq = new Map<string, number>();
  for (const h of hits) {
    if (STOP.has(h)) continue;
    if (/^[一二三四五六七八九十百千万]+$/.test(h)) continue;
    freq.set(h, (freq.get(h) || 0) + 1);
  }
  return [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([p]) => p)
    .slice(0, limit);
}

/** 从参考正文提取统计指纹 */
export function analyzeStyleFingerprint(raw: string): StyleFingerprint {
  const text = (raw || '').replace(/\uFEFF/g, '').trim();
  const chars = text.replace(/\s+/g, '');
  const charCount = chars.length;
  const sentences = splitSentences(text);
  const lens = sentences.map((s) => s.replace(/\s+/g, '').length).filter((n) => n > 0);
  const sentenceCount = lens.length || (charCount > 0 ? 1 : 0);
  const avgSentenceLen =
    sentenceCount > 0 ? Math.round((lens.reduce((a, b) => a + b, 0) / sentenceCount) * 10) / 10 : 0;
  const medianSentenceLen = Math.round(median(lens) * 10) / 10;
  const shortSentenceRatio =
    sentenceCount > 0 ? Math.round((lens.filter((n) => n > 0 && n < 12).length / sentenceCount) * 1000) / 1000 : 0;
  const longSentenceRatio =
    sentenceCount > 0 ? Math.round((lens.filter((n) => n > 40).length / sentenceCount) * 1000) / 1000 : 0;

  const dialogueChars = dialogueCharCount(text);
  const dialogueRatio =
    charCount > 0 ? Math.round((dialogueChars / charCount) * 1000) / 1000 : 0;

  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const paragraphCount = paragraphs.length || (charCount > 0 ? 1 : 0);
  const paraLens = paragraphs.map((p) => p.replace(/\s+/g, '').length);
  const avgParagraphLen =
    paragraphCount > 0
      ? Math.round((paraLens.reduce((a, b) => a + b, 0) / paragraphCount) * 10) / 10
      : 0;

  const k = Math.max(charCount / 1000, 0.001);
  const exclamationPerK = Math.round(((text.match(/！|!/g) || []).length / k) * 10) / 10;
  const questionPerK = Math.round(((text.match(/？|\?/g) || []).length / k) * 10) / 10;
  const commas = (text.match(/，|,/g) || []).length;
  const commaPerSentence =
    sentenceCount > 0 ? Math.round((commas / sentenceCount) * 100) / 100 : 0;

  return {
    charCount,
    sentenceCount,
    avgSentenceLen,
    medianSentenceLen,
    shortSentenceRatio,
    longSentenceRatio,
    dialogueRatio,
    paragraphCount,
    avgParagraphLen,
    exclamationPerK,
    questionPerK,
    commaPerSentence,
    topPhrases: topPhrases(text, 12),
    analyzedAt: new Date().toISOString(),
  };
}

/** 指纹短文案（UI / Prompt） */
export function formatFingerprintSummary(fp: StyleFingerprint): string {
  const shortPct = Math.round(fp.shortSentenceRatio * 100);
  const longPct = Math.round(fp.longSentenceRatio * 100);
  const dlgPct = Math.round(fp.dialogueRatio * 100);
  return [
    `样本 ${fp.charCount} 字 · ${fp.sentenceCount} 句`,
    `均句长 ${fp.avgSentenceLen}（中位 ${fp.medianSentenceLen}）`,
    `短句 ${shortPct}% · 长句 ${longPct}%`,
    `对白约 ${dlgPct}% · 段均 ${fp.avgParagraphLen} 字`,
    `！${fp.exclamationPerK}/千字 · ？${fp.questionPerK}/千字 · 逗号/句 ${fp.commaPerSentence}`,
    fp.topPhrases.length ? `高频片语：${fp.topPhrases.slice(0, 8).join('、')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 从样本截取 few-shot 摘录（尽量完整句） */
export function excerptSample(text: string, maxChars = 420): string {
  const t = text.replace(/\r\n/g, '\n').trim();
  if (t.length <= maxChars) return t;
  const slice = t.slice(0, maxChars);
  const cut = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'), slice.lastIndexOf('\n'));
  if (cut > maxChars * 0.5) return slice.slice(0, cut + 1).trim();
  return slice.trim() + '…';
}
