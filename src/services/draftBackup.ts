/**
 * 流式草稿备份 — 写章过程中周期性把正文快照存到 IndexedDB meta store。
 *
 * 背景：onStreamProse 只更新内存 state（避免与终稿竞态），若浏览器崩溃/
 * 标签页关闭/断网中断，草稿只存在于内存，刷新即丢。
 * 本服务把最新正文去抖落盘到 meta store，页面重新打开时提示恢复。
 */
import { proseWords } from './proseWords';
import { DRAFT_META_PREFIX, initDB, STORE_META, loadProject } from './storage';
import { createSnapshot } from './snapshots';
import type { Chapter } from '../types/novel';

export interface DraftBackup {
  projectId: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  /** 备份的正文（流式中/中断时的最新内容） */
  content: string;
  wordCount: number;
  /** 备份时间 ISO */
  updatedAt: string;
}

const DRAFT_PREFIX = DRAFT_META_PREFIX;
/** 草稿默认保留 7 天，超期自动清理 */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function draftKey(projectId: string, chapterId: string): string {
  return `${DRAFT_PREFIX}${projectId}:${chapterId}`;
}

/**
 * 写/删一条 meta。
 * 以事务提交为准（而非 request.onsuccess）：commit 阶段失败（典型
 * QuotaExceededError）必须让调用方知道没写进去——否则草稿被当成已保存。
 */
async function putMeta(key: string, value: unknown): Promise<void> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('草稿写入失败'));
    tx.onabort = () => reject(tx.error || new Error('草稿写入事务中止'));
  });
}

async function deleteMeta(key: string): Promise<void> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('草稿删除失败'));
    tx.onabort = () => reject(tx.error || new Error('草稿删除事务中止'));
  });
}

async function getAllMeta(): Promise<{ key: string; value: unknown }[]> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readonly');
    const store = tx.objectStore(STORE_META);
    const req = store.getAll();
    req.onsuccess = () =>
      resolve((req.result || []) as { key: string; value: unknown }[]);
    req.onerror = () => reject(req.error);
  });
}

export interface SaveDraftInput {
  projectId: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  content: string;
}

/** 立即写入一条草稿备份（空正文不写，避免覆盖有效备份） */
export async function saveDraftBackup(input: SaveDraftInput): Promise<void> {
  if (!input.content.trim()) return;
  const backup: DraftBackup = {
    projectId: input.projectId,
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    chapterTitle: input.chapterTitle,
    content: input.content,
    wordCount: proseWords(input.content),
    updatedAt: new Date().toISOString(),
  };
  await putMeta(draftKey(input.projectId, input.chapterId), backup);
}

/** 清除某章草稿备份（终稿落盘后调用） */
export async function clearDraftBackup(
  projectId: string,
  chapterId: string
): Promise<void> {
  await deleteMeta(draftKey(projectId, chapterId));
}

