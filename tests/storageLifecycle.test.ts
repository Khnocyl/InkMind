/**
 * 项目生命周期与存储韧性（真实 fake-indexeddb）：
 * - 删除项目级联清理 draft:* / snapshot-cap:* / snapshots / active_project_id；
 * - 快照裁剪尊重项目级上限，且永不淘汰 migration / pre_restore 安全快照；
 * - loadProject 面对损坏行 / 迁移抛错 / 迁移回写失败都不再让书「打不开」。
 *
 * migrations 被 mock，用来构造「迁移函数抛错」和「迁移回写触发跨页冲突」两条路径。
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MIGRATE_MODE = { kind: 'ok' as 'ok' | 'throw' | 'stale-rev' | 'peek-throw' };

vi.mock('../src/services/migrations', () => ({
  CURRENT_SCHEMA_VERSION: 1,
  // 贴近真实实现：schemaVersion 缺省=0 需迁移；>=1 视为已最新；>1 为降级（future）。
  // peek-throw 模拟「缺少迁移函数」——真实 peekMigration 在这条路径上会抛错。
  peekMigration: (project: { schemaVersion?: number }) => {
    if (MIGRATE_MODE.kind === 'peek-throw') throw new Error('缺少迁移函数');
    const from = project?.schemaVersion ?? 0;
    if (from >= 1) {
      return { fromVersion: from, toVersion: from, applied: [], isFuture: from > 1 };
    }
    return {
      fromVersion: 0,
      toVersion: 1,
      applied: ['stamp-schema-version-v1'],
      isFuture: false,
    };
  },
  migrateProjectToLatest: (project: { rev?: number; schemaVersion?: number }) => {
    if (MIGRATE_MODE.kind === 'throw') throw new Error('缺少迁移函数');
    const from = project?.schemaVersion ?? 0;
    // 降级：不迁移、原样返回
    if (from >= 1) {
      return { project, fromVersion: from, toVersion: from, applied: [] };
    }
    return {
      project: {
        ...project,
        schemaVersion: 1,
        // stale-rev：返回比库中更低的 rev，让回写触发 ProjectConflictError
        ...(MIGRATE_MODE.kind === 'stale-rev' ? { rev: 1 } : {}),
      },
      fromVersion: 0,
      toVersion: 1,
      applied: [{ from: 0, to: 1, name: 'stamp-schema-version-v1', at: 'x' }],
    };
  },
}));

import {
  deleteProject,
  getAllProjects,
  initDB,
  invalidateProjectListCache,
  loadProject,
  saveProject,
  setActiveProjectId,
  STORE_PROJECTS_NAME,
} from '../src/services/storage';
import {
  createSnapshot,
  getSnapshotCap,
  listSnapshots,
  setSnapshotCap,
} from '../src/services/snapshots';
import { saveDraftBackup, listDraftBackups } from '../src/services/draftBackup';
import type { BookProject } from '../src/types/novel';

function makeProject(id = 'p-life', overrides?: Partial<BookProject>): BookProject {
  return {
    id,
    title: `书-${id}`,
    genre: '玄幻',
    config: { genre: '玄幻', inspiration: '', writingStyle: '' },
    characters: [],
    settings: [],
    volumes: [],
    chapters: [],
    createdAt: '2026-08-03T00:00:00.000Z',
    createdDate: '2026-08-03',
    lastModified: '2026-08-03T00:00:00.000Z',
    ...overrides,
  } as unknown as BookProject;
}

/** 直接写一行原始数据（绕过 saveProject 的 rev 自增），用于构造损坏/高 rev 场景 */
async function rawPut(row: unknown): Promise<void> {
  const db = await initDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS_NAME, 'readwrite');
    tx.objectStore(STORE_PROJECTS_NAME).put(row as never);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

beforeEach(() => {
  MIGRATE_MODE.kind = 'ok';
});

describe('deleteProject · 级联清理', () => {
  it('清理项目行、快照、草稿备份、快照上限与激活标记', async () => {
    const p = makeProject('p-del');
    await saveProject(p);
    await setActiveProjectId(p.id);
    await createSnapshot(p, { reason: 'manual' });
    await setSnapshotCap(p.id, 50);
    await saveDraftBackup({
      projectId: p.id,
      chapterId: 'ch1',
      chapterNumber: 1,
      chapterTitle: '第一章',
      content: '未完成的流式草稿正文',
    });
    // 另一本书的数据必须保留
    await saveDraftBackup({
      projectId: 'p-keep',
      chapterId: 'ch1',
      chapterNumber: 1,
      chapterTitle: '第一章',
      content: '别的书的草稿',
    });
    await saveProject(makeProject('p-keep'));

    await deleteProject(p.id);

    expect(await loadProject(p.id)).toBeNull();
    expect(await listSnapshots(p.id)).toHaveLength(0);
    expect(await listDraftBackups(p.id)).toHaveLength(0);
    expect(await getSnapshotCap(p.id)).toBeNull();
    // 其他项目不受影响
    expect(await listDraftBackups('p-keep')).toHaveLength(1);
    expect(await loadProject('p-keep')).not.toBeNull();
  });
});

