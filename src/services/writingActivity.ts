import type { Chapter } from '../types/novel';

export interface DayActivity {
  /** YYYY-MM-DD */
  date: string;
  words: number;
  chapters: number;
}

export interface WritingActivitySummary {
  /** 从旧到新，长度 = days */
  days: DayActivity[];
  /** 含今天向前连续有写作日的 streak；若今天无写则看昨天起 */
  streak: number;
  wordsLast7: number;
  wordsLast28: number;
  chaptersLast7: number;
  /** 最近有写作的日期 */
  lastActiveDate: string | null;
  /** 热力最大字数（用于着色） */
  maxDayWords: number;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地日历日 YYYY-MM-DD */
export function toLocalDateKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseDateKey(isoOrDate: string | undefined | null): string | null {
  if (!isoOrDate || typeof isoOrDate !== 'string') return null;
  const s = isoOrDate.trim();
  // ISO 或 YYYY-MM-DD
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return toLocalDateKey(new Date(t));
  return null;
}

function chapterWordCount(c: Chapter): number {
  if (c.wordCount && c.wordCount > 0) return c.wordCount;
  return (c.content || '').replace(/\s+/g, '').length;
}

/**
 * 推断章节「写作归属日」：
 * contentUpdatedAt → lockedAt → recap.generatedAt → memoryWriteLog.generatedAt
 * （lastModified 常为仅时间，不可靠）
 */
export function resolveChapterActivityDate(ch: Chapter): string | null {
  return (
    parseDateKey(ch.contentUpdatedAt) ||
    parseDateKey(ch.lockedAt) ||
    parseDateKey(ch.recap?.generatedAt) ||
    parseDateKey(ch.memoryWriteLog?.generatedAt) ||
    null
  );
}

function shiftDateKey(key: string, deltaDays: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  return toLocalDateKey(dt);
}

/**
 * 按章归因到日历日（全文字数归入最近一次正文更新日）。
 * 用于日更热力 / streak，非精确增量日志。
 */
export function computeWritingActivity(
  chapters: Chapter[],
  options?: { days?: number; today?: string }
): WritingActivitySummary {
  const dayCount = Math.max(7, Math.min(90, options?.days ?? 28));
  const today = options?.today || toLocalDateKey();

  const map = new Map<string, { words: number; chapters: number }>();
  for (const ch of chapters) {
    const words = chapterWordCount(ch);
    if (words <= 0) continue;
    const date = resolveChapterActivityDate(ch);
    if (!date) continue;
    const cur = map.get(date) || { words: 0, chapters: 0 };
    cur.words += words;
    cur.chapters += 1;
    map.set(date, cur);
  }

  const days: DayActivity[] = [];
  for (let i = dayCount - 1; i >= 0; i--) {
    const date = shiftDateKey(today, -i);
    const cur = map.get(date);
    days.push({
      date,
      words: cur?.words || 0,
      chapters: cur?.chapters || 0,
    });
  }

  let lastActiveDate: string | null = null;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].words > 0) {
      lastActiveDate = days[i].date;
      break;
    }
  }

  // streak：从今天或昨天起向前连续
  let streak = 0;
  let cursor = today;
  if ((map.get(today)?.words || 0) === 0) {
    cursor = shiftDateKey(today, -1);
  }
  while (true) {
    if ((map.get(cursor)?.words || 0) > 0) {
      streak += 1;
      cursor = shiftDateKey(cursor, -1);
    } else {
      break;
    }
    if (streak > 400) break;
  }

  const last7 = days.slice(-7);
  const wordsLast7 = last7.reduce((s, d) => s + d.words, 0);
  const chaptersLast7 = last7.reduce((s, d) => s + d.chapters, 0);
  const wordsLast28 = days.slice(-28).reduce((s, d) => s + d.words, 0);
  const maxDayWords = days.reduce((m, d) => Math.max(m, d.words), 0);

  return {
    days,
    streak,
    wordsLast7,
    wordsLast28,
    chaptersLast7,
    lastActiveDate,
    maxDayWords,
  };
}

/** 热力色阶 0–4 */
export function heatLevel(words: number, maxDayWords: number): 0 | 1 | 2 | 3 | 4 {
  if (words <= 0) return 0;
  if (maxDayWords <= 0) return 1;
  const r = words / maxDayWords;
  if (r < 0.2) return 1;
  if (r < 0.4) return 2;
  if (r < 0.7) return 3;
  return 4;
}

export function heatClass(level: 0 | 1 | 2 | 3 | 4): string {
  switch (level) {
    case 0:
      return 'bg-slate-100 border-slate-200';
    case 1:
      return 'bg-indigo-100 border-indigo-200';
    case 2:
      return 'bg-indigo-200 border-indigo-300';
    case 3:
      return 'bg-indigo-400 border-indigo-500';
    case 4:
      return 'bg-indigo-600 border-indigo-700';
  }
}
