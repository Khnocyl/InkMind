import React, { useMemo, useState } from 'react';
import { proseWords } from '../../services/proseWords';
import type { Character, StoryMemory } from '../../types/novel';
import {
  addPinnedFact,
  addPlotThread,
  emptyStoryMemory,
  formatCharacterStateTable,
  invalidatePinnedFact,
  listActiveFacts,
  listActiveThreads,
  memorySummaryCounts,
  normalizeStoryMemory,
  removeFact,
  removeThread,
  updateThreadStatus,
} from '../../services/storyMemory';
import { listMemoryDebts, threadSilence } from '../../services/memoryRetrieval';
import {
  acceptHookResolve,
  consolidateMemoryAfterChapter,
  dismissHookResolve,
  longformMemoryHealth,
  polishEpochDigestsWithLlm,
} from '../../services/longformMemory';
import { entitySummaryCounts } from '../../services/entityState';
import {
  addManualAssertion,
  enrichSnapshotWithLlm,
  extractChapterFactSnapshot,
  factLedgerSummaryCounts,
  listActiveAssertions,
  mergeSnapshotIntoMemory,
  pinDeathAssertion,
  removeAssertion,
  retractAssertion,
  syncDeathsBidirectional,
  syncLedgerEntitiesToMemory,
} from '../../services/factLedger';
import type { FactAssertionKind } from '../../types/novel';
import {
  BookOpen,
  Brain,
  Plus,
  Trash2,
  CheckCircle2,
  PauseCircle,
  Pin,
  GitBranch,
  Users,
  AlertTriangle,
  Star,
  Layers,
  RefreshCw,
  Sparkles,
  Ban,
  Loader2,
} from 'lucide-react';

interface MemoryManagerProps {
  memory?: StoryMemory | null;
  characters: Character[];
  currentChapterNumber?: number;
  /** 全书章节：用于重建百章滚动摘要 */
  chapters?: import('../../types/novel').Chapter[];
  volumes?: import('../../types/novel').Volume[];
  onUpdateMemory: (memory: StoryMemory) => void;
  /**
   * 同时更新记忆+角色（避免分两次 persist 竞态）。
   * 死亡同步优先走这个。
   */
  onPatchBible?: (patch: {
    memory?: StoryMemory;
    characters?: Character[];
  }) => void;
}

