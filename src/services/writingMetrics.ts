import type { Chapter, ProjectConfig, StyleConfig } from '../types/novel';
import { DEFAULT_SUBLIMATION_PATTERNS, DEFAULT_TELL_PATTERNS } from './ruleScan';
import { resolveChapterWordTarget, proseWords } from './proseWords';

export interface ChapterMetrics {
  chapterId: string;
  number: number;
  title: string;
  wordCount: number;
  /** 对话字符占比 0–1（引号内粗算） */
  dialogueRatio: number;
  /** 平均句长（字） */
  avgSentenceLen: number;
  /** 长句占比（>40字） */
  longSentenceRatio: number;
  /** 情绪直给/tell 命中次数 */
  tellHits: number;
  /** 升华句式命中 */
  sublimationHits: number;
  /** 注水启发：重复句/空转比例 */
  paddingScore: number; // 0 干净 – 100 很注水
  /** 相对目标字数 */
  targetWords: number | null;
  targetDelta: number | null;
  /** 综合健康分 0–100（越高越好） */
  healthScore: number;
  flags: string[];
}

export interface BookMetricsSummary {
  totalWords: number;
  chapterCount: number;
  withContent: number;
  avgWords: number;
  avgDialogueRatio: number;
  avgHealth: number;
  chapters: ChapterMetrics[];
  alerts: string[];
}

function countWords(text: string): number {
  return proseWords(text);
}

/** 粗算中文对话：引号「」"" 内字符 */
function dialogueStats(text: string): { dialogueChars: number; total: number } {
  const total = countWords(text);
  let dialogueChars = 0;
  const patterns = [/「([^」]*)」/g, /“([^”]*)”/g, /"([^"]*)"/g];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags);
    while ((m = r.exec(text)) !== null) {
      dialogueChars += countWords(m[1] || '');
    }
  }
  return { dialogueChars, total: total || 1 };
}

function sentences(text: string): string[] {
  return text
    .split(/[。！？…]+/)
    .map((s) => s.replace(/\s+/g, '').trim())
    .filter((s) => s.length > 0);
}

function countPhraseHits(text: string, phrases: string[]): number {
  let n = 0;
  for (const p of phrases) {
    if (!p) continue;
    let idx = 0;
    while (true) {
      const i = text.indexOf(p, idx);
      if (i < 0) break;
      n++;
      idx = i + p.length;
    }
  }
  return n;
}

