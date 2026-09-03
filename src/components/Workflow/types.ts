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
import type { GapReport } from '../../services/gapScanner';
import type { GapFillProgress, GapFillSummary } from '../../hooks/useGapFiller';
import type { AutoPilotWriteMode } from '../../services/autoPilot';
import type { CrossAuditRemindStatus } from '../../services/crossAuditRemind';
import type { CrossChapterIssue } from '../../types/novel';

/**
 * AIWorkflowPanel 对外 props 签名（简约化改造中保持不变，仅迁出独立文件便于分发）。
 */
export interface AIWorkflowPanelProps {
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
  /** 停止单章生成：中断当前全部 in-flight LLM 调用（AP 模式由 onStopAutoPilot 处理） */
  onStopGeneration?: () => void;
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
  crossAuditRemind?: CrossAuditRemindStatus | null;
  onDismissCrossAuditRemind?: () => void;
  onJumpChapter?: (chapterId: string, todoId?: string) => void;
  /** 待修：解锁（若锁）并定位改稿 */
  onOpenForRewrite?: (chapterId: string, todoId?: string) => void;
  /** 抽检 issue 跳转相关章 */
  onJumpAuditIssue?: (
    issue: CrossChapterIssue,
    preferredChapterNumber?: number
  ) => void;
  onFixFirstRevision?: () => void;
  /** 一键修全部：串行 AI 局部改写全书所有 open 待修 */
  onAiFixAllRevisionTodos?: () => void;
  /** 停止一键修全部（软停 + 中断当前 in-flight LLM 调用） */
  onStopAiFixAll?: () => void;
  /** 一键修全部运行中（按钮切换为「停止」） */
  aiFixAllRunning?: boolean;
  /** AI 修指定待修 */
  onAiFixRevisionTodo?: (chapterId: string, todoId: string) => void | Promise<void>;
  /** 重跑本审：对当前章正文重新执行审校（只读复核，不改动正文；锁定章可用） */
  onRerunHardReview?: (chapterId: string) => void | Promise<void>;
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
  /** 全书缺口扫描 + 批量补跑 */
  gapReport?: GapReport | null;
  gapFilling?: boolean;
  gapProgress?: GapFillProgress;
  gapSummary?: GapFillSummary | null;
  onScanGaps?: () => void;
  onStartGapFilling?: (chapterIds: string[], writeMode: AutoPilotWriteMode) => void;
  onStopGapFilling?: () => void;
}

/** 右栏三分组 key */
export type WorkflowGroup = 'write' | 'audit' | 'book';
