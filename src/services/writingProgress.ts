import type { BookProject, Chapter, ProjectConfig } from '../types/novel';
import { isChapterLocked } from './chapterLock';

export interface BookProgress {
  currentWords: number;
  /** 目标总字数 = 目标章数 × 每章字数；缺一则为 null */
  targetWords: number | null;
  /** 0–100；无目标时为 null */
  wordPct: number | null;
  chapterCount: number;
  chaptersWithContent: number;
  lockedCount: number;
  targetChapters: number | null;
  chapterPct: number | null;
  /** 全书未完成待修条目数 */
  openTodos: number;
  /** 短文案，如「12.4万 / 30万 · 41%」 */
  wordLabel: string;
  chapterLabel: string;
}

function chapterWordCount(c: Chapter): number {
  if (c.wordCount && c.wordCount > 0) return c.wordCount;
  return (c.content || '').replace(/\s+/g, '').length;
}

function hasContent(c: Chapter): boolean {
  return chapterWordCount(c) > 0;
}

export function resolveTargetChapters(config?: ProjectConfig | null): number | null {
  if (!config) return null;
  const n = config.targetChapterCount ?? config.totalChapters;
  if (typeof n === 'number' && n > 0) return Math.floor(n);
  return null;
}

export function resolveWordsPerChapter(config?: ProjectConfig | null): number | null {
  if (!config) return null;
  const n = config.targetWordCountPerChapter ?? config.wordsPerChapter;
  if (typeof n === 'number' && n > 0) return Math.floor(n);
  return null;
}

export function resolveTargetTotalWords(config?: ProjectConfig | null): number | null {
  const chapters = resolveTargetChapters(config);
  const per = resolveWordsPerChapter(config);
  if (chapters != null && per != null) return chapters * per;
  return null;
}

function countOpenTodos(chapters: Chapter[]): number {
  let n = 0;
  for (const c of chapters) {
    for (const t of c.revisionTodos || []) {
      if (t.status === 'open') n += 1;
    }
  }
  return n;
}

function fmtWords(n: number): string {
  if (n >= 10000) {
    const w = n / 10000;
    return `${w >= 10 ? w.toFixed(0) : w.toFixed(1)}万`;
  }
  return n.toLocaleString();
}

export function computeBookProgress(
  project:
    | Pick<BookProject, 'chapters'> & { config?: ProjectConfig | null }
    | null
    | undefined
): BookProgress {
  const chapters = project?.chapters || [];
  const config = project?.config ?? undefined;
  const currentWords = chapters.reduce((s, c) => s + chapterWordCount(c), 0);
  const chapterCount = chapters.length;
  const chaptersWithContent = chapters.filter(hasContent).length;
  const lockedCount = chapters.filter((c) => isChapterLocked(c)).length;
  const targetChapters = resolveTargetChapters(config);
  const targetWords = resolveTargetTotalWords(config);
  const openTodos = countOpenTodos(chapters);

  const wordPct =
    targetWords && targetWords > 0
      ? Math.min(100, Math.round((currentWords / targetWords) * 1000) / 10)
      : null;
  const chapterPct =
    targetChapters && targetChapters > 0
      ? Math.min(100, Math.round((chaptersWithContent / targetChapters) * 1000) / 10)
      : null;

  const wordLabel =
    targetWords != null
      ? `${fmtWords(currentWords)} / ${fmtWords(targetWords)}${
          wordPct != null ? ` · ${wordPct}%` : ''
        }`
      : `${fmtWords(currentWords)} 字`;

  const chapterLabel =
    targetChapters != null
      ? `有正文 ${chaptersWithContent}/${targetChapters} 章 · 锁定 ${lockedCount}`
      : `有正文 ${chaptersWithContent}/${chapterCount || 0} 章 · 锁定 ${lockedCount}`;

  return {
    currentWords,
    targetWords,
    wordPct,
    chapterCount,
    chaptersWithContent,
    lockedCount,
    targetChapters,
    chapterPct,
    openTodos,
    wordLabel,
    chapterLabel,
  };
}
