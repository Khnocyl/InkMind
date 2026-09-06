import { describe, it, expect } from 'vitest';
import {
  scanAiTastePatterns,
  mergeExtendedBlacklist,
  mergeAiTasteIntoRuleHits,
  applyAiTasteHitsAsRevisionTodos,
  findProseSnippetRange,
  type RuleScanHitLike,
} from '../src/services/aiTasteScan';
import type { Chapter, StyleConfig } from '../src/types/novel';

function style(over: Partial<StyleConfig> = {}): StyleConfig {
  return {
    clicheBlacklist: [],
    customBlacklist: [],
    fewShotExamples: [],
    selectedExampleId: '',
    enforceShowDontTell: true,
    forbidEndingSublimation: true,
    ...over,
  } as StyleConfig;
}

function chapter(over: Partial<Chapter> = {}): Chapter {
  return {
    id: 'ch1',
    number: 1,
    title: '第一章',
    summary: '',
    wordCount: 0,
    status: '正文草稿',
    content: '',
    involvedCharacterIds: [],
    involvedSettingIds: [],
    beats: [],
    lastModified: '',
    ...over,
  } as unknown as Chapter;
}

describe('scanAiTastePatterns 干净文本', () => {
  it('无套路句式 → clean / 100 分 / 零命中', () => {
    const prose =
      '雨停了。他推开窗，看见巷口有人撑着伞走过。风从檐下穿堂而过，湿土的气息扑面而来。';
    const r = scanAiTastePatterns(prose);
    expect(r.tier).toBe('clean');
    expect(r.score).toBe(100);
    expect(r.hits).toHaveLength(0);
    expect(r.blockGreen).toBe(false);
  });
});

describe('scanAiTastePatterns Gate G 解释腔', () => {
  it('「他不知道的是」→ [G] 命中并计入 expositionHits', () => {
    const prose =
      '他不知道的是，门后已经站着三个人。他压下呼吸，握紧剑柄，一步迈出。';
    const r = scanAiTastePatterns(prose);
    const g = r.hits.find((h) => h.phrase.startsWith('[G]'));
    expect(g).toBeDefined();
    expect(g!.phrase).toContain('不知道的是');
    expect(r.metrics.expositionHits).toBeGreaterThan(0);
  });

  it('白名单含该词 → 命中被过滤', () => {
    const prose =
      '他不知道的是，门后已经站着三个人。他压下呼吸，握紧剑柄，一步迈出。';
    const r = scanAiTastePatterns(prose, style({ aiTasteWhitelist: ['他不知道的是'] }));
    expect(r.hits.some((h) => h.phrase.startsWith('[G]'))).toBe(false);
    expect(r.metrics.expositionHits).toBe(0);
  });

  it('多个解释腔词 → heavy 级', () => {
    const prose =
      '他不知道的是，门后有埋伏。殊不知，这一切都是安排好的。这意味着，真正的考验才刚刚开始。仿佛预示着，山雨欲来风满楼。';
    const r = scanAiTastePatterns(prose);
    expect(r.metrics.expositionHits).toBeGreaterThanOrEqual(4);
    expect(r.tier).toBe('heavy');
  });

  it('heavy + aiTasteBlockHeavy → blockGreen 阻断', () => {
    const prose =
      '他不知道的是，门后有埋伏。殊不知，这一切都是安排好的。这意味着，真正的考验才刚刚开始。仿佛预示着，山雨欲来风满楼。';
    const r = scanAiTastePatterns(prose, style({ aiTasteBlockHeavy: true }));
    expect(r.blockGreen).toBe(true);
    expect(r.summary).toContain('重度阻断');
  });
});

describe('scanAiTastePatterns Gate B 句式', () => {
  it('「不是…而是…」→ [B] 命中', () => {
    const prose =
      '他不是在犹豫，而是在等待时机。月光落在刀锋上，映出一线寒芒，他缓缓吐出一口浊气。';
    const r = scanAiTastePatterns(prose);
    const b = r.hits.find((h) => h.phrase.startsWith('[B]'));
    expect(b).toBeDefined();
    expect(b!.phrase).toContain('不是');
  });

  it('同一否定句式出现 2 次 → 升 error', () => {
    const prose =
      '他不是在犹豫，而是在等待时机。他不是在害怕，而是在准备反击。他握紧刀柄，缓缓起身，月光如霜。';
    const r = scanAiTastePatterns(prose);
    const b = r.hits.find((h) => h.phrase.startsWith('[B]') && h.phrase.includes('不是'));
    expect(b).toBeDefined();
    expect(b!.severity).toBe('error');
  });

  it('strict 模式：句式出现 3 次 → warn 升 error', () => {
    const prose =
      '他不是在犹豫，而是在等待时机。他不是在害怕，而是在准备反击。他不是在退缩，而是在蓄力待发。';
    const r = scanAiTastePatterns(prose, style({ aiTasteStrict: true }));
    const b = r.hits.find((h) => h.phrase.startsWith('[B]') && h.phrase.includes('不是'));
    expect(b).toBeDefined();
    expect(b!.severity).toBe('error');
  });
});

