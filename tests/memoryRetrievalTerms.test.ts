/**
 * 写前记忆检索的**查询词抽取**回归。
 *
 * 背景（用户反馈「RAG 没发挥应有作用」）：旧实现把标题/梗概当一整段做 2–4 字滑窗，
 * 结果 16 个词全被前 12 个字的重叠 n-gram 占满，沈砚/账册/虎符/三十万两全部落选，
 * 关键词通道形同失效（只剩角色索引与语义通道在工作）。
 * 现在按「角色名 → 写前意图 → 标题/梗概」的优先级抽取，并用虚词切分词组。
 */
import { describe, expect, it } from 'vitest';
import {
  extractMemoryQueryTerms,
  retrieveMemoryForChapter,
} from '../src/services/memoryRetrieval';
import type { Chapter, Character, StoryMemory } from '../src/types/novel';

const characters = [
  { id: 'c1', name: '林越', alias: '漕帮小吏', currentLocation: '东市' },
  { id: 'c2', name: '沈砚', alias: '漕运提举', currentLocation: '提举司' },
] as Character[];

const longSummary =
  '林越趁着夜色混入提举司后院，避开巡夜的差役，摸到存放漕运账册的偏厅。他要核对第三页上那笔三十万两的去向，却在翻到最后一页时发现有人提前动过手脚——账册末尾被整齐撕去一页。沈砚带着两名心腹堵在门口，林越只能亮出怀里的半枚虎符试探对方的反应。';

function makeChapter(overrides?: Partial<Chapter>): Chapter {
  return {
    id: 'ch31',
    number: 31,
    title: '第31章 漕运暗账',
    summary: longSummary,
    content: '',
    status: '细纲就绪',
    involvedCharacterIds: ['c1', 'c2'],
    involvedSettingIds: [],
    volumeId: 'v1',
    volumeNumber: 1,
    wordCount: 0,
    lastModified: '',
    intent: {
      mustDo: ['核对漕运账册第三页的三十万两去向', '与沈砚正面对峙并亮出虎符'],
      mustAvoid: ['让沈砚当场认罪'],
      endingHook: '账册最后一页被人提前撕走',
      emotionalBeats: ['压抑', '交锋'],
    },
    ...overrides,
  } as unknown as Chapter;
}

describe('extractMemoryQueryTerms · 真实长度梗概下实体不被挤掉', () => {
  it('角色名/称号/地点最优先', () => {
    const terms = extractMemoryQueryTerms({
      chapter: makeChapter(),
      characters,
    });
    expect(terms.slice(0, 6)).toEqual(
      expect.arrayContaining(['林越', '漕帮小吏', '东市', '沈砚'])
    );
  });

  it('关键词不丢：沈砚 / 提举司 / 虎符 / 账册 都在词表里', () => {
    const terms = extractMemoryQueryTerms({ chapter: makeChapter(), characters });
    const joined = terms.join('|');
    for (const w of ['沈砚', '提举司', '虎符', '账册']) {
      expect(joined).toContain(w);
    }
  });

  it('不再产生纯噪声滑窗词（旧实现会产出「越趁着夜」这类词）', () => {
    const terms = extractMemoryQueryTerms({ chapter: makeChapter(), characters });
    expect(terms).not.toContain('越趁着夜');
    expect(terms).not.toContain('夜色混入');
  });

  it('词表有上限，且过滤单字/停用词', () => {
    const terms = extractMemoryQueryTerms({ chapter: makeChapter(), characters });
    expect(terms.length).toBeLessThanOrEqual(18);
    expect(terms.every((t) => t.length >= 2)).toBe(true);
  });

  it('没有出场角色约束时（involved 为空）也会带上全部角色名', () => {
    const terms = extractMemoryQueryTerms({
      chapter: makeChapter({ involvedCharacterIds: [] } as never),
      characters,
    });
    expect(terms).toContain('林越');
    expect(terms).toContain('沈砚');
  });
});

describe('retrieveMemoryForChapter · 关键词通道真的生效', () => {
  const memory = {
    pinnedFacts: [
      {
        id: 'fact-20-1',
        text: '沈砚私吞漕银三十万两，账册记录在第三页',
        subject: '沈砚',
        sourceChapterNumber: 20,
        validFromChapter: 20,
        validUntilChapter: null,
        createdAt: '2026-08-02T00:00:00.000Z',
        status: 'pinned',
      },
      {
        id: 'fact-3-1',
        text: '东市茶肆的老板娘其实是北地来的细作',
        subject: '东市',
        sourceChapterNumber: 3,
        validFromChapter: 3,
        validUntilChapter: null,
        createdAt: '2026-07-01T00:00:00.000Z',
        status: 'pinned',
      },
    ],
    openThreads: [],
    spanDigests: [],
  } as unknown as StoryMemory;

  it('事实评分带「词项」理由（说明关键词命中，而不是只靠角色索引）', () => {
    const r = retrieveMemoryForChapter({
      chapter: makeChapter(),
      memory,
      characters,
      allChapters: [],
      chapterNumber: 31,
    });
    const shen = r.facts.find((f) => f.fact.id === 'fact-20-1');
    expect(shen).toBeDefined();
    expect(shen?.reasons.some((x) => x.startsWith('词项:'))).toBe(true);
    expect(shen?.reasons).toContain('角色索引');
  });
});
