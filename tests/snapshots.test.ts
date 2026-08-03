import { describe, it, expect } from 'vitest';
import {
  compressSnapshotJson,
  decompressSnapshotJson,
  readSnapshotProject,
  snapshotCapKey,
} from '../src/services/snapshots';
import type { BookProject } from '../src/types/novel';

function makeProject(title: string): BookProject {
  return {
    id: 'p-test',
    title,
    genre: '玄幻',
    wizardStep: 'ready',
    characters: [
      { id: 'c1', name: '叶无痕', status: '活跃', role: '主角' as const },
    ],
    settings: [],
    volumes: [],
    chapters: [
      {
        id: 'ch1',
        number: 1,
        title: '第一章',
        summary: '开场',
        content: '夜雨敲窗，烛火摇曳。'.repeat(200),
        status: '正文草稿',
      } as never,
    ],
    memory: {},
    config: { inspiration: '', genre: '玄幻', writingStyle: '' },
    styleConfig: {
      clicheBlacklist: [],
      customBlacklist: [],
      enforceShowDontTell: true,
      forbidEndingSublimation: true,
    },
    lastModified: new Date().toISOString(),
  } as unknown as BookProject;
}

describe('snapshot gzip 载荷', () => {
  it('compress → decompress 往返一致（中文长文本）', async () => {
    const project = makeProject('往返测试');
    const gz = await compressSnapshotJson(project);
    expect(gz.byteLength).toBeGreaterThan(0);
    const back = (await decompressSnapshotJson(gz)) as BookProject;
    expect(back.title).toBe('往返测试');
    expect(back.chapters[0].content).toBe(project.chapters[0].content);
  });

  it('中文文本压缩率显著（gzip 体积 < 原始 JSON 一半）', async () => {
    const project = makeProject('压缩率');
    const raw = new TextEncoder().encode(JSON.stringify(project)).byteLength;
    const gz = await compressSnapshotJson(project);
    // 中文重复正文压缩率应远超 2x；宽松断言避免环境差异误报
    expect(gz.byteLength).toBeLessThan(raw / 2);
  });

  it('gzip 后的字节 ≠ 原 JSON 字节（确实发生了编码）', async () => {
    const project = makeProject('编码检查');
    const raw = new TextEncoder().encode(JSON.stringify(project));
    const gz = new Uint8Array(await compressSnapshotJson(project));
    const same = raw.length === gz.length && raw.every((b, i) => b === gz[i]);
    expect(same).toBe(false);
  });
});

describe('readSnapshotProject 兼容 v1/v2', () => {
  it('v1（project 字段）直接返回，无需解压', async () => {
    const project = makeProject('v1');
    const snap = {
      id: 'snap-v1',
      projectId: 'p-test',
      createdAt: '2026-08-03T00:00:00.000Z',
      reason: 'manual' as const,
      label: '手动',
      chapterCount: 1,
      totalWords: 100,
      project,
    };
    expect(await readSnapshotProject(snap)).toBe(project);
  });

  it('v2（projectGz 字段）解压返回等价项目', async () => {
    const project = makeProject('v2');
    const snap = {
      id: 'snap-v2',
      projectId: 'p-test',
      createdAt: '2026-08-03T00:00:00.000Z',
      reason: 'manual' as const,
      label: '手动',
      chapterCount: 1,
      totalWords: 100,
      projectGz: await compressSnapshotJson(project),
    };
    const back = await readSnapshotProject(snap);
    expect(back?.title).toBe('v2');
    expect(back?.chapters[0].content).toBe(project.chapters[0].content);
  });

  it('双字段都有时优先 v1 project（迁移中的过渡态）', async () => {
    const project = makeProject('过渡');
    const snap = {
      id: 'snap-mix',
      projectId: 'p-test',
      createdAt: '2026-08-03T00:00:00.000Z',
      reason: 'manual' as const,
      label: '手动',
      chapterCount: 1,
      totalWords: 100,
      project,
      projectGz: await compressSnapshotJson({ title: '压缩版' }),
    };
    expect((await readSnapshotProject(snap))?.title).toBe('过渡');
  });

  it('无载荷返回 null', async () => {
    const snap = {
      id: 'snap-empty',
      projectId: 'p-test',
      createdAt: '2026-08-03T00:00:00.000Z',
      reason: 'manual' as const,
      label: '空',
      chapterCount: 0,
      totalWords: 0,
    };
    expect(await readSnapshotProject(snap)).toBeNull();
  });
});

describe('snapshotCapKey', () => {
  it('key 含 projectId 且稳定', () => {
    expect(snapshotCapKey('abc')).toBe('snapshot-cap:abc');
    expect(snapshotCapKey('abc')).not.toBe(snapshotCapKey('abd'));
  });
});
