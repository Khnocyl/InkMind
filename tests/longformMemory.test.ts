import { describe, it, expect } from 'vitest';
import {
  formatDigestsForPrompt,
  selectRelevantDigests,
} from '../src/services/longformMemory';
import type { StorySpanDigest } from '../src/types/novel';

function digest(
  kind: StorySpanDigest['kind'],
  from: number,
  to: number,
  title: string,
  summary = '摘要内容',
  keyFacts: string[] = [],
  openHooks: string[] = []
): StorySpanDigest {
  return {
    id: `${kind}-${from}-${to}`,
    kind,
    fromChapter: from,
    toChapter: to,
    title,
    summary,
    keyFacts,
    openHooks,
    createdAt: '2026-08-03T00:00:00Z',
  };
}

describe('selectRelevantDigests', () => {
  it('空输入返回空数组', () => {
    expect(selectRelevantDigests(undefined, [], 10)).toEqual([]);
    expect(selectRelevantDigests([], ['x'], 10)).toEqual([]);
  });

  it('过滤掉未来章节（toChapter >= 当前章）', () => {
    const d = [digest('rolling', 1, 5, '未来块')];
    expect(selectRelevantDigests(d, [], 5)).toEqual([]);
  });

  it('queryTerms 命中加权：相关块排在前面', () => {
    const unrelated = digest('mega', 1, 50, '第一卷', '江湖恩怨', ['刀']);
    const related = digest('mega', 51, 100, '第二卷', '藏宝图之争', ['藏宝图']);
    const picked = selectRelevantDigests([unrelated, related], ['藏宝图'], 120, 2);
    expect(picked[0].title).toBe('第二卷');
  });

  it('近 rolling 块（dist<=15）优先于远 rolling（同 kind 按分数排序）', () => {
    const far = digest('rolling', 1, 10, '远块', '旧事');
    const near = digest('rolling', 20, 25, '近块', '近况');
    // chapterNumber=30 → 走 <50 分支，arc/rolling/volume 同池按 score 排序
    // far dist=20(+2)，near dist=5(+5) → near 优先
    const picked = selectRelevantDigests([far, near], [], 30, 2);
    expect(picked[0].title).toBe('近块');
  });

  it('限制返回数量 max', () => {
    const ds = [
      digest('rolling', 90, 105, 'r1'),
      digest('arc', 60, 80, 'a1'),
      digest('mega', 1, 50, 'm1'),
      digest('super', 1, 100, 's1'),
    ];
    const picked = selectRelevantDigests(ds, [], 120, 2);
    expect(picked.length).toBeLessThanOrEqual(2);
  });
});

describe('formatDigestsForPrompt', () => {
  it('空数组返回空字符串', () => {
    expect(formatDigestsForPrompt([])).toBe('');
  });

  it('输出包含标题与章节范围', () => {
    const out = formatDigestsForPrompt([digest('rolling', 90, 105, '近块')], 2);
    expect(out).toContain('近块');
    expect(out).toContain('第90–105章');
    expect(out).toContain('滚动10');
  });

  it('超过 max 的块被截断', () => {
    const ds = [digest('mega', 1, 50, 'a'), digest('mega', 51, 100, 'b'), digest('mega', 101, 150, 'c')];
    const out = formatDigestsForPrompt(ds, 2);
    const bullets = out.split('\n').filter((l) => l.startsWith('▸')).length;
    expect(bullets).toBe(2);
  });

  it('keyFacts 与 openHooks 会渲染', () => {
    const out = formatDigestsForPrompt(
      [digest('arc', 60, 80, '弧', 's', ['主角受伤'], ['伏笔A'])],
      1
    );
    expect(out).toContain('主角受伤');
    expect(out).toContain('伏笔A');
  });
});
