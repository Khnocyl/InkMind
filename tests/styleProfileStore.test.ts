import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StyleProfile } from '../src/types/novel';
import {
  clearGlobalStyleProfiles,
  loadGlobalStyleProfiles,
  mergeWizardStyleProfiles,
  removeGlobalStyleProfile,
  upsertGlobalStyleProfiles,
} from '../src/services/styleProfileStore';

function makeProfile(id: string, name: string): StyleProfile {
  return {
    id,
    name,
    fingerprint: {
      avgSentenceLen: 12,
      shortSentenceRatio: 0.4,
      dialogueRatio: 0.3,
      charCount: 800,
    },
    styleGuide: `${name} 指南`,
    doList: ['短句'],
    dontList: ['套话'],
    authorStyle: `${name} 文风`,
    sampleExcerpt: `${name} 摘录`,
    analysis: `${name} 解构`,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  };
}

function mockLocalStorage() {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal('localStorage', storage);
  return storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('styleProfileStore · 全局文风档案库', () => {
  it('upsert 新增 → load 读回', () => {
    mockLocalStorage();
    upsertGlobalStyleProfiles([makeProfile('p1', '冷峻风')]);
    const all = loadGlobalStyleProfiles();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('冷峻风');
  });

  it('同 id upsert 覆盖而非重复', () => {
    mockLocalStorage();
    upsertGlobalStyleProfiles([makeProfile('p1', '旧')]);
    upsertGlobalStyleProfiles([makeProfile('p1', '新')]);
    const all = loadGlobalStyleProfiles();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('新');
  });

  it('remove 删除指定档案', () => {
    mockLocalStorage();
    upsertGlobalStyleProfiles([makeProfile('p1', 'a'), makeProfile('p2', 'b')]);
    removeGlobalStyleProfile('p1');
    const all = loadGlobalStyleProfiles();
    expect(all.map((p) => p.id)).toEqual(['p2']);
  });

  it('mergeWizardStyleProfiles：本书优先，全局补充，id 去重', () => {
    mockLocalStorage();
    upsertGlobalStyleProfiles([makeProfile('g1', '全局A'), makeProfile('g2', '全局B')]);
    // 本书也含 g1（同 id）→ 用本书版本且标 local
    const book = [makeProfile('g1', '本书A'), makeProfile('b1', '本书B')];
    const merged = mergeWizardStyleProfiles(book);
    expect(merged).toHaveLength(3); // b1(local), g1(local), g2(global)
    const g1 = merged.find((x) => x.profile.id === 'g1')!;
    expect(g1.source).toBe('local');
    expect(g1.profile.name).toBe('本书A'); // 本书优先
    const g2 = merged.find((x) => x.profile.id === 'g2')!;
    expect(g2.source).toBe('global');
  });

  it('mergeWizardStyleProfiles：无本书档案时全部来自全局', () => {
    mockLocalStorage();
    upsertGlobalStyleProfiles([makeProfile('g1', '全局A')]);
    const merged = mergeWizardStyleProfiles(undefined);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('global');
  });

  it('clear 清空全局库', () => {
    mockLocalStorage();
    upsertGlobalStyleProfiles([makeProfile('p1', 'a')]);
    clearGlobalStyleProfiles();
    expect(loadGlobalStyleProfiles()).toHaveLength(0);
  });

  it('损坏的 localStorage 数据 → 返回空数组不抛错', () => {
    mockLocalStorage();
    const storage = globalThis.localStorage as Storage;
    storage.setItem('novel_studio_global_style_profiles_v1', '{bad json');
    expect(loadGlobalStyleProfiles()).toEqual([]);
  });
});
