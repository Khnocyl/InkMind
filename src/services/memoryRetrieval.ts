/**
 * 写前记忆检索：
 * - 按本章意图/梗概/角色名做词项相关筛选（非全量最近 N）
 * - 时序事实：validFrom / validUntil
 * - 伏笔债务：静默过久强制提示推进/回收/延期
 * - 产出可落盘的 MemoryInjectionSnapshot
 */

import type {
  Chapter,
  Character,
  ChapterIntent,
  MemoryInjectionSnapshot,
  PinnedFact,
  PlotThread,
  StoryMemory,
} from '../types/novel';
import {
  listActiveFacts,
  listActiveThreads,
  normalizeStoryMemory,
} from './storyMemory';
import {
  formatDigestsForPrompt,
  longformInjectionBudget,
  selectRelevantDigests,
} from './longformMemory';
import type { StorySpanDigest } from '../types/novel';
import { factsLinkedToCharacters, inferFactSubject } from './subjectIndex';
import {
  formatRelatedChaptersForPrompt,
  semanticBoostMap,
  type SemanticBoostMaps,
} from './semanticIndex';
import { formatEntitiesForPrompt } from './entityState';

export interface MemoryQueryInput {
  chapter: Chapter;
  memory?: StoryMemory | null;
  characters?: Character[];
  /** 全书章节（语义检索相关历史章） */
  allChapters?: Chapter[];
  /** 当前章号（用于时序与债务）；默认 chapter.number */
  chapterNumber?: number;
  maxFacts?: number;
  maxThreads?: number;
  /** 债务静默阈值：progressing 默认 5；open 默认 10；core 默认 8 */
  debtThresholds?: {
    progressing?: number;
    open?: number;
    core?: number;
  };
  /** 关闭语义加持（默认开） */
  disableSemantic?: boolean;
  /**
   * 预计算的语义打分（由 embeddingIndex.semanticBoostMapAsync 产出）。
   * 提供（且 disableSemantic 未关）时内部不再跑本地 TF-IDF——写章主链路
   * 用真·向量结果，同步调用方（意图生成/写前检查）不传则维持本地检索。
   */
  semantic?: SemanticBoostMaps | null;
}

export interface ScoredFact {
  fact: PinnedFact;
  score: number;
  reasons: string[];
}

export interface ScoredThread {
  thread: PlotThread;
  score: number;
  silence: number;
  isDebt: boolean;
  reasons: string[];
}

export interface MemoryRetrievalResult {
  queryTerms: string[];
  facts: ScoredFact[];
  threads: ScoredThread[];
  debtThreads: ScoredThread[];
  digests: StorySpanDigest[];
  relatedChapters: { chapter: Chapter; score: number }[];
  /** 注入用纯文本块（含角色表由 format 另拼时可只用 facts/threads） */
  promptBlock: string;
  snapshot: MemoryInjectionSnapshot;
  source: 'retrieval' | 'fallback_all';
}

const STOP = new Set([
  '本章', '继续', '推进', '优先', '围绕', '聚焦', '保持', '处理', '应当', '不要',
  '必须', '禁止', '以及', '或者', '如果', '但是', '然后', '已经', '可以', '进行',
  '一个', '我们', '他们', '什么', '这个', '那个', '没有', '就是', '还是', '因为',
  '所以', 'the', 'and', 'with', 'from', 'that', 'this', 'into', 'must', 'keep',
  'chapter', 'story', 'focus', 'avoid',
]);

/** 从意图/梗概/角色抽检索词 */
export function extractMemoryQueryTerms(params: {
  chapter: Chapter;
  characters?: Character[];
  intent?: ChapterIntent | null;
}): string[] {
  const { chapter, characters = [], intent } = params;
  const bits: string[] = [];
  bits.push(chapter.title || '');
  bits.push(chapter.summary || '');
  bits.push(intent?.endingHook || chapter.intent?.endingHook || '');
  for (const s of intent?.mustDo || chapter.intent?.mustDo || []) bits.push(s);
  for (const s of intent?.mustAvoid || chapter.intent?.mustAvoid || []) bits.push(s);
  for (const s of intent?.emotionalBeats || chapter.intent?.emotionalBeats || []) bits.push(s);

  const involved = new Set(chapter.involvedCharacterIds || []);
  for (const c of characters) {
    if (involved.has(c.id) || involved.size === 0) {
      if (c.name) bits.push(c.name);
      if (c.alias) bits.push(c.alias);
      if (c.currentLocation) bits.push(c.currentLocation);
    }
  }

  return uniqueTerms(bits.join('\n')).slice(0, 16);
}

