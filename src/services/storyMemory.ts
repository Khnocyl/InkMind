import type {
  Character,
  ChapterRecap,
  HookResolveSuggestion,
  PinnedFact,
  PlotThread,
  PlotThreadStatus,
  StoryMemory,
  StorySpanDigest,
  StorySpanDigestKind,
  WorldEntityState,
} from '../types/novel';
import {
  formatFactLedgerForPrompt,
  formatTimelineForPrompt,
  normalizeFactLedger,
} from './factLedger';

export function emptyStoryMemory(): StoryMemory {
  return {
    pinnedFacts: [],
    openThreads: [],
    spanDigests: [],
    locations: [],
    items: [],
    factLedger: { assertions: [], recentSnapshots: [], updatedAt: new Date().toISOString() },
    digestBlockSize: 10,
    megaBlockSize: 50,
    superBlockSize: 100,
    pendingHookResolves: [],
    authorNotes: '',
    updatedAt: new Date().toISOString(),
  };
}

function normalizeEntity(raw: unknown, kind: 'location' | 'item'): WorldEntityState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = String(r.name || '').trim();
  if (name.length < 2) return null;
  return {
    id: String(r.id || `${kind}-${name.slice(0, 20)}`),
    kind: r.kind === 'item' || r.kind === 'location' ? r.kind : kind,
    name: name.slice(0, 24),
    status: typeof r.status === 'string' ? r.status.slice(0, 80) : undefined,
    note: typeof r.note === 'string' ? r.note.slice(0, 120) : undefined,
    lastChapterNumber:
      typeof r.lastChapterNumber === 'number' ? r.lastChapterNumber : undefined,
    updatedAt: String(r.updatedAt || new Date().toISOString()),
  };
}

function normalizeDigestKind(raw: unknown): StorySpanDigestKind {
  if (
    raw === 'volume' ||
    raw === 'mega' ||
    raw === 'super' ||
    raw === 'arc' ||
    raw === 'rolling'
  ) {
    return raw;
  }
  return 'rolling';
}

function normalizeDigest(raw: unknown, index: number): StorySpanDigest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const fromChapter = typeof r.fromChapter === 'number' ? r.fromChapter : 0;
  const toChapter = typeof r.toChapter === 'number' ? r.toChapter : 0;
  if (toChapter < fromChapter || toChapter <= 0) return null;
  return {
    id: String(r.id || `digest-${fromChapter}-${toChapter}-${index}`),
    fromChapter,
    toChapter,
    kind: normalizeDigestKind(r.kind),
    title: String(r.title || `第${fromChapter}–${toChapter}章`).slice(0, 80),
    summary: String(r.summary || '').slice(0, 800),
    keyFacts: Array.isArray(r.keyFacts)
      ? r.keyFacts.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 24)
      : [],
    openHooks: Array.isArray(r.openHooks)
      ? r.openHooks.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 12)
      : [],
    charactersMentioned: Array.isArray(r.charactersMentioned)
      ? r.charactersMentioned.map(String).slice(0, 20)
      : [],
    updatedAt: String(r.updatedAt || new Date().toISOString()),
    source: r.source === 'llm' ? 'llm' : r.source === 'heuristic' ? 'heuristic' : undefined,
    llmPolishedAt:
      typeof r.llmPolishedAt === 'string' && r.llmPolishedAt
        ? r.llmPolishedAt
        : undefined,
  };
}

function normalizeHookResolve(raw: unknown): HookResolveSuggestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const threadId = String(r.threadId || '').trim();
  const threadText = String(r.threadText || '').trim();
  if (!threadId || !threadText) return null;
  const conf = r.confidence;
  return {
    threadId,
    threadText: threadText.slice(0, 300),
    reason: String(r.reason || '').slice(0, 200),
    confidence: conf === 'high' || conf === 'low' || conf === 'medium' ? conf : 'medium',
    sourceChapterNumber:
      typeof r.sourceChapterNumber === 'number' ? r.sourceChapterNumber : 0,
    suggestedAt: String(r.suggestedAt || new Date().toISOString()),
  };
}