/** 注水启发：重复 8 字窗口、连续短句堆砌 */
function estimatePadding(text: string): number {
  const pure = text.replace(/\s+/g, '');
  if (pure.length < 80) return 0;
  let score = 0;

  // 重复片段
  const window = 8;
  const seen = new Map<string, number>();
  for (let i = 0; i + window <= pure.length; i += 4) {
    const key = pure.slice(i, i + window);
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  let heavy = 0;
  seen.forEach((v) => {
    if (v >= 3) heavy += v;
  });
  score += Math.min(40, heavy * 2);

  const sents = sentences(text);
  if (sents.length >= 5) {
    const veryShort = sents.filter((s) => s.length <= 4).length;
    score += Math.min(25, (veryShort / sents.length) * 50);
  }

  // 解释腔
  const explain = ['也就是说', '总而言之', '不难发现', '由此可见', '值得一提的是'];
  score += Math.min(20, countPhraseHits(text, explain) * 8);

  return Math.min(100, Math.round(score));
}

export function computeChapterMetrics(
  chapter: Chapter,
  options?: {
    projectConfig?: ProjectConfig | null;
    styleConfig?: StyleConfig | null;
  }
): ChapterMetrics {
  const content = chapter.content || '';
  const wordCount = chapter.wordCount || countWords(content);
  const { dialogueChars, total } = dialogueStats(content);
  const dialogueRatio = total > 0 ? dialogueChars / total : 0;
  const sents = sentences(content);
  const avgSentenceLen =
    sents.length > 0 ? sents.reduce((a, s) => a + s.length, 0) / sents.length : 0;
  const longSentenceRatio =
    sents.length > 0 ? sents.filter((s) => s.length > 40).length / sents.length : 0;

  const tellPhrases = [
    ...DEFAULT_TELL_PATTERNS,
    ...(options?.styleConfig?.clicheBlacklist || []).slice(0, 15),
  ];
  const tellHits = countPhraseHits(content, tellPhrases);
  const sublimationHits = countPhraseHits(content, DEFAULT_SUBLIMATION_PATTERNS);
  const paddingScore = estimatePadding(content);

  const targetWords = resolveChapterWordTarget(options?.projectConfig);
  const targetDelta =
    targetWords && targetWords > 0 ? wordCount - targetWords : null;

  const flags: string[] = [];
  if (wordCount > 0 && wordCount < 400) flags.push('过短');
  if (targetWords && wordCount > targetWords * 1.45) flags.push('远超目标字数');
  if (targetWords && wordCount > 0 && wordCount < targetWords * 0.55) flags.push('远低于目标');
  if (dialogueRatio < 0.05 && wordCount > 800) flags.push('对话偏少');
  if (dialogueRatio > 0.55) flags.push('对话偏多');
  if (longSentenceRatio > 0.35) flags.push('长句偏多');
  if (tellHits >= 3) flags.push('情绪直给偏多');
  if (sublimationHits >= 1) flags.push('疑似升华');
  if (paddingScore >= 45) flags.push('疑似注水');

  // 健康分
  let health = 100;
  health -= Math.min(25, paddingScore * 0.35);
  health -= Math.min(15, tellHits * 4);
  health -= Math.min(15, sublimationHits * 10);
  if (dialogueRatio < 0.05 && wordCount > 800) health -= 8;
  if (longSentenceRatio > 0.4) health -= 8;
  if (targetDelta != null && targetWords) {
    const ratio = Math.abs(targetDelta) / targetWords;
    if (ratio > 0.4) health -= 10;
  }
  if (wordCount === 0) health = 0;
  health = Math.max(0, Math.min(100, Math.round(health)));

  return {
    chapterId: chapter.id,
    number: chapter.number,
    title: chapter.title,
    wordCount,
    dialogueRatio,
    avgSentenceLen: Math.round(avgSentenceLen * 10) / 10,
    longSentenceRatio,
    tellHits,
    sublimationHits,
    paddingScore,
    targetWords,
    targetDelta,
    healthScore: health,
    flags,
  };
}

export function computeBookMetrics(
  chapters: Chapter[],
  options?: {
    projectConfig?: ProjectConfig | null;
    styleConfig?: StyleConfig | null;
  }
): BookMetricsSummary {
  const sorted = [...chapters].sort((a, b) => a.number - b.number);
  const metrics = sorted.map((c) => computeChapterMetrics(c, options));
  const withContent = metrics.filter((m) => m.wordCount > 0);
  const totalWords = metrics.reduce((s, m) => s + m.wordCount, 0);
  const avgWords =
    withContent.length > 0
      ? Math.round(totalWords / withContent.length)
      : 0;
  const avgDialogueRatio =
    withContent.length > 0
      ? withContent.reduce((s, m) => s + m.dialogueRatio, 0) / withContent.length
      : 0;
  const avgHealth =
    withContent.length > 0
      ? Math.round(
          withContent.reduce((s, m) => s + m.healthScore, 0) / withContent.length
        )
      : 0;

  const alerts: string[] = [];
  const low = withContent.filter((m) => m.healthScore < 60);
  if (low.length >= 2) {
    alerts.push(`${low.length} 章健康分偏低（注水/直给/升华风险）`);
  }
  const stagnant = withContent.filter((m) => m.flags.includes('对话偏少'));
  if (stagnant.length >= 3) {
    alerts.push('连续多章对话偏少，可能信息推进弱');
  }
  if (withContent.length === 0) {
    alerts.push('尚无正文，仪表盘待写章后更新');
  }

  return {
    totalWords,
    chapterCount: metrics.length,
    withContent: withContent.length,
    avgWords,
    avgDialogueRatio,
    avgHealth,
    chapters: metrics,
    alerts,
  };
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
