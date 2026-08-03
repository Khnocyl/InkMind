import { toLocalDateKey } from './writingActivity';

/** 日更字数账本：YYYY-MM-DD → 当日净增字数（可负，若删文） */
export type DailyWordLog = Record<string, number>;

export interface DailyGoalStatus {
  /** 今日净增字数（账本） */
  todayWords: number;
  /** 目标；0/null 表示未设置 */
  target: number | null;
  /** 0–100+ */
  pct: number | null;
  met: boolean;
  remaining: number;
  label: string;
}

export function accrueDailyWords(
  log: DailyWordLog | undefined | null,
  delta: number,
  dayKey?: string
): DailyWordLog {
  if (!delta || !Number.isFinite(delta)) return { ...(log || {}) };
  const key = dayKey || toLocalDateKey();
  const next = { ...(log || {}) };
  next[key] = Math.round((next[key] || 0) + delta);
  // 修剪过旧键（保留约 120 天）
  const keys = Object.keys(next).sort();
  if (keys.length > 120) {
    for (const k of keys.slice(0, keys.length - 120)) {
      delete next[k];
    }
  }
  return next;
}

export function getDayWords(log: DailyWordLog | undefined | null, dayKey?: string): number {
  const key = dayKey || toLocalDateKey();
  const n = log?.[key];
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0;
}

export function evaluateDailyGoal(
  log: DailyWordLog | undefined | null,
  dailyTarget?: number | null,
  dayKey?: string
): DailyGoalStatus {
  const todayWords = getDayWords(log, dayKey);
  const target =
    typeof dailyTarget === 'number' && dailyTarget > 0 ? Math.floor(dailyTarget) : null;
  if (target == null) {
    return {
      todayWords,
      target: null,
      pct: null,
      met: false,
      remaining: 0,
      label: todayWords > 0 ? `今日 +${todayWords.toLocaleString()} 字` : '今日尚未记账',
    };
  }
  const pct = Math.round((todayWords / target) * 1000) / 10;
  const remaining = Math.max(0, target - todayWords);
  const met = todayWords >= target;
  return {
    todayWords,
    target,
    pct,
    met,
    remaining,
    label: met
      ? `今日达标 ${todayWords.toLocaleString()}/${target.toLocaleString()} 字`
      : `今日 ${todayWords.toLocaleString()}/${target.toLocaleString()} · 还差 ${remaining.toLocaleString()}`,
  };
}

/** 正文字数（与 pipeline 一致） */
export function countContentWords(content: string | undefined, wordCount?: number): number {
  if (typeof wordCount === 'number' && wordCount >= 0) return wordCount;
  return (content || '').replace(/\s+/g, '').length;
}
