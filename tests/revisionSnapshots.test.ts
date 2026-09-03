/**
 * 修复环核心能力单测：快照回退 + 净提升止损 + 审稿不可信安全阀。
 *
 * 覆盖：
 * - 择优回退：循环结束最终态非最高分 → 回退最优快照（综合分最高，同分比硬伤分）
 * - 净提升止损：单轮综合分相对上一快照下降 ≥3 → 提前退出并回退最优快照
 * - 降幅 <3 / 单调上升 / 最终态即最优 → 不回退、无 revisionRollback 字段
 * - auditUnreliable → reviser 冻结全部自动修稿（零 LLM 调用，原文原结论直通）
 * - auditor 判定：硬伤审 API fallback 无结论 / 综合分与机检分背离 >25
 *
 * mock 策略参考 tests/enginePipeline.test.ts：在 aiEngine 模块边界打桩，
 * needsConflictFix / isHardReviewApiBlock 用真实实现（测真实门槛逻辑）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const fixLoopMock = vi.fn();
const hardReviewMock = vi.fn();
const step3Mock = vi.fn();

vi.mock('../src/services/aiEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/aiEngine')>();
  return {
    ...actual,
    runConflictFixLoop: (...args: unknown[]) => fixLoopMock(...(args as [])),
    runHardReview: (...args: unknown[]) => hardReviewMock(...(args as [])),
    step3_CriticVerify: (...args: unknown[]) => step3Mock(...(args as [])),
  };
});

import {
  runReviserAgent,
  pickBestRevisionSnapshot,
  isNetLossStop,
  makeRevisionSnapshot,
  REVISION_NET_LOSS_THRESHOLD,
} from '../src/engine/agents/reviserAgent';
import { runAuditorAgent } from '../src/engine/agents/auditorAgent';
import type { AgentContext, ChapterPipelineInput } from '../src/engine/types';
import type { MemoryAuditLog, HardReviewResult, PlotBeat } from '../src/types/novel';
import type { RuleScanResult } from '../src/services/ruleScan';

// ─── 夹具 ───

const PROSE_IN = '林越把账册收进包袱，吹熄了油灯，顺着后窗翻出院墙。';
const PROSE_R1 = '林越把账册收进包袱，吹熄了油灯，贴着墙根拐进了东巷。';
const PROSE_R2 = '林越把账册塞进包袱，吹熄了油灯，快步消失在巷子深处。';
const PROSE_RW = '林越背起包袱，熄了灯，从后院的小门走了出去。';

function makeScan(overrides?: Partial<RuleScanResult>): RuleScanResult {
  return {
    passed: false,
    score: 55,
    hits: [],
    blacklistHits: 1,
    sublimationHits: 0,
    tellHits: 0,
    patternHits: 0,
    summary: '黑名单命中 1 处',
    ...overrides,
  };
}

function makeAudit(overrides?: Partial<MemoryAuditLog>): MemoryAuditLog {
  return {
    injectedCharacters: ['林越'],
    injectedSettings: [],
    removedClichesCount: 0,
    removedClichésList: [],
    logicConflicts: [],
    verificationScore: 70,
    hardReview: {
      passed: false,
      score: 60,
      summary: '发现硬伤',
      issues: [
        {
          type: '状态冲突',
          severity: 'error',
          description: '林越已阵亡却又出场',
          suggestion: '改写至自洽',
        },
      ],
      source: 'llm',
    },
    hardBlocked: true,
    ...overrides,
  };
}

/** 修复环脚本步：每步对应一次 runConflictFixLoop 调用的返回 */
interface FixStep {
  prose: string;
  /** 该轮产出快照的综合分 */
  score: number;
  /** 该轮产出快照的硬伤分（同分 tie-break 测试用） */
  hardScore?: number;
  /** 返回的机检状态（默认保持未过，让下一轮继续跑） */
  scanPassed?: boolean;
  scanScore?: number;
}

