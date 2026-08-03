import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from 'react';
import type {
  BookProject,
  Chapter,
  ChapterIntent,
  CrossChapterIssue,
} from '../types/novel';
import {
  isChapterLocked,
  lockChapterAsFinal,
  unlockChapterForRewrite,
} from '../services/chapterLock';
import {
  deslopHitInChapter,
  deslopTopErrorsInBook,
  deslopTopErrorsInChapter,
  exportAiTasteCsv,
  scanBookAiTasteOnly,
  scanChapterAiTasteOnly,
} from '../services/aiTasteActions';
import { runCrossChapterAudit } from '../services/crossChapterAudit';
import {
  applyCrossAuditToChapters,
  crossAuditFailed,
  makeAuditTodoId,
} from '../services/crossAuditActions';
import { computeSnoozeUntilCount, evaluateCrossAuditRemind } from '../services/crossAuditRemind';
import {
  clearDoneRevisionTodos,
  collectRevisionTodos,
  markAllOpenTodosDone,
  pickFirstOpenRevision,
  toggleRevisionTodoOnChapter,
} from '../services/revisionTodos';
import { aiFixRevisionTodo } from '../services/revisionAiFix';
import { generateChapterIntent, hasIntentDraft } from '../services/chapterIntent';
import {
  accrueDailyWords,
  countContentWords,
} from '../services/dailyWordLog';
import { buildPreviousContextPack } from '../services/contextPack';
import { createSnapshot } from '../services/snapshots';

export type ActiveTab = 'workspace' | 'world' | 'outline' | 'style';

export interface UseChapterActionsOptions {
  /** 始终指向最新 project 的 ref（长异步工作流防闭包脏写） */
  projectRef: MutableRefObject<BookProject | null>;
  /** 防止双击并发跑多条工作流 */
  generatingLockRef: MutableRefObject<boolean>;
  /** 当前章 id（state 值，驱动"当前章"类动作） */
  activeChapterId: string;
  /** 单章/自动写作是否在跑（章节删除/清空禁入） */
  isGenerating: boolean;
  isAutoPiloting: boolean;
  /** 扫描/去味互斥锁 */
  aiTasteScanBusy: boolean;
  setStatusMessage: Dispatch<SetStateAction<string>>;
  setActiveChapterId: Dispatch<SetStateAction<string>>;
  setActiveTab: Dispatch<SetStateAction<ActiveTab>>;
  setFocusRevisionTodo: Dispatch<SetStateAction<{ chapterId: string; todoId: string } | null>>;
  setFocusProseSnippet: Dispatch<SetStateAction<string | null>>;
  setAiTasteScanBusy: Dispatch<SetStateAction<boolean>>;
  setAiTasteScanMessage: Dispatch<SetStateAction<string | null>>;
  setCrossAuditBusy: Dispatch<SetStateAction<boolean>>;
  /** R2-3 合并式持久化（来自 useProjectPersistence） */
  handleUpdateAndPersistProject: (
    updates: Partial<BookProject> | ((prev: BookProject) => Partial<BookProject>)
  ) => Promise<void>;
  /** 触发快照列表刷新 */
  bumpSnapshotList: () => void;
}

/**
 * 章节动作域（R1 拆分第三步）。
 *
 * 封装：章节 CRUD（增/删/清空/清正文/更新）与章节级动作
 * （定稿锁定 / 写前意图 / 跨章抽检 / 待修 / AI 修 / AI 味扫描 /
 * 批量去味 / 意图生成 / 解锁重写）。
 *
 * 函数体零改动搬移；只把 App 的 state/ref/能力收敛为 props。
 * 渲染派生值（previousContextPack 等）与编排胶水
 * （handleStartThreeStepWorkflow，依赖 runChapterPipeline）留在 App。
 */
