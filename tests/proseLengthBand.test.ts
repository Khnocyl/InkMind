import { describe, expect, it } from 'vitest';
import {
  countProseWords,
  deriveWordBand,
  trimProseAddition,
} from '../src/services/wordCount';
import {
  buildChapterExpandPrompt,
  buildChapterProsePrompt,
  buildConflictFixPrompt,
} from '../src/services/prompts';
import type { Chapter, Character, PlotBeat, StyleConfig, WorldSetting } from '../src/types/novel';

/** 最小 StyleConfig 桩（可选链路径安全） */
const styleStub = {
  fewShotExamples: [],
  clicheBlacklist: [],
  customBlacklist: [],
} as unknown as StyleConfig;

const chapterStub: Pick<Chapter, 'number' | 'title' | 'summary'> = {
  number: 3,
  title: '试炼',
  summary: '主角进入秘境试炼，遭遇伏击。',
};

const beats: PlotBeat[] = [{ order: 1, description: '遭遇伏击并反杀', focusSense: null } as PlotBeat];

describe('proseLengthBand · trimProseAddition 句界软裁剪', () => {
  it('合计未超上限 → 原样返回且不标记裁剪', () => {
    const base = '字'.repeat(1500);
    const add = `第一段结尾。${'字'.repeat(300)}`;
    const r = trimProseAddition(base, add, 2200);
    expect(r.trimmed).toBe(false);
    expect(r.text).toBe(add);
  });

  it('合计超上限 → 在句末标点截短并落在预算内', () => {
    const base = '字'.repeat(1500);
    const s1 = `甲句收尾。${'乙'.repeat(400)}`;
    const s2 = `丙段内容。${'丁'.repeat(500)}`;
    const add = `${s1}\n\n${s2}`;
    const max = 2000; // 预算 = 500 字
    const r = trimProseAddition(base, add, max);
    expect(r.trimmed).toBe(true);
    // 截到第一个「。」后：base + 截段 ≤ max
    expect(base.length + r.text.length).toBeLessThanOrEqual(max + 1); // 容忍 1 字符口径差
    expect(r.text.startsWith('甲句收尾。')).toBe(true);
    expect(r.text.endsWith('。')).toBe(true);
    expect(r.text).not.toContain('丁');
  });

  it('剩余空间过小（<120）→ 不动刀原样放行', () => {
    const base = '字'.repeat(2140);
    const add = `句子。${'字'.repeat(300)}`;
    const r = trimProseAddition(base, add, 2200);
    expect(r.trimmed).toBe(false);
    expect(r.text).toBe(add);
  });

  it('无上限（Infinity）或非法值 → 永不裁剪', () => {
    const base = 'a'.repeat(10);
    const add = 'b'.repeat(100);
    expect(trimProseAddition(base, add, Number.POSITIVE_INFINITY).trimmed).toBe(false);
    expect(trimProseAddition(base, add, 0).trimmed).toBe(false);
  });

  it('找不到合适句界 → 原样放行不硬切', () => {
    const base = '字'.repeat(1500);
    const add = 'b'.repeat(600); // 无任何标点
    const r = trimProseAddition(base, add, 1800);
    expect(r.trimmed).toBe(false);
    expect(r.text).toBe(add);
  });

  it('空白占比高的章节按比值换算上限（修单位错配过度裁剪）', () => {
    const para = '对话内容。';
    const base = (para + '\n\n').repeat(60); // 去空白 300 · 原始 420 → ratio 1.4
    const add = `他抬手一枪。${'硝烟'.repeat(30)}散去。${'很'.repeat(400)}`;
    const r = trimProseAddition(base, add, 400);
    // 旧实现：预算 = 400 − 420 < 0 → 整块放行（超写 469 字）；
    // 新实现：maxRaw = 400×1.4 = 560 → 预算 140，在句界 68 处截短
    expect(r.trimmed).toBe(true);
    expect(r.text.endsWith('。')).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(141);
    expect(base.length + r.text.length).toBeLessThanOrEqual(561);
    expect(r.text.startsWith('他抬手一枪。')).toBe(true);
  });

  it('countProseWords 去空白计数口径保持', () => {
    expect(countProseWords('你好 世界 \n 次！')).toBe(6);
  });
});

