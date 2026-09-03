/**
 * 引擎绿通/修复门槛纯函数单测：
 * - isDualReviewGreen：三重硬门（机检 + 硬伤 + 综合分）及全部阻断分支
 * - isVerificationScoreGreen / isHardReviewApiBlock
 * - needsConflictFix / collectFixConflicts：修复环进入条件与冲突收集策略
 * - discipline.validatePostWrite：确定性写后校验 5 规则
 *
 * 这些函数决定「自动锁章 vs 待人工」，此前零覆盖——改坏无信号。
 */
import { describe, expect, it } from 'vitest';
import {
  isDualReviewGreen,
  isVerificationScoreGreen,
  isHardReviewApiBlock,
  needsConflictFix,
  collectFixConflicts,
  MIN_GREEN_VERIFICATION_SCORE,
} from '../src/services/aiEngine';
import { validatePostWrite } from '../src/engine/discipline';
import type { RuleScanResult } from '../src/services/ruleScan';
import type { HardReviewResult, MemoryAuditLog } from '../src/types/novel';

function makeRuleScan(overrides?: Partial<RuleScanResult>): RuleScanResult {
  return {
    passed: true,
    score: 95,
    hits: [],
    blacklistHits: 0,
    sublimationHits: 0,
    tellHits: 0,
    patternHits: 0,
    summary: '机检通过',
    ...overrides,
  };
}

function makeHard(overrides?: Partial<HardReviewResult>): HardReviewResult {
  return {
    passed: true,
    score: 92,
    summary: '硬伤审通过',
    issues: [],
    source: 'llm',
    ...overrides,
  };
}

function makeAudit(overrides?: Partial<MemoryAuditLog>): MemoryAuditLog {
  return {
    injectedCharacters: [],
    injectedSettings: [],
    removedClichesCount: 0,
    removedClichésList: [],
    logicConflicts: [],
    verificationScore: 85,
    hardReview: makeHard(),
    hardBlocked: false,
    ...overrides,
  };
}

describe('isDualReviewGreen · 三重硬门', () => {
  it('机检过 + 硬伤过 + 分数达标 → 绿', () => {
    expect(isDualReviewGreen(makeRuleScan(), makeAudit())).toBe(true);
  });

  it('机检未过 → 不绿', () => {
    expect(isDualReviewGreen(makeRuleScan({ passed: false }), makeAudit())).toBe(false);
  });

  it('recap 质量弱 → 不绿', () => {
    expect(
      isDualReviewGreen(makeRuleScan(), makeAudit({ recapQualityBlocked: true }))
    ).toBe(false);
  });

  it('推进度弱（progressionBlocked）→ 不绿', () => {
    expect(
      isDualReviewGreen(makeRuleScan(), makeAudit({ progressionBlocked: true }))
    ).toBe(false);
  });

  it('hardBlocked 标记 → 不绿（即使 hardReview.passed=true）', () => {
    expect(isDualReviewGreen(makeRuleScan(), makeAudit({ hardBlocked: true }))).toBe(false);
  });

  it('未跑硬伤审（hardReview 缺失）→ 不绿（防漏检）', () => {
    const audit = makeAudit();
    delete audit.hardReview;
    expect(isDualReviewGreen(makeRuleScan(), audit)).toBe(false);
  });

  it('硬伤未过 → 不绿', () => {
    expect(
      isDualReviewGreen(
        makeRuleScan(),
        makeAudit({ hardReview: makeHard({ passed: false }), hardBlocked: true })
      )
    ).toBe(false);
  });

  it('API 失败阻断（fallback）→ 不绿', () => {
    expect(
      isDualReviewGreen(
        makeRuleScan(),
        makeAudit({
          hardReview: makeHard({ passed: false, source: 'fallback' }),
          hardBlocked: true,
        })
      )
    ).toBe(false);
  });

  it(`综合分 < ${MIN_GREEN_VERIFICATION_SCORE} → 不绿`, () => {
    expect(
      isDualReviewGreen(makeRuleScan(), makeAudit({ verificationScore: 74 }))
    ).toBe(false);
    expect(
      isDualReviewGreen(makeRuleScan(), makeAudit({ verificationScore: 75 }))
    ).toBe(true);
  });

  it('分数缺失按 0 处理 → 不绿', () => {
    const audit = makeAudit();
    delete audit.verificationScore;
    expect(isDualReviewGreen(makeRuleScan(), audit)).toBe(false);
  });
});

