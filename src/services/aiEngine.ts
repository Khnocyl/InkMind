import type {
  Character,
  WorldSetting,
  PlotBeat,
  MemoryAuditLog,
  StyleConfig,
  Chapter,
  ChapterRecap,
  CharacterStatePatch,
  CharacterStatus,
  MemoryWriteLog,
  HardReviewResult,
  HardIssueType,
  StyleReviewResult,
  HardReviewIssue,
} from '../types/novel';
import { generateJSON, generateStream } from './llmClient';
import {
  buildDetailedBeatsPrompt,
  buildChapterProsePrompt,
  buildChapterExpandPrompt,
  buildHardReviewPrompt,
  buildStyleReviewPrompt,
  buildChapterRecapPrompt,
  buildConflictFixPrompt,
  buildCharacterStatusPatchPrompt,
  buildNextChapterPlanPrompt,
} from './prompts';
import type { PreviousContextPack } from './contextPack';
import { ruleScanProse, ruleScanHitPhrases, type RuleScanResult } from './ruleScan';
import type { RuleScanAudit, StoryMemory, ChapterIntent } from '../types/novel';
import { applyLocalPatches, diffProseBlocks } from './textDiff';
import { countContentWords } from './dailyWordLog';
import {
  mergeHardWithLocalGuard,
  runLocalFactGuard,
} from './factGuard';

export { evaluateRecapQuality, runLocalFactGuard } from './factGuard';

export type { PreviousContextPack, RuleScanResult };

/**
 * 定稿绿通综合分硬门槛（硬伤 55% + 文笔 45%，再经机检/recap 压分后）。
 * 低于此分：不通过、不自动锁章，状态「机检未通过」并提示重写。
 */
export const MIN_GREEN_VERIFICATION_SCORE = 75;

const DEFAULT_FIX_MAX_ROUNDS = 2;

export type FixConflictItem = {
  type?: string;
  description: string;
  suggestion?: string;
  phrase?: string;
};

export function toRuleScanAudit(result: RuleScanResult): RuleScanAudit {
  return {
    passed: result.passed,
    score: result.score,
    summary: result.summary,
    blacklistHits: result.blacklistHits,
    sublimationHits: result.sublimationHits,
    tellHits: result.tellHits,
    patternHits: result.patternHits,
    hitPhrases: ruleScanHitPhrases(result),
    hits: result.hits,
  };
}

/** API 失败时：用正文尾段 + 大纲做弱 recap，保证下一章仍有可注入文本 */
export function buildFallbackChapterRecap(
  chapter: Pick<Chapter, 'number' | 'title' | 'summary'>,
  prose: string
): ChapterRecap {
  const trimmed = prose.trim();
  const tail = trimmed.length > 280 ? trimmed.slice(-280) : trimmed;
  const outline = (chapter.summary || '').trim();
  const parts: string[] = [];
  parts.push(`第${chapter.number}章《${chapter.title}》已写毕。`);
  if (outline) parts.push(`大纲意图：${outline.slice(0, 100)}${outline.length > 100 ? '…' : ''}`);
  if (tail) parts.push(`章末现场片段：……${tail.replace(/\s+/g, ' ')}`);
  else parts.push('（正文为空，仅能依据大纲记录。）');

  return {
    text: parts.join('').slice(0, 400),
    keyFacts: outline ? [`大纲规划：${outline.slice(0, 80)}`] : [],
    endingState: tail ? `正文止于：${tail.slice(-120).replace(/\s+/g, ' ')}` : '章末状态未知（无正文）',
    openThreads: [],
    generatedAt: new Date().toISOString(),
    source: 'fallback',
  };
}

/**
 * 章末 recap 生成（连载记忆底）。
 * 在 step3 定稿后调用；失败则 fallback，不阻断主流程。
 */
export async function generateChapterRecap(
  chapter: Pick<Chapter, 'number' | 'title' | 'summary'>,
  prose: string,
  characters: Character[],
  onProgress?: (msg: string) => void
): Promise<ChapterRecap> {
  if (onProgress) onProgress(' [记忆] 正在生成章末 recap（事实/现场/伏笔）...');

  if (!prose.trim()) {
    const empty = buildFallbackChapterRecap(chapter, prose);
    if (onProgress) onProgress(' [记忆] 正文为空，已写入占位 recap。');
    return empty;
  }

  try {
    const messages = buildChapterRecapPrompt(chapter, prose, characters);
    const res = await generateJSON<{
      recap?: string;
      text?: string;
      keyFacts?: string[];
      endingState?: string;
      openThreads?: string[];
    }>(messages, 0.4);

    const text = (res.recap || res.text || '').trim();
    if (!text) {
      throw new Error('模型返回空 recap');
    }

    const recap: ChapterRecap = {
      text: text.slice(0, 500),
      keyFacts: Array.isArray(res.keyFacts)
        ? res.keyFacts.map((f) => String(f).trim()).filter(Boolean).slice(0, 10)
        : [],
      endingState: (res.endingState || '').trim().slice(0, 200),
      openThreads: Array.isArray(res.openThreads)
        ? res.openThreads.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
        : [],
      generatedAt: new Date().toISOString(),
      source: 'llm',
    };

    if (onProgress) {
      onProgress(
        ` [记忆] 章末 recap 已生成（${recap.text.length} 字，事实 ${recap.keyFacts.length} 条）。`
      );
    }
    return recap;
  } catch (err: any) {
    if (onProgress) {
      onProgress(` [记忆警告] recap 生成失败，使用启发式摘要：${err.message || err}`);
    }
    return buildFallbackChapterRecap(chapter, prose);
  }
}

// 步骤 1：分镜头与细纲生成 (Beat Planner) — 调用真实 LLM API
export async function step1_GenerateBeats(
  chapterSummary: string,
  characters: Character[],
  settings: WorldSetting[],
  onProgress?: (msg: string) => void,
  previousContext?: string,
  storyMemoryBlock?: string,
  chapterIntentBlock?: string,
  genrePackBlock?: string
): Promise<PlotBeat[]> {
  if (onProgress) {
    onProgress(
      previousContext?.trim() || storyMemoryBlock?.trim() || chapterIntentBlock?.trim()
        ? ' [Step 1/3] 已装载题材/意图/前情/记忆，正在拆解分镜...'
        : ' [Step 1/3] 正在调用大模型分析剧情，拆解细粒度分镜要点与感官视角...'
    );
  }

  try {
    const messages = buildDetailedBeatsPrompt(
      chapterSummary,
      characters,
      settings,
      previousContext,
      storyMemoryBlock,
      chapterIntentBlock,
      genrePackBlock
    );

    const res = await generateJSON<{
      beats: { order: number; description: string; focusSense?: string }[];
    }>(messages, 0.7);

    if (onProgress) onProgress(` [Step 1/3] 细纲拆分成功，共构思 ${res.beats?.length || 0} 个核心表现镜头。`);

    return (res.beats || []).map((b, idx) => ({
      id: `beat-${Date.now()}-${idx + 1}`,
      order: b.order || idx + 1,
      description: b.description,
      focusSense: b.focusSense || '微细动作与物理空间反馈',
    }));
  } catch (err: any) {
    if (onProgress) onProgress(` [错误] 拆分细纲遇到报错: ${err.message}`);
    throw err;
  }
}

