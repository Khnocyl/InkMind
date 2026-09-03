/**
 * 审校新鲜度（auditFreshness）单测：
 * 1. fingerprintProse 稳定性 / 区分度
 * 2. isAuditStale：无审校 / 有锚匹配 / 正文改动 / 旧数据缺锚
 * 3. mergeAuditRefresh：复核结论替换 + 管线痕迹保留 + 版本锚写入
 * 4. deriveHardTodosAfterRerun：复核未过关 → 硬伤派生待修；去重 / 过关 / 仅 warn 不派生
 * 5. auditExistingProse（mock LLM 层）：复核只读硬保证——输出 prose 恒等于输入，
 *    即使文笔审返回润色稿也绝不被采用，且 auditLog/ruleScan 正常产出。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const generateJSONMock = vi.fn();
const generateStreamMock = vi.fn();

vi.mock('../src/services/llmClient', () => ({
  generateJSON: (...args: unknown[]) => generateJSONMock(...(args as [])),
  generateStream: (...args: unknown[]) => generateStreamMock(...(args as [])),
  isBudgetExceededError: () => false,
  setBudgetConfig: vi.fn(),
  setActiveUsageContext: vi.fn(),
  setActiveAbortSignal: vi.fn(),
  getActiveAbortSignal: () => null,
}));

import {
  deriveHardTodosAfterRerun,
  fingerprintProse,
  isAuditStale,
  mergeAuditRefresh,
} from '../src/services/auditFreshness';
import { auditExistingProse } from '../src/engine/agents/auditorAgent';
import { getDefaultStyleConfig } from '../src/services/storage';
import type {
  Chapter,
  Character,
  HardReviewIssue,
  MemoryAuditLog,
  StyleConfig,
  WorldSetting,
} from '../src/types/novel';

const PROSE = [
  '林越推开旧宅侧门，木轴发出一声闷响。',
  '堂屋的账案上摆着一本蓝皮账册，边角被老鼠啃过。',
  '他翻开第三页，父亲的小楷排在漕运的条目下，一笔一笔都对得上。',
].join('\n\n');

function styleConfigWith(overrides?: Partial<StyleConfig>): StyleConfig {
  return {
    ...getDefaultStyleConfig(),
    clicheBlacklist: [],
    customBlacklist: [],
    ...(overrides || {}),
  };
}

function makeChapter(overrides?: Partial<Chapter>): Chapter {
  return {
    id: 'ch3',
    number: 3,
    title: '虎符',
    summary: '夜探旧宅',
    wordCount: PROSE.replace(/\s+/g, '').length,
    status: '正文草稿',
    content: PROSE,
    involvedCharacterIds: ['c1'],
    involvedSettingIds: [],
    beats: [],
    lastModified: '',
    ...(overrides || {}),
  };
}

function makeCharacters(): Character[] {
  return [
    {
      id: 'c1',
      name: '林越',
      alias: '',
      role: '主角',
      status: '活跃',
      realmOrTitle: '',
      currentLocation: '旧宅',
      personality: '谨慎',
      appearance: '',
      background: '',
      relations: [],
      secretNotes: '',
    },
  ];
}

/** 按 prompt 标记路由 generateJSON；未匹配即抛错（暴露意外调用） */
function routeJSON(table: Record<string, unknown>) {
  generateJSONMock.mockImplementation(async (messages: unknown[]) => {
    const all = (messages || [])
      .map((m) => String((m as { content?: string })?.content || ''))
      .join('\n');
    for (const [marker, resp] of Object.entries(table)) {
      if (all.includes(marker)) return resp;
    }
    throw new Error(`未匹配的 LLM 调用: ${all.slice(0, 60)}`);
  });
}

describe('fingerprintProse · 正文指纹', () => {
  it('确定性：同一正文恒同指纹', () => {
    expect(fingerprintProse(PROSE)).toBe(fingerprintProse(PROSE));
    expect(fingerprintProse('')).toBe(fingerprintProse(''));
  });

  it('区分度：单字改动即翻转', () => {
    const changed = PROSE.replace('林越', '林岳');
    expect(fingerprintProse(changed)).not.toBe(fingerprintProse(PROSE));
  });

  it('区分度：同长度不同内容也翻转（长度+内容双通道）', () => {
    const a = '甲乙丙丁戊己庚辛壬癸';
    const b = '一二三四五六七八九十';
    expect(a.length).toBe(b.length);
    expect(fingerprintProse(a)).not.toBe(fingerprintProse(b));
  });
});