export function normalizeStoryMemory(raw: unknown): StoryMemory {
  const base = emptyStoryMemory();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const facts = Array.isArray(r.pinnedFacts) ? r.pinnedFacts : [];
  const threads = Array.isArray(r.openThreads) ? r.openThreads : [];
  const digests = Array.isArray(r.spanDigests) ? r.spanDigests : [];
  const resolves = Array.isArray(r.pendingHookResolves) ? r.pendingHookResolves : [];
  const locations = Array.isArray(r.locations) ? r.locations : [];
  const items = Array.isArray(r.items) ? r.items : [];

  return {
    pinnedFacts: facts
      .map((f, i) => normalizeFact(f, i))
      .filter((f): f is PinnedFact => !!f),
    openThreads: threads
      .map((t, i) => normalizeThread(t, i))
      .filter((t): t is PlotThread => !!t),
    spanDigests: digests
      .map((d, i) => normalizeDigest(d, i))
      .filter((d): d is StorySpanDigest => !!d),
    locations: locations
      .map((e) => normalizeEntity(e, 'location'))
      .filter((e): e is WorldEntityState => !!e)
      .slice(0, 40),
    items: items
      .map((e) => normalizeEntity(e, 'item'))
      .filter((e): e is WorldEntityState => !!e)
      .slice(0, 40),
    factLedger: normalizeFactLedger(r.factLedger),
    digestBlockSize:
      typeof r.digestBlockSize === 'number' && r.digestBlockSize >= 5
        ? Math.min(20, Math.floor(r.digestBlockSize))
        : 10,
    megaBlockSize:
      typeof r.megaBlockSize === 'number' && r.megaBlockSize >= 30
        ? Math.min(80, Math.floor(r.megaBlockSize))
        : 50,
    superBlockSize:
      typeof r.superBlockSize === 'number' && r.superBlockSize >= 60
        ? Math.min(150, Math.floor(r.superBlockSize))
        : 100,
    pendingHookResolves: resolves
      .map((x) => normalizeHookResolve(x))
      .filter((x): x is HookResolveSuggestion => !!x)
      .slice(-30),
    authorNotes: typeof r.authorNotes === 'string' ? r.authorNotes : '',
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : base.updatedAt,
  };
}

function normalizeFact(raw: unknown, index: number): PinnedFact | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = String(r.text || '').trim();
  if (!text) return null;
  const sourceChapterNumber =
    typeof r.sourceChapterNumber === 'number' ? r.sourceChapterNumber : undefined;
  const validFromChapter =
    typeof r.validFromChapter === 'number'
      ? r.validFromChapter
      : sourceChapterNumber;
  const validUntilChapter =
    typeof r.validUntilChapter === 'number'
      ? r.validUntilChapter
      : r.validUntilChapter === null
        ? null
        : undefined;
  return {
    id: String(r.id || `fact-${Date.now()}-${index}`),
    text: text.slice(0, 300),
    sourceChapterNumber,
    validFromChapter,
    validUntilChapter,
    subject: typeof r.subject === 'string' ? r.subject.slice(0, 40) : undefined,
    createdAt: String(r.createdAt || new Date().toISOString()),
    status: r.status === 'superseded' ? 'superseded' : 'pinned',
    note: typeof r.note === 'string' ? r.note : undefined,
  };
}

function normalizeThread(raw: unknown, index: number): PlotThread | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = String(r.text || '').trim();
  if (!text) return null;
  const allowed: PlotThreadStatus[] = ['open', 'progressing', 'resolved', 'deferred'];
  const status = allowed.includes(r.status as PlotThreadStatus)
    ? (r.status as PlotThreadStatus)
    : 'open';
  return {
    id: String(r.id || `thread-${Date.now()}-${index}`),
    text: text.slice(0, 300),
    status,
    introducedChapterNumber:
      typeof r.introducedChapterNumber === 'number' ? r.introducedChapterNumber : undefined,
    lastTouchedChapterNumber:
      typeof r.lastTouchedChapterNumber === 'number' ? r.lastTouchedChapterNumber : undefined,
    createdAt: String(r.createdAt || new Date().toISOString()),
    resolvedAt: typeof r.resolvedAt === 'string' ? r.resolvedAt : undefined,
    note: typeof r.note === 'string' ? r.note : undefined,
    coreHook: r.coreHook === true,
    seedExcerpt:
      typeof r.seedExcerpt === 'string' ? r.seedExcerpt.slice(0, 200) : undefined,
  };
}

function normalizeTextKey(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase().slice(0, 80);
}

function similarEnough(a: string, b: string): boolean {
  const x = normalizeTextKey(a);
  const y = normalizeTextKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 8 && y.includes(x)) return true;
  if (y.length >= 8 && x.includes(y)) return true;
  return false;
}

