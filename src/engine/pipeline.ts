/**
 * Chapter Pipeline — 六阶段多 Agent 创作管线
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
import {
  runPlannerAgent,
} from './agents/plannerAgent';
import { proseWords } from '../services/proseWords';
import { runWriterAgent } from './agents/writerAgent';
import { runAuditorAgent } from './agents/auditorAgent';
import { runReviserAgent } from './agents/reviserAgent';
import { runSettlerAgent } from './agents/settlerAgent';
import {
  setActiveAbortSignal,
  getActiveAbortSignal,
  setActiveRoleRoute,
  listLLMProfiles,
} from '../services/llmClient';
import {
  stageToRole,
  resolveRouteForRole,
  type RoutingProfileLike,
} from '../services/llmRouting';
import {
  GenerationAbortedError,
  isGenerationAborted,
} from '../services/llmResilience';
import { normalizeProseSymbols } from '../services/deslop/normalizePunctuation';
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

  // 按角色路由模型（默认关闭）：开启时拉一次配置档列表，随阶段推进解析角色路由。
  // 拉取失败/档已删除一律回退激活档（resolveRouteForRole → undefined），与关闭等价。
  let routingProfiles: RoutingProfileLike[] = [];
  let routingActiveProfileId: string | undefined;
  if (input.styleConfig?.llmRoleRouting?.enabled) {
    try {
      const list = await listLLMProfiles();
      routingProfiles = list.profiles;
      routingActiveProfileId = list.activeProfileId;
    } catch (err) {
      console.warn('[pipeline] 角色路由配置档拉取失败，本次全部跟随激活档:', err);
    }
  }

  const report = (stage: EngineStage, message: string) => {
    stageReached = stage;
    // 按角色路由：阶段 → 角色 → 配置档（关闭/未配置 → null，全走激活档）
    const role = stageToRole(stage);
    setActiveRoleRoute(
      role
        ? (resolveRouteForRole(
            input.styleConfig?.llmRoleRouting,
            role,
            routingProfiles,
            routingActiveProfileId
          ) ?? null)
        : null
    );
    hooks.onProgress?.({ stage, message });
  };

  const ctx: AgentContext = { input, hooks, report };
  const chapterId = input.chapter.id;
  const chapterNumber = input.chapter.number;

  /** 阶段边界中止检查：用户停止后在最近的检查点尽快退出（LLM 调用内部也会被 signal 打断） */
  const throwIfAborted = () => {
    if (input.signal?.aborted) throw new GenerationAbortedError();
  };

  // 用户中止信号：注入 llmClient 活动上下文，所有 generate* 自动携带。
  // 嵌套安全：保存外层信号（Auto-Pilot 循环级），退出时恢复——
  // 本管线无显式信号时沿用外层，保证 AP 规划等管线外调用同样可中止。
  const prevAbortSignal = getActiveAbortSignal();
  setActiveAbortSignal(input.signal ?? prevAbortSignal ?? null);

  try {
    // 启动前快失败：信号已中止则不发起任何 LLM 调用
    throwIfAborted();

    // ── 1. Planner ──
    const planned = await runPlannerAgent(ctx);
    const { beats, disciplineBlock } = planned;
    throwIfAborted();

    // ── 2. Writer ──
    const written = await runWriterAgent(ctx, beats, disciplineBlock);
    let prose = written.prose;
    const conservative = written.conservative;

    // 符号规范化（确定性，零 LLM）：去 Markdown 残留（**加粗**/# 标题）、
    // 直角引号「」统一为双引号“”。必须在审校/落盘之前，全链路只见干净正文。
    const symbolFix = normalizeProseSymbols(prose);
    if (symbolFix.changed) {
      prose = symbolFix.text;
      report(
        'write',
        `🧹 [Writer] 正文符号清洗：${symbolFix.findings
          .map((f) => `${f.message}×${f.count}`)
          .join('、')}`
      );
    }

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
        wordCount: proseWords(prose),
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
    throwIfAborted();
    const audited = await runAuditorAgent(ctx, prose, beats);
    prose = audited.prose;
    let auditLog: MemoryAuditLog = audited.auditLog;
    let ruleScan = audited.ruleScan;
    let postWriteViolations = audited.postWriteViolations;

    // ── 4. Reviser ──
    throwIfAborted();
    const revised = await runReviserAgent(ctx, prose, auditLog, ruleScan, beats);
    prose = revised.prose;
    auditLog = revised.auditLog;
    ruleScan = revised.ruleScan;
    postWriteViolations = revised.postWriteViolations;
    const reviseRounds = revised.reviseRounds;

    // ── 5. Settler ──
    throwIfAborted();
    const settled = await runSettlerAgent(ctx, prose, auditLog);
    auditLog = {
      ...settled.auditLog,
      fixRounds: reviseRounds,
      recapQualityBlocked: settled.recapBlockGreen || undefined,
      recapQualitySummary: settled.recapSummary,
    };

    // ── Green gate ──
    // 第二道保险：error 级写后违规未被上游拦下时，这里兜底禁止绿通
    const greenOk =
      isDualReviewGreen(ruleScan, auditLog) &&
      !postWriteViolations.some((v) => v.severity === 'error');
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
      wordCount: proseWords(prose),
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
    if (isGenerationAborted(err)) {
      // 用户停止：不算失败也不算完成——调用方会保留已流式产出的草稿
      report('error', `⏹ 第${chapterNumber}章已停止生成（已产出部分保留为草稿）`);
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
        errorMessage: '用户已停止生成',
      };
    }
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
    // 清理中止与角色路由上下文（恢复外层信号），避免污染管线外的直接调用
    setActiveAbortSignal(prevAbortSignal ?? null);
    setActiveRoleRoute(null);
  }
}
