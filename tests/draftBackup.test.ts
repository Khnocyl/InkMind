import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * draftBackup 依赖 IndexedDB（storage.initDB / STORE_META）。
 * 这里用 vi.mock 注入内存 meta store 桩，不引入 fake-indexeddb 依赖；
 * 每次 resetModules 后重新 import 获得干净的模块级去抖单例。
 */

// ── 内存 meta store 桩 ──
const memStore = new Map<string, unknown>();

function makeReq(compute: (req: { result?: unknown }) => void) {
  const req: {
    result?: unknown;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
    error: Error | null;
  } = {
    onsuccess: null,
    onerror: null,
    error: null,
  };
  let cb: (() => void) | null = null;
  Object.defineProperty(req, 'onsuccess', {
    get: () => cb,
    set: (v: (() => void) | null) => {
      cb = v;
      if (v) queueMicrotask(() => v());
    },
    configurable: true,
  });
  compute(req);
  return req;
}

vi.mock('../src/services/storage', () => ({
  STORE_META: 'meta',
  initDB: vi.fn(async () => ({
    transaction: () => ({
      objectStore: () => ({
        put: (rec: { key: string; value: unknown }) =>
          makeReq(() => {
            memStore.set(rec.key, rec.value);
          }),
        delete: (key: string) =>
          makeReq(() => {
            memStore.delete(key);
          }),
        getAll: () =>
          makeReq((req) => {
            req.result = [...memStore.entries()].map(([key, value]) => ({ key, value }));
          }),
      }),
    }),
  })),
}));

/** 取干净模块实例（隔离去抖单例） */
async function freshModule() {
  vi.resetModules();
  return await import('../src/services/draftBackup');
}

describe('saveDraftBackup / clearDraftBackup', () => {
  beforeEach(() => {
    memStore.clear();
  });

  it('空正文不写，避免覆盖有效备份', async () => {
    const m = await freshModule();
    await m.saveDraftBackup({
      projectId: 'p1',
      chapterId: 'c1',
      chapterNumber: 1,
      chapterTitle: '第一章',
      content: '   \n  ',
    });
    expect(memStore.size).toBe(0);
  });

  it('写入备份并计算去空白 wordCount', async () => {
    const m = await freshModule();
    await m.saveDraftBackup({
      projectId: 'p1',
      chapterId: 'c1',
      chapterNumber: 2,
      chapterTitle: '第二章',
      content: '夜雨敲窗，烛火摇曳。\n他缓缓起身。',
    });
    expect(memStore.size).toBe(1);
    const v = [...memStore.values()][0] as {
      wordCount: number;
      chapterNumber: number;
      chapterTitle: string;
    };
    // 去空白后：夜雨敲窗，烛火摇曳。他缓缓起身。 = 16 字
    expect(v.wordCount).toBe(16);
    expect(v.chapterNumber).toBe(2);
    expect(v.chapterTitle).toBe('第二章');
  });

  it('clearDraftBackup 仅清除目标章的键', async () => {
    const m = await freshModule();
    await m.saveDraftBackup({
      projectId: 'p1',
      chapterId: 'c1',
      chapterNumber: 1,
      chapterTitle: '一',
      content: '甲',
    });
    await m.saveDraftBackup({
      projectId: 'p1',
      chapterId: 'c2',
      chapterNumber: 2,
      chapterTitle: '二',
      content: '乙',
    });
    await m.clearDraftBackup('p1', 'c1');
    const all = await m.listDraftBackups();
    expect(all).toHaveLength(1);
    expect(all[0].chapterId).toBe('c2');
  });
});