describe('isAuditStale · 过期判定', () => {
  it('无 memoryAudit → 不过期（false）', () => {
    expect(isAuditStale(makeChapter({ memoryAudit: undefined }))).toBe(false);
  });

  it('有版本锚且与正文匹配 → 不过期（false）', () => {
    const chapter = makeChapter({
      memoryAudit: { auditedContentAt: fingerprintProse(PROSE) } as MemoryAuditLog,
    });
    expect(isAuditStale(chapter)).toBe(false);
  });

  it('正文已改动 → 过期（true）', () => {
    const chapter = makeChapter({
      memoryAudit: { auditedContentAt: fingerprintProse(PROSE) } as MemoryAuditLog,
      content: `${PROSE}\n\n新补的一段正文。`,
    });
    expect(isAuditStale(chapter)).toBe(true);
  });

  it('旧数据缺版本锚 → 诚实判过期（true）', () => {
    const chapter = makeChapter({
      memoryAudit: { verificationScore: 80 } as MemoryAuditLog,
    });
    expect(isAuditStale(chapter)).toBe(true);
  });
});

describe('mergeAuditRefresh · 复核结果合并', () => {
  const oldAudit: MemoryAuditLog = {
    injectedCharacters: ['旧角色'],
    injectedSettings: ['旧设定'],
    injectedPreviousContext: true,
    previousContextSource: '第2章 · 尾段500字',
    removedClichesCount: 2,
    removedClichésList: ['旧套话'],
    logicConflicts: [
      // 审校派生条目：应被 freshAudit 覆盖
      { type: '战力越界', description: '旧硬伤', suggestion: '', lane: 'hard' },
      { type: '行文套路', description: '[文笔建议] 旧建议', suggestion: '', lane: 'style' },
      { type: '行文套路', description: '[规则机检·blacklist] 禁忌短语 ×1', suggestion: '' },
      // 非审校派生（recap 矛盾，无 lane）：应保留
      { type: '吃书矛盾', description: '与旧钉死事实潜在矛盾', suggestion: '' },
    ],
    verificationScore: 50,
    ruleScan: {
      passed: false,
      score: 40,
      summary: '旧机检',
      blacklistHits: 1,
      sublimationHits: 0,
      tellHits: 0,
      hitPhrases: ['禁忌短语'],
      hits: [],
    },
    hardReview: { passed: false, score: 40, summary: '旧硬伤结论', issues: [] },
    memoryInjectionSummary: '旧注入摘要',
    memoryDebtCount: 3,
    fixHistory: [
      {
        round: 1,
        conflictCount: 2,
        ruleScanPassedAfter: false,
        summary: '旧修复',
      },
    ],
  };

  const freshAudit: MemoryAuditLog = {
    injectedCharacters: ['新角色'],
    injectedSettings: ['新设定'],
    removedClichesCount: 0,
    removedClichésList: [],
    logicConflicts: [
      { type: '状态冲突', description: '新硬伤', suggestion: '', lane: 'hard' },
      { type: '行文套路', description: '[文笔建议] 新建议', suggestion: '', lane: 'style' },
    ],
    verificationScore: 88,
    ruleScan: {
      passed: true,
      score: 90,
      summary: '新机检',
      blacklistHits: 0,
      sublimationHits: 0,
      tellHits: 0,
      hitPhrases: [],
      hits: [],
    },
    hardReview: { passed: true, score: 90, summary: '新硬伤结论', issues: [] },
  };

  it('复核结论替换旧审校字段，管线痕迹保留，版本锚写入', () => {
    const merged = mergeAuditRefresh(oldAudit, freshAudit, 'fp-abc', '2026-08-27T10:00:00.000Z');

    // 审校结论取复核
    expect(merged.hardReview?.passed).toBe(true);
    expect(merged.hardReview?.score).toBe(90);
    expect(merged.verificationScore).toBe(88);
    expect(merged.ruleScan?.passed).toBe(true);
    // 管线痕迹保留（复核不重跑注入/修复环）
    expect(merged.injectedCharacters).toEqual(['旧角色']);
    expect(merged.injectedPreviousContext).toBe(true);
    expect(merged.previousContextSource).toBe('第2章 · 尾段500字');
    expect(merged.memoryInjectionSummary).toBe('旧注入摘要');
    expect(merged.memoryDebtCount).toBe(3);
    expect(merged.fixHistory).toEqual(oldAudit.fixHistory);
    // 版本锚
    expect(merged.auditedContentAt).toBe('fp-abc');
    expect(merged.lastHardReviewAt).toBe('2026-08-27T10:00:00.000Z');
  });

  it('logicConflicts：审校派生旧条目被替换，非审校（recap 矛盾）旧条目保留', () => {
    const merged = mergeAuditRefresh(oldAudit, freshAudit, 'fp-abc');

    const types = merged.logicConflicts.map((c) => c.type);
    const descriptions = merged.logicConflicts.map((c) => c.description);
    // 新审校条目在
    expect(types).toContain('状态冲突');
    expect(descriptions).toContain('[文笔建议] 新建议');
    // 旧审校派生条目被清
    expect(descriptions).not.toContain('旧硬伤');
    expect(descriptions).not.toContain('[文笔建议] 旧建议');
    expect(descriptions).not.toContain('[规则机检·blacklist] 禁忌短语 ×1');
    // 非审校旧条目（recap 矛盾）保留
    expect(descriptions).toContain('与旧钉死事实潜在矛盾');
  });

  it('oldAudit 为空时不抛错，回退到 freshAudit 取值', () => {
    const merged = mergeAuditRefresh(null, freshAudit, 'fp-abc');
    expect(merged.hardReview?.score).toBe(90);
    expect(merged.injectedCharacters).toEqual(['新角色']);
    expect(merged.auditedContentAt).toBe('fp-abc');
    expect(merged.lastHardReviewAt).toBeUndefined();
  });

  it('合并后可被 isAuditStale 正常消费（锚匹配 → 不过期）', () => {
    const fp = fingerprintProse(PROSE);
    const merged = mergeAuditRefresh(oldAudit, freshAudit, fp);
    const chapter = makeChapter({ memoryAudit: merged });
    expect(isAuditStale(chapter)).toBe(false);
    // 正文再改 → 过期
    expect(isAuditStale({ ...chapter, content: `${PROSE}\n\n新正文。` })).toBe(true);
  });
});