/** 活跃（未作废）的钉死事实 */
export function listActiveFacts(memory?: StoryMemory | null): PinnedFact[] {
  return (memory?.pinnedFacts || []).filter((f) => f.status === 'pinned');
}

/** 未收束伏笔（open + progressing + deferred） */
export function listActiveThreads(memory?: StoryMemory | null): PlotThread[] {
  return (memory?.openThreads || []).filter(
    (t) => t.status === 'open' || t.status === 'progressing' || t.status === 'deferred'
  );
}

/**
 * 将章末 recap 合并进书级记忆。
 * - keyFacts → 追加钉死事实（去重）
 * - openThreads → 追加未收伏笔（去重）
 * 不自动删除作者手改内容。
 */
export function mergeRecapIntoMemory(
  memory: StoryMemory | null | undefined,
  recap: ChapterRecap,
  chapterNumber: number
): { memory: StoryMemory; addedFacts: number; addedThreads: number } {
  const next = normalizeStoryMemory(memory || emptyStoryMemory());
  let addedFacts = 0;
  let addedThreads = 0;
  const now = new Date().toISOString();

  // 防记忆污染（万古烬天 ch1 误报案例的根因之一）：recap 来自**当前版**正文，
  // 同一章旧版自动派生的事实在此先行作废——否则旧稿事实残留记忆库，后续章节
  // 的硬伤审会拿「新正文 vs 旧记忆」比对，产出幻觉硬伤。
  // 仅作废 id 为 fact-{chapterNumber}-* 的自动派生事实；作者手钉（fact-manual-*）永不自动作废。
  const chapterFactPrefix = `fact-${chapterNumber}-`;
  for (const f of next.pinnedFacts) {
    if (f.status === 'pinned' && f.sourceChapterNumber === chapterNumber && f.id.startsWith(chapterFactPrefix)) {
      f.status = 'superseded';
      f.note = (f.note ? f.note + ' ' : '') + '[自动作废：本章重写，旧版事实失效]';
    }
  }

  for (const raw of recap.keyFacts || []) {
    const text = String(raw).trim();
    if (text.length < 4) continue;
    const exists = next.pinnedFacts.some(
      (f) => f.status === 'pinned' && similarEnough(f.text, text)
    );
    if (exists) continue;
    next.pinnedFacts.push({
      id: `fact-${chapterNumber}-${Date.now()}-${addedFacts}`,
      text: text.slice(0, 300),
      sourceChapterNumber: chapterNumber,
      validFromChapter: chapterNumber,
      validUntilChapter: null,
      createdAt: now,
      status: 'pinned',
    });
    addedFacts += 1;
  }

  const seedFromRecap = (recap.endingState || recap.text || '').trim().slice(0, 120);

  for (const raw of recap.openThreads || []) {
    const text = String(raw).trim();
    if (text.length < 4) continue;
    const exists = next.openThreads.some(
      (t) =>
        t.status !== 'resolved' &&
        similarEnough(t.text, text)
    );
    if (exists) {
      // 触碰已有伏笔：标记 progressing
      const hit = next.openThreads.find(
        (t) => t.status !== 'resolved' && similarEnough(t.text, text)
      );
      if (hit) {
        if (hit.status === 'open') hit.status = 'progressing';
        hit.lastTouchedChapterNumber = chapterNumber;
        if (!hit.seedExcerpt && seedFromRecap) {
          hit.seedExcerpt = seedFromRecap;
        }
      }
      continue;
    }
    next.openThreads.push({
      id: `thread-${chapterNumber}-${Date.now()}-${addedThreads}`,
      text: text.slice(0, 300),
      status: 'open',
      introducedChapterNumber: chapterNumber,
      lastTouchedChapterNumber: chapterNumber,
      createdAt: now,
      seedExcerpt: seedFromRecap || undefined,
    });
    addedThreads += 1;
  }

  // 轻量上限：百章级真正的归档在 consolidateMemoryAfterChapter（进 digest）
  // 这里只防极端膨胀
  const activeFacts = next.pinnedFacts.filter((f) => f.status === 'pinned');
  if (activeFacts.length > 150) {
    const drop = activeFacts.length - 150;
    let dropped = 0;
    for (const f of next.pinnedFacts) {
      if (f.status === 'pinned' && dropped < drop) {
        f.status = 'superseded';
        f.note = (f.note || '') + ' [自动归档：超出硬上限]';
        dropped += 1;
      }
    }
  }
  const activeThreads = next.openThreads.filter((t) => t.status !== 'resolved');
  if (activeThreads.length > 60) {
    const sorted = [...activeThreads].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    const overflow = sorted.slice(0, activeThreads.length - 60);
    for (const t of overflow) {
      if (t.status === 'open' && !t.coreHook) t.status = 'deferred';
    }
  }

  next.updatedAt = now;
  return { memory: next, addedFacts, addedThreads };
}

