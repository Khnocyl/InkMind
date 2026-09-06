/**
 * 引擎管线集成测试（mock LLM 层，覆盖编排而非 prompt）：
 * 1. 全绿路径：plan→write→audit→settle 全过 → until_green 自动锁章
 * 2. 推进度弱：压分 70、不自动锁、待人工
 * 3. 硬伤 error → 补丁修复 → 复检通过 → 绿通
 * 4. 机检连续失败 → beat 级重写升级档 → 复扫通过 → 绿通
 * 5. LLM 执笔失败 → 本地保守稿降级 → 不锁章
 *
 * 这层此前零覆盖：分段审/复硬审/升级档都长在编排里，只有类型检查兜底。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const generateJSONMock = vi.fn();
const generateStreamMock = vi.fn();

vi.mock('../src/services/llmClient', () => ({
  generateJSON: (...args: unknown[]) => generateJSONMock(...(args as [])),
  generateStream: (...args: unknown[]) => generateStreamMock(...(args as [])),
  setActiveAbortSignal: vi.fn(),
  getActiveAbortSignal: () => null,
  // 按角色路由模型：管线 stage→role 上下文（默认关闭路径也要有桩）
  setActiveRoleRoute: vi.fn(),
  listLLMProfiles: vi.fn(async () => ({ activeProfileId: 'p-active', profiles: [] })),
}));

import { runChapterPipeline } from '../src/engine';
import { GenerationAbortedError } from '../src/services/llmResilience';
import { getDefaultStyleConfig } from '../src/services/storage';
import type {
  BookProject,
  Chapter,
  Character,
  StyleConfig,
  WorldSetting,
} from '../src/types/novel';

// ─── 测试正文（通过 ruleScan 默认机检与 discipline 确定性校验）───
const GOOD_PROSE = [
  '林越推开旧宅侧门，木轴发出一声闷响。',
  '堂屋的账案上摆着一本蓝皮账册，边角被老鼠啃过。',
  '他翻开第三页，父亲的小楷排在漕运的条目下，一笔一笔都对得上。',
  '账册最后夹着半枚虎符，铜色发乌，断口是旧的。',
  '他把虎符收进贴身口袋，吹熄了灯。',
  '院墙外传来两声更鼓。林越贴着墙根走，在巷口停了半息，确认没人跟上才转向东市。',
].join('\n\n');

const BAD_PROSE = `${GOOD_PROSE}\n\n他心头一震，命运的转轮已然开始转动，禁忌短语出现在这里。`;
const REWRITE_PROSE = `${GOOD_PROSE}\n\n巷口的灯笼灭了。林越把袖口收紧，快步汇入东市的人流。`;

function styleConfigWith(overrides?: Partial<StyleConfig>): StyleConfig {
  return {
    ...getDefaultStyleConfig(),
    clicheBlacklist: [],
    customBlacklist: overrides?.customBlacklist ?? [],
    ...(overrides || {}),
  };
}

interface Fixtures {
  project: BookProject;
  chapter: Chapter;
  characters: Character[];
  settings: WorldSetting[];
  styleConfig: StyleConfig;
  previousContext: string;
  contextPack: unknown;
  storyMemoryBlock: string;
  chapterIntentBlock: string;
  genrePackBlock: string;
  previousProse: string;
  targetWordCount: null;
  writeMode: 'until_green';
}

function makeInput(overrides?: { styleConfig?: StyleConfig }): Fixtures {
  const chapter: Chapter = {
    id: 'ch-it-1',
    number: 1,
    title: '雪夜旧账',
    summary: '林越夜探旧宅，发现父亲留下的账册与半枚虎符',
    wordCount: 0,
    status: '细纲就绪',
    content: '',
    volumeId: '',
    volumeNumber: 1,
    involvedCharacterIds: [],
    involvedSettingIds: [],
    lastModified: '',
  } as unknown as Chapter;
  const project = {
    id: 'p-it',
    title: '集成测试书',
    chapters: [chapter],
  } as unknown as BookProject;
  return {
    project,
    chapter,
    characters: [],
    settings: [],
    styleConfig: overrides?.styleConfig ?? styleConfigWith(),
    previousContext: '',
    contextPack: { text: '', preview: '', isFirstChapter: true },
    storyMemoryBlock: '',
    chapterIntentBlock: '',
    genrePackBlock: '',
    previousProse: '',
    targetWordCount: null,
    writeMode: 'until_green',
  };
}

type RouteTable = Record<string, unknown>;

/** 按 prompt 标记路由 generateJSON；未匹配即抛错（暴露意外调用） */
function routeJSON(table: RouteTable) {
  generateJSONMock.mockImplementation(async (messages: unknown[]) => {
    const all = (messages || []).map((m) => String((m as { content?: string })?.content || '')).join('\n');
    for (const [marker, resp] of Object.entries(table)) {
      if (all.includes(marker)) return resp;
    }
    throw new Error(`未匹配的 LLM 调用: ${all.slice(0, 60)}`);
  });
}