export interface Step2ExpandProseOptions {
  /** 真实章节元数据（序号/标题），用于 Prompt；缺省则用临时章 */
  chapter?: Pick<Chapter, 'number' | 'title' | 'summary' | 'volumeId' | 'volumeNumber' | 'involvedCharacterIds' | 'involvedSettingIds'>;
  /** 上章前情注入文本 */
  previousContext?: string;
  /** 前情包元数据（写入进度文案） */
  previousContextPack?: PreviousContextPack | null;
  /** 书级权威记忆块 */
  storyMemoryBlock?: string;
  /** 写前意图块 */
  chapterIntentBlock?: string;
  /** 题材规则包 */
  genrePackBlock?: string;
  /** 目标字数 */
  targetWordCount?: number | null;
  /** 上章正文（开篇同质机检） */
  previousProse?: string | null;
  /**
   * 字数不足时自动续写轮数，默认 2。
   * 0 = 关闭补写（仅提示）。
   */
  wordCountExpandRounds?: number;
  /** 最低达标比例，默认 0.9（目标的 90%） */
  wordCountMinRatio?: number;
}

export interface WordCountGate {
  target: number;
  min: number;
  current: number;
  met: boolean;
  expandRounds: number;
}

/** 去空白字数（与日更账本一致） */
export function countProseWords(prose: string): number {
  return countContentWords(prose);
}

/**
 * 字数不足则续写加厚，最多 maxRounds 轮。
 * 返回拼接后的全文与达标信息。
 */
export async function ensureProseWordCount(options: {
  prose: string;
  targetWordCount: number;
  chapter: Pick<Chapter, 'number' | 'title' | 'summary'>;
  beats?: PlotBeat[];
  characters?: Character[];
  styleConfig?: StyleConfig;
  chapterIntentBlock?: string;
  minRatio?: number;
  maxRounds?: number;
  onStream?: (chunk: string) => void;
  onProgress?: (msg: string) => void;
}): Promise<{ prose: string; gate: WordCountGate }> {
  const target = Math.max(0, Math.round(options.targetWordCount || 0));
  const minRatio = options.minRatio ?? 0.9;
  const maxRounds = options.maxRounds ?? 2;
  const min = target > 0 ? Math.round(target * minRatio) : 0;

  let prose = (options.prose || '').trim();
  let current = countProseWords(prose);
  let expandRounds = 0;

  if (target <= 0 || min <= 0) {
    return {
      prose,
      gate: { target, min, current, met: true, expandRounds: 0 },
    };
  }

  const blacklist = [
    ...(options.styleConfig?.clicheBlacklist || []),
    ...(options.styleConfig?.customBlacklist || []),
  ];

  while (current < min && expandRounds < maxRounds) {
    const needMore = Math.max(400, min - current + 80);
    expandRounds += 1;
    options.onProgress?.(
      ` [字数补写 ${expandRounds}/${maxRounds}] 当前 ${current} · 最低 ${min}（目标 ${target}）· 续写约 ${needMore} 字…`
    );

    const messages = buildChapterExpandPrompt({
      chapter: options.chapter,
      existingProse: prose,
      currentWords: current,
      targetWordCount: target,
      minWordCount: min,
      needMore,
      beats: options.beats,
      characters: options.characters,
      styleConfig: options.styleConfig,
      chapterIntentBlock: options.chapterIntentBlock,
      blacklist,
    });

    try {
      // 续写块单独缓冲，再拼到全文，避免 onStream 把「仅续写」当成覆盖全文
      let expandBuf = '';
      const expansion = await generateStream(
        messages,
        0.75,
        (chunk) => {
          expandBuf += chunk;
          if (options.onStream) {
            options.onStream(prose + (prose.endsWith('\n') ? '' : '\n') + expandBuf);
          }
        },
        (msg) => options.onProgress?.(` [字数补写] ${msg}`)
      );
      const add = (expansion || expandBuf || '').trim();
      if (!add || add.length < 40) {
        options.onProgress?.(
          ` [字数补写] 第 ${expandRounds} 轮几乎无输出，停止补写`
        );
        break;
      }
      // 若模型误回了全文，取比原文更长的部分或直接用新稿
      if (add.length > prose.length * 0.85 && add.includes(prose.slice(0, 80))) {
        prose = add;
      } else {
        prose = `${prose.trim()}\n\n${add}`.trim();
      }
      current = countProseWords(prose);
      options.onProgress?.(
        ` [字数补写] 第 ${expandRounds} 轮后 ${current}/${target} 字（最低 ${min}）`
      );
    } catch (err: any) {
      options.onProgress?.(
        ` [字数补写] 第 ${expandRounds} 轮失败：${err?.message || err}`
      );
      break;
    }
  }

  return {
    prose,
    gate: {
      target,
      min,
      current,
      met: current >= min,
      expandRounds,
    },
  };
}

