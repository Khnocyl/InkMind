/**
 * 自动大纲单次章数上限（prompts.OUTLINE_GENERATE_MAX_CHAPTERS）回归守卫。
 *
 * 背景（2026-09-25 复审 P2-2）：向导/设置页的目标章数上限放开到 5000 后，
 * 大纲生成仍按 500 封顶——「UI 能选、生成跟不上」的口径分裂。
 * 产品决策（2026-09-25）：**保留 500 上限**（单次拆章成本保护，每 20 章一批 LLM 调用），
 * 但把两个语义拆开——目标总章数是全书目标（进度/书库用，上限 5000），
 * 大纲单次只生成到本上限；向导滑杆与大纲审阅页如实提示超出部分不自动生成。
 *
 * 本测试锁三件事：上限值（改动需显式决策）、封顶行为、两处提示与常量的接线
 * （防提示文案与上限悄悄漂移）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';import {
  OUTLINE_GENERATE_MAX_CHAPTERS,
  resolveOutlineTotalChapters,
} from '../src/services/prompts';
import type { ProjectConfig } from '../src/types/novel';

function cfg(n?: number): ProjectConfig {
  return { targetChapterCount: n } as unknown as ProjectConfig;
}

describe('outlineCap · 大纲单次生成上限', () => {
  it('上限钉为 500（提高需显式改此值并评估批量成本：每 20 章一批 LLM 调用）', () => {
    expect(OUTLINE_GENERATE_MAX_CHAPTERS).toBe(500);
  });

  it('resolveOutlineTotalChapters：目标超限按 500 封顶；合法区间原样；非法回落 100', () => {
    expect(resolveOutlineTotalChapters(cfg(3000))).toBe(500);
    expect(resolveOutlineTotalChapters(cfg(501))).toBe(500);
    expect(resolveOutlineTotalChapters(cfg(500))).toBe(500);
    expect(resolveOutlineTotalChapters(cfg(499))).toBe(499);
    expect(resolveOutlineTotalChapters(cfg(20))).toBe(20);
    expect(resolveOutlineTotalChapters(cfg(undefined))).toBe(100);
    expect(resolveOutlineTotalChapters(cfg(Number.NaN))).toBe(100);
    expect(resolveOutlineTotalChapters(cfg(0))).toBe(100);
  });

  it('向导滑杆与大纲审阅页都接了上限常量（防提示与上限漂移）', () => {
    for (const rel of [
      'src/components/ProjectWizard/InspirationStep.tsx',
      'src/components/ProjectWizard/OutlineReviewStep.tsx',
    ]) {
      const src = readFileSync(join(process.cwd(), rel), 'utf8');
      expect(src, `${rel} 未引用 OUTLINE_GENERATE_MAX_CHAPTERS`).toContain(
        'OUTLINE_GENERATE_MAX_CHAPTERS'
      );
    }
  });
});