const GREEN_TABLE: RouteTable = {
  好莱坞金牌编剧: {
    beats: [
      { order: 1, description: '林越推门探宅' },
      { order: 2, description: '发现账册与虎符' },
      { order: 3, description: '离开留钩子' },
    ],
  },
  硬伤审查官: { hardScore: 95, hardPassed: true, summary: '无阻断矛盾', issues: [] },
  文笔审校官: {
    styleScore: 92,
    summary: '可读性好',
    suggestions: [],
    removedClichésList: [],
    removedSublimationsCount: 0,
  },
  进度审查官: {
    progressionScore: 88,
    mainLineAdvanced: true,
    wateriness: 2,
    unfinishedBeats: [],
    touchedThreads: [],
    suggestions: [],
    summary: '主线推进明确',
  },
  章末记忆官: {
    text: '林越夜探旧宅取得父亲账册与半枚虎符，账目指向漕运案。离开时被更夫搅动心神，携证入东市。',
    keyFacts: ['林越取得半枚虎符', '账册指向漕运案', '林越已离开旧宅'],
    endingState: '林越带账册与虎符进入东市',
    openThreads: ['虎符另一半的下落'],
  },
  状态记忆官: { patches: [] },
  冲突修复编辑: {
    fixedProse: GOOD_PROSE,
    changesSummary: ['已修正冲突'],
    localPatches: [],
  },
};

function streamReturns(proseByMarker: Record<string, string>) {
  generateStreamMock.mockImplementation(async (messages: unknown[], _t: unknown, onStream?: (s: string) => void) => {
    const all = (messages || []).map((m) => String((m as { content?: string })?.content || '')).join('\n');
    for (const [marker, prose] of Object.entries(proseByMarker)) {
      if (all.includes(marker)) {
        onStream?.(prose.slice(0, 20));
        onStream?.(prose);
        return prose;
      }
    }
    throw new Error(`未匹配的流式调用: ${all.slice(0, 60)}`);
  });
}

