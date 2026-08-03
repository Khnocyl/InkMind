/**
 * Reviser Agent — 对齐 InkOS reviser：按审稿问题定点/全文修复。
 */
import type { MemoryAuditLog } from '../../types/novel';
import {
  needsConflictFix,
  runConflictFixLoop,
  runHardReview,
} from '../../services/aiEngine';
import type { RuleScanResult } from '../../services/ruleScan';
import type { AgentContext } from '../types';
import { validatePostWrite, type EngineViolation } from '../discipline';

export interface ReviserOutput {
  prose: string;
  auditLog: MemoryAuditLog;
  ruleScan: RuleScanResult;
  postWriteViolations: EngineViolation[];
  reviseRounds: number;
}

export async function runReviserAgent(
  ctx: AgentContext,
  proseIn: string,
  auditLogIn: MemoryAuditLog,
  ruleScanIn: RuleScanResult
): Promise<ReviserOutput> {
  const { input, report, hooks } = ctx;
  const { chapter, characters, settings, styleConfig } = input;
  const maxRounds = input.maxReviseRounds ?? 2;

  let prose = proseIn;
  let auditLog = auditLogIn;
  let ruleScan = ruleScanIn;
  let reviseRounds = 0;

  if (!needsConflictFix(ruleScan, auditLog.logicConflicts, auditLog.hardReview)) {
    report('revise', `[Reviser] 无需修复，跳过`);
    return {
      prose,
      auditLog,
      ruleScan,
      postWriteViolations: validatePostWrite(prose),
      reviseRounds: 0,
    };
  }

  report(
    'revise',
    `第${chapter.number}章 · [Reviser] 修复环（最多 ${maxRounds} 轮）…`
  );

  const fixResult = await runConflictFixLoop(
    prose,
    auditLog,
    ruleScan,
    styleConfig,
    characters,
    settings,
    {
      maxRounds,
      previousProse: input.previousProse,
      targetWordCount: input.targetWordCount,
      onProgress: (msg) =>
        report('revise', msg.replace(/\[Step 4[^\]]*\]/g, '[Reviser]')),
      onProseUpdate: (text) => hooks.onStreamProse?.(text),
    }
  );

  prose = fixResult.prose;
  auditLog = fixResult.auditLog;
  ruleScan = fixResult.ruleScan;
  reviseRounds = fixResult.fixRounds;
  hooks.onStreamProse?.(prose);

  // 修复后复检硬伤
  if (auditLog.hardBlocked || (auditLog.hardReview && !auditLog.hardReview.passed)) {
    report('revise', `[Reviser] 修复后复检硬伤…`);
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

  const postWriteViolations = validatePostWrite(prose);
  report(
    'revise',
    `[Reviser] 完成 · ${reviseRounds} 轮 · 综合分 ${auditLog.verificationScore ?? '—'}`
  );

  return { prose, auditLog, ruleScan, postWriteViolations, reviseRounds };
}
