import { describe, it, expect } from 'vitest';
import {
  sanitizeProjectForExport,
  normalizeImportedProject,
} from '../src/services/projectTransfer';
import { DECONSTRUCT_SCHEMA_VERSION } from '../src/services/bookDeconstruct';
import { getDefaultStyleConfig } from '../src/services/storage';
import type { BookProject } from '../src/types/novel';

/** 一本最小可用的拆书模板书（章节全锁 + deconstructMeta + 逐章拆解数据） */
function templateBook(): BookProject {
  return {
    id: 'proj-dec-1',
    title: '测试模板书',
    genre: '东方玄幻',
    synopsis: '一句话主线',
    createdAt: '2026-09-13T00:00:00.000Z',
    lastModified: '2026-09-13T00:00:00.000Z',
    wizardStep: 'ready',
    config: {
      inspiration: '灵感',
      genre: '东方玄幻',
      targetChapterCount: 2,
      targetWordCountPerChapter: 2000,
      writingStyle: '克制',
      customParameters: {},
    },
    styleConfig: getDefaultStyleConfig(),
    characters: [
      {
        id: 'c1',
        name: '张三',
        alias: '',
        role: '主角',
        status: '活跃',
        realmOrTitle: '炼气',
        currentLocation: '',
        personality: '坚韧',
        appearance: '',
        background: '',
        relations: [{ targetId: 'c2', relation: '师徒', intimacy: 60 }],
        secretNotes: '',
      },
    ],
    settings: [],
    volumes: [],
    chapters: [
      {
        id: 'ch1',
        number: 1,
        title: '第一章 开局',
        summary: '开局梗概',
        wordCount: 2000,
        status: '精修定稿',
        content: '正文一',
        involvedCharacterIds: ['c1'],
        involvedSettingIds: [],
        beats: [],
        locked: true,
        deconstruct: {
          hookType: '悬念',
          hookStrength: 6,
          payoffType: '无',
          emotion: 7,
          foreshadowPlant: ['一枚玉佩'],
          foreshadowPayoff: [],
          newSettings: ['灵根'],
          characterNames: ['张三'],
          analyzedAt: '2026-09-13T01:00:00.000Z',
          v: DECONSTRUCT_SCHEMA_VERSION,
        },
      },
      {
        id: 'ch2',
        number: 2,
        title: '第二章 转折',
        summary: '转折梗概',
        wordCount: 2100,
        status: '精修定稿',
        content: '正文二',
        involvedCharacterIds: [],
        involvedSettingIds: [],
        beats: [],
        locked: true,
        // 旧版逐章数据：没有 v / emotion，导入后应原样保留（可被「补齐」识别）
        deconstruct: { hookType: '反转', hookStrength: 4, payoffType: '打脸' },
      },
    ],
    deconstructMeta: {
      source: 'file',
      sourceName: '书.txt',
      importedAt: '2026-09-13T00:30:00.000Z',
      synthesisDone: true,
    },
  };
}

describe('projectTransfer · 拆书数据往返', () => {
  it('导出包带出 deconstruct 与 deconstructMeta（否则「完整恢复」无从谈起）', () => {
    const clean = sanitizeProjectForExport(templateBook());
    expect(clean.chapters[0].deconstruct?.emotion).toBe(7);
    expect(clean.deconstructMeta?.sourceName).toBe('书.txt');
  });

  it('导入解析保留逐章 deconstruct（含 emotion/伏笔/人物名）与 deconstructMeta', () => {
    const bundle = sanitizeProjectForExport(templateBook());
    const { project } = normalizeImportedProject(bundle);

    const d1 = project.chapters[0].deconstruct;
    expect(d1).toBeDefined();
    expect(d1?.emotion).toBe(7);
    expect(d1?.hookStrength).toBe(6);
    expect(d1?.foreshadowPlant).toEqual(['一枚玉佩']);
    expect(d1?.characterNames).toEqual(['张三']);
    expect(d1?.v).toBe(DECONSTRUCT_SCHEMA_VERSION);
    // 旧版数据也要留下（不能补成新值，否则「补齐」判据失效）
    expect(project.chapters[1].deconstruct?.hookType).toBe('反转');
    expect(project.chapters[1].deconstruct?.emotion).toBeUndefined();
    // 没有它，书库的「已完成的拆解」入口会消失
    expect(project.deconstructMeta).toMatchObject({
      source: 'file',
      sourceName: '书.txt',
      importedAt: '2026-09-13T00:30:00.000Z',
      synthesisDone: true,
    });
  });

  it('导入时收敛越界值，不信任外部 JSON', () => {
    const raw = templateBook();
    const ch1 = raw.chapters[0];
    ch1.deconstruct = { ...ch1.deconstruct, emotion: 999, hookStrength: -5 };
    const { project } = normalizeImportedProject(raw);
    expect(project.chapters[0].deconstruct?.emotion).toBe(9);
    expect(project.chapters[0].deconstruct?.hookStrength).toBe(0);
  });

  it('普通书（无 deconstructMeta / 无 deconstruct）不被误标成模板书', () => {
    const raw = templateBook();
    delete raw.deconstructMeta;
    raw.chapters = raw.chapters.map((c) => {
      const { deconstruct, ...rest } = c;
      void deconstruct;
      return rest as typeof c;
    });
    const { project } = normalizeImportedProject(raw);
    expect(project.deconstructMeta).toBeUndefined();
    expect(project.chapters.every((c) => c.deconstruct === undefined)).toBe(true);

    // 缺 importedAt 的 meta 不可信（不能让任意 JSON 造出「这是模板书」的标记）
    const raw2 = templateBook();
    raw2.deconstructMeta = { ...raw2.deconstructMeta!, importedAt: '' };
    expect(normalizeImportedProject(raw2).project.deconstructMeta).toBeUndefined();
  });
});
