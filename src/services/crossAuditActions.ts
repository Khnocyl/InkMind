/**
 * 跨章抽检后动作：把问题写入章节待修清单，必要时标「待人工确认」并解锁锁定章。
 */

import type {
  BookProject,
  Chapter,
  ChapterRevisionTodo,
  CrossChapterAuditReport,
  CrossChapterIssue,
} from '../types/novel';
import { isChapterLocked } from './chapterLock';

/** 跨章 issue → 章内待修 id（与落盘一致，便于跳转高亮） */
export function makeAuditTodoId(issue: CrossChapterIssue, chapterNumber: number): string {
  return `audit-${chapterNumber}-${issue.id}`.slice(0, 80);
}

function issueToTodoText(issue: CrossChapterIssue): string {
  const ch =
    issue.chapterNumbers?.length
      ? `（第${issue.chapterNumbers.join('/')}章）`
      : '';
  const sug = issue.suggestion ? ` → ${issue.suggestion}` : '';
  return `[跨章·${issue.kind}] ${issue.title}${ch}：${issue.detail.slice(0, 120)}${sug}`.slice(
    0,
    280
  );
}

export interface ApplyCrossAuditResult {
  chapters: Chapter[];
  todosAdded: number;
  chaptersTouched: number;
  /** 因 error 自动解锁的章数 */
  chaptersUnlocked: number;
}

/**
 * 将抽检 issues 落到「最近相关章」的 revisionTodos。
 * - error/warn 写入 open 待修
 * - markPendingReview：相关章有正文 → 待人工确认
 * - unlockOnError：涉及章若已定稿锁定且含 error → 自动解锁便于改稿
 */
export function applyCrossAuditToChapters(
  project: BookProject,
  report: CrossChapterAuditReport,
  options?: {
    /** 默认 true：有 error 时把涉及章标待人工 */
    markPendingReview?: boolean;
    /** 默认 true：有 error 时自动解锁锁定章 */
    unlockOnError?: boolean;
    /** 只写 error；默认 false 含 warn */
    errorsOnly?: boolean;
  }
): ApplyCrossAuditResult {
  const markPending = options?.markPendingReview !== false;
  const unlockOnError = options?.unlockOnError !== false;
  const errorsOnly = options?.errorsOnly === true;
  const issues = report.issues.filter((i) =>
    errorsOnly ? i.severity === 'error' : i.severity === 'error' || i.severity === 'warn'
  );
  if (!issues.length) {
    return {
      chapters: project.chapters,
      todosAdded: 0,
      chaptersTouched: 0,
      chaptersUnlocked: 0,
    };
  }

  // 问题 → 目标章号集合
  const byChapter = new Map<number, CrossChapterIssue[]>();
  const fallbackCh = report.rangeTo;
  for (const iss of issues) {
    const nums =
      iss.chapterNumbers && iss.chapterNumbers.length
        ? iss.chapterNumbers
        : [fallbackCh];
    for (const n of nums) {
      const list = byChapter.get(n) || [];
      list.push(iss);
      byChapter.set(n, list);
    }
  }

  let todosAdded = 0;
  let chaptersTouched = 0;
  let chaptersUnlocked = 0;
  const now = new Date().toISOString();
  const timeLabel = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const chapters = project.chapters.map((ch) => {
    const list = byChapter.get(ch.number);
    if (!list?.length) return ch;

    const existing = [...(ch.revisionTodos || [])];
    const existingKeys = new Set(
      existing.map((t) => t.text.replace(/\s+/g, '').slice(0, 40))
    );
    let added = 0;
    const nextTodos: ChapterRevisionTodo[] = [...existing];

    for (const iss of list) {
      const text = issueToTodoText(iss);
      const key = text.replace(/\s+/g, '').slice(0, 40);
      if (existingKeys.has(key)) continue;
      // 同 id 不重复
      if (nextTodos.some((t) => t.id === makeAuditTodoId(iss, ch.number))) continue;
      nextTodos.unshift({
        id: makeAuditTodoId(iss, ch.number),
        text,
        status: 'open',
        createdAt: now,
      });
      existingKeys.add(key);
      added += 1;
    }

    const hasError = list.some((i) => i.severity === 'error');
    const wasLocked = isChapterLocked(ch);
    let status = ch.status;
    let locked = ch.locked;
    let lockedAt = ch.lockedAt;
    let unlockedThis = false;

    // 有 error 且章已锁定 → 自动解锁，标待人工，便于改稿闭环
    if (hasError && unlockOnError && wasLocked && (ch.wordCount || 0) > 50) {
      locked = false;
      lockedAt = undefined;
      status = '待人工确认';
      unlockedThis = true;
    } else if (
      markPending &&
      hasError &&
      !wasLocked &&
      (ch.wordCount || 0) > 50
    ) {
      if (
        status === '校验通过' ||
        status === '精修定稿' ||
        status === '校验精修定稿' ||
        status === '正文草稿' ||
        status === '机检未通过'
      ) {
        status = '待人工确认';
      }
    }

    if (added === 0 && !unlockedThis && status === ch.status) return ch;

    todosAdded += added;
    chaptersTouched += 1;
    if (unlockedThis) chaptersUnlocked += 1;

    return {
      ...ch,
      revisionTodos: nextTodos.slice(0, 40),
      status,
      locked,
      lockedAt,
      lastModified: timeLabel,
    };
  });

  return { chapters, todosAdded, chaptersTouched, chaptersUnlocked };
}

export function crossAuditFailed(
  report: CrossChapterAuditReport,
  minScore: number
): boolean {
  const errors = report.issues.filter((i) => i.severity === 'error').length;
  return report.score < minScore || errors > 0;
}

/**
 * 从待修文案里抽出可能出现在正文中的关键词（用于跳转后尝试定位选区）。
 * 优先取「」『』“” 引号内容，其次取较长中文片段。
 */
export function extractTodoSearchHints(todoText: string): string[] {
  const hints: string[] = [];
  const quoted =
    todoText.match(/[「『“"]([^」』”"]{2,24})[」』”"]/g) || [];
  for (const q of quoted) {
    const inner = q.slice(1, -1).trim();
    if (inner.length >= 2) hints.push(inner);
  }
  // 冒号后 detail 片段
  const afterColon = todoText.split(/[：:]/).slice(1).join('：');
  if (afterColon) {
    const chunks = afterColon
      .replace(/→.*$/, '')
      .split(/[，。；、·\s/（）()]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && s.length <= 12);
    for (const c of chunks.slice(0, 6)) {
      if (!hints.includes(c)) hints.push(c);
    }
  }
  // 标题侧：方括号外前段
  const titleMatch = todoText.match(/\]\s*([^：（:]+)/);
  if (titleMatch?.[1]) {
    const t = titleMatch[1].replace(/（第[\d/]+章）/, '').trim();
    if (t.length >= 2 && t.length <= 16 && !hints.includes(t)) {
      hints.unshift(t);
    }
  }
  return hints.slice(0, 8);
}

/** 在正文中找第一个命中的 hint，返回 [start, end) */
export function findHintRangeInContent(
  content: string,
  hints: string[]
): { start: number; end: number } | null {
  if (!content) return null;
  for (const h of hints) {
    if (!h || h.length < 2) continue;
    const idx = content.indexOf(h);
    if (idx >= 0) {
      return { start: idx, end: idx + h.length };
    }
  }
  return null;
}