describe('scanAiTastePatterns Gate D 节奏', () => {
  it('连续三段落以相同主语+逗号起句 → 排比 warn', () => {
    const prose = '他，推开院门。\n他，穿过长廊。\n他，停在井边。';
    const r = scanAiTastePatterns(prose);
    expect(r.metrics.parallelRuns).toBe(1);
    const d = r.hits.find((h) => h.phrase.includes('[D]') && h.phrase.includes('排比'));
    expect(d).toBeDefined();
    expect(d!.severity).toBe('warn');
  });

  it('两组独立连续排比（各 3 段）→ 排比升 error 且 tier heavy', () => {
    const prose =
      '他，推开院门。\n他，穿过长廊。\n他，停在井边。\n她，点亮油灯。\n她，铺开信纸。\n她，写下第一行。';
    const r = scanAiTastePatterns(prose);
    expect(r.metrics.parallelRuns).toBeGreaterThanOrEqual(2);
    const d = r.hits.find((h) => h.phrase.includes('[D]') && h.phrase.includes('排比'));
    expect(d).toBeDefined();
    expect(d!.severity).toBe('error');
    expect(r.tier).toBe('heavy');
  });
});

describe('scanAiTastePatterns Gate E 对话标签', () => {
  it('对话标签过密 → [E] 命中', () => {
    const prose =
      '“你来了。”他说道。\n“嗯。”她说道。\n“路上可还顺利？”他问道。\n“还好。”她说道。';
    const r = scanAiTastePatterns(prose);
    expect(r.metrics.dialogueLines).toBeGreaterThanOrEqual(4);
    expect(r.metrics.dialogueTagRatio).toBeGreaterThan(0.55);
    const e = r.hits.find((h) => h.phrase.startsWith('[E]'));
    expect(e).toBeDefined();
  });
});

describe('scanAiTastePatterns Gate F 碎句连发', () => {
  it('连续 3 句 ≤6 字（非对白）→ [F] 命中 warn', () => {
    const prose = '他走了。门关了。灯灭了。风起了。';
    const r = scanAiTastePatterns(prose);
    const f = r.hits.find((h) => h.phrase.startsWith('[F]'));
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warn');
    expect(f!.phrase).toContain('碎句连发');
    expect(f!.count).toBeGreaterThanOrEqual(1);
  });

  it('短句中间有长句打断 → 不构成连发', () => {
    const prose = '他走了。夜色如墨，冷风从巷口灌进来。门关了。';
    const r = scanAiTastePatterns(prose);
    expect(r.hits.some((h) => h.phrase.startsWith('[F]'))).toBe(false);
  });

  it('对白短句不计入连发（豁免）', () => {
    const prose = '“走。”“嗯。”“好。”';
    const r = scanAiTastePatterns(prose);
    expect(r.hits.some((h) => h.phrase.startsWith('[F]'))).toBe(false);
  });

  it('正常叙述不误报', () => {
    const prose =
      '他推开院门，冷风扑面而来。灯笼在檐下晃了两下，光影斑驳地落在青石板上。';
    const r = scanAiTastePatterns(prose);
    expect(r.hits.some((h) => h.phrase.startsWith('[F]'))).toBe(false);
  });
});