/** 角色状态表（由角色卡投影，供 prompt / UI） */
export function formatCharacterStateTable(
  characters: Character[],
  options?: { max?: number; onlyIds?: string[] }
): string {
  let list = characters || [];
  if (options?.onlyIds?.length) {
    const set = new Set(options.onlyIds);
    list = list.filter((c) => set.has(c.id));
  }
  const max = options?.max ?? 12;
  if (!list.length) return '（暂无角色状态）';
  return list
    .slice(0, max)
    .map((c) => {
      const bits = [
        `【${c.name}】`,
        `身份/境界：${c.realmOrTitle || '—'}`,
        `状态：${c.status || '—'}`,
        `所在：${c.currentLocation || '—'}`,
      ];
      if (c.secretNotes?.trim()) {
        bits.push(`暗线：${c.secretNotes.trim().slice(0, 60)}`);
      }
      return bits.join(' · ');
    })
    .join('\n');
}

/**
 * 组装写前注入的记忆块（权威源）。
 * 手改条目与角色状态优先于章内临时 recap。
 *
 * 推荐：先 `retrieveMemoryForChapter`，再把 `retrievalPromptBlock` 传入本函数；
 * 不传时回退「近条列表」（兼容局部精修等轻调用）。
 */
export function formatStoryMemoryForPrompt(
  memory: StoryMemory | null | undefined,
  characters: Character[],
  options?: {
    maxFacts?: number;
    maxThreads?: number;
    characterIds?: string[];
    /** 相关检索 + 债务 的 prompt 块（来自 memoryRetrieval） */
    retrievalPromptBlock?: string;
  }
): string {
  const maxFacts = options?.maxFacts ?? 12;
  const maxThreads = options?.maxThreads ?? 10;
  const lines: string[] = [];

  lines.push('【角色当前状态表（写本章不得无故违背）】');
  lines.push(
    formatCharacterStateTable(characters, {
      max: 10,
      onlyIds: options?.characterIds,
    })
  );

  const ledgerBlock = formatFactLedgerForPrompt(memory?.factLedger, 16);
  if (ledgerBlock) {
    lines.push('');
    lines.push(ledgerBlock);
  }
  const timeBlock = formatTimelineForPrompt(memory?.factLedger, 6);
  if (timeBlock) {
    lines.push('');
    lines.push(timeBlock);
  }

  if (options?.retrievalPromptBlock?.trim()) {
    lines.push('');
    lines.push(options.retrievalPromptBlock.trim());
  } else {
    const facts = listActiveFacts(memory).slice(-maxFacts);
    lines.push('');
    lines.push('【已钉死事实（绝对禁止推翻 / 遗忘）】');
    if (!facts.length) {
      lines.push('（暂无书级钉死事实；请勿与上章 recap 及正文已写事实冲突。）');
    } else {
      facts.forEach((f, i) => {
        const src =
          f.sourceChapterNumber != null ? `（源自第${f.sourceChapterNumber}章）` : '';
        const sub = f.subject ? `[${f.subject}] ` : '';
        lines.push(`${i + 1}. ${sub}${f.text}${src}`);
      });
    }

    const threads = listActiveThreads(memory).slice(0, maxThreads);
    lines.push('');
    lines.push('【未收伏笔 / 线索（应推进、回收或明确延期，禁止无故消失）】');
    if (!threads.length) {
      lines.push('（暂无未收伏笔记录。）');
    } else {
      threads.forEach((t, i) => {
        const st =
          t.status === 'progressing'
            ? '推进中'
            : t.status === 'deferred'
              ? '延期'
              : '未收';
        const ch =
          t.introducedChapterNumber != null ? `起自第${t.introducedChapterNumber}章` : '';
        const seed = t.seedExcerpt?.trim()
          ? ` · 埋线：「${t.seedExcerpt.trim().slice(0, 60)}」`
          : '';
        lines.push(`${i + 1}. [${st}] ${t.text}${ch ? ` · ${ch}` : ''}${seed}`);
      });
    }
  }

  if (memory?.authorNotes?.trim()) {
    lines.push('');
    lines.push('【作者备忘】');
    lines.push(memory.authorNotes.trim().slice(0, 400));
  }

  return lines.join('\n');
}

