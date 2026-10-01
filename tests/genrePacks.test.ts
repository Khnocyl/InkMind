/**
 * 题材库回归守卫。
 *
 * 覆盖三件容易悄悄坏掉的事：
 * 1. 题材覆盖度与必需字段（新增题材不能缺创作维度）；
 * 2. 别名路由：混合题材串必须取「最靠前」的标签，而不是按库内顺序先到先得；
 * 3. 项目级覆盖的向后兼容：旧面板只提交旧的几个字段时，
 *    新增的创作维度必须回退到内置值，不能被清空。
 */
import { describe, expect, it } from 'vitest';
import {
  GENRE_PACKS,
  formatGenrePackForPrompt,
  getGenrePackById,
  listGenrePacks,
  mergePackWithOverride,
  normalizeGenreOverride,
  resolveGenrePack,
} from '../src/services/genrePacks';

describe('genrePacks · 题材库覆盖度与字段完整性', () => {
  it('题材数量不少于 25 且 id 唯一', () => {
    expect(GENRE_PACKS.length).toBeGreaterThanOrEqual(25);
    const ids = GENRE_PACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每个题材都有必需字段与创作维度', () => {
    for (const p of GENRE_PACKS) {
      expect(p.name, p.id).toBeTruthy();
      expect(p.aliases.length, p.id).toBeGreaterThan(0);
      expect(p.description.length, p.id).toBeGreaterThan(4);
      expect(p.pacing.length, p.id).toBeGreaterThan(4);
      expect(p.taboos.length, p.id).toBeGreaterThanOrEqual(3);
      expect(p.mustHaves.length, p.id).toBeGreaterThanOrEqual(2);
      // 创作向维度：通用兜底包也应有，保证任何题材都能给到执行层指导
      expect(p.beatStructure, p.id).toBeTruthy();
      expect(p.scenePatterns?.length, p.id).toBeGreaterThanOrEqual(2);
      expect(p.payoffDesign?.length, p.id).toBeGreaterThanOrEqual(2);
      expect(p.perspectiveRules?.length, p.id).toBeGreaterThanOrEqual(2);
      expect(p.relationshipRules?.length, p.id).toBeGreaterThanOrEqual(2);
      expect(p.styleNorms?.targetWords, p.id).toBeGreaterThan(0);
    }
  });

  it('listGenrePacks 与内置表一致，getGenrePackById 可命中', () => {
    expect(listGenrePacks().length).toBe(GENRE_PACKS.length);
    expect(getGenrePackById('xuanhuan')?.name).toBe('玄幻修真');
    expect(getGenrePackById('not-exist')).toBeUndefined();
  });

  it('formatGenrePackForPrompt 渲染出全部创作维度', () => {
    const text = formatGenrePackForPrompt(getGenrePackById('xuanhuan')!);
    expect(text).toContain('【题材规则包：玄幻修真】');
    expect(text).toContain('章节范式：');
    expect(text).toContain('招牌场景拍法：');
    expect(text).toContain('爽点与情绪兑现：');
    expect(text).toContain('视角纪律：');
    expect(text).toContain('人物关系法则：');
    expect(text).toContain('题材参考规格');
    expect(text).toContain('禁忌：');
    expect(text).toContain('本章应具备：');
  });
});

describe('genrePacks · 别名路由', () => {
  it('纯题材串精确命中', () => {
    expect(resolveGenrePack('玄幻').id).toBe('xuanhuan');
    expect(resolveGenrePack('修仙').id).toBe('xianxia');
    expect(resolveGenrePack('悬疑').id).toBe('xuanyi');
    expect(resolveGenrePack('恐怖').id).toBe('kongbu');
    expect(resolveGenrePack('无限流').id).toBe('wuxianliu');
    expect(resolveGenrePack('种田').id).toBe('zhongtian');
  });

  it('混合题材串取最靠前的标签（不被库内顺序带偏）', () => {
    // 「修仙」所在的包排在库内更前，若按顺序匹配会误路由到仙侠
    expect(resolveGenrePack('科幻赛博·修仙智斗').id).toBe('kehuan');
    expect(resolveGenrePack('东方玄幻·诡秘流').id).toBe('xuanhuan');
    expect(resolveGenrePack('传统硬核·冷酷武侠').id).toBe('wuxia');
    // 悬疑在前 → 悬疑包（而非克苏鲁所在的恐怖包）
    expect(resolveGenrePack('悬疑诡案·蒸汽克苏鲁').id).toBe('xuanyi');
  });

  it('空值与未知题材回落通用包', () => {
    expect(resolveGenrePack('').id).toBe('general');
    expect(resolveGenrePack(null).id).toBe('general');
    expect(resolveGenrePack('某种不存在的类型').id).toBe('general');
  });

  it('单字题材回落通用包（有意决策：单字反查会命中错误包）', () => {
    // 「武」按旧算法经「高武」别名命中玄幻修真——那是误路由而非正确路由；
    // 单字信号太弱，宁可诚实回落通用包，也不猜。真实场景用户从 25 项下拉里选，
    // 不会手输单字。锁定此决策，防止未来改回反查引入静默误路由。
    expect(resolveGenrePack('武').id).toBe('general');
    expect(resolveGenrePack('史').id).toBe('general');
  });
});

