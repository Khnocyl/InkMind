import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * draftBackup 依赖 IndexedDB（storage.initDB / STORE_META）。
 * 这里用 vi.mock 注入内存 meta store 桩，不引入 fake-indexeddb 依赖；
 * 每次 resetModules 后重新 import 获得干净的模块级去抖单例。
 */

// ── 内存 meta store 桩 ──
const memStore = new Map<string, unknown>();
/** 测试用闸门：非 null 时下一次 put 延迟到它 resolve 后才落盘（模拟慢写） */
let putGate: Promise<void> | null = null;
/** 剩余需要失败的 put 次数（模拟配额满 / 事务 abort） */
let putFailures = 0;

/**
 * cleanupStaleDrafts 抢救路径的可控状态。
 * 用 vi.hoisted：vi.mock 会被提升到模块顶部，工厂函数需能在模块初始化前引用到它。
 */
const rescueState = vi.hoisted(() => ({
  /** loadProject 的返回值；null 表示项目不存在（草稿直接清理） */
  project: null as unknown,
  /** 被抢救固化出来的快照（断言用） */
  snapshots: [] as { project: unknown; opts: unknown }[],
}));

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
  DRAFT_META_PREFIX: 'draft:',
  // cleanupStaleDrafts 的抢救路径要读项目判断草稿是否已被终稿覆盖
  loadProject: vi.fn(async () => rescueState.project),
  initDB: vi.fn(async () => ({
    transaction: () => {
      const tx = {
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        error: null as Error | null,
        _fire: () => queueMicrotask(() => tx.oncomplete?.()),
        objectStore: () => ({
          put: (rec: { key: string; value: unknown }) =>
            makeReq(() => {
              const apply = () => {
                if (putFailures > 0) {
                  putFailures -= 1;
                  tx.error = new Error('QuotaExceededError');
                  queueMicrotask(() => tx.onerror?.());
                  return;
                }
                memStore.set(rec.key, rec.value);
                tx._fire();
              };
              if (putGate) {
                const g = putGate;
                putGate = null;
                void g.then(apply);
              } else {
                apply();
              }
            }),
          delete: (key: string) =>
            makeReq(() => {
              memStore.delete(key);
              tx._fire();
            }),
          getAll: () =>
            makeReq((req) => {
              req.result = [...memStore.entries()].map(([key, value]) => ({ key, value }));
              tx._fire();
            }),
        }),
      };
      return tx;
    },
  })),
}));

/** 取干净模块实例（隔离去抖单例） */
async function freshModule() {
  vi.resetModules();
  return await import('../src/services/draftBackup');
}

// 抢救路径会把未覆盖草稿固化成快照；桩掉以避免引入真实 snapshots（其依赖真实 IndexedDB）
vi.mock('../src/services/snapshots', () => ({
  createSnapshot: vi.fn(async (project: unknown, opts: unknown) => {
    rescueState.snapshots.push({ project, opts });
    return { id: 'snap-1' };
  }),
}));
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
    rescueState.project = null;
    rescueState.snapshots.length = 0;
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

  it('草稿未被终稿覆盖 → 先固化成快照再删，绝不静默丢唯一副本', async () => {
    const m = await freshModule();
    memStore.set('draft:p1:lost', {
      projectId: 'p1',
      chapterId: 'lost',
      chapterNumber: 3,
      chapterTitle: '断章',
      content: '这是被中断的正文，磁盘上没有。',
      wordCount: 15,
      updatedAt: '2026-07-20T00:00:00.000Z', // 14 天前
    });
    // 项目存在但该章正文为空（草稿是唯一副本）
    rescueState.project = {
      id: 'p1',
      title: '测试书',
      chapters: [{ id: 'lost', number: 3, title: '断章', content: '', wordCount: 0 }],
    };

    const removed = await m.cleanupStaleDrafts();

    expect(removed).toBe(1);
    expect(rescueState.snapshots).toHaveLength(1);
    const opts = rescueState.snapshots[0].opts as { reason: string; label: string };
    expect(opts.reason).toBe('manual');
    expect(opts.label).toContain('草稿抢救');
    // 快照里应含草稿正文（否则"抢救"没有意义）
    const snapProject = rescueState.snapshots[0].project as {
      chapters: { id: string; content: string }[];
    };
    expect(snapProject.chapters.find((c) => c.id === 'lost')?.content).toBe(
      '这是被中断的正文，磁盘上没有。'
    );
    // 草稿本身已清掉
    expect(await m.listDraftBackups()).toHaveLength(0);
  });

  it('草稿已被终稿覆盖（终稿更长）→ 直接删，不产生快照', async () => {
    const m = await freshModule();
    memStore.set('draft:p1:done', {
      projectId: 'p1',
      chapterId: 'done',
      chapterNumber: 4,
      chapterTitle: '成章',
      content: '草稿的一半内容',
      wordCount: 7,
      updatedAt: '2026-07-20T00:00:00.000Z',
    });
    rescueState.project = {
      id: 'p1',
      title: '测试书',
      chapters: [
        {
          id: 'done',
          number: 4,
          title: '成章',
          content: '这是已经落盘的完整终稿，比草稿长得多，草稿已无保留价值。',
          wordCount: 26,
        },
      ],
    };

    const removed = await m.cleanupStaleDrafts();

    expect(removed).toBe(1);
    expect(rescueState.snapshots).toHaveLength(0);
  });

  it('抢救/固化失败 → 保留草稿（宁可多留也不丢）', async () => {
    const m = await freshModule();
    memStore.set('draft:p1:err', {
      projectId: 'p1',
      chapterId: 'err',
      chapterNumber: 5,
      chapterTitle: '异常',
      content: '内容',
      wordCount: 2,
      updatedAt: '2026-07-20T00:00:00.000Z',
    });
    // 项目能读到、但章节未覆盖 → 走 createSnapshot；让它抛错
    rescueState.project = {
      id: 'p1',
      title: '测试书',
      chapters: [{ id: 'err', number: 5, title: '异常', content: '', wordCount: 0 }],
    };
    const snapMod = await import('../src/services/snapshots');
    (snapMod.createSnapshot as unknown as { mockRejectedValueOnce: (e: unknown) => void })
      .mockRejectedValueOnce(new Error('配额满'));

    const removed = await m.cleanupStaleDrafts();

    expect(removed).toBe(0);
    expect(await m.listDraftBackups()).toHaveLength(1);
  });

  it('读取项目抛错（迁移/事务故障）≠ 项目已删 → 保留草稿', async () => {
    const m = await freshModule();
    memStore.set('draft:p1:loadfail', {
      projectId: 'p1',
      chapterId: 'loadfail',
      chapterNumber: 6,
      chapterTitle: '读失败',
      content: '唯一副本',
      wordCount: 4,
      updatedAt: '2026-07-20T00:00:00.000Z',
    });
    const storageMod = await import('../src/services/storage');
    (storageMod.loadProject as unknown as { mockRejectedValueOnce: (e: unknown) => void })
      .mockRejectedValueOnce(new Error('迁移失败'));

    const removed = await m.cleanupStaleDrafts();

    // 关键：读取失败不能当成"项目已删"而清稿
    expect(removed).toBe(0);
    expect(await m.listDraftBackups()).toHaveLength(1);
  });
});