function uniqueTerms(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const k = t.toLowerCase();
    if (seen.has(k) || STOP.has(k) || STOP.has(t)) return;
    if (t.length < 2) return;
    seen.add(k);
    out.push(t);
  };

  const normalized = text.replace(/第\d+章/g, ' ');
  for (const m of normalized.match(/[a-zA-Z]{3,}/g) || []) {
    push(m);
  }
  for (const seg of normalized.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    if (seg.length <= 6) {
      push(seg);
    } else {
      // 滑窗 2–4 字
      for (let n = 4; n >= 2; n--) {
        for (let i = 0; i + n <= Math.min(seg.length, 12); i++) {
          push(seg.slice(i, i + n));
        }
      }
    }
  }
  return out;
}

/** 事实在 chapterNumber 是否有效 */
export function isFactValidAt(fact: PinnedFact, chapterNumber: number): boolean {
  if (fact.status !== 'pinned') return false;
  const from =
    fact.validFromChapter ??
    fact.sourceChapterNumber ??
    0;
  if (from > chapterNumber) return false;
  if (
    fact.validUntilChapter != null &&
    fact.validUntilChapter > 0 &&
    chapterNumber >= fact.validUntilChapter
  ) {
    return false;
  }
  return true;
}

export function threadSilence(thread: PlotThread, chapterNumber: number): number {
  const last = Math.max(
    thread.lastTouchedChapterNumber || 0,
    thread.introducedChapterNumber || 0
  );
  if (last <= 0) return Math.max(0, chapterNumber);
  return Math.max(0, chapterNumber - last);
}

function debtThreshold(
  thread: PlotThread,
  thresholds?: MemoryQueryInput['debtThresholds']
): number {
  const progressing = thresholds?.progressing ?? 5;
  const open = thresholds?.open ?? 10;
  const core = thresholds?.core ?? 8;
  if (thread.coreHook) return core;
  if (thread.status === 'progressing') return progressing;
  if (thread.status === 'deferred') return open + 5; // 延期略宽松，但仍要看见
  return open;
}

export function isDebtThread(
  thread: PlotThread,
  chapterNumber: number,
  thresholds?: MemoryQueryInput['debtThresholds']
): boolean {
  if (thread.status === 'resolved') return false;
  const silence = threadSilence(thread, chapterNumber);
  return silence >= debtThreshold(thread, thresholds);
}

function scoreTextMatch(text: string, terms: string[]): { score: number; hits: string[] } {
  const hay = text.toLowerCase();
  const hits: string[] = [];
  let score = 0;
  for (const t of terms) {
    if (!t) continue;
    if (hay.includes(t.toLowerCase())) {
      hits.push(t);
      score += t.length >= 4 ? 3 : 2;
    }
  }
  return { score, hits };
}

/**
 * 核心：相关记忆检索 + 债务伏笔 + 快照。
 */
/** 构造语义检索 query 文本（标题 + 梗概 + 钩子 + mustDo + 检索词） */
export function buildMemoryQueryBlob(input: MemoryQueryInput): string {
  const terms = extractMemoryQueryTerms({
    chapter: input.chapter,
    characters: input.characters,
    intent: input.chapter.intent,
  });
  return [
    input.chapter.title,
    input.chapter.summary,
    input.chapter.intent?.endingHook,
    ...(input.chapter.intent?.mustDo || []),
    ...terms,
  ]
    .filter(Boolean)
    .join('\n');
}

