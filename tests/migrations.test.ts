import { describe, it, expect } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
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
