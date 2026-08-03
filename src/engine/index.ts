/**
 * Novel Studio 写作引擎（InkOS 风格多 agent 管线）
 *
 * 阶段：Planner → Writer → Validator → Auditor → Reviser → Settler
 * UI / 存储仍在 App；脑子在这里。
 */
export {
  runChapterPipeline,
  MIN_GREEN_VERIFICATION_SCORE,
} from './pipeline';
export type {
  ChapterPipelineInput,
  ChapterPipelineHooks,
  ChapterPipelineResult,
  EngineStage,
  WriteMode,
  EngineProgress,
} from './types';
export {
  validatePostWrite,
  PROSE_DISCIPLINE_ZH,
  findSensoryStackParagraphs,
} from './discipline';
export type { EngineViolation } from './discipline';
