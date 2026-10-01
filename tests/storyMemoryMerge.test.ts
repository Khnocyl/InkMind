/**
 * 生成期间「用户对记忆的编辑」不得被章末落盘静默覆盖。
 *
 * 背景：useChapterPipeline 的终稿落盘把 `memory: consolidatedMemory` 整对象写回，
 * 而 consolidatedMemory 基于**生成开始时的记忆快照**算出（含 2 次分钟级 LLM await）。
 * 用户在这期间在记忆面板钉的事实、新增的伏笔、补的手动断言、乃至**删除**都会被覆盖。
 *
 * 传入生成开始时的 baseline 后走**三方合并**（与角色表 mergeCharacterStatesFromPipeline
 * 同口径）：用户的增/改/删都保住，管线真正做过的改动照常生效。
 * 不传 baseline 时降级为「按 id 并集」（只保新增）。
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

describe('mergeMemoryUserAdditions · 三方合并（传 baseline）', () => {
  const fact = (id: string, text: string) => ({ id, text, status: 'pinned' }) as never;
  const thread = (id: string, text: string) => ({ id, text, status: 'open' }) as never;

  it('用户在生成期间**删除**的事实不复活（baseline 有、latest 无）', () => {
    const baseline = mem({ pinnedFacts: [fact('pf-1', '错钉的事实')] });
    const latest = mem({ pinnedFacts: [] }); // 用户删掉了
    const produced = mem({ pinnedFacts: [fact('pf-1', '错钉的事实')] }); // 管线仍带着它
    const out = mergeMemoryUserAdditions(latest, produced, baseline);
    expect(out.pinnedFacts.map((f) => f.id)).toEqual([]);
  });

  it('用户**改过**且管线没动 → 保留用户的版本', () => {
    const baseline = mem({ pinnedFacts: [fact('pf-1', '原文')] });
    const latest = mem({ pinnedFacts: [fact('pf-1', '用户改过的文本')] });
    const produced = mem({ pinnedFacts: [fact('pf-1', '原文')] }); // 与 baseline 相同 = 管线没动
    const out = mergeMemoryUserAdditions(latest, produced, baseline);
    expect(out.pinnedFacts).toHaveLength(1);
    expect((out.pinnedFacts[0] as { text: string }).text).toBe('用户改过的文本');
  });

  it('管线**真的改过** → 以管线为准（保证本章更新生效）', () => {
    const baseline = mem({ pinnedFacts: [fact('pf-1', '原文')] });
    const latest = mem({ pinnedFacts: [fact('pf-1', '用户改过的文本')] });
    const produced = mem({
      pinnedFacts: [{ id: 'pf-1', text: '原文', status: 'superseded' }] as never,
    });
    const out = mergeMemoryUserAdditions(latest, produced, baseline);
    expect((out.pinnedFacts[0] as { status: string }).status).toBe('superseded');
  });

  it('管线新增的条目保留（baseline 与 latest 都没有）', () => {
    const baseline = mem({ pinnedFacts: [] });
    const latest = mem({ pinnedFacts: [] });
    const produced = mem({ pinnedFacts: [fact('pf-new', '管线本章新增')] });
    const out = mergeMemoryUserAdditions(latest, produced, baseline);
    expect(out.pinnedFacts.map((f) => f.id)).toEqual(['pf-new']);
  });

  it('伏笔同理：生成期间删掉的伏笔不复活', () => {
    const baseline = mem({ openThreads: [thread('th-1', '旧线索')] });
    const latest = mem({ openThreads: [] });
    const produced = mem({ openThreads: [thread('th-1', '旧线索')] });
    const out = mergeMemoryUserAdditions(latest, produced, baseline);
    expect(out.openThreads).toEqual([]);
  });

  it('账本断言同理：生成期间删掉的断言不复活', () => {
    const ledger = (ids: string[]) =>
      ({
        assertions: ids.map((id) => ({ id, kind: 'event', subject: 's', claim: 'c' })),
        recentSnapshots: [],
        updatedAt: '2026-01-01T00:00:00.000Z',
      }) as never;
    const baseline = mem({ factLedger: ledger(['a-1']) });
    const latest = mem({ factLedger: ledger([]) });
    const produced = mem({ factLedger: ledger(['a-1']) });
    const out = mergeMemoryUserAdditions(latest, produced, baseline);
    expect(out.factLedger?.assertions).toEqual([]);
  });

  it('不传 baseline → 降级为并集（向后兼容，仍不复活删除）', () => {
    const latest = mem({ pinnedFacts: [fact('pf-user', '用户钉的')] });
    const produced = mem({ pinnedFacts: [fact('pf-pipe', '管线新增')] });
    const out = mergeMemoryUserAdditions(latest, produced);
    expect(out.pinnedFacts.map((f) => f.id).sort()).toEqual(['pf-pipe', 'pf-user']);
  });

  it('authorNotes：生成期间用户编辑过就以用户的为准', () => {
    const baseline = mem({ authorNotes: '旧备忘' });
    const latest = mem({ authorNotes: '用户新写的备忘' });
    const produced = mem({ authorNotes: '旧备忘' }); // 管线从不写它
    const out = mergeMemoryUserAdditions(latest, produced, baseline);
    expect(out.authorNotes).toBe('用户新写的备忘');
  });
});