function scriptFixSteps(steps: FixStep[]) {
  let call = 0;
  fixLoopMock.mockImplementation(
    (
      _prose: string,
      audit: MemoryAuditLog,
      scan: RuleScanResult
      // eslint/oxlint: 模拟 aiEngine 真实签名，多余参数不使用
    ) => {
      const step = steps[Math.min(call, steps.length - 1)];
      call += 1;
      const hard: HardReviewResult = {
        ...((audit.hardReview as HardReviewResult) ?? makeAudit().hardReview!),
      };
      if (step.hardScore !== undefined) hard.score = step.hardScore;
      return Promise.resolve({
        prose: step.prose,
        auditLog: { ...audit, verificationScore: step.score, hardReview: hard },
        ruleScan: {
          ...scan,
          passed: step.scanPassed ?? scan.passed,
          score: step.scanScore ?? scan.score,
        },
        fixRounds: 1,
        resolved: (step.scanPassed ?? scan.passed) && true,
        history: [
          {
            round: 1,
            conflictCount: 1,
            ruleScanPassedAfter: step.scanPassed ?? scan.passed,
            summary: '[局部] 第1轮补丁',
            changesSummary: ['改写冲突句'],
            diffSummary: '+1/-1',
            charDelta: 0,
            diffHunks: [],
            localPatchesApplied: 1,
          },
        ],
      });
    }
  );
  return () => call;
}

/** 复检硬伤默认通过（保持当前综合分不变，隔离快照逻辑） */
function mockRecheckPass(score = 88) {
  hardReviewMock.mockResolvedValue({
    passed: true,
    score,
    summary: '复核通过',
    issues: [],
    source: 'llm',
  });
}

function makeCtx(overrides?: {
  maxReviseRounds?: number;
  report?: (stage: string, msg: string) => void;
}): { ctx: AgentContext; messages: string[] } {
  const messages: string[] = [];
  const input = {
    project: { id: 'p-test', memory: null },
    chapter: { number: 3, intent: null, involvedCharacterIds: [] },
    characters: [],
    settings: [],
    styleConfig: {},
    previousContext: '',
    contextPack: { text: '', preview: '', isFirstChapter: true },
    storyMemoryBlock: '',
    chapterIntentBlock: '',
    genrePackBlock: '',
    previousProse: '',
    targetWordCount: null,
    writeMode: 'until_green',
    maxReviseRounds: overrides?.maxReviseRounds,
  } as unknown as ChapterPipelineInput;
  return {
    ctx: {
      input,
      hooks: {},
      report: overrides?.report ?? ((_, msg) => messages.push(msg)),
    },
    messages,
  };
}

// ─── 纯函数：择优与止损判定 ───

describe('revision snapshot 纯函数', () => {
  it('择优：综合分最高者胜，同分比硬伤分，并列保留先出现者', () => {
    const s0 = makeRevisionSnapshot(0, 'a', makeAudit({ verificationScore: 70 }), makeScan());
    const s1 = makeRevisionSnapshot(
      1,
      'b',
      makeAudit({ verificationScore: 72, hardReview: { passed: false, score: 80, summary: '', issues: [] } }),
      makeScan()
    );
    const s2 = makeRevisionSnapshot(
      2,
      'c',
      makeAudit({ verificationScore: 72, hardReview: { passed: false, score: 65, summary: '', issues: [] } }),
      makeScan()
    );
    expect(pickBestRevisionSnapshot([s0, s1, s2])).toBe(s1);
    expect(pickBestRevisionSnapshot([s1, s2])).toBe(s1);
  });

  it('净提升止损阈值：降幅恰 ≥3 止损，<3 不止损', () => {
    const prev = makeRevisionSnapshot(0, 'a', makeAudit({ verificationScore: 70 }), makeScan());
    expect(REVISION_NET_LOSS_THRESHOLD).toBe(3);
    expect(isNetLossStop(prev, 67)).toBe(true);
    expect(isNetLossStop(prev, 68)).toBe(false);
    expect(isNetLossStop(prev, 71)).toBe(false);
  });
});

// ─── 能力①：快照回退 + 净提升止损（集成：runReviserAgent） ───