describe('genrePacks · 项目级覆盖', () => {
  const base = getGenrePackById('xuanhuan')!;

  it('旧面板只提交旧字段时，新增创作维度回退内置而非被清空', () => {
    const override = normalizeGenreOverride({
      basePackId: 'xuanhuan',
      pacing: '自定义节奏',
      taboos: ['自定义禁忌'],
    });
    const merged = mergePackWithOverride(base, override);
    expect(merged.pacing).toBe('自定义节奏');
    expect(merged.taboos).toEqual(['自定义禁忌']);
    expect(merged.beatStructure).toBe(base.beatStructure);
    expect(merged.scenePatterns).toEqual(base.scenePatterns);
    expect(merged.payoffDesign).toEqual(base.payoffDesign);
    expect(merged.styleNorms).toEqual(base.styleNorms);
  });

  it('可覆盖创作维度与数值规格（无效数值丢弃且不冲掉内置值）', () => {
    const override = normalizeGenreOverride({
      scenePatterns: ['自定义场景一', '自定义场景二'],
      relationshipRules: '自定义法则一\n自定义法则二',
      styleNorms: { targetWords: 2500, paragraphLen: 99999, dialogueRatio: 30 },
    });
    const merged = mergePackWithOverride(base, override);
    expect(merged.scenePatterns).toEqual(['自定义场景一', '自定义场景二']);
    expect(merged.relationshipRules).toEqual(['自定义法则一', '自定义法则二']);
    expect(merged.styleNorms?.targetWords).toBe(2500);
    expect(merged.styleNorms?.dialogueRatio).toBe(30);
    // paragraphLen 越界非法 → 省略键 → 回退内置 175（而不是 undefined 键冲掉内置值）
    expect(merged.styleNorms?.paragraphLen).toBe(175);
  });

  it('styleNorms 部分覆盖只改给的键，其余保留内置（spread 不得用 undefined 冲掉 base）', () => {
    const merged = mergePackWithOverride(
      base,
      normalizeGenreOverride({ styleNorms: { paragraphLen: 150 } })
    );
    expect(merged.styleNorms?.paragraphLen).toBe(150);
    expect(merged.styleNorms?.targetWords).toBe(3500);
    expect(merged.styleNorms?.dialogueRatio).toBe(25);
  });

  it('列表去噪只剥真正的列表标记，不剥正文数字开头', () => {
    const t = normalizeGenreOverride({
      taboos: ['3天内必须回款', '10.000灵石上限', '1、真列表项', '2) 另一种编号'],
    });
    expect(t!.taboos).toEqual(['3天内必须回款', '10.000灵石上限', '真列表项', '另一种编号']);
  });

  it('文本字段空字符串 = 未提供 → 回退内置（与列表字段语义一致）', () => {
    const o = normalizeGenreOverride({ beatStructure: '   ', description: '', pacing: '自定义节奏' });
    expect(o!.beatStructure).toBeUndefined();
    expect(o!.description).toBeUndefined();
    expect(o!.pacing).toBe('自定义节奏');
    const merged = mergePackWithOverride(base, o);
    expect(merged.beatStructure).toBe(base.beatStructure);
    expect(merged.description).toBe(base.description);
  });

  it('非对象/空输入返回 null，不污染调用方', () => {
    expect(normalizeGenreOverride(null)).toBeNull();
    expect(normalizeGenreOverride('abc')).toBeNull();
    expect(normalizeGenreOverride({})).toEqual({});
  });

  it('合并结果不共享内置数组引用（改一处不影响内置表）', () => {
    const merged = mergePackWithOverride(base, null);
    merged.taboos.push('注入项');
    merged.scenePatterns!.push('注入项');
    expect(base.taboos).not.toContain('注入项');
    expect(base.scenePatterns).not.toContain('注入项');
  });
});