// 步骤 2：细粒度正文流式执笔 (Show Don't Tell Writer) — 调用真实 LLM API SSE 流式输出
export async function step2_ExpandProse(
  beats: PlotBeat[],
  characters: Character[],
  settings: WorldSetting[],
  styleConfig: StyleConfig,
  onStream?: (chunk: string) => void,
  onProgress?: (msg: string) => void,
  options?: Step2ExpandProseOptions
): Promise<{
  rawProse: string;
  removedClichés: string[];
  ruleScan?: RuleScanResult;
  wordCountGate?: WordCountGate;
}> {
  const previousContext = options?.previousContext;
  const pack = options?.previousContextPack;
  const targetWordCount =
    options?.targetWordCount && options.targetWordCount > 0
      ? Math.round(options.targetWordCount)
      : 0;

  if (onProgress) {
    const memHint = options?.storyMemoryBlock?.trim() ? ' + 书级记忆' : '';
    const wordHint = targetWordCount > 0 ? ` · 目标 ${targetWordCount} 字` : '';
    if (pack && !pack.isFirstChapter) {
      onProgress(
        ` [Step 2/3] 已注入前情${memHint}${wordHint}：${pack.preview}。流式执笔中...`
      );
    } else {
      onProgress(
        ` [Step 2/3] 启动正文流式执笔${memHint}${wordHint}：Show Don't Tell + 黑名单 + 反升华...`
      );
    }
  }

  const selectedExample = styleConfig.fewShotExamples?.find((e) => e.id === styleConfig.selectedExampleId);
  const styleTitle = selectedExample ? selectedExample.title : '默认品质克制风';
  if (onProgress) onProgress(` [Step 2/3] 正在参照范例风格【${styleTitle}】实时撰写中...`);

  const meta = options?.chapter;
  const tempChapter: Chapter = {
    id: `temp-${Date.now()}`,
    number: meta?.number ?? 1,
    title: meta?.title ?? '章节正文创作',
    summary: meta?.summary ?? beats.map((b) => b.description).join(' '),
    wordCount: 0,
    status: '细纲就绪',
    content: '',
    volumeId: meta?.volumeId ?? '',
    volumeNumber: meta?.volumeNumber ?? 1,
    involvedCharacterIds: meta?.involvedCharacterIds ?? characters.map((c) => c.id),
    involvedSettingIds: meta?.involvedSettingIds ?? settings.map((s) => s.id),
    beats,
    lastModified: '',
  };

  const messages = buildChapterProsePrompt(
    tempChapter,
    beats,
    characters,
    settings,
    styleConfig,
    previousContext,
    options?.storyMemoryBlock,
    options?.chapterIntentBlock,
    options?.genrePackBlock,
    targetWordCount || options?.targetWordCount
  );

  try {
    let rawProse = await generateStream(messages, 0.8, onStream, (msg) => {
      if (onProgress) onProgress(` [Step 2/3] ${msg}`);
    });

    let wordCountGate: WordCountGate | undefined;
    const expandRounds = options?.wordCountExpandRounds;
    if (targetWordCount > 0 && expandRounds !== 0) {
      const ensured = await ensureProseWordCount({
        prose: rawProse,
        targetWordCount,
        chapter: {
          number: tempChapter.number,
          title: tempChapter.title,
          summary: tempChapter.summary,
        },
        beats,
        characters,
        styleConfig,
        chapterIntentBlock: options?.chapterIntentBlock,
        minRatio: options?.wordCountMinRatio ?? 0.9,
        maxRounds: expandRounds ?? 2,
        onStream,
        onProgress,
      });
      rawProse = ensured.prose;
      wordCountGate = ensured.gate;
      if (!ensured.gate.met) {
        onProgress?.(
          ` [字数警告] 补写后仍不足：${ensured.gate.current}/${ensured.gate.target}（最低 ${ensured.gate.min}）。可再手动扩写或提高模型输出长度。`
        );
      } else if (ensured.gate.expandRounds > 0) {
        onProgress?.(
          ` [字数达标] ${ensured.gate.current} 字 ≥ 最低 ${ensured.gate.min}（目标 ${ensured.gate.target}，补写 ${ensured.gate.expandRounds} 轮）`
        );
      }
    }

    // 写后即时机检（仅报告，不阻断流式；终检在 step3 后）
    const earlyScan = ruleScanProse(rawProse, styleConfig, {
      previousProse: options?.previousProse,
      targetWordCount: targetWordCount || undefined,
    });
    const removedClichés = ruleScanHitPhrases(earlyScan).filter((p) =>
      earlyScan.hits.some((h) => h.kind === 'blacklist' && (p === h.phrase || p.startsWith(h.phrase)))
    );
    // 若黑名单为空列表但有其它命中，仍用 hit 短语展示
    const hitList =
      removedClichés.length > 0
        ? removedClichés
        : earlyScan.hits.filter((h) => h.severity === 'error').map((h) => h.phrase);

    const words = countProseWords(rawProse);
    if (onProgress) {
      onProgress(
        ` [Step 2/3] 正文执笔完毕 · ${words} 字${
          targetWordCount ? ` / 目标 ${targetWordCount}` : ''
        }。机检：${earlyScan.summary}`
      );
    }
    return { rawProse, removedClichés: hitList, ruleScan: earlyScan, wordCountGate };
  } catch (err: any) {
    if (onProgress) onProgress(` [错误] 执笔发生异常: ${err.message}`);
    throw err;
  }
}

function mergeRuleScanIntoAudit(
  auditLog: MemoryAuditLog,
  styleConfig: StyleConfig,
  polishedProse: string,
  previousProse?: string | null,
  targetWordCount?: number | null
): { auditLog: MemoryAuditLog; ruleScan: RuleScanResult } {
  // 对润色后正文复扫（含 AI 味扩展 B/D/G + 开篇同质 + 字数）
  const ruleScan = ruleScanProse(polishedProse, styleConfig, {
    previousProse: previousProse || undefined,
    targetWordCount: targetWordCount || undefined,
  });
  const audit = toRuleScanAudit(ruleScan);

  // 机检命中并入「套话列表」，以机检为准（可复现）
  const machinePhrases = ruleScanHitPhrases(ruleScan);
  const llmList = auditLog.removedClichésList || [];
  const mergedList = [...new Set([...machinePhrases, ...llmList])];
  const taste = 'aiTaste' in ruleScan ? ruleScan.aiTaste : undefined;

  const next: MemoryAuditLog = {
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
    // 机检不通过时压低综合分，避免虚高「完美」
    verificationScore: ruleScan.passed
      ? Math.min(auditLog.verificationScore, Math.max(ruleScan.score, auditLog.verificationScore - 5))
      : Math.min(auditLog.verificationScore, ruleScan.score, 72),
  };

  // 将 error 级机检写入 logicConflicts，便于 UI 统一展示
  const machineConflicts = ruleScan.hits
    .filter((h) => h.severity === 'error')
    .map((h) => ({
      type: '行文套路' as const,
      description: `[规则机检·${h.kind}] ${h.phrase}${h.sample && h.sample !== h.phrase ? `（例：${h.sample}）` : ''} ×${h.count}`,
      suggestion: h.suggestion,
    }));

  if (machineConflicts.length > 0) {
    next.logicConflicts = [...(next.logicConflicts || []), ...machineConflicts];
  }

  return { auditLog: next, ruleScan };
}

const HARD_TYPES: HardIssueType[] = [
  '状态冲突',
  '战力越界',
  '时间线错乱',
  '吃书矛盾',
  '道具归属',
  '人称混乱',
  '其他硬伤',
];

function normalizeHardType(raw: unknown): HardIssueType {
  const s = String(raw || '');
  if (HARD_TYPES.includes(s as HardIssueType)) return s as HardIssueType;
  if (s.includes('战力')) return '战力越界';
  if (s.includes('状态')) return '状态冲突';
  if (s.includes('时间')) return '时间线错乱';
  if (s.includes('吃书') || s.includes('设定')) return '吃书矛盾';
  if (s.includes('道具') || s.includes('物品')) return '道具归属';
  if (s.includes('人称') || s.includes('视角')) return '人称混乱';
  return '其他硬伤';
}

