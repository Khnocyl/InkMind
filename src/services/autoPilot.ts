import { contentWordsOrFallback } from './proseWords';
import type { Chapter, StyleConfig } from '../types/novel';
import { isChapterLocked, shouldAutoPilotSkip } from './chapterLock';

export type AutoPilotStopReason =
  | 'completed_target'
  | 'user_abort'
  | 'rule_scan_fail'
  | 'api_error'
  | 'low_score_streak'
  | 'cross_audit_fail'
  | 'no_more_work'
  | 'busy';

export interface ChapterPipelineResult {
  chapterId: string;
  chapterNumber: number;
  ok: boolean;
  ruleScanPassed: boolean;
  score: number;
  status: Chapter['status'];
  error?: string;
}

export type AutoPilotWriteMode = 'until_green' | 'draft_only' | 'until_review';

export interface AutoPilotConfig {
  targetChapters: number;
  stopOnFail: boolean;
  minScore: number;
  lowScoreStreakLimit: number;
  createMissingChapters: boolean;
  writeMode: AutoPilotWriteMode;
  /** 高置信伏笔回收自动确认（AI 长跑默认开） */
  autoResolveHooks: boolean;
  /** 每写完 N 章本地跨章抽检；0=关，默认 5 */
  crossAuditEvery: number;
  /** 周期抽检最低分，默认 55 */
  crossAuditMinScore: number;
  /** 章末 LLM 补抽账本（默认关） */
  ledgerLlmEnrich: boolean;
  /** 账本死亡 → 角色卡（默认开） */
  syncDeathToCharacters: boolean;
}

export function resolveAutoPilotConfig(style?: StyleConfig | null): AutoPilotConfig {
  const mode = style?.autoPilotWriteMode;
  const writeMode: AutoPilotWriteMode =
    mode === 'draft_only' || mode === 'until_review' || mode === 'until_green'
      ? mode
      : 'until_green';
  const everyRaw = style?.autoPilotCrossAuditEvery;
  const every =
    everyRaw === 0
      ? 0
      : Math.max(0, Math.min(30, everyRaw ?? 5));
  return {
    // AI 连载：单次 AP 可拉到 100 章（仍受停机条件约束）
    targetChapters: Math.max(1, Math.min(100, style?.autoPilotTargetChapters ?? 3)),
    stopOnFail: style?.autoPilotStopOnFail !== false,
    minScore: style?.autoPilotMinScore ?? 65,
    lowScoreStreakLimit: style?.autoPilotLowScoreStreakLimit ?? 2,
    createMissingChapters: style?.autoPilotCreateMissingChapters !== false,
    writeMode,
    autoResolveHooks: style?.autoPilotAutoResolveHooks !== false,
    crossAuditEvery: every,
    crossAuditMinScore: Math.max(
      0,
      Math.min(100, style?.autoPilotCrossAuditMinScore ?? 55)
    ),
    ledgerLlmEnrich: style?.autoLedgerLlmEnrich === true,
    syncDeathToCharacters: style?.autoSyncDeathToCharacters !== false,
  };
}

export function autoPilotWriteModeLabel(mode: AutoPilotWriteMode): string {
  switch (mode) {
    case 'draft_only':
      return '只写草稿';
    case 'until_review':
      return '写到待人工';
    case 'until_green':
    default:
      return '写到机检过并锁定';
  }
}

/** 已有有效正文且流程走完（或明确待人工 / 已锁定） */
export function isChapterEffectivelyDone(ch: Chapter): boolean {
  // 显式解锁优先：用户点了「解锁重写」，即使状态仍是定稿也视为未完成（可重写）
  if (ch.locked === false) return false;
  if (isChapterLocked(ch) || shouldAutoPilotSkip(ch)) return true;
  if (ch.status === '校验通过' || ch.status === '精修定稿' || ch.status === '校验精修定稿') {
    return true;
  }
  if (ch.status === '待人工确认' || ch.status === '机检未通过') return true;
  const words = contentWordsOrFallback(ch.content, ch.wordCount);
  return words >= 200 && !!ch.recap;
}

/** 可自动执笔：有梗概、尚未完成、未锁定 */
export function isChapterWriteCandidate(ch: Chapter): boolean {
  // 定稿锁定：Auto-Pilot 永不静默覆盖
  if (isChapterLocked(ch) || shouldAutoPilotSkip(ch)) return false;
  if (isChapterEffectivelyDone(ch)) return false;
  if (ch.status === '待人工确认' || ch.status === '机检未通过') return false;
  const summary = (ch.summary || '').trim();
  if (summary.length < 8) return false;
  const words = contentWordsOrFallback(ch.content, ch.wordCount);
  // 已有长正文且曾绿通：不自动重写（用户显式解锁的除外）
  if (words >= 200 && ch.status === '校验通过' && ch.locked !== false) return false;
  return true;
}

export function sortChapters(chapters: Chapter[]): Chapter[] {
  return [...chapters].sort((a, b) => a.number - b.number);
}

/** 下一章待写：优先最小章号的候选 */
export function pickNextChapterToWrite(chapters: Chapter[]): Chapter | null {
  return sortChapters(chapters).find(isChapterWriteCandidate) || null;
}

/** 是否需要新建下一章 */
export function needsNewChapter(chapters: Chapter[]): { needed: boolean; nextNumber: number } {
  const sorted = sortChapters(chapters);
  if (sorted.length === 0) return { needed: true, nextNumber: 1 };
  const maxNum = sorted[sorted.length - 1].number;
  const pending = pickNextChapterToWrite(sorted);
  if (pending) return { needed: false, nextNumber: pending.number };
  // 全部已完成 → 可新建 max+1
  return { needed: true, nextNumber: maxNum + 1 };
}

export function autoPilotStopLabel(reason: AutoPilotStopReason): string {
  switch (reason) {
    case 'completed_target':
      return '已完成目标章数';
    case 'user_abort':
      return '用户停止';
    case 'rule_scan_fail':
      return '机检未过，停机待人工';
    case 'api_error':
      return 'API/流程异常停机';
    case 'low_score_streak':
      return '连续低分停机';
    case 'cross_audit_fail':
      return '周期跨章抽检未过停机';
    case 'no_more_work':
      return '无可写章节且未开启自动建章';
    case 'busy':
      return '引擎忙碌';
    default:
      return reason;
  }
}
