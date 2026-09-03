import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { BookProject } from '../types/novel';
import type { GapReport } from '../services/gapScanner';
import { scanChapterGaps, scanProjectGaps } from '../services/gapScanner';
import { isChapterLocked } from '../services/chapterLock';
import { crossTabLock } from '../services/crossTabLock';
import { generateChapterIntent } from '../services/chapterIntent';
import { buildPreviousContextPack } from '../services/contextPack';
import { setActiveAbortSignal } from '../services/llmClient';
import {
  autoPilotWriteModeLabel,
  type AutoPilotWriteMode,
  type ChapterPipelineResult,
} from '../services/autoPilot';

export type GapFillStage =
  | 'idle'
  | 'intent'
  | 'pipeline'
  | 'done'
  | 'fail'
  | 'aborted'
  | 'finished';

/** 批量补跑进度（UI 渲染用） */
export interface GapFillProgress {
  /** 本次批次待补章总数 */
  total: number;
  /** 已成功补齐章数 */
  done: number;
  /** 已失败章数 */
  failed: number;
  /** 当前处理序号（1 起） */
  current: number;
  /** 当前章号（无则 0） */
  chapterNumber: number;
  stage: GapFillStage;
  message: string;
}

export interface GapFillFailure {
  chapterNumber: number;
  title: string;
  reason: string;
}

export interface GapFillSummary {
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  aborted: boolean;
  failures: GapFillFailure[];
  /** 非致命告警（如意图生成降级为启发式兜底） */
  warnings: GapFillFailure[];
}

export const IDLE_GAP_FILL_PROGRESS: GapFillProgress = {
  total: 0,
  done: 0,
  failed: 0,
  current: 0,
  chapterNumber: 0,
  stage: 'idle',
  message: '',
};

export interface UseGapFillerDeps {
  /** 始终指向最新 project 的 ref（长异步工作流防闭包脏写） */
  projectRef: MutableRefObject<BookProject | null>;
  /** 全局生成锁（三步 / AP / 补跑 共用） */
  generatingLockRef: MutableRefObject<boolean>;
  /** 当前生成的 AbortController（三步 / AP 共用；App 持有） */
  generationAbortRef: MutableRefObject<AbortController | null>;
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
  isAutoPiloting: boolean;
  setIsGenerating: Dispatch<SetStateAction<boolean>>;
  setActiveStep: (step: number) => void;
}

/**
 * 全书缺口批量补跑（增量编排层，不改现有管线行为）。
 *
 * 编排纪律与 useAutoPilot 一致：
 * - 跨标签锁 + generatingLockRef + isGenerating 全链路互斥；
 * - 串行逐章，每章内按依赖顺序：缺意图先补意图（generateChapterIntent，
 *   带 previousContextPack/storyMemory 随管线同款上下文装配），
 *   再跑现有单章管线（runChapterPipeline）补分镜/正文；
 * - 尊重全局 abort：fillerAbortRef（批间停机）+ 批次 AbortController
 *   （写入 generationAbortRef，贯通管线与全部 LLM 调用）；切书/卸载中止；
 * - 补跑每章成功即经 handleUpdateAndPersistProject 落盘再进下一章；
 * - 单章失败不终止批次，记录原因继续；结束时汇总 N 成功 / M 失败。
 * - 执行时以最新 projectRef 快检缺口：已锁 / 已补齐的章一律跳过，绝不覆盖。
 */