describe('proseLengthBand · 修复环字数带（待修清单）', () => {
  const style = styleStub;
  const conflicts = [{ type: '吃书', description: '第2段与设定冲突' }];

  it('deriveWordBand：有目标用 ±10%，无目标相对原稿', () => {
    expect(deriveWordBand(2000, '')).toEqual({ low: 1800, high: 2200 });
    // 原稿 2000 字、无目标 → 相对带
    const rel = deriveWordBand(null, '字'.repeat(2000));
    expect(rel.low).toBe(1800);
    expect(rel.high).toBe(2200);
  });

  it('buildConflictFixPrompt：带约束时声明等量替换与区间', () => {
    const msgs = buildConflictFixPrompt(
      '原文正文。',
      conflicts,
      style,
      [],
      [],
      { low: 1800, high: 2200 }
    );
    expect(msgs[0].content).toContain('等量替换');
    expect(msgs[0].content).toContain('1800–2200');
    expect(msgs[1].content).toContain('【字数上限】');
    expect(msgs[1].content).toContain('能用 localPatches 就不要整章重写');
  });

  it('buildConflictFixPrompt：不带约束时不出现区间文案', () => {
    const msgs = buildConflictFixPrompt('正文。', conflicts, style, [], []);
    expect(msgs[0].content).not.toContain('等量替换');
    expect(msgs[1].content).not.toContain('【字数上限】');
  });
});

describe('proseLengthBand · 提示词区间语义', () => {
  it('补写模板：输出目标区间、严禁越上限，弃用「至少再写」地板措辞', () => {
    const msgs = buildChapterExpandPrompt({
      chapter: chapterStub,
      existingProse: '已有正文。',
      currentWords: 1400,
      targetWordCount: 2000,
      minWordCount: 1800,
      maxWordCount: 2200,
      needMore: 480,
      beats,
      styleConfig: styleStub,
    });
    const sys = msgs[0].content;
    const user = msgs[1].content;
    expect(sys).toContain('1800–2200');
    expect(sys).toContain('严禁越过 2200');
    expect(sys).toContain('不要三两句就收');
    expect(sys).not.toContain('至少再写');
    expect(sys).not.toContain('宁少勿超');
    expect(user).toContain('目标区间 1800–2200');
    expect(user).toContain('写到合计进入区间即以收束句停笔');
  });

  it('补写模板：maxWordCount 缺省时按 target×1.1 计算', () => {
    const msgs = buildChapterExpandPrompt({
      chapter: chapterStub,
      existingProse: '正文。',
      currentWords: 1500,
      targetWordCount: 2000,
      minWordCount: 1800,
      needMore: 380,
      beats: [],
      characters: [] as Character[],
      styleConfig: styleStub,
    });
    expect(msgs[0].content).toContain('1800–2200');
  });

  it('通用衔接语法不随文风开关：应答式开头 + 装置纪律 + 分镜承接（默认分支即生效）', () => {
    const messages = buildChapterProsePrompt(
      { ...chapterStub, id: 'c1', wordCount: 0, status: '细纲就绪', content: '', volumeId: '', volumeNumber: 1, involvedCharacterIds: [], involvedSettingIds: [], beats: [], lastModified: '' },
      beats,
      [] as Character[],
      [] as WorldSetting[],
      styleStub,
      '……上章末段。他说："你完了。"',
      undefined,
      undefined,
      undefined,
      2000
    );
    const sys = messages[0].content;
    const user = messages[1].content;
    expect(sys).toContain('应答式开头');
    expect(sys).toContain('对话用对话接');
    expect(sys).toContain('风格装置挂载纪律（无论使用哪种文风）');
    expect(user).toContain('首句承接上一 Beat 末句的现场');
  });

  it('首稿模板：字数规则同时声明下限与上限失格', () => {
    const settings = [] as WorldSetting[];
    const characters = [] as Character[];
    const messages = buildChapterProsePrompt(
      { ...chapterStub, id: 'c1', wordCount: 0, status: '细纲就绪', content: '', volumeId: '', volumeNumber: 1, involvedCharacterIds: [], involvedSettingIds: [], beats: [], lastModified: '' },
      beats,
      characters,
      settings,
      styleStub,
      undefined,
      undefined,
      undefined,
      undefined,
      2000
    );
    const sys = messages[0].content;
    expect(sys).toContain('必须落在 1800–2200');
    expect(sys).toContain('超过 2200 同样视为失败');
    expect(sys).toContain('推进到下限以上');
    expect(sys).not.toContain('宁少勿超');
    expect(sys).not.toContain('写不够视为失败');
  });
});
