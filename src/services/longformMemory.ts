/**
 * 200+ 章长篇记忆：
 * - rolling(10) 近中程 · mega(50) 远程总览 · volume 分卷
 * - 超额事实归档进 digest，不静默丢信息
 * - 章末伏笔回收建议（确认后才 resolved）
 */

import type {
  Chapter,
  ChapterRecap,
  Character,
  HookResolveSuggestion,
  StoryMemory,
  StorySpanDigest,
  StorySpanDigestKind,
  Volume,
} from '../types/novel';
import { listActiveFacts, listActiveThreads, normalizeStoryMemory } from './storyMemory';
import { enrichFactsWithSubjects } from './subjectIndex';
import { mergeEntitiesIntoMemory } from './entityState';
import { generateJSON } from './llmClient';

export const DEFAULT_DIGEST_BLOCK_SIZE = 10;
/** 叙事弧长度（约一卷内小弧 / 爽文小高潮周期） */
export const DEFAULT_ARC_BLOCK_SIZE = 15;
export const DEFAULT_MEGA_BLOCK_SIZE = 50;
export const DEFAULT_SUPER_BLOCK_SIZE = 100;

/** AI 长跑 300+：活跃事实软上限（超出归档进 digest） */
export const LONGFORM_ACTIVE_FACT_CAP = 200;
/** 活跃伏笔软上限（core 永不自动延期） */
export const LONGFORM_ACTIVE_THREAD_CAP = 80;

function chapterWordish(c: Chapter): boolean {
  return (c.wordCount || 0) > 80 || (c.content || '').replace(/\s+/g, '').length > 80;
}

function oneLineRecap(c: Chapter, max = 100): string {
  const t = c.recap?.text?.trim() || c.summary?.trim() || '';
  if (!t) return '';
  const line = t.replace(/\s+/g, ' ');
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function normalizeTextKey(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase().slice(0, 64);
}

function similarEnough(a: string, b: string): boolean {
  const x = normalizeTextKey(a);
  const y = normalizeTextKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 6 && y.includes(x)) return true;
  if (y.length >= 6 && x.includes(y)) return true;
  // 共享较长子串
  if (x.length >= 8 && y.length >= 8) {
    const n = Math.min(8, x.length, y.length);
    for (let i = 0; i <= x.length - n; i++) {
      if (y.includes(x.slice(i, i + n))) return true;
    }
  }
  return false;
}

/**
 * 重建多层 digest：volume + arc + rolling + mega + super。
 */
