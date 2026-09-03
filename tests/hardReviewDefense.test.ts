import { describe, it, expect } from 'vitest';
import { finalizeHardReviewScoring } from '../src/services/hardReviewVerify';
import { pruneStaleAutoTodos } from '../src/services/revisionTodos';
import type { HardReviewIssue, ChapterRevisionTodo } from '../src/types/novel';

describe('finalizeHardReviewScoring · 确定性锚点收口', () => {
  const warnIssue: HardReviewIssue = {
    type: '战力越界',
    severity: 'warn',
    description: 'd',
    suggestion: 's',
  };
  const errIssue: HardReviewIssue = {
    type: '状态冲突',
    severity: 'error',
    description: 'd',
    suggestion: 's',
    verify: { status: 'verified', reasons: [] },
  };

  it('0 项 error 且发生过指控降级 → 分数托回 80+，passed 复位（误报不卡章）', () => {
    const out = finalizeHardReviewScoring(
      {
        passed: false,
        score: 42,
        summary: '',
        issues: [warnIssue],
      },
      { passRescue: true }
    );
    expect(out.score).toBeGreaterThanOrEqual(80);
    expect(out.passed).toBe(true);
  });

  it('0 项 error 但从未有指控（LLM 显式判不过）→ 不代为翻转', () => {
    const out = finalizeHardReviewScoring({
      passed: false,
      score: 60,
      summary: '',
      issues: [warnIssue],
    });
    expect(out.score).toBe(60);
    expect(out.passed).toBe(false);
  });

  it('1 项 error → 收敛到 [55,70]（LLM 按多项 error 打的低分被纠正）', () => {
    const out = finalizeHardReviewScoring({
      passed: false,
      score: 42,
      summary: '',
      issues: [errIssue],
    });
    expect(out.score).toBe(55);
    expect(out.passed).toBe(false);
    const high = finalizeHardReviewScoring({
      passed: false,
      score: 90,
      summary: '',
      issues: [errIssue],
    });
    expect(high.score).toBe(70);
  });

  it('2 项及以上 error → ≤54 且不通过', () => {
    const out = finalizeHardReviewScoring({
      passed: false,
      score: 42,
      summary: '',
      issues: [errIssue, { ...errIssue }],
    });
    expect(out.score).toBeLessThanOrEqual(54);
    expect(out.passed).toBe(false);
  });
});

describe('pruneStaleAutoTodos · 清理旧运行自动待修', () => {
  const mk = (id: string, status: 'open' | 'done', autoRunId?: string): ChapterRevisionTodo => ({
    id,
    text: `t-${id}`,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    autoRunId,
  });
  const RUN = 'audit-current';

  it('删除旧运行 open 自动条目；保留当前运行、手工、done 条目', () => {
    const todos = [
      mk('a', 'open', 'audit-old'), // 旧运行 → 删
      mk('b', 'open', RUN), // 当前运行 → 留
      mk('c', 'open'), // 手工/无标识 → 留
      mk('d', 'done', 'audit-old'), // 已完成历史 → 留
    ];
    const out = pruneStaleAutoTodos(todos, RUN);
    expect(out.pruned).toBe(1);
    expect(out.todos.map((t) => t.id)).toEqual(['b', 'c', 'd']);
  });

  it('无旧运行时不删任何东西', () => {
    const todos = [mk('a', 'open'), mk('b', 'open', RUN)];
    const out = pruneStaleAutoTodos(todos, RUN);
    expect(out.pruned).toBe(0);
    expect(out.todos.length).toBe(2);
  });
});