export const MemoryManager: React.FC<MemoryManagerProps> = ({
  memory,
  characters,
  currentChapterNumber,
  chapters = [],
  volumes = [],
  onUpdateMemory,
  onPatchBible,
}) => {
  const mem = useMemo(() => normalizeStoryMemory(memory || emptyStoryMemory()), [memory]);
  const counts = memorySummaryCounts(mem);
  const facts = listActiveFacts(mem);
  const threads = listActiveThreads(mem);
  const resolved = (mem.openThreads || []).filter((t) => t.status === 'resolved');
  const chapterN = currentChapterNumber ?? 1;
  const debts = useMemo(() => listMemoryDebts(mem, chapterN), [mem, chapterN]);
  const digests = mem.spanDigests || [];
  const rollingN = digests.filter((d) => d.kind === 'rolling').length;
  const arcN = digests.filter((d) => d.kind === 'arc').length;
  const megaN = digests.filter((d) => d.kind === 'mega').length;
  const superN = digests.filter((d) => d.kind === 'super').length;
  const volumeN = digests.filter((d) => d.kind === 'volume').length;
  const pendingResolves = mem.pendingHookResolves || [];
  const entityCounts = useMemo(() => entitySummaryCounts(mem), [mem]);
  const ledgerCounts = useMemo(
    () => factLedgerSummaryCounts(mem.factLedger),
    [mem.factLedger]
  );
  const activeLedger = useMemo(
    () => listActiveAssertions(mem.factLedger).slice(0, 40),
    [mem.factLedger]
  );
  const timeline = useMemo(() => {
    const tl = [...(mem.factLedger?.timeline || [])].sort(
      (a, b) => b.chapterNumber - a.chapterNumber
    );
    return tl.slice(0, 12);
  }, [mem.factLedger?.timeline]);
  const health = useMemo(
    () => longformMemoryHealth(mem, chapters.length || chapterN),
    [mem, chapters.length, chapterN]
  );

  const [factInput, setFactInput] = useState('');
  const [threadInput, setThreadInput] = useState('');
  const [notes, setNotes] = useState(mem.authorNotes || '');
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [polishBusy, setPolishBusy] = useState(false);
  const [polishMsg, setPolishMsg] = useState<string | null>(null);
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const [ledgerMsg, setLedgerMsg] = useState<string | null>(null);
  const [manualKind, setManualKind] = useState<FactAssertionKind>('death');
  const [manualSubject, setManualSubject] = useState('');
  const [manualClaim, setManualClaim] = useState('');
  const llmDigestN = digests.filter((d) => d.source === 'llm').length;
  const epochPendingN = digests.filter(
    (d) => (d.kind === 'mega' || d.kind === 'super') && d.source !== 'llm'
  ).length;

  const handleRebuildDigests = () => {
    const next = consolidateMemoryAfterChapter(mem, chapters, {
      chapterNumber: chapterN,
      volumes,
    });
    onUpdateMemory(next);
    setPolishMsg('已重建启发式摘要（LLM 纪元总览在同范围下会保留）');
  };

  /** 从已有 recap 的章节重建事实账本（本地启发式） */
  const handleRebuildLedger = () => {
    const withRecap = [...chapters]
      .filter((c) => c.recap && ((c.wordCount || 0) > 50 || proseWords(c.content) > 50))
      .sort((a, b) => a.number - b.number);
    if (!withRecap.length) {
      setLedgerMsg('没有带 recap 的章节可建账本。请先完整闭环写几章。');
      return;
    }
    let next: StoryMemory = {
      ...mem,
      factLedger: {
        assertions: [],
        recentSnapshots: [],
        storyDayCursor: 1,
        timeline: [],
        updatedAt: new Date().toISOString(),
      },
    };
    let total = 0;
    for (const ch of withRecap) {
      const snap = extractChapterFactSnapshot({
        chapter: ch,
        prose: ch.content || '',
        recap: ch.recap,
        characters,
      });
      total += snap.assertions.length;
      next = mergeSnapshotIntoMemory(next, snap);
    }
    const ent = syncLedgerEntitiesToMemory(next);
    next = ent.memory;
    onUpdateMemory(next);
    const c = factLedgerSummaryCounts(next.factLedger);
    setLedgerMsg(
      `账本已重建 · ${withRecap.length} 章 · 抽取 ${total} 条 · 活跃 ${c.active} · 故事日${c.storyDay} · 实体物${ent.itemsUpdated}/地${ent.locationsUpdated}`
    );
  };

  const handleLlmEnrichLatest = async () => {
    if (ledgerBusy) return;
    const ch = [...chapters]
      .filter((c) => (c.content || '').replace(/\s+/g, '').length > 80)
      .sort((a, b) => b.number - a.number)[0];
    if (!ch) {
      setLedgerMsg('没有可补抽的正文。');
      return;
    }
    setLedgerBusy(true);
    setLedgerMsg(`LLM 补抽第${ch.number}章…`);
    try {
      let snap = extractChapterFactSnapshot({
        chapter: ch,
        prose: ch.content || '',
        recap: ch.recap,
        characters,
      });
      snap = await enrichSnapshotWithLlm(snap, {
        chapter: ch,
        prose: ch.content || '',
        recap: ch.recap,
        onProgress: (m) => setLedgerMsg(m),
      });
      const next = mergeSnapshotIntoMemory(mem, snap);
      onUpdateMemory(next);
      setLedgerMsg(
        `第${ch.number}章补抽完成 · 本章 ${snap.assertions.length} 条 · 账本活跃 ${factLedgerSummaryCounts(next.factLedger).active}`
      );
    } catch (e: unknown) {
      setLedgerMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLedgerBusy(false);
    }
  };

  const handleAddManual = (e: React.FormEvent) => {
    e.preventDefault();
    const subject = manualSubject.trim();
    if (!subject) return;
    let claim = manualClaim.trim();
    if (!claim) {
      if (manualKind === 'death') claim = `${subject}已阵亡/退出`;
      else claim = `${subject}`;
    }
    const next =
      manualKind === 'death'
        ? pinDeathAssertion(mem, subject, chapterN)
        : addManualAssertion(mem, {
            kind: manualKind,
            subject,
            claim,
            // 此分支 manualKind 已被收窄为「非 death」，value 恒为 undefined
            value: undefined,
            chapterNumber: chapterN,
          });
    // 手钉死亡：账本 + 匹配角色卡一次落盘
    if (manualKind === 'death' && onPatchBible) {
      const synced = syncDeathsBidirectional(next, characters, chapterN);
      onPatchBible({
        memory: synced.memory,
        characters: synced.toCards.length ? synced.characters : undefined,
      });
      setLedgerMsg(
        synced.toCards.length
          ? `已手钉死亡「${subject}」· 角色卡同步：${synced.toCards.join('、')}`
          : `已手钉死亡「${subject}」（无同名角色卡）`
      );
      setManualSubject('');
      setManualClaim('');
      return;
    }
    onUpdateMemory(next);
    setManualSubject('');
    setManualClaim('');
    setLedgerMsg(`已手钉：${claim.slice(0, 40)}`);
  };

  const handleSyncDeaths = () => {
    const r = syncDeathsBidirectional(mem, characters, chapterN);
    if (onPatchBible) {
      onPatchBible({ memory: r.memory, characters: r.characters });
    } else {
      onUpdateMemory(r.memory);
    }
    setLedgerMsg(
      `死亡同步完成 · 卡→账本 ${r.toLedger.length}（${r.toLedger.join('、') || '无'}）· 账本→卡 ${r.toCards.length}（${r.toCards.join('、') || '无'}）`
    );
  };

  const handleSyncEntities = () => {
    const r = syncLedgerEntitiesToMemory(mem);
    onUpdateMemory(r.memory);
    setLedgerMsg(
      `实体同步完成 · 道具更新 ${r.itemsUpdated} · 地点更新 ${r.locationsUpdated}`
    );
  };

  const handlePolishEpoch = async (force = false) => {
    if (polishBusy) return;
    if (!digests.some((d) => d.kind === 'mega' || d.kind === 'super')) {
      setPolishMsg('暂无 mega/super 摘要。请先写满约 50 章并点「重建摘要」。');
      return;
    }
    setPolishBusy(true);
    setPolishMsg(force ? '强制重跑纪元润色…' : 'LLM 润色纪元摘要…');
    try {
      const result = await polishEpochDigestsWithLlm(mem, {
        maxBlocks: 3,
        force,
        onProgress: (m) => setPolishMsg(m),
      });
      onUpdateMemory(result.memory);
      setPolishMsg(
        result.polished > 0
          ? `纪元润色完成 · ${result.polished} 块` +
              (result.skipped ? ` · 余 ${result.skipped} 可再跑` : '') +
              (result.errors.length ? ` · 失败 ${result.errors.length}` : '')
          : result.errors[0] || '无需润色或全部失败'
      );
    } catch (e: unknown) {
      setPolishMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setPolishBusy(false);
    }
  };

  const superseded = (mem.pinnedFacts || []).filter((f) => f.status === 'superseded');

  const commitNotes = () => {
    onUpdateMemory({
      ...mem,
      authorNotes: notes,
      updatedAt: new Date().toISOString(),
    });
  };

  const handleAddFact = (e: React.FormEvent) => {
    e.preventDefault();
    if (!factInput.trim()) return;
    onUpdateMemory(addPinnedFact(mem, factInput, currentChapterNumber));
    setFactInput('');
  };

  const handleAddThread = (e: React.FormEvent) => {
    e.preventDefault();
    if (!threadInput.trim()) return;
    onUpdateMemory(addPlotThread(mem, threadInput, currentChapterNumber));
    setThreadInput('');
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 lg:p-8 bg-white space-y-8">
      <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Brain className="w-5 h-5 text-violet-600" />
            书级权威记忆
          </h2>
          <p className="text-xs text-slate-600 mt-1 leading-relaxed max-w-2xl">
            <strong>AI 长跑记忆</strong>：语义检索（本地 TF-IDF）+ 角色索引 + 弧/卷/纪元摘要。
            写前不全量灌模型。
            <span className="text-violet-700 font-semibold"> 手改优先。</span>
          </p>
        </div>
        <div className="text-[11px] font-mono text-slate-500 text-right shrink-0">
          <div>钉死 {counts.facts}</div>
          <div>未收 {counts.threads}</div>
          <div>
            地点 {entityCounts.locations} · 道具 {entityCounts.items}
          </div>
          <div>
            账本 {ledgerCounts.active}
            <span className="text-slate-400">
              （死{ledgerCounts.deaths}/物{ledgerCounts.items}/日{ledgerCounts.storyDay}/快照
              {ledgerCounts.snapshots}）
            </span>
          </div>
          <div>
            摘要 {digests.length}
            <span className="text-slate-400">
              （弧{arcN}/滚{rollingN}/50:{megaN}/100:{superN}/卷{volumeN}）
            </span>
          </div>
          <div>已回收 {counts.resolvedThreads}</div>
          {debts.length > 0 && (
            <div className="mt-1 text-rose-700 font-bold">债务 {debts.length}</div>
          )}
          {pendingResolves.length > 0 && (
            <div className="mt-0.5 text-violet-700 font-bold">
              待确认回收 {pendingResolves.length}
            </div>
          )}
          {mem.updatedAt && (
            <div className="mt-1">更新 {new Date(mem.updatedAt).toLocaleString()}</div>
          )}
        </div>
      </div>

      {!health.ok && (
        <div
          className={`rounded-xl border px-3.5 py-2.5 text-[11px] space-y-1 ${
            health.level === 'risk'
              ? 'border-red-300 bg-red-50 text-red-950'
              : 'border-amber-300 bg-amber-50 text-amber-950'
          }`}
        >
          <div className="font-bold flex items-center gap-1">
            <AlertTriangle size={13} /> 长篇记忆健康
            {health.level === 'risk' ? ' · 风险' : ' · 留意'}
          </div>
          {health.messages.map((m, i) => (
            <p key={i} className="leading-relaxed">
              · {m}
            </p>
          ))}
        </div>
      )}

      {/* 伏笔回收建议（章末自动，需确认） */}
      {pendingResolves.length > 0 && (
        <section className="rounded-xl border border-violet-300 bg-violet-50/70 p-4 space-y-2">
          <h3 className="text-sm font-bold text-violet-950 flex items-center gap-1.5">
            <Sparkles size={15} className="text-violet-600" />
            伏笔回收建议（待确认）
          </h3>
          <p className="text-[11px] text-violet-900/80 leading-relaxed">
            完整写章后根据 recap 启发式提议。确认后才会标记 resolved，不会静默改你的台账。
          </p>
          <ul className="space-y-1.5">
            {pendingResolves.map((s) => (
              <li
                key={`${s.threadId}-${s.suggestedAt}`}
                className="flex items-start justify-between gap-2 text-xs p-2 rounded-lg bg-white border border-violet-200"
              >
                <div className="min-w-0">
                  <span
                    className={`text-[10px] px-1 py-0.5 rounded border font-bold ${
                      s.confidence === 'high'
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                        : s.confidence === 'low'
                          ? 'bg-slate-50 border-slate-200 text-slate-600'
                          : 'bg-amber-50 border-amber-200 text-amber-900'
                    }`}
                  >
                    {s.confidence}
                  </span>
                  <span className="ml-1 text-[10px] text-slate-500">
                    第{s.sourceChapterNumber}章提议
                  </span>
                  <p className="text-slate-900 font-medium mt-0.5 leading-relaxed">
                    {s.threadText}
                  </p>
                  <p className="text-[10px] text-slate-500 mt-0.5">{s.reason}</p>
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateMemory(acceptHookResolve(mem, s.threadId, chapterN))
                    }
                    className="text-[10px] px-2 py-0.5 rounded border border-black bg-black text-white font-bold"
                  >
                    确认回收
                  </button>
                  <button
                    type="button"
                    onClick={() => onUpdateMemory(dismissHookResolve(mem, s.threadId))}
                    className="text-[10px] px-2 py-0.5 rounded border border-slate-200 bg-slate-50 text-slate-700 font-semibold"
                  >
                    忽略
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 事实账本：结构化对账 */}
      <section className="space-y-2 rounded-xl border border-teal-200 bg-teal-50/40 p-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
            <BookOpen size={15} className="text-teal-700" />
            事实账本 · 活跃 {ledgerCounts.active}
            <span className="text-[10px] font-normal text-teal-900/70">
              死{ledgerCounts.deaths} · 物{ledgerCounts.items} · 故事日
              {ledgerCounts.storyDay} · 快照{ledgerCounts.snapshots}
            </span>
          </h3>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={handleRebuildLedger}
              disabled={chapters.length === 0 || ledgerBusy}
              className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
              title="按章序从 recap/正文启发式重建账本"
            >
              <RefreshCw size={12} />
              重建账本
            </button>
            <button
              type="button"
              onClick={() => void handleLlmEnrichLatest()}
              disabled={chapters.length === 0 || ledgerBusy}
              className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
              title="对最近一章有正文用 LLM 补抽死亡/道具/地点"
            >
              {ledgerBusy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Sparkles size={12} />
              )}
              LLM补抽最近章
            </button>
            <button
              type="button"
              onClick={handleSyncDeaths}
              disabled={ledgerBusy}
              className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
              title="角色卡「已阵亡」↔ 账本死亡 双向同步（精确匹配角色名）"
            >
              <Users size={12} />
              死亡双向同步
            </button>
            <button
              type="button"
              onClick={handleSyncEntities}
              disabled={ledgerBusy}
              className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
              title="账本道具归属/损毁、角色地点 → 地点/道具实体表"
            >
              <BookOpen size={12} />
              同步实体表
            </button>
          </div>
        </div>
        <p className="text-[11px] text-slate-600 leading-relaxed">
          章后自动：死亡/状态/地点/道具 + 故事日时间线；并同步实体表。写前注入 + 写后对账。
          误报可「作废」；关键铁律可手钉。未绿通时 error 会写入待修。
        </p>
        {timeline.length > 0 && (
          <div className="rounded-lg border border-teal-100 bg-white/80 px-2.5 py-2">
            <div className="text-[10px] font-bold text-teal-900 mb-1">
              故事时间线 · 当前约第 {ledgerCounts.storyDay} 天
            </div>
            <ul className="space-y-0.5 max-h-24 overflow-y-auto">
              {timeline.map((t) => (
                <li
                  key={`${t.chapterNumber}-${t.label}`}
                  className="text-[10px] text-slate-700 font-mono"
                >
                  第{t.chapterNumber}章 · {t.label}
                  {t.storyDay != null ? ` · 日${t.storyDay}` : ''}
                  {t.dayDelta != null && t.dayDelta > 0
                    ? ` (+${t.dayDelta})`
                    : t.dayDelta === 0
                      ? ' (同日)'
                      : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
        {ledgerMsg && (
          <p className="text-[10px] text-teal-900 bg-teal-50/90 border border-teal-100 rounded-lg px-2 py-1.5">
            {ledgerMsg}
          </p>
        )}

        <form
          onSubmit={handleAddManual}
          className="flex flex-wrap items-end gap-1.5 p-2 rounded-lg border border-teal-100 bg-white"
        >
          <label className="text-[10px] text-slate-600">
            类型
            <select
              value={manualKind}
              onChange={(e) => setManualKind(e.target.value as FactAssertionKind)}
              className="ml-1 text-[11px] border border-slate-200 rounded px-1.5 py-1"
            >
              <option value="death">死亡</option>
              <option value="character_status">状态</option>
              <option value="character_location">地点</option>
              <option value="item_owner">道具归属</option>
              <option value="item_state">道具损毁</option>
              <option value="event">事件</option>
            </select>
          </label>
          <label className="text-[10px] text-slate-600 flex-1 min-w-[5rem]">
            主体
            <input
              value={manualSubject}
              onChange={(e) => setManualSubject(e.target.value)}
              placeholder="角色/道具名"
              className="mt-0.5 w-full text-[11px] border border-slate-200 rounded px-2 py-1"
            />
          </label>
          <label className="text-[10px] text-slate-600 flex-[2] min-w-[8rem]">
            断言（可空）
            <input
              value={manualClaim}
              onChange={(e) => setManualClaim(e.target.value)}
              placeholder="空则自动生成，如「某某已阵亡」"
              className="mt-0.5 w-full text-[11px] border border-slate-200 rounded px-2 py-1"
            />
          </label>
          <button
            type="submit"
            disabled={!manualSubject.trim()}
            className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            <Pin size={12} />
            手钉
          </button>
        </form>

        {activeLedger.length === 0 ? (
          <p className="text-xs text-slate-500 py-2">
            暂无账本断言。写完几章完整闭环，或点「重建账本」。
          </p>
        ) : (
          <ul className="space-y-1 max-h-56 overflow-y-auto">
            {activeLedger.map((a) => (
              <li
                key={a.id}
                className="text-[11px] px-2.5 py-1.5 rounded-lg border border-teal-100 bg-white flex items-start gap-2"
              >
                <span
                  className={`shrink-0 text-[9px] px-1 py-0.5 rounded border font-bold ${
                    a.kind === 'death'
                      ? 'bg-red-50 border-red-200 text-red-800'
                      : a.kind === 'item_owner' || a.kind === 'item_state'
                        ? 'bg-amber-50 border-amber-200 text-amber-900'
                        : a.kind === 'character_location'
                          ? 'bg-sky-50 border-sky-200 text-sky-900'
                          : 'bg-teal-50 border-teal-200 text-teal-900'
                  }`}
                >
                  {a.kind}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-slate-900 leading-relaxed">{a.claim}</div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                    {a.subject}
                    {a.value ? ` · ${a.value}` : ''} · 第{a.sourceChapterNumber}章
                    {a.note === 'manual' || a.note === 'llm' ? ` · ${a.note}` : ''}
                  </div>
                </div>
                <div className="flex flex-col gap-0.5 shrink-0">
                  <button
                    type="button"
                    title="作废：不再参与对账，保留记录"
                    onClick={() => {
                      onUpdateMemory(retractAssertion(mem, a.id));
                      setLedgerMsg(`已作废：${a.claim.slice(0, 32)}`);
                    }}
                    className="text-[10px] px-1.5 py-0.5 rounded border border-black bg-black text-white font-semibold hover:bg-neutral-800 inline-flex items-center gap-0.5"
                  >
                    <Ban size={10} />
                    作废
                  </button>
                  <button
                    type="button"
                    title="彻底删除"
                    onClick={() => {
                      onUpdateMemory(removeAssertion(mem, a.id));
                      setLedgerMsg(`已删除：${a.claim.slice(0, 32)}`);
                    }}
                    className="text-[10px] px-1.5 py-0.5 rounded border border-slate-200 bg-slate-50 text-slate-600 hover:text-red-700 hover:border-red-200 inline-flex items-center gap-0.5"
                  >
                    <Trash2 size={10} />
                    删
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 三层摘要（200+ 中远记忆） */}
      <section className="space-y-2 rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
            <Layers size={15} className="text-indigo-600" />
            多层摘要 · 弧{arcN}/滚{rollingN}/50:{megaN}/100:{superN}/卷{volumeN}
            {llmDigestN > 0 && (
              <span className="text-[10px] font-bold text-fuchsia-800 bg-fuchsia-100 border border-fuchsia-200 px-1.5 py-0.5 rounded">
                LLM {llmDigestN}
              </span>
            )}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={handleRebuildDigests}
              disabled={chapters.length === 0 || polishBusy}
              className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              <RefreshCw size={12} />
              重建摘要
            </button>
            <button
              type="button"
              onClick={() => handlePolishEpoch(false)}
              disabled={chapters.length === 0 || polishBusy || (megaN === 0 && superN === 0)}
              className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
              title="用模型把 mega/super 压缩成连贯远程总览（默认只润未润色块）"
            >
              <Sparkles size={12} />
              {polishBusy ? '润色中…' : epochPendingN > 0 ? `润色纪元(${epochPendingN})` : '润色纪元'}
            </button>
            {llmDigestN > 0 && (
              <button
                type="button"
                onClick={() => handlePolishEpoch(true)}
                disabled={polishBusy}
                className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                title="强制重跑已润色的纪元块"
              >
                强制重润
              </button>
            )}
          </div>
        </div>
        <p className="text-[11px] text-slate-600 leading-relaxed">
          弧≈15 · 滚≈10 · mega≈50 · super≈100 · 卷。完整闭环自动更新；写前叠加本地语义相关章。
          <span className="text-fuchsia-800 font-semibold">
            {' '}
            纪元润色：把 50/100 章总览压成连贯远程记忆，利于 200+ 章 AI 长跑。
          </span>
        </p>
        {polishMsg && (
          <p className="text-[10px] text-fuchsia-900 bg-fuchsia-50/80 border border-fuchsia-100 rounded-lg px-2 py-1.5">
            {polishMsg}
          </p>
        )}
        {digests.length === 0 ? (
          <p className="text-xs text-slate-500 py-2">
            暂无摘要。写满若干章并完成 recap 后自动生成，或点「重建摘要」。
          </p>
        ) : (
          <ul className="space-y-2 max-h-72 overflow-y-auto">
            {[...digests]
              .sort((a, b) => {
                const rank = (k: string) =>
                  k === 'super'
                    ? 0
                    : k === 'mega'
                      ? 1
                      : k === 'arc'
                        ? 2
                        : k === 'volume'
                          ? 3
                          : 4;
                return rank(a.kind) - rank(b.kind) || b.toChapter - a.toChapter;
              })
              .map((d) => (
                <li
                  key={d.id}
                  className={`text-[11px] p-2.5 rounded-lg border bg-white ${
                    d.kind === 'super'
                      ? 'border-fuchsia-300'
                      : d.kind === 'mega'
                        ? 'border-violet-200'
                        : d.kind === 'arc'
                          ? 'border-cyan-200'
                          : d.kind === 'volume'
                            ? 'border-amber-200'
                            : 'border-indigo-100'
                  }`}
                >
                  <div className="font-bold text-indigo-950 flex items-center gap-1.5 flex-wrap">
                    <span
                      className={`text-[10px] px-1 py-0.5 rounded border font-bold ${
                        d.kind === 'super'
                          ? 'bg-fuchsia-100 border-fuchsia-300 text-fuchsia-900'
                          : d.kind === 'mega'
                            ? 'bg-violet-100 border-violet-300 text-violet-900'
                            : d.kind === 'arc'
                              ? 'bg-cyan-50 border-cyan-200 text-cyan-900'
                              : d.kind === 'volume'
                                ? 'bg-amber-50 border-amber-200 text-amber-900'
                                : 'bg-indigo-50 border-indigo-200 text-indigo-800'
                      }`}
                    >
                      {d.kind === 'super'
                        ? '纪元100'
                        : d.kind === 'mega'
                          ? '总览50'
                          : d.kind === 'arc'
                            ? '叙事弧'
                            : d.kind === 'volume'
                              ? '分卷'
                              : '滚动10'}
                    </span>
                    {d.title}
                    <span className="text-[10px] font-mono font-normal text-slate-500">
                      第{d.fromChapter}–{d.toChapter}章
                    </span>
                    {d.source === 'llm' && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-fuchsia-100 text-fuchsia-900 border border-fuchsia-200 font-bold">
                        LLM
                      </span>
                    )}
                  </div>
                  <p className="text-slate-700 mt-1 leading-relaxed whitespace-pre-wrap line-clamp-4">
                    {d.summary}
                  </p>
                  {d.keyFacts.length > 0 && (
                    <p className="text-slate-500 mt-1">
                      要点：{d.keyFacts.slice(0, 4).join('； ')}
                    </p>
                  )}
                </li>
              ))}
          </ul>
        )}
      </section>

      {/* 地点 / 道具 */}
      {(entityCounts.locations > 0 || entityCounts.items > 0) && (
        <section className="rounded-xl border border-teal-200 bg-teal-50/50 p-4 space-y-2">
          <h3 className="text-sm font-bold text-teal-950">地点 / 道具状态</h3>
          <p className="text-[11px] text-teal-900/80">
            写完章从 recap 与角色所在地自动更新，写前注入防「瞬移/丢物复活」。
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
            <div>
              <div className="font-bold text-teal-900 mb-1">地点</div>
              <ul className="space-y-1 max-h-32 overflow-y-auto">
                {(mem.locations || []).slice(0, 12).map((l) => (
                  <li key={l.id} className="px-2 py-1 rounded bg-white border border-teal-100">
                    <span className="font-semibold">{l.name}</span>
                    {l.status && (
                      <span className="text-slate-500"> · {l.status}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="font-bold text-teal-900 mb-1">道具</div>
              <ul className="space-y-1 max-h-32 overflow-y-auto">
                {(mem.items || []).slice(0, 12).map((it) => (
                  <li key={it.id} className="px-2 py-1 rounded bg-white border border-teal-100">
                    <span className="font-semibold">{it.name}</span>
                    {it.status && (
                      <span className="text-slate-500"> · {it.status}</span>
                    )}
                  </li>
                ))}
                {(mem.items || []).length === 0 && (
                  <li className="text-slate-400">暂无道具记录</li>
                )}
              </ul>
            </div>
          </div>
        </section>
      )}

      {/* 伏笔债务看板 */}
      {debts.length > 0 && (
        <section className="rounded-xl border border-rose-300 bg-rose-50/70 p-4 space-y-2">
          <h3 className="text-sm font-bold text-rose-950 flex items-center gap-1.5">
            <AlertTriangle size={15} className="text-rose-600" />
            伏笔债务（相对第 {chapterN} 章）
          </h3>
          <p className="text-[11px] text-rose-900/80 leading-relaxed">
            静默过久：推进中 ≥5 章、主线 ≥8 章、普通 open ≥10 章。写前会强制注入并建议写进 mustDo。
          </p>
          <ul className="space-y-1.5">
            {debts.map((d) => (
              <li
                key={d.thread.id}
                className="flex items-start justify-between gap-2 text-xs p-2 rounded-lg bg-white border border-rose-200"
              >
                <div className="min-w-0">
                  <span className="font-bold text-rose-800">静默 {d.silence} 章</span>
                  {d.thread.coreHook && (
                    <span className="ml-1 text-[10px] px-1 rounded bg-amber-100 text-amber-900">
                      主线
                    </span>
                  )}
                  <p className="text-slate-800 mt-0.5 leading-relaxed">{d.thread.text}</p>
                  {d.thread.seedExcerpt && (
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      埋线：{d.thread.seedExcerpt.slice(0, 80)}
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateMemory(
                        updateThreadStatus(mem, d.thread.id, 'progressing', chapterN)
                      )
                    }
                    className="text-[10px] px-2 py-0.5 rounded border border-sky-200 bg-sky-50 text-sky-900 font-semibold"
                  >
                    标推进
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateMemory(
                        updateThreadStatus(mem, d.thread.id, 'resolved', chapterN)
                      )
                    }
                    className="text-[10px] px-2 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-900 font-semibold"
                  >
                    已回收
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateMemory(
                        updateThreadStatus(mem, d.thread.id, 'deferred', chapterN)
                      )
                    }
                    className="text-[10px] px-2 py-0.5 rounded border border-slate-200 bg-slate-50 text-slate-700 font-semibold"
                  >
                    延期
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 角色状态表（只读投影） */}
      <section className="space-y-2">
        <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
          <Users size={15} className="text-indigo-600" />
          角色当前状态表
          <span className="text-[10px] font-normal text-slate-500">（编辑请到「角色图谱」）</span>
        </h3>
        <pre className="text-[11px] leading-relaxed p-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 whitespace-pre-wrap font-sans">
          {formatCharacterStateTable(characters, { max: 20 })}
        </pre>
      </section>

      {/* 已钉死事实 */}
      <section className="space-y-3">
        <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
          <Pin size={15} className="text-rose-600" />
          已钉死事实
          <span className="text-[10px] font-normal text-slate-500">写后续章不得推翻</span>
        </h3>

        <form onSubmit={handleAddFact} className="flex gap-2">
          <input
            value={factInput}
            onChange={(e) => setFactInput(e.target.value)}
            placeholder="例如：叶无痕已失去左臂·仍持断刀"
            className="flex-1 text-xs px-3 py-2 border border-slate-300 rounded-lg focus:border-rose-400 focus:outline-none"
          />
          <button
            type="submit"
            className="inline-flex items-center gap-1 px-3 py-2 bg-black text-white text-xs font-bold rounded-lg hover:bg-neutral-800"
          >
            <Plus size={14} />
            添加
          </button>
        </form>

        <ul className="space-y-1.5">
          {facts.length === 0 && (
            <li className="text-xs text-slate-500 p-3 bg-slate-50 border border-dashed border-slate-200 rounded-lg">
              暂无钉死事实。写完章节后会从 recap 的 keyFacts 自动汇入，也可在此手写。
            </li>
          )}
          {facts.map((f) => (
            <li
              key={f.id}
              className="flex items-start justify-between gap-2 p-2.5 bg-rose-50/40 border border-rose-100 rounded-lg text-xs"
            >
              <div className="min-w-0">
                <p className="text-slate-900 font-medium leading-relaxed">{f.text}</p>
                <p className="text-[10px] text-slate-500 mt-0.5 font-mono">
                  {f.sourceChapterNumber != null ? `源第${f.sourceChapterNumber}章 · ` : ''}
                  {f.validFromChapter != null ? `自第${f.validFromChapter}章生效 · ` : ''}
                  {f.subject ? `主语「${f.subject}」 · ` : ''}
                  {new Date(f.createdAt).toLocaleString()}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  title="作废（时序截止 + 不再注入）"
                  onClick={() =>
                    onUpdateMemory(
                      invalidatePinnedFact(
                        mem,
                        f.id,
                        chapterN,
                        `作者于第${chapterN}章作废`
                      )
                    )
                  }
                  className="p-1.5 text-slate-400 hover:text-amber-700 hover:bg-amber-50 rounded"
                >
                  <PauseCircle size={14} />
                </button>
                <button
                  type="button"
                  title="删除"
                  onClick={() => onUpdateMemory(removeFact(mem, f.id))}
                  className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>

        {superseded.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowSuperseded((v) => !v)}
              className="text-[10px] text-slate-500 hover:text-slate-800"
            >
              {showSuperseded ? '收起' : '展开'}已作废事实（{superseded.length}）
            </button>
            {showSuperseded && (
              <ul className="mt-1 space-y-1 opacity-70">
                {superseded.map((f) => (
                  <li key={f.id} className="text-[11px] line-through text-slate-500 px-2">
                    {f.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* 未收伏笔 */}
      <section className="space-y-3">
        <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
          <GitBranch size={15} className="text-amber-600" />
          未收伏笔 / 线索
        </h3>

        <form onSubmit={handleAddThread} className="flex gap-2">
          <input
            value={threadInput}
            onChange={(e) => setThreadInput(e.target.value)}
            placeholder="例如：北地霜莺羽信的真正收件人是谁"
            className="flex-1 text-xs px-3 py-2 border border-slate-300 rounded-lg focus:border-amber-400 focus:outline-none"
          />
          <button
            type="submit"
            className="inline-flex items-center gap-1 px-3 py-2 bg-black text-white text-xs font-bold rounded-lg hover:bg-neutral-800"
          >
            <Plus size={14} />
            添加
          </button>
        </form>

        <ul className="space-y-1.5">
          {threads.length === 0 && (
            <li className="text-xs text-slate-500 p-3 bg-slate-50 border border-dashed border-slate-200 rounded-lg">
              暂无未收伏笔。章末 recap 的 openThreads 会自动汇入。
            </li>
          )}
          {threads.map((t) => {
            const silence = threadSilence(t, chapterN);
            return (
              <li
                key={t.id}
                className="flex items-start justify-between gap-2 p-2.5 bg-amber-50/50 border border-amber-100 rounded-lg text-xs"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${
                        t.status === 'progressing'
                          ? 'bg-sky-50 border-sky-200 text-sky-800'
                          : t.status === 'deferred'
                            ? 'bg-slate-100 border-slate-200 text-slate-600'
                            : 'bg-amber-50 border-amber-200 text-amber-900'
                      }`}
                    >
                      {t.status === 'progressing'
                        ? '推进中'
                        : t.status === 'deferred'
                          ? '延期'
                          : '未收'}
                    </span>
                    {t.coreHook && (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-violet-100 text-violet-900 border border-violet-200 font-semibold">
                        主线
                      </span>
                    )}
                    {silence >= 5 && (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-rose-100 text-rose-800 border border-rose-200 font-semibold">
                        静默{silence}
                      </span>
                    )}
                    <p className="text-slate-900 font-medium leading-relaxed">{t.text}</p>
                  </div>
                  <p className="text-[10px] text-slate-500 mt-0.5 font-mono">
                    {t.introducedChapterNumber != null
                      ? `起自第${t.introducedChapterNumber}章`
                      : '手写'}
                    {t.lastTouchedChapterNumber != null
                      ? ` · 最近触达第${t.lastTouchedChapterNumber}章`
                      : ''}
                  </p>
                  {t.seedExcerpt?.trim() && (
                    <p className="text-[10px] text-slate-500 mt-0.5 leading-relaxed">
                      埋线摘录：{t.seedExcerpt.trim().slice(0, 100)}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    type="button"
                    title={t.coreHook ? '取消主线标记' : '标为主线伏笔（债务更严）'}
                    onClick={() => {
                      const next = normalizeStoryMemory(mem);
                      next.openThreads = next.openThreads.map((x) =>
                        x.id === t.id ? { ...x, coreHook: !x.coreHook } : x
                      );
                      next.updatedAt = new Date().toISOString();
                      onUpdateMemory(next);
                    }}
                    className={`p-1.5 rounded ${
                      t.coreHook
                        ? 'text-violet-700 bg-violet-50'
                        : 'text-slate-400 hover:text-violet-700 hover:bg-violet-50'
                    }`}
                  >
                    <Star size={14} />
                  </button>
                  <button
                    type="button"
                    title="标记推进中"
                    onClick={() => onUpdateMemory(updateThreadStatus(mem, t.id, 'progressing'))}
                    className="px-1.5 py-1 text-[10px] text-sky-700 hover:bg-sky-50 rounded"
                  >
                    推进
                  </button>
                  <button
                    type="button"
                    title="延期"
                    onClick={() => onUpdateMemory(updateThreadStatus(mem, t.id, 'deferred'))}
                    className="px-1.5 py-1 text-[10px] text-slate-600 hover:bg-slate-50 rounded"
                  >
                    延期
                  </button>
                  <button
                    type="button"
                    title="已回收"
                    onClick={() => onUpdateMemory(updateThreadStatus(mem, t.id, 'resolved'))}
                    className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded"
                  >
                    <CheckCircle2 size={14} />
                  </button>
                  <button
                    type="button"
                    title="删除"
                    onClick={() => onUpdateMemory(removeThread(mem, t.id))}
                    className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        {resolved.length > 0 && (
          <div className="text-[10px] text-slate-500">
            已回收 {resolved.length} 条：
            {resolved
              .slice(0, 5)
              .map((t) => t.text)
              .join('； ')}
            {resolved.length > 5 ? '…' : ''}
          </div>
        )}
      </section>

      {/* 作者备忘 */}
      <section className="space-y-2">
        <h3 className="text-sm font-bold text-slate-900">作者备忘（注入写章）</h3>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={commitNotes}
          rows={3}
          placeholder="长期想强调的节奏/禁忌/伏笔回收时机…"
          className="w-full text-xs p-3 border border-slate-300 rounded-xl focus:border-violet-400 focus:outline-none leading-relaxed"
        />
        <p className="text-[10px] text-slate-400">失焦自动保存。</p>
      </section>
    </div>
  );
};