describe('修复环快照回退（reviserAgent）', () => {
  beforeEach(() => {
    fixLoopMock.mockReset();
    hardReviewMock.mockReset();
    step3Mock.mockReset();
    mockRecheckPass();
  });

  it('择优回退：70→78→77（末轮降幅 1 不止损），最终态非最优 → 回退 78（best-snapshot）', async () => {
    const count = scriptFixSteps([
      { prose: PROSE_R1, score: 78 },
      { prose: PROSE_R2, score: 77 },
    ]);
    const { ctx, messages } = makeCtx({ maxReviseRounds: 2 });
    const out = await runReviserAgent(ctx, PROSE_IN, makeAudit(), makeScan());

    expect(count()).toBe(2); // 未提前退出，跑满 2 轮
    expect(out.prose).toBe(PROSE_R1); // 回退到 78 分快照
    expect(out.auditLog.verificationScore).toBe(78);
    expect(out.auditLog.revisionRollback).toEqual({
      fromScore: 77,
      toScore: 78,
      reason: 'best-snapshot',
    });
    expect(out.auditLog.fixRounds).toBe(2);
    expect(out.auditLog.fixHistory?.map((h) => h.round)).toEqual([1, 2]);
    expect(messages.some((m) => m.includes('已回退到最高分版本（77→78'))).toBe(true);
  });

  it('净提升止损：70→78→60（降 18 ≥3）→ 第 3 轮不执行，回退 78（net-loss）', async () => {
    const count = scriptFixSteps([
      { prose: PROSE_R1, score: 78 },
      { prose: PROSE_R2, score: 60 },
      { prose: PROSE_RW, score: 62 }, // 不应被消费
    ]);
    const { ctx, messages } = makeCtx({ maxReviseRounds: 3 });
    const out = await runReviserAgent(ctx, PROSE_IN, makeAudit(), makeScan());

    expect(count()).toBe(2); // 提前退出
    expect(out.prose).toBe(PROSE_R1);
    expect(out.auditLog.verificationScore).toBe(78);
    expect(out.auditLog.revisionRollback).toEqual({
      fromScore: 60,
      toScore: 78,
      reason: 'net-loss',
    });
    expect(messages.some((m) => m.includes('止损'))).toBe(true);
    expect(messages.some((m) => m.includes('已回退到最高分版本（60→78'))).toBe(true);
  });

  it('降幅 <3 不止损：70→72→73，最终态即最优 → 不回退、无 revisionRollback 字段', async () => {
    scriptFixSteps([
      { prose: PROSE_R1, score: 72 },
      { prose: PROSE_R2, score: 73 },
    ]);
    const { ctx } = makeCtx({ maxReviseRounds: 2 });
    const out = await runReviserAgent(ctx, PROSE_IN, makeAudit(), makeScan());

    expect(out.prose).toBe(PROSE_R2);
    expect(out.auditLog.verificationScore).toBe(73);
    expect('revisionRollback' in out.auditLog).toBe(false);
  });

  it('单调上升不回退：70→74→78，最终态即最优', async () => {
    scriptFixSteps([
      { prose: PROSE_R1, score: 74 },
      { prose: PROSE_R2, score: 78 },
    ]);
    const { ctx } = makeCtx({ maxReviseRounds: 2 });
    const out = await runReviserAgent(ctx, PROSE_IN, makeAudit(), makeScan());

    expect(out.prose).toBe(PROSE_R2);
    expect(out.auditLog.verificationScore).toBe(78);
    expect('revisionRollback' in out.auditLog).toBe(false);
  });

  it('同分比硬伤分：72(hard80)→72(hard60) → 回退硬伤分更高的第 1 轮', async () => {
    scriptFixSteps([
      { prose: PROSE_R1, score: 72, hardScore: 80 },
      { prose: PROSE_R2, score: 72, hardScore: 60 },
    ]);
    const { ctx } = makeCtx({ maxReviseRounds: 2 });
    const out = await runReviserAgent(ctx, PROSE_IN, makeAudit(), makeScan());

    expect(out.prose).toBe(PROSE_R1);
    expect(out.auditLog.revisionRollback).toEqual({
      fromScore: 72,
      toScore: 72,
      reason: 'best-snapshot',
    });
  });

  it('止损回退到第 0 快照：70→60（降 10）→ 原文原机检、结论按复检流程走', async () => {
    const auditIn = makeAudit();
    const scanIn = makeScan();
    scriptFixSteps([{ prose: PROSE_R1, score: 60 }]);
    const { ctx } = makeCtx({ maxReviseRounds: 2 });
    const out = await runReviserAgent(ctx, PROSE_IN, auditIn, scanIn);

    expect(out.prose).toBe(PROSE_IN);
    expect(out.ruleScan).toBe(scanIn); // 回退第 0 快照的机检 = 原对象
    expect(out.auditLog.verificationScore).toBe(70); // 复检通过，保持回退分
    expect(out.auditLog.hardBlocked).toBe(false);
    expect(out.auditLog.revisionRollback).toEqual({
      fromScore: 60,
      toScore: 70,
      reason: 'net-loss',
    });
    expect(out.auditLog.fixRounds).toBe(1); // 尝试过 1 轮
  });

  it('beat 重写升级档参与择优：70→68 后升级重写得 60 → 回退初稿；升级调用 maxRounds=0', async () => {
    scriptFixSteps([
      { prose: PROSE_R1, score: 68 },
      { prose: PROSE_RW, score: 60 }, // 升级档（第 2 次调用）
    ]);
    const { ctx } = makeCtx({ maxReviseRounds: 1 });
    const out = await runReviserAgent(
      ctx,
      PROSE_IN,
      makeAudit(),
      makeScan(),
      [{ order: 1, text: '分镜' }] as unknown as PlotBeat[]
    );

    expect(fixLoopMock).toHaveBeenCalledTimes(2);
    const escalationOpts = fixLoopMock.mock.calls[1][6] as { maxRounds: number };
    expect(escalationOpts.maxRounds).toBe(0); // 跳过补丁轮，直通升级档
    expect(out.prose).toBe(PROSE_IN); // 60 分重写稿被回退
    expect(out.auditLog.verificationScore).toBe(70);
    expect(out.auditLog.revisionRollback).toEqual({
      fromScore: 60,
      toScore: 70,
      reason: 'best-snapshot',
    });
    expect(out.auditLog.beatRewriteApplied).toBe(true);
    expect(out.auditLog.fixRounds).toBe(2); // 1 补丁 + 1 重写（全程尝试记录）
  });

  it('round 1 无修复动作（history 空）→ 不落快照、不推进', async () => {
    fixLoopMock.mockResolvedValue({
      prose: PROSE_IN,
      auditLog: makeAudit(),
      ruleScan: makeScan(),
      fixRounds: 0,
      resolved: false,
      history: [],
    });
    const { ctx } = makeCtx({ maxReviseRounds: 2 });
    const out = await runReviserAgent(ctx, PROSE_IN, makeAudit(), makeScan());

    expect(fixLoopMock).toHaveBeenCalledTimes(1);
    expect(out.prose).toBe(PROSE_IN);
    expect(out.reviseRounds).toBe(0);
    expect('revisionRollback' in out.auditLog).toBe(false);
  });

  it('auditUnreliable → 冻结自动修稿：零 LLM 调用，原文原结论原样返回', async () => {
    const auditIn = makeAudit({ auditUnreliable: true });
    const { ctx, messages } = makeCtx({ maxReviseRounds: 2 });
    const out = await runReviserAgent(ctx, PROSE_IN, auditIn, makeScan());

    expect(fixLoopMock).not.toHaveBeenCalled();
    expect(hardReviewMock).not.toHaveBeenCalled();
    expect(out.prose).toBe(PROSE_IN);
    expect(out.auditLog).toBe(auditIn);
    expect(out.reviseRounds).toBe(0);
    expect(messages.some((m) => m.includes('审稿结论不可信，已冻结自动修稿'))).toBe(true);
  });

  it('机检与硬伤全过 → 无需修复：原样返回、零调用、无回退标记（普通路径零变化）', async () => {
    const auditIn = makeAudit({
      verificationScore: 88,
      hardReview: { passed: true, score: 90, summary: '通过', issues: [], source: 'llm' },
      hardBlocked: false,
    });
    const scanIn = makeScan({ passed: true, score: 92, blacklistHits: 0 });
    const { ctx } = makeCtx({ maxReviseRounds: 2 });
    const out = await runReviserAgent(ctx, PROSE_IN, auditIn, scanIn);

    expect(fixLoopMock).not.toHaveBeenCalled();
    expect(hardReviewMock).not.toHaveBeenCalled();
    expect(out.prose).toBe(PROSE_IN);
    expect(out.auditLog).toBe(auditIn);
    expect(out.reviseRounds).toBe(0);
    expect('revisionRollback' in out.auditLog).toBe(false);
  });
});