describe('isVerificationScoreGreen', () => {
  it('null/undefined 按 0', () => {
    expect(isVerificationScoreGreen(null)).toBe(false);
    expect(isVerificationScoreGreen(undefined)).toBe(false);
  });
  it('边界：75 过、74 不过', () => {
    expect(isVerificationScoreGreen(75)).toBe(true);
    expect(isVerificationScoreGreen(74.9)).toBe(false);
  });
});

describe('isHardReviewApiBlock · 纯 API 失败识别', () => {
  it('无 hard / 已通过 / llm 来源 → 非 API 阻断', () => {
    expect(isHardReviewApiBlock(null)).toBe(false);
    expect(isHardReviewApiBlock(makeHard())).toBe(false);
    expect(
      isHardReviewApiBlock(makeHard({ passed: false, source: 'llm' }))
    ).toBe(false);
  });

  it('fallback 且仅含「硬伤审调用失败」类 issue → API 阻断（修复环无意义）', () => {
    const hard = makeHard({
      passed: false,
      source: 'fallback',
      issues: [
        {
          type: '其他硬伤',
          severity: 'error',
          description: '硬伤审调用失败：timeout。为防止幻觉漏检…',
          suggestion: '重跑',
        },
      ],
    });
    expect(isHardReviewApiBlock(hard)).toBe(true);
  });

  it('fallback 但含真实 issue → 非纯 API 阻断', () => {
    const hard = makeHard({
      passed: false,
      source: 'fallback',
      issues: [
        {
          type: '状态冲突',
          severity: 'error',
          description: '已死角色林越在段末出手',
          suggestion: '改为回忆或他人代持',
        },
      ],
    });
    expect(isHardReviewApiBlock(hard)).toBe(false);
  });

  it('fallback 且含本地断言 error → 可修，不算 API 阻断', () => {
    const hard = makeHard({
      passed: false,
      source: 'fallback',
      issues: [
        {
          type: '吃书矛盾',
          severity: 'error',
          description: '[本地断言] 阵亡角色行动',
          suggestion: '改正文',
        },
      ],
    });
    expect(isHardReviewApiBlock(hard)).toBe(false);
  });
});

describe('needsConflictFix · 修复环进入条件', () => {
  it('机检未过 → 进修复', () => {
    expect(needsConflictFix(makeRuleScan({ passed: false }), [])).toBe(true);
  });

  it('硬伤未过 → 进修复', () => {
    expect(
      needsConflictFix(makeRuleScan(), [], makeHard({ passed: false }))
    ).toBe(true);
  });

  it('纯文笔软建议（lane=style / [文笔建议]）→ 不进修复', () => {
    const conflicts: MemoryAuditLog['logicConflicts'] = [
      {
        type: '行文套路',
        description: '[文笔建议] 第二段比喻过密',
        suggestion: '删一个',
        lane: 'style',
      },
      {
        type: '行文套路',
        description: '对话标签偏多',
        suggestion: '精简',
        lane: 'style',
      },
    ];
    expect(needsConflictFix(makeRuleScan(), conflicts, makeHard())).toBe(false);
  });

  it('lane=hard 或硬伤类 type → 进修复', () => {
    const conflicts: MemoryAuditLog['logicConflicts'] = [
      {
        type: '其他硬伤',
        description: '时间线对不上',
        suggestion: '修',
        lane: 'hard',
      },
    ];
    expect(needsConflictFix(makeRuleScan(), conflicts, makeHard())).toBe(true);
    const byType: MemoryAuditLog['logicConflicts'] = [
      { type: '道具归属', description: '剑无故换手', suggestion: '交代' },
    ];
    expect(needsConflictFix(makeRuleScan(), byType, makeHard())).toBe(true);
  });

  it('纯 API 阻断且机检已过 → 不进修复（改写解决不了 API）', () => {
    const hard = makeHard({
      passed: false,
      source: 'fallback',
      issues: [
        {
          type: '其他硬伤',
          severity: 'error',
          description: '硬伤审调用失败：timeout',
          suggestion: '重跑',
        },
      ],
    });
    expect(needsConflictFix(makeRuleScan(), [], hard)).toBe(false);
  });
});

