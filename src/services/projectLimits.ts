/**
 * ProjectConfig 里「目标总章数」的取值上限（单一来源）。
 *
 * 单独成模块的原因：此前**同一字段两处各写各的字面量**——
 * 向导 `InspirationStep` 的滑杆写死 `max={500}`，设置页 `StyleAndEngineManager`
 * 写死 `max={5000}`。于是：
 *   1. 在设置页把目标设成 3000 章后再打开向导，滑杆按 HTML 规范会把 value 钳到 500，
 *      而标签读的是 React state（仍是 3000）→ **显示与控件不一致**，
 *      用户一碰滑杆就被静默降到 ≤500；
 *   2. 长连载（1000+ 章）在向导里根本无法表达。
 *
 * 收敛到单一常量，两处共用。改这个值时**只需改这里**。
 *
 * 注：`projectTransfer` 的导入归一**不钳制**该字段（只校验类型），
 * 所以库中可能存在超过本上限的历史值——消费方需按「取 max(本常量, 当前值)」处理，
 * 不要让 range/number 控件把用户的既有值静默改小。
 */
export const MAX_TARGET_CHAPTERS = 5000;

/**
 * 控件应使用的章数上限：**永远不低于当前值**。
 *
 * 不变量：range/number 控件会按 HTML 规范把 value 钳到 max。若 max 小于用户既有值，
 * 就会出现「标签显示 3000、滑块停在 500」的错位，且用户一碰控件就被静默降级。
 * 因此 max 必须取 `max(常量, 当前值)`——宁可把刻度拉长，也不能改小用户的值。
 */
export function effectiveTargetChapterMax(current: number): number {
  const cur = Number.isFinite(current) ? Math.floor(current) : 0;
  return Math.max(MAX_TARGET_CHAPTERS, Math.max(1, cur));
}

/**
 * 向导滑杆（type=range）的网格：min=20、step=10（与 InspirationStep 的控件一致，单一来源）。
 */
export const CHAPTER_SLIDER_MIN = 20;
export const CHAPTER_SLIDER_STEP = 10;

/**
 * 滑杆专用的上限：在 `effectiveTargetChapterMax` 基础上**向上吸附到网格**。
 *
 * HTML range 的可停位置都在 `min + k×step` 网格上：若 max 不在网格（如导入的 5999），
 * 滑块实际够不到 max（只到 5990），标签却显示 5999——「标签与控件错位」的又一形态。
 * 向上取整到网格（5999 → 6000）保证滑块覆盖全部合法值。step=1 的数字输入框
 * 不用本函数（无网格概念），仍用 `effectiveTargetChapterMax`。
 */
export function effectiveSliderChapterMax(current: number): number {
  const base = effectiveTargetChapterMax(current);
  const span = Math.max(0, base - CHAPTER_SLIDER_MIN);
  return CHAPTER_SLIDER_MIN + Math.ceil(span / CHAPTER_SLIDER_STEP) * CHAPTER_SLIDER_STEP;
}
