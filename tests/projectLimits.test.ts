/**
 * 目标总章数上限（`src/services/projectLimits.ts`）回归守卫。
 *
 * 背景：该字段此前**两处各写各的字面量**——向导滑杆 `max={500}`、设置页 `max={5000}`。
 * 后果有两条，都必须锁住：
 *   1. 长连载（1000+ 章）在向导里无法表达；
 *   2. 在设置页设 3000 章后打开向导，range 输入按 HTML 规范把 value 钳到 max，
 *      而标签读 React state（仍 3000）→ 显示与控件错位，用户一碰滑杆就被静默降级。
 */
import { describe, expect, it } from 'vitest';
import {
  CHAPTER_SLIDER_MIN,
  CHAPTER_SLIDER_STEP,
  MAX_TARGET_CHAPTERS,
  effectiveSliderChapterMax,
  effectiveTargetChapterMax,
} from '../src/services/projectLimits';

describe('projectLimits · 目标总章数上限', () => {
  it('上限足够覆盖长连载（不再是 500）', () => {
    expect(MAX_TARGET_CHAPTERS).toBeGreaterThanOrEqual(2000);
  });

  it('控件上限永远不低于当前值（否则用户既有值会被控件静默改小）', () => {
    // 常规值 → 用常量
    expect(effectiveTargetChapterMax(100)).toBe(MAX_TARGET_CHAPTERS);
    expect(effectiveTargetChapterMax(MAX_TARGET_CHAPTERS)).toBe(MAX_TARGET_CHAPTERS);
    // 历史/导入的超限值 → 抬到该值，绝不压小
    expect(effectiveTargetChapterMax(MAX_TARGET_CHAPTERS + 3000)).toBe(
      MAX_TARGET_CHAPTERS + 3000
    );
    expect(effectiveTargetChapterMax(99999)).toBe(99999);
  });

  it('脏输入（0/负数/NaN/小数）不产生非法上限', () => {
    expect(effectiveTargetChapterMax(0)).toBe(MAX_TARGET_CHAPTERS);
    expect(effectiveTargetChapterMax(-5)).toBe(MAX_TARGET_CHAPTERS);
    expect(effectiveTargetChapterMax(Number.NaN)).toBe(MAX_TARGET_CHAPTERS);
    expect(effectiveTargetChapterMax(Number.POSITIVE_INFINITY)).toBe(MAX_TARGET_CHAPTERS);
    expect(effectiveTargetChapterMax(1200.7)).toBe(MAX_TARGET_CHAPTERS);
    expect(effectiveTargetChapterMax(MAX_TARGET_CHAPTERS + 10.9)).toBe(
      MAX_TARGET_CHAPTERS + 10
    );
  });

  it('两处消费方共用同一常量（防止再次漂移）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = process.cwd();
    for (const rel of [
      'src/components/ProjectWizard/InspirationStep.tsx',
      'src/components/StyleConfig/StyleAndEngineManager.tsx',
    ]) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      // 不得再出现写死的章数上限字面量
      expect(src, `${rel} 仍有写死的 max={500}`).not.toMatch(/max=\{500\}/);
      expect(src, `${rel} 仍有写死的 max={5000}`).not.toMatch(/max=\{5000\}/);
      expect(src, `${rel} 未引用 projectLimits`).toMatch(/services\/projectLimits/);
    }
  });

  it('设置页数字输入按当前值抬升上限（存量 >5000 不被控件静默改小）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/components/StyleConfig/StyleAndEngineManager.tsx'),
      'utf8'
    );
    // 若退回写死常量 max={MAX_TARGET_CHAPTERS}，导入的超限存量值一碰就被 clamp
    expect(src, '设置页应使用 effectiveTargetChapterMax(当前值) 而非常量').toContain(
      'effectiveTargetChapterMax('
    );
    expect(src, '设置页不得再写死常量 max').not.toMatch(/max=\{MAX_TARGET_CHAPTERS\}/);
  });

  it('向导滑杆上限吸附到网格（防「标签 5999、滑块只到 5990」）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/components/ProjectWizard/InspirationStep.tsx'),
      'utf8'
    );
    expect(src, '向导滑杆应使用 effectiveSliderChapterMax').toContain(
      'effectiveSliderChapterMax('
    );
  });
});

describe('projectLimits · 滑杆网格吸附', () => {
  it('网格内常规值原样返回（min=20 / step=10 网格点不动）', () => {
    expect(effectiveSliderChapterMax(100)).toBe(MAX_TARGET_CHAPTERS);
    // MAX_TARGET_CHAPTERS=5000 在网格上：(5000-20)/10=498 整除
    expect((MAX_TARGET_CHAPTERS - CHAPTER_SLIDER_MIN) % CHAPTER_SLIDER_STEP).toBe(0);
    expect(effectiveSliderChapterMax(5000)).toBe(5000);
  });

  it('超限/不在网格的值向上吸附（5999 → 6000，滑块必须够得到当前值）', () => {
    expect(effectiveSliderChapterMax(5999)).toBe(6000);
    expect(effectiveSliderChapterMax(5991)).toBe(6000);
    expect(effectiveSliderChapterMax(5990)).toBe(5990); // 已在网格
    expect(effectiveSliderChapterMax(12345)).toBe(12350);
    // 吸附后仍满足「不低于当前值」不变量
    for (const v of [5999, 12345, 7]) {
      expect(effectiveSliderChapterMax(v)).toBeGreaterThanOrEqual(
        Math.max(MAX_TARGET_CHAPTERS, v)
      );
    }
  });
});