export function rebuildSpanDigests(
  chapters: Chapter[],
  memory?: StoryMemory | null,
  options?: {
    blockSize?: number;
    arcBlockSize?: number;
    megaBlockSize?: number;
    superBlockSize?: number;
    volumes?: Volume[];
    upToChapterExclusive?: number;
  }
): StorySpanDigest[] {
  const blockSize = Math.max(
    5,
    Math.min(20, options?.blockSize ?? memory?.digestBlockSize ?? DEFAULT_DIGEST_BLOCK_SIZE)
  );
  const arcSize = Math.max(
    8,
    Math.min(25, options?.arcBlockSize ?? DEFAULT_ARC_BLOCK_SIZE)
  );
  const megaSize = Math.max(
    30,
    Math.min(80, options?.megaBlockSize ?? memory?.megaBlockSize ?? DEFAULT_MEGA_BLOCK_SIZE)
  );
  const superSize = Math.max(
    60,
    Math.min(
      150,
      options?.superBlockSize ?? memory?.superBlockSize ?? DEFAULT_SUPER_BLOCK_SIZE
    )
  );
  const upTo =
    options?.upToChapterExclusive != null
      ? options.upToChapterExclusive
      : Number.POSITIVE_INFINITY;

  const sorted = [...chapters]
    .filter((c) => c.number < upTo && chapterWordish(c))
    .sort((a, b) => a.number - b.number);

  if (sorted.length === 0) return memory?.spanDigests || [];

  const digests: StorySpanDigest[] = [];
  const now = new Date().toISOString();

  // 1) 分卷
  const volumes = (options?.volumes || [])
    .filter((v) => v.endChapter >= v.startChapter)
    .sort((a, b) => a.startChapter - b.startChapter);

  for (const vol of volumes) {
    const slice = sorted.filter(
      (c) => c.number >= vol.startChapter && c.number <= vol.endChapter
    );
    if (slice.length < 2) continue;
    digests.push(
      buildDigestFromChapters(slice, 'volume', vol.title || `第${vol.number}卷`, now, {
        dense: slice.length > 25,
      })
    );
  }

  // 2) 叙事弧 ~15 章（ainovel 风格：比 rolling 更贴剧情单元）
  for (let i = 0; i < sorted.length; i += arcSize) {
    const slice = sorted.slice(i, i + arcSize);
    const isComplete = slice.length >= arcSize;
    const isTailPartial = !isComplete && slice.length >= 5;
    if (!isComplete && !isTailPartial) continue;
    const arcIdx = Math.floor(i / arcSize) + 1;
    const title = isComplete
      ? `第${arcIdx}弧·第${slice[0].number}–${slice[slice.length - 1].number}章`
      : `第${arcIdx}弧·第${slice[0].number}–${slice[slice.length - 1].number}章（进行中）`;
    digests.push(
      buildDigestFromChapters(slice, 'arc', title, now, { dense: slice.length > 12, maxLine: 90 })
    );
  }

  // 3) rolling 10 章
  for (let i = 0; i < sorted.length; i += blockSize) {
    const slice = sorted.slice(i, i + blockSize);
    const isComplete = slice.length >= blockSize;
    const isTailPartial = !isComplete && slice.length >= 3;
    if (!isComplete && !isTailPartial) continue;
    const title = isComplete
      ? `第${slice[0].number}–${slice[slice.length - 1].number}章`
      : `第${slice[0].number}–${slice[slice.length - 1].number}章（进行中）`;
    digests.push(buildDigestFromChapters(slice, 'rolling', title, now, { dense: false }));
  }

  // 4) mega 50 章（中远程）
  if (sorted.length >= megaSize * 0.6) {
    for (let i = 0; i < sorted.length; i += megaSize) {
      const slice = sorted.slice(i, i + megaSize);
      if (slice.length < Math.min(20, megaSize * 0.5)) continue;
      const complete = slice.length >= megaSize;
      if (!complete && slice.length < 25) continue;
      const title = complete
        ? `总览50·第${slice[0].number}–${slice[slice.length - 1].number}章`
        : `总览50·第${slice[0].number}–${slice[slice.length - 1].number}章（进行中）`;
      digests.push(
        buildDigestFromChapters(slice, 'mega', title, now, { dense: true, maxLine: 72 })
      );
    }
  }

  // 5) super 100 章（300+ AI 连载远程总纲）
  if (sorted.length >= superSize * 0.55) {
    for (let i = 0; i < sorted.length; i += superSize) {
      const slice = sorted.slice(i, i + superSize);
      if (slice.length < Math.min(40, superSize * 0.45)) continue;
      const complete = slice.length >= superSize;
      if (!complete && slice.length < 50) continue;
      const title = complete
        ? `纪元100·第${slice[0].number}–${slice[slice.length - 1].number}章`
        : `纪元100·第${slice[0].number}–${slice[slice.length - 1].number}章（进行中）`;
      digests.push(
        buildDigestFromChapters(slice, 'super', title, now, { dense: true, maxLine: 56 })
      );
    }
  }

  return digests;
}

function buildDigestFromChapters(
  slice: Chapter[],
  kind: StorySpanDigestKind,
  title: string,
  now: string,
  opts?: { dense?: boolean; maxLine?: number }
): StorySpanDigest {
  const fromChapter = slice[0].number;
  const toChapter = slice[slice.length - 1].number;
  const maxLine = opts?.maxLine ?? (opts?.dense ? 72 : 100);
  const lines = slice.map((c) => {
    const line = oneLineRecap(c, maxLine);
    return line ? `第${c.number}章《${c.title}》：${line}` : `第${c.number}章《${c.title}》`;
  });

  let summaryParts = lines;
  if (opts?.dense || lines.length > 8) {
    // 头 2 + 中段抽样 + 尾 2
    if (lines.length <= 6) {
      summaryParts = lines;
    } else {
      const mid = lines.slice(2, -2);
      const step = Math.max(1, Math.floor(mid.length / 3));
      const sampled = mid.filter((_, i) => i % step === 0).slice(0, 3);
      summaryParts = [
        ...lines.slice(0, 2),
        ...(sampled.length ? sampled : [`…（中段 ${mid.length} 章）…`]),
        ...lines.slice(-2),
      ];
    }
  } else if (lines.length > 6) {
    summaryParts = [
      ...lines.slice(0, 2),
      `…（中段 ${lines.length - 4} 章略）…`,
      ...lines.slice(-2),
    ];
  }

  const summaryCap =
    kind === 'super'
      ? 400
      : kind === 'mega'
        ? 480
        : kind === 'arc'
          ? 520
          : kind === 'volume'
            ? 560
            : 600;
  const summary = summaryParts.join('\n').slice(0, summaryCap);

  const keyFacts: string[] = [];
  const openHooks: string[] = [];
  const seenF = new Set<string>();
  const seenH = new Set<string>();
  const factLimit =
    kind === 'super' ? 18 : kind === 'mega' ? 16 : kind === 'arc' ? 14 : 12;
  const hookLimit =
    kind === 'super' ? 12 : kind === 'mega' ? 10 : kind === 'arc' ? 10 : 8;

  for (const c of slice) {
    for (const f of c.recap?.keyFacts || []) {
      const t = f.trim().slice(0, 120);
      const k = normalizeTextKey(t);
      if (!t || seenF.has(k) || keyFacts.length >= factLimit) continue;
      seenF.add(k);
      keyFacts.push(t);
    }
    for (const h of c.recap?.openThreads || []) {
      const t = h.trim().slice(0, 100);
      const k = normalizeTextKey(t);
      if (!t || seenH.has(k) || openHooks.length >= hookLimit) continue;
      seenH.add(k);
      openHooks.push(t);
    }
  }

  return {
    id: `digest-${kind}-${fromChapter}-${toChapter}`,
    fromChapter,
    toChapter,
    kind,
    title,
    summary,
    keyFacts,
    openHooks,
    charactersMentioned: [],
    updatedAt: now,
    source: 'heuristic',
  };
}