// ─── 能力②：审稿不可信判定（runAuditorAgent） ───

describe('审稿结论不可信判定（auditorAgent）', () => {
  beforeEach(() => {
    step3Mock.mockReset();
    hardReviewMock.mockReset();
  });

  function makeAuditorCtx() {
    const messages: string[] = [];
    const input = {
      project: { id: 'p-test', memory: null },
      chapter: { number: 1, intent: null, involvedCharacterIds: [] },
      characters: [],
      settings: [],
      styleConfig: {},
      previousContext: '',
      contextPack: { text: '', preview: '', isFirstChapter: true },
      storyMemoryBlock: '',
      chapterIntentBlock: '',
      genrePackBlock: '',
      previousProse: '',
      targetWordCount: null,
      writeMode: 'until_green',
    } as unknown as ChapterPipelineInput;
    return {
      ctx: { input, hooks: {}, report: (_: string, msg: string) => messages.push(msg) } as AgentContext,
      messages,
    };
  }

  it('背离 >25：硬伤审零问题但综合分 90 与机检分 60 背离 30 → 标记 auditUnreliable', async () => {
    step3Mock.mockResolvedValue({
      polishedProse: PROSE_IN,
      auditLog: makeAudit({
        verificationScore: 90,
        hardReview: { passed: true, score: 92, summary: '零问题', issues: [], source: 'llm' },
        hardBlocked: false,
      }),
      ruleScan: makeScan({ passed: true, score: 60, blacklistHits: 0 }),
    });
    const { ctx, messages } = makeAuditorCtx();
    const out = await runAuditorAgent(ctx, PROSE_IN, []);

    expect(out.auditLog.auditUnreliable).toBe(true);
    expect(messages.some((m) => m.includes('审稿结论不可信'))).toBe(true);
  });

  it('背离恰 25：综合分 85 与机检分 60 → 不标记（阈值 >25）', async () => {
    step3Mock.mockResolvedValue({
      polishedProse: PROSE_IN,
      auditLog: makeAudit({
        verificationScore: 85,
        hardReview: { passed: true, score: 90, summary: '零问题', issues: [], source: 'llm' },
        hardBlocked: false,
      }),
      ruleScan: makeScan({ passed: true, score: 60, blacklistHits: 0 }),
    });
    const { ctx } = makeAuditorCtx();
    const out = await runAuditorAgent(ctx, PROSE_IN, []);

    expect(out.auditLog.auditUnreliable).toBeUndefined();
  });

  it('正常审稿：零问题且分差 10 → 不标记（普通路径零变化）', async () => {
    step3Mock.mockResolvedValue({
      polishedProse: PROSE_IN,
      auditLog: makeAudit({
        verificationScore: 85,
        hardReview: { passed: true, score: 90, summary: '零问题', issues: [], source: 'llm' },
        hardBlocked: false,
      }),
      ruleScan: makeScan({ passed: true, score: 75, blacklistHits: 0 }),
    });
    const { ctx } = makeAuditorCtx();
    const out = await runAuditorAgent(ctx, PROSE_IN, []);

    expect(out.auditLog.auditUnreliable).toBeUndefined();
  });

  it('硬伤审整体 API 失败走 fallback 且无本地结论 → 标记 auditUnreliable', async () => {
    step3Mock.mockResolvedValue({
      polishedProse: PROSE_IN,
      auditLog: makeAudit({
        verificationScore: 62,
        hardReview: {
          passed: false,
          score: 35,
          summary: '硬伤审 API 失败，已阻断自动定稿',
          issues: [
            {
              type: '其他硬伤',
              severity: 'error',
              description: '硬伤审调用失败：超时。为防止幻觉漏检，本章不自动绿通。',
              suggestion: '检查 LLM/网络配置后重跑本章闭环，或人工通读确认后手动锁定。',
            },
          ],
          source: 'fallback',
        },
      }),
      ruleScan: makeScan({ passed: true, score: 58, blacklistHits: 0 }),
    });
    const { ctx } = makeAuditorCtx();
    const out = await runAuditorAgent(ctx, PROSE_IN, []);

    expect(out.auditLog.auditUnreliable).toBe(true);
  });

  it('fallback + 本地断言抓到硬伤 → 有可信结论，不标记（reviser 可正常修）', async () => {
    step3Mock.mockResolvedValue({
      polishedProse: PROSE_IN,
      auditLog: makeAudit({
        verificationScore: 62,
        hardReview: {
          passed: false,
          score: 35,
          summary: '硬伤审 API 失败，已阻断自动定稿',
          issues: [
            {
              type: '其他硬伤',
              severity: 'error',
              description: '硬伤审调用失败：超时。为防止幻觉漏检，本章不自动绿通。',
              suggestion: '检查配置后重跑。',
            },
            {
              type: '状态冲突',
              severity: 'error',
              description: '[本地断言] 第3章林越已阵亡，却又出场',
              suggestion: '改写至自洽',
            },
          ],
          source: 'fallback',
        },
      }),
      ruleScan: makeScan({ passed: true, score: 58, blacklistHits: 0 }),
    });
    const { ctx } = makeAuditorCtx();
    const out = await runAuditorAgent(ctx, PROSE_IN, []);

    expect(out.auditLog.auditUnreliable).toBeUndefined();
  });
});