export function retrieveMemoryForChapter(input: MemoryQueryInput): MemoryRetrievalResult {
  const chapterNumber = input.chapterNumber ?? input.chapter.number;
  const budget = longformInjectionBudget(chapterNumber);
  const isLongform = chapterNumber >= 30;
  const isEpic = chapterNumber >= 100;
  const maxFacts = input.maxFacts ?? budget.maxFacts;
  const maxThreads = input.maxThreads ?? budget.maxThreads;
  const maxDigests = budget.maxDigests;
  const memory = normalizeStoryMemory(input.memory || undefined);
  const terms = extractMemoryQueryTerms({
    chapter: input.chapter,
    characters: input.characters,
    intent: input.chapter.intent,
  });

  const queryBlob = buildMemoryQueryBlob(input);

  const semantic =
    input.disableSemantic === true
      ? null
      : input.semantic ??
        semanticBoostMap(queryBlob, {
          memory,
          chapters: input.allChapters || [],
          chapterNumber,
        });

  const chars = input.characters || [];
  const validFacts = listActiveFacts(memory)
    .filter((f) => isFactValidAt(f, chapterNumber))
    .map((f) =>
      f.subject
        ? f
        : { ...f, subject: inferFactSubject(f, chars) || f.subject }
    );
  const activeThreads = listActiveThreads(memory);
  const involvedIds = input.chapter.involvedCharacterIds || [];
  // 出场角色硬关联事实（AI 长跑：远章铁律不被挤掉）
  const linkedPool = factsLinkedToCharacters(validFacts, chars, involvedIds);
  const linkedIds = new Set(linkedPool.map((f) => f.id));

  const scoredFacts: ScoredFact[] = validFacts.map((fact) => {
    const reasons: string[] = [];
    let score = 0;
    const blob = `${fact.subject || ''} ${fact.text} ${fact.note || ''}`;
    const m = scoreTextMatch(blob, terms);
    score += m.score;
    if (m.hits.length) reasons.push(`词项:${m.hits.slice(0, 3).join('/')}`);
    // 新近事实略加权
    const src = fact.sourceChapterNumber ?? fact.validFromChapter ?? 0;
    if (src > 0 && chapterNumber - src <= 5) {
      score += 1;
      reasons.push('近章');
    }
    // subject / 正文命中出场角色 → 强加权（硬捞池）
    if (linkedIds.has(fact.id)) {
      score += 6;
      reasons.push('角色索引');
    } else if (fact.subject && chars.length) {
      const names = chars
        .filter((c) => involvedIds.includes(c.id))
        .map((c) => c.name);
      if (names.some((n) => fact.subject!.includes(n) || n.includes(fact.subject!))) {
        score += 4;
        reasons.push('出场角色');
      }
    }
    const sem = semantic?.factBoost.get(fact.id) || 0;
    if (sem > 0.15) {
      score += sem;
      reasons.push('语义');
    }
    // 无词项时保底分（仍可按近章排序）
    if (terms.length === 0) score += 1;
    return { fact, score, reasons };
  });

  scoredFacts.sort((a, b) => b.score - a.score || (b.fact.sourceChapterNumber || 0) - (a.fact.sourceChapterNumber || 0));

  const scoredThreads: ScoredThread[] = activeThreads.map((thread) => {
    const reasons: string[] = [];
    let score = 0;
    const silence = threadSilence(thread, chapterNumber);
    const debt = isDebtThread(thread, chapterNumber, input.debtThresholds);
    const m = scoreTextMatch(`${thread.text} ${thread.note || ''} ${thread.seedExcerpt || ''}`, terms);
    score += m.score;
    if (m.hits.length) reasons.push(`词项:${m.hits.slice(0, 3).join('/')}`);
    if (thread.status === 'progressing') {
      score += 2;
      reasons.push('推进中');
    }
    if (thread.coreHook) {
      score += 3;
      reasons.push('主线伏笔');
    }
    if (debt) {
      score += 8; // 债务强制入选
      reasons.push(`债务静默${silence}章`);
    }
    const sem = semantic?.threadBoost.get(thread.id) || 0;
    if (sem > 0.15) {
      score += sem;
      reasons.push('语义');
    }
    if (terms.length === 0) score += 1;
    return { thread, score, silence, isDebt: debt, reasons };
  });

  scoredThreads.sort((a, b) => b.score - a.score || b.silence - a.silence);

  // 债务全部入选，再补相关
  const debtThreads = scoredThreads.filter((t) => t.isDebt);
  const selectedThreadMap = new Map<string, ScoredThread>();
  for (const d of debtThreads) selectedThreadMap.set(d.thread.id, d);
  for (const t of scoredThreads) {
    if (selectedThreadMap.size >= maxThreads) break;
    selectedThreadMap.set(t.thread.id, t);
  }
  const selectedThreads = [...selectedThreadMap.values()].sort(
    (a, b) => Number(b.isDebt) - Number(a.isDebt) || b.score - a.score
  );

  // 事实：硬保留「角色索引」配额，再填相关
  const charReserve = Math.min(
    linkedPool.length,
    Math.max(3, Math.floor(maxFacts * (isEpic ? 0.45 : 0.35)))
  );
  const charScored = scoredFacts
    .filter((f) => linkedIds.has(f.fact.id))
    .slice(0, charReserve);
  const restSlots = Math.max(0, maxFacts - charScored.length);
  const restScored = scoredFacts
    .filter((f) => !linkedIds.has(f.fact.id) && f.score > 0)
    .slice(0, restSlots);
  let selectedFacts = [...charScored, ...restScored];
  // 去重保序
  {
    const seen = new Set<string>();
    selectedFacts = selectedFacts.filter((f) => {
      if (seen.has(f.fact.id)) return false;
      seen.add(f.fact.id);
      return true;
    });
  }
  let source: 'retrieval' | 'fallback_all' = 'retrieval';
  if (selectedFacts.length === 0 && scoredFacts.length > 0) {
    selectedFacts = scoredFacts
      .slice()
      .sort(
        (a, b) =>
          (b.fact.sourceChapterNumber || 0) - (a.fact.sourceChapterNumber || 0)
      )
      .slice(0, maxFacts)
      .map((f) => ({ ...f, reasons: [...f.reasons, '近章兜底'] }));
    source = terms.length === 0 ? 'fallback_all' : 'retrieval';
  }
  if (selectedThreads.length === 0 && scoredThreads.length > 0) {
    // 至少塞几条活跃伏笔
    for (const t of scoredThreads.slice(0, Math.min(5, maxThreads))) {
      selectedThreadMap.set(t.thread.id, t);
    }
  }

  const finalThreads = [...selectedThreadMap.values()].sort(
    (a, b) => Number(b.isDebt) - Number(a.isDebt) || b.score - a.score
  );

  // 摘要：词项选择 + 语义 boost 重排
  let digests = selectRelevantDigests(
    memory.spanDigests,
    terms,
    chapterNumber,
    maxDigests
  );
  if (semantic && memory.spanDigests?.length) {
    const boosted = memory.spanDigests
      .filter((d) => d.toChapter < chapterNumber)
      .map((d) => ({
        d,
        score: (semantic.digestBoost.get(d.id) || 0) + (digests.some((x) => x.id === d.id) ? 2 : 0),
      }))
      .filter((x) => x.score > 0.2)
      .sort((a, b) => b.score - a.score);
    if (boosted.length) {
      const merged = new Map<string, StorySpanDigest>();
      for (const d of digests) merged.set(d.id, d);
      for (const b of boosted.slice(0, maxDigests)) merged.set(b.d.id, b.d);
      // 保持 selectRelevant 的分层配额优先，语义只补充
      digests = [
        ...digests,
        ...boosted.map((b) => b.d).filter((d) => !digests.some((x) => x.id === d.id)),
      ].slice(0, maxDigests);
    }
  }

  const relatedChapters = semantic?.relatedChapters || [];
  const digestBlock = formatDigestsForPrompt(digests, maxDigests);
  const relatedBlock = formatRelatedChaptersForPrompt(relatedChapters);

  const entityBlock = formatEntitiesForPrompt(memory);
  const promptBlock = [
    formatRetrievedMemoryPrompt(selectedFacts, finalThreads, debtThreads),
    entityBlock,
    digestBlock,
    relatedBlock,
  ]
    .filter(Boolean)
    .join('\n\n');

  const previewParts: string[] = [];
  previewParts.push(`事实${selectedFacts.length}`);
  previewParts.push(`伏笔${finalThreads.length}`);
  if (debtThreads.length) previewParts.push(`债务${debtThreads.length}`);
  if (digests.length) previewParts.push(`摘要${digests.length}`);
  if (relatedChapters.length) previewParts.push(`相关章${relatedChapters.length}`);
  if (semantic) previewParts.push('语义');
  if (terms.length) previewParts.push(`词:${terms.slice(0, 4).join('/')}`);
  const tierHint = isEpic
    ? 'AI长跑：热=债务+角色/语义 · 温=弧/rolling · 冷=mega/super+相关章'
    : isLongform
      ? '长篇：热=债务+角色/语义 · 温=弧/滚动 · 冷=digest'
      : digests.length || relatedChapters.length
        ? '已注入摘要/语义相关章'
        : '短中篇：近章热记忆为主';

  const snapshot: MemoryInjectionSnapshot = {
    generatedAt: new Date().toISOString(),
    chapterNumber,
    queryTerms: terms,
    selectedFactIds: selectedFacts.map((f) => f.fact.id),
    selectedThreadIds: finalThreads.map((t) => t.thread.id),
    debtThreadIds: debtThreads.map((t) => t.thread.id),
    selectedDigestIds: digests.map((d) => d.id),
    relatedChapterNumbers: relatedChapters.map((r) => r.chapter.number),
    factCount: selectedFacts.length,
    threadCount: finalThreads.length,
    debtCount: debtThreads.length,
    digestCount: digests.length,
    preview: previewParts.join(' · '),
    source,
    tierHint,
    semanticUsed: !!semantic,
  };

  return {
    queryTerms: terms,
    facts: selectedFacts,
    threads: finalThreads,
    debtThreads,
    digests,
    relatedChapters,
    promptBlock,
    snapshot,
    source,
  };
}

