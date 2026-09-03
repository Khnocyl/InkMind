import type {
  Chapter,
  Character,
  WorldSetting,
  Volume,
  StoryMemory,
  ChapterIntent,
  CrossChapterIssue,
  StyleConfig,
  ProjectConfig,
  CrossChapterAuditReport,
} from '../../types/novel';
import type { PreviousContextPack } from '../../services/contextPack';
import type { CrossAuditRemindStatus } from '../../services/crossAuditRemind';
import type { GapReport } from '../../services/gapScanner';
import type { GapFillProgress, GapFillSummary } from '../../hooks/useGapFiller';
import type { AutoPilotWriteMode } from '../../services/autoPilot';
import { ChapterSidebar } from './ChapterSidebar';
import { WritingCanvas } from './WritingCanvas';
import { AIWorkflowPanel } from './AIWorkflowPanel';

export interface WorkspaceTabProps {
  chapters: Chapter[];
  volumes: Volume[];
  activeChapterId: string;
  activeChapter: Chapter | undefined;
  characters: Character[];
  settings: WorldSetting[];
  styleConfig: StyleConfig;
  storyMemory: StoryMemory | null;
  projectConfig?: ProjectConfig | null;
  isGenerating: boolean;
  isAutoPiloting: boolean;
  autoPilotProgress: { done: number; target: number };
  activeStep: number;
  statusMessage: string;
  previousContextPack: PreviousContextPack | null;
  projectId: string;
  snapshotRefreshToken: number;
  dailyWordLog: Record<string, number> | null;
  crossAuditReport: CrossChapterAuditReport | null;
  crossAuditBusy: boolean;
  crossAuditRemind: CrossAuditRemindStatus | null;
  aiTasteScanBusy: boolean;
  aiTasteScanMessage: string | null;
  focusTodoId: string | null;
  focusSnippet: string | null;
  onSelectChapter: (id: string) => void;
  onAddChapter: (volumeId?: string, volumeNumber?: number) => void;
  onDeleteChapter: (id: string) => void;
  onClearAllChapters: () => void;
  onClearAllChapterBodies: () => void;
  onUpdateChapter: (ch: Chapter) => void;
  onLockChapter: () => void;
  onUnlockChapter: () => void;
  onFocusTodoConsumed: () => void;
  onFocusSnippetConsumed: () => void;
  onStartThreeStepWorkflow: () => void;
  onStartAutoPilot: () => void;
  onStopAutoPilot: () => void;
  /** 停止单章生成（AP 模式由 onStopAutoPilot 处理） */
  onStopGeneration?: () => void;
  onUpdateStyleConfig: (
    updated: StyleConfig | ((prev: StyleConfig) => StyleConfig)
  ) => void;
  onUpdateBeats: (beats: Chapter['beats']) => void;
  onManualSnapshot: () => void;
  onRestoreSnapshot: (snapshotId: string) => void;
  onGenerateChapterIntent: (chapterId?: string) => void;
  onSaveChapterIntent: (intent: ChapterIntent) => void;
  onRunCrossAudit: (useLlm: boolean) => void;
  onDismissCrossAuditRemind: () => void;
  onJumpChapter: (chapterId: string, todoId?: string) => void;
  onOpenForRewrite: (chapterId: string, todoId?: string) => void;
  onJumpAuditIssue: (
    issue: CrossChapterIssue,
    preferredChapterNumber?: number
  ) => void;
  onLocateInProse: (snippet: string) => void;
  onScanAiTasteChapter: () => void;
  onScanAiTasteBook: (writeTodos?: boolean) => void;
  onDeslopHit: (snippet: string) => void;
  onBatchDeslopChapter: (maxHits?: number) => void;
  onBatchDeslopBook: (maxPerChapter?: number) => void;
  onExportAiTasteCsv: () => void;
  onFixFirstRevision: () => void;
  /** 一键修全部：串行 AI 局部改写全书所有 open 待修 */
  onAiFixAllRevisionTodos: () => void;
  /** 停止一键修全部（软停 + 中断当前 in-flight LLM 调用） */
  onStopAiFixAll: () => void;
  /** 一键修全部运行中（按钮切换为「停止」） */
  aiFixAllRunning: boolean;
  onAiFixRevisionTodo: (chapterId: string, todoId: string) => void;
  /** 重跑本审：对当前章正文重新执行审校（只读，不改正文） */
  onRerunHardReview: (chapterId: string) => void;
  onClearDoneRevisionTodos: () => void;
  onMarkAllRevisionTodosDone: () => void;
  onToggleRevisionTodo: (chapterId: string, todoId: string) => void;
  /** 全书缺口扫描 + 批量补跑 */
  gapReport: GapReport | null;
  gapFilling: boolean;
  gapProgress: GapFillProgress;
  gapSummary: GapFillSummary | null;
  onScanGaps: () => void;
  onStartGapFilling: (chapterIds: string[], writeMode: AutoPilotWriteMode) => void;
  onStopGapFilling: () => void;
}

