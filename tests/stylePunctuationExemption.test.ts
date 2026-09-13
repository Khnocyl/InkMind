/**
 * 标点豁免口径单测：书级开关「允许破折号」必须与确定性机检同样穿透到 LLM 侧。
 * 背景：resolveAllowEmDash 是两路取或（书级开关 OR 档案 ellipsis-emphatic），但
 * 文笔润色 prompt 此前只认档案声明——开了书级开关的书，机检放行而润色照样把
 * —— 当 AI 味删掉，同一开关在两条链路上行为矛盾。
 */
import { describe, expect, it } from 'vitest';
import { buildStyleReviewPrompt } from '../src/services/prompts';
import {
  resolveAllowEmDash,
  importStyleProfile,
} from '../src/services/styleImitate';
import {
  XISHEN_STYLE_PROFILE,
  TUDOU_STYLE_PROFILE,
} from '../src/services/stylePresets';
import { getDefaultStyleConfig } from '../src/services/storage';

const prose = '他停在门口，指尖抵着那扇门。';

function systemOf(cfg: Parameters<typeof buildStyleReviewPrompt>[1]): string {
  const msgs = buildStyleReviewPrompt(prose, cfg, []);
  return msgs[0].content;
}

describe('标点豁免 · resolveAllowEmDash 两路取或', () => {
  it('书级开关开启即放行（无需档案声明）', () => {
    const cfg = { ...getDefaultStyleConfig(), allowEmDash: true };
    expect(resolveAllowEmDash(cfg)).toBe(true);
  });

  it('档案声明 ellipsis-emphatic 亦放行', () => {
    const cfg = importStyleProfile(getDefaultStyleConfig(), XISHEN_STYLE_PROFILE, {
      activate: true,
    });
    expect(cfg.allowEmDash).not.toBe(true);
    expect(resolveAllowEmDash(cfg)).toBe(true);
  });

  it('两者皆无 → 不放行', () => {
    const cfg = importStyleProfile(getDefaultStyleConfig(), TUDOU_STYLE_PROFILE, {
      activate: true,
    });
    expect(resolveAllowEmDash(cfg)).toBe(false);
  });
});

describe('文笔润色 prompt · 标点豁免穿透', () => {
  it('书级「允许破折号」开启 → 润色 prompt 明确保护破折号（不再当 AI 味删）', () => {
    const cfg = {
      ...importStyleProfile(getDefaultStyleConfig(), TUDOU_STYLE_PROFILE, {
        activate: true,
      }),
      allowEmDash: true,
    };
    const sys = systemOf(cfg);
    expect(sys).toContain('标点豁免');
    expect(sys).toContain('破折号');
    // 只保护破折号：未声明 ellipsis-emphatic 时不得连带保护省略号
    expect(sys).not.toContain('省略号「……」');
  });

  it('档案声明 ellipsis-emphatic → 省略号与破折号一起保护（原行为保留）', () => {
    const cfg = importStyleProfile(getDefaultStyleConfig(), XISHEN_STYLE_PROFILE, {
      activate: true,
    });
    const sys = systemOf(cfg);
    expect(sys).toContain('标点豁免');
    expect(sys).toContain('省略号「……」');
    expect(sys).toContain('破折号「——」');
  });

  it('两者皆无 → 不出现豁免块（通用去AI味口径不变）', () => {
    const cfg = importStyleProfile(getDefaultStyleConfig(), TUDOU_STYLE_PROFILE, {
      activate: true,
    });
    expect(systemOf(cfg)).not.toContain('标点豁免');
  });

  it('无激活档案但开了书级开关 → 仍保护破折号', () => {
    const cfg = { ...getDefaultStyleConfig(), allowEmDash: true };
    const sys = systemOf(cfg);
    expect(sys).toContain('标点豁免');
    expect(sys).toContain('破折号');
  });

  it('编号连续（保护条款接入执行序号，不乱号）', () => {
    const cfg = importStyleProfile(getDefaultStyleConfig(), XISHEN_STYLE_PROFILE, {
      activate: true,
    });
    const sys = systemOf(cfg);
    expect(sys).toMatch(/8\. 保持文风档案/);
    expect(sys).toMatch(/9\. 向档案语感收敛/);
    expect(sys).toMatch(/10\. 标点豁免/);
  });
});

describe('文笔润色 prompt · 基础结构', () => {
  it('正文进入 user prompt，角色名单可空', () => {
    const cfg = { ...getDefaultStyleConfig(), allowEmDash: true };
    const msgs = buildStyleReviewPrompt(prose, cfg, []);
    expect(msgs[1].content).toContain(prose);
    expect(msgs[1].content).toContain('【出场角色名】（未绑定）');
  });
});
