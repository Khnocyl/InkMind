import React, { useState } from 'react';
import type {
  Chapter,
  Character,
  WorldSetting,
  StyleConfig,
  ProjectConfig,
  StoryMemory,
  ChapterIntent,
  CrossChapterAuditReport,
} from '../../types/novel';
import type { PreviousContextPack } from '../../services/contextPack';
import {
  autoPilotWriteModeLabel,
  resolveAutoPilotConfig,
  type AutoPilotWriteMode,
} from '../../services/autoPilot';
import {
  Cpu,
  ShieldCheck,
  Zap,
  CheckCircle,
  Sparkles,
  Sliders,
  Layers,
  RefreshCw,
  BookOpen,
  Rocket,
  Square,
  Lock,
  Unlock,
  ScanSearch,
  Wand2,
  Loader2,
  Download,
  Layers2,
} from 'lucide-react';
import { SnapshotPanel } from './SnapshotPanel';
import { PrewriteCheckPanel, shouldConfirmPrewrite } from './PrewriteCheckPanel';
import { ChapterIntentPanel } from './ChapterIntentPanel';
import { CrossChapterAuditPanel } from './CrossChapterAuditPanel';
import { WritingDashboard } from './WritingDashboard';
import { RevisionTodosPanel } from './RevisionTodosPanel';
import { isChapterLocked, lockReason } from '../../services/chapterLock';
import { isIntentConfirmed } from '../../services/chapterIntent';

interface AIWorkflowPanelProps {
  chapter: Chapter;
  characters: Character[];
  settings: WorldSetting[];
  styleConfig: StyleConfig;
  projectConfig?: ProjectConfig | null;
  storyMemory?: StoryMemory | null;
  /** 全书章节（仪表盘） */
  allChapters?: Chapter[];
  isGenerating: boolean;
  isAutoPiloting?: boolean;
  autoPilotProgress?: { done: number; target: number };
  activeStep: number;
  statusMessage: string;
  /** 写前组装的上章前情（摘要 + 尾段） */
  previousContextPack?: PreviousContextPack | null;
  onStartThreeStepWorkflow: () => void;
  onStartAutoPilot?: () => void;
  onStopAutoPilot?: () => void;
  onUpdateStyleConfig?: (config: StyleConfig) => void;
  onUpdateBeats: (beats: Chapter['beats']) => void;
  /** 全书快照 */
  projectId?: string;
  snapshotRefreshToken?: number;
  onManualSnapshot?: () => Promise<void> | void;
  onRestoreSnapshot?: (snapshotId: string) => Promise<void> | void;
  onLockChapter?: () => void;
  onUnlockChapter?: () => void;
  onGenerateChapterIntent?: () => Promise<void> | void;
  onSaveChapterIntent?: (intent: ChapterIntent) => void;
  crossAuditReport?: CrossChapterAuditReport | null;
  crossAuditBusy?: boolean;
  onRunCrossAudit?: (useLlm: boolean) => Promise<void> | void;
  crossAuditRemind?: import('../../services/crossAuditRemind').CrossAuditRemindStatus | null;
  onDismissCrossAuditRemind?: () => void;
  onJumpChapter?: (chapterId: string, todoId?: string) => void;
  /** 待修：解锁（若锁）并定位改稿 */
  onOpenForRewrite?: (chapterId: string, todoId?: string) => void;
  /** 抽检 issue 跳转相关章 */
  onJumpAuditIssue?: (
    issue: import('../../types/novel').CrossChapterIssue,
    preferredChapterNumber?: number
  ) => void;
  onFixFirstRevision?: () => void;
  /** AI 修指定待修 */
  onAiFixRevisionTodo?: (chapterId: string, todoId: string) => void | Promise<void>;
  onClearDoneRevisionTodos?: () => void;
  onMarkAllRevisionTodosDone?: () => void;
  onToggleRevisionTodo?: (chapterId: string, todoId: string) => void;
  /** AI 味/机检命中 → 正文定位 */
  onLocateInProse?: (snippet: string) => void;
  /** 只扫本章 AI 味（不写章） */
  onScanAiTasteChapter?: () => void | Promise<void>;
  /** 全书只扫 AI 味 */
  onScanAiTasteBook?: (writeTodos?: boolean) => void | Promise<void>;
  /** 对命中片段一键局部去AI味 */
  onDeslopHit?: (snippet: string) => void | Promise<void>;
  /** 批量去味本章前 N 处 error */
  onBatchDeslopChapter?: (maxHits?: number) => void | Promise<void>;
  /** 全书每章最多去味 maxPerChapter 处（费 token） */
  onBatchDeslopBook?: (maxPerChapter?: number) => void | Promise<void>;
  /** 导出全书 AI 味 CSV */
  onExportAiTasteCsv?: () => void;
  aiTasteScanBusy?: boolean;
  aiTasteScanMessage?: string | null;
  dailyWordLog?: Record<string, number> | null;
}