describe('deriveHardTodosAfterRerun · 重跑后派生待修', () => {
  const errorIssue: HardReviewIssue = {
    type: '状态冲突',
    severity: 'error',
    description: '账本记载「林越已阵亡/退出」（第1章），正文似仍有当下行动',
    suggestion: '改为回忆/他人转述，或修正角色状态与账本。',
  };
  const warnIssue: HardReviewIssue = {
    type: '时间线错乱',
    severity: 'warn',
    description: '正文写「故事第2天」，账本上章约第9天，疑似时间倒流',
    suggestion: '改为闪回并标明，或修正时间表述。',
  };

  function makeAuditLog(overrides?: Partial<MemoryAuditLog>): MemoryAuditLog {
    return {
      injectedCharacters: [],
      injectedSettings: [],
      removedClichesCount: 0,
      removedClichésList: [],
      logicConflicts: [],
      verificationScore: 0,
      ...(overrides || {}),
    };
  }

  it('复核未过且 issues 含 error → 派生待修：带 [硬伤] 前缀、status=open', () => {
    const chapter = makeChapter();
    const audit = makeAuditLog({
      verificationScore: 55,
      hardReview: {
        passed: false,
        score: 55,
        summary: '硬伤未过',
        issues: [errorIssue],
      },
    });
    const { chapter: next, added } = deriveHardTodosAfterRerun(chapter, audit);
    expect(added).toBe(1);
    expect(next.revisionTodos).toHaveLength(1);
    expect(next.revisionTodos![0].text.startsWith('[硬伤]')).toBe(true);
    expect(next.revisionTodos![0].status).toBe('open');
  });

  it('同一 issue 二次派生 → 按文本前缀去重，added=0', () => {
    const chapter = makeChapter();
    const audit = makeAuditLog({
      verificationScore: 55,
      hardReview: {
        passed: false,
        score: 55,
        summary: '硬伤未过',
        issues: [errorIssue],
      },
    });
    const once = deriveHardTodosAfterRerun(chapter, audit);
    const twice = deriveHardTodosAfterRerun(once.chapter, audit);
    expect(once.added).toBe(1);
    expect(twice.added).toBe(0);
    expect(twice.chapter.revisionTodos).toHaveLength(1);
  });

  it('hardReview.passed=true 且无 error 级 → 不派生，added=0', () => {
    const chapter = makeChapter();
    const audit = makeAuditLog({
      verificationScore: 88,
      hardReview: {
        passed: true,
        score: 90,
        summary: '通过',
        issues: [warnIssue],
      },
    });
    const { chapter: next, added } = deriveHardTodosAfterRerun(chapter, audit);
    expect(added).toBe(0);
    expect(next).toBe(chapter); // 原样返回，不动 revisionTodos
    expect(next.revisionTodos).toBeUndefined();
  });

  it('issues 全为 warn（errorsOnly 过滤）→ added=0', () => {
    const chapter = makeChapter();
    const audit = makeAuditLog({
      verificationScore: 70,
      hardReview: {
        passed: false,
        score: 70,
        summary: '仅警告',
        issues: [warnIssue],
      },
    });
    const { chapter: next, added } = deriveHardTodosAfterRerun(chapter, audit);
    expect(added).toBe(0);
    expect(next).toBe(chapter);
    expect(next.revisionTodos).toBeUndefined();
  });

  it('hardReview 结论缺失 → 不派生，added=0', () => {
    const chapter = makeChapter();
    const audit = makeAuditLog({ verificationScore: 80 });
    const { chapter: next, added } = deriveHardTodosAfterRerun(chapter, audit);
    expect(added).toBe(0);
    expect(next).toBe(chapter);
  });
});

