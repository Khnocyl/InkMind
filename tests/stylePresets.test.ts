/**
 * 内置文风档案预设（《我不是戏神·黑色幽默流》）单测：
 * - 指纹为引擎同口径实测值（短句主流、句短于 16 字均值）
 * - punctuationTolerance 豁免标记随导入保留（纪律豁免链路依赖它）
 * - 导入即激活 + 同步 few-shot（正面示范注入依赖它）
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_STYLE_PRESETS,
  MOXIANGTONGXIU_STYLE_PROFILE,
  TANGJIASANSHAO_STYLE_PROFILE,
  TUDOU_STYLE_PROFILE,
  XISHEN_STYLE_PROFILE,
} from '../src/services/stylePresets';
import {
  getActiveStyleProfile,
  importStyleProfile,
} from '../src/services/styleImitate';
import { validatePostWrite } from '../src/engine/discipline';
import { getDefaultStyleConfig } from '../src/services/storage';

describe('内置文风档案 · 我不是戏神', () => {
  it('指纹为短句主流节奏（短句≥50%、均值≤16 字、逗号稀疏）', () => {
    const fp = XISHEN_STYLE_PROFILE.fingerprint;
    expect(fp.shortSentenceRatio).toBeGreaterThanOrEqual(0.5);
    expect(fp.avgSentenceLen).toBeLessThanOrEqual(16);
    expect(fp.medianSentenceLen).toBeLessThanOrEqual(10);
    expect(fp.commaPerSentence).toBeLessThanOrEqual(1.2);
    expect(fp.dialogueRatio).toBeGreaterThanOrEqual(0.15);
  });

  it('档案声明省略号风格豁免 + 指南含语感层 + 多场景范文齐备', () => {
    expect(XISHEN_STYLE_PROFILE.punctuationTolerance).toBe('ellipsis-emphatic');
    expect(XISHEN_STYLE_PROFILE.styleGuide).toContain('节奏');
    expect(XISHEN_STYLE_PROFILE.styleGuide).toContain('对白');
    expect(XISHEN_STYLE_PROFILE.styleGuide).toContain('语感');
    expect(XISHEN_STYLE_PROFILE.doList.length).toBeGreaterThanOrEqual(5);
    expect(XISHEN_STYLE_PROFILE.dontList.length).toBeGreaterThanOrEqual(4);
    expect(XISHEN_STYLE_PROFILE.sampleExcerpt.length).toBeGreaterThan(200);
    const ex = XISHEN_STYLE_PROFILE.sampleExcerpts || [];
    expect(ex.length).toBeGreaterThanOrEqual(3);
    for (const e of ex) {
      expect(e.label.length).toBeGreaterThan(4);
      expect(e.text.length).toBeGreaterThan(150);
    }
  });

  it('多场景范文注入：formatStyleProfileForPrompt 带场景标签', async () => {
    const { formatStyleProfileForPrompt } = await import('../src/services/styleImitate');
    const block = formatStyleProfileForPrompt(XISHEN_STYLE_PROFILE);
    expect(block).toContain('场景：');
    expect(block).toContain('学语感');
  });

  it('导入即激活：activeStyleProfileId 指向预设 + few-shot 同步', () => {
    const base = getDefaultStyleConfig();
    const next = importStyleProfile(base, XISHEN_STYLE_PROFILE, {
      activate: true,
      syncFewShot: true,
    });
    expect(next.styleProfiles.some((p) => p.id === XISHEN_STYLE_PROFILE.id)).toBe(true);
    expect(next.activeStyleProfileId).toBe(XISHEN_STYLE_PROFILE.id);
    expect(next.fewShotExamples.some((e) => e.id === `few-style-${XISHEN_STYLE_PROFILE.id}`)).toBe(
      true
    );
    // 豁免标记在激活档案上可读（Auditor/Reviser 依赖）
    expect(getActiveStyleProfile(next)?.punctuationTolerance).toBe('ellipsis-emphatic');
  });

  it('纪律豁免链路：档案激活时破折号不再判 error，未激活仍判', () => {
    const withXishen = importStyleProfile(getDefaultStyleConfig(), XISHEN_STYLE_PROFILE, {
      activate: true,
    });
    const allow =
      getActiveStyleProfile(withXishen)?.punctuationTolerance === 'ellipsis-emphatic';
    expect(allow).toBe(true);
    const text = '他停住——有人在外面。';
    expect(
      validatePostWrite(text, { allowEmDash: allow }).some((v) => v.rule === '禁止破折号')
    ).toBe(false);
    expect(validatePostWrite(text).some((v) => v.rule === '禁止破折号')).toBe(true);
  });

  it('预设清单可被 UI 枚举导入且 id 唯一', () => {
    expect(BUILTIN_STYLE_PRESETS.length).toBeGreaterThanOrEqual(2);
    expect(new Set(BUILTIN_STYLE_PRESETS.map((p) => p.id)).size).toBe(BUILTIN_STYLE_PRESETS.length);
  });
});

describe('内置文风档案 · 天蚕土豆·热血升级流', () => {
  it('存在于预设清单且 id 不重复', () => {
    expect(BUILTIN_STYLE_PRESETS.some((p) => p.id === TUDOU_STYLE_PROFILE.id)).toBe(true);
    expect(new Set(BUILTIN_STYLE_PRESETS.map((p) => p.id)).size).toBe(
      BUILTIN_STYLE_PRESETS.length
    );
  });

  it('指纹为设计靶区：对白密、感叹多、短句为主且比黑色幽默流长', () => {
    const fp = TUDOU_STYLE_PROFILE.fingerprint;
    expect(fp.dialogueRatio).toBeGreaterThanOrEqual(0.2);
    expect(fp.exclamationPerK).toBeGreaterThanOrEqual(5);
    expect(fp.shortSentenceRatio).toBeGreaterThanOrEqual(0.3);
    // 中短句为主，但均值长于戏神流的 15.7 字（本档案校定 20 字）
    expect(fp.avgSentenceLen).toBeGreaterThan(16);
    expect(fp.avgSentenceLen).toBeLessThanOrEqual(22);
    // 自洽：均句长/段均与字数-句数-段数吻合
    expect(fp.avgSentenceLen).toBeCloseTo(fp.charCount / fp.sentenceCount, 5);
    expect(fp.avgParagraphLen).toBeCloseTo(fp.charCount / fp.paragraphCount, 5);
    expect(fp.topPhrases.length).toBeGreaterThanOrEqual(3);
  });

  it('风格指南含战斗/突破/爽点关键词', () => {
    const g = TUDOU_STYLE_PROFILE.styleGuide;
    expect(g).toContain('战斗');
    expect(g).toContain('突破');
    expect(g).toContain('爽点');
  });

  it('doList ≥6 条、dontList ≥5 条', () => {
    expect(TUDOU_STYLE_PROFILE.doList.length).toBeGreaterThanOrEqual(6);
    expect(TUDOU_STYLE_PROFILE.dontList.length).toBeGreaterThanOrEqual(5);
  });

  it('多场景范文齐备：≥3 段且每段 >150 字、≤300 字', () => {
    const ex = TUDOU_STYLE_PROFILE.sampleExcerpts || [];
    expect(ex.length).toBeGreaterThanOrEqual(3);
    for (const e of ex) {
      expect(e.label.length).toBeGreaterThan(4);
      expect(e.text.length).toBeGreaterThan(150);
      expect(e.text.length).toBeLessThanOrEqual(300);
    }
  });

  it('导入即激活：activeStyleProfileId 指向预设 + few-shot 同步', () => {
    const base = getDefaultStyleConfig();
    const next = importStyleProfile(base, TUDOU_STYLE_PROFILE, {
      activate: true,
      syncFewShot: true,
    });
    expect(next.styleProfiles.some((p) => p.id === TUDOU_STYLE_PROFILE.id)).toBe(true);
    expect(next.activeStyleProfileId).toBe(TUDOU_STYLE_PROFILE.id);
    expect(
      next.fewShotExamples.some((e) => e.id === `few-style-${TUDOU_STYLE_PROFILE.id}`)
    ).toBe(true);
    // 本档案不声明标点豁免（走通用去AI味规则）
    expect(getActiveStyleProfile(next)?.punctuationTolerance).toBeUndefined();
  });

  it('多场景范文注入：formatStyleProfileForPrompt 带场景标签', async () => {
    const { formatStyleProfileForPrompt } = await import('../src/services/styleImitate');
    const block = formatStyleProfileForPrompt(TUDOU_STYLE_PROFILE);
    expect(block).toContain('场景：');
    expect(block).toContain('退婚羞辱开局');
    expect(block).toContain('战斗五步公式');
  });

  it('原创样文跑 validatePostWrite 无系统性硬失败（无 error 级违规）', () => {
    for (const e of TUDOU_STYLE_PROFILE.sampleExcerpts || []) {
      const errors = validatePostWrite(e.text).filter((v) => v.severity === 'error');
      expect(errors, `样文「${e.label}」触发硬失败：${errors.map((x) => x.rule).join('、')}`).toEqual([]);
    }
  });
});

describe('内置文风档案 · 唐家三少·热血团战流', () => {
  it('存在于预设清单且 id 不重复', () => {
    expect(BUILTIN_STYLE_PRESETS.some((p) => p.id === TANGJIASANSHAO_STYLE_PROFILE.id)).toBe(true);
    expect(new Set(BUILTIN_STYLE_PRESETS.map((p) => p.id)).size).toBe(
      BUILTIN_STYLE_PRESETS.length
    );
  });

  it('指纹为设计靶区：对白密、感叹多，且数值自洽', () => {
    const fp = TANGJIASANSHAO_STYLE_PROFILE.fingerprint;
    expect(fp.dialogueRatio).toBeGreaterThanOrEqual(0.25);
    expect(fp.exclamationPerK).toBeGreaterThanOrEqual(6);
    expect(fp.avgSentenceLen).toBeGreaterThan(16);
    expect(fp.avgSentenceLen).toBeLessThanOrEqual(22);
    expect(fp.avgSentenceLen).toBeCloseTo(fp.charCount / fp.sentenceCount, 5);
    expect(fp.avgParagraphLen).toBeCloseTo(fp.charCount / fp.paragraphCount, 5);
    expect(fp.topPhrases.length).toBeGreaterThanOrEqual(3);
  });

  it('风格指南含团战/高光/体系关键词，不出现原作专名', () => {
    const g = TANGJIASANSHAO_STYLE_PROFILE.styleGuide;
    expect(g).toContain('团战');
    expect(g).toContain('高光');
    expect(g).toContain('体系');
    const blob = [
      TANGJIASANSHAO_STYLE_PROFILE.styleGuide,
      ...TANGJIASANSHAO_STYLE_PROFILE.doList,
      ...TANGJIASANSHAO_STYLE_PROFILE.dontList,
    ].join('\n');
    expect(blob).not.toContain('魂环');
    expect(blob).not.toContain('史莱克');
    expect(blob).not.toContain('斗罗');
  });

  it('doList ≥6 条、dontList ≥5 条', () => {
    expect(TANGJIASANSHAO_STYLE_PROFILE.doList.length).toBeGreaterThanOrEqual(6);
    expect(TANGJIASANSHAO_STYLE_PROFILE.dontList.length).toBeGreaterThanOrEqual(5);
  });

  it('多场景范文齐备：≥3 段且每段 >150 字、≤300 字', () => {
    const ex = TANGJIASANSHAO_STYLE_PROFILE.sampleExcerpts || [];
    expect(ex.length).toBeGreaterThanOrEqual(3);
    for (const e of ex) {
      expect(e.label.length).toBeGreaterThan(4);
      expect(e.text.length).toBeGreaterThan(150);
      expect(e.text.length).toBeLessThanOrEqual(300);
    }
  });

  it('导入即激活 + few-shot 同步；不声明标点豁免', () => {
    const base = getDefaultStyleConfig();
    const next = importStyleProfile(base, TANGJIASANSHAO_STYLE_PROFILE, {
      activate: true,
      syncFewShot: true,
    });
    expect(next.activeStyleProfileId).toBe(TANGJIASANSHAO_STYLE_PROFILE.id);
    expect(
      next.fewShotExamples.some((e) => e.id === `few-style-${TANGJIASANSHAO_STYLE_PROFILE.id}`)
    ).toBe(true);
    expect(getActiveStyleProfile(next)?.punctuationTolerance).toBeUndefined();
  });

  it('原创样文跑 validatePostWrite 无 error 级违规', () => {
    for (const e of TANGJIASANSHAO_STYLE_PROFILE.sampleExcerpts || []) {
      const errors = validatePostWrite(e.text).filter((v) => v.severity === 'error');
      expect(errors, `样文「${e.label}」触发硬失败：${errors.map((x) => x.rule).join('、')}`).toEqual([]);
    }
  });
});

describe('内置文风档案 · 墨香铜臭·暖虐群像流', () => {
  it('存在于预设清单且 id 不重复', () => {
    expect(BUILTIN_STYLE_PRESETS.some((p) => p.id === MOXIANGTONGXIU_STYLE_PROFILE.id)).toBe(true);
    expect(new Set(BUILTIN_STYLE_PRESETS.map((p) => p.id)).size).toBe(
      BUILTIN_STYLE_PRESETS.length
    );
  });

  it('指纹为设计靶区：对白极密、疑问句多（讥诮对白）、短句为主，且数值自洽', () => {
    const fp = MOXIANGTONGXIU_STYLE_PROFILE.fingerprint;
    expect(fp.dialogueRatio).toBeGreaterThanOrEqual(0.3);
    expect(fp.questionPerK).toBeGreaterThanOrEqual(5);
    expect(fp.shortSentenceRatio).toBeGreaterThanOrEqual(0.45);
    expect(fp.avgSentenceLen).toBeCloseTo(fp.charCount / fp.sentenceCount, 5);
    expect(fp.avgParagraphLen).toBeCloseTo(fp.charCount / fp.paragraphCount, 5);
    expect(fp.topPhrases.length).toBeGreaterThanOrEqual(3);
  });

  it('风格指南含双线/金句/群像关键词，不出现原作专名', () => {
    const g = MOXIANGTONGXIU_STYLE_PROFILE.styleGuide;
    expect(g).toContain('双线');
    expect(g).toContain('金句');
    expect(g).toContain('群像');
    const blob = [
      MOXIANGTONGXIU_STYLE_PROFILE.styleGuide,
      ...MOXIANGTONGXIU_STYLE_PROFILE.doList,
      ...MOXIANGTONGXIU_STYLE_PROFILE.dontList,
    ].join('\n');
    expect(blob).not.toContain('魔道');
    expect(blob).not.toContain('天官');
    expect(blob).not.toContain('魏无羡');
    expect(blob).not.toContain('陈情');
  });

  it('doList ≥6 条、dontList ≥5 条', () => {
    expect(MOXIANGTONGXIU_STYLE_PROFILE.doList.length).toBeGreaterThanOrEqual(6);
    expect(MOXIANGTONGXIU_STYLE_PROFILE.dontList.length).toBeGreaterThanOrEqual(5);
  });

  it('多场景范文齐备：≥3 段且每段 >150 字、≤300 字', () => {
    const ex = MOXIANGTONGXIU_STYLE_PROFILE.sampleExcerpts || [];
    expect(ex.length).toBeGreaterThanOrEqual(3);
    for (const e of ex) {
      expect(e.label.length).toBeGreaterThan(4);
      expect(e.text.length).toBeGreaterThan(150);
      expect(e.text.length).toBeLessThanOrEqual(300);
    }
  });

  it('导入即激活 + few-shot 同步；不声明标点豁免', () => {
    const base = getDefaultStyleConfig();
    const next = importStyleProfile(base, MOXIANGTONGXIU_STYLE_PROFILE, {
      activate: true,
      syncFewShot: true,
    });
    expect(next.activeStyleProfileId).toBe(MOXIANGTONGXIU_STYLE_PROFILE.id);
    expect(
      next.fewShotExamples.some((e) => e.id === `few-style-${MOXIANGTONGXIU_STYLE_PROFILE.id}`)
    ).toBe(true);
    expect(getActiveStyleProfile(next)?.punctuationTolerance).toBeUndefined();
  });

  it('原创样文跑 validatePostWrite 无 error 级违规', () => {
    for (const e of MOXIANGTONGXIU_STYLE_PROFILE.sampleExcerpts || []) {
      const errors = validatePostWrite(e.text).filter((v) => v.severity === 'error');
      expect(errors, `样文「${e.label}」触发硬失败：${errors.map((x) => x.rule).join('、')}`).toEqual([]);
    }
  });
});

describe('文风结构层 · 作家大脑参与结构建设', () => {
  it('全部内置预设都带非空 structureGuide（结构层方法论）', async () => {
    const { formatStyleStructureForPrompt } = await import('../src/services/styleImitate');
    for (const p of BUILTIN_STYLE_PRESETS) {
      expect(p.structureGuide?.trim().length ?? 0).toBeGreaterThan(40);
      const block = formatStyleStructureForPrompt(p);
      expect(block).toContain('作家创作方法论');
      expect(block).toContain(p.name);
      expect(block).not.toContain('undefined');
    }
  });

  it('无结构层档案 → 注入块为空串（提示词保持原样）', async () => {
    const { formatStyleStructureForPrompt } = await import('../src/services/styleImitate');
    expect(formatStyleStructureForPrompt(null)).toBe('');
    expect(formatStyleStructureForPrompt({ ...BUILTIN_STYLE_PRESETS[0], structureGuide: undefined })).toBe('');
    expect(formatStyleStructureForPrompt({ ...BUILTIN_STYLE_PRESETS[0], structureGuide: '  ' })).toBe('');
  });

  it('分镜提示词注入结构层（beats 层真实参与）', async () => {
    const { buildChapterBeatsPrompt } = await import('../src/services/prompts');
    const { formatStyleStructureForPrompt } = await import('../src/services/styleImitate');
    const messages = buildChapterBeatsPrompt(
      '主角进入秘境试炼',
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      formatStyleStructureForPrompt(TUDOU_STYLE_PROFILE)
    );
    const user = messages[1].content;
    expect(user).toContain('作家创作方法论');
    expect(user).toContain('换地图四要素');
  });

  it('分卷提示词注入结构层', async () => {
    const { buildOutlineVolumesPrompt } = await import('../src/services/prompts');
    const { formatStyleStructureForPrompt } = await import('../src/services/styleImitate');
    const messages = buildOutlineVolumesPrompt(
      { genre: '玄幻', inspiration: 'x' },
      '书名',
      '简介',
      [],
      [],
      formatStyleStructureForPrompt(MOXIANGTONGXIU_STYLE_PROFILE)
    );
    expect(messages[1].content).toContain('作家创作方法论');
    expect(messages[1].content).toContain('双线结构');
  });
});

describe('文风题材门控 · 防止题材公式串味（如团战流带进言情书）', () => {
  it('题材不匹配判定：标签命中→匹配；无标签→通用；无书题材→不降级', async () => {
    const { isStyleGenreMismatch } = await import('../src/services/styleImitate');
    // 唐家三少团战流：玄幻/热血匹配，言情/都市/悬疑不匹配
    expect(isStyleGenreMismatch(TANGJIASANSHAO_STYLE_PROFILE, '玄幻')).toBe(false);
    expect(isStyleGenreMismatch(TANGJIASANSHAO_STYLE_PROFILE, '东方玄幻')).toBe(false);
    expect(isStyleGenreMismatch(TANGJIASANSHAO_STYLE_PROFILE, '热血高武')).toBe(false);
    expect(isStyleGenreMismatch(TANGJIASANSHAO_STYLE_PROFILE, '都市言情')).toBe(true);
    expect(isStyleGenreMismatch(TANGJIASANSHAO_STYLE_PROFILE, '悬疑推理')).toBe(true);
    // 题材通用档案：无标签 = 题材通用，任何题材都不降级
    const genericProfile: any = { ...TANGJIASANSHAO_STYLE_PROFILE, genreTags: undefined };
    expect(isStyleGenreMismatch(genericProfile, '都市')).toBe(false);
    expect(isStyleGenreMismatch(genericProfile, '言情')).toBe(false);
    // 书题材未知 → 不降级（尊重用户显式选择）
    expect(isStyleGenreMismatch(TANGJIASANSHAO_STYLE_PROFILE, '')).toBe(false);
    expect(isStyleGenreMismatch(TANGJIASANSHAO_STYLE_PROFILE, undefined)).toBe(false);
  });

  it('结构层题材不匹配时不注入（大纲/分镜不再被带成团战流）', async () => {
    const { formatStyleStructureForPrompt } = await import('../src/services/styleImitate');
    expect(formatStyleStructureForPrompt(TANGJIASANSHAO_STYLE_PROFILE, '都市言情')).toBe('');
    expect(formatStyleStructureForPrompt(TUDOU_STYLE_PROFILE, '悬疑推理')).toBe('');
    // 题材匹配时照常注入
    const block = formatStyleStructureForPrompt(TANGJIASANSHAO_STYLE_PROFILE, '玄幻');
    expect(block).toContain('团战分布');
  });

  it('正文层题材不匹配时降级：注入降级铁律并显式禁用团战六拍等机制', async () => {
    const { formatStyleProfileForPrompt } = await import('../src/services/styleImitate');
    const block = formatStyleProfileForPrompt(TANGJIASANSHAO_STYLE_PROFILE, '都市言情');
    expect(block).toContain('题材不匹配降级铁律');
    expect(block).toContain('只执行文笔层');
    expect(block).toContain('团战六拍');
    expect(block).toContain('招式释放瞬间喊名');
    // 文笔层指纹仍在（句长/对白密度目标保留）
    expect(block).toContain('统计指纹');
    // 匹配题材时不出现降级块
    const ok = formatStyleProfileForPrompt(TANGJIASANSHAO_STYLE_PROFILE, '玄幻');
    expect(ok).not.toContain('题材不匹配降级铁律');
  });

  it('局部改写约束同样走题材降级（formatStyleConstraintsForRewrite）', async () => {
    const { formatStyleConstraintsForRewrite } = await import('../src/services/styleImitate');
    const cfg = importStyleProfile(getDefaultStyleConfig(), TANGJIASANSHAO_STYLE_PROFILE, {
      activate: true,
    });
    const mismatchBlock = formatStyleConstraintsForRewrite(cfg, {
      bookGenre: '都市言情',
    });
    expect(mismatchBlock).toContain('题材不匹配降级铁律');
    const matchBlock = formatStyleConstraintsForRewrite(cfg, { bookGenre: '玄幻' });
    expect(matchBlock).not.toContain('题材不匹配降级铁律');
  });

  it('激活文风仿写时，正文 prompt 仍注入黑名单（防止仿写分支漏黑名单写出套话）', async () => {
    const { buildChapterProsePrompt } = await import('../src/services/prompts');
    const cfg = importStyleProfile(getDefaultStyleConfig(), TANGJIASANSHAO_STYLE_PROFILE, {
      activate: true,
    });
    // 注入一条自定义黑名单词，验证它出现在仿写分支的 systemPrompt
    const custom = {
      ...cfg,
      customBlacklist: ['倒吸一口凉气'],
    };
    const chapter = {
      number: 1,
      title: '初战',
      summary: '主角团首场团战',
    } as unknown as Parameters<typeof buildChapterProsePrompt>[0];
    const msgs = buildChapterProsePrompt(
      chapter, [], [], [], custom,
      undefined, undefined, undefined, undefined, undefined, '玄幻'
    );
    // 仿写分支存在
    expect(msgs[0].content).toContain('文风仿写');
    // 黑名单已注入且明确为禁止
    expect(msgs[0].content).toContain('【黑名单短语】');
    expect(msgs[0].content).toContain('倒吸一口凉气');
  });
});
