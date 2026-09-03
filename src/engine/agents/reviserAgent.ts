/**
 * Reviser Agent — 按审稿问题定点补丁与升级重写修复。
 * 核心机制：
 * ① 快照回退 + 净提升止损——每轮修复落快照，单轮综合分相对上一快照净降 ≥3
 *   提前止损；循环结束最终态非最高分时回退最优快照（同分比硬伤分），防「越修越差」。
 * ② 审稿不可信安全阀——auditLog.auditUnreliable 置位时冻结全部自动修稿。
 */
import type { MemoryAuditLog, PlotBeat } from '../../types/novel';
import {
  isHardReviewApiBlock,
  needsConflictFix,
  runConflictFixLoop,
  runHardReview,
} from '../../services/aiEngine';
import type { ConflictFixLoopResult } from '../../services/aiEngine';
import type { RuleScanResult } from '../../services/ruleScan';
import type { AgentContext } from '../types';
import { validatePostWrite, type EngineViolation } from '../discipline';
import { resolveAllowEmDash } from '../../services/styleImitate';

export interface ReviserOutput {
  prose: string;
  auditLog: MemoryAuditLog;
  ruleScan: RuleScanResult;
  postWriteViolations: EngineViolation[];
  reviseRounds: number;
}

/** 净提升止损阈值：单轮综合分相对上一快照下降 ≥3 → 提前退出并回退最优快照 */
export const REVISION_NET_LOSS_THRESHOLD = 3;

/** 修复环快照：第 0 快照 = 审稿初稿，此后每轮修复产出新状态追加快照 */
export interface RevisionSnapshot {
  /** 0 = 审稿初稿；其后为触发该快照的修复轮次 */
  round: number;
  prose: string;
  auditLog: MemoryAuditLog;
  ruleScan: RuleScanResult;
  verificationScore: number;
  /** 硬伤审分数（综合分同分时的择优 tie-break） */
  hardScore: number;
}

export function makeRevisionSnapshot(
  round: number,
  prose: string,
  auditLog: MemoryAuditLog,
  ruleScan: RuleScanResult
): RevisionSnapshot {
  return {
    round,
    prose,
    auditLog,
    ruleScan,
    verificationScore: auditLog.verificationScore ?? 0,
    hardScore: auditLog.hardReview?.score ?? 0,
  };
}

/** 择优：综合分最高者胜，同分比硬伤分；严格更优才替换（并列保留先出现的快照） */
export function pickBestRevisionSnapshot(
  snapshots: RevisionSnapshot[]
): RevisionSnapshot {
  let best = snapshots[0];
  for (const s of snapshots.slice(1)) {
    if (
      s.verificationScore > best.verificationScore ||
      (s.verificationScore === best.verificationScore &&
        s.hardScore > best.hardScore)
    ) {
      best = s;
    }
  }
  return best;
}

/** 净提升止损判定：该轮分数相对上一快照下降 ≥ REVISION_NET_LOSS_THRESHOLD */
export function isNetLossStop(
  prev: RevisionSnapshot,
  roundScore: number
): boolean {
  return prev.verificationScore - roundScore >= REVISION_NET_LOSS_THRESHOLD;
}

/**
 * 剥离修复环过程簿记（fixRounds/fixResolved/fixHistory/beatRewriteApplied）：
 * 快照存「纯状态」，最终簿记由本 agent 统一回写，避免逐轮调用互相覆盖。
 */
function stripLoopBookkeeping(a: MemoryAuditLog): MemoryAuditLog {
  const next = { ...a };
  delete next.fixRounds;
  delete next.fixResolved;
  delete next.fixHistory;
  delete next.beatRewriteApplied;
  return next;
}

