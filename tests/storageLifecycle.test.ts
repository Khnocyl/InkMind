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

const MIGRATE_MODE = { kind: 'ok' as 'ok' | 'throw' | 'stale-rev' };

vi.mock('../src/services/migrations', () => ({
  CURRENT_SCHEMA_VERSION: 1,
  peekMigration: () => ({
    fromVersion: 0,
    toVersion: 1,
    applied: ['stamp-schema-version-v1'],
    isFuture: false,
  }),
  migrateProjectToLatest: (project: { rev?: number }) => {
    if (MIGRATE_MODE.kind === 'throw') throw new Error('缺少迁移函数');
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
  initDB,
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
