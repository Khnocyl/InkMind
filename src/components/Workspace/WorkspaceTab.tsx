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
  onAiFixRevisionTodo: (chapterId: string, todoId: string) => void;
  onClearDoneRevisionTodos: () => void;
  onMarkAllRevisionTodosDone: () => void;
  onToggleRevisionTodo: (chapterId: string, todoId: string) => void;
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
  onAiFixRevisionTodo,
  onClearDoneRevisionTodos,
  onMarkAllRevisionTodosDone,
  onToggleRevisionTodo,
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
        onAiFixRevisionTodo={onAiFixRevisionTodo}
        onClearDoneRevisionTodos={onClearDoneRevisionTodos}
        onMarkAllRevisionTodosDone={onMarkAllRevisionTodosDone}
        onToggleRevisionTodo={onToggleRevisionTodo}
        dailyWordLog={dailyWordLog}
      />
    )}
  </>
);
