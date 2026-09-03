import { describe, it, expect } from 'vitest';
import { scanChapterGaps, scanProjectGaps } from '../src/services/gapScanner';
import { isChapterLocked } from '../src/services/chapterLock';
import type { BookProject, Chapter } from '../src/types/novel';

/**
 * 全书缺口扫描（纯函数）测试：
 * 四类缺口判定 / 锁章豁免 / 混合样本统计 / 空书零缺口 / 章节排序。
 */

function makeChapter(partial: Partial<Chapter> & { number: number }): Chapter {
  return {
    id: `chap-${partial.number}`,
    number: partial.number,
    title: partial.title ?? `第${partial.number}章`,
    summary: partial.summary ?? '',
    wordCount: 0,
    status: '正文草稿',
    content: '',
    involvedCharacterIds: [],
    involvedSettingIds: [],
    beats: [],
    lastModified: '',
    ...partial,
  };
}

function makeProject(chapters: Chapter[]): BookProject {
  return {
    id: 'p1',
    title: '测试书',
    subtitle: '',
    genre: '玄幻',
    synopsis: '',
    lastModified: '',
    wizardStep: 'ready',
    config: { inspiration: '', writingStyle: '', genre: '玄幻' },
    characters: [],
    settings: [],
    volumes: [],
    chapters,
    styleConfig: {
      clicheBlacklist: [],
      customBlacklist: [],
      fewShotExamples: [],
      selectedExampleId: '',
      enforceShowDontTell: false,
      forbidEndingSublimation: false,
    },
  };
}

const oneBeat = { id: 'b1', order: 1, description: '场景' };

describe('scanChapterGaps · 单章缺口判定', () => {
  it('无 intent → intent_missing（连同缺分镜/缺正文）', () => {
    const kinds = scanChapterGaps(makeChapter({ number: 1 })).kinds;
    expect(kinds).toContain('intent_missing');
    expect(kinds).toContain('beats_missing');
    expect(kinds).toContain('prose_missing');
  });

  it('intent 存在但 mustDo 为空且 endingHook 为空 → intent_missing', () => {
    const ch = makeChapter({
      number: 2,
      intent: { mustDo: [], mustAvoid: [], endingHook: '', confirmed: false, source: 'manual' },
    });
    expect(scanChapterGaps(ch).kinds).toContain('intent_missing');
  });

  it('intent 有 mustDo 或 endingHook → 不列 intent_missing（有钩子即视为非空）', () => {
    const ch = makeChapter({
      number: 3,
      intent: {
        mustDo: [],
        mustAvoid: [],
        endingHook: '留下可接续钩子',
        confirmed: false,
        source: 'manual',
      },
    });
    expect(scanChapterGaps(ch).kinds).not.toContain('intent_missing');
  });

  it('fallback 未确认 intent → intent_fallback（质量打折需重生成）', () => {
    const ch = makeChapter({
      number: 4,
      intent: {
        mustDo: ['推进梗概'],
        mustAvoid: [],
        endingHook: '钩子',
        confirmed: false,
        source: 'fallback',
      },
    });
    expect(scanChapterGaps(ch).kinds).toContain('intent_fallback');
  });

  it('fallback 已确认 intent → 视为用户认可现状，不列缺口', () => {
    const ch = makeChapter({
      number: 5,
      intent: {
        mustDo: ['推进梗概'],
        mustAvoid: [],
        endingHook: '钩子',
        confirmed: true,
        source: 'fallback',
      },
      beats: [oneBeat],
      content: 'x'.repeat(200),
    });
    const { kinds, locked } = scanChapterGaps(ch);
    expect(kinds).toEqual([]);
    expect(locked).toBe(false);
  });

  it('beats 缺失/空 → beats_missing；有分镜 → 不列', () => {
    expect(scanChapterGaps(makeChapter({ number: 6 })).kinds).toContain('beats_missing');
    expect(
      scanChapterGaps(makeChapter({ number: 7, beats: [oneBeat] })).kinds
    ).not.toContain('beats_missing');
  });

  it('正文去空白 < 200 字 → prose_missing；≥200 → 不列；空白不计字数', () => {
    const short = scanChapterGaps(makeChapter({ number: 8, content: '短' })).kinds;
    expect(short).toContain('prose_missing');

    const almost = scanChapterGaps(makeChapter({ number: 9, content: '正'.repeat(199) })).kinds;
    expect(almost).toContain('prose_missing');

    const full = scanChapterGaps(makeChapter({ number: 10, content: '正'.repeat(200) })).kinds;
    expect(full).not.toContain('prose_missing');

    // 100 个「正 」= 100 个汉字，空白不计入
    const spaced = scanChapterGaps(makeChapter({ number: 11, content: '正 '.repeat(100) })).kinds;
    expect(spaced).toContain('prose_missing');
  });

  it('旧数据 intent 缺 mustDo/endingHook 字段（未 normalize）不崩溃，按空判定 intent_missing', () => {
    const legacy = makeChapter({
      number: 14,
      intent: {
        // 早期 JSON 解析 bug 产物：字段缺失
        confirmed: false,
        source: 'llm',
      } as Chapter['intent'],
    });
    const kinds = scanChapterGaps(legacy).kinds;
    expect(kinds).toContain('intent_missing');
  });

  it('锁定章（显式 locked / 定稿状态推断）永不列为缺口', () => {
    const explicit = makeChapter({ number: 12, locked: true, content: '', beats: [] });
    expect(isChapterLocked(explicit)).toBe(true);
    const r1 = scanChapterGaps(explicit);
    expect(r1.kinds).toEqual([]);
    expect(r1.locked).toBe(true);

    const byStatus = makeChapter({ number: 13, status: '校验通过', content: '', beats: [] });
    expect(isChapterLocked(byStatus)).toBe(true);
    expect(scanChapterGaps(byStatus).kinds).toEqual([]);
  });
});

