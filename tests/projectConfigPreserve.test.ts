/**
 * ProjectConfig 重建路径的字段保全单测。
 *
 * 背景（两条静默丢设置的路径）：
 * 1. 向导第 1 步提交走 `updateAndSave({ config })` —— **整表替换**，
 *    而 `buildConfig` 曾是逐字段字面量 → 向导不管理的字段（crossAuditRecentCount /
 *    targetAudience）被丢掉；
 * 2. `normalizeImportedProject` 的 config 同样是逐字段字面量 → 导出备份再导入，
 *    跨章抽检窗口静默回默认 5。
 *
 * 不变量：**向导/导入只覆盖自己管理的字段，其余原样保留**（含以后新增的字段）。
 */
import { describe, expect, it } from 'vitest';
import { buildWizardProjectConfig } from '../src/services/wizardConfig';
import {
  sanitizeProjectForExport,
  normalizeImportedProject,
} from '../src/services/projectTransfer';
import { getDefaultStyleConfig } from '../src/services/storage';
import type { BookProject, ProjectConfig } from '../src/types/novel';

const FORM = {
  inspiration: '一个出租车司机的雨夜订单',
  totalChapters: 120,
  wordsPerChapter: 2600,
  writingStyle: '冷峻克制',
  genre: '都市异能',
  genrePackId: 'urban-power',
  styleProfileId: 'style-1',
};

function initialConfig(): ProjectConfig {
  return {
    inspiration: '旧灵感',
    totalChapters: 300,
    wordsPerChapter: 3000,
    targetChapterCount: 300,
    targetWordCountPerChapter: 3000,
    writingStyle: '旧文风',
    genre: '东方玄幻',
    targetAudience: '男频',
    crossAuditRecentCount: 30,
    customParameters: { genrePackId: 'xuanhuan', myOwnKey: 'keep-me' },
    // 模拟「以后新增、向导不管理」的字段：这类字段最容易被字面量构造吃掉
    ...({ futureField: 7 } as unknown as ProjectConfig),
  } as ProjectConfig;
}

describe('buildWizardProjectConfig · 向导只覆盖自己管理的字段', () => {
  it('向导不管理的字段全部保留（含以后新增的字段）', () => {
    const next = buildWizardProjectConfig(initialConfig(), FORM);
    expect(next.crossAuditRecentCount).toBe(30);
    expect(next.targetAudience).toBe('男频');
    expect((next as unknown as { futureField?: number }).futureField).toBe(7);
  });

  it('向导管理的字段被表单值覆盖', () => {
    const next = buildWizardProjectConfig(initialConfig(), FORM);
    expect(next.inspiration).toBe(FORM.inspiration);
    expect(next.totalChapters).toBe(120);
    expect(next.wordsPerChapter).toBe(2600);
    expect(next.targetChapterCount).toBe(120);
    expect(next.targetWordCountPerChapter).toBe(2600);
    expect(next.writingStyle).toBe('冷峻克制');
    expect(next.genre).toBe('都市异能');
  });

  it('customParameters：保留非向导键，覆盖向导键', () => {
    const next = buildWizardProjectConfig(initialConfig(), FORM);
    expect(next.customParameters?.myOwnKey).toBe('keep-me');
    expect(next.customParameters?.genrePackId).toBe('urban-power');
    expect(next.customParameters?.wizardStyleProfileId).toBe('style-1');
  });

  it('无初始配置（新书）不抛错', () => {
    const next = buildWizardProjectConfig(null, FORM);
    expect(next.targetChapterCount).toBe(120);
    expect(next.crossAuditRecentCount).toBeUndefined();
  });
});

describe('projectTransfer · 导入归一不丢跨章抽检窗口', () => {
  function bookWithWindow(count: unknown): BookProject {
    return {
      id: 'proj-1',
      title: '测试书',
      genre: '都市异能',
      synopsis: '',
      createdAt: '2026-09-18T00:00:00.000Z',
      lastModified: '2026-09-18T00:00:00.000Z',
      wizardStep: 'ready',
      config: {
        inspiration: '',
        genre: '都市异能',
        targetChapterCount: 120,
        targetWordCountPerChapter: 2600,
        writingStyle: '',
        crossAuditRecentCount: count,
        customParameters: {},
      } as unknown as ProjectConfig,
      styleConfig: getDefaultStyleConfig(),
      characters: [],
      settings: [],
      volumes: [],
      chapters: [],
    } as unknown as BookProject;
  }

  it('合法值往返保留（此前会被字面量丢掉）', () => {
    const clean = sanitizeProjectForExport(bookWithWindow(30));
    const { project } = normalizeImportedProject(clean);
    expect(project.config.crossAuditRecentCount).toBe(30);
  });

  it('脏值不落库（不信任外部 JSON）', () => {
    for (const bad of ['30', null, Number.NaN, {}]) {
      const clean = sanitizeProjectForExport(bookWithWindow(bad));
      const { project } = normalizeImportedProject(clean);
      expect(project.config.crossAuditRecentCount).toBeUndefined();
    }
  });
});
