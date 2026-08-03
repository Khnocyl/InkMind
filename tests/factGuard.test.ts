import { describe, it, expect } from 'vitest';
import {
  runLocalFactGuard,
  factGuardHitsToHardIssues,
  mergeHardWithLocalGuard,
  evaluateRecapQuality,
} from '../src/services/factGuard';
import type { ChapterRecap, ChapterIntent, Character, StoryMemory } from '../src/types/novel';

function char(name: string, status: string): Character {
  return { id: `c-${name}`, name, status, role: '配角', alias: '' } as unknown as Character;
}

function memoryWithFacts(facts: { text: string; status?: 'pinned' | 'superseded' }[]): StoryMemory {
  return {
    pinnedFacts: facts.map((f, i) => ({
      id: `f${i}`,
      text: f.text,
      status: f.status || 'pinned',
      createdAt: '2026-08-01T00:00:00.000Z',
    })),
    openThreads: [],
  };
}

describe('runLocalFactGuard 基础门槛', () => {
  it('空/过短正文直接通过（跳过断言）', () => {
    const r = runLocalFactGuard({ prose: '短。' });
    expect(r.passed).toBe(true);
    expect(r.score).toBe(100);
    expect(r.issues).toHaveLength(0);
    expect(r.summary).toContain('跳过');
  });
});

describe('runLocalFactGuard 状态冲突', () => {
  it('阵亡角色出现当下行动 → error 状态冲突', () => {
    const prose =
      '叶无痕说道：“此地不宜久留，速速撤离。”众人闻言纷纷点头，山风猎猎，月色如霜，气氛凝重。';
    const r = runLocalFactGuard({
      prose,
      characters: [char('叶无痕', '已阵亡/退出')],
    });
    const hit = r.issues.find((i) => i.type === '状态冲突');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
    expect(r.passed).toBe(false);
  });

  it('阵亡角色出现在回忆语境 → warn 而非 error', () => {
    const prose =
      '他站在祠堂前，回忆起当年叶无痕说过的话，那时山门初立，剑光如雪，满座皆惊，如今物是人非，令人唏嘘不已。';
    const r = runLocalFactGuard({
      prose,
      characters: [char('叶无痕', '已阵亡/退出')],
    });
    const hit = r.issues.find((i) => i.type === '状态冲突');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('warn');
  });

  it('重伤/闭关角色高强度行动 → warn', () => {
    const prose =
      '李铁飞身而起，一掌拍碎山门巨石，碎石飞溅如雨，在场众人皆被气浪震退数步，血雾在月光下弥漫开来，人人骇然变色。';
    const r = runLocalFactGuard({
      prose,
      characters: [char('李铁', '闭关突破')],
    });
    const hit = r.issues.find((i) => i.type === '状态冲突');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('warn');
  });

  it('活蹦乱跳的角色不误报', () => {
    const prose =
      '苏小小快步走进屋内，放下药箱，取出一只瓷瓶，转身对老人轻声说道：“该换药了。”';
    const r = runLocalFactGuard({
      prose,
      characters: [char('苏小小', '活跃')],
    });
    expect(r.issues.filter((i) => i.type === '状态冲突')).toHaveLength(0);
  });
});

describe('runLocalFactGuard 钉死事实否定', () => {
  it('正文粗暴否定钉死事实 → error 吃书矛盾', () => {
    const prose =
      '他冷笑一声：“这世上根本没有林晚晴是剑宗宗主之女的身份，一切都是骗局罢了。”众人哗然。';
    const r = runLocalFactGuard({
      prose,
      storyMemory: memoryWithFacts([{ text: '林晚晴是剑宗宗主之女' }]),
    });
    const hit = r.issues.find((i) => i.type === '吃书矛盾');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
    expect(r.passed).toBe(false);
  });

  it('已作废（superseded）事实不参与否定检查', () => {
    const prose =
      '他冷笑一声：“这世上根本没有林晚晴是剑宗宗主之女的身份，一切都是骗局罢了。”众人哗然。';
    const r = runLocalFactGuard({
      prose,
      storyMemory: memoryWithFacts([
        { text: '林晚晴是剑宗宗主之女', status: 'superseded' },
      ]),
    });
    expect(r.issues.filter((i) => i.type === '吃书矛盾')).toHaveLength(0);
  });
});

describe('runLocalFactGuard must-avoid', () => {
  it('正文撞写前禁止项 → warn', () => {
    const prose =
      '主角一言不合灭门之后，整个宗门鸦雀无声，连呼吸都变得小心翼翼，无人敢抬头，长街尽头传来一声叹息，久久不散。';
    const r = runLocalFactGuard({
      prose,
      characters: [char('主角', '活跃')],
      chapterIntent: {
        mustDo: [],
        mustAvoid: ['禁止主角一言不合灭门'],
        endingHook: '',
        confirmed: true,
      } as ChapterIntent,
    });
    const hit = r.issues.find((i) => i.type === '其他硬伤');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('warn');
    expect(hit!.description).toContain('主角一言不合灭门');
  });

  it('must-avoid 为空不产生命中', () => {
    const prose =
      '主角一言不合灭门之后，整个宗门鸦雀无声，连呼吸都变得小心翼翼，无人敢抬头。';
    const r = runLocalFactGuard({
      prose,
      chapterIntent: { mustDo: [], mustAvoid: [], endingHook: '', confirmed: true },
    });
    expect(r.issues).toHaveLength(0);
  });
});