describe('mergeExtendedBlacklist', () => {
  it('默认包含内置扩展套话表并去重', () => {
    const out = mergeExtendedBlacklist(
      style({ clicheBlacklist: ['眼中闪过一丝', '自定义词'] })
    );
    expect(out).toContain('眼中闪过一丝');
    expect(out).toContain('自定义词');
    // 去重：'眼中闪过一丝' 只在扩展表，不因重复出现两次
    expect(out.filter((x) => x === '眼中闪过一丝')).toHaveLength(1);
    expect(out).toContain('嘴角勾起一抹');
  });

  it('白名单精确相等 → 豁免对应套话', () => {
    const out = mergeExtendedBlacklist(
      style({ clicheBlacklist: ['眼中闪过一丝'], deslopWhitelist: ['眼中闪过一丝'] })
    );
    expect(out).not.toContain('眼中闪过一丝');
    expect(out).toContain('嘴角勾起一抹');
  });

  it('白名单 ≥4 字且占条目长度过半 → 豁免装饰变体', () => {
    const out = mergeExtendedBlacklist(
      style({ clicheBlacklist: ['眼中闪过一丝'], deslopWhitelist: ['眼中闪过'] })
    );
    expect(out).not.toContain('眼中闪过一丝');
  });

  it('短白名单词（<4 字子串）不再静默击穿黑名单', () => {
    const out = mergeExtendedBlacklist(
      style({ clicheBlacklist: ['眼中闪过一丝'], deslopWhitelist: ['眼中'] })
    );
    // 旧口径「包含即豁免」会误放行整条套话；收紧后仅精确/主导子串才豁免
    expect(out).toContain('眼中闪过一丝');
  });

  it('useExtendedClicheList=false → 不使用内置扩展表', () => {
    const out = mergeExtendedBlacklist(
      style({ clicheBlacklist: ['自定义'], useExtendedClicheList: false })
    );
    expect(out).toEqual(['自定义']);
  });
});

describe('mergeAiTasteIntoRuleHits', () => {
  it('同 phrase 合并取最大 count', () => {
    const base: RuleScanHitLike[] = [
      {
        kind: 'pattern',
        severity: 'warn',
        phrase: '[B]不是…而是…',
        count: 1,
        suggestion: 's',
      },
    ];
    const taste = scanAiTastePatterns(
      '他不是在犹豫，而是在等待时机。他不是在害怕，而是在准备反击。他不是在退缩，而是在蓄力。',
      undefined
    );
    const merged = mergeAiTasteIntoRuleHits(base, taste);
    const b = merged.find((h) => h.phrase === '[B]不是…而是…');
    expect(b).toBeDefined();
    expect(b!.count).toBe(3);
  });
});

describe('applyAiTasteHitsAsRevisionTodos', () => {
  const errorHit: RuleScanHitLike = {
    kind: 'pattern',
    severity: 'error',
    phrase: '[G]他不知道的是',
    count: 1,
    suggestion: '删旁白剧透',
  };
  const warnHit: RuleScanHitLike = {
    kind: 'pattern',
    severity: 'warn',
    phrase: '[E]对话标签过密',
    count: 4,
    suggestion: '用动作替代',
  };

  it('默认 errorsOnly：只写 error 命中', () => {
    const c = chapter();
    const r = applyAiTasteHitsAsRevisionTodos(c, [errorHit, warnHit]);
    expect(r.added).toBe(1);
    expect(r.chapter.revisionTodos![0].text).toContain('解释腔');
  });

  it('errorsOnly=false：warn 也写，标签映射 [E]→对话', () => {
    const c = chapter();
    const r = applyAiTasteHitsAsRevisionTodos(c, [warnHit], { errorsOnly: false });
    expect(r.added).toBe(1);
    expect(r.chapter.revisionTodos![0].text).toContain('[去AI·对话]');
  });

  it('无有效命中 → added 0 且返回原 chapter（不产生新对象）', () => {
    const c = chapter({ revisionTodos: [] });
    const r = applyAiTasteHitsAsRevisionTodos(c, []);
    expect(r.added).toBe(0);
    expect(r.chapter).toBe(c);
  });

  it('重复写入同一命中 → 第二次 added 0（key 去重）', () => {
    const c = chapter();
    const first = applyAiTasteHitsAsRevisionTodos(c, [errorHit]);
    expect(first.added).toBe(1);
    const second = applyAiTasteHitsAsRevisionTodos(first.chapter, [errorHit]);
    expect(second.added).toBe(0);
  });

  it('medium/heavy 且 errorsOnly：error 不足 3 时补充 warn（最多 4 条）', () => {
    const c = chapter();
    const r = applyAiTasteHitsAsRevisionTodos(
      c,
      [errorHit, warnHit],
      { tier: 'heavy', errorsOnly: true, max: 12 }
    );
    expect(r.added).toBe(2);
    const tags = r.chapter.revisionTodos!.map((t) => t.text);
    expect(tags.some((t) => t.includes('解释腔'))).toBe(true);
    expect(tags.some((t) => t.includes('对话'))).toBe(true);
  });

  it('max 限制写入条数', () => {
    const c = chapter();
    const many: RuleScanHitLike[] = Array.from({ length: 5 }, (_, i) => ({
      kind: 'pattern',
      severity: 'error',
      phrase: `[B]句式${i}`,
      count: 1,
      suggestion: 's',
    }));
    const r = applyAiTasteHitsAsRevisionTodos(c, many, { max: 3 });
    expect(r.added).toBe(3);
    expect(r.chapter.revisionTodos).toHaveLength(3);
  });
});

