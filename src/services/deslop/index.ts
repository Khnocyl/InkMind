/**
 * 去 AI 味模块
 */

export {
  DESLOP_PHILOSOPHY_ZH,
  DESLOP_COMPACT_ZH,
  OH_STORY_PRIMARY_BANNED,
  OH_STORY_SECONDARY_BANNED,
  OH_STORY_EXPOSITION_PHRASES,
  OH_STORY_REPLACE_HINTS,
} from './canon';

export {
  findNotIsComparisons,
  countNotIsComparisons,
  type NotIsFinding,
} from './notIsComparison';

export {
  normalizeProsePunctuation,
  scanProsePunctuationIssues,
  type NormalizePunctuationResult,
  type PunctuationFinding,
} from './normalizePunctuation';