describe('scanProjectGaps · 全书统计', () => {
  it('空书 → 零缺口', () => {
    const r = scanProjectGaps(makeProject([]));
    expect(r.totalChapters).toBe(0);
    expect(r.gapChapters).toBe(0);
    expect(r.lockedChapters).toBe(0);
    expect(r.cleanChapters).toBe(0);
    expect(r.chapterGaps).toEqual([]);
    expect(r.counts).toEqual({
      intent_missing: 0,
      intent_fallback: 0,
      beats_missing: 0,
      prose_missing: 0,
    });
  });

  it('混合样本：四类缺口并存统计正确，锁章豁免不计入缺口', () => {
    // c1：全缺（intent_missing + beats_missing + prose_missing）
    const c1 = makeChapter({ number: 1 });
    // c2：仅 intent_fallback（意图兜底，分镜正文齐备）
    const c2 = makeChapter({
      number: 2,
      intent: {
        mustDo: ['推进梗概'],
        mustAvoid: [],
        endingHook: '钩子',
        confirmed: false,
        source: 'fallback',
      },
      beats: [oneBeat],
      content: 'x'.repeat(300),
    });
    // c3：仅 beats_missing（意图确认、正文够长）
    const c3 = makeChapter({
      number: 3,
      intent: { mustDo: ['推进冲突'], mustAvoid: [], endingHook: '钩子', confirmed: true },
      beats: [],
      content: 'x'.repeat(300),
    });
    // c4：锁定章（即使全缺也豁免）
    const c4 = makeChapter({ number: 4, status: '校验通过', content: '' });
    // c5：干净章
    const c5 = makeChapter({
      number: 5,
      intent: {
        mustDo: ['推进冲突'],
        mustAvoid: ['不崩人设'],
        endingHook: '钩子',
        confirmed: true,
        source: 'llm',
      },
      beats: [oneBeat],
      content: 'x'.repeat(300),
    });

    const r = scanProjectGaps(makeProject([c1, c2, c3, c4, c5]));
    expect(r.totalChapters).toBe(5);
    expect(r.lockedChapters).toBe(1);
    expect(r.gapChapters).toBe(3);
    expect(r.cleanChapters).toBe(1);
    expect(r.counts).toEqual({
      intent_missing: 1,
      intent_fallback: 1,
      beats_missing: 2,
      prose_missing: 1,
    });

    // c1 三类并存
    const g1 = r.chapterGaps.find((g) => g.chapterNumber === 1)!;
    expect(g1.kinds).toEqual(['intent_missing', 'beats_missing', 'prose_missing']);
    // 锁章 / 干净章不在明细
    expect(r.chapterGaps.some((g) => g.chapterNumber === 4)).toBe(false);
    expect(r.chapterGaps.some((g) => g.chapterNumber === 5)).toBe(false);
    // 动作映射齐备
    expect(r.actions.intent_missing).toContain('generateChapterIntent');
    expect(r.actions.intent_fallback).toContain('重新生成写前意图');
    expect(r.actions.beats_missing).toContain('单章管线');
    expect(r.actions.prose_missing).toContain('单章管线');
  });

  it('章节按章号升序输出，与输入顺序无关', () => {
    const c1 = makeChapter({ number: 1 });
    const c2 = makeChapter({ number: 2 });
    const c3 = makeChapter({ number: 3 });
    const r = scanProjectGaps(makeProject([c3, c1, c2]));
    expect(r.chapterGaps.map((g) => g.chapterNumber)).toEqual([1, 2, 3]);
  });

  it('全部已锁 → gapChapters 0 且 lockedChapters = 总数', () => {
    const a = makeChapter({ number: 1, status: '校验通过' });
    const b = makeChapter({ number: 2, locked: true });
    const r = scanProjectGaps(makeProject([a, b]));
    expect(r.lockedChapters).toBe(2);
    expect(r.gapChapters).toBe(0);
    expect(r.cleanChapters).toBe(0);
    expect(r.chapterGaps).toEqual([]);
  });
});
