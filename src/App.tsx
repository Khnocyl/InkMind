import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  BookProject,
  Character,
  WorldSetting,
  Chapter,
  BookProjectSummary,
} from './types/novel';

import { defaultStyleConfig } from './mockData/initialBook';
import { TopNav } from './components/TopNav';
import { WorkspaceTab } from './components/Workspace/WorkspaceTab';
import { WorldBibleTab } from './components/WorldBible/WorldBibleTab';
import { TimelinePlanner } from './components/PlotPlanner/TimelinePlanner';
import { StyleAndEngineManager } from './components/StyleConfig/StyleAndEngineManager';
import { ProjectWizard } from './components/ProjectWizard/ProjectWizard';
import { ProjectSelectorModal } from './components/ProjectSelectorModal';
import {
  listProjects,
  saveProject,
  setActiveProjectId,
} from './services/storage';
import { buildPreviousContextPack } from './services/contextPack';
import { crossTabLock } from './services/crossTabLock';
import {
  clearDraftBackup,
  listDraftBackups,
  cleanupStaleDrafts,
} from './services/draftBackup';
import { migrateLegacySnapshots } from './services/snapshots';
import { useProjectPersistence } from './hooks/useProjectPersistence';
import { useProjectActions } from './hooks/useProjectActions';
import { useChapterActions } from './hooks/useChapterActions';
import { useChapterPipeline } from './hooks/useChapterPipeline';
import { useAutoPilot } from './hooks/useAutoPilot';
import {
  createSnapshot,
  restoreSnapshot,
} from './services/snapshots';
import {
  isChapterLocked,
} from './services/chapterLock';
import { evaluateCrossAuditRemind } from './services/crossAuditRemind';
import {
  type GenrePackOverride,
} from './services/genrePacks';
import { ReadingPreviewModal } from './components/Workspace/ReadingPreviewModal';

