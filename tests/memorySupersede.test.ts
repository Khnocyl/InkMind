import { describe, it, expect } from 'vitest';
import { mergeRecapIntoMemory, listActiveFacts } from '../src/services/storyMemory';
import type { StoryMemory } from '../src/types/novel';

function memWith(facts: { id: string; text: string; src: number }[]): StoryMemory {
  return {
    pinnedFacts: facts.map((f) => ({
      id: f.id,
      text: f.text,
      sourceChapterNumber: f.src,
      validFromChapter: f.src,
      validUntilChapter: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'pinned' as const,
    })),
    openThreads: [],
    spanDigests: [],
    locations: [],
    items: [],
    factLedger: [],
    authorNotes: [],
  } as unknown as StoryMemory;
}

describe('mergeRecapIntoMemory · 同章重写事实作废（P0-② 防记忆污染）', () => {
  it('本章重写：旧版自动派生事实作废，新 recap 事实入库', () => {
    const mem = memWith([
      { id: 'fact-1-1700000000000-0', text: '旧稿：沈烬被以草席卷抬至正堂矮榻', src: 1 },
      { id: 'fact-2-1700000000001-0', text: '第2章事实：姜漪澜当众宣读退婚书', src: 2 },
    ]);
    const out = mergeRecapIntoMemory(
      mem,
      {
        text: '本章复盘',
        keyFacts: ['新稿：沈烬被拖入北墙根废弃祠堂，门从外闩死'],
        endingState: '祠堂雪夜',
        openThreads: [],
      },
      1
    );
    const active = listActiveFacts(out.memory);
    // 旧 ch1 自动事实已作废；ch2 事实不受影响；新事实已入库
    expect(active.some((f) => f.text.includes('草席卷'))).toBe(false);
    expect(active.some((f) => f.text.includes('姜漪澜'))).toBe(true);
    expect(active.some((f) => f.text.includes('北墙根废弃祠堂'))).toBe(true);
    const old = out.memory.pinnedFacts.find((f) => f.id === 'fact-1-1700000000000-0');
    expect(old?.status).toBe('superseded');
    expect(old?.note || '').toContain('本章重写');
  });

  it('作者手钉事实（fact-manual-*）同章也不被自动作废', () => {
    const mem = memWith([
      { id: 'fact-manual-1700000000002', text: '作者手钉：星晷碎片共有七道裂纹上限', src: 1 },
    ]);
    const out = mergeRecapIntoMemory(
      mem,
      { text: 'r', keyFacts: ['新事实'], endingState: '', openThreads: [] },
      1
    );
    expect(listActiveFacts(out.memory).some((f) => f.id.startsWith('fact-manual-'))).toBe(true);
  });
});