/**
 * 工作区标签页容器（R1 拆分最后一步）。
 * 纯透传：把 App 层的章节动作 handler 与派生数据接线给
 * ChapterSidebar / WritingCanvas / AIWorkflowPanel，自身无状态。
 */
export const WorkspaceTab: React.FC<WorkspaceTabProps> = ({
  chapters,
  volumes,
  activeChapterId,
  activeChapter,
  characters,
  settings,
  styleConfig,
  storyMemory,
  projectConfig,
  isGenerating,
  isAutoPiloting,
  autoPilotProgress,
  activeStep,
  statusMessage,
  previousContextPack,
  projectId,
  snapshotRefreshToken,
  dailyWordLog,
  crossAuditReport,
  crossAuditBusy,
  crossAuditRemind,
  aiTasteScanBusy,
  aiTasteScanMessage,
  focusTodoId,
  focusSnippet,
  onSelectChapter,
  onAddChapter,
  onDeleteChapter,
  onClearAllChapters,
  onClearAllChapterBodies,
  onUpdateChapter,
  onLockChapter,
  onUnlockChapter,
  onFocusTodoConsumed,
  onFocusSnippetConsumed,
  onStartThreeStepWorkflow,
  onStartAutoPilot,
  onStopAutoPilot,
  onStopGeneration,
  onUpdateStyleConfig,
  onUpdateBeats,
  onManualSnapshot,
  onRestoreSnapshot,
  onGenerateChapterIntent,
  onSaveChapterIntent,
  onRunCrossAudit,
  onDismissCrossAuditRemind,
  onJumpChapter,
  onOpenForRewrite,
  onJumpAuditIssue,
  onLocateInProse,
  onScanAiTasteChapter,
  onScanAiTasteBook,
  onDeslopHit,
  onBatchDeslopChapter,
  onBatchDeslopBook,
  onExportAiTasteCsv,
  onFixFirstRevision,
  onAiFixAllRevisionTodos,
  onStopAiFixAll,
  aiFixAllRunning,
  onAiFixRevisionTodo,
  onRerunHardReview,
  onClearDoneRevisionTodos,
  onMarkAllRevisionTodosDone,
  onToggleRevisionTodo,
  gapReport,
  gapFilling,
  gapProgress,
  gapSummary,
  onScanGaps,
  onStartGapFilling,
  onStopGapFilling,
}) => (
  <>
    <ChapterSidebar
      chapters={chapters}
      volumes={volumes}
      activeChapterId={activeChapterId}
      onSelectChapter={onSelectChapter}
      onAddChapter={onAddChapter}
      onDeleteChapter={onDeleteChapter}
      onClearAllChapters={onClearAllChapters}
      onClearAllChapterBodies={onClearAllChapterBodies}
      deleteDisabled={isGenerating || isAutoPiloting}
    />

    {activeChapter ? (
      <WritingCanvas
        chapter={activeChapter}
        onUpdateChapter={onUpdateChapter}
        isGenerating={isGenerating}
        onUnlockChapter={onUnlockChapter}
        onLockChapter={onLockChapter}
        characters={characters}
        settings={settings}
        styleConfig={styleConfig}
        storyMemory={storyMemory}
        bookGenre={projectConfig?.genre}
        focusTodoId={focusTodoId}
        onFocusTodoConsumed={onFocusTodoConsumed}
        focusSnippet={focusSnippet}
        onFocusSnippetConsumed={onFocusSnippetConsumed}
      />
    ) : (
      <div className="flex-1 flex items-center justify-center text-sm text-slate-500">
        请在左侧侧栏选择或创建章节
      </div>
    )}

    {activeChapter && (
      <AIWorkflowPanel
        chapter={activeChapter}
        characters={characters}
        settings={settings}
        styleConfig={styleConfig}
        projectConfig={projectConfig}
        storyMemory={storyMemory}
        allChapters={chapters}
        isGenerating={isGenerating}
        isAutoPiloting={isAutoPiloting}
        autoPilotProgress={autoPilotProgress}
        activeStep={activeStep}
        statusMessage={statusMessage}
        previousContextPack={previousContextPack}
        onStartThreeStepWorkflow={onStartThreeStepWorkflow}
        onStartAutoPilot={onStartAutoPilot}
        onStopAutoPilot={onStopAutoPilot}
        onStopGeneration={onStopGeneration}
        onUpdateStyleConfig={onUpdateStyleConfig}
        onUpdateBeats={onUpdateBeats}
        projectId={projectId}
        snapshotRefreshToken={snapshotRefreshToken}
        onManualSnapshot={onManualSnapshot}
        onRestoreSnapshot={onRestoreSnapshot}
        onLockChapter={onLockChapter}
        onUnlockChapter={onUnlockChapter}
        onGenerateChapterIntent={onGenerateChapterIntent}
        onSaveChapterIntent={onSaveChapterIntent}
        crossAuditReport={crossAuditReport}
        crossAuditBusy={crossAuditBusy}
        onRunCrossAudit={onRunCrossAudit}
        crossAuditRemind={crossAuditRemind}
        onDismissCrossAuditRemind={onDismissCrossAuditRemind}
        onJumpChapter={onJumpChapter}
        onOpenForRewrite={onOpenForRewrite}
        onJumpAuditIssue={onJumpAuditIssue}
        onLocateInProse={onLocateInProse}
        onScanAiTasteChapter={onScanAiTasteChapter}
        onScanAiTasteBook={onScanAiTasteBook}
        onDeslopHit={onDeslopHit}
        onBatchDeslopChapter={onBatchDeslopChapter}
        onBatchDeslopBook={onBatchDeslopBook}
        onExportAiTasteCsv={onExportAiTasteCsv}
        aiTasteScanBusy={aiTasteScanBusy}
        aiTasteScanMessage={aiTasteScanMessage}
        onFixFirstRevision={onFixFirstRevision}
        onAiFixAllRevisionTodos={onAiFixAllRevisionTodos}
        onStopAiFixAll={onStopAiFixAll}
        aiFixAllRunning={aiFixAllRunning}
        onAiFixRevisionTodo={onAiFixRevisionTodo}
        onRerunHardReview={onRerunHardReview}
        onClearDoneRevisionTodos={onClearDoneRevisionTodos}
        onMarkAllRevisionTodosDone={onMarkAllRevisionTodosDone}
        onToggleRevisionTodo={onToggleRevisionTodo}
        gapReport={gapReport}
        gapFilling={gapFilling}
        gapProgress={gapProgress}
        gapSummary={gapSummary}
        onScanGaps={onScanGaps}
        onStartGapFilling={onStartGapFilling}
        onStopGapFilling={onStopGapFilling}
        dailyWordLog={dailyWordLog}
      />
    )}
  </>
);