describe('findProseSnippetRange', () => {
  it('精确命中返回起止', () => {
    const content = '夜色深沉，他推开门，山风扑面。';
    const r = findProseSnippetRange(content, '他推开门');
    expect(r).toEqual({ start: 5, end: 9 });
  });

  it('长片段（>8 字）未精确命中时降级用前 8 字定位', () => {
    const content = '夜色深沉，他推开门，山风扑面而来。';
    const r = findProseSnippetRange(content, '他推开门，山风扑面吹得他衣袂翻飞');
    expect(r).not.toBeNull();
    expect(r!.start).toBe(content.indexOf('他推开门，山风扑面'));
    expect(r!.end).toBeLessThanOrEqual(content.length);
  });

  it('未命中 → null', () => {
    expect(findProseSnippetRange('短文本', '完全不存在的长片段')).toBeNull();
  });

  it('空 snippet / 空 content → null', () => {
    expect(findProseSnippetRange('abc', '')).toBeNull();
    expect(findProseSnippetRange('', 'abc')).toBeNull();
    expect(findProseSnippetRange('abc', '   ')).toBeNull();
  });
});

describe('scanAiTastePatterns · 句子级节奏（正面指标）', () => {
  it('句长均匀偏长的单调文本 → [D]句式节奏单调（极端单调升 error）', () => {
    // 25 句、每句约 28 字、句长几乎不变（段落有变化以隔离段落级检查）
    const sentence =
      '他沿着城墙根慢慢向前走着，尽量让自己的脚步声混进更夫的梆子声里，以免引起守夜人的注意。';
    const paras = Array.from({ length: 25 }, (_, i) =>
      i % 3 === 0 ? sentence : `${sentence}${sentence.slice(0, 14)}`
    ).join('\n');
    const report = scanAiTastePatterns(paras);
    const hit = report.hits.find((h) => h.phrase === '[D]句式节奏单调');
    expect(hit).toBeTruthy();
    expect(hit?.severity).toBe('error');
    expect(report.metrics.sentenceLenCv).toBeLessThan(0.7);
    expect(report.metrics.shortSentenceRatio).toBeLessThan(0.1);
  });

  it('长短句交错（变异系数高、短句多）→ 不报单调', () => {
    const text = [
      '雨停了。',
      '他没动。',
      '巷口的灯笼灭了一盏，剩下那盏在风里晃，把他的影子拉得很长很长，长到贴上对面的墙根，像一条趴着的黑狗。',
      '谁？',
      '没人应。',
      '他又等了三息，才把后背从墙上撑开，一步一步挪到灯笼底下，借着那点昏黄的光，看清了地上那滩还没干透的水渍里，印着半枚鞋印。',
      '不是他的。',
      '他蹲下去，伸手比了比。',
      '鞋印比他的脚小一号。',
    ].join('\n');
    const report = scanAiTastePatterns(text);
    expect(report.hits.find((h) => h.phrase === '[D]句式节奏单调')).toBeFalsy();
    expect(report.metrics.sentenceLenCv).toBeGreaterThan(0.7);
    expect(report.metrics.shortSentenceRatio).toBeGreaterThan(0.3);
  });
});

describe('scanAiTastePatterns · 换皮解释腔（真实稿件病例）', () => {
  it('判断句解说「那是……的位置」→ 命中', () => {
    const r = scanAiTastePatterns('叶无痕走在队伍正中间的三尺后处。那是整个阵型中承接首尾最容易变阵的位置。');
    expect(r.hits.some((h) => h.phrase.includes('判断句解说'))).toBe(true);
  });

  it('叙述者定性「仿佛只是在陈述……」→ 命中', () => {
    const r = scanAiTastePatterns('他语声平静，仿佛只是在陈述一条最基础的求生细则。');
    expect(r.hits.some((h) => h.phrase.includes('叙述者定性'))).toBe(true);
  });

  it('否定解说「没有做出任何多余解释」→ 命中', () => {
    const r = scanAiTastePatterns('叶无痕没有做出任何多余解释，左脚重重一踏地面发黑的腐木。');
    expect(r.hits.some((h) => h.phrase.includes('否定解说'))).toBe(true);
  });

  it('正常叙述不误伤', () => {
    const r = scanAiTastePatterns('他推门进去，把剑放在桌上。桌上摆着一只旧铅笔盒。');
    expect(r.hits.filter((h) => h.phrase.includes('解说') || h.phrase.includes('定性'))).toHaveLength(0);
  });

});