/** 列出某书（或不限书）的草稿备份，按更新时间倒序 */
export async function listDraftBackups(projectId?: string): Promise<DraftBackup[]> {
  const all = await getAllMeta();
  const drafts = all
    .filter((r) => r.key.startsWith(DRAFT_PREFIX))
    .map((r) => r.value as DraftBackup)
    .filter((d) => d && typeof d.content === 'string' && typeof d.projectId === 'string');
  const filtered = projectId ? drafts.filter((d) => d.projectId === projectId) : drafts;
  return filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * 清理超期草稿，返回清理条数。
 *
 * ⚠️ 不能按时长**无条件**删：正常路径是「终稿落盘成功后 clearDraftBackup」，
 * 因此仍然存在的草稿往往意味着那次生成被中断/失败/直接关页 —— 它就是那段正文的
 * **唯一副本**。此前隔 7 天连提示带正文一起删掉，用户回来时正文已永久消失且无任何
 * 提示（与 snapshots.ts「钉死快照宁可多留」的取舍也自相矛盾）。
 *
 * 现在口径：
 * - 终稿已覆盖（正文字数 ≥ 草稿）→ 直接清，空间正常回收；
 * - 未被覆盖 → 先固化成快照（可在快照面板找回）再清草稿，绝不静默丢稿；
 * - 项目已不存在 → 草稿无所依附，直接清。
 */
export async function cleanupStaleDrafts(
  maxAgeMs: number = DRAFT_MAX_AGE_MS
): Promise<number> {
  const now = Date.now();
  const drafts = await listDraftBackups();
  let removed = 0;
  for (const d of drafts) {
    const age = now - new Date(d.updatedAt).getTime();
    if (!Number.isNaN(age) && age <= maxAgeMs) continue;
    try {
      await rescueUncoveredDraft(d);
      await clearDraftBackup(d.projectId, d.chapterId);
      removed++;
    } catch (err) {
      // 抢救/删除失败一律保留草稿——宁可多留，也不静默丢唯一副本
      console.warn('[draftBackup] 超期草稿清理失败，本次保留:', (err as Error)?.message || err);
    }
  }
  return removed;
}

/**
 * 超期草稿若尚未被终稿覆盖，先转成快照再允许删除。返回是否发生了抢救。
 *
 * 快照会把草稿正文并进对应章节后再固化，因此恢复出来的就是那份未落盘的稿子；
 * 用 `manual` 理由（非 pinned），受既有每书 30 条上限约束，存储有界。
 */
async function rescueUncoveredDraft(d: DraftBackup): Promise<boolean> {
  // 不要 .catch(() => null)：loadProject 只在**确实查无此书**时返回 null（正常情况
  // 返回项目对象），迁移失败 / 事务故障等一律抛错。把「读取失败」当成「项目已删」
  // 会直接清掉草稿，静默丢掉唯一副本 —— 与本函数「宁可多留」的取舍自相矛盾。
  // 抛错交由外层 catch 处理（保留草稿）。
  const project = await loadProject(d.projectId);
  if (!project) return false; // 确实查无此书：草稿无所依附

  const chapters = project.chapters || [];
  const chapter = chapters.find((c) => c.id === d.chapterId);
  const draftWords = d.wordCount || proseWords(d.content || '');
  const finalWords = chapter
    ? proseWords(chapter.content || '') || chapter.wordCount || 0
    : 0;
  if (chapter && finalWords >= draftWords) return false; // 已被终稿覆盖

  const rescuedChapter: Chapter = {
    ...(chapter || ({} as Chapter)),
    id: d.chapterId,
    number: chapter?.number ?? d.chapterNumber,
    title: chapter?.title ?? d.chapterTitle,
    content: d.content,
    wordCount: draftWords,
  };
  await createSnapshot(
    {
      ...project,
      chapters: chapter
        ? chapters.map((c) => (c.id === d.chapterId ? rescuedChapter : c))
        : [...chapters, rescuedChapter],
    },
    {
      reason: 'manual',
      label: `草稿抢救：第${d.chapterNumber ?? '?'}章 ${draftWords} 字（未落盘）`,
      chapterId: d.chapterId,
      chapterNumber: d.chapterNumber,
      chapterTitle: d.chapterTitle,
    }
  );
  return true;
}

// ── 流式去抖：onStreamProse 高频触发，合并为周期落盘 ──
const DEBOUNCE_MS = 800;
/**
 * 持续流式下的强制落盘间隔。
 *
 * 仅尾沿去抖是不够的：调用方是约每 120ms 触发一次的流式回调，chunk 间隔远小于
 * DEBOUNCE_MS → 计时器被无限重置，**草稿在正常流畅流式下从不落盘**，崩溃保护
 * 在最需要它的那段窗口里恰好失效（只有流暂停 ≥800ms 或结束时才会写一次）。
 * 超过该间隔就立即落一次盘，保证崩溃丢稿窗口不超过它。
 */
const MAX_WAIT_MS = 3000;
/** 写失败后的重试退避上限：配额满时避免高频空转 */
const MAX_RETRY_DELAY_MS = 30_000;
let pending: SaveDraftInput | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let saving = false;
/** 首个待落盘变更的时间戳（0 = 当前无待处理）；用于 MAX_WAIT_MS 判定 */
let firstPendingAt = 0;
/** 连续写失败次数：用于退避，成功后归零 */
let failureStreak = 0;

/** 失败重试延迟：800ms → 1.6s → 3.2s … 封顶 30s */
function retryDelayMs(): number {
  return Math.min(DEBOUNCE_MS * 2 ** Math.min(failureStreak, 5), MAX_RETRY_DELAY_MS);
}

/** 保留最新 job 并重新挂上定时器（失败/写入中两条路径共用） */
function reschedulePending(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushDraftBackup();
  }, retryDelayMs());
}

/** 去抖调度：合并突发，但保证最长不超过 MAX_WAIT_MS 落一次盘 */
export function scheduleDraftBackup(input: SaveDraftInput): void {
  const now = Date.now();
  pending = input;
  if (!firstPendingAt) firstPendingAt = now;
  if (now - firstPendingAt >= MAX_WAIT_MS) {
    // 距首个未落盘变更已超过上限：立即落盘（flush 会清掉定时器并重置计时起点）
    void flushDraftBackup();
    return;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flushDraftBackup();
  }, DEBOUNCE_MS);
}

/** 立即执行一次未落盘的调度（管线结束/页面隐藏时调用） */
export async function flushDraftBackup(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!pending) return;
  const job = pending;
  pending = null;
  firstPendingAt = 0;
  if (saving) {
    // 上一次写入还在进行：保留最新 job，并**重新挂上定时器**。
    // 此前只保留 pending 不再调度，若之后没有新的 schedule 调用，
    // 这份最后的流式草稿会一直躺在内存里直到 pagehide。
    pending = job;
    reschedulePending();
    return;
  }
  saving = true;
  try {
    await saveDraftBackup(job);
    failureStreak = 0;
  } catch (e) {
    console.warn('流式草稿备份失败:', e);
    // 失败保留并**重新挂上定时器**（带退避）：否则配额满/事务失败后，
    // 这段最后的流式正文会一直躺在内存里，直到下次 schedule 或 pagehide——
    // 期间崩溃/关页即永久丢失（本模块存在的意义所在）。
    if (!pending) pending = job;
    failureStreak += 1;
    reschedulePending();
  } finally {
    saving = false;
  }
}

// 页面隐藏/关闭时尽量冲刷一次（IndexedDB 写可能来不及完成，尽力而为）
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    void flushDraftBackup();
  });
}