export async function runReviserAgent(
  ctx: AgentContext,
  proseIn: string,
  auditLogIn: MemoryAuditLog,
  ruleScanIn: RuleScanResult,
  beats: PlotBeat[] = []
): Promise<ReviserOutput> {
  const { input, report, hooks } = ctx;
  const { chapter, characters, settings, styleConfig } = input;
  const maxRounds = input.maxReviseRounds ?? 2;

  // 文风豁免：与 Auditor 同口径（档案以省略号/破折号为节奏器官时放松禁令）
  const allowEmDash = resolveAllowEmDash(styleConfig);

  // ── 能力②安全阀：审稿结论不可信 → 冻结全部自动修稿，原文原结论直通绿通判定 ──
  if (auditLogIn.auditUnreliable) {
    report('revise', `[Reviser] 审稿结论不可信，已冻结自动修稿（请人工确认）`);
    return {
      prose: proseIn,
      auditLog: auditLogIn,
      ruleScan: ruleScanIn,
      postWriteViolations: validatePostWrite(proseIn, { allowEmDash }),
      reviseRounds: 0,
    };
  }

  let prose = proseIn;
  let auditLog = auditLogIn;
  let ruleScan = ruleScanIn;

  if (!needsConflictFix(ruleScan, auditLog.logicConflicts, auditLog.hardReview)) {
    report('revise', `[Reviser] 无需修复，跳过`);
    return {
      prose,
      auditLog,
      ruleScan,
      postWriteViolations: validatePostWrite(prose, { allowEmDash }),
      reviseRounds: 0,
    };
  }

  report(
    'revise',
    `第${chapter.number}章 · [Reviser] 修复环（最多 ${maxRounds} 轮）…`
  );

  // ── 能力①：快照回退 + 净提升止损 ──
  // 修复环按「单轮」逐次驱动（maxRounds=1、关闭内部 beat 重写升级档），每轮
  // 产出新状态即落快照；升级档在轮次耗尽仍不过时单独触发（与原行为对齐）。
  const snapshots: RevisionSnapshot[] = [
    makeRevisionSnapshot(0, prose, auditLog, ruleScan),
  ];
  let fixHistory: NonNullable<MemoryAuditLog['fixHistory']> = [];
  let reviseRounds = 0;
  let netLoss = false;
  let beatRewrite = false;

  /** 接住一轮修复结果：无修复动作（history 空）返回 false，状态不变 */
  const applyFixResult = (r: ConflictFixLoopResult): boolean => {
    if (r.history.length === 0) return false;
    prose = r.prose;
    auditLog = stripLoopBookkeeping(r.auditLog);
    ruleScan = r.ruleScan;
    fixHistory = fixHistory.concat(
      r.history.map((h, i) => ({ ...h, round: reviseRounds + i + 1 }))
    );
    reviseRounds += r.history.length;
    return true;
  };
  const fixLoopOptions = (maxRounds: number) => ({
    maxRounds,
    previousProse: input.previousProse,
    targetWordCount: input.targetWordCount,
    beats,
    chapterNumber: chapter.number,
    onProgress: (msg: string) =>
      report('revise', msg.replace(/\[Step 4[^\]]*\]/g, '[Reviser]')),
    onProseUpdate: (text: string) => hooks.onStreamProse?.(text),
  });

  for (let round = 1; round <= maxRounds; round++) {
    if (!needsConflictFix(ruleScan, auditLog.logicConflicts, auditLog.hardReview)) break;
    const prevSnap = snapshots[snapshots.length - 1];
    const r = await runConflictFixLoop(
      prose,
      auditLog,
      ruleScan,
      styleConfig,
      characters,
      settings,
      { ...fixLoopOptions(1), enableBeatRewrite: false }
    );
    // 本轮没有产生任何修复动作 → 无新状态，不落快照
    if (!applyFixResult(r)) break;
    snapshots.push(makeRevisionSnapshot(round, prose, auditLog, ruleScan));
    // 净提升止损：单轮综合分相对上一快照下降 ≥3 → 提前退出
    const score = auditLog.verificationScore ?? 0;
    if (isNetLossStop(prevSnap, score)) {
      netLoss = true;
      report(
        'revise',
        `[Reviser] ⏹ 第 ${round} 轮综合分 ${prevSnap.verificationScore}→${score}（净降 ${prevSnap.verificationScore - score}），止损退出`
      );
      break;
    }
  }

  // 升级档：轮次耗尽（且未止损）机检仍不过 → beat 级重写（只重写相关场景）。
  // maxRounds=0 让内部跳过补丁轮、直接走 beat 重写升级档，触发条件与原实现一致。
  if (
    !netLoss &&
    !ruleScan.passed &&
    beats.length > 0 &&
    !isHardReviewApiBlock(auditLog.hardReview)
  ) {
    const r = await runConflictFixLoop(
      prose,
      auditLog,
      ruleScan,
      styleConfig,
      characters,
      settings,
      fixLoopOptions(0)
    );
    if (applyFixResult(r)) {
      beatRewrite = true;
      snapshots.push(makeRevisionSnapshot(reviseRounds, prose, auditLog, ruleScan));
    }
  }
  hooks.onStreamProse?.(prose);

  // ── 择优回退：最终态非最优 → 回退最优快照的 prose/auditLog/ruleScan ──
  const finalSnap = snapshots[snapshots.length - 1];
  const bestSnap = pickBestRevisionSnapshot(snapshots);
  const finalIsBest =
    bestSnap.verificationScore === finalSnap.verificationScore &&
    bestSnap.hardScore <= finalSnap.hardScore;
  let rollback: MemoryAuditLog['revisionRollback'] | undefined;
  if (!finalIsBest) {
    rollback = {
      fromScore: finalSnap.verificationScore,
      toScore: bestSnap.verificationScore,
      reason: netLoss ? 'net-loss' : 'best-snapshot',
    };
    prose = bestSnap.prose;
    auditLog = bestSnap.auditLog;
    ruleScan = bestSnap.ruleScan;
    hooks.onStreamProse?.(prose);
    report(
      'revise',
      `[Reviser] ↩ 已回退到最高分版本（${rollback.fromScore}→${rollback.toScore}${rollback.reason === 'net-loss' ? ' · 净提升止损' : ' · 择优回退'}）`
    );
  }

  // 修复后复检硬伤：不仅当原硬审未过时复检——只要修复环真的改动了正文
  // （哪怕只是为机检黑名单做的重写），都必须对「新文本」复检：
  // 修复重写本身可能引入新的事实/状态硬伤，不复检就会留到下次审查才爆出来
  // （用户看到的「修了又出现其他硬伤」正是这条漏网路径）。
  const proseChangedByFix = prose !== proseIn;
  const hardReviewStale =
    auditLog.hardBlocked ||
    (auditLog.hardReview && !auditLog.hardReview.passed) ||
    proseChangedByFix;
  if (hardReviewStale && !isHardReviewApiBlock(auditLog.hardReview)) {
    report('revise', `[Reviser] 修复后复检硬伤…`);
    // 已修账本：把本轮修复环动过的冲突描述带给复核，
    // 复核只核验「是否修好 + 是否新出现」，不再对整章重新挑刺（防 phantom error 死循环）
    const previouslyFixed = (auditLog.logicConflicts || [])
      .filter((c) => c.lane === 'hard' || c.description?.startsWith('[规则机检'))
      .slice(0, 10)
      .map((c) => c.description || '');
    const hard2 = await runHardReview(
      prose,
      characters,
      settings,
      (msg) => report('revise', msg),
      {
        previousContext: input.previousContext,
        storyMemoryBlock: input.storyMemoryBlock,
        chapterIntentBlock: input.chapterIntentBlock,
        storyMemory: input.project.memory,
        chapterIntent: chapter.intent,
        involvedCharacterIds: chapter.involvedCharacterIds,
        chapterNumber: chapter.number,
        previouslyFixed,
        isRecheck: true,
      }
    );
    auditLog = {
      ...auditLog,
      hardReview: hard2,
      hardBlocked: !hard2.passed,
      logicConflicts: [
        ...(auditLog.logicConflicts || []).filter((c) => c.lane === 'style'),
        ...hard2.issues.map((i) => ({
          type: i.type as (typeof auditLog.logicConflicts)[0]['type'],
          description: i.description,
          suggestion: i.suggestion,
          lane: 'hard' as const,
        })),
      ],
      verificationScore: !hard2.passed
        ? Math.min(auditLog.verificationScore ?? 100, hard2.score, 68)
        : auditLog.verificationScore,
    };
  }

  const postWriteViolations = validatePostWrite(prose, { allowEmDash });
  // 确定性写后校验是最终裁决：LLM 硬伤复检不认识这些纪律规则（禁止句式/破折号等），
  // 若复检把 auditor 设的 hardBlocked 清掉了而违规仍在 → 在此重新设卡并压分，与 auditor 同口径
  if (postWriteViolations.some((v) => v.severity === 'error')) {
    auditLog = {
      ...auditLog,
      hardBlocked: true,
      verificationScore: Math.min(auditLog.verificationScore ?? 100, 70),
    };
  }

  // 统一回写修复环簿记：fixRounds/fixHistory 为全程尝试记录（含被回退的轮次），
  // revisionRollback 说明最终态是回退所得（回退后复检/写后校验仍可能再调综合分，
  // from/to 记录的是回退决策时点的快照分）。
  auditLog = {
    ...auditLog,
    fixRounds: reviseRounds,
    fixResolved: ruleScan.passed,
    beatRewriteApplied: beatRewrite || undefined,
    fixHistory,
    ...(rollback ? { revisionRollback: rollback } : {}),
  };
  report(
    'revise',
    `[Reviser] 完成 · ${reviseRounds} 轮 · 综合分 ${auditLog.verificationScore ?? '—'}`
  );

  return { prose, auditLog, ruleScan, postWriteViolations, reviseRounds };
}
