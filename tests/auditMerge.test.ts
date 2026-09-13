import { describe, expect, it } from 'vitest';
import {
  hardIssuesToConflicts,
  styleSuggestionsToConflicts,
} from '../src/services/aiEngine';
import type { HardReviewIssue } from '../src/types/novel';

/**
 * 审校合并共享函数的契约测试。
 *
 * 背景：`auditorAgent`（重跑本审）与 `aiEngine.step3_CriticVerify`（管线审校）
 * 此前各有一份逐字相同的私有实现；任一侧改动就会造成「同一正文、两条审校路径
 * 结论不一致」。现已合并为共享函数，这里锁住语义防回归。
 */

describe('hardIssuesToConflicts · 硬伤 → logicConflicts', () => {
  it('逐条映射为 hard lane，保留 type/description/suggestion', () => {
    const issues = [
      { type: '战力越界', description: '主角越级秒杀', suggestion: '降低战力表现' },
      { type: '时间线错乱', description: '昨日已死今日复现', suggestion: '调整时间线' },
    ] as unknown as HardReviewIssue[];

    const conflicts = hardIssuesToConflicts(issues) as unknown as Array<{
      type: string;
      description: string;
      suggestion: string;
      lane: string;
    }>;

    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]).toEqual({
      type: '战力越界',
      description: '主角越级秒杀',
      suggestion: '降低战力表现',
      lane: 'hard',
    });
    expect(conflicts.every((c) => c.lane === 'hard')).toBe(true);
  });

  it('空数组 → 空结果', () => {
    expect(hardIssuesToConflicts([])).toEqual([]);
  });
});

describe('styleSuggestionsToConflicts · 文笔建议 → style 软线索', () => {
  it('最多取 4 条，标记 style lane，且文案固定', () => {
    const suggestions = ['建议一', '建议二', '建议三', '建议四', '建议五'];

    const conflicts = styleSuggestionsToConflicts(suggestions) as unknown as Array<{
      type: string;
      description: string;
      suggestion: string;
      lane: string;
    }>;

    // 截断上限 4：这是与另一条审校路径对齐的关键语义
    expect(conflicts).toHaveLength(4);
    expect(conflicts[0].type).toBe('行文套路');
    expect(conflicts[0].description).toBe('[文笔建议] 建议一');
    expect(conflicts[0].lane).toBe('style');
    expect(conflicts[0].suggestion).toContain('不阻断定稿');
    // 第五条被截掉
    expect(conflicts.some((c) => c.description.includes('建议五'))).toBe(false);
  });

  it('空/未定义 → 空结果（不抛错）', () => {
    expect(styleSuggestionsToConflicts([])).toEqual([]);
    expect(styleSuggestionsToConflicts(undefined as unknown as string[])).toEqual([]);
  });
});