export function formatRetrievedMemoryPrompt(
  facts: ScoredFact[],
  threads: ScoredThread[],
  debtThreads: ScoredThread[]
): string {
  const lines: string[] = [];

  if (debtThreads.length > 0) {
    lines.push('【伏笔债务（本章必须推进 / 回收 / 明确延期，禁止无故消失）】');
    debtThreads.forEach((t, i) => {
      const seed = t.thread.seedExcerpt?.trim()
        ? ` · 埋线摘录：「${t.thread.seedExcerpt.trim().slice(0, 80)}」`
        : '';
      lines.push(
        `${i + 1}. [静默${t.silence}章·${t.thread.status}${t.thread.coreHook ? '·主线' : ''}] ${t.thread.text}${seed}`
      );
    });
    lines.push('');
  }

  lines.push('【已钉死事实（相关检索 · 绝对禁止推翻）】');
  if (!facts.length) {
    lines.push('（本章检索未命中钉死事实；仍不得与上章 recap / 正文已写事实冲突。）');
  } else {
    facts.forEach((f, i) => {
      const src =
        f.fact.sourceChapterNumber != null ? `（第${f.fact.sourceChapterNumber}章）` : '';
      const sub = f.fact.subject ? `[${f.fact.subject}] ` : '';
      const why = f.reasons.length ? ` · ${f.reasons.slice(0, 2).join(',')}` : '';
      lines.push(`${i + 1}. ${sub}${f.fact.text}${src}${why}`);
    });
  }

  lines.push('');
  lines.push('【未收伏笔 / 线索（相关 + 债务优先）】');
  if (!threads.length) {
    lines.push('（暂无未收伏笔。）');
  } else {
    threads.forEach((t, i) => {
      const st =
        t.thread.status === 'progressing'
          ? '推进中'
          : t.thread.status === 'deferred'
            ? '延期'
            : '未收';
      const debt = t.isDebt ? '·债务' : '';
      const ch =
        t.thread.introducedChapterNumber != null
          ? `起自第${t.thread.introducedChapterNumber}章`
          : '';
      const seed = t.thread.seedExcerpt?.trim()
        ? `\n   埋线：「${t.thread.seedExcerpt.trim().slice(0, 100)}」`
        : '';
      lines.push(
        `${i + 1}. [${st}${debt}] ${t.thread.text}${ch ? ` · ${ch}` : ''}${seed}`
      );
    });
  }

  return lines.join('\n');
}

