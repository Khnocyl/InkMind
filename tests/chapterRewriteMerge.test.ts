import { describe, expect, it } from 'vitest';
import {
  applyPipelineResult,
  mergeRevisionTodoStatus,
  mergeRewriteIntoLatest,
} from '../src/services/chapterRewriteMerge';
import type { Chapter } from '../src/types/novel';

function ch(overrides: Partial<Chapter> = {}): Chapter {
  return {
    id: 'c1',
    number: 1,
    title: '第一章',
    summary: '梗概',
    content: '原始正文',
    wordCount: 4,
    status: '正文草稿',
    ...overrides,
  } as unknown as Chapter;
}

describe('mergeRewriteIntoLatest · 正文指纹闸门', () => {
  it('正文被用户改动 → 放弃写入（绝不覆盖用户改动）', () => {
    const startedFrom = ch({ content: '原始正文' });
    const latest = ch({ content: '用户手动改过的正文' });
    const rewritten = ch({ content: 'AI 改写后的正文' });

    const r = mergeRewriteIntoLatest(latest, rewritten, startedFrom);
    expect(r.chapter).toBeNull();
    expect(r.skippedReason).toBe('prose-changed');
  });

  it('正文未变 → 采用 AI 产出的正文与字数', () => {
    const startedFrom = ch({ content: '原始正文' });
    const latest = ch({ content: '原始正文' });
    const rewritten = ch({
      content: 'AI 改写后的正文',
      wordCount: 8,
      contentUpdatedAt: '2026-09-11T04:00:00.000Z',
      lastModified: '12:00',
    });

    const r = mergeRewriteIntoLatest(latest, rewritten, startedFrom);
    expect(r.chapter?.content).toBe('AI 改写后的正文');
    expect(r.chapter?.wordCount).toBe(8);
    expect(r.chapter?.contentUpdatedAt).toBe('2026-09-11T04:00:00.000Z');
  });
});

describe('mergeRewriteIntoLatest · 保留用户在任务期间的编辑', () => {
  it('用户改了标题/梗概 → 不被整章替换回滚', () => {
    const startedFrom = ch({ title: '旧标题', summary: '旧梗概' });
    const latest = ch({ title: '用户新标题', summary: '用户新梗概' });
    const rewritten = ch({ content: 'AI 新正文' });

    const r = mergeRewriteIntoLatest(latest, rewritten, startedFrom);
    expect(r.chapter?.title).toBe('用户新标题');
    expect(r.chapter?.summary).toBe('用户新梗概');
    expect(r.chapter?.content).toBe('AI 新正文');
  });

  it('动作没动 memoryAudit / revisionTodos（引用相同）→ 保留 latest 的', () => {
    const audit = { verificationScore: 90 } as Chapter['memoryAudit'];
    const todos = [{ id: 't1', status: 'done' }] as Chapter['revisionTodos'];
    const startedFrom = ch({ memoryAudit: audit, revisionTodos: todos });
    // latest 的待修被用户勾选过，是另一个数组
    const latestTodos = [{ id: 't1', status: 'open' }] as Chapter['revisionTodos'];
    const latest = ch({ memoryAudit: audit, revisionTodos: latestTodos });
    // 动作只是 spread 了快照，两个字段引用未变
    const rewritten = ch({ content: 'AI 新正文', memoryAudit: audit, revisionTodos: todos });

    const r = mergeRewriteIntoLatest(latest, rewritten, startedFrom);
    expect(r.chapter?.revisionTodos).toBe(latestTodos);
    expect(r.chapter?.memoryAudit).toBe(audit);
  });

  it('动作动了 revisionTodos（新引用）→ 回写', () => {
    const startedFrom = ch({ revisionTodos: [{ id: 't1', status: 'open' }] as never });
    const latest = ch({ revisionTodos: [{ id: 't1', status: 'open' }] as never });
    const produced = [{ id: 't1', status: 'open' }, { id: 't2', status: 'open' }] as never;

    const r = mergeRewriteIntoLatest(latest, ch({ revisionTodos: produced }), startedFrom);
    expect(r.chapter?.revisionTodos).toBe(produced);
  });
});

