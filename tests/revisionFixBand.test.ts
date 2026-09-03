import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  revisionFixBand,
  resolveFixMaxChars,
  trimToSentenceBudget,
  aiFixRevisionTodo,
} from '../src/services/revisionAiFix';
import { mergeHardReviewSegmentScores } from '../src/services/aiEngine';
import type { Chapter, ChapterRevisionTodo } from '../src/types/novel';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('revisionFixBand · 等量替换字数带', () => {
  it('去AI类收紧到 1.25 倍，其余 1.5 倍，下限 0.75 倍（禁大幅压缩）', () => {
    expect(revisionFixBand(1000, 'aitaste')).toEqual({
      minChars: 750,
      maxChars: 1250,
    });
    expect(revisionFixBand(1000, 'hard')).toEqual({
      minChars: 750,
      maxChars: 1500,
    });
    expect(revisionFixBand(1000, 'audit').maxChars).toBe(1500);
    expect(revisionFixBand(1000, 'generic').maxChars).toBe(1500);
  });

  it('极短选区有最小保护', () => {
    const b = revisionFixBand(4, 'hard');
    expect(b.minChars).toBeGreaterThanOrEqual(8);
    expect(b.maxChars).toBeGreaterThanOrEqual(16);
  });
});

describe('resolveFixMaxChars · 章级余量约束', () => {
  it('余量充足 → 用片段带上限', () => {
    expect(resolveFixMaxChars(72, 48, 1800, 2200)).toBe(72);
  });

  it('余量不足 → 收紧到余量', () => {
    expect(resolveFixMaxChars(72, 48, 2180, 2200)).toBe(68);
  });

  it('章节已超上限 → 等量替换兜底（不恶化）', () => {
    expect(resolveFixMaxChars(72, 48, 2250, 2200)).toBe(48);
  });
});

describe('trimToSentenceBudget · 句界截短', () => {
  it('预算内原样返回', () => {
    expect(trimToSentenceBudget('第一句。第二句。', 100)).toBe(
      '第一句。第二句。'
    );
  });

  it('超预算 → 在预算内最后一个句读截断', () => {
    const text = `甲${'一'.repeat(80)}。乙${'二'.repeat(80)}。丙${'三'.repeat(80)}。`;
    const out = trimToSentenceBudget(text, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('。')).toBe(true);
  });

  it('找不到句界 → 硬截到预算（兜底不失控）', () => {
    const text = 'x'.repeat(200);
    expect(trimToSentenceBudget(text, 50)).toHaveLength(50);
  });
});

describe('mergeHardReviewSegmentScores · 分段合并计分', () => {
  it('全过取均值', () => {
    expect(
      mergeHardReviewSegmentScores([
        { passed: true, score: 95 },
        { passed: true, score: 85 },
      ])
    ).toBe(90);
  });

  it('未过取均值-10（不再被最差段绑架），下限 40', () => {
    expect(
      mergeHardReviewSegmentScores([
        { passed: true, score: 95 },
        { passed: false, score: 55 },
        { passed: true, score: 92 },
      ])
    ).toBe(71); // 均值 81 − 10
    expect(
      mergeHardReviewSegmentScores([
        { passed: false, score: 40 },
        { passed: false, score: 40 },
      ])
    ).toBe(40);
  });

  it('空数组返回 0', () => {
    expect(mergeHardReviewSegmentScores([])).toBe(0);
  });
});