/** 阶段 A：硬伤审 */
export async function runHardReview(
  prose: string,
  characters: Character[],
  settings: WorldSetting[],
  onProgress?: (msg: string) => void,
  extras?: {
    previousContext?: string;
    storyMemoryBlock?: string;
    chapterIntentBlock?: string;
    /** 本地断言：书级记忆 / 意图 / 本章角色 */
    storyMemory?: StoryMemory | null;
    chapterIntent?: ChapterIntent | null;
    involvedCharacterIds?: string[];
    chapterNumber?: number;
    /** 默认 true：合并本地事实断言 */
    runLocalGuard?: boolean;
  }
): Promise<HardReviewResult> {
  onProgress?.(' [Step 3A] 硬伤审：吃书 / 战力 / 时间线 / 道具 / 人称...');

  const applyLocal = (hard: HardReviewResult): HardReviewResult => {
    if (extras?.runLocalGuard === false) return hard;
    const local = runLocalFactGuard({
      prose,
      characters,
      storyMemory: extras?.storyMemory,
      chapterIntent: extras?.chapterIntent,
      involvedCharacterIds: extras?.involvedCharacterIds,
      chapterNumber: extras?.chapterNumber,
    });
    if (!local.issues.length && local.passed) {
      onProgress?.(
        hard.passed
          ? ` [Step 3A+] 本地断言通过`
          : ` [Step 3A+] 本地断言通过（硬伤仍未过）`
      );
      return hard;
    }
    const merged = mergeHardWithLocalGuard(hard, local);
    onProgress?.(
      merged.passed
        ? ` [Step 3A+] 本地断言：${local.summary}`
        : ` [Step 3A+] 本地断言未过：${local.summary}`
    );
    return {
      passed: merged.passed,
      score: merged.score,
      summary: merged.summary,
      issues: merged.issues,
      source: merged.source,
    };
  };

  try {
    const messages = buildHardReviewPrompt(prose, characters, settings, extras);
    const res = await generateJSON<{
      hardScore?: number;
      hardPassed?: boolean;
      summary?: string;
      issues?: {
        type?: string;
        severity?: string;
        description?: string;
        suggestion?: string;
      }[];
    }>(messages, 0.35);

    const issues: HardReviewIssue[] = (res.issues || [])
      .map((i) => ({
        type: normalizeHardType(i.type),
        severity: i.severity === 'warn' ? ('warn' as const) : ('error' as const),
        description: String(i.description || '').trim(),
        suggestion: String(i.suggestion || '').trim() || '请改写至自洽',
      }))
      .filter((i) => i.description.length > 0)
      .slice(0, 12);

    const errorCount = issues.filter((i) => i.severity === 'error').length;
    const passed =
      typeof res.hardPassed === 'boolean' ? res.hardPassed && errorCount === 0 : errorCount === 0;
    let score =
      typeof res.hardScore === 'number' && Number.isFinite(res.hardScore)
        ? Math.max(0, Math.min(100, res.hardScore))
        : passed
          ? 92
          : Math.max(20, 75 - errorCount * 15);

    if (!passed) score = Math.min(score, 70);

    const summary =
      (res.summary || '').trim() ||
      (passed ? '硬伤审通过，未发现阻断级矛盾' : `发现 ${errorCount} 处硬伤 error`);

    onProgress?.(
      passed
        ? ` [Step 3A] 硬伤通过（${score}分）`
        : ` [Step 3A] 硬伤未过：${summary}（${errorCount} error）`
    );

    return applyLocal({ passed, score, summary, issues, source: 'llm' });
  } catch (err: any) {
    const msg = err?.message || String(err);
    // 防幻觉：API 失败默认阻断，不再放行绿通
    onProgress?.(
      ` [Step 3A] 硬伤审失败，已阻断定稿（防幻觉漏检）：${msg}`
    );
    const blocked: HardReviewResult = {
      passed: false,
      score: 35,
      summary: '硬伤审 API 失败，已阻断自动定稿',
      issues: [
        {
          type: '其他硬伤',
          severity: 'error',
          description: `硬伤审调用失败：${msg.slice(0, 160)}。为防止幻觉漏检，本章不自动绿通。`,
          suggestion: '检查 LLM/网络配置后重跑本章闭环，或人工通读确认后手动锁定。',
        },
      ],
      source: 'fallback',
    };
    // API 挂了仍跑本地断言，能抓阵亡/钉死事实硬伤
    return applyLocal(blocked);
  }
}

/** 阶段 B：文笔审 + 可选润色 */
export async function runStyleReview(
  prose: string,
  characters: Character[],
  styleConfig: StyleConfig,
  onProgress?: (msg: string) => void
): Promise<{ style: StyleReviewResult; polishedProse: string }> {
  onProgress?.(' [Step 3B] 文笔审：去 AI 味 / 禁升华 / 润色建议...');
  try {
    const messages = buildStyleReviewPrompt(prose, styleConfig, characters);
    const res = await generateJSON<{
      styleScore?: number;
      summary?: string;
      suggestions?: string[];
      removedClichésList?: string[];
      removedSublimationsCount?: number;
      polishedProse?: string;
    }>(messages, 0.55);

    const polished = (res.polishedProse || '').trim() || prose;
    const list = Array.isArray(res.removedClichésList)
      ? res.removedClichésList.map(String).filter(Boolean).slice(0, 20)
      : [];
    const suggestions = Array.isArray(res.suggestions)
      ? res.suggestions.map(String).filter(Boolean).slice(0, 6)
      : [];
    const score =
      typeof res.styleScore === 'number' && Number.isFinite(res.styleScore)
        ? Math.max(0, Math.min(100, res.styleScore))
        : 80;

    const style: StyleReviewResult = {
      score,
      summary: (res.summary || '').trim() || (list.length ? `检出套话 ${list.length} 类` : '文笔可接受'),
      suggestions,
      removedClichésList: list,
      removedSublimationsCount: res.removedSublimationsCount ?? 0,
      polishedApplied: polished !== prose,
      source: 'llm',
    };

    onProgress?.(
      ` [Step 3B] 文笔分 ${score} · 建议 ${suggestions.length} 条 · ${
        style.polishedApplied ? '已出润色稿' : '正文几乎未改'
      }`
    );
    return { style, polishedProse: polished };
  } catch (err: any) {
    onProgress?.(` [Step 3B 警告] 文笔审失败，保留原文：${err?.message || err}`);
    return {
      style: {
        score: 72,
        summary: '文笔审 API 失败，未润色',
        suggestions: [],
        removedClichésList: [],
        removedSublimationsCount: 0,
        polishedApplied: false,
        source: 'fallback',
      },
      polishedProse: prose,
    };
  }
}

function hardIssuesToConflicts(
  issues: HardReviewIssue[]
): MemoryAuditLog['logicConflicts'] {
  return issues.map((i) => ({
    type: i.type as MemoryAuditLog['logicConflicts'][0]['type'],
    description: i.description,
    suggestion: i.suggestion,
    lane: 'hard' as const,
  }));
}

/**
 * 步骤 3：双阶段审校
 * A 硬伤审（阻断定稿）→ B 文笔审（润色+建议）→ 规则机检（黑名单等硬门）
 * 绿通条件：hardPassed && ruleScan.passed && 综合分 ≥ MIN_GREEN_VERIFICATION_SCORE
 */
