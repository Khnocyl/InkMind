/**
 * 向导「行文文风」与设置页「文风仿写」的双向一致（用户反馈）：
 * - 设置里选的档案 → 向导第一步显示同一个；
 * - 向导里改了 → 设置页/项目状态随之改变；
 * - 选内置预设 = 解除档案激活（不再注入该档案的指纹/指南）。
 */
import { describe, expect, it } from 'vitest';
import {
  applyStyleKeyToProject,
  styleDirectiveForProfile,
  syncConfigWithActiveProfile,
} from '../src/services/styleImitate';
import type { BookProject, StyleConfig, StyleProfile } from '../src/types/novel';

function profile(id: string, name: string, authorStyle = '', styleGuide = ''): StyleProfile {
  return { id, name, authorStyle, styleGuide, sampleExcerpt: '样本', analysis: '' } as unknown as StyleProfile;
}

function styleConfig(overrides?: Partial<StyleConfig>): StyleConfig {
  return {
    clicheBlacklist: [],
    customBlacklist: [],
    enforceShowDontTell: true,
    forbidEndingSublimation: true,
    styleProfiles: [],
    activeStyleProfileId: null,
    fewShotExamples: [],
    selectedExampleId: '',
    ...overrides,
  } as StyleConfig;
}

function project(config: Partial<BookProject['config']>, sc: StyleConfig) {
  return {
    config: {
      inspiration: '',
      genre: '玄幻',
      writingStyle: '',
      ...config,
    } as BookProject['config'],
    styleConfig: sc,
  };
}

describe('styleDirectiveForProfile', () => {
  it('带 authorStyle 时拼「仿写·名字：提示」', () => {
    expect(styleDirectiveForProfile(profile('a', '戏神', '短句利落'))).toBe(
      '仿写·戏神：短句利落'
    );
  });

  it('无 authorStyle/styleGuide 时回落到名字（沿用既有格式）', () => {
    expect(styleDirectiveForProfile(profile('a', '戏神', '', '多用短句'))).toBe(
      '仿写·戏神：多用短句'
    );
    // 两者都为空 → tip 回落 name（与重构前的口径一致）
    expect(styleDirectiveForProfile(profile('a', '戏神'))).toBe('仿写·戏神：戏神');
  });
});

describe('applyStyleKeyToProject · 向导选择同时更新 config 与 styleConfig', () => {
  const merged = [{ profile: profile('p1', '戏神', '短句利落') }];

  it('选本书档案 → 激活该档案 + config 写派生文案 + 记住 id', () => {
    const sc = styleConfig({ styleProfiles: [profile('p1', '戏神', '短句利落')] });
    const patch = applyStyleKeyToProject(project({}, sc), 'profile:p1', merged);
    expect(patch.styleConfig?.activeStyleProfileId).toBe('p1');
    expect(patch.config?.writingStyle).toBe('仿写·戏神：短句利落');
    expect(patch.config?.customParameters?.wizardStyleProfileId).toBe('p1');
  });

  it('选全局档案 → 复制进本书并激活（含 few-shot 同步）', () => {
    const sc = styleConfig();
    const patch = applyStyleKeyToProject(project({}, sc), 'profile:p1', merged);
    expect(patch.styleConfig?.styleProfiles?.map((p) => p.id)).toEqual(['p1']);
    expect(patch.styleConfig?.activeStyleProfileId).toBe('p1');
    expect(patch.styleConfig?.fewShotExamples?.some((e) => e.id === 'few-style-p1')).toBe(true);
  });

  it('选内置预设 → 解除档案激活并清掉该档案的 few-shot 选择', () => {
    const sc = styleConfig({
      styleProfiles: [profile('p1', '戏神')],
      activeStyleProfileId: 'p1',
      fewShotExamples: [{ id: 'few-style-p1', title: 'x', authorStyle: '', content: '', analysis: '' }],
      selectedExampleId: 'few-style-p1',
    });
    const patch = applyStyleKeyToProject(
      project({ writingStyle: '仿写·戏神：短句利落' }, sc),
      '网文爽快·反转利落',
      merged
    );
    expect(patch.styleConfig?.activeStyleProfileId).toBeNull();
    expect(patch.styleConfig?.selectedExampleId).toBe('');
    expect(patch.config?.writingStyle).toBe('网文爽快·反转利落');
    expect(patch.config?.customParameters?.wizardStyleProfileId).toBeUndefined();
  });

  it('档案 id 已失效 → 不写入悬空 id', () => {
    const sc = styleConfig({ styleProfiles: [profile('p1', '戏神')], activeStyleProfileId: 'p1' });
    const patch = applyStyleKeyToProject(project({}, sc), 'profile:gone', merged);
    expect(patch.styleConfig?.activeStyleProfileId).toBeNull();
    expect(patch.config?.writingStyle).toBe('');
    expect(patch.config?.customParameters?.wizardStyleProfileId).toBeUndefined();
  });

  it('保留其他 customParameters', () => {
    const sc = styleConfig({ styleProfiles: [profile('p1', '戏神')] });
    const patch = applyStyleKeyToProject(
      project({ customParameters: { genrePackId: 'xuanhuan' } }, sc),
      'profile:p1',
      merged
    );
    expect(patch.config?.customParameters).toMatchObject({
      genrePackId: 'xuanhuan',
      wizardStyleProfileId: 'p1',
    });
  });
});

describe('syncConfigWithActiveProfile · 设置页切换同步到向导', () => {
  const sc = styleConfig({
    styleProfiles: [profile('p1', '戏神', '短句利落')],
    activeStyleProfileId: 'p1',
  });

  it('设置页激活档案 → config.writingStyle 跟随', () => {
    const patch = syncConfigWithActiveProfile(
      project({}, styleConfig({ styleProfiles: [profile('p1', '戏神', '短句利落')] })),
      sc
    );
    expect(patch.config?.writingStyle).toBe('仿写·戏神：短句利落');
    expect(patch.config?.customParameters?.wizardStyleProfileId).toBe('p1');
  });

  it('设置页停用档案 → 清空 writingStyle 与 id', () => {
    const patch = syncConfigWithActiveProfile(
      project({ writingStyle: '仿写·戏神：短句利落' }, sc),
      styleConfig({ styleProfiles: [profile('p1', '戏神')] })
    );
    expect(patch.config?.writingStyle).toBe('');
    expect(patch.config?.customParameters?.wizardStyleProfileId).toBeUndefined();
  });

  it('激活项未变 → 不动 config', () => {
    expect(syncConfigWithActiveProfile(project({}, sc), sc)).toEqual({});
  });
});