describe('factGuardHitsToHardIssues / mergeHardWithLocalGuard', () => {
  it('命中转 hard issue 带 [本地断言] 前缀', () => {
    const out = factGuardHitsToHardIssues([
      {
        type: '状态冲突',
        severity: 'error',
        description: '角色状态冲突',
        suggestion: '修正状态',
      },
    ]);
    expect(out[0].description).toBe('[本地断言] 角色状态冲突');
    expect(out[0].type).toBe('状态冲突');
  });

  it('本地 error → 总 passed 必不通过，score 取 min', () => {
    const merged = mergeHardWithLocalGuard(
      {
        passed: true,
        score: 92,
        summary: 'LLM 通过',
        issues: [],
        source: 'llm',
      },
      {
        passed: false,
        score: 52,
        summary: '本地断言未过',
        issues: [
          {
            type: '状态冲突',
            severity: 'error',
            description: 'x',
            suggestion: 'y',
          },
        ],
      }
    );
    expect(merged.passed).toBe(false);
    expect(merged.score).toBe(52);
    expect(merged.source).toBe('mixed');
    expect(merged.issues.some((i) => i.description.startsWith('[本地断言]'))).toBe(true);
  });

  it('本地无命中时保持 llm 来源与 passed', () => {
    const merged = mergeHardWithLocalGuard(
      {
        passed: true,
        score: 95,
        summary: '通过',
        issues: [],
        source: 'llm',
      },
      { passed: true, score: 100, summary: '本地通过', issues: [] }
    );
    expect(merged.passed).toBe(true);
    expect(merged.source).toBe('llm');
    expect(merged.localGuard?.passed).toBe(true);
  });
});

describe('evaluateRecapQuality', () => {
  it('无 recap：第 1 章不阻断，第 2 章起阻断绿通', () => {
    expect(evaluateRecapQuality(null, 1).blockGreen).toBe(false);
    expect(evaluateRecapQuality(null, 2).blockGreen).toBe(true);
    expect(evaluateRecapQuality(undefined, 5).ok).toBe(false);
  });

  it('正文很短时门槛放宽', () => {
    const recap = {
      text: '短摘要',
      keyFacts: [],
      endingState: '',
      openThreads: [],
      generatedAt: '2026-08-01T00:00:00.000Z',
    } as ChapterRecap;
    const r = evaluateRecapQuality(recap, 3, '寥寥数语');
    expect(r.ok).toBe(true);
    expect(r.blockGreen).toBe(false);
  });

  it('recap 正文过短 → 失败并阻断', () => {
    const recap = {
      text: '太短',
      keyFacts: ['林晚晴是剑宗宗主之女'],
      endingState: '人在山门，局势紧张',
      openThreads: [],
      generatedAt: '2026-08-01T00:00:00.000Z',
    } as ChapterRecap;
    const r = evaluateRecapQuality(recap, 2, 'x'.repeat(300));
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain('过短');
    expect(r.blockGreen).toBe(true);
  });

  it('第 3 章起 keyFacts 为空 → 失败', () => {
    const recap = {
      text: '本章叶无痕寻到剑冢入口，与守墓人交手，剑鸣三响，风起云涌，夜色如墨。',
      keyFacts: [],
      endingState: '叶无痕站在剑冢入口前，守墓人持剑而立。',
      openThreads: [],
      generatedAt: '2026-08-01T00:00:00.000Z',
    } as ChapterRecap;
    const r = evaluateRecapQuality(recap, 3, 'x'.repeat(300));
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.includes('keyFacts'))).toBe(true);
  });

  it('第 10 章起不足 2 条 keyFacts → 失败；充足则通过', () => {
    const base = {
      text: '本章叶无痕寻到剑冢入口，与守墓人交手，剑鸣三响，风起云涌，夜色如墨。',
      endingState: '叶无痕站在剑冢入口前，守墓人持剑而立。',
      openThreads: [],
      generatedAt: '2026-08-01T00:00:00.000Z',
    } as ChapterRecap;
    const weak = evaluateRecapQuality({ ...base, keyFacts: ['剑冢在断魂崖下'] }, 10, 'x'.repeat(300));
    expect(weak.ok).toBe(false);

    const strong = evaluateRecapQuality(
      { ...base, keyFacts: ['剑冢在断魂崖下', '守墓人姓姜'] },
      10,
      'x'.repeat(300)
    );
    expect(strong.ok).toBe(true);
    expect(strong.blockGreen).toBe(false);
  });

  it('fallback recap 且高章无事实 → 阻断（记忆不可靠）', () => {
    const recap = {
      text: '本章叶无痕寻到剑冢入口，与守墓人交手，剑鸣三响，风起云涌，夜色如墨。',
      keyFacts: [],
      endingState: '人在剑冢入口。',
      openThreads: [],
      generatedAt: '2026-08-01T00:00:00.000Z',
      source: 'fallback',
    } as ChapterRecap;
    const r = evaluateRecapQuality(recap, 5, 'x'.repeat(300));
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.includes('fallback'))).toBe(true);
    expect(r.blockGreen).toBe(true);
  });

  it('合格 recap（第 2 章）→ ok 且不阻断', () => {
    const recap = {
      text: '本章叶无痕寻到剑冢入口，与守墓人交手，剑鸣三响，风起云涌，夜色如墨。',
      keyFacts: ['剑冢在断魂崖下'],
      endingState: '叶无痕站在剑冢入口前，守墓人持剑而立。',
      openThreads: [],
      generatedAt: '2026-08-01T00:00:00.000Z',
    } as ChapterRecap;
    const r = evaluateRecapQuality(recap, 2, 'x'.repeat(300));
    expect(r.ok).toBe(true);
    expect(r.blockGreen).toBe(false);
    expect(r.summary).toContain('合格');
  });
});