export function useGapFiller(deps: UseGapFillerDeps) {
  const {
    projectRef,
    generatingLockRef,
    generationAbortRef,
    runChapterPipeline,
    handleUpdateAndPersistProject,
    setStatusMessage,
    isGenerating,
    isAutoPiloting,
    setIsGenerating,
    setActiveStep,
  } = deps;

  /** 批量补跑用户中止（批间停机；in-flight 由 generationAbortRef 中断） */
  const fillerAbortRef = useRef(false);
  /** 运行态 ref（stop 回调防闭包滞后） */
  const fillingRef = useRef(false);

  const [report, setReport] = useState<GapReport | null>(null);
  const [filling, setFilling] = useState(false);
  const [progress, setProgress] = useState<GapFillProgress>(IDLE_GAP_FILL_PROGRESS);
  const [summary, setSummary] = useState<GapFillSummary | null>(null);

  /** 切书 / 卸载：中止批量补跑（生成中本就拦截切书，此为兜底） */
  const projectId = projectRef.current?.id;
  useEffect(() => {
    return () => {
      fillerAbortRef.current = true;
      generationAbortRef.current?.abort();
    };
    // generationAbortRef 为 ref（引用恒定）；projectId 变化 = 切书
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generationAbortRef, projectId]);

  /** 扫描全书缺口（纯函数，同步） */
  const handleScanGaps = useCallback(() => {
    const proj = projectRef.current;
    if (!proj) return;
    if (generatingLockRef.current) {
      setStatusMessage('⚠️ 生成进行中，请稍后再扫描缺口。');
      return;
    }
    const r = scanProjectGaps(proj);
    setReport(r);
    setSummary(null);
    setStatusMessage(
      r.chapterGaps.length === 0
        ? `✅ 全书缺口扫描完成：${r.totalChapters} 章均无缺口`
        : `🔍 全书缺口扫描完成：缺口 ${r.chapterGaps.length} 章 · 锁${r.lockedChapters} · 干净${r.cleanChapters}`
    );
  }, [projectRef, generatingLockRef, setStatusMessage]);

  /** 停止批量补跑：标志置位（停下一章）+ 中断当前 in-flight 生成 */
  const handleStopFilling = useCallback(() => {
    if (!fillingRef.current) return;
    fillerAbortRef.current = true;
    generationAbortRef.current?.abort();
    setStatusMessage('⏹ 正在停止批量补跑（中断当前章生成，已补齐成果保留）...');
  }, [generationAbortRef, setStatusMessage]);

  /** 批量补跑：串行逐章，缺意图先补意图，再跑单章管线补分镜/正文 */
  const handleStartFilling = useCallback(
    async (chapterIds: string[], writeMode: AutoPilotWriteMode) => {
      if (generatingLockRef.current || isGenerating || isAutoPiloting) return;
      const proj = projectRef.current;
      if (!proj) return;
      if (!chapterIds.length) {
        setStatusMessage('⚠️ 未勾选任何章节，请先勾选要补跑的章节。');
        return;
      }
      if (!crossTabLock.acquire(proj.id, '批量补跑')) {
        setStatusMessage('⚠️ 其他标签页正在生成本书，已阻止批量补跑启动（跨标签锁）。');
        return;
      }

      fillerAbortRef.current = false;
      fillingRef.current = true;
      generatingLockRef.current = true;
      const abortController = new AbortController();
      generationAbortRef.current = abortController;
      setActiveAbortSignal(abortController.signal);
      setFilling(true);
      setIsGenerating(true);
      setActiveStep(0);

      // 以最新项目状态过滤勾选章：已锁 / 已无缺口（用户或他处已补）自动排除
      const selectedSet = new Set(chapterIds);
      const workList = (projectRef.current?.chapters || [])
        .filter((c) => selectedSet.has(c.id))
        .map((c) => ({ chapter: c, kinds: scanChapterGaps(c).kinds }))
        .filter((w) => w.kinds.length > 0)
        .sort((a, b) => a.chapter.number - b.chapter.number);

      const total = workList.length;
      let done = 0;
      let failed = 0;
      let skipped = 0;
      const failures: GapFillFailure[] = [];
      const warnings: GapFillFailure[] = [];

      const bump = (patch: Partial<GapFillProgress>) =>
        setProgress((prev) => ({ ...prev, ...patch }));

      try {
        if (total === 0) {
          setSummary({
            total: 0,
            ok: 0,
            failed: 0,
            skipped: 0,
            aborted: false,
            failures,
            warnings,
          });
          setStatusMessage('✅ 所选章节均已无缺口（可能已在上次补跑补齐），无需处理。');
        } else {
          bump({
            total,
            done: 0,
            failed: 0,
            current: 0,
            chapterNumber: 0,
            stage: 'idle',
            message: `批量补跑启动：共 ${total} 章 · 模式=${autoPilotWriteModeLabel(writeMode)}`,
          });
          setStatusMessage(
            `🚀 批量补跑启动：全书缺口 ${total} 章 · 模式=${autoPilotWriteModeLabel(writeMode)}`
          );

          for (let i = 0; i < workList.length; i++) {
            if (fillerAbortRef.current || abortController.signal.aborted) break;

            const entry = workList[i];
            const chapterId = entry.chapter.id;

            // 执行时再次快检最新 projectRef：锁定 / 已无缺口 → 跳过，绝不覆盖
            const live = projectRef.current?.chapters.find((c) => c.id === chapterId);
            if (!live) continue;
            if (isChapterLocked(live)) {
              skipped += 1;
              continue;
            }
            const liveKinds = scanChapterGaps(live).kinds;
            if (liveKinds.length === 0) {
              skipped += 1;
              continue;
            }

            const needsIntent =
              liveKinds.includes('intent_missing') || liveKinds.includes('intent_fallback');
            const needsProse =
              liveKinds.includes('beats_missing') || liveKinds.includes('prose_missing');
            const chapterNumber = live.number;
            const title = live.title;

            bump({
              current: i + 1,
              chapterNumber,
              stage: 'idle',
              message: `第 ${chapterNumber} 章《${title}》…`,
            });

            try {
              // ── 1. 缺意图先补意图（随管线同款上下文装配）──
              if (needsIntent) {
                bump({
                  stage: 'intent',
                  message: `第 ${chapterNumber} 章 · 补生成写前意图…`,
                });
                const proj2 = projectRef.current;
                if (!proj2) throw new Error('项目已关闭或切换');
                const pack = buildPreviousContextPack(proj2.chapters, live, {
                  storyMemory: proj2.memory,
                  queryTerms: [live.title, live.summary || '', ...(live.intent?.mustDo || [])],
                });
                const activeChars = (proj2.characters || []).filter((c) =>
                  live.involvedCharacterIds?.includes(c.id)
                );
                const activeSets = (proj2.settings || []).filter((s) =>
                  live.involvedSettingIds?.includes(s.id)
                );
                const intent = await generateChapterIntent({
                  chapter: live,
                  characters: activeChars.length ? activeChars : proj2.characters || [],
                  settings: activeSets.length ? activeSets : proj2.settings || [],
                  previousContext: pack.text,
                  storyMemory: proj2.memory,
                  previousContextPack: pack,
                  styleConfig: proj2.styleConfig,
                  onProgress: (msg) => setStatusMessage(msg),
                });
                // 中止时不落盘半途兜底货
                if (abortController.signal.aborted) break;
                await handleUpdateAndPersistProject((prev) => ({
                  chapters: prev.chapters.map((c) =>
                    c.id === chapterId
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
                if (intent.source === 'fallback') {
                  warnings.push({
                    chapterNumber,
                    title,
                    reason: '写前意图生成降级为启发式兜底（API 异常），建议后续重跑补一次',
                  });
                }
              }

              // ── 2. beats / 正文缺口：走现有单章管线（分镜→正文→审校→记忆）──
              if (needsProse) {
                bump({
                  stage: 'pipeline',
                  message: `第 ${chapterNumber} 章 · 单章管线补跑（分镜→正文→审校→记忆）…`,
                });
                setActiveStep(1);
                const result = await runChapterPipeline(chapterId, {
                  writeMode,
                  signal: abortController.signal,
                });
                if (abortController.signal.aborted) break;
                if (!result.ok) {
                  throw new Error(result.error || '单章管线执行失败');
                }
              }

              done += 1;
              bump({
                done,
                stage: 'done',
                message: `✅ 第 ${chapterNumber} 章《${title}》已补齐`,
              });
              setStatusMessage(
                `✅ 批量补跑 ${done}/${total} · 第 ${chapterNumber} 章《${title}》已补齐`
              );
            } catch (e: any) {
              if (abortController.signal.aborted) break;
              failed += 1;
              const reason = (e?.message || String(e)).slice(0, 200);
              failures.push({ chapterNumber, title, reason });
              bump({
                failed,
                stage: 'fail',
                message: `❌ 第 ${chapterNumber} 章失败：${reason}`,
              });
              setStatusMessage(
                `❌ 批量补跑 · 第 ${chapterNumber} 章《${title}》失败：${reason}（已跳过，继续下一章）`
              );
            }
          }
        }

        const aborted = fillerAbortRef.current || abortController.signal.aborted;
        setSummary({
          total,
          ok: done,
          failed,
          skipped,
          aborted,
          failures,
          warnings,
        });
        bump({
          current: Math.min(done + failed + skipped + (aborted ? 1 : 0), Math.max(total, 1)),
          chapterNumber: 0,
          stage: aborted ? 'aborted' : 'finished',
          message: aborted
            ? `⏹ 已停止 · 成功 ${done} · 失败 ${failed} · 跳过 ${skipped}`
            : `🏁 补跑完成 · 成功 ${done} · 失败 ${failed} · 跳过 ${skipped}`,
        });
        setStatusMessage(
          aborted
            ? `⏹ 批量补跑已停止：成功 ${done}/${total} · 失败 ${failed} · 跳过 ${skipped}`
            : `🏁 批量补跑完成：成功 ${done}/${total} · 失败 ${failed} · 跳过 ${skipped}${
                failures.length ? ` · ${failures.length} 章失败详见面板` : ''
              }`
        );
      } catch (e: any) {
        console.error('批量补跑异常:', e);
        setSummary({
          total,
          ok: done,
          failed,
          skipped,
          aborted: true,
          failures,
          warnings,
        });
        setStatusMessage(`❌ 批量补跑异常停机: ${e.message || e}`);
      } finally {
        crossTabLock.release();
        generatingLockRef.current = false;
        fillerAbortRef.current = false;
        fillingRef.current = false;
        setFilling(false);
        setIsGenerating(false);
        setActiveAbortSignal(null);
        generationAbortRef.current = null;
        setActiveStep(0);
      }
    },
    [
      projectRef,
      generatingLockRef,
      generationAbortRef,
      isGenerating,
      isAutoPiloting,
      runChapterPipeline,
      handleUpdateAndPersistProject,
      setStatusMessage,
      setIsGenerating,
      setActiveStep,
    ]
  );

  return {
    report,
    filling,
    progress,
    summary,
    handleScanGaps,
    handleStartFilling,
    handleStopFilling,
  };
}
