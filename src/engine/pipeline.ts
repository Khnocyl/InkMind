/**
 * Chapter Pipeline — InkOS 风格多 agent 编排
 *
 * plan → write → (draft_only 结束)
 *      → audit(+post_validate) → revise → settle → green gate
 */
import type { Chapter, MemoryAuditLog } from '../types/novel';
import {
  isDualReviewGreen,
  isVerificationScoreGreen,
  MIN_GREEN_VERIFICATION_SCORE,
} from '../services/aiEngine';
import { runPlannerAgent } from './agents/plannerAgent';
import { runWriterAgent } from './agents/writerAgent';
import { runAuditorAgent } from './agents/auditorAgent';
import { runReviserAgent } from './agents/reviserAgent';
import { runSettlerAgent } from './agents/settlerAgent';
import { setBudgetConfig, setActiveUsageContext } from '../services/llmClient';
import type {
  AgentContext,
  ChapterPipelineHooks,
  ChapterPipelineInput,
  ChapterPipelineResult,
  EngineStage,
} from './types';

export { MIN_GREEN_VERIFICATION_SCORE };
export type { ChapterPipelineInput, ChapterPipelineHooks, ChapterPipelineResult };

export async function runChapterPipeline(
  input: ChapterPipelineInput,
  hooks: ChapterPipelineHooks = {}
): Promise<ChapterPipelineResult> {
  let stageReached: EngineStage = 'plan';

  const report = (stage: EngineStage, message: string) => {
    stageReached = stage;
    // R3-B：用量归属随阶段推进（引擎级上下文，llmClient 自动记录）
    setActiveUsageContext({
      projectId: input.project?.id,
      chapterNumber,
      stage: `engine:${stage}`,
    });
    hooks.onProgress?.({ stage, message });
  };

  const ctx: AgentContext = { input, hooks, report };
  const chapterId = input.chapter.id;
  const chapterNumber = input.chapter.number;

  // R3-B：注入预算配置（未启用/0 = 不限）
  setBudgetConfig({
    enabled: !!input.styleConfig?.llmBudgetEnabled,
    monthlyLimitCny: input.styleConfig?.llmMonthlyBudgetCny ?? 0,
  });
  setActiveUsageContext({
    projectId: input.project?.id,
    chapterNumber,
    stage: 'engine:init',
  });

  try {
    // ── 1. Planner ──
    const planned = await runPlannerAgent(ctx);
    const { beats, disciplineBlock } = planned;

    // ── 2. Writer ──
    const written = await runWriterAgent(ctx, beats, disciplineBlock);
    let prose = written.prose;
    const conservative = written.conservative;

    if (!prose.trim()) {
      return {
        ok: false,
        stageReached: 'write',
        chapterNumber,
        chapterId,
        beats,
        prose: '',
        wordCount: 0,
        status: '正文草稿',
        locked: false,
        postWriteViolations: [],
        score: 0,
        greenOk: false,
        ruleScanPassed: false,
        reviseRounds: 0,
        errorMessage: 'Writer 返回空正文',
      };
    }

    // ── draft_only：写完即停 ──
    if (input.writeMode === 'draft_only') {
      report('done', `📝 第${chapterNumber}章草稿完成（只写草稿）`);
      return {
        ok: true,
        stageReached: 'done',
        chapterNumber,
        chapterId,
        beats,
        prose,
        wordCount: prose.replace(/\s+/g, '').length,
        status: '正文草稿',
        locked: false,
        postWriteViolations: [],
        score: 0,
        greenOk: true,
        ruleScanPassed: true,
        reviseRounds: 0,
        conservative,
      };
    }

    // ── 3. Auditor + post-validate ──
    const audited = await runAuditorAgent(ctx, prose, beats);
    prose = audited.prose;
    let auditLog: MemoryAuditLog = audited.auditLog;
    let ruleScan = audited.ruleScan;
    let postWriteViolations = audited.postWriteViolations;

    // ── 4. Reviser ──
    const revised = await runReviserAgent(ctx, prose, auditLog, ruleScan);
    prose = revised.prose;
    auditLog = revised.auditLog;
    ruleScan = revised.ruleScan;
    postWriteViolations = revised.postWriteViolations;
    const reviseRounds = revised.reviseRounds;

    // ── 5. Settler ──
    const settled = await runSettlerAgent(ctx, prose, auditLog);
    auditLog = {
      ...settled.auditLog,
      fixRounds: reviseRounds,
      recapQualityBlocked: settled.recapBlockGreen || undefined,
      recapQualitySummary: settled.recapSummary,
    };

    // ── Green gate ──
    const greenOk = isDualReviewGreen(ruleScan, auditLog);
    const score = auditLog.verificationScore ?? ruleScan.score ?? 0;
    const scoreFail = !isVerificationScoreGreen(score);
    const ruleScanPassed = ruleScan.passed;

    let status: Chapter['status'];
    if (input.writeMode === 'until_review') {
      status = '待人工确认';
    } else if (greenOk) {
      status = '校验通过';
    } else if (scoreFail) {
      status = '机检未通过';
    } else {
      status = '待人工确认';
    }

    // 保守稿（LLM 执笔失败降级）即使审校绿也强制不自动锁，提示用户重跑正式稿
    const autoLocked =
      input.writeMode === 'until_green' && greenOk && !conservative;
    const lockedAt = autoLocked ? new Date().toISOString() : undefined;

    report(
      'done',
      conservative
        ? `⚠️ 第${chapterNumber}章管线完成 · 保守稿（未锁） · 分 ${score}`
        : greenOk
          ? `✅ 第${chapterNumber}章管线完成 · 绿通 · 分 ${score}`
          : `⚠️ 第${chapterNumber}章管线完成 · ${status} · 分 ${score}`
    );

    return {
      ok: true,
      stageReached: 'done',
      chapterNumber,
      chapterId,
      beats,
      prose,
      wordCount: prose.replace(/\s+/g, '').length,
      status,
      locked: autoLocked,
      lockedAt,
      auditLog,
      ruleScan,
      postWriteViolations,
      recap: settled.recap,
      memoryWriteLog: settled.writeLog,
      updatedCharacters: settled.updatedCharacters,
      memoryAfterRecap: settled.memoryAfterRecap,
      score,
      greenOk,
      ruleScanPassed,
      reviseRounds,
      conservative,
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    report('error', `[Pipeline] 失败：${msg}`);
    return {
      ok: false,
      stageReached,
      chapterNumber,
      chapterId,
      beats: [],
      prose: '',
      wordCount: 0,
      status: '正文草稿',
      locked: false,
      postWriteViolations: [],
      score: 0,
      greenOk: false,
      ruleScanPassed: false,
      reviseRounds: 0,
      errorMessage: msg,
    };
  } finally {
    // 清理用量上下文，避免污染管线外的直接调用
    setActiveUsageContext(undefined);
  }
}