describe('scheduleDraftBackup / flushDraftBackup（去抖）', () => {
  beforeEach(() => {
    memStore.clear();
    putFailures = 0;
    putGate = null;
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

  it('持续流式（chunk 间隔 < 去抖窗口）也必须周期性落盘，不能无限推后', async () => {
    const m = await freshModule();
    // 模拟约 120ms 一个 chunk 的流畅流式，共 3.6s —— 全程没有 800ms 的空隙。
    // 旧实现是纯尾沿去抖：每次 schedule 都 clearTimeout 重置，草稿一条都不会落盘，
    // 崩溃保护在最需要它的窗口里恰好失效。
    for (let i = 0; i < 30; i += 1) {
      m.scheduleDraftBackup({
        projectId: 'p1',
        chapterId: 'c1',
        chapterNumber: 1,
        chapterTitle: '一',
        content: `第 ${i} 段正文`,
      });
      await vi.advanceTimersByTimeAsync(120);
    }
    const all = await m.listDraftBackups();
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it('短促突发仍被合并（maxWait 不破坏去抖本意）', async () => {
    const m = await freshModule();
    for (let i = 0; i < 4; i += 1) {
      m.scheduleDraftBackup({
        projectId: 'p1',
        chapterId: 'c1',
        chapterNumber: 1,
        chapterTitle: '一',
        content: `v${i}`,
      });
      await vi.advanceTimersByTimeAsync(100); // 合计 400ms < MAX_WAIT
    }
    await vi.advanceTimersByTimeAsync(800); // 触发尾沿
    const all = await m.listDraftBackups();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe('v3'); // 只写最新一版
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

  it('写入进行中再次 flush → 重新调度，最后的草稿不会滞留内存', async () => {
    const m = await freshModule();
    let release!: () => void;
    putGate = new Promise<void>((r) => {
      release = r;
    });
    m.scheduleDraftBackup({
      projectId: 'p1',
      chapterId: 'c1',
      chapterNumber: 1,
      chapterTitle: '一',
      content: '第一版',
    });
    void m.flushDraftBackup(); // 第一次写被闸门挂住（saving = true）
    m.scheduleDraftBackup({
      projectId: 'p1',
      chapterId: 'c1',
      chapterNumber: 1,
      chapterTitle: '一',
      content: '最终版',
    });
    // 写入仍在进行时再 flush：此前只保留 pending、不再调度 → 最终版永远不落盘
    void m.flushDraftBackup();
    release();
    await vi.advanceTimersByTimeAsync(800);
    const all = await m.listDraftBackups();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe('最终版');
  });

  it('写失败后自动重挂定时器重试，最后的草稿不丢（防配额满时崩溃丢稿）', async () => {
    const m = await freshModule();
    putFailures = 1; // 第一次写失败（模拟 QuotaExceededError）
    m.scheduleDraftBackup({
      projectId: 'p1',
      chapterId: 'c1',
      chapterNumber: 1,
      chapterTitle: '一',
      content: '崩溃前的最后一段正文',
    });
    // 第一次尝试（800ms 去抖）→ 失败
    await vi.advanceTimersByTimeAsync(800);
    expect(memStore.size).toBe(0);
    // 失败后必须重新挂上定时器（退避 1.6s）；若只保留 pending 不调度，
    // 这段草稿会一直躺在内存里直到 pagehide —— 期间崩溃即永久丢失
    await vi.advanceTimersByTimeAsync(1600);
    const all = await m.listDraftBackups();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe('崩溃前的最后一段正文');
  });
});
