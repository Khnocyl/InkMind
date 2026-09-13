/**
 * InkMind 写作引擎（多 Agent 协作管线）
 *
 * 阶段：Planner → Writer → Auditor（内含写后确定性校验，进度显示 [Validator]）
 *       → Reviser → Settler
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
  validateStyleHardRules,
  collectSpeakerNames,
  computeDialogueCharRatio,
  PROSE_DISCIPLINE_ZH,
  findSensoryStackParagraphs,
} from './discipline';
export type { EngineViolation } from './discipline';
