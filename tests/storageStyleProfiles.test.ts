/**
 * storage 层往返测试（R3 收尾 · 文风仿写丢失排查）
 *
 * 用 fake-indexeddb 模拟浏览器 IndexedDB，验证「保存 → 加载」往返
 * 不丢 styleConfig.styleProfiles / activeStyleProfileId（用户报：创建的
 * 文风仿写刷新后丢失）。此测试同时给 storage 主链路补上首个单测。
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach } from 'vitest';
import type { BookProject, StyleProfile } from '../src/types/novel';
import { saveProject, loadProject } from '../src/services/storage';
import { importStyleProfile } from '../src/services/styleImitate';
import { defaultStyleConfig } from '../src/mockData/initialBook';

function makeProject(overrides?: Partial<BookProject>): BookProject {
  const p: BookProject = {
    id: 'p-style-roundtrip',
    title: '文风往返测试书',
    genre: '玄幻',
    config: { genre: '玄幻', inspiration: '测试', writingStyle: '' },
    characters: [],
    settings: [],
    volumes: [],
    chapters: [],
    styleConfig: defaultStyleConfig,
    createdAt: '2026-08-03T00:00:00.000Z',
    createdDate: '2026-08-03',
    lastModified: '2026-08-03T00:00:00.000Z',
  };
  return { ...p, ...overrides };
}

const sampleProfile: StyleProfile = {
  id: 'prof-1',
  name: '金庸短句风',
  authorStyle: '利落短句，动作推进',
  styleGuide: '多用短句切断节奏，避免均匀长句。',
  fingerprint: {
    avgSentenceLen: 14,
    shortSentenceRatio: 0.42,
    dialogueRatio: 0.25,
    topPhrases: ['陡的', '当下'],
    sampleCount: 1,
  },
  sampleExcerpt: '寒光骤起！',
  sourceLabel: '粘贴样本',
  createdAt: '2026-08-03T00:00:00.000Z',
};

beforeEach(async () => {
  // 清空所有 store，避免用例间串数据
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('novel_studio_db', 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('snapshots')) {
        const s = d.createObjectStore('snapshots', { keyPath: 'id' });
        s.createIndex('by_project', 'projectId', { unique: false });
        s.createIndex('by_project_time', ['projectId', 'createdAt'], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const stores = ['projects', 'meta', 'snapshots'];
  for (const name of stores) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(name, 'readwrite');
      tx.objectStore(name).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  db.close();
});

describe('storage · 文风仿写往返', () => {
  it('导入档案 → save → load 往返后 styleProfiles 完整保留', async () => {
    // 模拟 StyleImitatePanel 的更新链：importStyleProfile 函数式更新
    const withProfile = importStyleProfile(defaultStyleConfig, sampleProfile, {
      activate: true,
      syncFewShot: true,
    });
    const project = makeProject({ styleConfig: withProfile });

    await saveProject(project);

    const loaded = await loadProject(project.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.styleConfig?.styleProfiles).toHaveLength(1);
    expect(loaded!.styleConfig?.styleProfiles?.[0].id).toBe('prof-1');
    expect(loaded!.styleConfig?.styleProfiles?.[0].name).toBe('金庸短句风');
    expect(loaded!.styleConfig?.activeStyleProfileId).toBe('prof-1');
    // 同步的 few-shot 卡片也在
    expect(
      loaded!.styleConfig?.fewShotExamples?.some((e) => e.id === 'few-style-prof-1')
    ).toBe(true);
  });

  it('多档案 + 切换激活后往返仍保留（激活 id 正确）', async () => {
    const second: StyleProfile = {
      ...sampleProfile,
      id: 'prof-2',
      name: '古龙冷峭风',
    };
    let sc = importStyleProfile(defaultStyleConfig, sampleProfile, { activate: true });
    sc = importStyleProfile(sc, second, { activate: true });
    // 切回第一个
    sc = { ...sc, activeStyleProfileId: 'prof-1' };

    const project = makeProject({ styleConfig: sc });
    await saveProject(project);
    const loaded = await loadProject(project.id);

    expect(loaded!.styleConfig?.styleProfiles?.map((p) => p.id)).toEqual([
      'prof-2',
      'prof-1',
    ]);
    expect(loaded!.styleConfig?.activeStyleProfileId).toBe('prof-1');
  });

  it('save 后立即 load（不等额外延迟）也不丢档案', async () => {
    const withProfile = importStyleProfile(defaultStyleConfig, sampleProfile);
    await saveProject(makeProject({ styleConfig: withProfile }));
    const loaded = await loadProject('p-style-roundtrip');
    expect(loaded!.styleConfig?.styleProfiles).toHaveLength(1);
  });
});