export default function App() {
  const [projectsList, setProjectsList] = useState<BookProjectSummary[]>([]);
  const [currentProject, setCurrentProject] = useState<BookProject | null>(null);
  const [activeTab, setActiveTab] = useState<'workspace' | 'world' | 'outline' | 'style'>(() => {
    try {
      const t = sessionStorage.getItem('novel-active-tab');
      if (t === 'workspace' || t === 'world' || t === 'outline' || t === 'style') return t;
    } catch {
      /* ignore */
    }
    return 'workspace';
  });
  const [worldSubTab, setWorldSubTab] = useState<'characters' | 'settings' | 'memory'>('characters');
  const [activeChapterId, setActiveChapterId] = useState<string>('');

  // UI 模态窗控制
  const [isWizardOpen, setIsWizardOpen] = useState<boolean>(false);
  const [isSelectorOpen, setIsSelectorOpen] = useState<boolean>(false);
  const [isReadingPreviewOpen, setIsReadingPreviewOpen] = useState(false);
  const [crossAuditBusy, setCrossAuditBusy] = useState(false);
  /** 向导完成后引导去跑 Doctor */
  const [postWizardDoctorHint, setPostWizardDoctorHint] = useState(false);
  /** 全书待修 → 画布高亮 todo（消费后清空） */
  const [focusRevisionTodo, setFocusRevisionTodo] = useState<{
    chapterId: string;
    todoId: string;
  } | null>(null);
  /** AI 味报告 → 正文选区定位 */
  const [focusProseSnippet, setFocusProseSnippet] = useState<string | null>(null);
  const [aiTasteScanBusy, setAiTasteScanBusy] = useState(false);
  const [aiTasteScanMessage, setAiTasteScanMessage] = useState<string | null>(null);

  // AI 状态控制
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAutoPiloting, setIsAutoPiloting] = useState(false);
  const [autoPilotProgress, setAutoPilotProgress] = useState({ done: 0, target: 0 });
  const [activeStep, setActiveStep] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>('');
  /** 触发快照列表刷新 */
  const [snapshotRefreshToken, setSnapshotRefreshToken] = useState(0);
  /** 初始化失败时展示可恢复 UI，避免永远转圈像白屏 */
  const [initError, setInitError] = useState<string | null>(null);

  /** 始终指向最新 project，避免长异步工作流闭包脏写 */
  const projectRef = useRef<BookProject | null>(null);

  /** 防止双击并发跑多条工作流 */
  const generatingLockRef = useRef(false);
  /** Auto-Pilot 是否在跑（供流水线内判断，避免 setState 闭包滞后） */
  const isAutoPilotingRef = useRef(false);

  const setProjectSafe = useCallback((next: BookProject | null) => {
    projectRef.current = next;
    setCurrentProject(next);
  }, []);

  /** R2-3 合并式持久化 + 落盘路径（R1 拆分：见 hooks/useProjectPersistence） */
  const { handleUpdateAndPersistProject } = useProjectPersistence({
    projectRef,
    setProjectSafe,
    setProjectsList,
  });

  const patchProjectLocal = useCallback((updater: (prev: BookProject) => BookProject) => {
    setCurrentProject((prev) => {
      if (!prev) return null;
      const next = updater(prev);
      projectRef.current = next;
      return next;
    });
  }, []);

  // R1：项目生命周期 + 导入导出动作域（逻辑见 hooks/useProjectActions）
  const {
    initWorkspace,
    openProjectInWorkspace,
    refreshProjectsList,
    tryRecoverStyleProfiles,
    handleSelectProject,
    handleCreateNewProject,
    handleDeleteProject,
    handleExportJson,
    handleExportMarkdown,
    handleExportEpub,
    handleImportFile,
  } = useProjectActions({
    projectRef,
    generatingLockRef,
    currentProject,
    projectsList,
    setProjectSafe,
    setProjectsList,
    setActiveChapterId,
    setIsWizardOpen,
    setIsSelectorOpen,
    setStatusMessage,
    setInitError,
  });

  // 1. 初始挂载：从 IndexedDB 加载小说书目
  useEffect(() => {
    initWorkspace();
  }, []);

  // R2-2：启动后延迟执行旧版明文快照 → gzip 后台迁移（不阻塞首屏，幂等）
  useEffect(() => {
    const t = window.setTimeout(() => {
      migrateLegacySnapshots()
        .then((n) => {
          if (n > 0) console.info(`快照压缩迁移完成：${n} 条`);
        })
        .catch((e) => console.warn('快照压缩迁移失败（可稍后重试）:', e));
    }, 4000);
    return () => window.clearTimeout(t);
  }, []);

  // 外部 setCurrentProject 路径（向导等）同步 ref
  useEffect(() => {
    projectRef.current = currentProject;
  }, [currentProject]);

  // 记住当前工作区 Tab，避免保存配置/刷新后被弹回创作台
  useEffect(() => {
    try {
      sessionStorage.setItem('novel-active-tab', activeTab);
    } catch {
      /* ignore */
    }
  }, [activeTab]);


  /** 打开书后：检查是否有可恢复的流式草稿（崩溃/刷新保护） */
  useEffect(() => {
    const pid = currentProject?.id;
    if (!pid) return;
    let cancelled = false;
    void (async () => {
      try {
        const drafts = await listDraftBackups(pid);
        if (cancelled || drafts.length === 0) return;
        const chapters = projectRef.current?.chapters || [];

        // 已被终稿覆盖的备份：直接清除（终稿落盘路径已清，这里是兜底清理）
        const superseded = drafts.filter((d) => {
          const ch = chapters.find((c) => c.id === d.chapterId);
          return (
            ch &&
            ch.contentUpdatedAt &&
            d.updatedAt <= ch.contentUpdatedAt
          );
        });
        for (const d of superseded) {
          await clearDraftBackup(pid, d.chapterId);
        }

        // 可恢复：草稿非空、与项目内容不一致、且比项目内容新
        const candidates = drafts.filter((d) => {
          if (!d.content.trim()) return false;
          const ch = chapters.find((c) => c.id === d.chapterId);
          if (ch && ch.content === d.content) return false;
          if (ch && ch.contentUpdatedAt && d.updatedAt <= ch.contentUpdatedAt) return false;
          return true;
        });
        if (cancelled || candidates.length === 0) return;

        const newest = candidates[0]; // listDraftBackups 已按 updatedAt 倒序
        const ok = window.confirm(
          `检测到「第${newest.chapterNumber}章《${newest.chapterTitle}》」有一份未完成的流式草稿（${newest.wordCount} 字，备份于 ${new Date(newest.updatedAt).toLocaleTimeString()}）。\n\n上次生成可能被中断。是否恢复该草稿为正文？（状态将置为「正文草稿」并覆盖当前内容）`
        );
        if (cancelled || !ok) return;

        await handleUpdateAndPersistProject((prev) => ({
          chapters: prev.chapters.map((c) =>
            c.id === newest.chapterId
              ? {
                  ...c,
                  content: newest.content,
                  wordCount: newest.wordCount,
                  status: '正文草稿' as const,
                  locked: false,
                  lockedAt: undefined,
                  contentUpdatedAt: new Date().toISOString(),
                }
              : c
          ),
        }));
        await clearDraftBackup(pid, newest.chapterId);
        setStatusMessage(
          `♻️ 已从流式草稿恢复「第${newest.chapterNumber}章」正文（${newest.wordCount} 字）`
        );
      } catch (e) {
        console.warn('流式草稿恢复检查失败:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // currentProject.id 切换（打开书）时检查一次；其余更新不重复弹窗
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id]);

  /** 启动时清理超期流式草稿备份 */
  useEffect(() => {
    cleanupStaleDrafts()
      .then((n) => {
        if (n > 0) console.log(`[草稿备份] 已清理 ${n} 条过期流式草稿`);
      })
      .catch(() => {});
  }, []);

  /** 只改本地 state（流式中间态），不立刻打盘，避免与终稿竞态 */
  const patchChapterLocal = useCallback(
    (chapterId: string, patch: Partial<Chapter> | ((c: Chapter) => Chapter)) => {
      patchProjectLocal((prev) => ({
        ...prev,
        chapters: (prev.chapters || []).map((c) => {
          if (c.id !== chapterId) return c;
          return typeof patch === 'function' ? patch(c) : { ...c, ...patch };
        }),
      }));
    },
    [patchProjectLocal]
  );

  /**
   * 注意：以下 hooks 必须在任何条件 return 之前声明。
   * 若放在 `if (!currentProject)` / `if (isWizardOpen)` 之后，
   * 加载完成或进出向导时 hooks 数量变化 → React 直接白屏崩溃。
   */
  const bumpSnapshotList = useCallback(() => {
    setSnapshotRefreshToken((n) => n + 1);
  }, []);

  /** 手动全书快照 */
  const handleManualSnapshot = useCallback(async () => {
    const proj = projectRef.current;
    if (!proj) throw new Error('无当前项目');
    if (generatingLockRef.current) throw new Error('生成进行中，请稍后再快照');
    const ch = (proj.chapters || []).find((c) => c.id === activeChapterId);
    await createSnapshot(proj, {
      reason: 'manual',
      chapterId: ch?.id,
      chapterNumber: ch?.number,
      chapterTitle: ch?.title,
    });
    bumpSnapshotList();
    setStatusMessage(
      `📸 已创建手动快照 · 《${proj.title}》· ${(proj.chapters || []).length} 章`
    );
  }, [activeChapterId, bumpSnapshotList]);

  /** 从快照回滚全书 */
  const handleRestoreSnapshot = useCallback(
    async (snapshotId: string) => {
      if (generatingLockRef.current) {
        throw new Error('生成进行中，无法回滚');
      }
      const current = projectRef.current;
      const { project: restored, safetySnapshot, restoredFrom } = await restoreSnapshot(
        snapshotId,
        current
      );
      const chapters = Array.isArray(restored.chapters) ? restored.chapters : [];
      setProjectSafe({ ...restored, chapters });
      setActiveChapterId(restored.currentChapterId || chapters[0]?.id || '');
      try {
        const list = await listProjects();
        setProjectsList(list);
      } catch {
        /* 列表刷新失败不阻断回滚结果 */
      }
      await setActiveProjectId(restored.id).catch(() => {});
      bumpSnapshotList();
      setStatusMessage(
        `⏪ 已回滚到「${restoredFrom.label}」` +
          (safetySnapshot ? ` · 回滚前已备份「${safetySnapshot.label}」` : '')
      );
    },
    [bumpSnapshotList, setProjectSafe]
  );

  // R1：styleConfig 提前派生（条件 return 之前），供 useChapterPipeline 使用
  const styleConfig = currentProject?.styleConfig || defaultStyleConfig;

  // R1：单章写作管线（逻辑见 hooks/useChapterPipeline）
  const { runChapterPipeline } = useChapterPipeline({
    projectRef,
    isAutoPilotingRef,
    styleConfig,
    setStatusMessage,
    setActiveChapterId,
    setActiveStep,
    patchChapterLocal,
    handleUpdateAndPersistProject,
    bumpSnapshotList,
  });

  // R1：Auto-Pilot 连写循环（逻辑见 hooks/useAutoPilot）
  const { handleStartAutoPilot, handleStopAutoPilot } = useAutoPilot({
    projectRef,
    generatingLockRef,
    isAutoPilotingRef,
    styleConfig,
    runChapterPipeline,
    handleUpdateAndPersistProject,
    setStatusMessage,
    isGenerating,
    isAutoPiloting,
    setIsGenerating,
    setIsAutoPiloting,
    setAutoPilotProgress,
    setActiveStep,
  });

  // R1：章节动作域（逻辑见 hooks/useChapterActions）
  const {
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
  } = useChapterActions({
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
  });

  if (!currentProject) {
    return (
      <div className="min-h-screen bg-white text-black flex items-center justify-center font-sans theme-paper">
        {initError ? (
          <div className="flex flex-col items-center space-y-4 max-w-md px-6 text-center">
            <p className="text-base font-bold text-red-700">书库加载失败</p>
            <p className="text-xs text-slate-600 break-all">{initError}</p>
            <button
              type="button"
              className="px-4 py-2 rounded-lg bg-black text-white text-sm font-semibold hover:bg-neutral-800"
              onClick={() => {
                void initWorkspace();
              }}
            >
              重试加载
            </button>
            <p className="text-[11px] text-slate-500">
              若持续失败，可尝试清除本站站点数据后刷新，或从备份 JSON 导入。
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center space-y-4 animate-pulse">
            <div className="w-12 h-12 border-4 border-cyan-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm font-semibold">正在从 IndexedDB 安全加载全书图谱与本地引擎...</p>
          </div>
        )}
      </div>
    );
  }

  // 处于向导流程中
  if (isWizardOpen) {
    return (

      <ProjectWizard
        project={currentProject}
        onProjectChange={(updated) => {
          setProjectSafe(updated);
        }}
        onComplete={async (finalProject) => {
          const ready: BookProject = {
            ...finalProject,
            wizardStep: 'ready',
            lastModified: new Date().toISOString(),
          };
          await saveProject(ready);
          await refreshProjectsList();
          setIsWizardOpen(false);
          await openProjectInWorkspace(ready, { openWizardIfIncomplete: false });
          setActiveTab('style');
          setPostWizardDoctorHint(true);
          setStatusMessage(
            '✅ 新书就绪。已跳转「引擎与风格」——建议先跑 Doctor 诊断，确认 API 可用后再开写。'
          );
        }}
        onBackToMenu={async () => {
          // 退出向导时强制重拉书库，避免列表为空/过期
          try {
            await refreshProjectsList();
          } catch (err) {
            console.error('刷新书库失败:', err);
          }
          setIsWizardOpen(false);
          setIsSelectorOpen(true);
        }}
      />
    );
  }

  const characters = currentProject.characters || [];
  const settings = currentProject.settings || [];
  const chapters = currentProject.chapters || [];
  const volumes = currentProject.volumes || [];
  const activeChapter = chapters.find((c) => c.id === activeChapterId) || chapters[0];
  const totalWords = chapters.reduce((sum, c) => sum + (c.wordCount || 0), 0);

  // 增加新角色 / 设定 / 章节（一律基于最新 prev，避免闭包脏写）
  const handleAddCharacter = (newChar: Character) => {
    handleUpdateAndPersistProject((prev) => ({
      characters: [newChar, ...(prev.characters || [])],
    }));
  };

  const handleUpdateCharacter = (updatedChar: Character) => {
    handleUpdateAndPersistProject((prev) => ({
      characters: (prev.characters || []).map((c) => (c.id === updatedChar.id ? updatedChar : c)),
    }));
  };

  const handleAddSetting = (newSet: WorldSetting) => {
    handleUpdateAndPersistProject((prev) => ({
      settings: [newSet, ...(prev.settings || [])],
    }));
  };


  // 当前章写前前情包（上章摘要 + 正文尾段）
  const previousContextPack = activeChapter
    ? buildPreviousContextPack(chapters, activeChapter, {
        storyMemory: currentProject.memory,
        queryTerms: [
          activeChapter.title,
          activeChapter.summary || '',
          ...(activeChapter.intent?.mustDo || []),
        ],
      })
    : null;

  /**
   * 单章全链路（1–6）：分镜→正文→审校→修复→recap→记忆→终态落盘。
   * 调用方负责 generatingLock；本函数不抢锁。
   * @param force 强制覆盖已锁定章（仅人工确认后传入；Auto-Pilot 永不 force）
   */
  // R1：runChapterPipeline 已迁至 hooks/useChapterPipeline（逻辑零改动）






  // R1：pipeline 已迁至 hooks/useChapterPipeline（逻辑零改动）

  // 单章：用户点「启动三步」——锁定章需二次确认后 force
  const handleStartThreeStepWorkflow = async () => {
    if (generatingLockRef.current || isGenerating || isAutoPiloting || !activeChapter) return;

    let force = false;
    if (isChapterLocked(activeChapter)) {
      const ok = window.confirm(
        `第 ${activeChapter.number} 章已定稿锁定。\n\n强制重写将：\n1. 自动解锁\n2. 写前打快照\n3. 清空并覆盖正文\n\n确定继续？`
      );
      if (!ok) {
        setStatusMessage('已取消：锁定章未覆盖。');
        return;
      }
      force = true;
    }

    if (!crossTabLock.acquire(currentProject?.id ?? '', '单章三步')) {
      setStatusMessage('⚠️ 其他标签页正在生成本书，已阻止本次「三步」启动（跨标签锁）。');
      return;
    }
    generatingLockRef.current = true;
    setIsGenerating(true);
    try {
      await runChapterPipeline(activeChapter.id, { force });
    } finally {
      crossTabLock.release();
      generatingLockRef.current = false;
      setIsGenerating(false);
      setActiveStep(0);
    }
  };

  // R1：Auto-Pilot 已迁至 hooks/useAutoPilot（逻辑零改动）

  return (
    <div className="min-h-screen bg-white text-black flex flex-col font-sans select-none overflow-hidden theme-paper">

      <TopNav
        project={currentProject}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        styleConfig={styleConfig}
        totalWords={totalWords}
        onOpenProjectSelector={() => setIsSelectorOpen(true)}
        onOpenWizard={() => {
          // 已完成书也可浏览向导，但不会改写 ready；未完成则续孵
          setIsWizardOpen(true);
        }}
        onOpenReadingPreview={() => setIsReadingPreviewOpen(true)}
      />

      <div className="flex-1 flex overflow-hidden">
        {activeTab === 'workspace' && (
          <WorkspaceTab
            chapters={chapters}
            volumes={volumes}
            activeChapterId={activeChapterId}
            activeChapter={activeChapter}
            characters={characters}
            settings={settings}
            styleConfig={styleConfig}
            storyMemory={currentProject.memory ?? null}
            projectConfig={currentProject.config}
            isGenerating={isGenerating}
            isAutoPiloting={isAutoPiloting}
            autoPilotProgress={autoPilotProgress}
            activeStep={activeStep}
            statusMessage={statusMessage}
            previousContextPack={previousContextPack}
            projectId={currentProject.id}
            snapshotRefreshToken={snapshotRefreshToken}
            dailyWordLog={currentProject.dailyWordLog ?? null}
            crossAuditReport={currentProject.lastCrossAudit ?? null}
            crossAuditBusy={crossAuditBusy}
            crossAuditRemind={evaluateCrossAuditRemind(currentProject)}
            aiTasteScanBusy={aiTasteScanBusy}
            aiTasteScanMessage={aiTasteScanMessage}
            focusTodoId={
              focusRevisionTodo?.chapterId === activeChapter?.id
                ? focusRevisionTodo.todoId
                : null
            }
            focusSnippet={focusProseSnippet}
            onSelectChapter={(id) => {
              if (generatingLockRef.current || isGenerating) {
                setStatusMessage('⚠️ 生成进行中，请勿切换章节以免状态错乱。');
                return;
              }
              setActiveChapterId(id);
            }}
            onAddChapter={handleAddChapter}
            onDeleteChapter={handleDeleteChapter}
            onClearAllChapters={handleClearAllChapters}
            onClearAllChapterBodies={handleClearAllChapterBodies}
            onUpdateChapter={handleUpdateChapter}
            onLockChapter={() => handleLockChapter(activeChapter?.id)}
            onUnlockChapter={() => handleUnlockChapter(activeChapter?.id)}
            onFocusTodoConsumed={() => setFocusRevisionTodo(null)}
            onFocusSnippetConsumed={() => setFocusProseSnippet(null)}
            onStartThreeStepWorkflow={handleStartThreeStepWorkflow}
            onStartAutoPilot={handleStartAutoPilot}
            onStopAutoPilot={handleStopAutoPilot}
            onUpdateStyleConfig={(updated) =>
              handleUpdateAndPersistProject((prev) => {
                const base = prev.styleConfig || defaultStyleConfig;
                const next =
                  typeof updated === 'function'
                    ? (updated as (s: typeof base) => typeof base)(base)
                    : updated;
                return { styleConfig: next };
              })
            }
            onUpdateBeats={(beats) => {
              if (activeChapter) handleUpdateChapter({ ...activeChapter, beats });
            }}
            onManualSnapshot={handleManualSnapshot}
            onRestoreSnapshot={handleRestoreSnapshot}
            onGenerateChapterIntent={() => {
              if (activeChapter) handleGenerateChapterIntent(activeChapter.id);
            }}
            onSaveChapterIntent={handleSaveChapterIntent}
            onRunCrossAudit={handleRunCrossAudit}
            onDismissCrossAuditRemind={handleDismissCrossAuditRemind}
            onJumpChapter={handleJumpChapter}
            onOpenForRewrite={handleOpenForRewrite}
            onJumpAuditIssue={handleJumpAuditIssue}
            onLocateInProse={(snippet) => {
              setActiveTab('workspace');
              setFocusProseSnippet(snippet);
            }}
            onScanAiTasteChapter={handleScanAiTasteChapter}
            onScanAiTasteBook={handleScanAiTasteBook}
            onDeslopHit={handleDeslopHit}
            onBatchDeslopChapter={handleBatchDeslopChapter}
            onBatchDeslopBook={handleBatchDeslopBook}
            onExportAiTasteCsv={handleExportAiTasteCsv}
            onFixFirstRevision={handleFixFirstRevision}
            onAiFixRevisionTodo={(cid, tid) => void handleAiFixRevisionTodo(cid, tid)}
            onClearDoneRevisionTodos={handleClearDoneRevisionTodos}
            onMarkAllRevisionTodosDone={handleMarkAllRevisionTodosDone}
            onToggleRevisionTodo={handleToggleRevisionTodo}
          />
        )}

        {activeTab === 'world' && (
          <WorldBibleTab
            characters={characters}
            settings={settings}
            chapters={chapters}
            volumes={volumes}
            memory={currentProject.memory}
            worldSubTab={worldSubTab}
            onWorldSubTabChange={setWorldSubTab}
            currentChapterNumber={activeChapter?.number}
            onAddCharacter={handleAddCharacter}
            onUpdateCharacter={handleUpdateCharacter}
            onAddSetting={handleAddSetting}
            onUpdateMemory={(memory) => handleUpdateAndPersistProject({ memory })}
            onPatchBible={(patch) => handleUpdateAndPersistProject(patch)}
          />
        )}

        {activeTab === 'outline' && (
          <TimelinePlanner
            outlines={chapters.map((c) => ({
              id: c.id,
              order: c.number,
              chapterTitle: c.title,
              summary: c.summary,
              involvedCharacterIds: c.involvedCharacterIds,
              involvedSettingIds: c.involvedSettingIds,
              wordCountTarget: 3000,
            }))}
            characters={characters}
            settings={settings}
          />
        )}

        {activeTab === 'style' && (
          <StyleAndEngineManager
            styleConfig={styleConfig}
            onUpdateStyleConfig={(updated) =>
              handleUpdateAndPersistProject((prev) => ({
                styleConfig:
                  typeof updated === 'function'
                    ? updated(prev.styleConfig || defaultStyleConfig)
                    : updated,
              }))
            }
            onNotifyStatus={(msg) => setStatusMessage(msg)}
            onRecoverStyleProfiles={() =>
              void (async () => {
                const p = projectRef.current;
                if (!p) return;
                const next = await tryRecoverStyleProfiles(p);
                if ((next.styleConfig?.styleProfiles || []).length === 0) {
                  setStatusMessage(
                    '未在快照中找到文风档案。请重新「分析并导入仿写」，或从 JSON 备份导入。'
                  );
                }
              })()
            }
            genre={currentProject.genre}
            projectConfig={currentProject.config}
            highlightDoctor={postWizardDoctorHint}
            onDoctorHintConsumed={() => setPostWizardDoctorHint(false)}
            onUpdateGenre={(genreName, packId) =>
              handleUpdateAndPersistProject((prev) => ({
                genre: genreName,
                config: {
                  ...prev.config,
                  genre: genreName,
                  customParameters: {
                    ...(prev.config?.customParameters || {}),
                    genrePackId: packId,
                  },
                },
              }))
            }
            onUpdateProjectConfig={(config) =>
              handleUpdateAndPersistProject({ config })
            }
            onSaveGenreOverride={(packId, override: GenrePackOverride | null) =>
              handleUpdateAndPersistProject((prev) => ({
                genre: override?.name || prev.genre,
                config: {
                  ...prev.config,
                  genre: override?.name || prev.config?.genre || prev.genre,
                  customParameters: {
                    ...(prev.config?.customParameters || {}),
                    genrePackId: packId,
                    genrePackOverride: override || undefined,
                  },
                },
              }))
            }
          />
        )}
      </div>

      {/* 书库与项目切换模态窗 */}
      <ProjectSelectorModal
        isOpen={isSelectorOpen}
        onClose={() => setIsSelectorOpen(false)}
        projects={projectsList}
        activeProjectId={currentProject.id}
        onSelectProject={handleSelectProject}
        onCreateNewProject={handleCreateNewProject}
        onDeleteProject={handleDeleteProject}
        onExportJson={handleExportJson}
        onExportMarkdown={handleExportMarkdown}
        onExportEpub={handleExportEpub}
        onImportFile={handleImportFile}
        busy={isGenerating || isAutoPiloting}
        onOpen={async () => {
          try {
            await refreshProjectsList();
          } catch (err) {
            console.error('打开书库时刷新失败:', err);
          }
        }}
      />

      <ReadingPreviewModal
        open={isReadingPreviewOpen}
        project={currentProject}
        initialChapterId={activeChapterId}
        onClose={() => setIsReadingPreviewOpen(false)}
      />
    </div>
  );
}