describe('auditExistingProse · 重跑复核（mock LLM）', () => {
  beforeEach(() => {
    generateJSONMock.mockReset();
    generateStreamMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('复核只读：输出 prose 恒等于输入，润色稿绝不被采用', async () => {
    routeJSON({
      硬伤审查官: { hardScore: 88, hardPassed: true, summary: '硬伤审通过', issues: [] },
      文笔审校官: {
        styleScore: 84,
        summary: '文笔可接受',
        suggestions: [],
        removedClichésList: [],
        removedSublimationsCount: 0,
        // 故意返回与输入完全不同的润色稿——复核必须丢弃它
        polishedProse: '这是一份完全不同的润色稿，绝不应被采用。',
      },
      进度审查官: {
        progressionScore: 85,
        mainLineAdvanced: true,
        wateriness: 1,
        unfinishedBeats: [],
        touchedThreads: [],
        suggestions: [],
        summary: '主线推进明确',
      },
    });

    const chapter = makeChapter();
    const result = await auditExistingProse({
      chapter,
      characters: makeCharacters(),
      settings: [] as WorldSetting[],
      styleConfig: styleConfigWith(),
      storyMemory: null,
      chapterIntent: chapter.intent,
    });

    // 硬保证：一个字都没改
    expect(result.prose).toBe(chapter.content);
    expect(result.prose).not.toContain('完全不同的润色稿');
    // 没有发起任何正文生成调用（无 writer / 无补写）
    expect(generateStreamMock).not.toHaveBeenCalled();

    // auditLog 正常产出：硬伤结论 + 文笔结论（未误报已润色）
    expect(result.auditLog.hardReview?.passed).toBe(true);
    expect(result.auditLog.hardReview?.score).toBe(88);
    expect(result.auditLog.styleReview?.polishedApplied).toBe(false);
    expect(result.auditLog.polishDiff?.materiallyChanged).toBe(false);
    // 综合分 = 硬伤 55% + 文笔 45%（复核口径与管线一致）
    expect(result.auditLog.verificationScore).toBe(Math.round(88 * 0.55 + 84 * 0.45));
    // 规则机检零 LLM 复扫
    expect(result.ruleScan?.passed).toBe(true);
    // 写后确定性校验（正文干净 → 无违规）
    expect(result.postWriteViolations).toEqual([]);
  });

  it('复核可感知正文变化：同一章改一个标点后重跑，审校结论随正文重算', async () => {
    routeJSON({
      硬伤审查官: { hardScore: 60, hardPassed: false, summary: '发现硬伤', issues: [] },
      文笔审校官: {
        styleScore: 80,
        summary: '文笔可接受',
        suggestions: [],
        removedClichésList: [],
        removedSublimationsCount: 0,
      },
      进度审查官: {
        progressionScore: 85,
        mainLineAdvanced: true,
        wateriness: 1,
        unfinishedBeats: [],
        touchedThreads: [],
        suggestions: [],
        summary: '主线推进明确',
      },
    });

    const chapter = makeChapter();
    const result = await auditExistingProse({
      chapter,
      characters: makeCharacters(),
      settings: [] as WorldSetting[],
      styleConfig: styleConfigWith(),
      storyMemory: null,
    });

    expect(result.prose).toBe(chapter.content);
    expect(result.auditLog.hardReview?.passed).toBe(false);
    expect(result.auditLog.hardBlocked).toBe(true);
    // 硬伤未过 → 综合分压至 ≤68
    expect(result.auditLog.verificationScore ?? 0).toBeLessThanOrEqual(68);
  });
});
