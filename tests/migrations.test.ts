import { describe, it, expect, afterEach } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  migrateProjectToLatest,
} from '../src/services/migrations';
import type { BookProject } from '../src/types/novel';

function makeProject(overrides: Partial<BookProject> = {}): BookProject {
  return {
    id: 'p-mig',
    title: '迁移测试',
    subtitle: '',
    genre: '玄幻',
    synopsis: '',
    lastModified: new Date().toISOString(),
    wizardStep: 'ready',
    config: { inspiration: '', genre: '玄幻', writingStyle: '' },
    characters: [],
    settings: [],
    volumes: [],
    chapters: [],
    styleConfig: {
      clicheBlacklist: [],
      customBlacklist: [],
      enforceShowDontTell: true,
      forbidEndingSublimation: true,
    },
    ...overrides,
  };
}

describe('migrateProjectToLatest', () => {
  it('无 schemaVersion 的存量数据 → 迁移到最新并打上版本号', () => {
    const r = migrateProjectToLatest(makeProject());
    expect(r.applied).toHaveLength(1);
    expect(r.fromVersion).toBe(0);
    expect(r.toVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(r.project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(r.applied[0].name).toBe('stamp-schema-version-v1');
  });

  it('已是最新版本 → 原样返回，applied 为空', () => {
    const p = makeProject({ schemaVersion: CURRENT_SCHEMA_VERSION });
    const r = migrateProjectToLatest(p);
    expect(r.applied).toHaveLength(0);
    expect(r.project).toBe(p); // 同一引用，零改动
  });

  it('版本超前（未来数据）→ 不迁移、不降级', () => {
    const p = makeProject({ schemaVersion: 99 });
    const r = migrateProjectToLatest(p);
    expect(r.applied).toHaveLength(0);
    expect(r.project).toBe(p);
    expect(r.project.schemaVersion).toBe(99);
  });

  it('非法 schemaVersion（负数/NaN/字符串）→ 按 0 处理', () => {
    const r1 = migrateProjectToLatest(makeProject({ schemaVersion: -3 as never }));
    expect(r1.fromVersion).toBe(0);
    const r2 = migrateProjectToLatest(
      makeProject({ schemaVersion: 'abc' as never })
    );
    expect(r2.fromVersion).toBe(0);
    expect(r2.project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('迁移保持其余字段不变（纯变换）', () => {
    const p = makeProject({
      title: '保持书名',
      chapters: [{ id: 'c1', number: 1 } as never],
    });
    const r = migrateProjectToLatest(p);
    expect(r.project.title).toBe('保持书名');
    expect(r.project.chapters).toHaveLength(1);
    expect(r.project.id).toBe('p-mig');
  });
});

describe('migrateProjectToLatest · 迁移必须推进 schemaVersion（防重复迁移）', () => {
  const originalV0 = MIGRATIONS[0];
  afterEach(() => {
    MIGRATIONS[0] = originalV0;
  });

  it('迁移函数忘记推进 schemaVersion → 抛错而不是静默返回', () => {
    // 危险场景：迁移只改字段、漏写 schemaVersion。若不拦，项目会带旧版本号落盘，
    // 于是每次加载都重跑这条迁移；非幂等的迁移（重命名/拆分合并）会逐次累积损坏数据。
    MIGRATIONS[0] = {
      name: 'bad-no-version-bump',
      fn: (p) => ({ ...p, title: '被改过' }),
    };
    expect(() => migrateProjectToLatest(makeProject())).toThrow(/未把 schemaVersion 推进/);
  });

  it('迁移把版本号推进过头（跳过一级）同样抛错', () => {
    MIGRATIONS[0] = {
      name: 'bad-overshoot',
      fn: (p) => ({ ...p, schemaVersion: CURRENT_SCHEMA_VERSION + 5 }),
    };
    expect(() => migrateProjectToLatest(makeProject())).toThrow(/未把 schemaVersion 推进/);
  });
});
