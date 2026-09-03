import type { BookProject, Chapter } from '../types/novel';
import { isChapterLocked } from './chapterLock';

/**
 * 全书缺口扫描（纯函数，可测）。
 *
 * 背景：用户的书已完成大纲拆章，但部分章节因早期 JSON 解析 bug
 * 缺少写前意图（有的被 fallback 兜底填过、有的根本没有 intent）、
 * 分镜或正文。解析修复后需要一次性扫出全书缺口并批量补齐，
 * 已有有效产出的章节一律跳过（含已锁章、已确认意图的章）。
 */

export type GapKind =
  | 'intent_missing'
  | 'intent_fallback'
  | 'beats_missing'
  | 'prose_missing';

/** 单章缺口明细 */
export interface ChapterGap {
  chapterId: string;
  chapterNumber: number;
  title: string;
  /** 缺口类型（一章可并存多类） */
  kinds: GapKind[];
}

export interface GapReport {
  scannedAt: string;
  totalChapters: number;
  /** 已锁定章：视为用户认可现状，永不列为缺口 */
  lockedChapters: number;
  /** 有缺口的未锁章数 */
  gapChapters: number;
  /** 无缺口的未锁章数 */
  cleanChapters: number;
  /** 逐章缺口明细（仅含缺口章，按章号升序） */
  chapterGaps: ChapterGap[];
  /** 各类缺口总次数 */
  counts: Record<GapKind, number>;
  /** 预计补跑动作映射 */
  actions: Record<GapKind, string>;
}

export const GAP_ACTIONS: Record<GapKind, string> = {
  intent_missing: '生成写前意图（走 generateChapterIntent，LLM 失败启发式兜底）',
  intent_fallback: '重新生成写前意图（替换 fallback 兜底货，保留分镜/正文不动）',
  beats_missing: '跑单章管线补分镜 + 正文',
  prose_missing: '跑单章管线补正文（分镜一并重排）',
};

function stripWhitespaceLength(s: string | undefined): number {
  return (s || '').replace(/\s+/g, '').length;
}

/**
 * 单章缺口判定。
 * - intent_missing：无 intent，或 mustDo 为空且 endingHook 为空；
 * - intent_fallback：intent 存在但 source==='fallback'（质量打折需重生成）；
 *   已确认（confirmed===true）的 fallback 视为用户认可现状，不列为缺口。
 *   注：未用 intentCompleteness 做判据——它对「未确认」也扣分，
 *   而 llm/manual 草稿未确认是正常态，会把正常草稿误报成兜底货。
 * - beats_missing：无分镜数组或空；
 * - prose_missing：content 去空白后 < 200 字（锁章整体豁免，此处仅未锁章判定）。
 * - 已锁章（locked=true 或定稿状态推断）永不列为缺口。
 */
export function scanChapterGaps(ch: Chapter): {
  kinds: GapKind[];
  locked: boolean;
} {
  if (isChapterLocked(ch)) return { kinds: [], locked: true };

  const kinds: GapKind[] = [];
  const intent = ch.intent;
  // 旧数据可能未过 normalize：字段缺省按空处理
  const mustDo = intent?.mustDo || [];
  const endingHook = intent?.endingHook || '';
  const intentEmpty =
    !intent || (mustDo.length === 0 && stripWhitespaceLength(endingHook) === 0);
  if (intentEmpty) kinds.push('intent_missing');
  if (intent && intent.source === 'fallback' && intent.confirmed !== true) {
    kinds.push('intent_fallback');
  }
  if (!(ch.beats || []).length) kinds.push('beats_missing');
  if (stripWhitespaceLength(ch.content) < 200) kinds.push('prose_missing');

  return { kinds, locked: false };
}

export function scanProjectGaps(project: BookProject): GapReport {
  const chapters = project.chapters || [];
  const counts: Record<GapKind, number> = {
    intent_missing: 0,
    intent_fallback: 0,
    beats_missing: 0,
    prose_missing: 0,
  };

  let lockedChapters = 0;
  const chapterGaps: ChapterGap[] = [];

  for (const ch of [...chapters].sort((a, b) => a.number - b.number)) {
    const { kinds, locked } = scanChapterGaps(ch);
    if (locked) {
      lockedChapters += 1;
      continue;
    }
    if (kinds.length === 0) continue;
    chapterGaps.push({
      chapterId: ch.id,
      chapterNumber: ch.number,
      title: ch.title,
      kinds,
    });
    for (const k of kinds) counts[k] += 1;
  }

  const gapChapters = chapterGaps.length;
  return {
    scannedAt: new Date().toISOString(),
    totalChapters: chapters.length,
    lockedChapters,
    gapChapters,
    cleanChapters: chapters.length - lockedChapters - gapChapters,
    chapterGaps,
    counts,
    actions: GAP_ACTIONS,
  };
}

/** 缺口章对应的单章补跑动作（供 UI 提示 / 测试断言） */
export function kindsToActionLabel(kinds: GapKind[]): string {
  return kinds.map((k) => GAP_ACTIONS[k]).join('；');
}
