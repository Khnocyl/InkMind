import type {
  BookProject,
  Chapter,
  ChapterRecap,
  Character,
  MemoryAuditLog,
  MemoryWriteLog,
  PlotBeat,
  StyleConfig,
  WorldSetting,
  ChapterFactSnapshot,
  StoryMemory,
} from '../types/novel';
import type { PreviousContextPack } from '../services/contextPack';
import type { RuleScanResult } from '../services/ruleScan';
import type { EngineViolation } from './discipline';

/** 多 Agent 创作管线阶段 */
export type EngineStage =
  | 'plan'
  | 'write'
  | 'post_validate'
  | 'audit'
  | 'revise'
  | 'settle'
  | 'done'
  | 'error';

export type WriteMode = 'until_green' | 'draft_only' | 'until_review';

export interface EngineProgress {
  stage: EngineStage;
  message: string;
}

export interface ChapterPipelineInput {
  project: BookProject;
  chapter: Chapter;
  characters: Character[];
  settings: WorldSetting[];
  styleConfig: StyleConfig;
  previousContext: string;
  contextPack: PreviousContextPack;
  storyMemoryBlock: string;
  chapterIntentBlock: string;
  genrePackBlock: string;
  previousProse: string;
  targetWordCount: number | null;
  writeMode: WriteMode;
  /** 最多审修轮数（audit→revise），默认 2 */
  maxReviseRounds?: number;
  /** 综合分绿通门槛，默认 75 */
  minGreenScore?: number;
  /** 用户中止信号：触发后管线在阶段边界尽快停止（已流式产出的部分由调用方保留为草稿） */
  signal?: AbortSignal;
}

export interface ChapterPipelineHooks {
  onProgress?: (p: EngineProgress) => void;
  onStreamProse?: (text: string) => void;
  onBeats?: (beats: PlotBeat[]) => void;
}

export interface ChapterPipelineResult {
  ok: boolean;
  stageReached: EngineStage;
  chapterNumber: number;
  chapterId: string;
  beats: PlotBeat[];
  prose: string;
  wordCount: number;
  status: Chapter['status'];
  locked: boolean;
  lockedAt?: string;
  /** R3-A：是否为本地保守稿（LLM 执笔失败降级，不应自动锁章） */
  conservative?: boolean;
  auditLog?: MemoryAuditLog;
  ruleScan?: RuleScanResult;
  postWriteViolations: EngineViolation[];
  recap?: ChapterRecap;
  memoryWriteLog?: MemoryWriteLog;
  updatedCharacters?: Character[];
  /** 合并 recap 后的书级记忆（调用方再做账本） */
  memoryAfterRecap?: StoryMemory;
  factSnapshot?: ChapterFactSnapshot;
  score: number;
  greenOk: boolean;
  ruleScanPassed: boolean;
  /** 修订轮次 */
  reviseRounds: number;
  errorMessage?: string;
}

/** 单 agent 公共上下文 */
export interface AgentContext {
  input: ChapterPipelineInput;
  hooks: ChapterPipelineHooks;
  report: (stage: EngineStage, message: string) => void;
}
