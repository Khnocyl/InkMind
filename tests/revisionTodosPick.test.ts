import { describe, it, expect } from 'vitest';
import { pickFirstOpenRevision } from '../src/services/revisionTodos';
import type { Chapter, ChapterRevisionTodo } from '../src/types/novel';

const todo = (id: string, text: string, status: 'open' | 'done' = 'open'): ChapterRevisionTodo =>
  ({ id, text, status, severity: 'warn', createdAt: '2026-09-14T00:00:00.000Z' }) as ChapterRevisionTodo;

const ch = (id: string, todos: ChapterRevisionTodo[]): Chapter =>
  ({
    id,
    number: 1,
    title: 'x',
    summary: '',
    wordCount: 1,
    status: '草稿',
    content: '正文',
    beats: [],
    involvedCharacterIds: [],
    involvedSettingIds: [],
    lastModified: '',
    contentUpdatedAt: '',
    revisionTodos: todos,
  }) as Chapter;

describe('pickFirstOpenRevision · 跳过集（一键修全部防死循环）', () => {
  it('默认选第一条 open', () => {
    const chapters = [ch('c1', [todo('t1', 'a'), todo('t2', 'b')])];
    expect(pickFirstOpenRevision(chapters)?.todo.id).toBe('t1');
  });

  it('跳过集里的条目不再被选；全部跳完返回 null（这是防死循环的关键）', () => {
    const chapters = [ch('c1', [todo('t1', '[硬伤] a'), todo('t2', 'b')])];
    // t1 修失败 → 进跳过集 → 下轮必须选 t2，而不是又回到 t1
    expect(pickFirstOpenRevision(chapters, new Set(['t1']))?.todo.id).toBe('t2');
    expect(pickFirstOpenRevision(chapters, new Set(['t1', 't2']))).toBeNull();
  });

  it('跨章/硬伤类优先也尊重跳过集', () => {
    const chapters = [
      ch('c1', [todo('t9', '普通')]),
      ch('c2', [todo('audit-1', '[跨章·伏笔] x')]),
    ];
    expect(pickFirstOpenRevision(chapters)?.todo.id).toBe('audit-1');
    expect(pickFirstOpenRevision(chapters, new Set(['audit-1']))?.todo.id).toBe('t9');
  });
});
