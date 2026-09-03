import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type {
  BookProject,
  Chapter,
  PlotBeat,
  StyleConfig,
} from '../types/novel';
import {
  isVerificationScoreGreen,
  MIN_GREEN_VERIFICATION_SCORE,
} from '../services/aiEngine';
import {
  runChapterPipeline as runEnginePipeline,
  type ChapterPipelineResult as EngineChapterResult,
  type EngineProgress,
  type EngineViolation,
} from '../engine';
import { buildPreviousContextPack } from '../services/contextPack';
import {
  scheduleDraftBackup,
  flushDraftBackup,
  clearDraftBackup,
} from '../services/draftBackup';
import {
  createSnapshot,
} from '../services/snapshots';
import {
  resolveAutoPilotConfig,
  type AutoPilotWriteMode,
  type ChapterPipelineResult,
} from '../services/autoPilot';
import {
  canPipelineOverwrite,
  isChapterLocked,
  unlockChapterForRewrite,
} from '../services/chapterLock';
import { formatStoryMemoryForPrompt, mergeRecapIntoMemory } from '../services/storyMemory';
import { detectRecapConflicts } from '../services/memoryConsistency';
import {
  applyHardIssuesAsRevisionTodos,
  enrichSnapshotWithLlm,
  extractChapterFactSnapshot,
  mergeSnapshotIntoMemory,
  syncDeathsFromLedgerToCharacters,
  syncLedgerEntitiesToMemory,
} from '../services/factLedger';
import { applyAiTasteHitsAsRevisionTodos } from '../services/aiTasteScan';
import { pruneStaleAutoTodos } from '../services/revisionTodos';
import { fingerprintProse } from '../services/auditFreshness';
import { retrieveMemoryForChapterAsync } from '../services/embeddingIndex';
import { scheduleAutoBackup } from '../services/autoBackup';
import { resolveChapterWordTarget, proseWords } from '../services/proseWords';
import { consolidateMemoryAfterChapter } from '../services/longformMemory';
import {
  buildFallbackChapterIntent,
  emptyIntent,
  ensureAutoPilotIntent,
  formatIntentForPrompt,
  generateChapterIntent,
  hasIntentDraft,
  isIntentConfirmed,
} from '../services/chapterIntent';
import {
  accrueDailyWords,
  countContentWords,
} from '../services/dailyWordLog';
import {
  formatGenrePackForPrompt,
  mergeGenreBlacklist,
  resolveGenrePackForProject,
} from '../services/genrePacks';

export interface UseChapterPipelineDeps {
  /** 始终指向最新 project 的 ref（长异步工作流防闭包脏写） */
  projectRef: MutableRefObject<BookProject | null>;
  /** Auto-Pilot 是否在跑（流水线内判断，避免 setState 闭包滞后） */
  isAutoPilotingRef: MutableRefObject<boolean>;
  /** 组件级 styleConfig 回退（渲染层派生，currentProject 非空时 = 项目配置） */
  styleConfig: StyleConfig;
  setStatusMessage: (msg: string) => void;
  setActiveChapterId: (id: string) => void;
  setActiveStep: (step: number) => void;
  /** 只改本地 state（流式中间态），不立刻打盘，避免与终稿竞态 */
  patchChapterLocal: (
    chapterId: string,
    patch: Partial<Chapter> | ((c: Chapter) => Chapter)
  ) => void;
  handleUpdateAndPersistProject: (
    updates: Partial<BookProject> | ((prev: BookProject) => Partial<BookProject>)
  ) => Promise<void>;
  bumpSnapshotList: () => void;
}

/**
 * 单章写作管线（R1 拆分第二步）。
 *
 * 从 App.tsx 原样搬移（零逻辑改动），外部依赖收敛为 deps 对象：
 * refs（projectRef / isAutoPilotingRef）、状态 setter、落盘路径、
 * 本地 patch、快照列表刷新、styleConfig 回退。
 *
 * 调用方负责 generatingLock；本函数不抢锁。
 */