describe('engine · runChapterPipeline 集成（mock LLM）', () => {
  beforeEach(() => {
    generateJSONMock.mockReset();
    generateStreamMock.mockReset();
  });

  it('全绿路径：三重门全过 → 自动锁章', async () => {
    routeJSON(GREEN_TABLE);
    streamReturns({ 执笔撰写正文: GOOD_PROSE });

    const input = makeInput();
    const result = await runChapterPipeline(input as never);

    expect(result.ok).toBe(true);
    expect(result.greenOk).toBe(true);
    expect(result.locked).toBe(true);
    expect(result.status).toBe('校验通过');
    expect(result.prose).toBe(GOOD_PROSE);
    expect(result.reviseRounds).toBe(0);
    expect(result.recap?.keyFacts).toHaveLength(3);
    expect(result.auditLog?.progressionReview?.score).toBe(88);
  });

  it('推进度弱（45 分/注水 8）→ 压分 70、不自动锁、不绿', async () => {
    routeJSON({
      ...GREEN_TABLE,
      进度审查官: {
        progressionScore: 45,
        mainLineAdvanced: false,
        wateriness: 8,
        unfinishedBeats: [{ order: 2, reason: '账册只看了一眼就跳过' }],
        touchedThreads: [],
        suggestions: ['把分镜 2 写成完整翻阅场景'],
        summary: '推进微弱，分镜2一笔带过',
      },
    });
    streamReturns({ 执笔撰写正文: GOOD_PROSE });

    const result = await runChapterPipeline(makeInput() as never);

    expect(result.ok).toBe(true);
    expect(result.greenOk).toBe(false);
    expect(result.locked).toBe(false);
    expect(result.auditLog?.progressionBlocked).toBe(true);
    expect(result.auditLog?.verificationScore).toBeLessThanOrEqual(70);
  });

  it('硬伤 error → 补丁修复 → 复检通过 → 仍可绿通锁章', async () => {
    let hardCalls = 0;
    generateJSONMock.mockImplementation(async (messages: unknown[]) => {
      const all = (messages || []).map((m) => String((m as { content?: string })?.content || '')).join('\n');
      if (all.includes('硬伤审查官')) {
        hardCalls++;
        return hardCalls === 1
          ? {
              hardScore: 55,
              hardPassed: false,
              summary: '发现状态冲突',
              issues: [
                {
                  type: '状态冲突',
                  severity: 'error',
                  description: '林越上一章已负伤左臂，本章单手翻墙未交代',
                  suggestion: '改为借用墙缝踏点或另手支撑',
                  evidenceA: { source: 'chapter', quote: '他把虎符收进贴身口袋，吹熄了灯' },
                  evidenceB: { source: 'chapter', quote: '院墙外传来两声更鼓' },
                },
              ],
            }
          : { hardScore: 93, hardPassed: true, summary: '复检通过', issues: [] };
      }
      // 其余走绿色路由表
      const { 硬伤审查官: _omit, ...rest } = GREEN_TABLE;
      for (const [marker, resp] of Object.entries(rest)) {
        if (all.includes(marker)) return resp;
      }
      throw new Error(`未匹配的 LLM 调用: ${all.slice(0, 60)}`);
    });
    streamReturns({ 执笔撰写正文: GOOD_PROSE });

    const result = await runChapterPipeline(makeInput() as never);

    expect(result.ok).toBe(true);
    expect(hardCalls).toBeGreaterThanOrEqual(2); // 初审 + 修复后复检
    expect(result.greenOk).toBe(true);
    expect(result.locked).toBe(true);
    expect(result.reviseRounds).toBeGreaterThanOrEqual(1);
  });

  it('机检两轮补丁修不动 → beat 级重写升级 → 复扫通过 → 绿通', async () => {
    // 黑名单命中：执笔稿含「禁忌短语」→ 机检 error；补丁修复返回原稿（修不动）
    const table: RouteTable = {
      ...GREEN_TABLE,
      冲突修复编辑: { fixedProse: BAD_PROSE, changesSummary: ['尝试修正失败'], localPatches: [] },
    };
    routeJSON(table);
    streamReturns({
      执笔撰写正文: BAD_PROSE,
      修订执笔: REWRITE_PROSE,
    });

    const result = await runChapterPipeline(
      makeInput({ styleConfig: styleConfigWith({ customBlacklist: ['禁忌短语'] }) }) as never
    );

    expect(result.ok).toBe(true);
    expect(result.auditLog?.beatRewriteApplied).toBe(true);
    expect(result.prose).toBe(REWRITE_PROSE);
    expect(result.greenOk).toBe(true);
    expect(result.locked).toBe(true);
  });

  it('LLM 执笔失败 → 本地保守稿降级 → 不锁章、标记 conservative', async () => {
    routeJSON(GREEN_TABLE);
    generateStreamMock.mockImplementation(async (messages: unknown[]) => {
      const all = (messages || []).map((m) => String((m as { content?: string })?.content || '')).join('\n');
      if (all.includes('执笔撰写正文')) {
        throw new Error('模拟执笔 API 故障');
      }
      throw new Error(`意外的流式调用: ${all.slice(0, 40)}`);
    });

    const result = await runChapterPipeline(makeInput() as never);

    expect(result.ok).toBe(true);
    expect(result.conservative).toBe(true);
    expect(result.prose.length).toBeGreaterThan(0);
    // 保守稿无论审校/机检结果如何都不得自动锁章（autoLocked = greenOk && !conservative）；
    // greenOk 本身可为 true（机检照常过）——防的是「自动定稿」而非「标记」
    expect(result.locked).toBe(false);
  });
});

describe('engine · 用户中止（signal）', () => {
  beforeEach(() => {
    generateJSONMock.mockReset();
    generateStreamMock.mockReset();
  });

  it('启动前已中止 → 快速失败，不发起任何 LLM 调用', async () => {
    routeJSON(GREEN_TABLE);
    streamReturns({ 执笔撰写正文: GOOD_PROSE });

    const controller = new AbortController();
    controller.abort();
    const input = { ...makeInput(), signal: controller.signal };

    const result = await runChapterPipeline(input as never);

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBe('用户已停止生成');
    expect(result.locked).toBe(false);
    expect(generateJSONMock).not.toHaveBeenCalled();
    expect(generateStreamMock).not.toHaveBeenCalled();
  });

  it('Writer 阶段中止（GenerationAbortedError 穿透）→ ok:false、停止语义、不锁章', async () => {
    routeJSON(GREEN_TABLE); // planner 正常
    generateStreamMock.mockImplementation(async () => {
      throw new GenerationAbortedError();
    });

    const controller = new AbortController();
    const input = { ...makeInput(), signal: controller.signal };
    const result = await runChapterPipeline(input as never);

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBe('用户已停止生成');
    expect(result.locked).toBe(false);
    expect(result.status).toBe('正文草稿');
    // 停止不是 API 失败：不应触发保守稿降级
    expect(result.conservative).toBeUndefined();
  });
});