export async function step3_CriticVerify(
  prose: string,
  characters: Character[],
  settings: WorldSetting[],
  styleConfig: StyleConfig,
  onProgress?: (msg: string) => void,
  contextMeta?: {
    previousContextPack?: PreviousContextPack | null;
    previousContext?: string;
    storyMemoryBlock?: string;
    chapterIntentBlock?: string;
    storyMemory?: StoryMemory | null;
    chapterIntent?: ChapterIntent | null;
    involvedCharacterIds?: string[];
    chapterNumber?: number;
    /** 上章正文，供开篇同质机检 */
    previousProse?: string | null;
    /** 本章字数目标（机检 length） */
    targetWordCount?: number | null;
  }
): Promise<{ polishedProse: string; auditLog: MemoryAuditLog; ruleScan: RuleScanResult }> {
  const pack = contextMeta?.previousContextPack;
  const previousContextSource = pack
    ? pack.isFirstChapter
      ? '开篇章·无上章'
      : pack.preview
    : undefined;

  onProgress?.(' [Step 3] 双阶段审校：硬伤+本地断言 → 文笔 → 规则机检...');

  const hard = await runHardReview(prose, characters, settings, onProgress, {
    previousContext: contextMeta?.previousContext || pack?.text,
    storyMemoryBlock: contextMeta?.storyMemoryBlock,
    chapterIntentBlock: contextMeta?.chapterIntentBlock,
    storyMemory: contextMeta?.storyMemory,
    chapterIntent: contextMeta?.chapterIntent,
    involvedCharacterIds: contextMeta?.involvedCharacterIds,
    chapterNumber: contextMeta?.chapterNumber,
  });

  const { style, polishedProse } = await runStyleReview(
    prose,
    characters,
    styleConfig,
    onProgress
  );

  const hardConflicts = hardIssuesToConflicts(hard.issues);
  const styleSoftConflicts: MemoryAuditLog['logicConflicts'] = (style.suggestions || [])
    .slice(0, 4)
    .map((s) => ({
      type: '行文套路' as const,
      description: `[文笔建议] ${s}`,
      suggestion: '可在画布划线精修或接受润色稿；不阻断定稿',
      lane: 'style' as const,
    }));

  let auditLog: MemoryAuditLog = {
    injectedCharacters: characters.map((c) => c.name),
    injectedSettings: settings.map((s) => s.name),
    injectedPreviousContext: !!pack && !pack.isFirstChapter,
    previousContextSource,
    removedClichesCount: style.removedClichésList.length,
    removedClichésList: style.removedClichésList,
    removedSublimationsCount: style.removedSublimationsCount,
    logicConflicts: [...hardConflicts, ...styleSoftConflicts],
    verificationScore: Math.round(hard.score * 0.55 + style.score * 0.45),
    hardReview: hard,
    styleReview: style,
    hardBlocked: !hard.passed,
  };

  onProgress?.(
    ' [Step 3C] 润色后复扫：黑名单 / 升华 / SdT / 句式·节奏·解释腔 / 开篇同质...'
  );
  const merged = mergeRuleScanIntoAudit(
    auditLog,
    styleConfig,
    polishedProse,
    contextMeta?.previousProse,
    contextMeta?.targetWordCount
  );
  auditLog = merged.auditLog;
  auditLog.hardReview = hard;
  auditLog.styleReview = style;
  auditLog.hardBlocked = !hard.passed;

  // 硬伤未过时压分并禁止虚高
  if (!hard.passed) {
    auditLog.verificationScore = Math.min(auditLog.verificationScore, hard.score, 68);
  }

  const scoreOk =
    (auditLog.verificationScore ?? 0) >= MIN_GREEN_VERIFICATION_SCORE;
  const greenOk = hard.passed && merged.ruleScan.passed && scoreOk;
  if (onProgress) {
    const tasteHint = auditLog.aiTasteTier
      ? ` · AI味${auditLog.aiTasteTier}`
      : '';
    if (!greenOk) {
      const parts: string[] = [];
      if (!hard.passed) parts.push(`硬伤：${hard.summary}`);
      if (!merged.ruleScan.passed) parts.push(`机检：${merged.ruleScan.summary}`);
      if (!scoreOk) {
        parts.push(
          `综合分 ${auditLog.verificationScore}<${MIN_GREEN_VERIFICATION_SCORE}（需重写）`
        );
      }
      onProgress(
        ` [Step 3] 未绿通 — ${parts.join('； ')} · 综合 ${auditLog.verificationScore}${tasteHint}`
      );
    } else {
      onProgress(
        ` [Step 3] 双阶段通过 · 硬伤 ${hard.score} / 文笔 ${style.score} · 综合 ${auditLog.verificationScore}≥${MIN_GREEN_VERIFICATION_SCORE}${tasteHint}`
      );
    }
  }

  return { polishedProse, auditLog, ruleScan: merged.ruleScan };
}

/** 定稿绿通：硬伤通过 + 规则机检通过 + 综合分 ≥ 门槛（缺 hardReview / API 阻断均不绿） */
export function isDualReviewGreen(
  ruleScan: RuleScanResult,
  auditLog: MemoryAuditLog
): boolean {
  if (!ruleScan.passed) return false;
  if (auditLog.recapQualityBlocked) return false;
  if (auditLog.hardBlocked === true) return false;
  const hard = auditLog.hardReview;
  // 未跑硬伤审 → 不绿通（防漏检）
  if (!hard) return false;
  if (!hard.passed) return false;
  // API 失败阻断标记
  if (hard.source === 'fallback' && !hard.passed) return false;
  // 综合分硬门槛：低于 75 不予通过，需重写
  const score = auditLog.verificationScore ?? 0;
  if (score < MIN_GREEN_VERIFICATION_SCORE) return false;
  return true;
}

/** 综合分是否达到绿通门槛 */
export function isVerificationScoreGreen(
  score: number | null | undefined
): boolean {
  return (score ?? 0) >= MIN_GREEN_VERIFICATION_SCORE;
}

/** 纯 API 失败阻断：修复环无法解决，应跳过无意义的改写 */
export function isHardReviewApiBlock(hard?: HardReviewResult | null): boolean {
  if (!hard || hard.passed) return false;
  if (hard.source !== 'fallback') return false;
  // 仅有 API 失败类 issue（本地断言 error 仍可尝试修）
  const nonApi = (hard.issues || []).filter(
    (i) => !i.description.includes('硬伤审调用失败') && !i.description.startsWith('[本地断言]')
  );
  const localErrors = (hard.issues || []).filter(
    (i) => i.description.startsWith('[本地断言]') && i.severity === 'error'
  );
  return nonApi.length === 0 && localErrors.length === 0;
}

// 步骤 0：下一章大纲自动推导（真 LLM；失败则启发式）
export async function step0_AutoPlanNextChapter(
  chapterNumber: number,
  pastChapters: Chapter[],
  characters: Character[],
  settings: WorldSetting[],
  onProgress?: (msg: string) => void,
  bookTitle?: string
): Promise<{ title: string; summary: string; involvedCharacterIds: string[]; involvedSettingIds: string[] }> {
  if (onProgress) onProgress(` [规划] 分析前情，构思第 ${chapterNumber} 章大纲...`);

  const fallback = () => {
    const lastChapter = [...pastChapters].sort((a, b) => a.number - b.number).pop();
    const title = `第 ${chapterNumber} 章 ${lastChapter ? '余波与变局' : '初探风云'}`;
    const summary = lastChapter
      ? `承接《${lastChapter.title}》后的余波：${(lastChapter.recap?.endingState || lastChapter.summary || '').slice(0, 80)}。主角推进核心矛盾并埋下新钩子。`
      : `开章揭示主角当前险境与金手指契机，建立主线冲突。`;
    return {
      title,
      summary,
      involvedCharacterIds: characters.slice(0, 2).map((c) => c.id),
      involvedSettingIds: settings.slice(0, 2).map((s) => s.id),
    };
  };

  try {
    const messages = buildNextChapterPlanPrompt(
      chapterNumber,
      pastChapters,
      characters,
      settings,
      bookTitle
    );
    const res = await generateJSON<{
      title?: string;
      summary?: string;
      involvedCharacterNames?: string[];
      involvedSettingNames?: string[];
    }>(messages, 0.65);

    const title = (res.title || `第 ${chapterNumber} 章`).trim();
    const summary = (res.summary || '').trim();
    if (!summary || summary.length < 20) {
      throw new Error('规划梗概过短');
    }

    const nameToChar = new Map(characters.map((c) => [c.name, c.id]));
    const nameToSet = new Map(settings.map((s) => [s.name, s.id]));
    const involvedCharacterIds = (res.involvedCharacterNames || [])
      .map((n) => nameToChar.get(n))
      .filter((id): id is string => !!id);
    const involvedSettingIds = (res.involvedSettingNames || [])
      .map((n) => nameToSet.get(n))
      .filter((id): id is string => !!id);

    if (onProgress) onProgress(` [规划] 第 ${chapterNumber} 章大纲就绪：《${title}》`);

    return {
      title: title.includes('第') ? title : `第 ${chapterNumber} 章 ${title}`,
      summary,
      involvedCharacterIds:
        involvedCharacterIds.length > 0
          ? involvedCharacterIds
          : characters.slice(0, 2).map((c) => c.id),
      involvedSettingIds:
        involvedSettingIds.length > 0
          ? involvedSettingIds
          : settings.slice(0, 2).map((s) => s.id),
    };
  } catch (err: any) {
    if (onProgress) onProgress(` [规划警告] LLM 规划失败，使用启发式：${err.message || err}`);
    return fallback();
  }
}

