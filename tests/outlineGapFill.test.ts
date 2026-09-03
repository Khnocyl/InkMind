/**
 * 占位章梗概补齐（fillPlaceholderChapters / isPlaceholderChapter）测试：
 * mock 掉 prompts 与 generateJSON 层，覆盖编排与无损语义：
 * 1. isPlaceholderChapter 各分支判定（待补全标题 / 【待补全】摘要 / <40 字 / 详案 false）
 * 2. 混合书（2 卷 6 章、3 占位跨两卷）：仅占位章被替换、status=细纲就绪、非占位章对象引用不变
 * 3. previousTail 携带前文详案章梗概（批前最近 3 个）+ 追加「不得改写其他章」约束消息
 * 4. 跨批衔接：第二批 previousTail 含首批刚补齐的详案
 * 5. 单批抛错：成功批计数正确、剩余正确、不 throw
 * 6. 无占位：filled=0 且零 LLM 调用
 * 7. 卷对象透传正确（title/summary 进 prompt 上下文）
 * 8. 新详案长度门槛（≥40 字才采用，35 字不采用）
 * 9. 标题替换规则：仅原标题含「待补全」才采纳模型标题
 * 10. involved 角色/设定 id 解析与无名字时回退原值
 * 11. 批区间内的非占位章即使被模型改写也不采用（对象引用不变）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Chapter, Volume, Character, WorldSetting, ProjectConfig } from '../src/types/novel';

const { generateJSONMock, buildOutlineChaptersBatchPromptMock } = vi.hoisted(() => ({
  generateJSONMock: vi.fn(),
  buildOutlineChaptersBatchPromptMock: vi.fn(),
}));

vi.mock('../src/services/llmClient', () => ({
  generateJSON: (...args: unknown[]) => generateJSONMock(...(args as [])),
}));

vi.mock('../src/services/prompts', () => ({
  buildOutlineChaptersBatchPrompt: (...args: unknown[]) =>
    buildOutlineChaptersBatchPromptMock(...(args as [])),
  buildOutlineVolumesPrompt: vi.fn(),
  buildOutlinePrompt: vi.fn(),
  resolveOutlineTotalChapters: () => 100,
  suggestVolumeCount: () => 4,
}));

import { fillPlaceholderChapters, isPlaceholderChapter } from '../src/services/outlineGenerate';

// ─── 夹具 ───
const BASE_CONFIG: ProjectConfig = {
  inspiration: '测试灵感',
  totalChapters: 6,
  writingStyle: '快节奏网文',
  genre: '玄幻',
};

const DETAIL =
  '主角林越推门而入，旧宅账册半掩在案头，虎符断口映着烛火，他一把收进怀中，转身隐入巷口夜色，身后更鼓已敲过两声。';

function makeVolume(
  partial: Partial<Volume> & {
    id: string;
    number: number;
    startChapter: number;
    endChapter: number;
  }
): Volume {
  return {
    id: partial.id,
    number: partial.number,
    title: partial.title ?? `第${partial.number}卷`,
    summary: partial.summary ?? `第${partial.number}卷摘要`,
    startChapter: partial.startChapter,
    endChapter: partial.endChapter,
  };
}

function makeChapter(partial: Partial<Chapter> & { number: number }): Chapter {
  return {
    id: `chap-${partial.number}`,
    number: partial.number,
    title: partial.title ?? `第${partial.number}章`,
    summary: partial.summary ?? '',
    wordCount: 0,
    status: '大纲待拆',
    content: '',
    volumeId: partial.volumeId ?? `vol-${partial.number}`,
    volumeNumber: partial.volumeNumber ?? 1,
    involvedCharacterIds: [],
    involvedSettingIds: [],
    beats: [],
    lastModified: '',
    ...partial,
  };
}

function makeCharacter(id: string, name: string): Character {
  return {
    id,
    name,
    alias: '',
    role: '主角',
    status: '活跃',
    realmOrTitle: '',
    currentLocation: '',
    personality: '',
    appearance: '',
    background: '',
    relations: [],
    secretNotes: '',
  };
}

function makeSetting(id: string, name: string): WorldSetting {
  return {
    id,
    category: '世界地理势力',
    name,
    description: '',
    hardRules: [],
    tags: [],
    isActive: true,
  };
}

function makeOptions(
  overrides: {
    volumes?: Volume[];
    chapters?: Chapter[];
    characters?: Character[];
    settings?: WorldSetting[];
  } = {}
) {
  return {
    config: BASE_CONFIG,
    title: '测试之书',
    synopsis: '主角林越身负旧账，踏足宗门风云。',
    characters: overrides.characters ?? [
      makeCharacter('c1', '林越'),
      makeCharacter('c2', '苏瑶'),
    ],
    settings: overrides.settings ?? [makeSetting('s1', '灵气复苏')],
    volumes: overrides.volumes ?? [],
    chapters: overrides.chapters ?? [],
  };
}

function draft(
  number: number,
  summary: string,
  title?: string,
  opts?: { chars?: string[]; sets?: string[] }
) {
  return {
    number,
    title: title ?? `第${number}章 新标题`,
    summary,
    involvedCharacterNames: opts?.chars,
    involvedSettingNames: opts?.sets,
  };
}

beforeEach(() => {
  generateJSONMock.mockReset();
  buildOutlineChaptersBatchPromptMock.mockReset();
  buildOutlineChaptersBatchPromptMock.mockReturnValue([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'user' },
  ]);
  generateJSONMock.mockImplementation(() => ({ chapters: [] }));
});

describe('isPlaceholderChapter · 占位判定各分支', () => {
  it('待补全标题 / 【待补全】摘要 / 短摘要判定为占位，正常详案为 false', () => {
    expect(isPlaceholderChapter({ title: '第3章 待补全', summary: DETAIL })).toBe(true);
    expect(
      isPlaceholderChapter({ title: '第3章 转折', summary: '【待补全】属「第一卷」，请补写本章冲突与钩子。' })
    ).toBe(true);
    expect(isPlaceholderChapter({ title: '第3章 转折', summary: '太短' })).toBe(true);
    expect(isPlaceholderChapter({ title: '第3章 转折', summary: DETAIL })).toBe(false);
  });

  it('以 40 字为界：恰好 40 字视为详案，39 字视为占位', () => {
    expect(isPlaceholderChapter({ title: 'x', summary: '字'.repeat(40) })).toBe(false);
    expect(isPlaceholderChapter({ title: 'x', summary: '字'.repeat(39) })).toBe(true);
  });
});

describe('fillPlaceholderChapters · 无损增量补齐', () => {
  it('混合书（2 卷 6 章、3 占位跨两卷）：仅占位章被替换，非占位章对象引用不变', async () => {
    const v1 = makeVolume({ id: 'vol-1', number: 1, startChapter: 1, endChapter: 3, title: '第一卷 风起', summary: '卷一要旨' });
    const v2 = makeVolume({ id: 'vol-2', number: 2, startChapter: 4, endChapter: 6, title: '第二卷 云涌', summary: '卷二要旨' });
    const ch1 = makeChapter({ number: 1, title: '第1章 启程', summary: DETAIL, volumeId: 'vol-1', volumeNumber: 1 });
    const ch2 = makeChapter({ number: 2, title: '第2章', summary: '待补充梗概', volumeId: 'vol-1', volumeNumber: 1 });
    const ch3 = makeChapter({ number: 3, title: '第3章 伏笔', summary: DETAIL, volumeId: 'vol-1', volumeNumber: 1 });
    const ch4 = makeChapter({ number: 4, title: '第4章 待补全', summary: '', volumeId: 'vol-2', volumeNumber: 2 });
    const ch5 = makeChapter({ number: 5, title: '第5章', summary: '【待补全】属「第二卷」，请补写本章剧情。', volumeId: 'vol-2', volumeNumber: 2 });
    const ch6 = makeChapter({ number: 6, title: '第6章 收束', summary: DETAIL, volumeId: 'vol-2', volumeNumber: 2 });
    const chapters = [ch1, ch2, ch3, ch4, ch5, ch6];

    const DRAFT_2 = '第二章详案：林越在夜市撞见苏瑶被围，出手化解并得到半枚令牌，章末令牌发烫引出新线索。';
    const DRAFT_4 = '第四章详案：苏瑶透露令牌来自宗门禁地，二人决定夜探，途中遭遇禁卫盘查，危急关头林越用灵力伪装过关。';
    const DRAFT_5 = '第五章详案：二人在禁地深处发现染血的阵法图，林越认出与父亲旧账册一致，正要拓印时石壁震动，石门正在关闭。';

    generateJSONMock
      .mockResolvedValueOnce({
        chapters: [draft(2, DRAFT_2, '第二章 风起', { chars: ['林越'], sets: ['灵气复苏'] })],
      })
      .mockResolvedValueOnce({
        chapters: [
          draft(4, DRAFT_4, '第四章 禁地线索', { chars: ['林越', '苏瑶'], sets: ['灵气复苏'] }),
          draft(5, DRAFT_5, '第五章 染血阵图', { chars: ['林越'] }),
        ],
      });

    const result = await fillPlaceholderChapters(makeOptions({ volumes: [v1, v2], chapters }));

    expect(result.filledCount).toBe(3);
    expect(result.remainingCount).toBe(0);
    expect(result.batchesRun).toBe(2);
    expect(result.chapters).toHaveLength(6);

    // 非占位章对象引用不变
    expect(result.chapters[0]).toBe(ch1);
    expect(result.chapters[2]).toBe(ch3);
    expect(result.chapters[5]).toBe(ch6);

    // 占位章被替换：summary 新详案、status 细纲就绪、id 不变
    const replaced2 = result.chapters[1];
    expect(replaced2.summary).toBe(DRAFT_2);
    expect(replaced2.status).toBe('细纲就绪');
    expect(replaced2.id).toBe('chap-2');
    // 原标题不含「待补全」→ 保留原标题
    expect(replaced2.title).toBe('第2章');
    expect(replaced2.involvedCharacterIds).toEqual(['c1']);
    expect(replaced2.involvedSettingIds).toEqual(['s1']);

    const replaced4 = result.chapters[3];
    expect(replaced4.title).toBe('第四章 禁地线索');
    expect(replaced4.status).toBe('细纲就绪');
    expect(replaced4.involvedCharacterIds).toEqual(['c1', 'c2']);
    expect(replaced4.involvedSettingIds).toEqual(['s1']);

    const replaced5 = result.chapters[4];
    expect(replaced5.summary).toBe(DRAFT_5);
    expect(replaced5.status).toBe('细纲就绪');
    expect(replaced5.involvedCharacterIds).toEqual(['c1']);
  });

  it('previousTail：携带批前最近详案章梗概，且追加「不得改写其他章」约束消息', async () => {
    const v1 = makeVolume({ id: 'vol-1', number: 1, startChapter: 1, endChapter: 3, title: '第一卷', summary: '卷一要旨' });
    const ch1 = makeChapter({ number: 1, title: '第1章 启程', summary: DETAIL, volumeId: 'vol-1', volumeNumber: 1 });
    const ch2 = makeChapter({ number: 2, title: '第2章', summary: '', volumeId: 'vol-1', volumeNumber: 1 });
    const ch3 = makeChapter({ number: 3, title: '第3章', summary: '', volumeId: 'vol-1', volumeNumber: 1 });

    generateJSONMock.mockResolvedValueOnce({
      chapters: [
        draft(2, '第二章详案：林越寻得半枚虎符，断口与账册夹痕吻合，章末巷口有人尾随，他闪身躲进檐下暗影。', '第二章 风起'),
        draft(3, '第三章详案：苏瑶登门揭出旧账册秘密，二人约定夜探禁地，门外却传来三声急促的敲门声。', '第三章 伏笔'),
      ],
    });

    await fillPlaceholderChapters(makeOptions({ volumes: [v1], chapters: [ch1, ch2, ch3] }));

    const opts = buildOutlineChaptersBatchPromptMock.mock.calls[0][0] as {
      fromChapter: number;
      toChapter: number;
      previousTail: { number: number; title: string; summary: string }[];
    };
    expect(opts.fromChapter).toBe(2);
    expect(opts.toChapter).toBe(3);
    expect(opts.previousTail).toEqual([{ number: 1, title: ch1.title, summary: ch1.summary }]);

    const messages = generateJSONMock.mock.calls[0][0] as { role: string; content: string }[];
    expect(messages[messages.length - 1].role).toBe('user');
    expect(messages[messages.length - 1].content).toContain('不要改写');
  });

  it('跨批衔接：第二批 previousTail 包含首批刚补齐的详案梗概', async () => {
    const v1 = makeVolume({ id: 'vol-1', number: 1, startChapter: 1, endChapter: 3, title: '第一卷', summary: '卷一要旨' });
    const v2 = makeVolume({ id: 'vol-2', number: 2, startChapter: 4, endChapter: 4, title: '第二卷', summary: '卷二要旨' });
    const ch1 = makeChapter({ number: 1, title: '第1章 启程', summary: DETAIL, volumeId: 'vol-1', volumeNumber: 1 });
    const ch2 = makeChapter({ number: 2, title: '第2章', summary: '', volumeId: 'vol-1', volumeNumber: 1 });
    const ch3 = makeChapter({ number: 3, title: '第3章', summary: '', volumeId: 'vol-1', volumeNumber: 1 });
    const ch4 = makeChapter({ number: 4, title: '第4章', summary: '', volumeId: 'vol-2', volumeNumber: 2 });

    const NEW_2 = '第二章详案：林越在旧宅账册夹层里发现半枚虎符，断口锈迹与父亲遗物一致，章末巷口传来急促的脚步声。';
    const NEW_3 = '第三章详案：苏瑶深夜登门，道出虎符与禁地秘辛，二人定下夜探之约，约定若事败便以暗号示警全身而退。';
    const NEW_4 = '第四章详案：二人摸黑潜入禁地外围，石阶下隐约浮出上古阵纹，林越认出是父亲手记里记载的封禁符文。';

    generateJSONMock
      .mockResolvedValueOnce({
        chapters: [draft(2, NEW_2, '第二章 风起'), draft(3, NEW_3, '第三章 伏笔')],
      })
      .mockResolvedValueOnce({ chapters: [draft(4, NEW_4, '第四章 禁地')] });

    const result = await fillPlaceholderChapters(
      makeOptions({ volumes: [v1, v2], chapters: [ch1, ch2, ch3, ch4] })
    );

    expect(result.filledCount).toBe(3);
    const opts2 = buildOutlineChaptersBatchPromptMock.mock.calls[1][0] as {
      fromChapter: number;
      previousTail: { number: number; title: string; summary: string }[];
    };
    expect(opts2.fromChapter).toBe(4);
    // 批前最近 3 个详案：第 1 章（原文）+ 第 2、3 章（首批刚补齐的新详案）
    expect(opts2.previousTail).toHaveLength(3);
    expect(opts2.previousTail).toContainEqual({ number: 2, title: '第2章', summary: NEW_2 });
    expect(opts2.previousTail).toContainEqual({ number: 3, title: '第3章', summary: NEW_3 });
    expect(opts2.previousTail).toContainEqual({ number: 1, title: ch1.title, summary: ch1.summary });
  });

  it('单批抛错：filledCount 只含成功批、remainingCount 正确、不 throw', async () => {
    const v1 = makeVolume({ id: 'vol-1', number: 1, startChapter: 1, endChapter: 2, title: '第一卷', summary: '卷一要旨' });
    const v2 = makeVolume({ id: 'vol-2', number: 2, startChapter: 3, endChapter: 4, title: '第二卷', summary: '卷二要旨' });
    const ch1 = makeChapter({ number: 1, title: '第1章', summary: '', volumeId: 'vol-1', volumeNumber: 1 });
    const ch2 = makeChapter({ number: 2, title: '第2章', summary: '', volumeId: 'vol-1', volumeNumber: 1 });
    const ch3 = makeChapter({ number: 3, title: '第3章', summary: '', volumeId: 'vol-2', volumeNumber: 2 });
    const ch4 = makeChapter({ number: 4, title: '第4章', summary: '', volumeId: 'vol-2', volumeNumber: 2 });
    const chapters = [ch1, ch2, ch3, ch4];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    generateJSONMock
      .mockResolvedValueOnce({
        chapters: [
          draft(1, '第一章详案：林越返乡发现父亲旧账册被人翻动，页脚多出一行陌生批注，他连夜赶往城南当铺打听下落。', '第一章 归乡'),
          draft(2, '第二章详案：账册夹层藏有半枚虎符，断口与父亲遗物吻合，窗外人影一闪而过，林越提灯追出三条街。', '第二章 虎符'),
        ],
      })
      .mockRejectedValueOnce(new Error('JSON 截断解析失败'));

    const result = await fillPlaceholderChapters(makeOptions({ volumes: [v1, v2], chapters }));

    expect(result.filledCount).toBe(2);
    expect(result.remainingCount).toBe(2);
    expect(result.batchesRun).toBe(2);
    // 成功批被替换
    expect(result.chapters[0].status).toBe('细纲就绪');
    expect(result.chapters[1].status).toBe('细纲就绪');
    // 失败批保持原占位（对象引用不变）
    expect(result.chapters[2]).toBe(ch3);
    expect(result.chapters[3]).toBe(ch4);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('无占位：直接返回 filled=0 且不发一次 LLM 调用', async () => {
    const v1 = makeVolume({ id: 'vol-1', number: 1, startChapter: 1, endChapter: 3, title: '第一卷', summary: '卷一要旨' });
    const chapters = [
      makeChapter({ number: 1, title: '第1章', summary: DETAIL, volumeId: 'vol-1', volumeNumber: 1 }),
      makeChapter({ number: 2, title: '第2章', summary: DETAIL, volumeId: 'vol-1', volumeNumber: 1 }),
      makeChapter({ number: 3, title: '第3章', summary: DETAIL, volumeId: 'vol-1', volumeNumber: 1 }),
    ];

    const result = await fillPlaceholderChapters(makeOptions({ volumes: [v1], chapters }));

    expect(result.filledCount).toBe(0);
    expect(result.remainingCount).toBe(0);
    expect(result.batchesRun).toBe(0);
    expect(result.chapters).toBe(chapters);
    expect(generateJSONMock).not.toHaveBeenCalled();
    expect(buildOutlineChaptersBatchPromptMock).not.toHaveBeenCalled();
  });

  it('卷对象透传正确：volume.title/summary 进入 prompt 上下文', async () => {
    const v1 = makeVolume({
      id: 'vol-1',
      number: 1,
      startChapter: 1,
      endChapter: 2,
      title: '第一卷 风起',
      summary: '卷一专属摘要：主角踏足宗门，卷入旧账风云。',
    });
    const ch1 = makeChapter({ number: 1, title: '第1章', summary: DETAIL, volumeId: 'vol-1', volumeNumber: 1 });
    const ch2 = makeChapter({ number: 2, title: '第2章', summary: '', volumeId: 'vol-1', volumeNumber: 1 });

    generateJSONMock.mockResolvedValueOnce({
      chapters: [draft(2, '第二章详案：林越接获密信，约定三日后入禁地。', '第二章 密信')],
    });

    await fillPlaceholderChapters(makeOptions({ volumes: [v1], chapters: [ch1, ch2] }));

    const opts = buildOutlineChaptersBatchPromptMock.mock.calls[0][0] as {
      volume: Volume;
      fromChapter: number;
      toChapter: number;
    };
    expect(opts.volume.title).toBe('第一卷 风起');
    expect(opts.volume.summary).toBe('卷一专属摘要：主角踏足宗门，卷入旧账风云。');
    expect(opts.volume.number).toBe(1);
    expect(opts.volume.startChapter).toBe(1);
    expect(opts.volume.endChapter).toBe(2);
    expect(opts.fromChapter).toBe(2);
    expect(opts.toChapter).toBe(2);
  });

  it('新详案长度门槛：35 字不采用（保持占位），恰好 40 字采用', async () => {
    const v1 = makeVolume({ id: 'vol-1', number: 1, startChapter: 1, endChapter: 3, title: '第一卷', summary: '卷一要旨' });
    const ch2 = makeChapter({ number: 2, title: '第2章', summary: '', volumeId: 'vol-1', volumeNumber: 1 });
    const ch3 = makeChapter({ number: 3, title: '第3章', summary: '', volumeId: 'vol-1', volumeNumber: 1 });

    generateJSONMock.mockResolvedValueOnce({
      chapters: [
        draft(2, '短'.repeat(35), '第二章 短'),
        draft(3, '长'.repeat(40), '第三章 长'),
      ],
    });

    const result = await fillPlaceholderChapters(makeOptions({ volumes: [v1], chapters: [ch2, ch3] }));

    expect(result.filledCount).toBe(1);
    expect(result.remainingCount).toBe(1);
    expect(result.chapters[0]).toBe(ch2); // 35 字不足详案，保持原引用
    expect(result.chapters[1].summary).toBe('长'.repeat(40));
    expect(result.chapters[1].status).toBe('细纲就绪');
  });

  it('标题替换规则：仅原标题含「待补全」才采纳模型标题，否则保留', async () => {
    const v1 = makeVolume({ id: 'vol-1', number: 1, startChapter: 1, endChapter: 3, title: '第一卷', summary: '卷一要旨' });
    const ch2 = makeChapter({ number: 2, title: '第2章 待补全', summary: '', volumeId: 'vol-1', volumeNumber: 1 });
    const ch3 = makeChapter({ number: 3, title: '第3章 决战', summary: '', volumeId: 'vol-1', volumeNumber: 1 });

    generateJSONMock.mockResolvedValueOnce({
      chapters: [
        draft(2, '第二章详案：风起云涌之际，林越与苏瑶定下破局之策，二人分头行动，约定午夜在城南废宅汇合。', '第二章 风起'),
        draft(3, '第三章详案：决战在即，旧账终于揭晓，林越握紧虎符直面来敌，章末天边雷云翻涌，杀机骤临，事态急转直下。', '第三章 改名'),
      ],
    });

    const result = await fillPlaceholderChapters(makeOptions({ volumes: [v1], chapters: [ch2, ch3] }));

    expect(result.chapters[0].title).toBe('第二章 风起'); // 原标题含待补全 → 采纳模型标题
    expect(result.chapters[1].title).toBe('第3章 决战'); // 原标题不含 → 保留用户/既有标题
  });

  it('involved id：模型给名字时解析为 id，无名字时回退保留原值', async () => {
    const v1 = makeVolume({ id: 'vol-1', number: 1, startChapter: 1, endChapter: 3, title: '第一卷', summary: '卷一要旨' });
    const ch2 = makeChapter({
      number: 2,
      title: '第2章',
      summary: '',
      volumeId: 'vol-1',
      volumeNumber: 1,
      involvedCharacterIds: ['c1'],
      involvedSettingIds: ['s1'],
    });
    const ch3 = makeChapter({ number: 3, title: '第3章', summary: '', volumeId: 'vol-1', volumeNumber: 1 });

    generateJSONMock.mockResolvedValueOnce({
      chapters: [
        draft(2, '第二章详案：林越独自追查旧账线索，先后探访三家当铺，最终在东市暗巷寻得半枚刻字的铜牌，铜牌背面刻着一个「越」字。'),
        draft(3, '第三章详案：苏瑶与林越联手，灵气复苏的真相浮出水面，二人决定潜入禁地寻回失落的阵图残卷，此行九死一生。', '第三章 联手', {
          chars: ['林越', '苏瑶'],
          sets: ['灵气复苏'],
        }),
      ],
    });

    const result = await fillPlaceholderChapters(makeOptions({ volumes: [v1], chapters: [ch2, ch3] }));

    // 无名字 → 回退保留原 involvedCharacterIds/involvedSettingIds
    expect(result.chapters[0].involvedCharacterIds).toEqual(['c1']);
    expect(result.chapters[0].involvedSettingIds).toEqual(['s1']);
    // 有名字 → 解析为 id
    expect(result.chapters[1].involvedCharacterIds).toEqual(['c1', 'c2']);
    expect(result.chapters[1].involvedSettingIds).toEqual(['s1']);
  });

  it('批区间内的非占位章即使被模型改写也不采用（对象引用不变）', async () => {
    const v1 = makeVolume({ id: 'vol-1', number: 1, startChapter: 1, endChapter: 5, title: '第一卷', summary: '卷一要旨' });
    const ch1 = makeChapter({ number: 1, title: '第1章', summary: DETAIL, volumeId: 'vol-1', volumeNumber: 1 });
    const ch2 = makeChapter({ number: 2, title: '第2章', summary: '', volumeId: 'vol-1', volumeNumber: 1 });
    const ch3 = makeChapter({ number: 3, title: '第3章', summary: DETAIL, volumeId: 'vol-1', volumeNumber: 1 });
    const ch4 = makeChapter({ number: 4, title: '第4章', summary: '', volumeId: 'vol-1', volumeNumber: 1 });
    const ch5 = makeChapter({ number: 5, title: '第5章', summary: DETAIL, volumeId: 'vol-1', volumeNumber: 1 });
    const chapters = [ch1, ch2, ch3, ch4, ch5];

    // 批区间 [2,4] 内的非占位章 ch3 也被模型输出，但不应被采用
    generateJSONMock.mockResolvedValueOnce({
      chapters: [
        draft(2, '第二章详案：林越循着账册线索找到旧当铺，掌柜却矢口否认，章末他在柜台下发现半截烧焦的账页。', '第二章 旧当铺'),
        draft(3, '模型改写后的第三章内容，完全不应被采用', '第三章 改写'),
        draft(4, '第四章详案：当铺老板道出虎符来路，指向城北废宅，林越与苏瑶连夜前往，章末废宅窗内亮起一盏孤灯。', '第四章 虎符来路'),
      ],
    });

    const result = await fillPlaceholderChapters(makeOptions({ volumes: [v1], chapters }));

    expect(result.filledCount).toBe(2);
    expect(result.remainingCount).toBe(0);
    expect(result.chapters[0]).toBe(ch1);
    expect(result.chapters[2]).toBe(ch3); // 非占位章对象引用不变
    expect(result.chapters[2].summary).toBe(ch3.summary); // 模型改写内容未生效
    expect(result.chapters[4]).toBe(ch5);
    expect(result.chapters[1].status).toBe('细纲就绪');
    expect(result.chapters[3].status).toBe('细纲就绪');
  });
});