export function useChapterActions({
  projectRef,
  generatingLockRef,
  activeChapterId,
  isGenerating,
  isAutoPiloting,
  aiTasteScanBusy,
  setStatusMessage,
  setActiveChapterId,
  setActiveTab,
  setFocusRevisionTodo,
  setFocusProseSnippet,
  setAiTasteScanBusy,
  setAiTasteScanMessage,
  setCrossAuditBusy,
  handleUpdateAndPersistProject,
  bumpSnapshotList,
}: UseChapterActionsOptions) {
  const handleAddChapter = (volumeId?: string, volumeNumber?: number) => {
    if (generatingLockRef.current) {
      setStatusMessage('⚠️ 生成进行中，暂不可新增章节。');
      return;
    }
    const prev = projectRef.current;
    if (!prev) return;
    const prevChapters = prev.chapters || [];
    const prevVolumes = prev.volumes || [];
    const prevChars = prev.characters || [];
    const prevSets = prev.settings || [];
    const newNum = prevChapters.length + 1;
    const targetVol = prevVolumes.find((v) => v.id === volumeId) || prevVolumes[0];
    const newChapter: Chapter = {
      id: `chap-${Date.now()}`,
      number: newNum,
      title: `第 ${newNum} 章 新增章节`,
      summary: '在此写下章节核心情节钩子与高潮转折，点击右侧按钮调用三步推理生成章节。',
      wordCount: 0,
      status: '大纲待拆',
      content: '',
      volumeId: targetVol ? targetVol.id : volumeId,
      volumeNumber: targetVol ? targetVol.number : volumeNumber || 1,
      involvedCharacterIds: prevChars.slice(0, 2).map((c) => c.id),
      involvedSettingIds: prevSets.slice(0, 2).map((s) => s.id),
      beats: [],
      lastModified: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    handleUpdateAndPersistProject((p) => ({
      chapters: [...(p.chapters || []), newChapter],
    }));
    setActiveChapterId(newChapter.id);
  };

  /** 删除章节：确认后落盘，按序重编号；若删的是当前章则切到相邻章 */
  const handleDeleteChapter = (chapterId: string) => {
    if (generatingLockRef.current || isGenerating || isAutoPiloting) {
      setStatusMessage('⚠️ 生成进行中，暂不可删除章节。');
      return;
    }
    const prev = projectRef.current;
    if (!prev) return;
    const list = prev.chapters || [];
    const target = list.find((c) => c.id === chapterId);
    if (!target) {
      setStatusMessage('⚠️ 章节不存在或已删除。');
      return;
    }
    if (list.length <= 1) {
      const goClear = window.confirm(
        '仅剩一章，无法再单删。\n\n是否改用「清空全部章节」？\n将删除本版所有章节内容，并重置为一章空白大纲（书名/人物/记忆等保留）。'
      );
      if (goClear) {
        handleClearAllChapters();
      }
      return;
    }

    const words = target.wordCount || (target.content || '').replace(/\s+/g, '').length;
    const lockedHint = isChapterLocked(target) ? '\n⚠️ 本章已定稿锁定，删除后无法从侧栏恢复（可用快照/JSON 备份回滚）。' : '';
    const ok = window.confirm(
      `确定删除第 ${target.number} 章《${target.title || '无标题'}》？\n\n` +
        `约 ${words.toLocaleString()} 字 · ${target.status || '未知状态'}${lockedHint}\n\n` +
        `删除后将按顺序重编号后续章节，此操作不可撤销（建议先导出 JSON 或打快照）。`
    );
    if (!ok) return;

    const remaining = list
      .filter((c) => c.id !== chapterId)
      .map((c, idx) => ({
        ...c,
        number: idx + 1,
      }));

    // 若删的是当前章：落在原序号位置（后章前移），否则保持当前选中
    let nextActiveId = activeChapterId;
    if (activeChapterId === chapterId) {
      const idx = list.findIndex((c) => c.id === chapterId);
      nextActiveId =
        remaining[Math.min(Math.max(idx, 0), remaining.length - 1)]?.id ||
        remaining[0]?.id ||
        '';
    }

    handleUpdateAndPersistProject({
      chapters: remaining,
      currentChapterId: nextActiveId || remaining[0]?.id,
    });
    if (nextActiveId) {
      setActiveChapterId(nextActiveId);
    }
    setStatusMessage(
      `🗑️ 已删除原第 ${target.number} 章《${target.title || '无标题'}》，剩余 ${remaining.length} 章并已重编号。`
    );
  };

  /**
   * 清空本版全部章节：删除所有章（含正文/大纲/待修），重置为 1 章空白壳。
   * 书名、人物、设定、记忆、文风配置保留；不可撤销（建议先导出/快照）。
   */
  const handleClearAllChapters = () => {
    if (generatingLockRef.current || isGenerating || isAutoPiloting) {
      setStatusMessage('⚠️ 生成进行中，暂不可清空章节。');
      return;
    }
    const prev = projectRef.current;
    if (!prev) return;
    const list = prev.chapters || [];
    const totalWords = list.reduce(
      (s, c) => s + (c.wordCount || (c.content || '').replace(/\s+/g, '').length),
      0
    );
    const lockedN = list.filter((c) => isChapterLocked(c)).length;
    const withBody = list.filter(
      (c) => (c.content || '').replace(/\s+/g, '').length > 0
    ).length;

    const ok1 = window.confirm(
      `清空本版全部章节？\n\n` +
        `· 将删除 ${list.length} 章（有正文 ${withBody} 章）\n` +
        `· 合计约 ${totalWords.toLocaleString()} 字\n` +
        (lockedN ? `· 其中已锁定 ${lockedN} 章也会删除\n` : '') +
        `· 重置为「第 1 章」空白大纲，可重新开写\n` +
        `· 书名 / 人物 / 设定 / 书级记忆 / 文风 保留\n\n` +
        `此操作不可撤销。强烈建议先导出 JSON 或打快照。\n\n确定继续？`
    );
    if (!ok1) return;

    const ok2 = window.confirm(
      `最后确认：真的删除全部 ${list.length} 章？\n\n点「确定」后立即清空，无法 Ctrl+Z。`
    );
    if (!ok2) return;

    const targetVol = (prev.volumes || [])[0];
    const blankId = `chap-${Date.now()}`;
    const blank: Chapter = {
      id: blankId,
      number: 1,
      title: '第 1 章 新章',
      summary:
        '章节已清空。在此写梗概，或用右侧闭环 / 向导重新拆章开写。',
      wordCount: 0,
      status: '大纲待拆',
      content: '',
      volumeId: targetVol?.id,
      volumeNumber: targetVol?.number ?? 1,
      involvedCharacterIds: (prev.characters || []).slice(0, 2).map((c) => c.id),
      involvedSettingIds: (prev.settings || []).slice(0, 2).map((s) => s.id),
      beats: [],
      locked: false,
      lockedAt: undefined,
      revisionTodos: [],
      authorNotes: '',
      lastModified: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    };

    handleUpdateAndPersistProject({
      chapters: [blank],
      currentChapterId: blankId,
    });
    setActiveChapterId(blankId);
    setFocusRevisionTodo(null);
    setFocusProseSnippet(null);
    setStatusMessage(
      `🗑️ 已清空全部章节（原 ${list.length} 章 / 约 ${totalWords.toLocaleString()} 字）· 已重置为 1 章空白`
    );
  };

  /**
   * 仅清空全部正文字数（保留章序、标题、梗概），便于同一版大纲重写。
   */
  const handleClearAllChapterBodies = () => {
    if (generatingLockRef.current || isGenerating || isAutoPiloting) {
      setStatusMessage('⚠️ 生成进行中，暂不可清空正文。');
      return;
    }
    const prev = projectRef.current;
    if (!prev) return;
    const list = prev.chapters || [];
    if (!list.length) {
      setStatusMessage('没有章节可清空');
      return;
    }
    const withBody = list.filter(
      (c) => (c.content || '').replace(/\s+/g, '').length > 0
    ).length;
    const withIntent = list.filter((c) => !!c.intent).length;
    const withBeats = list.filter((c) => (c.beats || []).length > 0).length;
    if (withBody === 0 && withIntent === 0 && withBeats === 0) {
      setStatusMessage('各章正文与写前大纲已是空的');
      return;
    }
    const totalWords = list.reduce(
      (s, c) => s + (c.wordCount || (c.content || '').replace(/\s+/g, '').length),
      0
    );
    const lockedN = list.filter((c) => isChapterLocked(c)).length;
    const ok = window.confirm(
      `清空全部章节的正文与写前大纲？\n\n` +
        `· 保留 ${list.length} 章的标题与梗概（summary）\n` +
        `· 删除约 ${totalWords.toLocaleString()} 字正文（${withBody} 章有正文）\n` +
        `· 清除写前大纲 intent（${withIntent} 章有）\n` +
        (lockedN
          ? `· 将解锁 ${lockedN} 章锁定并清空正文\n`
          : '') +
        `· 清除分镜 / 审校 / 待修 / recap 等章内写作产物\n\n` +
        `建议先导出或打快照。确定？`
    );
    if (!ok) return;

    const label = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    const next = list.map((c) => ({
      ...c,
      content: '',
      wordCount: 0,
      status: '大纲待拆' as Chapter['status'],
      locked: false,
      lockedAt: undefined,
      beats: [],
      /** 写前大纲（目标/禁止/钩子）一并清空，便于重开写 */
      intent: undefined,
      memoryAudit: undefined,
      recap: undefined,
      memoryWriteLog: undefined,
      revisionTodos: [],
      autoFixCount: 0,
      contentUpdatedAt: undefined,
      factSnapshot: undefined,
      memoryInjection: undefined,
      lastModified: label,
    }));

    handleUpdateAndPersistProject({ chapters: next });
    setFocusRevisionTodo(null);
    setFocusProseSnippet(null);
    setStatusMessage(
      `🧹 已清空全部正文与写前大纲（正文 ${withBody} 章 / 大纲 ${withIntent} 章 / 约 ${totalWords.toLocaleString()} 字）· 标题与梗概保留`
    );
  };

  const handleUpdateChapter = (updatedChapter: Chapter) => {
    handleUpdateAndPersistProject((prev) => {
      const prevCh = prev.chapters.find((c) => c.id === updatedChapter.id);
      // 锁定章：禁止通过常规编辑改正文/标题；梗概与元数据可改
      if (prevCh && isChapterLocked(prevCh)) {
        if (
          updatedChapter.content !== prevCh.content ||
          updatedChapter.title !== prevCh.title
        ) {
          setStatusMessage('🔒 本章已定稿锁定，正文/标题不可改。请先「解锁重写」。');
          return {
            chapters: prev.chapters.map((c) =>
              c.id === updatedChapter.id
                ? {
                    ...prevCh,
                    summary: updatedChapter.summary,
                    involvedCharacterIds: updatedChapter.involvedCharacterIds,
                    involvedSettingIds: updatedChapter.involvedSettingIds,
                    beats: updatedChapter.beats,
                    authorNotes: updatedChapter.authorNotes,
                    revisionTodos: updatedChapter.revisionTodos,
                  }
                : c
            ),
          };
        }
      }
      const oldW = countContentWords(prevCh?.content, prevCh?.wordCount);
      const newW = countContentWords(updatedChapter.content, updatedChapter.wordCount);
      const delta = newW - oldW;
      const dailyWordLog =
        delta !== 0 ? accrueDailyWords(prev.dailyWordLog, delta) : prev.dailyWordLog;
      return {
        chapters: prev.chapters.map((c) => (c.id === updatedChapter.id ? updatedChapter : c)),
        ...(delta !== 0 ? { dailyWordLog } : {}),
      };
    });
  };

  /** 人工定稿锁定 + 自动快照 */
  const handleLockChapter = async (chapterId?: string) => {
    const id = chapterId || activeChapterId;
    if (!id) return;
    if (generatingLockRef.current) {
      setStatusMessage('⚠️ 生成进行中，无法改锁定状态。');
      return;
    }
    await handleUpdateAndPersistProject((prev) => ({
      chapters: prev.chapters.map((c) => (c.id === id ? lockChapterAsFinal(c) : c)),
    }));
    try {
      const after = projectRef.current;
      const ch = after?.chapters.find((c) => c.id === id);
      if (after && ch) {
        await createSnapshot(after, {
          reason: 'finalize',
          chapterId: ch.id,
          chapterNumber: ch.number,
          chapterTitle: ch.title,
        });
        bumpSnapshotList();
        setStatusMessage(
          `🔒 已定稿锁定并自动快照 · 第${ch.number}章《${ch.title}》· 流水线不会覆盖正文`
        );
        return;
      }
    } catch (e) {
      console.warn('定稿快照失败:', e);
    }
    setStatusMessage('🔒 已定稿锁定：流水线与 Auto-Pilot 不会覆盖本章正文。');
  };

  /** 保存写前意图（编辑会取消确认，由 chapterIntent 服务处理） */
  const handleSaveChapterIntent = (intent: ChapterIntent) => {
    const id = activeChapterId;
    if (!id) return;
    handleUpdateAndPersistProject((prev) => ({
      chapters: prev.chapters.map((c) =>
        c.id === id
          ? {
              ...c,
              intent,
              lastModified: new Date().toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              }),
            }
          : c
      ),
    }));
    setStatusMessage(
      intent.confirmed
        ? '✅ 写前大纲已确认，可以开写'
        : hasIntentDraft(intent)
          ? '📝 写前大纲已保存（草稿，未确认）'
          : '写前大纲已更新'
    );
  };

  /** 跨章连贯抽检 */
  const handleRunCrossAudit = async (useLlm: boolean) => {
    const proj = projectRef.current;
    if (!proj) return;
    if (generatingLockRef.current) {
      setStatusMessage('⚠️ 生成进行中，请稍后再抽检。');
      return;
    }
    setCrossAuditBusy(true);
    setStatusMessage(useLlm ? '跨章抽检：本地 + 模型…' : '跨章抽检：本地启发…');
    try {
      const report = await runCrossChapterAudit(proj, {
        recentCount: 5,
        useLlm,
        onProgress: (msg) => setStatusMessage(msg),
      });
      // 清除 snooze；失败则写入待修清单 / 待人工
      const failed = crossAuditFailed(report, 60);
      const applied = failed
        ? applyCrossAuditToChapters(proj, report, { markPendingReview: true })
        : null;
      await handleUpdateAndPersistProject((prev) => {
        const cp = { ...(prev.config?.customParameters || {}) };
        delete cp.crossAuditRemindDismissedUntilCount;
        return {
          lastCrossAudit: report,
          config: { ...prev.config, customParameters: cp },
          ...(applied ? { chapters: applied.chapters } : {}),
        };
      });
      const fixHint =
        applied && applied.todosAdded > 0
          ? ` · 已写入 ${applied.todosAdded} 条待修（${applied.chaptersTouched} 章）`
          : failed
            ? ' · 有问题但待修未新增（可能已存在）'
            : '';
      const unlockHint =
        applied && applied.chaptersUnlocked > 0
          ? ` · 已解锁 ${applied.chaptersUnlocked} 章（待人工改稿）`
          : '';
      setStatusMessage(
        `📡 跨章抽检完成 · ${report.score}分 · ${report.issues.length} 项 · ${report.summary}${fixHint}${unlockHint}`
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMessage(`❌ 跨章抽检失败：${msg}`);
    } finally {
      setCrossAuditBusy(false);
    }
  };

  /** 跨章抽检提醒：再写 N 章后提示 */
  const handleDismissCrossAuditRemind = () => {
    const proj = projectRef.current;
    if (!proj) return;
    const status = evaluateCrossAuditRemind(proj);
    const until = computeSnoozeUntilCount(status.chaptersWithContent, status.interval);
    handleUpdateAndPersistProject((prev) => ({
      config: {
        ...prev.config,
        customParameters: {
          ...(prev.config?.customParameters || {}),
          crossAuditRemindDismissedUntilCount: until,
        },
      },
    }));
    setStatusMessage(`⏰ 跨章抽检提醒已延后：有正文满 ${until} 章后再提示`);
  };

  const handleJumpChapter = (chapterId: string, todoId?: string) => {
    setActiveChapterId(chapterId);
    setActiveTab('workspace');
    if (todoId) {
      setFocusRevisionTodo({ chapterId, todoId });
    }
  };

  /**
   * 待修「解锁并开写」：若锁定则确认后解锁，再跳转高亮。
   * 未锁定则等同定位 + 提示可改。
   */
  const handleOpenForRewrite = (chapterId: string, todoId?: string) => {
    if (generatingLockRef.current) {
      setStatusMessage('⚠️ 生成进行中，无法改锁定状态。');
      return;
    }
    const ch = projectRef.current?.chapters.find((c) => c.id === chapterId);
    if (!ch) return;

    if (isChapterLocked(ch)) {
      const ok = window.confirm(
        `解锁第 ${ch.number} 章《${ch.title}》并定位待修？\n\n解锁后可直接改正文或重跑本章闭环。\n当前正文保留，直到再次开写覆盖。`
      );
      if (!ok) return;
      handleUpdateAndPersistProject((prev) => ({
        chapters: prev.chapters.map((c) =>
          c.id === chapterId ? unlockChapterForRewrite(c) : c
        ),
      }));
      setStatusMessage(
        `🔓 第${ch.number}章已解锁 · 可改稿` + (todoId ? ' · 已定位待修' : '')
      );
    } else {
      setStatusMessage(
        `✏️ 第${ch.number}章可改 · 已定位` + (todoId ? '待修' : '本章')
      );
    }
    handleJumpChapter(chapterId, todoId);
  };

  /** 跨章抽检 issue → 跳转相关章并高亮对应 audit 待修 */
  const handleJumpAuditIssue = (
    issue: CrossChapterIssue,
    preferredChapterNumber?: number
  ) => {
    const proj = projectRef.current;
    if (!proj) return;
    const fallback =
      preferredChapterNumber ??
      issue.chapterNumbers?.[0] ??
      proj.lastCrossAudit?.rangeTo ??
      proj.chapters[proj.chapters.length - 1]?.number;
    if (fallback == null) {
      setStatusMessage('⚠️ 找不到相关章节');
      return;
    }
    const ch = proj.chapters.find((c) => c.number === fallback);
    if (!ch) {
      setStatusMessage(`⚠️ 第${fallback}章不存在`);
      return;
    }
    const todoId = makeAuditTodoId(issue, ch.number);
    const hasTodo = (ch.revisionTodos || []).some((t) => t.id === todoId);
    handleJumpChapter(ch.id, hasTodo ? todoId : undefined);
    setStatusMessage(
      `📍 已跳转第${ch.number}章` +
        (hasTodo ? ' · 高亮对应待修' : ` · [${issue.kind}] ${issue.title}`)
    );
  };

  const handleToggleRevisionTodo = (chapterId: string, todoId: string) => {
    handleUpdateAndPersistProject((prev) => ({
      chapters: prev.chapters.map((c) =>
        c.id === chapterId ? toggleRevisionTodoOnChapter(c, todoId) : c
      ),
    }));
  };

  /**
   * AI 修第一处 / 指定待修：模型局部改写正文，成功后自动勾完成。
   */
  const handleAiFixRevisionTodo = async (
    chapterId?: string,
    todoId?: string
  ) => {
    const proj = projectRef.current;
    if (!proj) return;
    if (generatingLockRef.current) {
      setStatusMessage('⚠️ 生成进行中，无法 AI 修待修。');
      return;
    }
    if (aiTasteScanBusy) {
      setStatusMessage('⚠️ 已有扫描/去味任务进行中。');
      return;
    }

    let targetChapterId = chapterId;
    let targetTodoId = todoId;
    if (!targetChapterId || !targetTodoId) {
      const first = pickFirstOpenRevision(proj.chapters);
      if (!first) {
        setStatusMessage('✅ 暂无待修项');
        return;
      }
      targetChapterId = first.chapterId;
      targetTodoId = first.todo.id;
    }

    const ch = proj.chapters.find((c) => c.id === targetChapterId);
    if (!ch) {
      setStatusMessage('⚠️ 章节不存在');
      return;
    }
    const todo = (ch.revisionTodos || []).find((t) => t.id === targetTodoId);
    if (!todo) {
      setStatusMessage('⚠️ 待修条目不存在（可能已清理）');
      return;
    }
    if (todo.status === 'done') {
      setStatusMessage('该待修已完成');
      return;
    }

    const lockedHint = isChapterLocked(ch) ? '（将自动解锁）' : '';
    const ok = window.confirm(
      `AI 修待修 · 第${ch.number}章${lockedHint}\n\n` +
        `${todo.text.slice(0, 120)}${todo.text.length > 120 ? '…' : ''}\n\n` +
        `将调用模型局部改写正文；成功后自动勾「完成」。\n建议先导出备份。继续？`
    );
    if (!ok) return;

    setActiveChapterId(ch.id);
    setActiveTab('workspace');
    setFocusRevisionTodo({ chapterId: ch.id, todoId: todo.id });
    setAiTasteScanBusy(true);
    setAiTasteScanMessage(`AI 修第${ch.number}章…`);
    setStatusMessage(`🤖 AI 修待修 · 第${ch.number}章…`);

    try {
      const r = await aiFixRevisionTodo({
        chapter: ch,
        todo,
        styleConfig: proj.styleConfig,
        characters: proj.characters,
        storyMemory: proj.memory,
        onProgress: (m) => {
          setAiTasteScanMessage(m);
          setStatusMessage(`🤖 ${m}`);
        },
      });

      if (!r.replaced) {
        setStatusMessage(`⚠️ ${r.message || 'AI 修未替换正文'}`);
        setAiTasteScanMessage(r.message);
        // 仍跳转定位，方便人工
        handleJumpChapter(ch.id, todo.id);
        return;
      }

      await handleUpdateAndPersistProject({
        chapters: proj.chapters.map((c) => (c.id === ch.id ? r.chapter : c)),
      });
      if (r.focusSnippet) setFocusProseSnippet(r.focusSnippet);
      setFocusRevisionTodo({ chapterId: ch.id, todoId: todo.id });
      const msg = r.message || 'AI 修完成';
      setAiTasteScanMessage(msg);
      setStatusMessage(`✨ ${msg}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMessage(`❌ AI 修失败：${msg}`);
      setAiTasteScanMessage(msg);
    } finally {
      setAiTasteScanBusy(false);
    }
  };

  /** 修第一处 = AI 修第一条优先待修 */
  const handleFixFirstRevision = () => {
    void handleAiFixRevisionTodo();
  };

  const handleClearDoneRevisionTodos = () => {
    const proj = projectRef.current;
    if (!proj) return;
    const { openCount, doneCount } = collectRevisionTodos(proj.chapters);
    if (doneCount === 0) {
      setStatusMessage('没有已完成的待修可清空');
      return;
    }
    const ok = window.confirm(
      `清空全书 ${doneCount} 条已完成待修？\n（未完成 ${openCount} 条会保留）`
    );
    if (!ok) return;
    const { chapters, removed } = clearDoneRevisionTodos(proj.chapters);
    handleUpdateAndPersistProject({ chapters });
    setStatusMessage(`🗑️ 已清空 ${removed} 条已完成待修`);
  };

  /** 只扫本章 AI 味 */
  const handleScanAiTasteChapter = async () => {
    const proj = projectRef.current;
    if (!proj || !activeChapterId) return;
    if (generatingLockRef.current) {
      setStatusMessage('⚠️ 生成进行中，请稍后再扫。');
      return;
    }
    const ch = proj.chapters.find((c) => c.id === activeChapterId);
    if (!ch) return;
    if ((ch.content || '').replace(/\s+/g, '').length < 40) {
      setStatusMessage('本章正文过短，无需扫描');
      return;
    }
    setAiTasteScanBusy(true);
    setAiTasteScanMessage('正在扫描本章 AI 味…');
    try {
      const r = scanChapterAiTasteOnly(ch, proj.styleConfig, { writeTodos: true });
      await handleUpdateAndPersistProject({
        chapters: proj.chapters.map((c) => (c.id === ch.id ? r.chapter : c)),
      });
      const msg = `本章 AI味 ${r.row.tier} · ${r.row.score}分 · ${r.row.summary}${
        r.todosAdded ? ` · 待修+${r.todosAdded}` : ''
      }`;
      setAiTasteScanMessage(msg);
      setStatusMessage(`✨ ${msg}`);
    } finally {
      setAiTasteScanBusy(false);
    }
  };

  /** 全书只扫 AI 味 */
  const handleScanAiTasteBook = async (writeTodos = false) => {
    const proj = projectRef.current;
    if (!proj) return;
    if (generatingLockRef.current) {
      setStatusMessage('⚠️ 生成进行中，请稍后再扫。');
      return;
    }
    const ok = window.confirm(
      writeTodos
        ? '扫描全书有正文的章节 AI 味，并将 medium/heavy 写入待修？\n（不改正文）'
        : '扫描全书有正文的章节 AI 味？（只更新机检报告，不改正文）'
    );
    if (!ok) return;
    setAiTasteScanBusy(true);
    setAiTasteScanMessage('全书 AI 味扫描中…');
    try {
      const r = scanBookAiTasteOnly(proj.chapters, proj.styleConfig, {
        writeTodos,
      });
      await handleUpdateAndPersistProject({ chapters: r.chapters });
      const msg = `全书扫完 ${r.scanned} 章 · 重${r.heavyCount}/中${r.mediumCount}/未过${r.failCount}${
        r.todosAdded ? ` · 待修+${r.todosAdded}` : ''
      }`;
      setAiTasteScanMessage(msg);
      setStatusMessage(`✨ ${msg}`);
    } finally {
      setAiTasteScanBusy(false);
    }
  };

  /** 批量去味本章前 N 处 error */
  const handleBatchDeslopChapter = async (maxHits = 3) => {
    const proj = projectRef.current;
    if (!proj || !activeChapterId) return;
    if (generatingLockRef.current) {
      setStatusMessage('⚠️ 生成进行中，无法批量去味。');
      return;
    }
    const ch = proj.chapters.find((c) => c.id === activeChapterId);
    if (!ch) return;
    if (isChapterLocked(ch)) {
      setStatusMessage('⚠️ 本章已锁定，请先解锁。');
      return;
    }
    const n = Math.max(1, Math.min(8, maxHits));
    const ok = window.confirm(
      `对第 ${ch.number} 章最多 ${n} 处 error 命中依次局部去AI味？\n\n会调用模型约 ${n} 次，可能改动正文。建议先导出备份。`
    );
    if (!ok) return;
    setAiTasteScanBusy(true);
    setAiTasteScanMessage(`批量去味中（最多 ${n} 处）…`);
    try {
      const r = await deslopTopErrorsInChapter({
        chapter: ch,
        styleConfig: proj.styleConfig,
        characters: proj.characters,
        storyMemory: proj.memory,
        maxHits: n,
        onProgress: (m) => setAiTasteScanMessage(m),
      });
      await handleUpdateAndPersistProject({
        chapters: proj.chapters.map((c) => (c.id === ch.id ? r.chapter : c)),
      });
      const errHint = r.errors.length ? ` · 失败 ${r.errors.length}` : '';
      const msg = `本章去味完成 · 成功 ${r.replaced}/${r.attempted} · ${r.tierBefore}→${r.tierAfter}${errHint}`;
      setAiTasteScanMessage(msg);
      setStatusMessage(`✨ ${msg}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMessage(`❌ 批量去味失败：${msg}`);
      setAiTasteScanMessage(msg);
    } finally {
      setAiTasteScanBusy(false);
    }
  };

  /**
   * 全书去味：medium/heavy 章每章最多 maxPer 处（默认 1，上限 3）。
   * 最多处理 20 章，控制 token。
   */
  const handleBatchDeslopBook = async (maxPerChapter = 1) => {
    const proj = projectRef.current;
    if (!proj) return;
    if (generatingLockRef.current) {
      setStatusMessage('⚠️ 生成进行中，无法全书去味。');
      return;
    }
    const maxPer = Math.max(1, Math.min(3, maxPerChapter));
    const lockedIds = new Set(
      proj.chapters.filter((c) => isChapterLocked(c)).map((c) => c.id)
    );
    const ok = window.confirm(
      `全书自动去AI味？\n\n` +
        `· 仅 medium/heavy 或机检未过的章\n` +
        `· 每章最多 ${maxPer} 处 error 局部改写\n` +
        `· 最多处理 20 章（按章号）\n` +
        `· 已锁定 ${lockedIds.size} 章将跳过\n` +
        `· 会多次调用模型，费用可能较高\n\n` +
        `强烈建议先导出 JSON 备份。确定继续？`
    );
    if (!ok) return;

    setAiTasteScanBusy(true);
    setAiTasteScanMessage('全书去味准备中…');
    try {
      const workChapters = proj.chapters.filter((c) => !lockedIds.has(c.id));
      const r = await deslopTopErrorsInBook({
        chapters: workChapters,
        styleConfig: proj.styleConfig,
        characters: proj.characters,
        storyMemory: proj.memory,
        maxPerChapter: maxPer,
        maxChapters: 20,
        onlyMediumPlus: true,
        onProgress: (m) => setAiTasteScanMessage(m),
      });

      const byId = new Map(r.chapters.map((c) => [c.id, c]));
      const merged = proj.chapters.map((c) =>
        lockedIds.has(c.id) ? c : byId.get(c.id) || c
      );

      await handleUpdateAndPersistProject({ chapters: merged });
      const errHint = r.errors.length ? ` · 失败 ${r.errors.length}` : '';
      const skipLock = lockedIds.size ? ` · 跳过锁${lockedIds.size}` : '';
      const msg = `全书去味 · 动 ${r.chaptersTouched} 章 · 替换 ${r.totalReplaced} 处${skipLock}${errHint}`;
      setAiTasteScanMessage(msg);
      setStatusMessage(`✨ ${msg}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMessage(`❌ 全书去味失败：${msg}`);
      setAiTasteScanMessage(msg);
    } finally {
      setAiTasteScanBusy(false);
    }
  };

  /** 导出全书 AI 味 CSV */
  const handleExportAiTasteCsv = () => {
    const proj = projectRef.current;
    if (!proj) return;
    const hasAudit = proj.chapters.some((c) => c.memoryAudit?.ruleScan || c.memoryAudit?.aiTasteTier);
    if (!hasAudit) {
      const ok = window.confirm(
        '尚未发现 AI 味扫描记录。是否先扫全书再导出？\n点「取消」仍会导出（空/旧数据）。'
      );
      if (ok) {
        void handleScanAiTasteBook(false).then(() => {
          const p2 = projectRef.current;
          if (!p2) return;
          const { filename, rowCount } = exportAiTasteCsv(p2.chapters, {
            bookTitle: p2.title,
          });
          setStatusMessage(`📥 已导出 ${filename}（${rowCount} 章）`);
          setAiTasteScanMessage(`已导出 CSV · ${rowCount} 章`);
        });
        return;
      }
    }
    const { filename, rowCount } = exportAiTasteCsv(proj.chapters, {
      bookTitle: proj.title,
    });
    setStatusMessage(`📥 已导出 ${filename}（${rowCount} 章）`);
    setAiTasteScanMessage(`已导出 CSV · ${rowCount} 章`);
  };

  /** 命中片段一键局部去 AI 味 */
  const handleDeslopHit = async (snippet: string) => {
    const proj = projectRef.current;
    if (!proj || !activeChapterId) return;
    if (generatingLockRef.current) {
      setStatusMessage('⚠️ 生成进行中，无法精修。');
      return;
    }
    const ch = proj.chapters.find((c) => c.id === activeChapterId);
    if (!ch) return;
    if (isChapterLocked(ch)) {
      setStatusMessage('⚠️ 本章已锁定，请先解锁再去味。');
      return;
    }
    setAiTasteScanBusy(true);
    setAiTasteScanMessage('局部去AI味中…');
    try {
      const r = await deslopHitInChapter({
        chapter: ch,
        snippet,
        styleConfig: proj.styleConfig,
        characters: proj.characters,
        storyMemory: proj.memory,
        onProgress: (m) => setAiTasteScanMessage(m),
      });
      if (!r.replaced) {
        setStatusMessage('未替换：正文未命中片段或改写无实质变化');
        return;
      }
      await handleUpdateAndPersistProject({
        chapters: proj.chapters.map((c) => (c.id === ch.id ? r.chapter : c)),
      });
      setFocusProseSnippet(r.after.slice(0, 40));
      setStatusMessage(
        `✨ 已局部去AI味 · ${r.before.slice(0, 12)}… → ${r.after.slice(0, 12)}…`
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMessage(`❌ 去味失败：${msg}`);
      setAiTasteScanMessage(msg);
    } finally {
      setAiTasteScanBusy(false);
    }
  };

  const handleMarkAllRevisionTodosDone = () => {
    const proj = projectRef.current;
    if (!proj) return;
    const first = pickFirstOpenRevision(proj.chapters);
    if (!first) {
      setStatusMessage('没有未完成待修');
      return;
    }
    const ok = window.confirm(
      '将全书未完成待修全部标为「完成」？\n\n不会改正文，仅勾清单。建议仅在已人工处理完后使用。'
    );
    if (!ok) return;
    const { chapters, marked } = markAllOpenTodosDone(proj.chapters);
    handleUpdateAndPersistProject({ chapters });
    setStatusMessage(`✅ 已勾完 ${marked} 条待修`);
  };

  /** AI 生成写前意图（不自动确认） */
  const handleGenerateChapterIntent = async (chapterId?: string) => {
    const proj = projectRef.current;
    if (!proj) return;
    const id = chapterId || activeChapterId;
    const ch = proj.chapters.find((c) => c.id === id);
    if (!ch) return;
    if (generatingLockRef.current) {
      setStatusMessage('⚠️ 生成进行中，请稍后再规划大纲。');
      return;
    }
    const pack = buildPreviousContextPack(proj.chapters, ch, {
      storyMemory: proj.memory,
      queryTerms: [ch.title, ch.summary || '', ...(ch.intent?.mustDo || [])],
    });
    const activeChars = (proj.characters || []).filter((c) =>
      ch.involvedCharacterIds?.includes(c.id)
    );
    const activeSets = (proj.settings || []).filter((s) =>
      ch.involvedSettingIds?.includes(s.id)
    );
    setStatusMessage(`第${ch.number}章 · 生成写前大纲...`);
    const intent = await generateChapterIntent({
      chapter: ch,
      characters: activeChars.length ? activeChars : proj.characters || [],
      settings: activeSets.length ? activeSets : proj.settings || [],
      previousContext: pack.text,
      storyMemory: proj.memory,
      previousContextPack: pack,
      onProgress: (msg) => setStatusMessage(msg),
    });
    await handleUpdateAndPersistProject((prev) => ({
      chapters: prev.chapters.map((c) =>
        c.id === id
          ? {
              ...c,
              intent,
              lastModified: new Date().toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              }),
            }
          : c
      ),
    }));
    setStatusMessage(
      `📋 第${ch.number}章写前大纲已生成（目标${intent.mustDo.length}/禁止${intent.mustAvoid.length}）· 请确认后开写`
    );
  };

  /** 解锁以便重写 */
  const handleUnlockChapter = (chapterId?: string) => {
    const id = chapterId || activeChapterId;
    if (!id) return;
    if (generatingLockRef.current) {
      setStatusMessage('⚠️ 生成进行中，无法改锁定状态。');
      return;
    }
    const ch = projectRef.current?.chapters.find((c) => c.id === id);
    if (!ch) return;
    const ok = window.confirm(
      `解锁第 ${ch.number} 章《${ch.title}》？\n\n解锁后可用流水线重写（会覆盖正文）。\n当前正文仍保留，直到你再次开写。\n建议先导出 JSON 或打手动快照。`
    );
    if (!ok) return;
    handleUpdateAndPersistProject((prev) => ({
      chapters: prev.chapters.map((c) => (c.id === id ? unlockChapterForRewrite(c) : c)),
    }));
    setStatusMessage('🔓 已解锁：可编辑正文，或重新跑本章闭环。');
  };

  return {
    handleAddChapter,
    handleDeleteChapter,
    handleClearAllChapters,
    handleClearAllChapterBodies,
    handleUpdateChapter,
    handleLockChapter,
    handleSaveChapterIntent,
    handleRunCrossAudit,
    handleDismissCrossAuditRemind,
    handleJumpChapter,
    handleOpenForRewrite,
    handleJumpAuditIssue,
    handleToggleRevisionTodo,
    handleAiFixRevisionTodo,
    handleFixFirstRevision,
    handleClearDoneRevisionTodos,
    handleScanAiTasteChapter,
    handleScanAiTasteBook,
    handleBatchDeslopChapter,
    handleBatchDeslopBook,
    handleExportAiTasteCsv,
    handleDeslopHit,
    handleMarkAllRevisionTodosDone,
    handleGenerateChapterIntent,
    handleUnlockChapter,
  };
}