/**
 * 从机检 + LLM 冲突列表构建本轮「必须修复」清单。
 * 机检 error 每轮都带；LLM 非机检冲突仅第 1 轮带入（避免无法复检的软冲突死循环）。
 */
export function collectFixConflicts(
  ruleScan: RuleScanResult,
  logicConflicts: MemoryAuditLog['logicConflicts'] = [],
  round = 1
): FixConflictItem[] {
  const items: FixConflictItem[] = [];

  for (const h of ruleScan.hits.filter((x) => x.severity === 'error')) {
    items.push({
      type: `规则机检·${h.kind}`,
      description: `正文命中禁用项「${h.phrase}」共 ${h.count} 次${h.sample ? `，例：${h.sample}` : ''}`,
      suggestion: h.suggestion,
      phrase: h.phrase,
    });
  }

  if (round === 1) {
    for (const c of logicConflicts) {
      if (c.description?.startsWith('[规则机检')) continue;
      // 跳过纯文笔软建议；硬伤与未标 lane 的旧冲突进入修复
      if (c.lane === 'style' || c.description?.startsWith('[文笔建议]')) continue;
      items.push({
        type: c.type,
        description: c.description,
        suggestion: c.suggestion,
      });
    }
  }

  const seen = new Set<string>();
  return items.filter((it) => {
    const key = `${it.type}|${it.description}|${it.phrase || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 是否进入修复环：规则机检失败，或存在硬伤 error（文笔建议不触发） */
export function needsConflictFix(
  ruleScan: RuleScanResult,
  logicConflicts: MemoryAuditLog['logicConflicts'] = [],
  hardReview?: HardReviewResult | null
): boolean {
  // 硬伤 API 整段失败且无本地可修 error → 不进修复环（改写解决不了 API）
  if (isHardReviewApiBlock(hardReview)) return !ruleScan.passed;
  if (!ruleScan.passed) return true;
  if (hardReview && !hardReview.passed) return true;
  const serious = (logicConflicts || []).filter((c) => {
    if (c.description?.startsWith('[规则机检')) return false;
    if (c.lane === 'style' || c.description?.startsWith('[文笔建议]')) return false;
    if (c.description?.includes('硬伤审调用失败')) return false;
    if (c.lane === 'hard') return true;
    return (
      c.type === '状态冲突' ||
      c.type === '战力越界' ||
      c.type === '时间线错乱' ||
      c.type === '吃书矛盾' ||
      c.type === '道具归属' ||
      c.type === '人称混乱'
    );
  });
  return serious.length > 0;
}

export interface Step4FixResult {
  fixedProse: string;
  fixedCount: number;
  changesSummary: string[];
  localPatchesApplied: number;
  /** 相对输入 prose 的 diff */
  diff: ReturnType<typeof diffProseBlocks>;
  mode: 'local' | 'full' | 'none' | 'failed';
}

// 步骤 4：单轮冲突修复 —— 优先 localPatches，否则全文 fixedProse
export async function step4_AutoRefineAndFix(
  prose: string,
  conflicts: FixConflictItem[] | MemoryAuditLog['logicConflicts'],
  styleConfig?: StyleConfig,
  characters: Character[] = [],
  settings: WorldSetting[] = [],
  onProgress?: (msg: string) => void
): Promise<Step4FixResult> {
  const list = (conflicts || []) as FixConflictItem[];
  const emptyDiff = diffProseBlocks(prose, prose);
  if (onProgress) {
    onProgress(` [Step 4 修复] ${list.length} 处冲突，优先局部补丁...`);
  }

  if (list.length === 0) {
    return {
      fixedProse: prose,
      fixedCount: 0,
      changesSummary: [],
      localPatchesApplied: 0,
      diff: emptyDiff,
      mode: 'none',
    };
  }

  const style: StyleConfig = styleConfig || {
    clicheBlacklist: [],
    customBlacklist: [],
    fewShotExamples: [],
    selectedExampleId: '',
    enforceShowDontTell: true,
    forbidEndingSublimation: true,
  };

  try {
    const messages = buildConflictFixPrompt(prose, list, style, characters, settings);
    const res = await generateJSON<{
      fixedProse?: string;
      polishedProse?: string;
      changesSummary?: string[];
      localPatches?: { before?: string; after?: string }[];
    }>(messages, 0.45);

    const changesSummary = Array.isArray(res.changesSummary)
      ? res.changesSummary.map(String).filter(Boolean)
      : [];

    let fixedProse = '';
    let localPatchesApplied = 0;
    let mode: Step4FixResult['mode'] = 'none';

    const full = (res.fixedProse || res.polishedProse || '').trim();
    const patches = Array.isArray(res.localPatches) ? res.localPatches : [];

    // 优先：有完整稿且长度合理 → 全文
    if (full && full.length >= Math.min(80, prose.trim().length * 0.3)) {
      fixedProse = full;
      mode = 'full';
      // 仍尝试统计 patches 信息供展示
      if (patches.length) {
        const trial = applyLocalPatches(prose, patches);
        localPatchesApplied = trial.applied;
        if (trial.failed > 0 && onProgress) {
          const first = trial.failedDetails[0];
          onProgress(
            ` [Step 4] 全文修复已生效；${trial.failed} 条局部补丁未命中（${first?.reason === 'not_found' ? '原文片段不存在' : '空片段'}${first?.before ? `："${first.before.slice(0, 30)}…"` : ''}）`
          );
        }
      }
    } else if (patches.length > 0) {
      const applied = applyLocalPatches(prose, patches);
      if (applied.applied > 0 && applied.text.trim().length >= Math.min(40, prose.trim().length * 0.2)) {
        fixedProse = applied.text;
        localPatchesApplied = applied.applied;
        mode = 'local';
        if (onProgress) {
          const failNote =
            applied.failed > 0
              ? `，失败 ${applied.failed} 条` +
                (applied.failedDetails[0]?.before
                  ? `（示例：找不到 "${applied.failedDetails[0].before.slice(0, 24)}…"）`
                  : '（含空片段）')
              : '';
          onProgress(` [Step 4] 局部补丁成功 ${applied.applied} 条${failNote}`);
        }
      }
    }

    if (!fixedProse) {
      throw new Error('修复结果无效：无可用全文且局部补丁未命中');
    }

    const diff = diffProseBlocks(prose, fixedProse);
    if (onProgress) {
      onProgress(
        ` [Step 4 修复] ${mode === 'local' ? '局部' : '全文'}完成 · ${diff.summary}` +
          (changesSummary.length ? ` · ${changesSummary.slice(0, 2).join('；')}` : '')
      );
    }

    return {
      fixedProse,
      fixedCount: list.length,
      changesSummary,
      localPatchesApplied,
      diff,
      mode,
    };
  } catch (err: any) {
    if (onProgress) onProgress(` [Step 4 修复失败] ${err.message || err}，保留原文。`);
    return {
      fixedProse: prose,
      fixedCount: 0,
      changesSummary: [`修复调用失败: ${err.message || err}`],
      localPatchesApplied: 0,
      diff: emptyDiff,
      mode: 'failed',
    };
  }
}

export interface ConflictFixLoopResult {
  prose: string;
  auditLog: MemoryAuditLog;
  ruleScan: RuleScanResult;
  fixRounds: number;
  resolved: boolean;
  history: NonNullable<MemoryAuditLog['fixHistory']>;
}

/**
 * 冲突修复环：最多 maxRounds 轮。
 * 每轮：收集冲突 → LLM 改写 → 规则机检回写 audit。
 * 仍失败 → resolved=false（调用方标「待人工确认」）。
 */
export async function runConflictFixLoop(
  prose: string,
  auditLog: MemoryAuditLog,
  ruleScan: RuleScanResult,
  styleConfig: StyleConfig,
  characters: Character[],
  settings: WorldSetting[],
  options?: {
    maxRounds?: number;
    onProgress?: (msg: string) => void;
    onProseUpdate?: (prose: string) => void;
    /** 上章正文，修复后复扫开篇同质 */
    previousProse?: string | null;
    /** 字数目标，修复后复扫 length */
    targetWordCount?: number | null;
  }
): Promise<ConflictFixLoopResult> {
  const maxRounds = options?.maxRounds ?? DEFAULT_FIX_MAX_ROUNDS;
  const onProgress = options?.onProgress;
  const history: NonNullable<MemoryAuditLog['fixHistory']> = [];

  let currentProse = prose;
  let currentAudit = { ...auditLog, logicConflicts: [...(auditLog.logicConflicts || [])] };
  let currentScan = ruleScan;

  if (!needsConflictFix(currentScan, currentAudit.logicConflicts, currentAudit.hardReview)) {
    if (onProgress) onProgress(' [Step 4] 无需修复：机检通过且无硬伤。');
    currentAudit = {
      ...currentAudit,
      fixRounds: 0,
      fixResolved: true,
      fixHistory: [],
      ruleScanBlocked: !currentScan.passed,
    };
    return {
      prose: currentProse,
      auditLog: currentAudit,
      ruleScan: currentScan,
      fixRounds: 0,
      resolved: true,
      history: [],
    };
  }

  for (let round = 1; round <= maxRounds; round++) {
    const conflicts = collectFixConflicts(currentScan, currentAudit.logicConflicts, round);
    if (conflicts.length === 0) break;

    if (onProgress) {
      onProgress(` [Step 4] 修复轮次 ${round}/${maxRounds}，冲突 ${conflicts.length} 条...`);
    }

    const fixRound = await step4_AutoRefineAndFix(
      currentProse,
      conflicts,
      styleConfig,
      characters,
      settings,
      onProgress
    );

    currentProse = fixRound.fixedProse;
    options?.onProseUpdate?.(currentProse);

    // 重扫机检；去掉旧规则机检条目再合并，避免无限叠加
    // 第 1 轮后丢弃「严重 LLM 冲突」软线索（已尝试修过，绿通只认机检）
    const llmOnlyConflicts =
      round === 1
        ? []
        : (currentAudit.logicConflicts || []).filter((c) => !c.description?.startsWith('[规则机检'));

    const baseAfter: MemoryAuditLog = {
      ...currentAudit,
      logicConflicts: llmOnlyConflicts,
    };
    const merged = mergeRuleScanIntoAudit(
      baseAfter,
      styleConfig,
      currentProse,
      options?.previousProse,
      options?.targetWordCount
    );
    currentAudit = merged.auditLog;
    currentScan = merged.ruleScan;

    const roundSummary =
      fixRound.changesSummary.slice(0, 3).join('；') ||
      fixRound.diff.summary ||
      (currentScan.passed ? '机检已通过' : currentScan.summary);

    history.push({
      round,
      conflictCount: conflicts.length,
      ruleScanPassedAfter: currentScan.passed,
      summary: `${fixRound.mode === 'local' ? '[局部]' : fixRound.mode === 'full' ? '[全文]' : ''} ${roundSummary}`.trim(),
      changesSummary: fixRound.changesSummary.slice(0, 8),
      diffSummary: fixRound.diff.summary,
      charDelta: fixRound.diff.charDelta,
      diffHunks: fixRound.diff.hunks
        .filter((h) => h.kind !== 'equal')
        .slice(0, 12)
        .map((h) => ({
          kind: h.kind as 'remove' | 'add' | 'replace',
          before: h.before?.slice(0, 400),
          after: h.after?.slice(0, 400),
          label: h.label,
        })),
      localPatchesApplied: fixRound.localPatchesApplied,
    });

    if (onProgress) {
      onProgress(
        currentScan.passed
          ? ` [Step 4] 第 ${round} 轮后机检通过 · ${fixRound.diff.summary}`
          : ` [Step 4] 第 ${round} 轮后仍未通过：${currentScan.summary} · ${fixRound.diff.summary}`
      );
    }

    // 绿通硬门：机检通过即停止（硬伤复检在 App 层）
    if (currentScan.passed) break;
  }

  const greenOk = currentScan.passed;

  currentAudit = {
    ...currentAudit,
    fixRounds: history.length,
    fixResolved: greenOk,
    fixHistory: history,
    ruleScanBlocked: !currentScan.passed,
    verificationScore: greenOk
      ? Math.max(currentAudit.verificationScore, Math.min(100, currentScan.score + 5))
      : Math.min(currentAudit.verificationScore, currentScan.score, 70),
  };

  if (onProgress) {
    const diffHint = history
      .map((h) => h.diffSummary)
      .filter(Boolean)
      .slice(-1)[0];
    onProgress(
      greenOk
        ? ` [Step 4] 修复环结束：机检通过（共 ${history.length} 轮）${diffHint ? ` · ${diffHint}` : ''}`
        : ` [Step 4] 修复环结束：机检仍未通过（${history.length} 轮），待人工确认${diffHint ? ` · ${diffHint}` : ''}`
    );
  }

  return {
    prose: currentProse,
    auditLog: currentAudit,
    ruleScan: currentScan,
    fixRounds: history.length,
    resolved: greenOk,
    history,
  };
}

const VALID_CHAR_STATUS: CharacterStatus[] = [
  '活跃',
  '重伤',
  '闭关突破',
  '被捕受困',
  '已阵亡/退出',
];

function normalizeCharacterStatus(raw: unknown): CharacterStatus | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if ((VALID_CHAR_STATUS as string[]).includes(s)) return s as CharacterStatus;
  // 宽松映射
  if (/阵亡|死亡|身亡|已死/.test(s)) return '已阵亡/退出';
  if (/重伤|濒死|重创/.test(s)) return '重伤';
  if (/闭关|突破中/.test(s)) return '闭关突破';
  if (/被捕|受困|囚禁|被俘/.test(s)) return '被捕受困';
  if (/活跃|正常|无恙/.test(s)) return '活跃';
  return undefined;
}

/**
 * 将 patch 列表安全应用到角色卡（只改名单内 id，只写有差异字段）。
 */
export function applyCharacterPatches(
  characters: Character[],
  patches: CharacterStatePatch[],
  chapterNumber?: number
): { updatedCharacters: Character[]; writeLog: MemoryWriteLog } {
  const byId = new Map(characters.map((c) => [c.id, { ...c }]));
  const byName = new Map(characters.map((c) => [c.name, c.id]));
  const logPatches: MemoryWriteLog['patches'] = [];
  const now = new Date().toISOString();

  for (const p of patches) {
    let id = p.characterId;
    if (!byId.has(id) && p.characterName) {
      id = byName.get(p.characterName) || id;
    }
    const char = byId.get(id);
    if (!char) continue;

    const changed: string[] = [];
    const status = p.status ? normalizeCharacterStatus(p.status) : undefined;
    if (status && status !== char.status) {
      char.status = status;
      changed.push(`status→${status}`);
    }
    if (p.realmOrTitle?.trim() && p.realmOrTitle.trim() !== char.realmOrTitle) {
      char.realmOrTitle = p.realmOrTitle.trim();
      changed.push(`realm→${char.realmOrTitle}`);
    }
    if (p.currentLocation?.trim() && p.currentLocation.trim() !== char.currentLocation) {
      char.currentLocation = p.currentLocation.trim();
      changed.push(`loc→${char.currentLocation}`);
    }
    if (p.secretNotesAppend?.trim()) {
      const note = p.secretNotesAppend.trim().slice(0, 80);
      if (!char.secretNotes.includes(note)) {
        char.secretNotes = char.secretNotes
          ? `${char.secretNotes}\n[第${chapterNumber ?? '?'}章] ${note}`
          : `[第${chapterNumber ?? '?'}章] ${note}`;
        changed.push('secretNotes+');
      }
    }

    if (changed.length > 0) {
      if (chapterNumber != null) char.lastMemoryChapterNumber = chapterNumber;
      char.lastMemoryUpdatedAt = now;
      byId.set(id, char);
      logPatches.push({
        characterId: id,
        characterName: char.name,
        changedFields: changed,
        reason: p.reason,
      });
    }
  }

  // 保持原顺序
  const updatedCharacters = characters.map((c) => byId.get(c.id) || c);
  return {
    updatedCharacters,
    writeLog: {
      appliedCount: logPatches.length,
      source: 'llm',
      patches: logPatches,
      generatedAt: now,
    },
  };
}

/**
 * 启发式 fallback：用 recap 文本里对「已阵亡/重伤」等关键词做弱更新（仅限本章出场角色名命中）。
 */
export function buildFallbackCharacterPatches(
  characters: Character[],
  recap: ChapterRecap | undefined,
  prose: string
): CharacterStatePatch[] {
  const text = `${recap?.text || ''}\n${recap?.endingState || ''}\n${(recap?.keyFacts || []).join('\n')}\n${prose.slice(-800)}`;
  const patches: CharacterStatePatch[] = [];

  for (const c of characters) {
    if (!text.includes(c.name)) continue;
    // 在角色名附近窗口找状态词
    const idx = text.indexOf(c.name);
    const window = text.slice(Math.max(0, idx - 20), idx + c.name.length + 40);
    let status: CharacterStatus | undefined;
    if (/阵亡|身死|已死|陨落/.test(window)) status = '已阵亡/退出';
    else if (/重伤|濒死|重创|奄奄/.test(window)) status = '重伤';
    else if (/闭关/.test(window)) status = '闭关突破';
    else if (/被俘|受困|囚禁/.test(window)) status = '被捕受困';

    if (status && status !== c.status) {
      patches.push({
        characterId: c.id,
        characterName: c.name,
        status,
        reason: '启发式：recap/正文邻近状态词',
      });
    }
  }
  return patches;
}

// 步骤 5：章末状态 patch 回写角色卡（失忆闭环）
export async function step5_AutoUpdateMemoryGraph(
  chapter: Pick<Chapter, 'number' | 'title' | 'involvedCharacterIds'>,
  characters: Character[],
  prose: string,
  recap?: ChapterRecap,
  onProgress?: (msg: string) => void
): Promise<{
  updatedCharacters: Character[];
  writeLog: MemoryWriteLog;
  patches: CharacterStatePatch[];
}> {
  if (onProgress) onProgress(' [Step 5 记忆] 抽取本章角色状态 diff，回写角色卡...');

  // 优先本章出场角色；若未绑定则用全书角色（限前 12，控 token）
  const involved = characters.filter((c) => chapter.involvedCharacterIds?.includes(c.id));
  const scope = (involved.length > 0 ? involved : characters).slice(0, 12);

  if (scope.length === 0) {
    if (onProgress) onProgress(' [Step 5 记忆] 无角色卡可更新，跳过。');
    return {
      updatedCharacters: characters,
      writeLog: {
        appliedCount: 0,
        source: 'fallback',
        patches: [],
        generatedAt: new Date().toISOString(),
      },
      patches: [],
    };
  }

  try {
    const messages = buildCharacterStatusPatchPrompt(
      chapter,
      prose,
      scope,
      recap?.text
    );
    const res = await generateJSON<{
      patches?: Array<{
        characterId?: string;
        characterName?: string;
        status?: string;
        realmOrTitle?: string;
        currentLocation?: string;
        secretNotesAppend?: string;
        reason?: string;
      }>;
    }>(messages, 0.3);

    const rawList = Array.isArray(res.patches) ? res.patches : [];
    const patches: CharacterStatePatch[] = rawList
      .map((p) => {
        const name = (p.characterName || '').trim();
        const id =
          (p.characterId || '').trim() ||
          scope.find((c) => c.name === name)?.id ||
          '';
        if (!id && !name) return null;
        const status = normalizeCharacterStatus(p.status);
        return {
          characterId: id || scope.find((c) => c.name === name)?.id || '',
          characterName: name || scope.find((c) => c.id === id)?.name || '',
          status,
          realmOrTitle: p.realmOrTitle?.trim() || undefined,
          currentLocation: p.currentLocation?.trim() || undefined,
          secretNotesAppend: p.secretNotesAppend?.trim() || undefined,
          reason: p.reason?.trim() || undefined,
        } as CharacterStatePatch;
      })
      .filter((p): p is CharacterStatePatch => !!p && !!p.characterId);

    const { updatedCharacters, writeLog } = applyCharacterPatches(
      characters,
      patches,
      chapter.number
    );
    writeLog.source = 'llm';

    if (onProgress) {
      onProgress(
        writeLog.appliedCount > 0
          ? ` [Step 5 记忆] 已回写 ${writeLog.appliedCount} 名角色状态。`
          : ' [Step 5 记忆] 模型认为本章无状态变化，角色卡保持不变。'
      );
    }

    return { updatedCharacters, writeLog, patches };
  } catch (err: any) {
    if (onProgress) {
      onProgress(` [Step 5 记忆警告] LLM 抽取失败，改用启发式：${err.message || err}`);
    }
    const patches = buildFallbackCharacterPatches(scope, recap, prose);
    const { updatedCharacters, writeLog } = applyCharacterPatches(
      characters,
      patches,
      chapter.number
    );
    writeLog.source = 'fallback';
    if (onProgress) {
      onProgress(
        writeLog.appliedCount > 0
          ? ` [Step 5 记忆] 启发式回写 ${writeLog.appliedCount} 名角色。`
          : ' [Step 5 记忆] 启发式无可靠变更，跳过回写。'
      );
    }
    return { updatedCharacters, writeLog, patches };
  }
}
