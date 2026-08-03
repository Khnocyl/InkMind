import type { Chapter, ChapterRevisionTodo } from '../types/novel';

export interface RevisionTodoEntry {
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  todo: ChapterRevisionTodo;
}

export interface RevisionTodosOverview {
  open: RevisionTodoEntry[];
  done: RevisionTodoEntry[];
  openCount: number;
  doneCount: number;
  chaptersWithOpen: number;
}

/** 全书待修条目扁平列表（open 在前，按章号） */
export function collectRevisionTodos(chapters: Chapter[]): RevisionTodosOverview {
  const open: RevisionTodoEntry[] = [];
  const done: RevisionTodoEntry[] = [];
  const openChapterIds = new Set<string>();

  const sorted = [...chapters].sort((a, b) => a.number - b.number);
  for (const ch of sorted) {
    for (const todo of ch.revisionTodos || []) {
      const entry: RevisionTodoEntry = {
        chapterId: ch.id,
        chapterNumber: ch.number,
        chapterTitle: ch.title || '',
        todo,
      };
      if (todo.status === 'done') {
        done.push(entry);
      } else {
        open.push(entry);
        openChapterIds.add(ch.id);
      }
    }
  }

  return {
    open,
    done,
    openCount: open.length,
    doneCount: done.length,
    chaptersWithOpen: openChapterIds.size,
  };
}

export function toggleRevisionTodoOnChapter(
  chapter: Chapter,
  todoId: string
): Chapter {
  const revisionTodos = (chapter.revisionTodos || []).map((t) => {
    if (t.id !== todoId) return t;
    if (t.status === 'open') {
      return { ...t, status: 'done' as const, doneAt: new Date().toISOString() };
    }
    return { ...t, status: 'open' as const, doneAt: undefined };
  });
  return {
    ...chapter,
    revisionTodos,
    lastModified: new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    }),
  };
}

function timeLabel(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * 优先挑跨章 audit 待修，否则第一条 open。
 * 用于「修第一处」捷径。
 */
export function pickFirstOpenRevision(
  chapters: Chapter[]
): RevisionTodoEntry | null {
  const { open } = collectRevisionTodos(chapters);
  if (!open.length) return null;
  const audit = open.find(
    (e) =>
      e.todo.id.startsWith('audit-') ||
      e.todo.id.startsWith('hard-') ||
      e.todo.id.startsWith('aitaste-') ||
      e.todo.text.includes('[跨章') ||
      e.todo.text.includes('跨章·') ||
      e.todo.text.includes('[账本对账]') ||
      e.todo.text.includes('[本地断言]') ||
      e.todo.text.includes('[硬伤]') ||
      e.todo.text.includes('[去AI')
  );
  return audit || open[0];
}

/** 清空全书已完成待修（保留 open） */
export function clearDoneRevisionTodos(
  chapters: Chapter[]
): { chapters: Chapter[]; removed: number } {
  let removed = 0;
  const label = timeLabel();
  const next = chapters.map((ch) => {
    const todos = ch.revisionTodos || [];
    if (!todos.length) return ch;
    const keep = todos.filter((t) => t.status !== 'done');
    const drop = todos.length - keep.length;
    if (drop === 0) return ch;
    removed += drop;
    return {
      ...ch,
      revisionTodos: keep,
      lastModified: label,
    };
  });
  return { chapters: next, removed };
}

/** 将某章全部 open 标为 done */
export function markAllOpenTodosDoneOnChapter(chapter: Chapter): Chapter {
  const now = new Date().toISOString();
  const todos = chapter.revisionTodos || [];
  if (!todos.some((t) => t.status === 'open')) return chapter;
  return {
    ...chapter,
    revisionTodos: todos.map((t) =>
      t.status === 'open' ? { ...t, status: 'done' as const, doneAt: now } : t
    ),
    lastModified: timeLabel(),
  };
}

/** 全书：把所有 open 标 done（慎用） */
export function markAllOpenTodosDone(
  chapters: Chapter[]
): { chapters: Chapter[]; marked: number } {
  let marked = 0;
  const now = new Date().toISOString();
  const label = timeLabel();
  const next = chapters.map((ch) => {
    const todos = ch.revisionTodos || [];
    if (!todos.some((t) => t.status === 'open')) return ch;
    let local = 0;
    const revisionTodos = todos.map((t) => {
      if (t.status !== 'open') return t;
      local += 1;
      return { ...t, status: 'done' as const, doneAt: now };
    });
    marked += local;
    return { ...ch, revisionTodos, lastModified: label };
  });
  return { chapters: next, marked };
}