describe('pruneSnapshots · 上限与安全快照保护', () => {
  it('尊重项目级上限，且 migration / pre_restore 永不被裁剪', async () => {
    const p = makeProject('p-prune');
    await saveProject(p);
    await setSnapshotCap(p.id, 2);

    await createSnapshot(p, { reason: 'migration', prune: false, label: '迁移前备份' });
    await createSnapshot(p, { reason: 'pre_restore', prune: false, label: '回滚前备份' });
    for (let i = 0; i < 4; i += 1) {
      await createSnapshot(p, { reason: 'manual', label: `手动 ${i}` });
    }

    const rows = await listSnapshots(p.id);
    const reasons = rows.map((r) => r.reason);
    expect(reasons).toContain('migration');
    expect(reasons).toContain('pre_restore');
    // 普通快照受上限约束（2 条），安全快照额外保留
    expect(reasons.filter((r) => r === 'manual')).toHaveLength(2);
    expect(rows).toHaveLength(4);
  });
});

describe('saveProject · rev 提交语义', () => {
  it('成功保存后 rev 自增，且返回值与内存对象一致', async () => {
    const p = makeProject('p-rev-ok');
    expect(await saveProject(p)).toBe(1);
    expect(p.rev).toBe(1);
    expect(await saveProject(p)).toBe(2);
    expect(p.rev).toBe(2);
  });

  it('提交失败时不得推进内存 rev（否则下次冲突判定失效 → 静默覆盖他人写入）', async () => {
    const p = makeProject('p-rev-fail');
    await saveProject(p);
    const revBefore = p.rev;
    // 注入不可结构化克隆的字段 → put 抛 DataCloneError（模拟 commit 阶段失败）。
    // 旧实现先 `project.rev = existingRev + 1` 再 put，失败后内存 rev 已前进、
    // 磁盘未变，下次保存的 existingRev > callerRev 判定会失效。
    (p as unknown as { bad?: unknown }).bad = () => {};
    await expect(saveProject(p)).rejects.toBeTruthy();
    expect(p.rev).toBe(revBefore);
  });
});

describe('loadProject · 韧性', () => {
  it('迁移函数抛错 → 原数据仍可加载（不再整书打不开）', async () => {
    const p = makeProject('p-migrate-throw');
    await saveProject(p);
    MIGRATE_MODE.kind = 'throw';

    const loaded = await loadProject(p.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.title).toBe(p.title);
  });

  it('迁移结果回写失败（跨页冲突）→ 仍返回迁移后数据', async () => {
    const p = makeProject('p-migrate-conflict');
    await saveProject(p);
    // 库中 rev 抬到 5，迁移函数返回 rev=1 → saveProject 触发 ProjectConflictError
    await rawPut({ ...p, rev: 5 });
    MIGRATE_MODE.kind = 'stale-rev';

    const loaded = await loadProject(p.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.schemaVersion).toBe(1);
  });
});

describe('getAllProjects · 书库摘要', () => {
  it('拆书模板书（带 deconstructMeta）在摘要里标记 isDeconstruct', async () => {
    await saveProject(
      makeProject('p-normal', { title: '普通书' })
    );
    await saveProject(
      makeProject('p-decon', {
        title: '模板书',
        deconstructMeta: {
          source: 'file',
          sourceName: '源.txt',
          importedAt: '2026-09-13T00:00:00.000Z',
          synthesisDone: true,
        },
      })
    );
    invalidateProjectListCache();

    const list = await getAllProjects();
    const byId = new Map(list.map((p) => [p.id, p]));
    expect(byId.get('p-decon')?.isDeconstruct).toBe(true);
    expect(byId.get('p-normal')?.isDeconstruct).toBe(false);
  });
});

describe('迁移/降级保护快照 · 幂等', () => {
  /** 模拟「另一次会话」：清掉模块级「已建快照」记忆，强制走磁盘去重判定 */
  async function loadInFreshSession(id: string) {
    vi.resetModules();
    const storage = await import('../src/services/storage');
    return storage.loadProject(id);
  }

  it('迁移落盘持续失败 → 每次加载不重复建迁移快照（防体积死循环增长）', async () => {
    const p = makeProject('p-mig-dedup');
    await saveProject(p);
    // 库中 rev 抬到 5：迁移回写永远冲突，磁盘始终停留在旧 schema，
    // 于是每次加载都会重新进入迁移分支——这正是体积爆炸的触发条件。
    await rawPut({ ...p, rev: 5 });
    MIGRATE_MODE.kind = 'stale-rev';

    for (let i = 0; i < 3; i += 1) {
      await loadInFreshSession(p.id);
    }

    const rows = await listSnapshots(p.id);
    expect(rows.filter((r) => r.reason === 'migration')).toHaveLength(1);
  });

  it('缺少迁移函数（预检抛错）→ 仍建立保护快照', async () => {
    const p = makeProject('p-mig-peekthrow');
    await saveProject(p);
    MIGRATE_MODE.kind = 'peek-throw';

    await loadInFreshSession(p.id);

    const rows = await listSnapshots(p.id);
    expect(rows.filter((r) => r.reason === 'migration')).toHaveLength(1);
  });

  it('降级（schema 超前）→ 建立保护快照且不重复创建', async () => {
    const p = makeProject('p-mig-future');
    // schemaVersion=99 高于代码支持的 v1 → isFuture，loadProject 不迁移
    await rawPut({ ...p, schemaVersion: 99, rev: 1 });
    MIGRATE_MODE.kind = 'ok';

    await loadInFreshSession(p.id);
    await loadInFreshSession(p.id);

    const rows = await listSnapshots(p.id);
    expect(rows.filter((r) => r.reason === 'migration')).toHaveLength(1);
    // 降级保护快照必须 pinned（永不裁剪）：塞满普通快照后它仍应在
    for (let i = 0; i < 35; i += 1) {
      await createSnapshot(makeProject(p.id), { reason: 'manual', label: `填充 ${i}` });
    }
    const after = await listSnapshots(p.id);
    expect(after.some((r) => r.reason === 'migration')).toBe(true);
  });
});
