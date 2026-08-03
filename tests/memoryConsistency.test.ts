import { describe, it, expect } from 'vitest';
import {
  detectRecapConflicts,
  detectLedgerCharacterConflicts,
} from '../src/services/memoryConsistency';
import type { ChapterRecap, Character, StoryMemory } from '../src/types/novel';

function memoryWithFacts(facts: string[]): StoryMemory {
  return {
    pinnedFacts: facts.map((text, i) => ({
      id: `f${i}`,
      text,
      status: 'pinned' as const,
      createdAt: new Date().toISOString(),
    })),
    openThreads: [],
  };
}

function recapWithFacts(keyFacts: string[]): ChapterRecap {
  return {
    text: '本章正文摘要'.repeat(10),
    keyFacts,
    endingState: '主角在山门对峙',
    openThreads: [],
    generatedAt: new Date().toISOString(),
    source: 'llm',
  };
}

describe('detectRecapConflicts', () => {
  it('旧「已死」+ 新「复活」→ warn（合法反转需显式）', () => {
    const memory = memoryWithFacts(['叶无痕已战死，尸骨无存']);
    const recap = recapWithFacts(['叶无痕在深渊中复活，重获肉身']);
    const r = detectRecapConflicts(memory, recap);
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('recap_vs_pinned');
    expect(r[0].severity).toBe('warn');
    expect(r[0].oldFactText).toContain('叶无痕已战死');
    expect(r[0].factText).toContain('叶无痕在深渊中复活');
  });

  it('旧「未死透」+ 新「身亡」→ warn', () => {
    const memory = memoryWithFacts(['李铁并未真正死去，只是假死']);
    const recap = recapWithFacts(['李铁这次真的身亡，魂飞魄散']);
    const r = detectRecapConflicts(memory, recap);
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe('warn');
  });

  it('归属冲突：旧「归 A」+ 新「归 B」→ warn', () => {
    const memory = memoryWithFacts(['青云剑归叶无痕所有']);
    const recap = recapWithFacts(['青云剑如今归苏清雪所有']);
    const r = detectRecapConflicts(memory, recap);
    expect(r).toHaveLength(1);
    expect(r[0].description).toContain('归属冲突');
  });

  it('正常追加（同主语无矛盾）→ 零冲突', () => {
    const memory = memoryWithFacts(['叶无痕突破元婴期']);
    const recap = recapWithFacts(['叶无痕获得天阶功法']);
    expect(detectRecapConflicts(memory, recap)).toHaveLength(0);
  });

  it('空记忆 / 空 keyFacts / 短文本 → 零冲突', () => {
    expect(detectRecapConflicts(null, recapWithFacts(['叶无痕已死']))).toHaveLength(0);
    const memory = memoryWithFacts(['叶无痕已死']);
    expect(detectRecapConflicts(memory, recapWithFacts([]))).toHaveLength(0);
    expect(detectRecapConflicts(memory, recapWithFacts(['短']))).toHaveLength(0);
  });

  it('不同主语（同名不重叠）→ 零冲突', () => {
    const memory = memoryWithFacts(['赵客已死']);
    const recap = recapWithFacts(['叶无痕复活']);
    expect(detectRecapConflicts(memory, recap)).toHaveLength(0);
  });
});

describe('detectLedgerCharacterConflicts', () => {
  it('账本记死 + 角色卡活跃 → info 提示（将静默覆盖）', () => {
    const memory = {
      pinnedFacts: [],
      openThreads: [],
      factLedger: {
        assertions: [
          {
            id: 'a1',
            kind: 'death',
            subject: '叶无痕',
            claim: '叶无痕已死',
            value: 'dead',
            sourceChapterNumber: 5,
            status: 'pinned',
            createdAt: new Date().toISOString(),
          },
        ],
      },
    } as StoryMemory;
    const chars = [{ id: 'c1', name: '叶无痕', status: '活跃' }] as Character[];
    const r = detectLedgerCharacterConflicts(memory, chars);
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('ledger_vs_character');
    expect(r[0].severity).toBe('info');
  });

  it('角色卡已阵亡 / 账本无死 → 零冲突', () => {
    const memory = {
      pinnedFacts: [],
      openThreads: [],
      factLedger: { assertions: [] },
    } as StoryMemory;
    const dead = [{ id: 'c1', name: '叶无痕', status: '已阵亡/退出' }] as Character[];
    expect(detectLedgerCharacterConflicts(memory, dead)).toHaveLength(0);
    const active = [{ id: 'c1', name: '叶无痕', status: '活跃' }] as Character[];
    expect(detectLedgerCharacterConflicts(memory, active)).toHaveLength(0);
  });

  it('空角色 / 无账本 → 零冲突', () => {
    expect(detectLedgerCharacterConflicts(null, [])).toHaveLength(0);
    expect(
      detectLedgerCharacterConflicts(
        { pinnedFacts: [], openThreads: [] },
        [{ id: 'c1', name: '叶无痕', status: '活跃' }] as Character[]
      )
    ).toHaveLength(0);
  });
});