/** 作废事实（时序截止 + superseded） */
export function invalidatePinnedFact(
  memory: StoryMemory,
  factId: string,
  untilChapter: number,
  note?: string
): StoryMemory {
  const next = normalizeStoryMemory(memory);
  next.pinnedFacts = next.pinnedFacts.map((f) =>
    f.id === factId
      ? {
          ...f,
          status: 'superseded' as const,
          validUntilChapter: untilChapter,
          note: [f.note, note || `自第${untilChapter}章起失效`].filter(Boolean).join(' '),
        }
      : f
  );
  next.updatedAt = new Date().toISOString();
  return next;
}

export function addPinnedFact(
  memory: StoryMemory | null | undefined,
  text: string,
  sourceChapterNumber?: number
): StoryMemory {
  const next = normalizeStoryMemory(memory || emptyStoryMemory());
  const t = text.trim();
  if (!t) return next;
  if (next.pinnedFacts.some((f) => f.status === 'pinned' && similarEnough(f.text, t))) {
    return next;
  }
  next.pinnedFacts.push({
    id: `fact-manual-${Date.now()}`,
    text: t.slice(0, 300),
    sourceChapterNumber,
    validFromChapter: sourceChapterNumber,
    validUntilChapter: null,
    createdAt: new Date().toISOString(),
    status: 'pinned',
  });
  next.updatedAt = new Date().toISOString();
  return next;
}

export function addPlotThread(
  memory: StoryMemory | null | undefined,
  text: string,
  introducedChapterNumber?: number
): StoryMemory {
  const next = normalizeStoryMemory(memory || emptyStoryMemory());
  const t = text.trim();
  if (!t) return next;
  next.openThreads.push({
    id: `thread-manual-${Date.now()}`,
    text: t.slice(0, 300),
    status: 'open',
    introducedChapterNumber,
    lastTouchedChapterNumber: introducedChapterNumber,
    createdAt: new Date().toISOString(),
  });
  next.updatedAt = new Date().toISOString();
  return next;
}

export function updateFactStatus(
  memory: StoryMemory,
  factId: string,
  status: PinnedFact['status']
): StoryMemory {
  const next = normalizeStoryMemory(memory);
  next.pinnedFacts = next.pinnedFacts.map((f) =>
    f.id === factId ? { ...f, status } : f
  );
  next.updatedAt = new Date().toISOString();
  return next;
}

export function updateThreadStatus(
  memory: StoryMemory,
  threadId: string,
  status: PlotThreadStatus,
  touchChapterNumber?: number
): StoryMemory {
  const next = normalizeStoryMemory(memory);
  next.openThreads = next.openThreads.map((t) => {
    if (t.id !== threadId) return t;
    return {
      ...t,
      status,
      lastTouchedChapterNumber:
        status === 'resolved' || status === 'progressing' || status === 'deferred'
          ? touchChapterNumber ?? t.lastTouchedChapterNumber
          : t.lastTouchedChapterNumber,
      resolvedAt: status === 'resolved' ? new Date().toISOString() : t.resolvedAt,
    };
  });
  next.updatedAt = new Date().toISOString();
  return next;
}

export function removeFact(memory: StoryMemory, factId: string): StoryMemory {
  const next = normalizeStoryMemory(memory);
  next.pinnedFacts = next.pinnedFacts.filter((f) => f.id !== factId);
  next.updatedAt = new Date().toISOString();
  return next;
}

export function removeThread(memory: StoryMemory, threadId: string): StoryMemory {
  const next = normalizeStoryMemory(memory);
  next.openThreads = next.openThreads.filter((t) => t.id !== threadId);
  next.updatedAt = new Date().toISOString();
  return next;
}

export function memorySummaryCounts(memory?: StoryMemory | null): {
  facts: number;
  threads: number;
  resolvedThreads: number;
} {
  return {
    facts: listActiveFacts(memory).length,
    threads: listActiveThreads(memory).length,
    resolvedThreads: (memory?.openThreads || []).filter((t) => t.status === 'resolved').length,
  };
}
