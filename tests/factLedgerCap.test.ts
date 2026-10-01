/**
 * 账本活跃上限（`MAX_ACTIVE = 120`）的淘汰策略回归守卫。
 *
 * 背景：上限淘汰时按 kind 排序（death > item_owner > character_status > 其它），
 * 而**手动钉死的条目**唯一的标记是 `note === 'manual'`（FactAssertion 没有专门的
 * pinned 字段）。此前 rank 只看 kind，于是：
 *   1. 用户手钉的 `kind:'other'` 条目会被自动抽取的 death/item_owner 悄悄挤掉；
 *   2. 淘汰时 note 被整条覆盖为 `'[账本上限归档]'` —— 连「这条是手动钉的」都查不到，
 *      而且本路径**并不写摘要**（factLedger 完全不碰 spanDigests），措辞是误导。
 */
import { describe, expect, it } from 'vitest';
import {
  addManualAssertion,
  mergeSnapshotIntoLedger,
  normalizeFactLedger,
} from '../src/services/factLedger';
import type { ChapterFactSnapshot, StoryMemory } from '../src/types/novel';

function snapshot(n: number, kind: 'event' | 'death' | 'item_owner'): ChapterFactSnapshot {
  return {
    chapterNumber: n,
    extractedAt: new Date().toISOString(),
    source: 'heuristic',
    summary: `第${n}章`,
    assertions: [
      {
        id: `a-${kind}-${n}`,
        kind,
        subject: `主体${n}`,
        claim: `第${n}章断言（${kind}）`,
        sourceChapterNumber: n,
        createdAt: new Date().toISOString(),
        status: 'active',
      },
    ],
  } as unknown as ChapterFactSnapshot;
}

function ledgerOf(memory: StoryMemory | null | undefined) {
  return memory?.factLedger;
}

describe('factLedger · 活跃上限淘汰策略', () => {
  it('手动钉死的条目不被自动抽取的条目挤掉（即使 kind 优先级最低）', () => {
    // 先手钉 5 条 kind:'event'（rank 最低）
    let mem: StoryMemory | null = null;
    for (let i = 1; i <= 5; i += 1) {
      mem = addManualAssertion(mem, {
        kind: 'event',
        subject: `手钉${i}`,
        claim: `手动钉死的事实 ${i}`,
        chapterNumber: 1,
      });
    }
    const manualIds = (ledgerOf(mem)?.assertions || [])
      .filter((a) => a.note === 'manual')
      .map((a) => a.id);
    expect(manualIds).toHaveLength(5);

    // 再灌入大量高优先级的 death 断言，把活跃数顶到上限以上
    let ledger = ledgerOf(mem)!;
    for (let n = 1; n <= 130; n += 1) {
      ledger = mergeSnapshotIntoLedger(ledger, snapshot(n, 'death'));
    }
    const active = ledger.assertions.filter((a) => a.status === 'active');
    expect(active.length).toBeLessThanOrEqual(120);
    // 关键不变量：5 条手动条目必须**全部仍在 active**
    for (const id of manualIds) {
      const a = ledger.assertions.find((x) => x.id === id);
      expect(a, `手动条目 ${id} 被淘汰了`).toBeDefined();
      expect(a!.status, `手动条目 ${id} 被淘汰了`).toBe('active');
    }
  });

  it('淘汰 note 保留原标记、且不谎称「归档」', () => {
    let ledger = normalizeFactLedger(null);
    for (let n = 1; n <= 140; n += 1) {
      ledger = mergeSnapshotIntoLedger(ledger, snapshot(n, 'event'));
    }
    const evicted = ledger.assertions.filter(
      (a) => a.status === 'superseded' && a.note?.includes('账本上限')
    );
    expect(evicted.length).toBeGreaterThan(0);
    for (const a of evicted) {
      // 不再出现「归档」这种本路径做不到的措辞
      expect(a.note).not.toContain('归档');
      expect(a.note).toContain('淘汰');
    }
  });

  it('上限内不触发淘汰（不误伤）', () => {
    let ledger = normalizeFactLedger(null);
    for (let n = 1; n <= 10; n += 1) {
      ledger = mergeSnapshotIntoLedger(ledger, snapshot(n, 'event'));
    }
    expect(ledger.assertions.every((a) => a.status === 'active')).toBe(true);
    expect(ledger.assertions.some((a) => a.note?.includes('账本上限'))).toBe(false);
  });
});
