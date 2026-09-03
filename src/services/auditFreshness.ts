/**
 * 审校新鲜度（audit freshness）
 *
 * 背景：章节硬伤审（hardReview）结果是「某版正文」的结论。手改正文 /
 * AI 修待修 / 批量去味后，旧结果是否仍成立无从得知。本模块用
 * 内容指纹锚定「审的是哪版」，正文一变即可判定过期，UI 提示重跑本审。
 *
 * 纯函数、无副作用、可单测（值依赖仅 factLedger 的 applyHardIssuesAsRevisionTodos）。
 */
import type { Chapter, MemoryAuditLog } from '../types/novel';
import { applyHardIssuesAsRevisionTodos } from './factLedger';

/**
 * 正文内容指纹：长度 + 正/反两个 32 位 FNV-1a 哈希。
 * - 确定性：同一内容恒同指纹（无随机、无时间）；
 * - 区分度：单字改动即翻转（正反双向注入，捕捉首尾变化）；
 * - 不依赖 contentUpdatedAt（手改路径可能不更新该时间戳）。
 */
export function fingerprintProse(prose: string): string {
  const text = prose || '';
  const len = text.length;
  let fwd = 0x811c9dc5; // FNV-1a 32-bit offset basis
  let rev = 0x811c9dc5;
  for (let i = 0; i < len; i++) {
    fwd ^= text.charCodeAt(i);
    fwd = Math.imul(fwd, 0x01000193) >>> 0;
    rev ^= text.charCodeAt(len - 1 - i);
    rev = Math.imul(rev, 0x01000193) >>> 0;
  }
  return `${len}:${fwd.toString(36)}:${rev.toString(36)}`;
}

/**
 * 审校结果是否已过期：
 * - 无 memoryAudit → 无结果可过期（false，UI 走「未审」分支）；
 * - 有 memoryAudit 但缺锚（旧数据）→ 无法证明未过期，诚实判过期；
 * - 锚与当前正文指纹失配 → 正文已改，判过期。
 */
export function isAuditStale(
  chapter: Pick<Chapter, 'content' | 'memoryAudit'>
): boolean {
  const audit = chapter.memoryAudit;
  if (!audit) return false;
  if (!audit.auditedContentAt) return true;
  return audit.auditedContentAt !== fingerprintProse(chapter.content || '');
}

/** logicConflicts 中「非审校派生」的旧条目（recap 矛盾等无 lane 痕迹），复核后保留 */
function isNonReviewConflict(
  c: MemoryAuditLog['logicConflicts'][number]
): boolean {
  // hard/style lane 一律由复核结果覆盖
  if (c.lane === 'hard' || c.lane === 'style') return false;
  // 无 lane 的机检/文笔审派生条目（type 统一为「行文套路」）同样由复核结果覆盖
  if (c.type === '行文套路') return false;
  return true;
}

/**
 * 复核结果合并回既有 memoryAudit：
 * - 审校派生结论（hardReview / styleReview / ruleScan / progressionReview /
 *   verificationScore / logicConflicts 审校部分）取复核的 freshAudit；
 * - 管线痕迹（注入历史 / memoryInjectionSummary / memoryDebtCount /
 *   修复环 fixHistory / recap 质量 / 非审校 logicConflicts）保留旧值——
 *   复核不重跑这些步骤，不得谎报；
 * - 写入新的版本锚 auditedContentAt（= 复核正文指纹）与完成时间。
 */
export function mergeAuditRefresh(
  oldAudit: MemoryAuditLog | null | undefined,
  freshAudit: MemoryAuditLog,
  auditedContentAt: string,
  auditedAt?: string
): MemoryAuditLog {
  return {
    ...freshAudit,
    // ── 保留（复核不重跑这些管线步骤）──
    injectedCharacters:
      oldAudit?.injectedCharacters ?? freshAudit.injectedCharacters,
    injectedSettings: oldAudit?.injectedSettings ?? freshAudit.injectedSettings,
    injectedPreviousContext: oldAudit?.injectedPreviousContext,
    previousContextSource: oldAudit?.previousContextSource,
    memoryInjectionSummary: oldAudit?.memoryInjectionSummary,
    memoryDebtCount: oldAudit?.memoryDebtCount,
    fixRounds: oldAudit?.fixRounds,
    fixResolved: oldAudit?.fixResolved,
    beatRewriteApplied: oldAudit?.beatRewriteApplied,
    fixHistory: oldAudit?.fixHistory,
    recapQualityBlocked: oldAudit?.recapQualityBlocked,
    recapQualitySummary: oldAudit?.recapQualitySummary,
    // ── logicConflicts：复核派生条目覆盖旧审校条目；非审校旧条目保留 ──
    logicConflicts: [
      ...(freshAudit.logicConflicts || []),
      ...(oldAudit?.logicConflicts || []).filter(isNonReviewConflict),
    ],
    // ── 版本锚 ──
    auditedContentAt,
    lastHardReviewAt: auditedAt ?? oldAudit?.lastHardReviewAt,
  };
}

/**
 * 重跑硬伤审后派生待修：复核结论未过关（或仍含 error 级硬伤）时，
 * 把新硬伤 issues 写入 chapter.revisionTodos，供「全书待修」面板展示。
 * - 与管线口径一致：errorsOnly + 最多 10 条；applyHardIssuesAsRevisionTodos
 *   自带按文本前缀去重，重复派生不会产生双条目；
 * - 已过关且无 error 级（或硬审结论缺失）→ 原样返回，added=0。
 */
export function deriveHardTodosAfterRerun(
  chapter: Chapter,
  freshAudit: MemoryAuditLog,
  options?: { autoRunId?: string }
): { chapter: Chapter; added: number } {
  const hard = freshAudit.hardReview;
  const hasError = (hard?.issues || []).some((i) => i.severity === 'error');
  if (!hard || (!hasError && hard.passed)) {
    return { chapter, added: 0 };
  }
  return applyHardIssuesAsRevisionTodos(chapter, hard.issues, {
    errorsOnly: true,
    max: 10,
    autoRunId: options?.autoRunId,
  });
}
