/**
 * 生成期间「用户新建/钉死的记忆条目」不得被章末落盘静默覆盖（P0-1 记忆侧）。
 *
 * 背景：useChapterPipeline 的终稿落盘把 `memory: consolidatedMemory` 整对象写回，
 * 而 consolidatedMemory 基于**生成开始时的记忆快照**算出（含 2 次分钟级 LLM await）。
 * 用户在这期间在记忆面板钉的事实、新增的伏笔、补的手动断言会被整体覆盖。
 *
 * 记忆是嵌套结构，无法像角色表那样做字段级合并，因此采用「按 id 并集」：
 * 以管线产出为准，把 latest 中缺失的条目补回。
 */
import { describe, expect, it } from 'vitest';
import { mergeMemoryUserAdditions } from '../src/services/storyMemory';
import type { StoryMemory } from '../src/types/novel';

function mem(over: Partial<StoryMemory> = {}): StoryMemory {
  return {
    pinnedFacts: [],
    openThreads: [],
    spanDigests: [],
    locations: [],
    items: [],
    factLedger: { assertions: [], recentSnapshots: [], updatedAt: '2026-01-01T00:00:00.000Z' },
    ...over,
  } as unknown as StoryMemory;
}

describe('mergeMemoryUserAdditions · 记忆条目并集', () => {
  it('用户生成期间钉的事实被保留（管线产出里没有）', () => {
    const latest = mem({
      pinnedFacts: [{ id: 'pf-user', text: '用户钉死：主角左手已断' }],
    });
    const produced = mem({
      pinnedFacts: [{ id: 'pf-pipeline', text: '管线：本章新增事实' }],
    } as Partial<StoryMemory>);
    const out = mergeMemoryUserAdditions(latest, produced);
    const ids = out.pinnedFacts.map((f) => f.id);
    expect(ids).toContain('pf-user');
    expect(ids).toContain('pf-pipeline');
  });

  it('用户新增的伏笔被保留', () => {
    const latest = mem({ openThreads: [{ id: 'th-user', text: '用户加的线索' }] } as Partial<StoryMemory>);
    const produced = mem({ openThreads: [{ id: 'th-pipeline', text: '管线回收记录' }] } as Partial<StoryMemory>);
    const out = mergeMemoryUserAdditions(latest, produced);
    expect(out.openThreads.map((t) => t.id)).toEqual(['th-pipeline', 'th-user']);
  });

  it('用户手动补的账本断言被保留', () => {
    const latest = mem({
      factLedger: {
        assertions: [{ id: 'fa-user', kind: 'item_owner', subject: '青锋剑', claim: '归主角', status: 'active' }],
        recentSnapshots: [],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    } as Partial<StoryMemory>);
    const produced = mem({
      factLedger: {
        assertions: [{ id: 'fa-pipeline', kind: 'death', subject: '镇夜', claim: '镇夜已阵亡', status: 'active' }],
        recentSnapshots: [],
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    } as Partial<StoryMemory>);
    const out = mergeMemoryUserAdditions(latest, produced);
    const ids = (out.factLedger?.assertions || []).map((a) => a.id);
    expect(ids).toContain('fa-user');
    expect(ids).toContain('fa-pipeline');
  });

  it('同 id 条目以管线为准（不重复、不被用户旧版本覆盖）', () => {
    const latest = mem({ pinnedFacts: [{ id: 'same', text: '用户版本' }] } as Partial<StoryMemory>);
    const produced = mem({ pinnedFacts: [{ id: 'same', text: '管线版本' }] } as Partial<StoryMemory>);
    const out = mergeMemoryUserAdditions(latest, produced);
    expect(out.pinnedFacts).toHaveLength(1);
    expect(out.pinnedFacts[0].text).toBe('管线版本');
  });

  it('latest 为空（首次写章）→ 原样返回管线产出', () => {
    const produced = mem({ pinnedFacts: [{ id: 'a', text: 'x' }] } as Partial<StoryMemory>);
    expect(mergeMemoryUserAdditions(null, produced)).toBe(produced);
    expect(mergeMemoryUserAdditions(undefined, produced)).toBe(produced);
  });

  it('管线产出的非条目字段（摘要/账本快照）不被改动', () => {
    const latest = mem({ authorNotes: '用户备忘' });
    const produced = mem({
      spanDigests: [{ id: 'd1', kind: 'rolling', text: '摘要' }],
    } as Partial<StoryMemory>);
    const out = mergeMemoryUserAdditions(latest, produced);
    expect(out.spanDigests).toEqual(produced.spanDigests);
    expect(out.authorNotes).toBe(undefined);
  });
});
