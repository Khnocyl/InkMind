/**
 * Auditor Agent — 连续性审查与双重质量核验：
 * 硬伤 / 文笔 / 规则机检 + 确定性写后校验。
 */
import type {
  Chapter,
  Character,
  ChapterIntent,
  HardReviewIssue,
  MemoryAuditLog,
  PlotBeat,
  ProgressionReviewResult,
  StoryMemory,
  StyleConfig,
  WorldSetting,
} from '../../types/novel';
import {
  ensureProseWordCount,
  countProseWords,
} from '../../services/wordCount';
import {
  isHardReviewApiBlock,
  runHardReview,
  runProgressionReview,
  runStyleReview,
  step3_CriticVerify,
  summarizePolishDiff,
  toRuleScanAudit,
} from '../../services/aiEngine';
import {
  ruleScanHitPhrases,
  ruleScanProse,
  type RuleScanResult,
} from '../../services/ruleScan';
import type { PreviousContextPack } from '../../services/contextPack';
import type { AgentContext } from '../types';
import { validatePostWrite, type EngineViolation } from '../discipline';
import { resolveAllowEmDash } from '../../services/styleImitate';

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

  // 文风豁免：档案声明省略号/破折号为风格器官时，放松对应确定性禁令
  const allowEmDash = resolveAllowEmDash(styleConfig);

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
      beats,
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
        maxRounds: 3,
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
          beats,
        }
      );
      prose = re.polishedProse;
      auditLog = re.auditLog;
      ruleScan = re.ruleScan;
      hooks.onStreamProse?.(prose);
    }
  }

  // ── 审稿结论不可信判定（置位后 reviser 冻结自动修稿）──
  // (a) 硬伤审整体 API 失败走 fallback 且无任何可信结论（本地断言也没抓到硬伤）；
  // (b) 硬伤审零问题但综合分与机检分背离 >25（模型自评与可复现机检严重脱节）。
  // 必须在写后校验压分之前判定：postWrite error 会把综合分压到 70，
  // 压分后比对会造出假背离。
  const machineScore = ruleScan.score;
  const vsScore = auditLog.verificationScore;
  const hardConcluded =
    !!auditLog.hardReview && !isHardReviewApiBlock(auditLog.hardReview);
  const scoreDiverged =
    !!auditLog.hardReview &&
    (auditLog.hardReview.issues || []).length === 0 &&
    Math.abs(vsScore - machineScore) > 25;
  if (!hardConcluded || scoreDiverged) {
    auditLog = { ...auditLog, auditUnreliable: true };
    report(
      'audit',
      `[Auditor] ⚠ 审稿结论不可信（${
        !hardConcluded
          ? '硬伤审无可信结论'
          : `综合分 ${vsScore} 与机检分 ${machineScore} 背离`
      }），自动修稿将被冻结`
    );
  }

  report('post_validate', `[Validator] 确定性写后校验…`);
  const postWriteViolations = validatePostWrite(prose, { allowEmDash });
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

// ─────────────────────────────────────────────────────────────────────
// 轻量复核路径（「重跑本审」专用）——只读，绝不动正文
// ─────────────────────────────────────────────────────────────────────

/** 重跑本审的输入：围绕「本章现有正文」的最小审校上下文 */
export interface AuditExistingProseOptions {
  chapter: Chapter;
  characters: Character[];
  settings: WorldSetting[];
  styleConfig: StyleConfig;
  contextPack?: PreviousContextPack | null;
  previousContext?: string | null;
  storyMemoryBlock?: string | null;
  chapterIntentBlock?: string | null;
  storyMemory?: StoryMemory | null;
  chapterIntent?: ChapterIntent | null;
  /** 上一章正文（开篇同质机检用） */
  previousProse?: string | null;
  /** 本章字数目标（机检 length） */
  targetWordCount?: number | null;
  beats?: PlotBeat[];
  onProgress?: (msg: string) => void;
}

export interface AuditExistingProseResult {
  /** 恒等于输入正文——复核只读的硬保证 */
  prose: string;
  auditLog: MemoryAuditLog;
  ruleScan: RuleScanResult;
  postWriteViolations: EngineViolation[];
}

/** 硬伤 issue → logicConflicts（与 aiEngine.hardIssuesToConflicts 同构，此处私有实现） */
function toHardConflicts(
  issues: HardReviewIssue[]
): MemoryAuditLog['logicConflicts'] {
  return issues.map((i) => ({
    type: i.type as MemoryAuditLog['logicConflicts'][0]['type'],
    description: i.description,
    suggestion: i.suggestion,
    lane: 'hard' as const,
  }));
}

/** 文笔建议 → style 软线索 conflicts（与 aiEngine 的 styleSoftConflicts 同构） */
function toStyleConflicts(
  suggestions: string[]
): MemoryAuditLog['logicConflicts'] {
  return (suggestions || []).slice(0, 4).map((s) => ({
    type: '行文套路' as const,
    description: `[文笔建议] ${s}`,
    suggestion: '可在画布划线精修或接受润色稿；不阻断定稿',
    lane: 'style' as const,
  }));
}

/**
 * 对本章现有正文重新执行审校（硬伤 / 文笔 / 推进度 / 规则机检 / 写后校验），
 * **不改动正文一个字**。
 *
 * 为什么不直接复用 runAuditorAgent / step3_CriticVerify：
 * step3_CriticVerify 内置文笔润色（runStyleReview 返回 polishedProse），
 * runAuditorAgent 还会在字数不足时用 ensureProseWordCount 补写——两条路径的
 * auditLog 都描述「改写后」的文本。复核若直接取用，审计结论会挂在与
 * 实际正文不符的版本上（版本锚失真）。因此这里只组合纯审函数：
 * 润色稿与补写一律丢弃，返回的 prose 恒等于输入。
 */
