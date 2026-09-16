/**
 * 本书参考源（拆书模板书 → 仅本书文风注入）单测
 *
 * 目标不变量：
 * 1. 抽样：首/中/尾均匀、跳过不可用章、控字数、可复现；
 * 2. 注入：参考源**优先**于档案库激活档案，且**不进档案库**（styleProfiles 不被写入）；
 * 3. 归一化：外部 JSON 形状不合格一律丢弃；
 * 4. 落盘：清理/覆盖式合并不会把参考源冲掉；备份往返保留。
 */
import { describe, expect, it } from 'vitest';
import {
  getReferenceStyleProfile,
  resolveStyleForInjection,
  resolveInjectionProfile,
  setReferenceProfile,
  clearReferenceProfile,
  normalizeReferenceProfile,
  getActiveStyleProfile,
  mergeStyleConfigPreserve,
} from '../src/services/styleImitate';
import { sampleProseForStyle } from '../src/services/bookDeconstruct';
import { analyzeStyleFingerprint } from '../src/services/styleFingerprint';
import { buildChapterProsePrompt } from '../src/services/prompts';
import { getDefaultStyleConfig } from '../src/services/storage';
import {
  sanitizeProjectForExport,
  normalizeImportedProject,
} from '../src/services/projectTransfer';
import type {
  BookProject,
  Chapter,
  ReferenceStyleProfile,
  StyleConfig,
  StyleProfile,
} from '../src/types/novel';

// ── 夹具 ────────────────────────────────────────────────────────────────

function chapter(number: number, body: string): Chapter {
  return {
    id: `ch-${number}`,
    number,
    title: `第${number}章`,
    summary: '',
    content: body,
    wordCount: body.length,
  } as unknown as Chapter;
}

/** 一章「够用」的正文（超过 MIN_CHAPTER_CHARS=60） */
const LONG = '他推开门，风灌进领口。'.repeat(12);

function fakeProfile(name = '拆书参考文风'): StyleProfile {
  return {
    id: `ref-profile-${name}`,
    name,
    sourceLabel: '拆书模板：测试模板书',
    fingerprint: analyzeStyleFingerprint(LONG),
    styleGuide: '短句连射；对白扛剧情；动词优先，修饰退位。',
    doList: ['一半以上句子 ≤12 字'],
    dontList: ['禁止章末升华'],
    authorStyle: '短句冲锋枪节奏',
    sampleExcerpt: LONG.slice(0, 200),
    analysis: '测试用档案',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
  };
}