/**
 * 重建摘要后保留同 id、同范围的 LLM 润色叙事，避免每次 consolidate 冲掉纪元总览。
 */
export function preserveLlmPolishedDigests(
  rebuilt: StorySpanDigest[],
  previous: StorySpanDigest[] | undefined
): StorySpanDigest[] {
  if (!previous?.length) return rebuilt;
  const prevMap = new Map(previous.map((d) => [d.id, d]));
  return rebuilt.map((d) => {
    const old = prevMap.get(d.id);
    if (
      !old ||
      old.source !== 'llm' ||
      !old.summary?.trim() ||
      old.fromChapter !== d.fromChapter ||
      old.toChapter !== d.toChapter
    ) {
      return d;
    }
    return {
      ...d,
      summary: old.summary,
      source: 'llm',
      llmPolishedAt: old.llmPolishedAt,
      // 事实/伏笔仍以重建结果为准（可能有新归档），但摘要叙事保留 LLM
      keyFacts: d.keyFacts.length ? d.keyFacts : old.keyFacts || [],
      openHooks: d.openHooks.length ? d.openHooks : old.openHooks || [],
    };
  });
}

export interface PolishEpochDigestsResult {
  memory: StoryMemory;
  polished: number;
  skipped: number;
  errors: string[];
}

/**
 * 用 LLM 把 mega/super（纪元）摘要润成连贯远程总览，服务 100/200/300+ 章注入。
 * 默认只处理尚未 llm 润色的块；force 可重跑。
 */