describe('listDraftBackups', () => {
  beforeEach(() => {
    memStore.clear();
  });

  it('只返回 draft: 前缀条目（跳过其他 meta 键）', async () => {
    const m = await freshModule();
    memStore.set('other-key', { nope: true });
    await m.saveDraftBackup({
      projectId: 'p1',
      chapterId: 'c1',
      chapterNumber: 1,
      chapterTitle: '一',
      content: '正文甲',
    });
    const all = await m.listDraftBackups();
    expect(all).toHaveLength(1);
    expect(all[0].chapterId).toBe('c1');
  });

  it('过滤损坏/非草稿 value，避免旧脏数据炸列表', async () => {
    const m = await freshModule();
    memStore.set('draft:p1:c1', { content: 42 }); // 非法
    memStore.set('draft:p1:c2', 'plain string'); // 非法
    await m.saveDraftBackup({
      projectId: 'p1',
      chapterId: 'c3',
      chapterNumber: 3,
      chapterTitle: '三',
      content: '正常',
    });
    const all = await m.listDraftBackups();
    expect(all).toHaveLength(1);
    expect(all[0].chapterId).toBe('c3');
  });

  it('按 projectId 过滤，且按 updatedAt 倒序', async () => {
    const m = await freshModule();
    memStore.set('draft:p1:old', {
      projectId: 'p1',
      chapterId: 'old',
      chapterNumber: 1,
      chapterTitle: '旧',
      content: '旧稿',
      wordCount: 2,
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    memStore.set('draft:p1:new', {
      projectId: 'p1',
      chapterId: 'new',
      chapterNumber: 2,
      chapterTitle: '新',
      content: '新稿',
      wordCount: 2,
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    memStore.set('draft:p2:x', {
      projectId: 'p2',
      chapterId: 'x',
      chapterNumber: 1,
      chapterTitle: '别的书',
      content: 'x',
      wordCount: 1,
      updatedAt: '2026-08-02T00:00:00.000Z',
    });
    const p1 = await m.listDraftBackups('p1');
    expect(p1.map((d) => d.chapterId)).toEqual(['new', 'old']);
    const all = await m.listDraftBackups();
    expect(all).toHaveLength(3);
  });
});

describe('cleanupStaleDrafts', () => {
  beforeEach(() => {
    memStore.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00Z'));
  });

  it('超期草稿删除，新鲜草稿保留，返回清理数', async () => {
    const m = await freshModule();
    memStore.set('draft:p1:old', {
      projectId: 'p1',
      chapterId: 'old',
      chapterNumber: 1,
      chapterTitle: '旧',
      content: '旧稿',
      wordCount: 2,
      updatedAt: '2026-07-20T00:00:00.000Z', // 14 天前 > 7 天
    });
    memStore.set('draft:p1:fresh', {
      projectId: 'p1',
      chapterId: 'fresh',
      chapterNumber: 2,
      chapterTitle: '新',
      content: '新稿',
      wordCount: 2,
      updatedAt: '2026-08-03T06:00:00.000Z', // 6 小时前
    });
    const removed = await m.cleanupStaleDrafts();
    expect(removed).toBe(1);
    const left = await m.listDraftBackups();
    expect(left.map((d) => d.chapterId)).toEqual(['fresh']);
  });

  it('updatedAt 非法（NaN age）视为超期清理', async () => {
    const m = await freshModule();
    memStore.set('draft:p1:bad', {
      projectId: 'p1',
      chapterId: 'bad',
      chapterNumber: 1,
      chapterTitle: '坏',
      content: '坏稿',
      wordCount: 2,
      updatedAt: 'not-a-date',
    });
    const removed = await m.cleanupStaleDrafts();
    expect(removed).toBe(1);
  });
});

describe('scheduleDraftBackup / flushDraftBackup（去抖）', () => {
  beforeEach(() => {
    memStore.clear();
    vi.useFakeTimers();
  });

  it('连续调度只保留最后一次写入', async () => {
    const m = await freshModule();
    m.scheduleDraftBackup({
      projectId: 'p1',
      chapterId: 'c1',
      chapterNumber: 1,
      chapterTitle: '一',
      content: '第一版',
    });
    m.scheduleDraftBackup({
      projectId: 'p1',
      chapterId: 'c1',
      chapterNumber: 1,
      chapterTitle: '一',
      content: '最终版',
    });
    await vi.advanceTimersByTimeAsync(800);
    const all = await m.listDraftBackups();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe('最终版');
  });

  it('flushDraftBackup 立即冲刷未落盘调度', async () => {
    const m = await freshModule();
    m.scheduleDraftBackup({
      projectId: 'p1',
      chapterId: 'c1',
      chapterNumber: 1,
      chapterTitle: '一',
      content: '未到点',
    });
    await m.flushDraftBackup();
    const all = await m.listDraftBackups();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe('未到点');
    // 冲刷后 pending 清空，再 flush 无副作用
    await m.flushDraftBackup();
  });
});
