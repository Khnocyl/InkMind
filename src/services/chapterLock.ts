import type { Chapter, ChapterStatus } from '../types/novel';

/** 视为「定稿向」的状态（无 locked 字段的旧数据也按此保护） */
export const FINALIZED_STATUSES: ChapterStatus[] = [
  '校验通过',
  '精修定稿',
  '校验精修定稿',
];

export function isFinalizedStatus(status: Chapter['status'] | undefined): boolean {
  if (!status) return false;
  return FINALIZED_STATUSES.includes(status);
}

/**
 * 是否锁定（不可被流水线静默覆盖）。
 * - 显式 locked === true → 锁
 * - 显式 locked === false → 不锁（即使用户曾点解锁但 status 仍是校验通过）
 * - 未设置 locked → 兼容旧数据：定稿状态默认锁
 */
export function isChapterLocked(ch: Pick<Chapter, 'status' | 'locked'> | null | undefined): boolean {
  if (!ch) return false;
  if (ch.locked === true) return true;
  if (ch.locked === false) return false;
  return isFinalizedStatus(ch.status);
}

export function lockReason(ch: Pick<Chapter, 'status' | 'locked'>): string {
  if (ch.locked === true) {
    return isFinalizedStatus(ch.status)
      ? `已定稿锁定（${ch.status}）`
      : '已手动锁定';
  }
  if (ch.locked === false) {
    return '已解锁（可重写）';
  }
  if (isFinalizedStatus(ch.status)) {
    return `状态「${ch.status}」默认锁定（兼容旧数据）`;
  }
  return '未锁定';
}

/** 流水线是否允许覆盖该章 */
export function canPipelineOverwrite(
  ch: Chapter,
  options?: { force?: boolean }
): { ok: boolean; reason: string } {
  if (options?.force) {
    return { ok: true, reason: 'force=true，已授权覆盖锁定章' };
  }
  if (!isChapterLocked(ch)) {
    return { ok: true, reason: '未锁定' };
  }
  return {
    ok: false,
    reason: `第${ch.number}章已定稿锁定，禁止流水线覆盖。请先「解锁重写」或在确认对话框中授权强制重写。`,
  };
}

/** Auto-Pilot 是否应跳过该章 */
export function shouldAutoPilotSkip(ch: Chapter): boolean {
  return isChapterLocked(ch);
}

/** 机检通过后自动锁定 */
export function applyAutoLockOnPass(ch: Chapter, passed: boolean): Chapter {
  if (passed) {
    return {
      ...ch,
      locked: true,
      lockedAt: new Date().toISOString(),
      status: ch.status === '精修定稿' || ch.status === '校验精修定稿' ? ch.status : '校验通过',
    };
  }
  // 未通过：保持可改写
  return {
    ...ch,
    locked: false,
    lockedAt: undefined,
  };
}

/** 人工确认定稿 */
export function lockChapterAsFinal(ch: Chapter): Chapter {
  return {
    ...ch,
    locked: true,
    lockedAt: new Date().toISOString(),
    status: '校验通过',
    lastModified: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
}

/**
 * 解锁以便重写。
 * 不删除正文、不动定稿状态：显式 locked=false 已足以让流水线放行
 * （isChapterLocked 显式 false 优先），状态等真正重写出新稿后自然流转。
 * 此前会把 status 直接降为「正文草稿」——用户解锁后未重写，定稿状态被静默降级。
 * Auto-Pilot 选章侧由 isChapterEffectivelyDone 对 locked===false 放行配合。
 */
export function unlockChapterForRewrite(ch: Chapter): Chapter {
  return {
    ...ch,
    locked: false,
    lockedAt: undefined,
    lastModified: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
}

export function lockBadgeLabel(ch: Pick<Chapter, 'status' | 'locked'>): string | null {
  if (!isChapterLocked(ch)) return null;
  return '🔒 已锁定';
}
