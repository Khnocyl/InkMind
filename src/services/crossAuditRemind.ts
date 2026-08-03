import type { BookProject, CrossChapterAuditReport, StyleConfig } from '../types/novel';

/** 默认每写满 N 章有正文后提醒跨章抽检 */
export const DEFAULT_CROSS_AUDIT_INTERVAL = 5;

export interface CrossAuditRemindStatus {
  /** 是否应展示提醒（已考虑 snooze） */
  due: boolean;
  /** 全书有正文的章数 */
  chaptersWithContent: number;
  /** 上次抽检覆盖到的最大章号；无报告时为 null */
  lastAuditRangeTo: number | null;
  /** 上次抽检之后新写完的章数（有正文且章号 > rangeTo；无报告时=有正文总数） */
  chaptersSinceAudit: number;
  /** 提醒间隔（章） */
  interval: number;
  /** 用户 snooze 到「有正文章数」达到该值前不再提醒；无则 null */
  dismissedUntilChapterCount: number | null;
  message: string;
}

function contentChapters(project: Pick<BookProject, 'chapters'>) {
  return (project.chapters || []).filter(
    (c) => (c.wordCount && c.wordCount > 0) || (c.content && c.content.replace(/\s+/g, '').length > 200)
  );
}

/** 从 styleConfig / config 读取间隔，夹在 2–20 */
export function resolveCrossAuditInterval(
  styleConfig?: StyleConfig | null,
  customParameters?: Record<string, unknown> | null
): number {
  const fromStyle = styleConfig?.crossAuditIntervalChapters;
  const fromCustom =
    customParameters && typeof customParameters.crossAuditIntervalChapters === 'number'
      ? customParameters.crossAuditIntervalChapters
      : undefined;
  const n = fromStyle ?? fromCustom ?? DEFAULT_CROSS_AUDIT_INTERVAL;
  return Math.max(2, Math.min(20, Math.floor(Number(n) || DEFAULT_CROSS_AUDIT_INTERVAL)));
}

export function getDismissedUntilChapterCount(
  customParameters?: Record<string, unknown> | null
): number | null {
  if (!customParameters) return null;
  const v = customParameters.crossAuditRemindDismissedUntilCount;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  return null;
}

/**
 * 评估是否应提醒跨章抽检。
 * 规则：自上次抽检覆盖范围之后，新写完（有正文）的章数 ≥ interval；
 * 从未抽检且有正文章数 ≥ interval 也提醒。
 * snooze：有正文章数 < dismissedUntil 时不提醒。
 */
export function evaluateCrossAuditRemind(
  project: Pick<BookProject, 'chapters' | 'lastCrossAudit' | 'styleConfig' | 'config'>,
  options?: { interval?: number }
): CrossAuditRemindStatus {
  const interval =
    options?.interval ??
    resolveCrossAuditInterval(project.styleConfig, project.config?.customParameters ?? null);
  const withContent = contentChapters(project);
  const chaptersWithContent = withContent.length;
  const report: CrossChapterAuditReport | undefined = project.lastCrossAudit;
  const lastAuditRangeTo = report ? report.rangeTo : null;

  let chaptersSinceAudit: number;
  if (lastAuditRangeTo == null) {
    chaptersSinceAudit = chaptersWithContent;
  } else {
    chaptersSinceAudit = withContent.filter((c) => c.number > lastAuditRangeTo).length;
  }

  const dismissedUntilChapterCount = getDismissedUntilChapterCount(
    project.config?.customParameters ?? null
  );
  const snoozed =
    dismissedUntilChapterCount != null && chaptersWithContent < dismissedUntilChapterCount;

  const rawDue = chaptersSinceAudit >= interval;
  const due = rawDue && !snoozed;

  let message: string;
  if (!rawDue) {
    const left = Math.max(0, interval - chaptersSinceAudit);
    message =
      lastAuditRangeTo == null
        ? `再写 ${left} 章后建议做首次跨章抽检（间隔 ${interval} 章）`
        : `距下次跨章抽检还差约 ${left} 章（已写 ${chaptersSinceAudit}/${interval}）`;
  } else if (snoozed) {
    message = `跨章抽检已延后（有正文 ${chaptersWithContent} 章，延后至 ${dismissedUntilChapterCount} 章）`;
  } else if (lastAuditRangeTo == null) {
    message = `已写 ${chaptersWithContent} 章正文，尚未做过跨章抽检。建议现在跑一次，检查伏笔与状态连贯。`;
  } else {
    message = `自上次抽检（覆盖至第 ${lastAuditRangeTo} 章）后又写了 ${chaptersSinceAudit} 章。建议再跑跨章抽检。`;
  }

  return {
    due,
    chaptersWithContent,
    lastAuditRangeTo,
    chaptersSinceAudit,
    interval,
    dismissedUntilChapterCount,
    message,
  };
}

/** snooze：再写 interval 章后再提醒 */
export function computeSnoozeUntilCount(
  chaptersWithContent: number,
  interval: number
): number {
  return chaptersWithContent + Math.max(1, interval);
}