export async function polishEpochDigestsWithLlm(
  memory: StoryMemory | null | undefined,
  options?: {
    /** 最多润色几块（省 token） */
    maxBlocks?: number;
    /** 强制重跑已润色块 */
    force?: boolean;
    /** 只处理 super / mega，默认两者 */
    kinds?: Array<'mega' | 'super'>;
    onProgress?: (msg: string) => void;
  }
): Promise<PolishEpochDigestsResult> {
  const base = normalizeStoryMemory(memory || undefined);
  const maxBlocks = Math.max(1, Math.min(6, options?.maxBlocks ?? 2));
  const kinds = options?.kinds ?? (['super', 'mega'] as const);
  const force = options?.force === true;
  const digests = [...(base.spanDigests || [])];
  const errors: string[] = [];
  let polished = 0;
  let skipped = 0;

  const candidates = digests
    .filter((d) => (kinds as readonly string[]).includes(d.kind))
    .filter((d) => force || d.source !== 'llm')
    .sort((a, b) => {
      // 优先 super，再近的 mega
      const rank = (k: string) => (k === 'super' ? 0 : 1);
      return rank(a.kind) - rank(b.kind) || b.toChapter - a.toChapter;
    });

  if (!candidates.length) {
    options?.onProgress?.('纪元摘要均已润色，无需重跑');
    return { memory: base, polished: 0, skipped: digests.length, errors };
  }

  const toRun = candidates.slice(0, maxBlocks);
  skipped = Math.max(0, candidates.length - toRun.length);

  for (const dig of toRun) {
    const tag = dig.kind === 'super' ? '纪元100' : '总览50';
    options?.onProgress?.(
      `LLM 润色 ${tag} · 第${dig.fromChapter}–${dig.toChapter}章…`
    );
    try {
      const res = await generateJSON<{
        summary?: string;
        keyFacts?: string[];
        openHooks?: string[];
      }>(
        [
          {
            role: 'system',
            content:
              '你是长篇网文连载记忆压缩器。把分章摘要压缩成远程可用的总览，供后续写章注入。' +
              '只输出 JSON：{ "summary": string, "keyFacts": string[], "openHooks": string[] }。' +
              'summary 用连贯中文 120～280 字，按时间推进，保留主线冲突与人物关系，不要列表堆砌章号。' +
              'keyFacts 最多 12 条钉死级要点；openHooks 最多 8 条仍未收的线。禁止编造输入中没有的情节。',
          },
          {
            role: 'user',
            content: [
              `块类型：${tag} · ${dig.title}`,
              `章节范围：第${dig.fromChapter}–${dig.toChapter}章`,
              '--- 原始压缩（启发式） ---',
              dig.summary || '（无）',
              '--- 已有要点 ---',
              (dig.keyFacts || []).join('\n') || '（无）',
              '--- 段内伏笔 ---',
              (dig.openHooks || []).join('\n') || '（无）',
            ].join('\n'),
          },
        ],
        0.35
      );

      const summary = (res.summary || '').trim().replace(/\s+/g, ' ');
      if (summary.length < 40) {
        errors.push(`${dig.id}: 润色过短`);
        continue;
      }
      const keyFacts = (res.keyFacts || [])
        .map((s) => String(s).trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, 12);
      const openHooks = (res.openHooks || [])
        .map((s) => String(s).trim().slice(0, 100))
        .filter(Boolean)
        .slice(0, 8);
      const now = new Date().toISOString();
      const idx = digests.findIndex((d) => d.id === dig.id);
      if (idx < 0) continue;
      digests[idx] = {
        ...digests[idx],
        summary: summary.slice(0, dig.kind === 'super' ? 420 : 480),
        keyFacts: keyFacts.length ? keyFacts : digests[idx].keyFacts,
        openHooks: openHooks.length ? openHooks : digests[idx].openHooks,
        source: 'llm',
        llmPolishedAt: now,
        updatedAt: now,
      };
      polished += 1;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${dig.id}: ${msg}`);
    }
  }

  const next: StoryMemory = {
    ...base,
    spanDigests: digests,
    updatedAt: new Date().toISOString(),
  };
  options?.onProgress?.(
    polished > 0
      ? `纪元润色完成 · ${polished} 块` + (errors.length ? ` · 失败 ${errors.length}` : '')
      : `纪元润色未更新` + (errors.length ? ` · ${errors[0]}` : '')
  );
  return { memory: next, polished, skipped, errors };
}

/**
 * 超额旧事实归档进 digest；旧 open 伏笔延期（core 除外）。
 */
export function archiveOverflowFacts(
  memory: StoryMemory,
  options?: { factCap?: number; threadCap?: number; currentChapter?: number }
): StoryMemory {
  const next = normalizeStoryMemory(memory);
  const factCap = options?.factCap ?? LONGFORM_ACTIVE_FACT_CAP;
  const threadCap = options?.threadCap ?? LONGFORM_ACTIVE_THREAD_CAP;
  const currentChapter = options?.currentChapter ?? 9999;

  const activeFacts = next.pinnedFacts.filter((f) => f.status === 'pinned');
  if (activeFacts.length > factCap) {
    const ordered = [...activeFacts].sort(
      (a, b) =>
        (a.sourceChapterNumber || a.validFromChapter || 0) -
        (b.sourceChapterNumber || b.validFromChapter || 0)
    );
    const dropCount = ordered.length - factCap;
    const toArchive = ordered.slice(0, dropCount);
    const digests = [...(next.spanDigests || [])];

    for (const f of toArchive) {
      f.status = 'superseded';
      f.validUntilChapter = f.validUntilChapter ?? currentChapter;
      f.note = [f.note, '[长篇归档：写入摘要，冷检索可命中]'].filter(Boolean).join(' ');
      const src = f.sourceChapterNumber || f.validFromChapter || 0;
      // 优先挂 rolling，再 mega
      let dig =
        digests.find(
          (d) => d.kind === 'rolling' && src >= d.fromChapter && src <= d.toChapter
        ) ||
        digests.find(
          (d) => d.kind === 'mega' && src >= d.fromChapter && src <= d.toChapter
        ) ||
        digests.find(
          (d) => d.kind === 'super' && src >= d.fromChapter && src <= d.toChapter
        ) ||
        digests.find((d) => src >= d.fromChapter && src <= d.toChapter) ||
        digests[0];
      if (
        dig &&
        dig.keyFacts.length < 24 &&
        !dig.keyFacts.some((k) => similarEnough(k, f.text))
      ) {
        dig = {
          ...dig,
          keyFacts: [...dig.keyFacts, f.text.slice(0, 120)],
        };
        const idx = digests.findIndex((d) => d.id === dig!.id);
        if (idx >= 0) digests[idx] = dig;
      }
    }
    next.spanDigests = digests;
  }

  const activeThreads = next.openThreads.filter((t) => t.status !== 'resolved');
  if (activeThreads.length > threadCap) {
    const sorted = [...activeThreads].sort(
      (a, b) =>
        (a.introducedChapterNumber || 0) - (b.introducedChapterNumber || 0)
    );
    const overflow = sorted.slice(0, activeThreads.length - threadCap);
    for (const t of overflow) {
      if (t.status === 'open' && !t.coreHook) {
        t.status = 'deferred';
        t.note = [t.note, '[200+：活跃伏笔过多，自动延期]'].filter(Boolean).join(' ');
      }
    }
  }

  next.updatedAt = new Date().toISOString();
  return next;
}

/**
 * 根据 recap 启发式提议可回收的伏笔（不自动 resolved）。
 */
export function suggestHookResolvesFromRecap(
  memory: StoryMemory,
  recap: ChapterRecap,
  chapterNumber: number
): HookResolveSuggestion[] {
  const corpus = [
    recap.text || '',
    recap.endingState || '',
    ...(recap.keyFacts || []),
  ].join('\n');
  if (corpus.replace(/\s+/g, '').length < 20) return [];

  const suggestions: HookResolveSuggestion[] = [];
  const active = listActiveThreads(memory);
  const now = new Date().toISOString();

  // 若 openThreads 列表变短且某旧线文本不再出现、但 keyFacts 像结算 → 弱信号
  for (const t of active) {
    if (t.status === 'deferred' && !t.coreHook) continue;
    // 正文/事实强烈覆盖伏笔表述 → 建议回收
    if (similarEnough(corpus, t.text) && /解决|揭穿|已死|身亡|坦白|真相|结束|收回|了结|击溃|坦白|公开/.test(corpus)) {
      suggestions.push({
        threadId: t.id,
        threadText: t.text,
        reason: '章末 recap/事实与伏笔高度重合，且含收束措辞',
        confidence: t.coreHook ? 'medium' : 'high',
        sourceChapterNumber: chapterNumber,
        suggestedAt: now,
      });
      continue;
    }
    // recap 的 openThreads 不再包含相似线，且 keyFacts 命中 → medium
    const stillOpenInRecap = (recap.openThreads || []).some((h) => similarEnough(h, t.text));
    const factHit = (recap.keyFacts || []).some((f) => similarEnough(f, t.text));
    if (!stillOpenInRecap && factHit && t.status === 'progressing') {
      suggestions.push({
        threadId: t.id,
        threadText: t.text,
        reason: '本章 keyFacts 覆盖该线，且 recap 未再列为未收伏笔',
        confidence: 'medium',
        sourceChapterNumber: chapterNumber,
        suggestedAt: now,
      });
    }
  }

  return suggestions.slice(0, 8);
}

/** 合并回收建议（去重 threadId，保留更新） */
export function mergePendingHookResolves(
  memory: StoryMemory,
  incoming: HookResolveSuggestion[]
): StoryMemory {
  const next = normalizeStoryMemory(memory);
  const map = new Map<string, HookResolveSuggestion>();
  for (const s of next.pendingHookResolves || []) map.set(s.threadId, s);
  for (const s of incoming) map.set(s.threadId, s);
  // 清掉已 resolved 的
  const resolvedIds = new Set(
    next.openThreads.filter((t) => t.status === 'resolved').map((t) => t.id)
  );
  next.pendingHookResolves = [...map.values()]
    .filter((s) => !resolvedIds.has(s.threadId))
    .slice(-30);
  next.updatedAt = new Date().toISOString();
  return next;
}

export function acceptHookResolve(
  memory: StoryMemory,
  threadId: string,
  chapterNumber?: number
): StoryMemory {
  const next = normalizeStoryMemory(memory);
  next.openThreads = next.openThreads.map((t) =>
    t.id === threadId
      ? {
          ...t,
          status: 'resolved' as const,
          resolvedAt: new Date().toISOString(),
          lastTouchedChapterNumber: chapterNumber ?? t.lastTouchedChapterNumber,
        }
      : t
  );
  next.pendingHookResolves = (next.pendingHookResolves || []).filter(
    (s) => s.threadId !== threadId
  );
  next.updatedAt = new Date().toISOString();
  return next;
}

export function dismissHookResolve(memory: StoryMemory, threadId: string): StoryMemory {
  const next = normalizeStoryMemory(memory);
  next.pendingHookResolves = (next.pendingHookResolves || []).filter(
    (s) => s.threadId !== threadId
  );
  next.updatedAt = new Date().toISOString();
  return next;
}

/** 写完一章后：重建 digest + 归档 + 回收建议（+ 可选 AP 自动确认 high） */
export function consolidateMemoryAfterChapter(
  memory: StoryMemory | null | undefined,
  chapters: Chapter[],
  options?: {
    chapterNumber?: number;
    volumes?: Volume[];
    blockSize?: number;
    megaBlockSize?: number;
    superBlockSize?: number;
    recap?: ChapterRecap | null;
    /** AI 连载：自动确认 high 置信回收 */
    autoAcceptHighConfidenceResolves?: boolean;
    /** 补全事实 subject 用 */
    characters?: Character[];
  }
): StoryMemory {
  const base = normalizeStoryMemory(memory || undefined);
  const rebuilt = rebuildSpanDigests(chapters, base, {
    blockSize: options?.blockSize ?? base.digestBlockSize,
    megaBlockSize: options?.megaBlockSize ?? base.megaBlockSize,
    superBlockSize: options?.superBlockSize ?? base.superBlockSize,
    volumes: options?.volumes,
    upToChapterExclusive: options?.chapterNumber
      ? options.chapterNumber + 1
      : undefined,
  });
  // 同范围 LLM 纪元总览不因重建而丢失
  const digests = preserveLlmPolishedDigests(rebuilt, base.spanDigests);
  let next: StoryMemory = {
    ...base,
    spanDigests: digests,
    digestBlockSize: options?.blockSize ?? base.digestBlockSize ?? DEFAULT_DIGEST_BLOCK_SIZE,
    megaBlockSize: options?.megaBlockSize ?? base.megaBlockSize ?? DEFAULT_MEGA_BLOCK_SIZE,
    superBlockSize:
      options?.superBlockSize ?? base.superBlockSize ?? DEFAULT_SUPER_BLOCK_SIZE,
    updatedAt: new Date().toISOString(),
  };

  // 出场角色名 → 事实 subject，供 300 章后精确捞取
  if (options?.characters?.length) {
    next.pinnedFacts = enrichFactsWithSubjects(next.pinnedFacts, options.characters);
  }

  // 地点/道具轻量实体（recap + 角色所在地）
  if (options?.chapterNumber != null) {
    next = mergeEntitiesIntoMemory(next, {
      recap: options.recap,
      characters: options.characters,
      chapterNumber: options.chapterNumber,
    });
  }

  next = archiveOverflowFacts(next, {
    currentChapter: options?.chapterNumber,
  });

  if (options?.recap && options.chapterNumber != null) {
    const suggestions = suggestHookResolvesFromRecap(
      next,
      options.recap,
      options.chapterNumber
    );
    if (suggestions.length) {
      next = mergePendingHookResolves(next, suggestions);
    }
  }

  if (options?.autoAcceptHighConfidenceResolves) {
    const highs = (next.pendingHookResolves || []).filter((s) => s.confidence === 'high');
    for (const s of highs) {
      next = acceptHookResolve(next, s.threadId, options.chapterNumber);
    }
  }

  return next;
}

export function formatDigestsForPrompt(
  digests: StorySpanDigest[],
  max = 4
): string {
  if (!digests.length) return '';
  const lines: string[] = ['【中远程压缩记忆（勿当逐字正文；冲突以近章 recap/钉死事实为准）】'];
  for (const d of digests.slice(0, max)) {
    const tag =
      d.kind === 'super'
        ? '纪元100'
        : d.kind === 'mega'
          ? '总览50'
          : d.kind === 'arc'
            ? '叙事弧'
            : d.kind === 'volume'
              ? '分卷'
              : '滚动10';
    lines.push(`▸ [${tag}] ${d.title}（第${d.fromChapter}–${d.toChapter}章）`);
    const cap =
      d.kind === 'super' ? 240 : d.kind === 'mega' ? 280 : d.kind === 'arc' ? 300 : 320;
    lines.push(d.summary.slice(0, cap));
    if (d.keyFacts.length) {
      const n = d.kind === 'super' ? 7 : d.kind === 'mega' ? 6 : 5;
      lines.push(`  要点：${d.keyFacts.slice(0, n).join('； ')}`);
    }
    if (d.openHooks.length) {
      lines.push(`  段内伏笔：${d.openHooks.slice(0, 4).join('； ')}`);
    }
  }
  return lines.join('\n');
}

/**
 * 200+ 检索：强制近 mega 1 + 近 rolling 1～2 + 相关 volume/更远块。
 */
export function selectRelevantDigests(
  digests: StorySpanDigest[] | undefined,
  queryTerms: string[],
  chapterNumber: number,
  max = 4
): StorySpanDigest[] {
  const list = digests || [];
  if (!list.length) return [];
  const past = list.filter((d) => d.toChapter < chapterNumber);
  if (!past.length) return [];

  const scored = past.map((d) => {
    let score = 0;
    const blob =
      `${d.title} ${d.summary} ${d.keyFacts.join(' ')} ${d.openHooks.join(' ')}`.toLowerCase();
    for (const t of queryTerms) {
      if (t && blob.includes(t.toLowerCase())) score += 3;
    }
    const dist = chapterNumber - d.toChapter;
    if (d.kind === 'super') {
      score += dist <= 120 ? 5 : dist <= 220 ? 3 : 1;
    } else if (d.kind === 'mega') {
      score += dist <= 60 ? 4 : dist <= 120 ? 2 : 1;
    } else if (d.kind === 'arc') {
      if (dist <= 20) score += 5;
      else if (dist <= 45) score += 3;
      else score += 1;
    } else if (d.kind === 'rolling') {
      if (dist <= 15) score += 5;
      else if (dist <= 40) score += 2;
      else score += 0.5;
    } else if (d.kind === 'volume') {
      score += dist <= 80 ? 3 : 1;
    }
    return { d, score, dist };
  });

  const picked: StorySpanDigest[] = [];
  const used = new Set<string>();

  const take = (pred: (s: (typeof scored)[0]) => boolean, n: number) => {
    const pool = scored
      .filter((s) => !used.has(s.d.id) && pred(s))
      .sort((a, b) => b.score - a.score || a.dist - b.dist);
    for (const s of pool.slice(0, n)) {
      used.add(s.d.id);
      picked.push(s.d);
    }
  };

  // 配额：章数越大越依赖 super/mega（AI 300+ 连载）
  if (chapterNumber >= 200) {
    take((s) => s.d.kind === 'super', 1);
    take((s) => s.d.kind === 'mega', 1);
    take((s) => s.d.kind === 'arc', 1);
    take((s) => s.d.kind === 'rolling' || s.d.kind === 'volume', 1);
  } else if (chapterNumber >= 100) {
    take((s) => s.d.kind === 'super', 1);
    take((s) => s.d.kind === 'arc', 1);
    take((s) => s.d.kind === 'mega', 1);
    take((s) => s.d.kind === 'rolling', 1);
  } else if (chapterNumber >= 50) {
    take((s) => s.d.kind === 'arc', 1);
    take((s) => s.d.kind === 'mega', 1);
    take((s) => s.d.kind === 'rolling', 1);
  } else if (chapterNumber >= 15) {
    take((s) => s.d.kind === 'arc' || s.d.kind === 'rolling' || s.d.kind === 'volume', max);
  } else {
    take(() => true, Math.min(2, max));
  }

  // 补相关高分
  if (picked.length < max) {
    take((s) => s.score > 0, max - picked.length);
  }
  // 仍空：最近 rolling/mega
  if (picked.length === 0) {
    take(() => true, Math.min(2, max));
  }

  return picked.slice(0, max);
}

export function longformMemoryHealth(
  memory: StoryMemory | null | undefined,
  chapterCount: number
): { ok: boolean; messages: string[]; level: 'ok' | 'watch' | 'risk' } {
  const mem = normalizeStoryMemory(memory || undefined);
  const messages: string[] = [];
  const facts = listActiveFacts(mem).length;
  const threads = listActiveThreads(mem).length;
  const digests = mem.spanDigests || [];
  const rolling = digests.filter((d) => d.kind === 'rolling').length;
  const arcN = digests.filter((d) => d.kind === 'arc').length;
  const mega = digests.filter((d) => d.kind === 'mega').length;
  const superN = digests.filter((d) => d.kind === 'super').length;
  const pending = mem.pendingHookResolves?.length || 0;

  if (chapterCount >= 20 && rolling === 0 && arcN === 0) {
    messages.push('已超 20 章仍无滚动/弧摘要：请用完整闭环写章，或点「重建摘要」。');
  }
  if (chapterCount >= 30 && arcN === 0) {
    messages.push('30+ 章建议出现「叙事弧」摘要（约 15 章一弧），中程连贯更稳。');
  }
  if (chapterCount >= 50 && mega === 0) {
    messages.push('50+ 章建议出现「总览50」摘要，否则远程主线易丢。');
  }
  if (chapterCount >= 100 && superN === 0) {
    messages.push('100+ 章：缺少「纪元100」超级总览，AI 长跑远程易断层。');
  }
  if (chapterCount >= 100 && mega < 2) {
    messages.push('100+ 章：巨型摘要偏少，重建摘要或检查是否有足够 recap。');
  }
  if (chapterCount >= 200 && superN < 2) {
    messages.push('200+ 章：超级总览偏少，建议完整闭环连写并重建摘要。');
  }
  if (chapterCount >= 150 && rolling < 8) {
    messages.push('150+ 章：滚动块偏少，中程连贯可能不足。');
  }
  if (facts > LONGFORM_ACTIVE_FACT_CAP * 0.9) {
    messages.push(
      `活跃事实 ${facts}/${LONGFORM_ACTIVE_FACT_CAP}，将自动归档旧条进摘要。`
    );
  }
  if (threads > LONGFORM_ACTIVE_THREAD_CAP * 0.85) {
    messages.push(`活跃伏笔 ${threads} 条偏多，注意清债务与确认回收建议。`);
  }
  if (pending >= 3) {
    messages.push(`有 ${pending} 条伏笔回收建议待确认（记忆页处理）。`);
  }
  if (chapterCount >= 40 && facts < 5) {
    messages.push('章数不少但钉死事实很少：铁律请手钉，并避免长期 draft_only。');
  }
  const ledgerActive =
    mem.factLedger?.assertions?.filter((a) => a.status === 'active').length || 0;
  if (chapterCount >= 15 && ledgerActive === 0) {
    messages.push(
      '15+ 章仍无事实账本：完整闭环会自动建；或在记忆页点「重建账本」。'
    );
  } else if (chapterCount >= 50 && ledgerActive < 5) {
    messages.push('50+ 章账本偏空，跨章对账能力弱，建议重建账本并手钉关键死亡/道具。');
  }

  let level: 'ok' | 'watch' | 'risk' = 'ok';
  if (messages.length >= 3 || (chapterCount >= 100 && mega === 0)) level = 'risk';
  else if (messages.length > 0) level = 'watch';

  return { ok: messages.length === 0, messages, level };
}

/** 注入配额：按当前章号给检索/前情用 */
export function longformInjectionBudget(chapterNumber: number): {
  maxFacts: number;
  maxThreads: number;
  maxDigests: number;
  extraRecentOneLiners: number;
  tailChars: number;
} {
  if (chapterNumber >= 280) {
    return {
      maxFacts: 11,
      maxThreads: 12,
      maxDigests: 5,
      extraRecentOneLiners: 2,
      tailChars: 380,
    };
  }
  if (chapterNumber >= 200) {
    return {
      maxFacts: 12,
      maxThreads: 12,
      maxDigests: 5,
      extraRecentOneLiners: 2,
      tailChars: 400,
    };
  }
  if (chapterNumber >= 180) {
    return {
      maxFacts: 12,
      maxThreads: 12,
      maxDigests: 4,
      extraRecentOneLiners: 3,
      tailChars: 420,
    };
  }
  if (chapterNumber >= 120) {
    return {
      maxFacts: 13,
      maxThreads: 12,
      maxDigests: 4,
      extraRecentOneLiners: 3,
      tailChars: 450,
    };
  }
  if (chapterNumber >= 80) {
    return {
      maxFacts: 14,
      maxThreads: 12,
      maxDigests: 3,
      extraRecentOneLiners: 4,
      tailChars: 480,
    };
  }
  if (chapterNumber >= 40) {
    return {
      maxFacts: 14,
      maxThreads: 11,
      maxDigests: 3,
      extraRecentOneLiners: 4,
      tailChars: 500,
    };
  }
  if (chapterNumber >= 20) {
    return {
      maxFacts: 12,
      maxThreads: 10,
      maxDigests: 2,
      extraRecentOneLiners: 3,
      tailChars: 500,
    };
  }
  return {
    maxFacts: 12,
    maxThreads: 10,
    maxDigests: 1,
    extraRecentOneLiners: 2,
    tailChars: 500,
  };
}
