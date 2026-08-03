/**
 * Auditor Agent — 对齐 InkOS continuity + critic：
 * 硬伤 / 文笔 / 规则机检 + 确定性写后校验。
 */
import type { MemoryAuditLog, PlotBeat } from '../../types/novel';
import {
  ensureProseWordCount,
  step3_CriticVerify,
  countProseWords,
} from '../../services/aiEngine';
import type { RuleScanResult } from '../../services/ruleScan';
import type { AgentContext } from '../types';
import { validatePostWrite, type EngineViolation } from '../discipline';

export interface AuditorOutput {
  prose: string;
  auditLog: MemoryAuditLog;
  ruleScan: RuleScanResult;
  postWriteViolations: EngineViolation[];
}

export async function runAuditorAgent(
  ctx: AgentContext,
  proseIn: string,
  beats: PlotBeat[]
): Promise<AuditorOutput> {
  const { input, report, hooks } = ctx;
  const { chapter, characters, settings, styleConfig } = input;

  report('audit', `第${chapter.number}章 · [Auditor] 双阶段审校…`);

  let prose = proseIn;
  let { polishedProse, auditLog, ruleScan } = await step3_CriticVerify(
    prose,
    characters,
    settings,
    styleConfig,
    (msg) => report('audit', msg.replace(/\[Step 3[A-C]?\]/g, '[Auditor]')),
    {
      previousContextPack: input.contextPack,
      previousContext: input.previousContext,
      storyMemoryBlock: input.storyMemoryBlock,
      chapterIntentBlock: input.chapterIntentBlock,
      storyMemory: input.project.memory,
      chapterIntent: chapter.intent,
      involvedCharacterIds: chapter.involvedCharacterIds,
      chapterNumber: chapter.number,
      previousProse: input.previousProse,
      targetWordCount: input.targetWordCount,
    }
  );
  prose = polishedProse;
  hooks.onStreamProse?.(prose);

  // 润色后字数不足则补写并复审
  const target = input.targetWordCount;
  if (target && target > 0) {
    const afterPolish = countProseWords(prose);
    const minNeed = Math.round(target * 0.9);
    if (afterPolish < minNeed) {
      report(
        'audit',
        `[Auditor] 润色后字数 ${afterPolish}/${target}，补写…`
      );
      const topped = await ensureProseWordCount({
        prose,
        targetWordCount: target,
        chapter,
        beats,
        characters,
        styleConfig,
        chapterIntentBlock: input.chapterIntentBlock,
        minRatio: 0.9,
        maxRounds: 2,
        onStream: (full) => hooks.onStreamProse?.(full),
        onProgress: (msg) => report('audit', msg),
      });
      prose = topped.prose;
      const re = await step3_CriticVerify(
        prose,
        characters,
        settings,
        styleConfig,
        (msg) => report('audit', msg.replace(/\[Step 3[A-C]?\]/g, '[Auditor]')),
        {
          previousContextPack: input.contextPack,
          previousContext: input.previousContext,
          storyMemoryBlock: input.storyMemoryBlock,
          chapterIntentBlock: input.chapterIntentBlock,
          storyMemory: input.project.memory,
          chapterIntent: chapter.intent,
          involvedCharacterIds: chapter.involvedCharacterIds,
          chapterNumber: chapter.number,
          previousProse: input.previousProse,
          targetWordCount: target,
        }
      );
      prose = re.polishedProse;
      auditLog = re.auditLog;
      ruleScan = re.ruleScan;
      hooks.onStreamProse?.(prose);
    }
  }

  report('post_validate', `[Validator] 确定性写后校验…`);
  const postWriteViolations = validatePostWrite(prose);
  if (postWriteViolations.length) {
    // 并入 audit 逻辑冲突，供 reviser 消费
    const extra = postWriteViolations.map((v) => ({
      type: '其他硬伤' as const,
      description: `[${v.rule}] ${v.description}`,
      suggestion: v.suggestion,
      lane: (v.severity === 'error' ? 'hard' : 'style') as 'hard' | 'style',
    }));
    auditLog = {
      ...auditLog,
      logicConflicts: [...(auditLog.logicConflicts || []), ...extra],
    };
    if (postWriteViolations.some((v) => v.severity === 'error')) {
      auditLog = {
        ...auditLog,
        verificationScore: Math.min(auditLog.verificationScore ?? 100, 70),
        hardBlocked: auditLog.hardBlocked || true,
      };
    }
    report(
      'post_validate',
      `[Validator] ${postWriteViolations.length} 项 · ${postWriteViolations.map((v) => v.rule).join('、')}`
    );
  } else {
    report('post_validate', `[Validator] 通过`);
  }

  report(
    'audit',
    `[Auditor] 综合分 ${auditLog.verificationScore ?? '—'} · 机检 ${ruleScan.passed ? '过' : '未过'}`
  );

  return { prose, auditLog, ruleScan, postWriteViolations };
}
