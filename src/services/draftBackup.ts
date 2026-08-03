/**
 * 流式草稿备份 — 写章过程中周期性把正文快照存到 IndexedDB meta store。
 *
 * 背景：onStreamProse 只更新内存 state（避免与终稿竞态），若浏览器崩溃/
 * 标签页关闭/断网中断，草稿只存在于内存，刷新即丢。
 * 本服务把最新正文去抖落盘到 meta store，页面重新打开时提示恢复。
 */
import { initDB, STORE_META } from './storage';

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

const DRAFT_PREFIX = 'draft:';
/** 草稿默认保留 7 天，超期自动清理 */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function draftKey(projectId: string, chapterId: string): string {
  return `${DRAFT_PREFIX}${projectId}:${chapterId}`;
}

async function putMeta(key: string, value: unknown): Promise<void> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    const req = store.put({ key, value });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function deleteMeta(key: string): Promise<void> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
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
    wordCount: input.content.replace(/\s+/g, '').length,
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

/** 清理超期草稿，返回清理条数 */
export async function cleanupStaleDrafts(
  maxAgeMs: number = DRAFT_MAX_AGE_MS
): Promise<number> {
  const now = Date.now();
  const drafts = await listDraftBackups();
  let removed = 0;
  for (const d of drafts) {
    const age = now - new Date(d.updatedAt).getTime();
    if (Number.isNaN(age) || age > maxAgeMs) {
      try {
        await clearDraftBackup(d.projectId, d.chapterId);
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

// ── 流式去抖：onStreamProse 高频触发，合并为周期落盘 ──
const DEBOUNCE_MS = 800;
let pending: SaveDraftInput | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let saving = false;

/** 去抖调度：只保留最新一次，DEBOUNCE_MS 后写入 */
export function scheduleDraftBackup(input: SaveDraftInput): void {
  pending = input;
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
  if (saving) {
    // 上一次写入还在进行：保留最新 job，由后续调度再写
    pending = job;
    return;
  }
  saving = true;
  try {
    await saveDraftBackup(job);
  } catch (e) {
    console.warn('流式草稿备份失败:', e);
    // 失败保留，下次调度重试
    if (!pending) pending = job;
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