export const AIWorkflowPanel: React.FC<AIWorkflowPanelProps> = ({
  chapter,
  characters,
  settings,
  styleConfig,
  projectConfig,
  storyMemory,
  allChapters,
  isGenerating,
  isAutoPiloting = false,
  autoPilotProgress = { done: 0, target: 0 },
  activeStep,
  statusMessage,
  previousContextPack,
  onStartThreeStepWorkflow,
  onStartAutoPilot,
  onStopAutoPilot,
  onUpdateStyleConfig,
  onUpdateBeats: _onUpdateBeats,
  projectId,
  snapshotRefreshToken = 0,
  onManualSnapshot,
  onRestoreSnapshot,
  onLockChapter,
  onUnlockChapter,
  onGenerateChapterIntent,
  onSaveChapterIntent,
  crossAuditReport,
  crossAuditBusy,
  onRunCrossAudit,
  crossAuditRemind,
  onDismissCrossAuditRemind,
  onJumpChapter,
  onOpenForRewrite,
  onJumpAuditIssue,
  onFixFirstRevision,
  onAiFixRevisionTodo,
  onClearDoneRevisionTodos,
  onMarkAllRevisionTodosDone,
  onToggleRevisionTodo,
  onLocateInProse,
  onScanAiTasteChapter,
  onScanAiTasteBook,
  onDeslopHit,
  onBatchDeslopChapter,
  onBatchDeslopBook,
  onExportAiTasteCsv,
  aiTasteScanBusy = false,
  aiTasteScanMessage = null,
  dailyWordLog,
}) => {
  const [deslopN, setDeslopN] = useState(3);
  const activeChars = characters.filter((c) => chapter.involvedCharacterIds?.includes(c.id));
  const activeSettings = settings.filter((s) => chapter.involvedSettingIds?.includes(s.id));
  const pack = previousContextPack || null;
  const apCfg = resolveAutoPilotConfig(styleConfig);
  const locked = isChapterLocked(chapter);

  const guardAndStart = (kind: 'single' | 'autopilot') => {
    // Auto-Pilot 永不覆盖锁定章（由选章逻辑跳过）；此处仅提示
    if (kind === 'autopilot' && locked) {
      window.alert(
        `当前章已定稿锁定，Auto-Pilot 会自动跳过锁定章，只写未完成章节。\n\n${lockReason(chapter)}`
      );
    }
    // 单章：写前大纲未确认则强提示（仍可强行写）
    if (kind === 'single' && !isIntentConfirmed(chapter.intent)) {
      const ok = window.confirm(
        '写前大纲尚未确认（目标/禁止/钩子）。\n\n建议先「AI 生成大纲」并点「确认大纲」再开写。\n\n仍要强行开写吗？'
      );
      if (!ok) return;
    }
    const { needConfirm, message, report } = shouldConfirmPrewrite(
      chapter,
      characters,
      settings,
      styleConfig,
      pack,
      projectConfig,
      storyMemory
    );
    if (needConfirm) {
      const header =
        kind === 'autopilot'
          ? `【Auto-Pilot 写前体检 ${report.score}分】\n`
          : `【单章写前体检 ${report.score}分】\n`;
      if (!window.confirm(header + message)) return;
    }
    if (kind === 'single') onStartThreeStepWorkflow();
    else onStartAutoPilot?.();
  };

  return (
    <aside className="w-80 bg-white border-l border-neutral-200 flex flex-col h-[calc(100vh-61px)] shrink-0 overflow-y-auto text-black select-none">
      {/* 侧栏顶头 */}
      <div className="p-4 border-b border-slate-200 bg-white flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <div className="flex items-center space-x-2">
          <Cpu size={16} className="text-indigo-600" />
          <h2 className="font-bold text-xs text-slate-900 uppercase tracking-wider">防幻觉三步推理创作引擎</h2>
        </div>
        <span className="text-[10px] bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded-full font-mono font-bold">
          API 联网
        </span>
      </div>

      {/* 创作控制区 */}
      <div className="p-4 border-b border-slate-200 space-y-3 bg-white">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-slate-900 flex items-center space-x-1.5">
            <Zap size={14} className="text-amber-600" />
            <span>逐章推理与审校监控</span>
          </span>
          <div className="flex items-center gap-1 flex-wrap justify-end">
            {locked && (
              <span className="text-[10px] bg-emerald-100 border border-emerald-400 text-emerald-900 px-2 py-0.5 rounded-full font-bold flex items-center space-x-1">
                <Lock size={10} />
                <span>已锁定</span>
              </span>
            )}
            {chapter.status === '校验通过' && !chapter.memoryAudit?.ruleScanBlocked && (
              <span className="text-[10px] bg-emerald-50 border border-emerald-300 text-emerald-800 px-2 py-0.5 rounded-full font-bold flex items-center space-x-1">
                <CheckCircle size={10} className="text-emerald-600" />
                <span>自检达标</span>
              </span>
            )}
            {(chapter.status === '待人工确认' || chapter.memoryAudit?.ruleScanBlocked) && (
              <span className="text-[10px] bg-amber-50 border border-amber-300 text-amber-900 px-2 py-0.5 rounded-full font-bold">
                待人工确认
              </span>
            )}
          </div>
        </div>

        {/* 锁定控制 */}
        {(onLockChapter || onUnlockChapter) && (
          <div className="flex items-center gap-2">
            {locked ? (
              <button
                type="button"
                disabled={isGenerating}
                onClick={onUnlockChapter}
                className="flex-1 text-[11px] font-bold py-1.5 px-2 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50 flex items-center justify-center gap-1"
              >
                <Unlock size={12} />
                解锁重写
              </button>
            ) : (
              <button
                type="button"
                disabled={isGenerating || !(chapter.content || '').trim()}
                onClick={onLockChapter}
                className="flex-1 text-[11px] font-bold py-1.5 px-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 flex items-center justify-center gap-1"
                title="防止流水线与 Auto-Pilot 覆盖正文"
              >
                <Lock size={12} />
                定稿锁定
              </button>
            )}
          </div>
        )}

        {/* 进度指示条 */}
        <div>
          <div className="flex justify-between text-[11px] text-slate-600 mb-1">
            <span>推理执行进度:</span>
            <span className="font-mono font-bold text-indigo-600">
              {activeStep === 0
                ? '待触发引擎'
                : activeStep >= 5
                  ? '记忆回写 5/5'
                  : activeStep === 4
                    ? '修复环 4/5'
                    : `第 ${activeStep}/5 阶段`}
            </span>
          </div>
          <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden border border-slate-300">
            <div
              className="bg-indigo-600 h-full transition-all duration-500"
              style={{ width: `${(Math.min(activeStep, 5) / 5) * 100}%` }}
            />
          </div>
          <p className="text-[11px] text-slate-600 mt-1.5 leading-relaxed">
            {activeStep === 1 && '💡 正在拆分细粒度分镜（已注入上章前情）...'}
            {activeStep === 2 && '✍️ 正在流式生成正文（Show Don\'t Tell + 黑名单约束）...'}
            {activeStep === 3 && '🛡️ 主编审校 + 规则机检...'}
            {activeStep === 4 && '🔧 冲突修复环：按清单改写并重跑机检（最多 2 轮）...'}
            {activeStep === 5 && '🧠 章末状态 patch 回写角色卡...'}
            {activeStep === 0 && '准备就绪：分镜 → 正文 → 审校 → 修复 → 记忆回写。'}
          </p>
        </div>

        {isGenerating ? (
          <div className="p-3.5 bg-indigo-50 border border-indigo-200 rounded-xl text-xs space-y-2.5 shadow-sm">
            <div className="flex items-center justify-between font-bold text-indigo-900">
              <div className="flex items-center space-x-2">
                <RefreshCw size={14} className="animate-spin text-indigo-600" />
                <span>
                  {isAutoPiloting
                    ? `Auto-Pilot ${autoPilotProgress.done}/${autoPilotProgress.target}`
                    : `推理中 [阶段 ${Math.min(activeStep, 5)}/5]`}
                </span>
              </div>
              {isAutoPiloting && onStopAutoPilot && (
                <button
                  type="button"
                  onClick={onStopAutoPilot}
                  className="flex items-center space-x-1 text-[10px] px-2 py-1 rounded-lg bg-black border border-black text-white hover:bg-neutral-800"
                >
                  <Square size={10} />
                  <span>停止</span>
                </button>
              )}
            </div>
            {isAutoPiloting && autoPilotProgress.target > 0 && (
              <div className="w-full bg-indigo-100 h-1.5 rounded-full overflow-hidden">
                <div
                  className="bg-indigo-600 h-full transition-all duration-500"
                  style={{
                    width: `${Math.min(100, (autoPilotProgress.done / autoPilotProgress.target) * 100)}%`,
                  }}
                />
              </div>
            )}
            <div className="text-[11px] text-slate-800 font-mono leading-relaxed bg-white p-2.5 rounded-lg border border-slate-200 shadow-inner">
              {statusMessage || '正在连通服务端后端接口进行推理...'}
            </div>
          </div>
        ) : (
          <div className="pt-1 space-y-2">
            <button
              type="button"
              onClick={() => guardAndStart('single')}
              className="w-full py-3 px-4 text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-2 shadow-md transform hover:-translate-y-0.5 bg-black hover:bg-neutral-800"
            >
              <Sparkles size={15} />
              <span>{locked ? '⚠️ 强制重写本章（需确认解锁）' : '✨ 启动本章闭环（单章）'}</span>
            </button>

            {/* Auto-Pilot */}
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-slate-800 flex items-center space-x-1">
                  <Rocket size={12} className="text-rose-600" />
                  <span>Auto-Pilot 连载</span>
                </span>
                <span className="text-[10px] text-slate-500 font-mono">
                  目标 {apCfg.targetChapters} 章
                </span>
              </div>
              {onUpdateStyleConfig && (
                <>
                  <label className="flex items-center justify-between text-[10px] text-slate-600">
                    <span>本轮连写章数</span>
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={styleConfig.autoPilotTargetChapters ?? 3}
                      onChange={(e) =>
                        onUpdateStyleConfig({
                          ...styleConfig,
                          autoPilotTargetChapters: Math.max(
                            1,
                            Math.min(30, Number(e.target.value) || 1)
                          ),
                        })
                      }
                      className="w-14 px-1.5 py-0.5 border border-slate-300 rounded text-right font-mono"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[10px] text-slate-600">
                    <span>写作深度</span>
                    <select
                      value={styleConfig.autoPilotWriteMode || 'until_green'}
                      onChange={(e) =>
                        onUpdateStyleConfig({
                          ...styleConfig,
                          autoPilotWriteMode: e.target.value as AutoPilotWriteMode,
                        })
                      }
                      className="w-full px-2 py-1 border border-slate-300 rounded-lg bg-white text-[11px] font-medium text-slate-800"
                    >
                      <option value="until_green">
                        {autoPilotWriteModeLabel('until_green')}
                      </option>
                      <option value="draft_only">
                        {autoPilotWriteModeLabel('draft_only')}
                      </option>
                      <option value="until_review">
                        {autoPilotWriteModeLabel('until_review')}
                      </option>
                    </select>
                  </label>
                </>
              )}
              <p className="text-[10px] text-slate-500 leading-relaxed">
                当前：{autoPilotWriteModeLabel(apCfg.writeMode)}。规划缺章 →
                写作 → 按模式停机（失败/低分/手动）。启动前会体检。
              </p>
              <button
                type="button"
                onClick={() => guardAndStart('autopilot')}
                disabled={!onStartAutoPilot}
                className="w-full py-2.5 px-3 bg-black hover:bg-neutral-800 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center justify-center space-x-2 shadow-sm"
              >
                <Rocket size={14} />
                <span>🚀 启动 Auto-Pilot</span>
              </button>
            </div>

            <p className="text-[10px] text-slate-500 text-center">
              写前体检 → 快照 → 闭环写作 · 终态落盘
            </p>
          </div>
        )}
      </div>

      {/* 写前大纲确认 */}
      {onGenerateChapterIntent && onSaveChapterIntent && (
        <ChapterIntentPanel
          chapter={chapter}
          busy={isGenerating || isAutoPiloting}
          onGenerate={onGenerateChapterIntent}
          onSaveIntent={onSaveChapterIntent}
        />
      )}

      {onRunCrossAudit && (
        <CrossChapterAuditPanel
          report={crossAuditReport}
          busy={!!crossAuditBusy || isGenerating || isAutoPiloting}
          onRun={onRunCrossAudit}
          remind={crossAuditRemind}
          onDismissRemind={onDismissCrossAuditRemind}
          onJumpIssue={onJumpAuditIssue}
          onFixFirst={onFixFirstRevision}
        />
      )}

      {allChapters &&
        allChapters.length > 0 &&
        onJumpChapter &&
        onToggleRevisionTodo && (
          <RevisionTodosPanel
            chapters={allChapters}
            activeChapterId={chapter.id}
            onJumpChapter={onJumpChapter}
            onOpenForRewrite={onOpenForRewrite}
            onFixFirst={onFixFirstRevision}
            onAiFixTodo={
              onAiFixRevisionTodo
                ? (cid, tid) => void onAiFixRevisionTodo(cid, tid)
                : undefined
            }
            onClearDone={onClearDoneRevisionTodos}
            onMarkAllDone={onMarkAllRevisionTodosDone}
            onToggleTodo={onToggleRevisionTodo}
            busy={isGenerating || isAutoPiloting || aiTasteScanBusy}
          />
        )}

      {allChapters && allChapters.length > 0 && (
        <WritingDashboard
          chapters={allChapters}
          projectConfig={projectConfig}
          styleConfig={styleConfig}
          activeChapterId={chapter.id}
          crossAuditRemind={crossAuditRemind}
          onRunCrossAudit={onRunCrossAudit ? () => onRunCrossAudit(true) : undefined}
          dailyWordLog={dailyWordLog}
        />
      )}

      {/* 写前上下文体检（含前情/角色/设定/文风） */}
      <PrewriteCheckPanel
        chapter={chapter}
        characters={characters}
        settings={settings}
        styleConfig={styleConfig}
        previousContextPack={pack}
        projectConfig={projectConfig}
        storyMemory={storyMemory}
      />

      {/* 角色状态回写 */}
      <div className="p-4 border-b border-slate-200 space-y-2.5 bg-white">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-slate-900 flex items-center space-x-1.5">
            <Layers size={14} className="text-rose-600" />
            <span>角色状态回写 (Step5)</span>
          </span>
          <span
            className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${
              chapter.memoryWriteLog && chapter.memoryWriteLog.appliedCount > 0
                ? 'bg-rose-50 text-rose-800 border-rose-200'
                : 'bg-slate-50 text-slate-600 border-slate-200'
            }`}
          >
            {chapter.memoryWriteLog
              ? chapter.memoryWriteLog.appliedCount > 0
                ? `已回写 ${chapter.memoryWriteLog.appliedCount}`
                : '无变更'
              : '未执行'}
          </span>
        </div>
        {chapter.memoryWriteLog ? (
          <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1.5">
            <div className="text-[10px] text-slate-500">
              来源：{chapter.memoryWriteLog.source === 'llm' ? '模型抽取' : '启发式'} ·{' '}
              {chapter.memoryWriteLog.generatedAt
                ? new Date(chapter.memoryWriteLog.generatedAt).toLocaleString()
                : ''}
            </div>
            {(chapter.memoryWriteLog.patches || []).length === 0 ? (
              <div className="text-[11px] text-slate-500">本章角色卡无字段变化。</div>
            ) : (
              <ul className="space-y-1.5 max-h-36 overflow-y-auto">
                {chapter.memoryWriteLog.patches.map((p) => (
                  <li key={p.characterId} className="p-2 bg-white border border-slate-200 rounded-lg">
                    <div className="font-semibold text-slate-800 text-[11px]">{p.characterName}</div>
                    <div className="text-[10px] text-rose-800 mt-0.5">
                      {p.changedFields.join(' · ')}
                    </div>
                    {p.reason && (
                      <div className="text-[10px] text-slate-500 mt-0.5">{p.reason}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[10px] text-slate-500 leading-relaxed">
              状态/地点/境界会写入世界圣经角色卡，下一章切片自动带上。
            </p>
          </div>
        ) : (
          <div className="text-[11px] text-slate-500 italic p-2 bg-slate-50 rounded border border-slate-200">
            跑完创作闭环后，系统会根据正文回写角色 status / 地点 / 境界。
          </div>
        )}
      </div>

      {/* 本章已存 recap */}
      <div className="p-4 border-b border-slate-200 space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-slate-900 flex items-center space-x-1.5">
            <BookOpen size={14} className="text-indigo-600" />
            <span>本章章末 Recap</span>
          </span>
          <span
            className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${
              chapter.recap
                ? chapter.recap.source === 'fallback'
                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                  : 'bg-indigo-50 text-indigo-800 border-indigo-200'
                : 'bg-slate-50 text-slate-600 border-slate-200'
            }`}
          >
            {chapter.recap
              ? chapter.recap.source === 'fallback'
                ? '启发式'
                : '已沉淀'
              : '未生成'}
          </span>
        </div>
        {chapter.recap ? (
          <div className="p-2.5 bg-white border border-slate-200 rounded-lg text-xs space-y-2 shadow-sm">
            <p className="text-[11px] text-slate-800 leading-relaxed whitespace-pre-wrap">
              {chapter.recap.text}
            </p>
            {chapter.recap.endingState && (
              <div className="text-[10px] text-slate-600 bg-slate-50 border border-slate-100 rounded p-2">
                <span className="font-semibold text-slate-700">章末现场：</span>
                {chapter.recap.endingState}
              </div>
            )}
            {chapter.recap.keyFacts?.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold text-slate-600 mb-1">
                  已钉死事实 ({chapter.recap.keyFacts.length})
                </div>
                <ul className="space-y-1 max-h-28 overflow-y-auto">
                  {chapter.recap.keyFacts.map((f, i) => (
                    <li key={i} className="text-[10px] text-slate-700 flex gap-1.5">
                      <span className="text-indigo-500 font-bold shrink-0">{i + 1}.</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {chapter.recap.openThreads?.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold text-amber-700 mb-1">
                  未收伏笔 ({chapter.recap.openThreads.length})
                </div>
                <ul className="space-y-1">
                  {chapter.recap.openThreads.map((t, i) => (
                    <li key={i} className="text-[10px] text-slate-700">· {t}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="text-[11px] text-slate-500 italic p-2 bg-white rounded border border-slate-200">
            跑完三步推理定稿后，系统会自动生成并保存 recap，供下一章写前注入。
          </div>
        )}
      </div>

      {/* 设定与角色切片（状态切片，非向量 RAG） */}
      <div className="p-4 border-b border-slate-200 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-slate-900 flex items-center space-x-1.5">
            <Layers size={14} className="text-blue-600" />
            <span>设定/角色状态切片 ({activeChars.length + activeSettings.length})</span>
          </span>
          <span className="text-[10px] text-slate-600 bg-white px-2 py-0.5 rounded border border-slate-300">
            防遗忘
          </span>
        </div>

        <div className="space-y-2.5">
          <div>
            <div className="text-[11px] font-semibold text-slate-600 mb-1">活跃人物状态追踪 ({activeChars.length})</div>
            <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
              {activeChars.map((char) => (
                <div key={char.id} className="p-2.5 bg-white border border-slate-200 rounded-lg text-xs shadow-sm">
                  <div className="flex items-center justify-between font-bold text-slate-900">
                    <span className="truncate pr-1">{char.name} ({char.alias || '核心人物'})</span>
                    <span className="text-[10px] font-normal px-1.5 py-0.5 bg-indigo-50 border border-indigo-200 rounded text-indigo-700 flex-shrink-0">
                      {char.realmOrTitle || '修行者'}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-600 mt-1 line-clamp-1">
                    当前状态: <strong className="text-slate-800">{char.status || '活跃'}</strong>
                  </div>
                </div>
              ))}
              {activeChars.length === 0 && (
                <div className="text-[11px] text-slate-500 italic p-2 bg-white rounded border border-slate-200 shadow-sm">
                  本章暂无关联角色记忆，可在大纲梗概中提及即可自动捕捉。
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-semibold text-slate-600 mb-1">世界红线铁律约束 ({activeSettings.length})</div>
            <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
              {activeSettings.map((set) => (
                <div key={set.id} className="p-2.5 bg-white border border-slate-200 rounded-lg text-xs shadow-sm">
                  <div className="font-bold text-amber-800 text-xs mb-1">{set.name}</div>
                  {(set.hardRules || []).slice(0, 2).map((rule, idx) => (
                    <div key={idx} className="text-[10px] text-slate-700 flex items-start space-x-1.5 mt-0.5">
                      <span className="text-amber-600 font-bold">！</span>
                      <span className="line-clamp-2">{rule}</span>
                    </div>
                  ))}
                </div>
              ))}
              {activeSettings.length === 0 && (
                <div className="text-[11px] text-slate-500 italic p-2 bg-white rounded border border-slate-200 shadow-sm">
                  本章未特别关联红线，将应用通用物理法则。
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 分镜头细纲列表 */}
      <div className="p-4 border-b border-slate-200 space-y-2.5 bg-white">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-slate-900 flex items-center space-x-1.5">
            <Sliders size={14} className="text-purple-600" />
            <span>分镜细纲要点 (Beats)</span>
          </span>
          <span className="text-[10px] text-purple-700 bg-purple-50 border border-purple-200 px-2 py-0.5 rounded">
            杜绝水字数
          </span>
        </div>

        <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
          {(chapter.beats || []).map((beat) => (
            <div key={beat.id} className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs shadow-sm">
              <div className="flex items-center justify-between font-bold text-slate-900 mb-1">
                <span className="text-purple-700">镜头 #{beat.order}</span>
                {beat.focusSense && (
                  <span className="text-[10px] font-normal text-slate-600 bg-white px-1.5 py-0.5 rounded border border-slate-200">
                    {beat.focusSense}
                  </span>
                )}
              </div>
              <p className="text-slate-800 text-[11px] leading-relaxed">{beat.description}</p>
            </div>
          ))}
          {(chapter.beats || []).length === 0 && (
            <div className="text-center py-5 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg">
              尚未拆分分镜，点击上方推理按钮一键推导。
            </div>
          )}
        </div>
      </div>

      {/* 去味与逻辑自检报告 */}
      <div className="p-4 bg-slate-50 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-slate-900 flex items-center space-x-1.5">
            <ShieldCheck size={15} className="text-emerald-600" />
            <span>自检报告与去味审计</span>
          </span>
          {chapter.memoryAudit && (
            <span
              className={`text-xs font-bold font-mono px-2 py-0.5 rounded border ${
                chapter.memoryAudit.hardBlocked ||
                chapter.memoryAudit.ruleScanBlocked ||
                (chapter.memoryAudit.verificationScore ?? 0) < 75
                  ? 'text-rose-900 bg-rose-50 border-rose-300'
                  : 'text-emerald-800 bg-emerald-50 border-emerald-300'
              }`}
              title={
                (chapter.memoryAudit.verificationScore ?? 0) < 75
                  ? '综合分低于 75：不予通过，需重写'
                  : '综合分 ≥ 75 且硬伤/机检通过方可绿通'
              }
            >
              综合 {chapter.memoryAudit.verificationScore}/100
              {(chapter.memoryAudit.verificationScore ?? 0) < 75
                ? ' · <75需重写'
                : ''}
            </span>
          )}
        </div>

        {/* 只扫 AI 味（不写章） */}
        {(onScanAiTasteChapter || onScanAiTasteBook) && (
          <div className="p-2.5 bg-white border border-violet-200 rounded-lg space-y-1.5 shadow-sm">
            <div className="text-[11px] font-bold text-violet-950 flex items-center gap-1">
              <ScanSearch size={13} className="text-violet-600" />
              AI 味只扫（不改正文）
            </div>
            <div className="flex flex-wrap gap-1.5">
              {onScanAiTasteChapter && (
                <button
                  type="button"
                  disabled={aiTasteScanBusy || isGenerating || isAutoPiloting}
                  onClick={() => void onScanAiTasteChapter()}
                  className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-md border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
                >
                  {aiTasteScanBusy ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <ScanSearch size={11} />
                  )}
                  扫本章
                </button>
              )}
              {onScanAiTasteBook && (
                <>
                  <button
                    type="button"
                    disabled={aiTasteScanBusy || isGenerating || isAutoPiloting}
                    onClick={() => void onScanAiTasteBook(false)}
                    className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-md border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
                  >
                    扫全书
                  </button>
                  <button
                    type="button"
                    disabled={aiTasteScanBusy || isGenerating || isAutoPiloting}
                    onClick={() => void onScanAiTasteBook(true)}
                    className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-md border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
                    title="扫全书并把 medium/heavy 写入待修"
                  >
                    扫全书+待修
                  </button>
                </>
              )}
              {(onBatchDeslopChapter || onBatchDeslopBook) && (
                <label className="inline-flex items-center gap-1 text-[10px] text-slate-600 font-semibold">
                  N=
                  <select
                    value={deslopN}
                    disabled={aiTasteScanBusy}
                    onChange={(e) =>
                      setDeslopN(
                        Math.max(1, Math.min(8, Number(e.target.value) || 3))
                      )
                    }
                    className="text-[10px] border border-slate-200 rounded px-1 py-0.5 bg-white"
                    title="本章批量去味处数；全书模式每章最多 min(N,3)"
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {onBatchDeslopChapter && (
                <button
                  type="button"
                  disabled={
                    aiTasteScanBusy || isGenerating || isAutoPiloting || locked
                  }
                  onClick={() => void onBatchDeslopChapter(deslopN)}
                  className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-md border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
                  title={`对本章前 ${deslopN} 处 error 依次局部去AI味（费 token）`}
                >
                  <Layers2 size={11} />
                  本章去味×{deslopN}
                </button>
              )}
              {onBatchDeslopBook && (
                <button
                  type="button"
                  disabled={aiTasteScanBusy || isGenerating || isAutoPiloting}
                  onClick={() =>
                    void onBatchDeslopBook(Math.min(3, deslopN))
                  }
                  className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-md border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
                  title="medium/heavy 章每章最多去味 min(N,3) 处，全书上限约 20 章"
                >
                  <Wand2 size={11} />
                  全书去味
                </button>
              )}
              {onExportAiTasteCsv && (
                <button
                  type="button"
                  disabled={aiTasteScanBusy}
                  onClick={onExportAiTasteCsv}
                  className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  title="导出各章 AI 味机检为 CSV（建议先扫全书）"
                >
                  <Download size={11} />
                  导出CSV
                </button>
              )}
            </div>
            {aiTasteScanMessage && (
              <p className="text-[10px] text-violet-800 leading-relaxed">{aiTasteScanMessage}</p>
            )}
          </div>
        )}

        {chapter.memoryAudit ? (
          <div className="space-y-2.5 text-xs">
            {chapter.memoryAudit.previousContextSource && (
              <div className="p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm">
                <div className="text-[11px] font-bold text-slate-900 mb-1 flex items-center justify-between">
                  <span>写前前情注入记录</span>
                  <span className="text-[10px] text-teal-700 font-semibold">
                    {chapter.memoryAudit.injectedPreviousContext ? '已注入' : '开篇章'}
                  </span>
                </div>
                <div className="text-[11px] text-slate-600 leading-relaxed">
                  {chapter.memoryAudit.previousContextSource}
                </div>
              </div>
            )}

            {/* 双阶段：硬伤审 */}
            {chapter.memoryAudit.hardReview && (
              <div className="p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm space-y-1.5">
                <div className="text-[11px] font-bold text-slate-900 flex items-center justify-between">
                  <span>阶段 A · 硬伤审</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${
                      chapter.memoryAudit.hardReview.passed
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                        : 'bg-red-50 border-red-200 text-red-800'
                    }`}
                  >
                    {chapter.memoryAudit.hardReview.passed ? '通过' : '阻断'} ·{' '}
                    {chapter.memoryAudit.hardReview.score}分
                  </span>
                </div>
                <p className="text-[11px] text-slate-700 leading-relaxed">
                  {chapter.memoryAudit.hardReview.summary}
                </p>
                {(chapter.memoryAudit.hardReview.issues || []).length > 0 && (
                  <ul className="max-h-28 overflow-y-auto space-y-1">
                    {chapter.memoryAudit.hardReview.issues.map((iss, i) => (
                      <li
                        key={i}
                        className={`text-[10px] p-1.5 rounded border leading-relaxed ${
                          iss.severity === 'error'
                            ? 'bg-red-50/80 border-red-100 text-red-950'
                            : 'bg-amber-50/60 border-amber-100 text-amber-950'
                        }`}
                      >
                        <span className="font-semibold">
                          [{iss.severity === 'error' ? '硬伤' : '可疑'}·{iss.type}]
                        </span>{' '}
                        {iss.description}
                        {iss.suggestion && (
                          <div className="text-slate-500 mt-0.5">→ {iss.suggestion}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* 双阶段：文笔审 */}
            {chapter.memoryAudit.styleReview && (
              <div className="p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm space-y-1.5">
                <div className="text-[11px] font-bold text-slate-900 flex items-center justify-between">
                  <span>阶段 B · 文笔审</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded border font-semibold bg-violet-50 border-violet-200 text-violet-800">
                    {chapter.memoryAudit.styleReview.score}分
                    {chapter.memoryAudit.styleReview.polishedApplied ? ' · 已润色' : ''}
                  </span>
                </div>
                <p className="text-[11px] text-slate-700 leading-relaxed">
                  {chapter.memoryAudit.styleReview.summary}
                </p>
                {(chapter.memoryAudit.styleReview.suggestions || []).length > 0 && (
                  <ul className="space-y-1">
                    {chapter.memoryAudit.styleReview.suggestions.map((s, i) => (
                      <li
                        key={i}
                        className="text-[10px] p-1.5 rounded border bg-violet-50/50 border-violet-100 text-slate-700"
                      >
                        建议 {i + 1}. {s}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-[10px] text-slate-500">
                  文笔建议不单独阻断定稿；黑名单/升华机检仍可阻断。划线精修可局部处理。
                </p>
              </div>
            )}

            {/* 冲突修复环记录 + Diff */}
            {(chapter.memoryAudit.fixRounds !== undefined ||
              (chapter.memoryAudit.fixHistory && chapter.memoryAudit.fixHistory.length > 0)) && (
              <div className="p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm">
                <div className="text-[11px] font-bold text-slate-900 mb-1.5 flex items-center justify-between">
                  <span>冲突修复环 · Diff (Step4)</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${
                      chapter.memoryAudit.fixResolved
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                        : (chapter.memoryAudit.fixRounds ?? 0) > 0
                          ? 'bg-amber-50 border-amber-300 text-amber-900'
                          : 'bg-slate-50 border-slate-200 text-slate-600'
                    }`}
                  >
                    {(chapter.memoryAudit.fixRounds ?? 0) === 0
                      ? '未触发'
                      : chapter.memoryAudit.fixResolved
                        ? `${chapter.memoryAudit.fixRounds} 轮·已解决`
                        : `${chapter.memoryAudit.fixRounds} 轮·未解决`}
                  </span>
                </div>
                {(chapter.memoryAudit.fixHistory || []).length === 0 ? (
                  <div className="text-[11px] text-slate-500">机检一次通过，无需修复。</div>
                ) : (
                  <ul className="space-y-2 max-h-56 overflow-y-auto">
                    {(chapter.memoryAudit.fixHistory || []).map((h) => (
                      <li
                        key={h.round}
                        className="text-[10px] p-2 rounded border border-slate-100 bg-slate-50 text-slate-700 space-y-1"
                      >
                        <div className="flex items-center justify-between gap-1 flex-wrap">
                          <span className="font-semibold">
                            第 {h.round} 轮 · 冲突 {h.conflictCount}
                            {h.localPatchesApplied
                              ? ` · 局部补丁 ${h.localPatchesApplied}`
                              : ''}
                          </span>
                          <span
                            className={
                              h.ruleScanPassedAfter ? 'text-emerald-700' : 'text-amber-800'
                            }
                          >
                            {h.ruleScanPassedAfter ? '机检通过' : '仍未过'}
                            {typeof h.charDelta === 'number' && h.charDelta !== 0
                              ? ` · ${h.charDelta > 0 ? '+' : ''}${h.charDelta}字`
                              : ''}
                          </span>
                        </div>
                        {h.summary ? (
                          <div className="text-slate-600 leading-relaxed">{h.summary}</div>
                        ) : null}
                        {h.diffSummary && (
                          <div className="text-slate-500 font-mono">{h.diffSummary}</div>
                        )}
                        {(h.changesSummary || []).length > 0 && (
                          <ul className="list-disc pl-3 space-y-0.5 text-slate-600">
                            {h.changesSummary!.slice(0, 4).map((c, i) => (
                              <li key={i}>{c}</li>
                            ))}
                          </ul>
                        )}
                        {(h.diffHunks || []).length > 0 && (
                          <div className="space-y-1 pt-0.5">
                            {h.diffHunks!.slice(0, 6).map((dh, i) => (
                              <div
                                key={i}
                                className="rounded border border-slate-200 bg-white overflow-hidden"
                              >
                                <div className="px-1.5 py-0.5 text-[9px] font-bold text-slate-500 bg-slate-100">
                                  {dh.kind === 'replace'
                                    ? '替换'
                                    : dh.kind === 'remove'
                                      ? '删除'
                                      : '新增'}
                                </div>
                                {dh.before && (
                                  <div className="px-1.5 py-1 text-red-800/90 bg-red-50/80 leading-relaxed line-clamp-3">
                                    − {dh.before}
                                  </div>
                                )}
                                {dh.after && (
                                  <div className="px-1.5 py-1 text-emerald-900/90 bg-emerald-50/80 leading-relaxed line-clamp-3">
                                    + {dh.after}
                                  </div>
                                )}
                              </div>
                            ))}
                            {(h.diffHunks?.length || 0) > 6 && (
                              <div className="text-[9px] text-slate-400">
                                另有 {(h.diffHunks?.length || 0) - 6} 处未展开
                              </div>
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* 规则机检（可复现，不靠模型自评） */}
            <div
              className={`p-2.5 border rounded-lg shadow-sm ${
                chapter.memoryAudit.ruleScan?.passed === false
                  ? 'bg-amber-50 border-amber-300'
                  : 'bg-white border-slate-200'
              }`}
            >
              <div className="text-[11px] font-bold text-slate-900 mb-1.5 flex items-center justify-between">
                <span>规则机检 RuleScan</span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${
                    chapter.memoryAudit.ruleScan?.passed === false
                      ? 'bg-amber-100 border-amber-300 text-amber-900'
                      : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  }`}
                >
                  {chapter.memoryAudit.ruleScan
                    ? chapter.memoryAudit.ruleScan.passed
                      ? '通过'
                      : '未通过·禁绿通'
                    : '未记录'}
                </span>
              </div>
              {chapter.memoryAudit.ruleScan ? (
                <div className="space-y-1.5">
                  <div className="text-[11px] text-slate-700">{chapter.memoryAudit.ruleScan.summary}</div>
                  <div className="flex flex-wrap gap-1 text-[10px]">
                    <span className="px-1.5 py-0.5 rounded border bg-white border-slate-200">
                      黑名单 {chapter.memoryAudit.ruleScan.blacklistHits}
                    </span>
                    <span className="px-1.5 py-0.5 rounded border bg-white border-slate-200">
                      升华 {chapter.memoryAudit.ruleScan.sublimationHits}
                    </span>
                    <span className="px-1.5 py-0.5 rounded border bg-white border-slate-200">
                      情绪标签 {chapter.memoryAudit.ruleScan.tellHits}
                    </span>
                    <span className="px-1.5 py-0.5 rounded border bg-white border-slate-200">
                      结构 {chapter.memoryAudit.ruleScan.patternHits ?? 0}
                    </span>
                    <span className="px-1.5 py-0.5 rounded border bg-white border-slate-200 font-mono">
                      机检分 {chapter.memoryAudit.ruleScan.score}
                    </span>
                    {chapter.memoryAudit.aiTasteTier && (
                      <span
                        className={`px-1.5 py-0.5 rounded border font-bold ${
                          chapter.memoryAudit.aiTasteTier === 'heavy'
                            ? 'bg-red-50 border-red-200 text-red-900'
                            : chapter.memoryAudit.aiTasteTier === 'medium'
                              ? 'bg-amber-50 border-amber-200 text-amber-900'
                              : chapter.memoryAudit.aiTasteTier === 'light'
                                ? 'bg-sky-50 border-sky-200 text-sky-900'
                                : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                        }`}
                      >
                        AI味 {chapter.memoryAudit.aiTasteTier}
                        {chapter.memoryAudit.aiTasteScore != null
                          ? ` · ${chapter.memoryAudit.aiTasteScore}`
                          : ''}
                      </span>
                    )}
                  </div>
                  {chapter.memoryAudit.aiTasteSummary &&
                    chapter.memoryAudit.aiTasteTier !== 'clean' && (
                      <p className="text-[10px] text-slate-600">
                        {chapter.memoryAudit.aiTasteSummary}
                      </p>
                    )}
                  {chapter.memoryAudit.ruleScan.hits.length > 0 && (
                    <ul className="max-h-40 overflow-y-auto space-y-1 mt-1">
                      {chapter.memoryAudit.ruleScan.hits.map((h, i) => {
                        const locateKey = h.sample || h.phrase.replace(/^\[[A-Z]\]/, '');
                        const canLocate =
                          !!onLocateInProse &&
                          !!(h.sample || (h.phrase && !h.phrase.startsWith('[D]')));
                        return (
                          <li
                            key={i}
                            className={`text-[10px] leading-relaxed p-1.5 rounded border ${
                              h.severity === 'error'
                                ? 'bg-white border-amber-200 text-amber-950'
                                : 'bg-slate-50 border-slate-200 text-slate-700'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-1">
                              <div className="min-w-0">
                                <span className="font-semibold">
                                  [{h.severity === 'error' ? '阻断' : '提示'}·{h.kind}]
                                </span>{' '}
                                {h.phrase}
                                {h.count > 1 ? ` ×${h.count}` : ''}
                                {h.sample && (
                                  <div className="text-slate-600 mt-0.5 font-mono truncate">
                                    「{h.sample.slice(0, 36)}」
                                  </div>
                                )}
                                <div className="text-slate-500 mt-0.5">{h.suggestion}</div>
                              </div>
                              <div className="flex flex-col gap-0.5 shrink-0">
                                {canLocate && (
                                  <button
                                    type="button"
                                    onClick={() => onLocateInProse?.(locateKey)}
                                    className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-black bg-black text-white hover:bg-neutral-800"
                                    title="在正文中定位"
                                  >
                                    定位
                                  </button>
                                )}
                                {onDeslopHit &&
                                  (h.sample || h.kind === 'blacklist') &&
                                  !aiTasteScanBusy && (
                                    <button
                                      type="button"
                                      disabled={isGenerating || isAutoPiloting || locked}
                                      onClick={() =>
                                        void onDeslopHit(h.sample || locateKey)
                                      }
                                      className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50 inline-flex items-center gap-0.5"
                                      title="对该片段局部去AI味并复扫"
                                    >
                                      <Wand2 size={9} />
                                      去味
                                    </button>
                                  )}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-slate-500">旧章节无 ruleScan 记录，重新跑三步流程可生成。</div>
              )}
            </div>

            <div className="p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm">
              <div className="text-[11px] font-bold text-slate-900 mb-1.5 flex items-center justify-between">
                <span>套话 / 模式命中列表</span>
                <span className="bg-purple-50 text-purple-700 border border-purple-200 px-1.5 py-0.5 rounded text-[10px]">
                  {chapter.memoryAudit.removedClichesCount} 处
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(chapter.memoryAudit.removedClichésList || []).length === 0 && (
                  <span className="text-[10px] text-slate-500">无命中</span>
                )}
                {(chapter.memoryAudit.removedClichésList || []).map((item, i) => (
                  <span key={i} className="text-[10px] bg-slate-100 text-slate-700 border border-slate-200 px-1.5 py-0.5 rounded font-mono">
                    <s>{item}</s>
                  </span>
                ))}
              </div>
            </div>

            <div className="p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm">
              <div className="text-[11px] font-bold text-slate-900 mb-1 flex items-center justify-between">
                <span>硬伤冲突列表</span>
                <span
                  className={`text-[10px] font-semibold flex items-center space-x-1 ${
                    (chapter.memoryAudit.logicConflicts || []).some(
                      (c) =>
                        c.lane === 'hard' ||
                        (!c.lane &&
                          !c.description.startsWith('[规则机检') &&
                          !c.description.startsWith('[文笔建议]'))
                    )
                      ? 'text-red-700'
                      : 'text-emerald-600'
                  }`}
                >
                  <CheckCircle size={11} />
                  <span>
                    {(chapter.memoryAudit.logicConflicts || []).filter(
                      (c) => c.lane === 'hard' || (!c.lane && !c.description.startsWith('['))
                    ).length > 0
                      ? '有硬伤线索'
                      : '无硬伤'}
                  </span>
                </span>
              </div>
              <div className="text-[11px] text-slate-600 leading-relaxed mt-1">
                绿通 = 硬伤通过 + 规则机检通过。文笔建议不阻断。
              </div>
            </div>

            <div className="p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm">
              <div className="text-[11px] font-bold text-slate-900 mb-1 flex items-center justify-between">
                <span>截断结尾升华与多余说教</span>
                <span className="text-[10px] bg-indigo-50 text-indigo-700 border border-indigo-200 px-1.5 py-0.5 rounded font-mono">
                  {styleConfig.forbidEndingSublimation ? '机检生效' : '未开启'}
                </span>
              </div>
              <div className="text-[11px] text-slate-600 leading-relaxed mt-1">
                {styleConfig.forbidEndingSublimation
                  ? `章末升华命中 ${chapter.memoryAudit.ruleScan?.sublimationHits ?? chapter.memoryAudit.removedSublimationsCount ?? 0} 处（规则扫描，非模型自评）。`
                  : '当前允许自由总结，建议前往引擎设置开启以加强沉浸感。'}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-center py-6 text-xs text-slate-500 bg-white border border-slate-200 rounded-lg shadow-sm">
            暂无自检数据，三步推理生成后系统会自动输出规则机检与审校报告。
          </div>
        )}
      </div>

      {projectId && onManualSnapshot && onRestoreSnapshot && (
        <SnapshotPanel
          projectId={projectId}
          refreshToken={snapshotRefreshToken}
          busy={isGenerating || isAutoPiloting}
          onManualSnapshot={onManualSnapshot}
          onRestore={onRestoreSnapshot}
        />
      )}
    </aside>
  );
};