export function useChapterPipeline(deps: UseChapterPipelineDeps) {
  const {
    projectRef,
    isAutoPilotingRef,
    styleConfig,
    setStatusMessage,
    setActiveChapterId,
    setActiveStep,
    patchChapterLocal,
    handleUpdateAndPersistProject,
    bumpSnapshotList,
  } = deps;

  const runChapterPipeline = useCallback(
    async (
      chapterId: string,
      options?: {
        force?: boolean;
        writeMode?: AutoPilotWriteMode;
        /** 用户中止信号：贯通到引擎与全部 LLM 调用 */
        signal?: AbortSignal;
      }
    ): Promise<ChapterPipelineResult> => {
      const writeMode: AutoPilotWriteMode = options?.writeMode || 'until_green';
      const projectAtStart = projectRef.current;
      if (!projectAtStart) {
        return {
          chapterId,
          chapterNumber: 0,
          ok: false,
          ruleScanPassed: false,
          score: 0,
          status: '正文草稿',
          error: '无项目',
        };
      }

      const chapterSnapshot = projectAtStart.chapters.find((c) => c.id === chapterId);
      if (!chapterSnapshot) {
        return {
          chapterId,
          chapterNumber: 0,
          ok: false,
          ruleScanPassed: false,
          score: 0,
          status: '正文草稿',
          error: '章节不存在',
        };
      }

      // 定稿锁定硬门：Auto-Pilot / 未授权强制 一律拒绝
      const gate = canPipelineOverwrite(chapterSnapshot, { force: options?.force === true });
      if (!gate.ok) {
        setStatusMessage(`🔒 ${gate.reason}`);
        return {
          chapterId,
          chapterNumber: chapterSnapshot.number,
          ok: false,
          ruleScanPassed: false,
          score: 0,
          status: chapterSnapshot.status,
          error: gate.reason,
        };
      }

      // 若强制重写锁定章：先解锁状态，避免半途又被 UI 挡
      if (options?.force && isChapterLocked(chapterSnapshot)) {
        const unlocked = unlockChapterForRewrite(chapterSnapshot);
        patchChapterLocal(chapterId, unlocked);
        await handleUpdateAndPersistProject((prev) => ({
          chapters: prev.chapters.map((c) => (c.id === chapterId ? { ...c, ...unlocked } : c)),
        }));
      }

      const projectForSnap = projectRef.current || projectAtStart;
      const chapterForSnap =
        projectForSnap.chapters.find((c) => c.id === chapterId) || chapterSnapshot;

      // 写前保护快照：失败不阻断写作
      try {
        await createSnapshot(projectForSnap, {
          reason: 'pre_write',
          chapterId: chapterForSnap.id,
          chapterNumber: chapterForSnap.number,
          chapterTitle: chapterForSnap.title,
        });
        bumpSnapshotList();
      } catch (snapErr) {
        console.warn('写前快照失败（继续写作）:', snapErr);
      }

      setActiveChapterId(chapterId);
      setActiveStep(1);

      // 以最新 ref 为准（强制解锁后状态可能已变）
      const liveProject = projectRef.current || projectAtStart;
      const liveChapter =
        liveProject.chapters.find((c) => c.id === chapterId) || chapterSnapshot;

      const styleSnapshot = { ...(liveProject.styleConfig || styleConfig) };
      const allChapters = liveProject.chapters || [];
      const allCharacters = liveProject.characters || [];
      const allSettings = liveProject.settings || [];

      const contextPack = buildPreviousContextPack(allChapters, liveChapter, {
        storyMemory: liveProject.memory,
        queryTerms: [
          liveChapter.title,
          liveChapter.summary || '',
          ...(liveChapter.intent?.mustDo || []),
        ],
      });
      const previousContext = contextPack.text;
      const activeChars = allCharacters.filter((c) =>
        liveChapter.involvedCharacterIds?.includes(c.id)
      );
      const activeSets = allSettings.filter((s) =>
        liveChapter.involvedSettingIds?.includes(s.id)
      );
      // 写前记忆检索（相关事实 + 伏笔债务 + 快照）
      let workingChapter = liveChapter;
      let memoryRetrieval = await retrieveMemoryForChapterAsync({
        chapter: workingChapter,
        memory: liveProject.memory,
        characters: allCharacters,
        allChapters,
        chapterNumber: workingChapter.number,
        projectId: liveProject.id,
      });
      let storyMemoryBlock = formatStoryMemoryForPrompt(
        liveProject.memory,
        allCharacters,
        {
          characterIds: liveChapter.involvedCharacterIds,
          retrievalPromptBlock: memoryRetrieval.promptBlock,
        }
      );

      let streamBuffer = '';
      // 流式 UI 节流（性能）：LLM chunk 频率远高于人眼需要——120ms 合并
      // 一次 setState（每 chunk 全项目 setState 会卡长书）；草稿备份自带 800ms 去抖不受影响
      let lastStreamUiAt = 0;
      let streamUiTimer: ReturnType<typeof setTimeout> | null = null;
      let pendingStreamText: string | null = null;
      const flushStreamUi = () => {
        lastStreamUiAt = Date.now();
        const text = pendingStreamText;
        if (text == null) return;
        patchChapterLocal(chapterId, {
          content: text,
          wordCount: proseWords(text),
          status: '正文草稿',
          locked: false,
        });
      };
      /** 流水线开始时正文字数，用于日更净增（中间 patch 不清空账本） */
      const pipelineStartWords = countContentWords(
        workingChapter.content,
        workingChapter.wordCount
      );
      /** 测速：管线墙钟时间与生成速度（成功消息附带） */
      const pipelineStartedAt = Date.now();
      const formatTiming = (words: number): string => {
        const sec = Math.max(1, Math.round((Date.now() - pipelineStartedAt) / 1000));
        const perMin = Math.round((words / sec) * 60);
        const dur =
          sec >= 60 ? `${Math.floor(sec / 60)}分${sec % 60}秒` : `${sec}秒`;
        return `⏱ 用时${dur} · 约${perMin}字/分`;
      };

      try {
        // 写前意图：须在 try 内，避免 AP 只跑完大纲就因未捕获异常整段停机
        // AP：无草稿则生成并自动确认；有草稿未确认则直接确认，绝不停手等人点
        // 单章：无草稿才生成，且不自动确认
        if (!isIntentConfirmed(workingChapter.intent)) {
          let nextIntent = workingChapter.intent;
          const ap = isAutoPilotingRef.current;
          const hasDraft = hasIntentDraft(workingChapter.intent);

          if (!hasDraft) {
            setStatusMessage(
              ap
                ? `第${workingChapter.number}章 · Auto-Pilot 补全写前大纲（完成后自动进分镜）...`
                : `第${workingChapter.number}章 · 补全写前大纲...`
            );
            const autoIntent = await generateChapterIntent({
              chapter: workingChapter,
              characters: activeChars.length ? activeChars : allCharacters,
              settings: activeSets.length ? activeSets : allSettings,
              previousContext,
              storyMemory: liveProject.memory,
              previousContextPack: contextPack,
              styleConfig: liveProject.styleConfig,
              onProgress: (msg) => {
                if (ap && /待确认/.test(msg)) {
                  setStatusMessage(
                    `第${workingChapter.number}章 · 写前大纲已生成，正在自动确认…`
                  );
                } else {
                  setStatusMessage(msg);
                }
              },
            });
            nextIntent = ap
              ? ensureAutoPilotIntent(autoIntent, workingChapter)
              : autoIntent;
          } else if (ap && hasDraft) {
            nextIntent = ensureAutoPilotIntent(
              workingChapter.intent ||
                buildFallbackChapterIntent(workingChapter, contextPack),
              workingChapter
            );
            setStatusMessage(
              `第${workingChapter.number}章 · 已自动确认既有写前大纲 · 进入分镜…`
            );
          }

          if (nextIntent) {
            workingChapter = { ...workingChapter, intent: nextIntent };
            memoryRetrieval = await retrieveMemoryForChapterAsync({
              chapter: workingChapter,
              memory: projectRef.current?.memory || liveProject.memory,
              characters: allCharacters,
              allChapters: projectRef.current?.chapters || allChapters,
              chapterNumber: workingChapter.number,
              projectId: (projectRef.current || liveProject).id,
            });
            storyMemoryBlock = formatStoryMemoryForPrompt(
              projectRef.current?.memory || liveProject.memory,
              allCharacters,
              {
                characterIds: liveChapter.involvedCharacterIds,
                retrievalPromptBlock: memoryRetrieval.promptBlock,
              }
            );
            patchChapterLocal(chapterId, {
              intent: nextIntent,
              memoryInjection: memoryRetrieval.snapshot,
            });
            await handleUpdateAndPersistProject((prev) => ({
              chapters: prev.chapters.map((c) =>
                c.id === chapterId
                  ? {
                      ...c,
                      intent: nextIntent,
                      memoryInjection: memoryRetrieval.snapshot,
                    }
                  : c
              ),
            }));
            if (ap) {
              setStatusMessage(
                `第${workingChapter.number}章 · 写前大纲已就绪 · 进入分镜拆解…`
              );
            }
          } else {
            patchChapterLocal(chapterId, { memoryInjection: memoryRetrieval.snapshot });
          }
        } else {
          patchChapterLocal(chapterId, { memoryInjection: memoryRetrieval.snapshot });
        }

        // AP 二次保险：确认态仍不达标则强制补全
        if (
          isAutoPilotingRef.current &&
          !isIntentConfirmed(workingChapter.intent)
        ) {
          const nextIntent = ensureAutoPilotIntent(
            workingChapter.intent ||
              buildFallbackChapterIntent(workingChapter, contextPack) ||
              emptyIntent(),
            workingChapter
          );
          workingChapter = { ...workingChapter, intent: nextIntent };
          patchChapterLocal(chapterId, { intent: nextIntent });
        }

        // 意图已确认但上面未重检索时，用当前 working 再检一次保证一致
        memoryRetrieval = await retrieveMemoryForChapterAsync({
          chapter: workingChapter,
          memory: projectRef.current?.memory || liveProject.memory,
          characters: allCharacters,
          allChapters: projectRef.current?.chapters || allChapters,
          chapterNumber: workingChapter.number,
          projectId: (projectRef.current || liveProject).id,
        });
        storyMemoryBlock = formatStoryMemoryForPrompt(
          projectRef.current?.memory || liveProject.memory,
          allCharacters,
          {
            characterIds: liveChapter.involvedCharacterIds,
            retrievalPromptBlock: memoryRetrieval.promptBlock,
          }
        );
        if (
          memoryRetrieval.debtThreads.length > 0 ||
          memoryRetrieval.relatedChapters.length > 0 ||
          memoryRetrieval.snapshot.semanticUsed
        ) {
          setStatusMessage(
            `第${workingChapter.number}章 · 记忆检索：${memoryRetrieval.snapshot.preview}`
          );
        }

        const chapterIntentBlock = formatIntentForPrompt(workingChapter.intent);
        const genrePack = resolveGenrePackForProject({
          genre: liveProject.genre || liveProject.config?.genre,
          genrePackId: liveProject.config?.customParameters?.genrePackId as
            | string
            | undefined,
          override: liveProject.config?.customParameters?.genrePackOverride,
        });
        const genrePackBlock = formatGenrePackForPrompt(genrePack);
        // 题材附加黑名单叠入本轮风格
        const styleWithGenre = {
          ...styleSnapshot,
          clicheBlacklist: mergeGenreBlacklist(
            styleSnapshot.clicheBlacklist || [],
            genrePack
          ),
        };

        // 出场角色为空时回退全书角色，避免分镜/正文「空人设」弱输出
        const beatsChars = activeChars.length ? activeChars : allCharacters;
        const beatsSets = activeSets.length ? activeSets : allSettings;

        let beats: PlotBeat[] = [];

        setStatusMessage(
          contextPack.isFirstChapter
            ? `第${workingChapter.number}章开篇 · 题材「${genrePack.name}」· 引擎管线启动…`
            : `第${workingChapter.number}章 · ${genrePack.name} · ${contextPack.preview} · 引擎管线启动…`
        );

        const prevChapterForEcho = (projectRef.current?.chapters || allChapters)
          .filter((c) => c.number < workingChapter.number)
          .sort((a, b) => b.number - a.number)[0];
        const previousProse = prevChapterForEcho?.content || '';

        const chapterWordTarget = resolveChapterWordTarget(liveProject.config);

        const engineResult: EngineChapterResult = await runEnginePipeline(
          {
            project: {
              ...liveProject,
              memory: projectRef.current?.memory || liveProject.memory,
            },
            chapter: workingChapter,
            characters: beatsChars,
            settings: beatsSets,
            styleConfig: styleWithGenre,
            previousContext,
            contextPack,
            storyMemoryBlock,
            chapterIntentBlock,
            genrePackBlock,
            previousProse,
            targetWordCount: chapterWordTarget,
            writeMode,
            maxReviseRounds: 2,
            signal: options?.signal,
          },
          {
            onProgress: ({ stage, message }: EngineProgress) => {
              if (stage === 'plan') setActiveStep(1);
              else if (stage === 'write') setActiveStep(2);
              else if (stage === 'audit' || stage === 'post_validate') setActiveStep(3);
              else if (stage === 'revise') setActiveStep(4);
              else if (stage === 'settle') setActiveStep(5);
              setStatusMessage(message);
            },
            onStreamProse: (text: string) => {
              streamBuffer = text;
              pendingStreamText = text;
              // 流式草稿去抖落盘：崩溃/刷新后可从 IndexedDB 恢复
              scheduleDraftBackup({
                projectId: liveProject.id,
                chapterId,
                chapterNumber: workingChapter.number,
                chapterTitle: workingChapter.title,
                content: text,
              });
              // 120ms 节流合并 UI 更新（首个 chunk 立即上屏）
              const now = Date.now();
              if (now - lastStreamUiAt >= 120) {
                flushStreamUi();
              } else if (!streamUiTimer) {
                streamUiTimer = setTimeout(() => {
                  streamUiTimer = null;
                  flushStreamUi();
                }, 120);
              }
            },
            onBeats: (b: PlotBeat[]) => {
              beats = b;
              patchChapterLocal(chapterId, {
                status: '正文草稿',
                locked: false,
                beats: b,
                content: '',
                wordCount: 0,
                lastModified: new Date().toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              });
            },
          }
        );

        if (!engineResult.ok && !engineResult.prose) {
          throw new Error(engineResult.errorMessage || '写作引擎失败');
        }

        beats = engineResult.beats.length ? engineResult.beats : beats;
        streamBuffer = engineResult.prose || streamBuffer;

        // —— 只写草稿：到正文为止 ——
        if (writeMode === 'draft_only' || engineResult.status === '正文草稿') {
          if (writeMode === 'draft_only') {
            const draftChapter: Chapter = {
              ...workingChapter,
              ...(projectRef.current?.chapters.find((c) => c.id === chapterId) || {}),
              content: streamBuffer,
              wordCount: proseWords(streamBuffer),
              status: '正文草稿',
              locked: false,
              lockedAt: undefined,
              beats,
              autoGenerated: true,
              contentUpdatedAt: new Date().toISOString(),
              lastModified: new Date().toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              }),
            };
            await handleUpdateAndPersistProject((prev) => {
              const newW = countContentWords(draftChapter.content, draftChapter.wordCount);
              const delta = newW - pipelineStartWords;
              return {
                chapters: prev.chapters.map((c) =>
                  c.id === chapterId ? draftChapter : c
                ),
                ...(delta !== 0
                  ? { dailyWordLog: accrueDailyWords(prev.dailyWordLog, delta) }
                  : {}),
              };
            });
            // 草稿已正式落盘，清除流式备份
            try {
              await clearDraftBackup(liveProject.id, chapterId);
            } catch {
              /* ignore */
            }
            try {
              const after = projectRef.current;
              if (after) {
                await createSnapshot(after, {
                  reason: isAutoPilotingRef.current ? 'auto_pilot_round' : 'post_write',
                  chapterId,
                  chapterNumber: workingChapter.number,
                  chapterTitle: workingChapter.title,
                });
                bumpSnapshotList();
              }
            } catch {
              /* ignore */
            }
            setStatusMessage(
              `📝 第${workingChapter.number}章草稿完成（引擎 draft_only）· ${draftChapter.wordCount} 字 · ${formatTiming(draftChapter.wordCount)}`
            );
            return {
              chapterId,
              chapterNumber: workingChapter.number,
              ok: true,
              ruleScanPassed: true,
              score: 0,
              status: '正文草稿',
            };
          }
        }

        let polishedProse = engineResult.prose;
        let auditLog = engineResult.auditLog!;
        let ruleScan = engineResult.ruleScan!;
        const recap = engineResult.recap!;
        const writeLog = engineResult.memoryWriteLog!;
        const updatedCharacters =
          engineResult.updatedCharacters || beatsChars;
        const greenOk = engineResult.greenOk;
        const scoreNow = engineResult.score;
        const scoreFail = !isVerificationScoreGreen(scoreNow);
        const chapterStatus = engineResult.status;
        const autoLocked = engineResult.locked;
        const lockedAt = engineResult.lockedAt;
        const recapQ = {
          blockGreen: !!auditLog.recapQualityBlocked,
          summary: auditLog.recapQualitySummary || '',
          ok: !auditLog.recapQualityBlocked,
          reasons: auditLog.recapQualitySummary
            ? [auditLog.recapQualitySummary]
            : ([] as string[]),
        };

        // 未绿通：把硬伤/账本/本地断言 error 写入待修，方便「修第一处」
        let chapterForTodos: Chapter = {
          ...liveChapter,
          ...(projectRef.current?.chapters.find((c) => c.id === chapterId) || {}),
        };
        // P1 防跨运行堆积：本轮审校运行标识；先清理同章旧运行残留的 open 自动条目
        // （旧运行的「字数不足」「综合分」「套话」等与当前正文无关，会误导人工与 AI 修复）。
        // 手工条目（无 autoRunId）、已完成条目、跨章抽检等无运行标识来源不受影响。
        const auditRunId = `audit-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 7)}`;
        {
          const pruned = pruneStaleAutoTodos(
            chapterForTodos.revisionTodos || [],
            auditRunId,
            { includeLegacyAuto: true }
          );
          if (pruned.pruned > 0) {
            chapterForTodos = {
              ...chapterForTodos,
              revisionTodos: pruned.todos,
            };
          }
        }
        let hardTodosAdded = 0;
        if (!greenOk && auditLog.hardReview?.issues?.length) {
          const applied = applyHardIssuesAsRevisionTodos(
            chapterForTodos,
            auditLog.hardReview.issues,
            { errorsOnly: true, max: 10, autoRunId: auditRunId }
          );
          chapterForTodos = applied.chapter;
          hardTodosAdded = applied.added;
        }
        const tasteTier = auditLog.aiTasteTier || 'clean';
        const ruleHits = auditLog.ruleScan?.hits || [];
        if (
          ruleHits.length > 0 &&
          (tasteTier === 'medium' ||
            tasteTier === 'heavy' ||
            ruleHits.some((h: { severity: string }) => h.severity === 'error'))
        ) {
          const tasteApplied = applyAiTasteHitsAsRevisionTodos(
            chapterForTodos,
            ruleHits,
            {
              tier: tasteTier,
              errorsOnly: tasteTier === 'light' || tasteTier === 'clean',
              max: 10,
              autoRunId: auditRunId,
            }
          );
          chapterForTodos = tasteApplied.chapter;
          hardTodosAdded += tasteApplied.added;
        }
        if (!greenOk && scoreFail) {
          const hardS = auditLog.hardReview?.score;
          const styleS = auditLog.styleReview?.score;
          const scoreTodoText =
            `[综合分] ${scoreNow}/${MIN_GREEN_VERIFICATION_SCORE} 未达标，不予通过 · 需重写本章` +
            (hardS != null || styleS != null
              ? `（硬伤${hardS ?? '—'} / 文笔${styleS ?? '—'}）`
              : '') +
            ` → 加强冲突与文笔质感后重跑闭环`;
          const existing = chapterForTodos.revisionTodos || [];
          const dup = existing.some(
            (t) =>
              t.status === 'open' &&
              (t.id.startsWith('score-') || t.text.includes('[综合分]'))
          );
          if (!dup) {
            chapterForTodos = {
              ...chapterForTodos,
              revisionTodos: [
                {
                  id: `score-${liveChapter.number}-${Date.now().toString(36)}`.slice(
                    0,
                    80
                  ),
                  text: scoreTodoText.slice(0, 280),
                  status: 'open' as const,
                  createdAt: new Date().toISOString(),
                  autoRunId: auditRunId,
                },
                ...existing,
              ].slice(0, 40),
            };
            hardTodosAdded += 1;
          }
        }

        // 引擎写后确定性违规 → 待修
        if (engineResult.postWriteViolations?.length) {
          const existing = chapterForTodos.revisionTodos || [];
          const extra = engineResult.postWriteViolations
            .filter((v: EngineViolation) => v.severity === 'error' || v.rule === '描写过细')
            .slice(0, 5)
            .map((v: EngineViolation, i: number) => ({
              id: `engine-${liveChapter.number}-${i}-${Date.now().toString(36)}`.slice(
                0,
                80
              ),
              text: `[引擎·${v.rule}] ${v.description} → ${v.suggestion}`.slice(0, 280),
              status: 'open' as const,
              createdAt: new Date().toISOString(),
              autoRunId: auditRunId,
            }))
            .filter(
              (t: { text: string }) =>
                !existing.some(
                  (e) => e.status === 'open' && e.text.slice(0, 40) === t.text.slice(0, 40)
                )
            );
          if (extra.length) {
            chapterForTodos = {
              ...chapterForTodos,
              revisionTodos: [...extra, ...existing].slice(0, 40),
            };
            hardTodosAdded += extra.length;
          }
        }

        // R7：章末回写前冲突检测（旧钉死事实 vs 新 keyFacts）——warn 不阻断，记入审校
        const memBeforeRecap = projectRef.current?.memory || liveProject.memory;
        const memoryConflicts = detectRecapConflicts(memBeforeRecap, recap);
        if (memoryConflicts.length) {
          setStatusMessage(
            `⚠️ 章末记忆回写：检测到 ${memoryConflicts.length} 处与旧钉死事实潜在矛盾（已列入审校记录，未阻断）`
          );
        }

        // R3-A：LLM 执笔失败降级为保守稿 → 提示用户（pipeline 已强制不自动锁）
        if (engineResult.conservative) {
          setStatusMessage(
            `⚠️ 第${workingChapter.number}章：LLM 执笔连续失败，已生成本地保守稿（未锁章）。请检查模型/网络配置后重跑正式稿。`
          );
        }

        const finalChapter: Chapter = {
          ...chapterForTodos,
          content: polishedProse,
          wordCount: proseWords(polishedProse),
          status: chapterStatus,
          locked: autoLocked,
          lockedAt,
          conservativeDraft: !!engineResult.conservative || undefined,
          beats,
          memoryAudit: {
            ...auditLog,
            // 审校版本锚：锚定「审的是哪版正文」——正文再被改动即判过期（isAuditStale）
            auditedContentAt: fingerprintProse(polishedProse),
            lastHardReviewAt: new Date().toISOString(),
            memoryInjectionSummary: memoryRetrieval.snapshot.preview,
            memoryDebtCount: memoryRetrieval.debtThreads.length,
            logicConflicts: [
              ...(auditLog.logicConflicts || []),
              ...memoryConflicts.map((c) => ({
                type: '吃书矛盾' as const,
                description: c.description,
                suggestion: c.suggestion,
              })),
            ],
          },
          memoryInjection: memoryRetrieval.snapshot,
          intent: workingChapter.intent,
          recap,
          memoryWriteLog: writeLog,
          autoFixCount: auditLog.fixRounds ?? engineResult.reviseRounds ?? 0,
          autoGenerated: true,
          contentUpdatedAt: new Date().toISOString(),
          lastModified: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }),
        };

        // 章末 recap → 书级记忆（Settler 已 merge 则复用）
        const memAfter = engineResult.memoryAfterRecap
          ? { memory: engineResult.memoryAfterRecap, addedFacts: 0, addedThreads: 0 }
          : mergeRecapIntoMemory(memBeforeRecap, recap, liveChapter.number);

        const pipelineApCfg = resolveAutoPilotConfig(
          projectRef.current?.styleConfig || liveProject.styleConfig
        );
        let factSnapshot = extractChapterFactSnapshot({
          chapter: liveChapter,
          prose: polishedProse,
          recap,
          characters: updatedCharacters,
        });
        if (pipelineApCfg.ledgerLlmEnrich) {
          setStatusMessage(`第${liveChapter.number}章 · 事实账本 LLM 补抽…`);
          factSnapshot = await enrichSnapshotWithLlm(factSnapshot, {
            chapter: liveChapter,
            prose: polishedProse,
            recap,
            onProgress: (msg: string) => setStatusMessage(msg),
          });
        }
        let memWithLedger = mergeSnapshotIntoMemory(memAfter.memory, factSnapshot);
        const entSync = syncLedgerEntitiesToMemory(memWithLedger);
        memWithLedger = entSync.memory;
        finalChapter.factSnapshot = factSnapshot;

        let charsAfterLedger = updatedCharacters;
        let deathSyncN = 0;
        if (pipelineApCfg.syncDeathToCharacters) {
          const synced = syncDeathsFromLedgerToCharacters(
            memWithLedger,
            updatedCharacters,
            { chapterNumber: liveChapter.number }
          );
          charsAfterLedger = synced.characters;
          deathSyncN = synced.updated;
        }

        const chaptersAfter = (
          projectRef.current?.chapters || liveProject.chapters
        ).map((c) => (c.id === chapterId ? finalChapter : c));
        const apAutoResolve =
          isAutoPilotingRef.current && pipelineApCfg.autoResolveHooks;
        const consolidatedMemory = consolidateMemoryAfterChapter(
          memWithLedger,
          chaptersAfter,
          {
            chapterNumber: liveChapter.number,
            volumes: projectRef.current?.volumes || liveProject.volumes,
            recap,
            characters: charsAfterLedger,
            autoAcceptHighConfidenceResolves: apAutoResolve,
          }
        );

        await handleUpdateAndPersistProject((prev) => {
          const newW = countContentWords(finalChapter.content, finalChapter.wordCount);
          const delta = newW - pipelineStartWords;
          return {
            chapters: prev.chapters.map((c) =>
              c.id === chapterId ? finalChapter : c
            ),
            characters: charsAfterLedger,
            memory: consolidatedMemory,
            ...(delta !== 0
              ? { dailyWordLog: accrueDailyWords(prev.dailyWordLog, delta) }
              : {}),
          };
        });
        // 终稿已落盘，清除流式备份
        try {
          await clearDraftBackup(liveProject.id, chapterId);
        } catch {
          /* ignore */
        }

        try {
          const after = projectRef.current;
          if (after) {
            const reason = autoLocked
              ? 'finalize'
              : isAutoPilotingRef.current
                ? 'auto_pilot_round'
                : 'post_write';
            await createSnapshot(after, {
              reason,
              chapterId: finalChapter.id,
              chapterNumber: finalChapter.number,
              chapterTitle: finalChapter.title,
              label: autoLocked
                ? `定稿 · 第${finalChapter.number}章《${finalChapter.title}》`
                : undefined,
            });
            bumpSnapshotList();
          }
        } catch (snapErr) {
          console.warn('章后快照失败:', snapErr);
        }

        // 章末自动备份到磁盘（去抖 15s：连写多章合并一次，失败静默下次重试）
        scheduleAutoBackup(() => projectRef.current);

        const score = auditLog.verificationScore ?? ruleScan.score;
        const digestN = consolidatedMemory.spanDigests?.length || 0;
        const megaN =
          consolidatedMemory.spanDigests?.filter((d) => d.kind === 'mega').length ||
          0;
        const resolveN = consolidatedMemory.pendingHookResolves?.length || 0;
        const ledgerN = consolidatedMemory.factLedger?.assertions?.filter(
          (a) => a.status === 'active'
        ).length;
        const snapN = factSnapshot.assertions.length;
        const deathHint = deathSyncN > 0 ? ` · 死卡同步${deathSyncN}` : '';
        const entHint =
          entSync.itemsUpdated || entSync.locationsUpdated
            ? ` · 实体物${entSync.itemsUpdated}/地${entSync.locationsUpdated}`
            : '';
        const dayHint =
          consolidatedMemory.factLedger?.storyDayCursor != null
            ? ` · 故事日${consolidatedMemory.factLedger.storyDayCursor}`
            : '';
        const enrichHint =
          factSnapshot.source === 'mixed' || factSnapshot.source === 'llm'
            ? ' · LLM账本'
            : '';
        const memHint =
          memAfter.addedFacts || memAfter.addedThreads || digestN || snapN
            ? ` · 记忆+${memAfter.addedFacts}事实/${memAfter.addedThreads}伏笔 · 账本${ledgerN || 0}(本章+${snapN})${enrichHint}${deathHint}${entHint}${dayHint} · 摘要${digestN}(巨${megaN})${
                resolveN ? ` · 回收建议${resolveN}` : ''
              }`
            : ' · 记忆已对齐';
        const hardLabel = auditLog.hardReview
          ? auditLog.hardReview.passed
            ? `硬伤${auditLog.hardReview.score}`
            : auditLog.hardReview.source === 'fallback'
              ? '硬伤API阻断'
              : `硬伤未过`
          : '硬伤未跑';
        const styleLabel = auditLog.styleReview
          ? `文笔${auditLog.styleReview.score}`
          : '';
        const tasteHint =
          auditLog.aiTasteTier && auditLog.aiTasteTier !== 'clean'
            ? ` · AI味${auditLog.aiTasteTier}${
                auditLog.aiTasteScore != null ? `(${auditLog.aiTasteScore})` : ''
              }`
            : '';
        const recapHint = recapQ.blockGreen
          ? ` · recap阻断(${recapQ.reasons[0] || recapQ.summary})`
          : '';
        const scoreHint = scoreFail
          ? ` · 综合${score}<${MIN_GREEN_VERIFICATION_SCORE}需重写`
          : '';
        const todoHint = hardTodosAdded > 0 ? ` · 待修+${hardTodosAdded}` : '';
        const modeHint =
          writeMode === 'until_review'
            ? ' · 待人工模式(不自动锁)'
            : autoLocked
              ? ' · 已锁定'
              : '';
        const engineHint = ` · 引擎${engineResult.reviseRounds || 0}轮修`;
        const finalWords = proseWords(polishedProse);
        const timingHint = formatTiming(finalWords);
        setStatusMessage(
          (
            greenOk && writeMode === 'until_green'
              ? `✅ 第${workingChapter.number}章完成 · ${hardLabel}/${styleLabel} · 综合${score}≥${MIN_GREEN_VERIFICATION_SCORE}${tasteHint}${modeHint}${engineHint}`
              : greenOk && writeMode === 'until_review'
                ? `📋 第${workingChapter.number}章审校通过 · ${hardLabel}/${styleLabel} · 综合${score}≥${MIN_GREEN_VERIFICATION_SCORE}${tasteHint}${modeHint}${engineHint}`
                : scoreFail
                  ? `⚠️ 第${workingChapter.number}章不予通过 · 综合${score}<${MIN_GREEN_VERIFICATION_SCORE}需重写 · ${hardLabel}/${styleLabel} · 机检:${ruleScan.summary}${tasteHint}${recapHint}${todoHint}${engineHint}`
                  : `⚠️ 第${workingChapter.number}章待人工 · ${hardLabel} · 机检:${ruleScan.summary} · ${score}${tasteHint}${recapHint}${scoreHint}${todoHint}${engineHint}`
          ) + `${memHint} · ${timingHint}`
        );

        return {
          chapterId,
          chapterNumber: workingChapter.number,
          ok: true,
          ruleScanPassed: greenOk,
          score,
          status: chapterStatus,
        };
      } catch (e: any) {
        console.error('单章流水线失败:', e);
        const partialContent =
          streamBuffer ||
          projectRef.current?.chapters.find((c) => c.id === chapterId)?.content ||
          '';
        patchChapterLocal(chapterId, {
          content: partialContent,
          wordCount: proseWords(partialContent),
          status: '正文草稿',
          locked: false,
          lastModified: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
        try {
          await handleUpdateAndPersistProject((prev) => ({
            chapters: prev.chapters.map((c) =>
              c.id === chapterId
                ? {
                    ...c,
                    content: partialContent,
                    wordCount: proseWords(partialContent),
                    status: '正文草稿' as const,
                    locked: false,
                    contentUpdatedAt: new Date().toISOString(),
                  }
                : c
            ),
          }));
        } catch (persistErr) {
          console.error('失败后落盘异常:', persistErr);
        }
        const msg = e?.message || '网络或API异常';
        setStatusMessage(`❌ 第${liveChapter.number}章中断（已尽量保留草稿）: ${msg}`);
        return {
          chapterId,
          chapterNumber: liveChapter.number,
          ok: false,
          ruleScanPassed: false,
          score: 0,
          status: '正文草稿',
          error: msg,
        };
      } finally {
        // 兜底：把未落盘的流式调度立即写入备份（成功路径已清，此处无副作用）
        void flushDraftBackup();
        setActiveStep(0);
      }
    },
    [
      projectRef,
      isAutoPilotingRef,
      styleConfig,
      setStatusMessage,
      setActiveChapterId,
      setActiveStep,
      patchChapterLocal,
      handleUpdateAndPersistProject,
      bumpSnapshotList,
    ]
  );

  return { runChapterPipeline };
}