describe('aiFixRevisionTodo · 越带反馈重试与终闸（集成）', () => {
  const baseText =
    '陈伶握紧枪柄。「昨晚死的人是谁？」他盯着表格，指节发白。雨点砸在窗上，屋里的煤油灯忽明忽暗。';
  const makeChapter = (): Chapter =>
    ({
      id: 'ch1',
      number: 3,
      title: '试炼',
      summary: '',
      content: baseText,
      wordCount: baseText.replace(/\s+/g, '').length,
      status: '草稿',
      volumeId: 'v1',
      volumeNumber: 1,
      involvedCharacterIds: [],
      involvedSettingIds: [],
      beats: [],
      lastModified: '',
      revisionTodos: [
        {
          id: 't1',
          text: '[硬伤] 修正「昨晚死的人是谁」与账本矛盾',
          status: 'open',
        },
      ] as ChapterRevisionTodo[],
    }) as unknown as Chapter;

  const styleStub = {
    fewShotExamples: [],
    clicheBlacklist: [],
    customBlacklist: [],
  } as unknown as Parameters<typeof aiFixRevisionTodo>[0]['styleConfig'];

  function mockTextSequence(contents: string[]) {
    let calls = 0;
    const bodies: string[] = [];
    const fn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const idx = Math.min(calls, contents.length - 1);
      calls += 1;
      bodies.push(String(init?.body || ''));
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, content: contents[idx] }),
        text: async () => '',
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fn);
    return { fn, bodies, callCount: () => calls };
  }

  it('首轮越带 → 反馈重试后在带内，替换成功', async () => {
    // 选区约 48 字 → 带约 36–72 字；首轮 200 字越带，次轮 42 字在带内
    const over = `改${'写'.repeat(198)}。`;
    const good =
      '陈伶缓缓松开枪柄。「死的是替身，不是他。」他在表格写下结论，灯芯爆了个火星，雨还在下。';
    const { fn, bodies, callCount } = mockTextSequence([over, good]);
    const r = await aiFixRevisionTodo({
      chapter: makeChapter(),
      todo: (makeChapter().revisionTodos as ChapterRevisionTodo[])[0],
      styleConfig: styleStub,
      onProgress: () => {},
    });
    expect(callCount()).toBe(2);
    const retryMsg = JSON.parse(bodies[1]).messages as { content: string }[];
    expect(retryMsg).toHaveLength(4); // 原始 2 条 + assistant 回显 + 修正指令
    expect(retryMsg[3].content).toContain('等量替换');
    expect(r.replaced).toBe(true);
    expect(r.after).toBe(good);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('修复缩水 → 章级契约自动补写回目标区间', async () => {
    // target=60：下限 54。缩水稿 30 字（重试仍短，接受）→ 全章 30 < 54 → 触发补写
    const short1 = '陈伶点头。';
    const short2 = '陈伶点头，把枪收回枪套，转身走向门口，脚步在雨声里停了一瞬。';
    const expansion =
      '夜雨敲窗，他想起白天档案里那张缺失的照片，指节在门框上敲了两下，终于还是推门回到桌前重新翻开卷宗。';
    const enc = new TextEncoder();
    let calls = 0;
    const fn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.stream) {
        // 补写（generateStream）：SSE 单块
        return {
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                enc.encode(`data: {"chunk":${JSON.stringify(expansion)}}\n\n`)
              );
              controller.close();
            },
          }),
          text: async () => '',
          json: async () => ({}),
        } as unknown as Response;
      }
      const contents = [short1, short2];
      const idx = Math.min(calls - 1, contents.length - 1);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, content: contents[idx] }),
        text: async () => '',
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fn);

    const r = await aiFixRevisionTodo({
      chapter: makeChapter(),
      todo: (makeChapter().revisionTodos as ChapterRevisionTodo[])[0],
      styleConfig: styleStub,
      targetWordCount: 60,
      onProgress: () => {},
    });

    expect(r.replaced).toBe(true);
    expect(calls).toBe(3); // 改写 + 反馈重试 + 章级补写
    // 补写块已拼进全章
    expect(r.chapter.content).toContain('夜雨敲窗');
    // 字数字段与内容同步
    expect(r.chapter.wordCount).toBe(
      (r.chapter.content || '').replace(/\s+/g, '').length
    );
  });

  it('重试仍超长 → 句界终闸截短', async () => {
    // 首个句读落在截短窗口(40%~100%)内，确保走句界而非硬截兜底
    const over1 = `甲${'乙'.repeat(300)}。`;
    const over2 = `丙${'丁'.repeat(95)}。${'戊'.repeat(150)}。`;
    const { callCount } = mockTextSequence([over1, over2]);
    const r = await aiFixRevisionTodo({
      chapter: makeChapter(),
      todo: (makeChapter().revisionTodos as ChapterRevisionTodo[])[0],
      styleConfig: styleStub,
      onProgress: () => {},
    });
    expect(callCount()).toBe(2);
    expect(r.replaced).toBe(true);
    // 终闸后不超过 band.max + 40（选区 48 字 → hard 1.5× = 72 + 40 容差）
    expect(r.after.replace(/\s+/g, '').length).toBeLessThanOrEqual(112);
    expect(r.after.endsWith('。')).toBe(true);
    expect(r.after).not.toContain('戊'); // 只保留到第一个句界
  });
});