/** 全书债务概览（UI） */
export function listMemoryDebts(
  memory: StoryMemory | null | undefined,
  chapterNumber: number,
  thresholds?: MemoryQueryInput['debtThresholds']
): ScoredThread[] {
  const threads = listActiveThreads(memory);
  return threads
    .map((thread) => {
      const silence = threadSilence(thread, chapterNumber);
      const isDebt = isDebtThread(thread, chapterNumber, thresholds);
      return {
        thread,
        score: silence,
        silence,
        isDebt,
        reasons: isDebt ? [`静默${silence}章`] : [],
      };
    })
    .filter((t) => t.isDebt)
    .sort((a, b) => b.silence - a.silence);
}

/** 从检索结果拼完整写前记忆块（含角色表） */
export function formatStoryMemoryFromRetrieval(
  retrieval: MemoryRetrievalResult,
  characters: Character[],
  options?: {
    characterIds?: string[];
    authorNotes?: string;
    formatCharacterStateTable: (
      characters: Character[],
      options?: { max?: number; onlyIds?: string[] }
    ) => string;
  }
): string {
  const lines: string[] = [];
  lines.push('【角色当前状态表（写本章不得无故违背）】');
  if (options?.formatCharacterStateTable) {
    lines.push(
      options.formatCharacterStateTable(characters, {
        max: 10,
        onlyIds: options.characterIds,
      })
    );
  }
  lines.push('');
  lines.push(retrieval.promptBlock);
  if (options?.authorNotes?.trim()) {
    lines.push('');
    lines.push('【作者备忘】');
    lines.push(options.authorNotes.trim().slice(0, 400));
  }
  lines.push('');
  lines.push(
    `【记忆检索元数据】${retrieval.snapshot.preview} · 模式=${retrieval.source}`
  );
  return lines.join('\n');
}
