/**
 * 删除文风档案后的悬空引用清理。
 * 回归背景（用户反馈）：删掉的文风仍出现在向导第一步「行文文风」下拉里——
 * 因为 config.writingStyle 仍保存着「仿写·<档案名>：…」文案，而向导会把
 * 匹配不到档案的历史字符串原样渲染成「当前配置」一项。
 */
import { describe, expect, it } from 'vitest';
import {
  pruneDeletedStyleReferences,
  removedStyleProfiles,
} from '../src/services/styleProfileCleanup';
import type { BookProject, StyleProfile } from '../src/types/novel';

function profile(id: string, name: string, authorStyle = ''): StyleProfile {
  return { id, name, authorStyle, styleGuide: '', sampleExcerpt: '', analysis: '' } as unknown as StyleProfile;
}

function project(config: Partial<BookProject['config']>): Pick<BookProject, 'config' | 'styleConfig'> {
  return {
    config: {
      inspiration: '',
      genre: '玄幻',
      writingStyle: '',
      ...config,
    } as BookProject['config'],
    styleConfig: undefined as never,
  };
}

describe('pruneDeletedStyleReferences · 清理已删档案的悬空引用', () => {
  it('writingStyle 是「仿写·<名字>：…」→ 清空（否则向导下拉仍显示）', () => {
    const patch = pruneDeletedStyleReferences(
      project({ writingStyle: '仿写·戏神：短句利落，动作推进' }),
      [profile('p1', '戏神')]
    );
    expect(patch.config?.writingStyle).toBe('');
  });

  it('writingStyle 恰等于档案 authorStyle → 清空', () => {
    const patch = pruneDeletedStyleReferences(
      project({ writingStyle: '利落短句，动作推进' }),
      [profile('p1', '戏神', '利落短句，动作推进')]
    );
    expect(patch.config?.writingStyle).toBe('');
  });

  it('自定义历史文案与已删档案无关 → 不动', () => {
    const patch = pruneDeletedStyleReferences(
      project({ writingStyle: '我自己手写的风格描述' }),
      [profile('p1', '戏神')]
    );
    expect(patch).toEqual({});
  });

  it('清理 customParameters.wizardStyleProfileId，且保留其他参数', () => {
    const patch = pruneDeletedStyleReferences(
      project({
        writingStyle: '仿写·戏神：x',
        customParameters: { genrePackId: 'xuanhuan', wizardStyleProfileId: 'p1' },
      }),
      [profile('p1', '戏神')]
    );
    expect(patch.config?.customParameters).toEqual({ genrePackId: 'xuanhuan' });
  });

  it('指向其他档案的 id 不受影响', () => {
    const patch = pruneDeletedStyleReferences(
      project({ customParameters: { wizardStyleProfileId: 'keep' } }),
      [profile('p1', '戏神')]
    );
    expect(patch).toEqual({});
  });

  it('removed 为空 → 返回空补丁', () => {
    expect(pruneDeletedStyleReferences(project({ writingStyle: '仿写·戏神：x' }), [])).toEqual(
      {}
    );
  });
});

describe('removedStyleProfiles · 只按 id 判定删除', () => {
  it('同 id 改名（编辑）不算删除', () => {
    expect(
      removedStyleProfiles([profile('a', '旧名')], [profile('a', '新名')])
    ).toEqual([]);
  });

  it('id 消失 → 判定为删除', () => {
    const removed = removedStyleProfiles(
      [profile('a', '甲'), profile('b', '乙')],
      [profile('b', '乙')]
    );
    expect(removed.map((p) => p.id)).toEqual(['a']);
  });

  it('next 为空 → 全部删除', () => {
    expect(removedStyleProfiles([profile('a', '甲')], undefined)).toHaveLength(1);
  });
});