function fakeReference(overrides?: Partial<ReferenceStyleProfile>): ReferenceStyleProfile {
  return {
    projectId: 'proj-dec-1',
    sourceLabel: '拆书模板：测试模板书',
    sampledChapterNumbers: [1, 2, 3],
    sampleChars: 3600,
    profile: fakeProfile(),
    derivedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

// ── 1. 抽样 ─────────────────────────────────────────────────────────────

describe('sampleProseForStyle · 参考源抽样', () => {
  it('均匀取样：含首尾、数量受控、结果可复现', () => {
    const chapters = Array.from({ length: 20 }, (_, i) => chapter(i + 1, LONG));
    const a = sampleProseForStyle(chapters, { chapterCount: 10 });
    const b = sampleProseForStyle(chapters, { chapterCount: 10 });
    expect(a.chapterNumbers).toHaveLength(10);
    expect(a.chapterNumbers[0]).toBe(1);
    expect(a.chapterNumbers[a.chapterNumbers.length - 1]).toBe(20);
    // 章号严格递增（保持阅读顺序）
    expect([...a.chapterNumbers].sort((x, y) => x - y)).toEqual(a.chapterNumbers);
    expect(b).toEqual(a);
  });

  it('跳过不可用的章（空正文 / 抓取失败占位 / 过短）', () => {
    const chapters = [
      chapter(1, LONG),
      chapter(2, ''),
      chapter(3, '【抓取失败: 反爬拦截】'),
      chapter(4, '太短'),
      chapter(5, LONG),
    ];
    const r = sampleProseForStyle(chapters, { chapterCount: 10 });
    expect(r.chapterNumbers).toEqual([1, 5]);
  });

  it('无可用章 → 空样本（不抛错、不产出垃圾）', () => {
    const r = sampleProseForStyle([chapter(1, ''), chapter(2, '短')]);
    expect(r.text).toBe('');
    expect(r.chapterNumbers).toEqual([]);
    expect(r.charCount).toBe(0);
  });

  it('控字数：长书抽样后不超过上限', () => {
    const big = '正文内容'.repeat(800); // 单章远超每章配额
    const chapters = Array.from({ length: 60 }, (_, i) => chapter(i + 1, big));
    const r = sampleProseForStyle(chapters, { chapterCount: 10, maxChars: 4200 });
    expect(r.charCount).toBeLessThanOrEqual(4400);
    // 每章都截头留尾（省 token 但保留起手式与收束习惯）
    expect(r.text).toContain('……');
  });

  it('短书全取，不做无意义的截断', () => {
    const chapters = [chapter(1, LONG), chapter(2, LONG)];
    const r = sampleProseForStyle(chapters, { chapterCount: 10 });
    expect(r.chapterNumbers).toEqual([1, 2]);
    expect(r.text).not.toContain('……');
  });
});

// ── 2. 注入解析优先级 ───────────────────────────────────────────────────

describe('resolveStyleForInjection · 参考源优先', () => {
  it('有参考源 → 用它，且 fromReference=true（即使档案库另有激活档案）', () => {
    const base = getDefaultStyleConfig();
    const saved = fakeProfile('档案库档案');
    const cfg: StyleConfig = {
      ...base,
      styleProfiles: [saved],
      activeStyleProfileId: saved.id,
    };
    const withRef = setReferenceProfile(cfg, fakeReference());
    const r = resolveStyleForInjection(withRef);
    expect(r.fromReference).toBe(true);
    expect(r.profile?.name).toBe('拆书参考文风');
    expect(resolveInjectionProfile(withRef)?.name).toBe('拆书参考文风');
    // 参考源不进档案列表：原档案仍在、激活 id 未被改写
    expect(withRef.styleProfiles?.map((p) => p.id)).toEqual([saved.id]);
    expect(withRef.activeStyleProfileId).toBe(saved.id);
  });

  it('无参考源 → 回落激活档案（fromReference=false）', () => {
    const saved = fakeProfile('档案库档案');
    const cfg: StyleConfig = {
      ...getDefaultStyleConfig(),
      styleProfiles: [saved],
      activeStyleProfileId: saved.id,
    };
    expect(resolveStyleForInjection(cfg)).toEqual({ profile: saved, fromReference: false });
  });

  it('两者都没有 → null；清除参考源后回落档案', () => {
    expect(resolveInjectionProfile(getDefaultStyleConfig())).toBeNull();
    const saved = fakeProfile('档案库档案');
    const cfg: StyleConfig = {
      ...getDefaultStyleConfig(),
      styleProfiles: [saved],
      activeStyleProfileId: saved.id,
    };
    const cleared = clearReferenceProfile(setReferenceProfile(cfg, fakeReference()));
    expect(cleared.referenceProfile).toBeUndefined();
    expect(resolveInjectionProfile(cleared)?.name).toBe('档案库档案');
  });

  it('参考源不是「激活档案」：getActiveStyleProfile 仍为 null', () => {
    const cfg = setReferenceProfile(getDefaultStyleConfig(), fakeReference());
    expect(getReferenceStyleProfile(cfg)?.name).toBe('拆书参考文风');
    expect(getActiveStyleProfile(cfg)).toBeNull();
  });
});

// ── 3. 写手 prompt 注入（真正的注入点）──────────────────────────────────

describe('写手 prompt · 参考源真的注入且不落档案', () => {
  it('参考源进入 systemPrompt，profile 列表保持为空', () => {
    const cfg = setReferenceProfile(getDefaultStyleConfig(), fakeReference());
    const ch = { number: 1, title: '试', summary: '试' } as unknown as Chapter;
    const msgs = buildChapterProsePrompt(
      ch,
      [],
      [],
      [],
      cfg,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '玄幻'
    );
    expect(msgs[0].content).toContain('拆书参考文风');
    expect(msgs[0].content).toContain('短句连射');
    // 没有写进档案库/档案列表
    expect(cfg.styleProfiles || []).toEqual([]);
    expect(cfg.activeStyleProfileId ?? null).toBeNull();
  });
});

// ── 4. 归一化 ───────────────────────────────────────────────────────────

describe('normalizeReferenceProfile · 不信任外部 JSON', () => {
  it('合法输入保留关键字段', () => {
    const r = normalizeReferenceProfile(fakeReference());
    expect(r?.projectId).toBe('proj-dec-1');
    expect(r?.sourceLabel).toBe('拆书模板：测试模板书');
    expect(r?.sampledChapterNumbers).toEqual([1, 2, 3]);
    expect(r?.profile.name).toBe('拆书参考文风');
  });

  it('缺 profile / 缺指纹 / 非对象 → undefined', () => {
    expect(normalizeReferenceProfile(null)).toBeUndefined();
    expect(normalizeReferenceProfile('x')).toBeUndefined();
    expect(normalizeReferenceProfile({})).toBeUndefined();
    expect(
      normalizeReferenceProfile({ projectId: 'p', profile: { name: 'x' } })
    ).toBeUndefined();
  });

  it('收敛脏字段（章号非数字/空值、超长名、负字数、缺 derivedAt）', () => {
    const r = normalizeReferenceProfile({
      projectId: 'p1',
      sourceLabel: 'x'.repeat(200),
      sampledChapterNumbers: [1, '2', null, Number.NaN, 3, '', true],
      sampleChars: -5,
      profile: { ...fakeProfile(), name: 'n'.repeat(200) },
    });
    // null/''/true 不能变成「第 0/1 章」——Number(null)===0 是本项目踩过的坑
    expect(r?.sampledChapterNumbers).toEqual([1, 2, 3]);
    expect(r?.sampleChars).toBe(0);
    expect(r?.sourceLabel.length).toBeLessThanOrEqual(80);
    expect(r?.profile.name.length).toBeLessThanOrEqual(40);
    expect(typeof r?.derivedAt).toBe('string');
  });
});

// ── 5. 合并与备份往返 ───────────────────────────────────────────────────

describe('落盘与备份 · 参考源不被冲掉', () => {
  it('mergeStyleConfigPreserve：patch 未带该字段时保留；显式 undefined 才清除', () => {
    const withRef = setReferenceProfile(getDefaultStyleConfig(), fakeReference());
    const kept = mergeStyleConfigPreserve(withRef, { enforceShowDontTell: true });
    expect(kept.referenceProfile?.projectId).toBe('proj-dec-1');
    const cleared = mergeStyleConfigPreserve(withRef, { referenceProfile: undefined });
    expect(cleared.referenceProfile).toBeUndefined();
  });

  it('导出 → 导入 往返保留参考源（且仍不进档案列表）', () => {
    const book = {
      id: 'proj-writer-1',
      title: '我在写的书',
      genre: '东方玄幻',
      synopsis: '',
      createdAt: '2026-09-15T00:00:00.000Z',
      lastModified: '2026-09-15T00:00:00.000Z',
      wizardStep: 'ready',
      config: {
        inspiration: '',
        genre: '东方玄幻',
        targetChapterCount: 1,
        targetWordCountPerChapter: 2000,
        writingStyle: '',
        customParameters: {},
      },
      styleConfig: setReferenceProfile(getDefaultStyleConfig(), fakeReference()),
      characters: [],
      settings: [],
      volumes: [],
      chapters: [chapter(1, LONG)],
    } as unknown as BookProject;

    const clean = sanitizeProjectForExport(book);
    const { project } = normalizeImportedProject(clean);
    expect(project.styleConfig.referenceProfile?.projectId).toBe('proj-dec-1');
    expect(project.styleConfig.referenceProfile?.profile.name).toBe('拆书参考文风');
    expect(project.styleConfig.styleProfiles || []).toEqual([]);
  });
});