describe('collectFixConflicts · 本轮修复清单', () => {
  const scanWithErrors = makeRuleScan({
    passed: false,
    hits: [
      {
        kind: 'blacklist',
        severity: 'error',
        phrase: '命运的齿轮',
        count: 2,
        sample: '命运的齿轮开始转动',
        suggestion: '删除套话',
      },
    ],
  });
  const llmConflicts: MemoryAuditLog['logicConflicts'] = [
    { type: '吃书矛盾', description: '与前章钉死事实冲突：林越佩剑', suggestion: '改回断剑', lane: 'hard' },
    { type: '行文套路', description: '[文笔建议] 节奏偏缓', suggestion: '删', lane: 'style' },
  ];

  it('机检 error 每轮都进清单（round 1 与 2 均含）', () => {
    const r1 = collectFixConflicts(scanWithErrors, llmConflicts, 1);
    const r2 = collectFixConflicts(scanWithErrors, llmConflicts, 2);
    expect(r1.some((i) => i.type === '规则机检·blacklist')).toBe(true);
    expect(r2.some((i) => i.type === '规则机检·blacklist')).toBe(true);
  });

  it('LLM 冲突仅第 1 轮带入；第 2 轮只剩机检', () => {
    const r1 = collectFixConflicts(scanWithErrors, llmConflicts, 1);
    const r2 = collectFixConflicts(scanWithErrors, llmConflicts, 2);
    expect(r1.some((i) => i.description.includes('佩剑'))).toBe(true);
    expect(r2.some((i) => i.description.includes('佩剑'))).toBe(false);
    expect(r2.every((i) => i.type.startsWith('规则机检'))).toBe(true);
  });

  it('style lane / [文笔建议] 不进修复清单', () => {
    const r1 = collectFixConflicts(scanWithErrors, llmConflicts, 1);
    expect(r1.some((i) => i.description.includes('文笔建议'))).toBe(false);
    expect(r1.some((i) => i.description.includes('节奏偏缓'))).toBe(false);
  });

  it('同 type+description 去重', () => {
    const dup: MemoryAuditLog['logicConflicts'] = [
      { type: '吃书矛盾', description: '同一条', suggestion: 'a', lane: 'hard' },
      { type: '吃书矛盾', description: '同一条', suggestion: 'b', lane: 'hard' },
    ];
    const out = collectFixConflicts(makeRuleScan(), dup, 1);
    expect(out.filter((i) => i.description === '同一条')).toHaveLength(1);
  });
});

describe('validatePostWrite · 确定性写后校验', () => {
  it('干净文本零违规', () => {
    expect(
      validatePostWrite('他把剑收进鞘里，转身出门。街上人不多，雨刚停。')
    ).toHaveLength(0);
  });

  it('「不是…而是…」句式 → error', () => {
    const v = validatePostWrite('这不是恐惧，而是一种更深的警觉。');
    expect(v.some((x) => x.rule === '禁止句式' && x.severity === 'error')).toBe(true);
  });

  it('破折号 → error', () => {
    const v = validatePostWrite('他停住——有人在外面。');
    expect(v.some((x) => x.rule === '禁止破折号')).toBe(true);
  });

  it('转折/惊讶词超密度 → warning', () => {
    const text = Array.from({ length: 30 }, (_, i) => `他忽然转身${i}。`).join('');
    const v = validatePostWrite(text);
    expect(v.some((x) => x.rule === '转折词密度' && x.severity === 'warning')).toBe(true);
  });

  it('感官堆砌段（≥4 个感官 token 的短段）→ warning；≥3 段升 error', () => {
    const stack = '掌心一片温热，伤口黏腻，指尖发麻，铁锈味腥得出奇。';
    const one = validatePostWrite(`${stack}\n\n他退后两步，靠着墙调整呼吸。`);
    expect(one.some((x) => x.rule === '描写过细' && x.severity === 'warning')).toBe(true);
    const three = validatePostWrite(
      [stack, stack, stack].join('\n\n')
    );
    expect(three.some((x) => x.rule === '描写过细' && x.severity === 'error')).toBe(true);
  });

  it('报告术语入正文 → error', () => {
    const v = validatePostWrite('他心中盘算着核心动机与信息边界。');
    expect(v.some((x) => x.rule === '报告术语' && x.severity === 'error')).toBe(true);
  });
});