export async function auditExistingProse(
  options: AuditExistingProseOptions
): Promise<AuditExistingProseResult> {
  const { chapter, characters, settings, styleConfig, onProgress } = options;
  const prose = chapter.content || '';
  const allowEmDash = resolveAllowEmDash(styleConfig);

  onProgress?.(
    `复核第${chapter.number}章 · 双阶段审校（只读复核，不改动正文）…`
  );

  // A. 硬伤审（纯审）
  const hard = await runHardReview(prose, characters, settings, onProgress, {
    previousContext: options.previousContext ?? options.contextPack?.text ?? undefined,
    storyMemoryBlock: options.storyMemoryBlock ?? undefined,
    chapterIntentBlock: options.chapterIntentBlock ?? undefined,
    storyMemory: options.storyMemory,
    chapterIntent: options.chapterIntent,
    involvedCharacterIds: chapter.involvedCharacterIds,
    chapterNumber: chapter.number,
  });

  // B. 文笔审：只取分数/建议，丢弃润色稿（复核不应用任何改写）
  const { style } = await runStyleReview(prose, characters, styleConfig, onProgress);

  // D. 推进度审（成本开关同管线：styleConfig.progressionReviewEnabled === false 跳过）
  let progression: ProgressionReviewResult | undefined;
  let progressionBlocked = false;
  if (styleConfig.progressionReviewEnabled !== false) {
    progression = await runProgressionReview({
      chapterNumber: chapter.number,
      beats: options.beats || chapter.beats || [],
      prose,
      storyMemory: options.storyMemory,
      chapterIntent: options.chapterIntent,
      onProgress,
    });
    progressionBlocked = !progression.passed;
  }

  // 审校与润色分离：复核未应用润色 → diff 恒为「未改动」
  const polishDiff = summarizePolishDiff(prose, prose);

  let auditLog: MemoryAuditLog = {
    injectedCharacters: characters.map((c) => c.name),
    injectedSettings: settings.map((s) => s.name),
    removedClichesCount: style.removedClichésList.length,
    removedClichésList: style.removedClichésList,
    removedSublimationsCount: style.removedSublimationsCount,
    logicConflicts: [
      ...toHardConflicts(hard.issues),
      ...toStyleConflicts(style.suggestions),
    ],
    verificationScore: Math.round(hard.score * 0.55 + style.score * 0.45),
    hardReview: hard,
    // 复核未应用润色稿：polishedApplied 归 false，避免 UI 误报「已润色」
    styleReview: { ...style, polishedApplied: false },
    hardBlocked: !hard.passed,
    polishDiff,
    progressionReview: progression,
    progressionBlocked: progressionBlocked || undefined,
    progressionSummary:
      progressionBlocked && progression ? progression.summary : undefined,
  };

  // 写后规则机检（零 LLM，对当前正文复扫）——与 aiEngine.mergeRuleScanIntoAudit 同构
  const ruleScan = ruleScanProse(prose, styleConfig, {
    previousProse: options.previousProse || undefined,
    targetWordCount: options.targetWordCount || undefined,
  });
  const audit = toRuleScanAudit(ruleScan);
  const machinePhrases = ruleScanHitPhrases(ruleScan);
  const llmList = auditLog.removedClichésList || [];
  const mergedList = [...new Set([...machinePhrases, ...llmList])];
  const taste = 'aiTaste' in ruleScan ? ruleScan.aiTaste : undefined;
  auditLog = {
    ...auditLog,
    ruleScan: audit,
    ruleScanBlocked: !ruleScan.passed,
    removedClichesCount: Math.max(auditLog.removedClichesCount || 0, ruleScan.blacklistHits),
    removedClichésList: mergedList,
    removedSublimationsCount: Math.max(
      auditLog.removedSublimationsCount || 0,
      ruleScan.sublimationHits
    ),
    aiTasteTier: taste?.tier,
    aiTasteSummary: taste?.summary,
    aiTasteScore: taste?.score,
    verificationScore: ruleScan.passed
      ? Math.min(auditLog.verificationScore, Math.max(ruleScan.score, auditLog.verificationScore - 5))
      : Math.min(auditLog.verificationScore, ruleScan.score, 72),
  };
  const machineConflicts = ruleScan.hits
    .filter((h) => h.severity === 'error')
    .map((h) => ({
      type: '行文套路' as const,
      description: `[规则机检·${h.kind}] ${h.phrase}${
        h.sample && h.sample !== h.phrase ? `（例：${h.sample}）` : ''
      } ×${h.count}`,
      suggestion: h.suggestion,
    }));
  if (machineConflicts.length > 0) {
    auditLog.logicConflicts = [...(auditLog.logicConflicts || []), ...machineConflicts];
  }
  // 硬伤未过时压分并禁止虚高（同 step3_CriticVerify）
  if (!hard.passed) {
    auditLog.verificationScore = Math.min(auditLog.verificationScore, hard.score, 68);
  }
  // 推进度弱：压分至 70（低于绿通线 75），交人工
  if (progressionBlocked) {
    auditLog.verificationScore = Math.min(auditLog.verificationScore, 70);
  }

  // 确定性写后校验（同 runAuditorAgent 尾部）
  onProgress?.(' [复核] 确定性写后校验…');
  const postWriteViolations = validatePostWrite(prose, { allowEmDash });
  if (postWriteViolations.length) {
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
  }

  onProgress?.(
    ` [复核] 完成 · 综合分 ${auditLog.verificationScore ?? '—'} · 机检 ${ruleScan.passed ? '过' : '未过'}`
  );
  return { prose, auditLog, ruleScan, postWriteViolations };
}