describe('mergeRewriteIntoLatest · 纯扫描类动作', () => {
  it('只扫不写：不动正文时不回写陈旧的 contentUpdatedAt', () => {
    const startedFrom = ch({ content: '正文', contentUpdatedAt: '2026-09-11T01:00:00.000Z' });
    const latest = ch({ content: '正文', contentUpdatedAt: '2026-09-11T03:00:00.000Z' });
    const audit = { verificationScore: 88 } as Chapter['memoryAudit'];
    // 扫描类动作：content 原样 spread，只换了 memoryAudit
    const rewritten = ch({ content: '正文', memoryAudit: audit });

    const r = mergeRewriteIntoLatest(latest, rewritten, startedFrom);
    expect(r.chapter?.contentUpdatedAt).toBe('2026-09-11T03:00:00.000Z');
    expect(r.chapter?.memoryAudit).toBe(audit);
  });
});

describe('mergeRevisionTodoStatus', () => {
  it('latest 为空 → 直接用产出；produced 为空 → 保留 latest', () => {
    const produced = [{ id: 't1', status: 'open' }] as never;
    expect(mergeRevisionTodoStatus(undefined, produced)).toBe(produced);
    const latest = [{ id: 't2', status: 'done' }] as never;
    expect(mergeRevisionTodoStatus(latest, undefined)).toBe(latest);
  });

  it('保留用户在生成期间的勾选状态，并保留用户新增条目', () => {
    const latest = [
      { id: 't1', status: 'done' },
      { id: 't-user', status: 'open' },
    ] as never;
    const produced = [
      { id: 't1', status: 'open' }, // 管线仍认为未完成，但用户已勾
      { id: 't2', status: 'open' }, // 管线新加
    ] as never;

    const merged = mergeRevisionTodoStatus(latest, produced) as Array<{
      id: string;
      status: string;
    }>;
    expect(merged.find((t) => t.id === 't1')?.status).toBe('done'); // 用户勾选被保留
    expect(merged.find((t) => t.id === 't2')).toBeTruthy(); // 管线新条目在
    expect(merged.find((t) => t.id === 't-user')).toBeTruthy(); // 用户条目在
  });
});

describe('applyPipelineResult · 管线终稿合并', () => {
  it('只覆盖管线拥有的字段，保留用户在生成期间的标题/梗概编辑', () => {
    const latest = ch({ title: '用户改的标题', summary: '用户改的梗概' });
    const finalChapter = ch({
      title: '旧标题',
      summary: '旧梗概',
      content: '管线产出的正文',
      wordCount: 7,
      status: '已定稿',
      locked: true,
    });

    const merged = applyPipelineResult(latest, finalChapter);
    expect(merged.title).toBe('用户改的标题');
    expect(merged.summary).toBe('用户改的梗概');
    expect(merged.content).toBe('管线产出的正文');
    expect(merged.status).toBe('已定稿');
    expect(merged.locked).toBe(true);
  });

  it('待修：管线产出为准，但用户已勾的 done 不被回退', () => {
    const latest = ch({ revisionTodos: [{ id: 't1', status: 'done' }] as never });
    const finalChapter = ch({
      revisionTodos: [
        { id: 't1', status: 'open' },
        { id: 't2', status: 'open' },
      ] as never,
    });

    const merged = applyPipelineResult(latest, finalChapter) as unknown as {
      revisionTodos: Array<{ id: string; status: string }>;
    };
    expect(merged.revisionTodos.find((t) => t.id === 't1')?.status).toBe('done');
    expect(merged.revisionTodos.find((t) => t.id === 't2')).toBeTruthy();
  });
});
