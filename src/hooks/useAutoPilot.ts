import { useCallback, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { BookProject, Chapter, StyleConfig } from '../types/novel';
import { crossTabLock } from '../services/crossTabLock';
import {
  resolveAutoPilotConfig,
  pickNextChapterToWrite,
  needsNewChapter,
  autoPilotStopLabel,
  autoPilotWriteModeLabel,
  type AutoPilotStopReason,
  type AutoPilotWriteMode,
  type ChapterPipelineResult,
} from '../services/autoPilot';
import { step0_AutoPlanNextChapter } from '../services/aiEngine';
import { setActiveAbortSignal } from '../services/llmClient';
import {
  runHeuristicCrossAudit,
} from '../services/crossChapterAudit';
import {
  applyCrossAuditToChapters,
  crossAuditFailed,
} from '../services/crossAuditActions';
import { evaluateCrossAuditRemind } from '../services/crossAuditRemind';

export interface UseAutoPilotDeps {
  /** 始终指向最新 project 的 ref */
  projectRef: MutableRefObject<BookProject | null>;
  /** 全局生成锁（三步 / AP 共用） */
  generatingLockRef: MutableRefObject<boolean>;
  /** Auto-Pilot 运行态（与 useChapterPipeline 共享） */
  isAutoPilotingRef: MutableRefObject<boolean>;
  /** 当前生成的 AbortController（三步 / AP 共用；App 持有） */
  generationAbortRef: MutableRefObject<AbortController | null>;
  /** 组件级 styleConfig 回退（渲染层派生） */
  styleConfig: StyleConfig;
  /** 单章管线（来自 useChapterPipeline） */
  runChapterPipeline: (
    chapterId: string,
    options?: {
      force?: boolean;
      writeMode?: AutoPilotWriteMode;
      signal?: AbortSignal;
    }
  ) => Promise<ChapterPipelineResult>;
  /** 落盘路径（来自 useProjectPersistence） */
  handleUpdateAndPersistProject: (
    updates: Partial<BookProject> | ((prev: BookProject) => Partial<BookProject>)
  ) => Promise<void>;
  setStatusMessage: Dispatch<SetStateAction<string>>;
  /** 生成中（UI state；三步 / AP 共用显示态） */
  isGenerating: boolean;
  /** Auto-Pilot 运行中（UI state） */
  isAutoPiloting: boolean;
  setIsGenerating: Dispatch<SetStateAction<boolean>>;
  setIsAutoPiloting: Dispatch<SetStateAction<boolean>>;
  setAutoPilotProgress: Dispatch<
    SetStateAction<{ done: number; target: number }>
  >;
  setActiveStep: (step: number) => void;
}

/**
 * Auto-Pilot 连写循环（R1 拆分第三步）。
 *
 * 从 App.tsx 原样搬移（零逻辑改动）：跨章锁 → 选章/建章 →
 * runChapterPipeline 逐章执行 → 停机条件（中止/机检失败/低分连击/
 * 周期抽检/完成）→ 收尾状态与跨章抽检提醒。
 *
 * autoPilotAbortRef 为 hook 私有（仅 stop/start 使用）；
 * isAutoPilotingRef 由 App 持有并共享给 useChapterPipeline；
 * generationAbortRef（App 持有）使「停止」即中断当前章的全部 LLM 调用，
 * 已流式产出部分由管线失败路径保留为草稿。
 */
export function useAutoPilot(deps: UseAutoPilotDeps) {
  const {
    projectRef,
    generatingLockRef,
    isAutoPilotingRef,
    generationAbortRef,
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
  } = deps;

  /** Auto-Pilot 用户中止 */
  const autoPilotAbortRef = useRef(false);

  /** Auto-Pilot 用户中止：置标志（停下一章）+ 中止当前 in-flight 生成 */
  const handleStopAutoPilot = useCallback(() => {
    autoPilotAbortRef.current = true;
    // 立即中断当前章的全部 LLM 调用（管线在阶段边界收尾，已产出部分保留为草稿）
    generationAbortRef.current?.abort();
    setStatusMessage('⏹ 正在停止 Auto-Pilot（中断当前章生成，草稿保留）...');
  }, [generationAbortRef, setStatusMessage]);

  const handleStartAutoPilot = useCallback(async () => {
    if (generatingLockRef.current || isGenerating || isAutoPiloting) return;
    const cfg = resolveAutoPilotConfig(styleConfig);
    const apProjectId = projectRef.current?.id ?? '';
    if (!crossTabLock.acquire(apProjectId, 'Auto-Pilot')) {
      setStatusMessage('⚠️ 其他标签页正在生成本书，Auto-Pilot 已阻止启动（跨标签锁）。');
      return;
    }
    autoPilotAbortRef.current = false;
    isAutoPilotingRef.current = true;
    generatingLockRef.current = true;
    // 循环级中止信号：覆盖管线内（逐章传入）与管线外调用（AP 补规划等）
    const abortController = new AbortController();
    generationAbortRef.current = abortController;
    setActiveAbortSignal(abortController.signal);
    setIsAutoPiloting(true);
    setIsGenerating(true);
    setAutoPilotProgress({ done: 0, target: cfg.targetChapters });

    let done = 0;
    let lowStreak = 0;
    let stopReason: AutoPilotStopReason | null = null;

    setStatusMessage(
      `🚀 Auto-Pilot 启动：目标 ${cfg.targetChapters} 章 · 模式=${autoPilotWriteModeLabel(cfg.writeMode)} · 失败停机=${cfg.stopOnFail ? '开' : '关'}`
    );

    try {
      while (done < cfg.targetChapters) {
        if (autoPilotAbortRef.current) {
          stopReason = 'user_abort';
          break;
        }

        const proj = projectRef.current;
        if (!proj) {
          stopReason = 'api_error';
          break;
        }

        let next = pickNextChapterToWrite(proj.chapters || []);

        if (!next) {
          const { needed, nextNumber } = needsNewChapter(proj.chapters || []);
          if (!needed || !cfg.createMissingChapters) {
            stopReason = done > 0 ? 'completed_target' : 'no_more_work';
            break;
          }

          setActiveStep(0);
          setStatusMessage(`Auto-Pilot · 规划第 ${nextNumber} 章大纲...`);
          const plan = await step0_AutoPlanNextChapter(
            nextNumber,
            proj.chapters || [],
            proj.characters || [],
            proj.settings || [],
            (msg) => setStatusMessage(msg),
            proj.title
          );

          const vol = (proj.volumes || [])[0];
          const newChapter: Chapter = {
            id: `chap-auto-${Date.now()}-${nextNumber}`,
            number: nextNumber,
            title: plan.title,
            summary: plan.summary,
            wordCount: 0,
            status: '大纲待拆',
            content: '',
            volumeId: vol?.id,
            volumeNumber: vol?.number || 1,
            involvedCharacterIds: plan.involvedCharacterIds,
            involvedSettingIds: plan.involvedSettingIds,
            beats: [],
            autoGenerated: true,
            lastModified: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          };

          await handleUpdateAndPersistProject((prev) => ({
            chapters: [...(prev.chapters || []), newChapter],
          }));
          next = newChapter;
        }

        setStatusMessage(
          `Auto-Pilot ${done + 1}/${cfg.targetChapters} · 执笔第 ${next.number} 章《${next.title}》...`
        );

        const result = await runChapterPipeline(next.id, {
          writeMode: cfg.writeMode,
          signal: abortController.signal,
        });

        if (abortController.signal.aborted && autoPilotAbortRef.current) {
          stopReason = 'user_abort';
          break;
        }

        if (!result.ok) {
          stopReason = 'api_error';
          // 保留真实错误，避免只显示「写前大纲」最后成功态被结束语盖掉
          setStatusMessage(
            `❌ Auto-Pilot 在第 ${result.chapterNumber || next.number} 章中断：${
              result.error || '未知错误（若卡在写前大纲后，多半是分镜/正文 API 失败）'
            }`
          );
          break;
        }

        done += 1;
        setAutoPilotProgress({ done, target: cfg.targetChapters });

        // 草稿模式不计机检失败；完整/待人工模式才停机
        if (
          cfg.writeMode !== 'draft_only' &&
          !result.ruleScanPassed &&
          cfg.stopOnFail
        ) {
          stopReason = 'rule_scan_fail';
          setStatusMessage(
            `⛔ Auto-Pilot 停机：第 ${result.chapterNumber} 章机检未过（模式=${autoPilotWriteModeLabel(
              cfg.writeMode
            )}，score=${result.score}）· 已完成 ${done}/${cfg.targetChapters}`
          );
          break;
        }

        if (cfg.writeMode !== 'draft_only' && result.score > 0 && result.score < cfg.minScore) {
          lowStreak += 1;
          if (lowStreak >= cfg.lowScoreStreakLimit) {
            stopReason = 'low_score_streak';
            break;
          }
        } else {
          lowStreak = 0;
        }

        // 周期跨章抽检（本地启发，快）：AI 长跑质检闸
        if (
          cfg.writeMode !== 'draft_only' &&
          cfg.crossAuditEvery > 0 &&
          done % cfg.crossAuditEvery === 0
        ) {
          const proj = projectRef.current;
          if (proj) {
            setStatusMessage(
              `Auto-Pilot 周期跨章抽检（每 ${cfg.crossAuditEvery} 章）· 本地启发…`
            );
            try {
              const report = runHeuristicCrossAudit(proj, { recentCount: 5 });
              const failed = crossAuditFailed(report, cfg.crossAuditMinScore);
              const applied = failed
                ? applyCrossAuditToChapters(proj, report, {
                    markPendingReview: true,
                  })
                : null;
              await handleUpdateAndPersistProject({
                lastCrossAudit: report,
                ...(applied ? { chapters: applied.chapters } : {}),
              });
              if (failed) {
                stopReason = 'cross_audit_fail';
                const errors = report.issues.filter((i) => i.severity === 'error').length;
                setStatusMessage(
                  `📡 周期抽检未过 · ${report.score}分 · error ${errors} · 已停机` +
                    (applied && applied.todosAdded
                      ? ` · 待修 +${applied.todosAdded}`
                      : '') +
                    (applied && applied.chaptersUnlocked
                      ? ` · 解锁 ${applied.chaptersUnlocked} 章`
                      : '') +
                    `（阈值 ${cfg.crossAuditMinScore}）`
                );
                break;
              }
              setStatusMessage(
                `📡 周期抽检通过 · ${report.score}分 · ${report.issues.length} 项 · 继续 AP`
              );
            } catch (auditErr) {
              console.warn('AP 周期抽检失败:', auditErr);
            }
          }
        }
      }

      if (!stopReason) {
        stopReason = done >= cfg.targetChapters ? 'completed_target' : 'no_more_work';
      }

      const remind = projectRef.current
        ? evaluateCrossAuditRemind(projectRef.current)
        : null;
      const remindSuffix =
        remind?.due ? ` · ⚠️ 建议跑跨章抽检：${remind.message}` : '';
      // api_error / rule_scan_fail 已在上面写过详细原因，此处只补收尾
      const stopLabel = autoPilotStopLabel(stopReason ?? 'no_more_work');
      if (stopReason !== 'api_error' && stopReason !== 'rule_scan_fail') {
        setStatusMessage(
          `🏁 Auto-Pilot 结束：完成 ${done}/${cfg.targetChapters} 章 · ${stopLabel}${remindSuffix}`
        );
      } else {
        setStatusMessage((prev) =>
          prev?.startsWith('❌') || prev?.startsWith('⛔')
            ? `${prev} · 共完成 ${done}/${cfg.targetChapters}${remindSuffix}`
            : `🏁 Auto-Pilot 结束：完成 ${done}/${cfg.targetChapters} 章 · ${stopLabel}${remindSuffix}`
        );
      }
    } catch (e: any) {
      console.error('Auto-Pilot 异常:', e);
      setStatusMessage(`❌ Auto-Pilot 异常停机: ${e.message || e}`);
    } finally {
      crossTabLock.release();
      autoPilotAbortRef.current = false;
      isAutoPilotingRef.current = false;
      generatingLockRef.current = false;
      setActiveAbortSignal(null);
      generationAbortRef.current = null;
      setIsAutoPiloting(false);
      setIsGenerating(false);
      setActiveStep(0);
    }
  }, [
    projectRef,
    generatingLockRef,
    isAutoPilotingRef,
    generationAbortRef,
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
  ]);

  return { handleStartAutoPilot, handleStopAutoPilot };
}
