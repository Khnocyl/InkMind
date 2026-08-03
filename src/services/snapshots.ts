import type { BookProject } from '../types/novel';
import { initDB, STORE_META, STORE_SNAPSHOTS, saveProject } from './storage';
import { sanitizeProjectForExport } from './projectTransfer';

/** 每书最多保留快照数（超出删最旧） */
export const MAX_SNAPSHOTS_PER_PROJECT = 30;
/** meta store key 前缀：项目级快照上限（默认 MAX_SNAPSHOTS_PER_PROJECT） */
export function snapshotCapKey(projectId: string): string {
  return `snapshot-cap:${projectId}`;
}

export type SnapshotReason =
  | 'pre_write'
  | 'post_write'
  | 'manual'
  | 'pre_restore'
  | 'auto_pilot_round'
  /** 定稿锁定后（人工锁 / 机检绿通自动锁） */
  | 'finalize'
  /** R4：schema 版本迁移前自动备份 */
  | 'migration';

export interface ProjectSnapshotMeta {
  id: string;
  projectId: string;
  createdAt: string;
  reason: SnapshotReason;
  label: string;
  chapterId?: string;
  chapterNumber?: number;
  chapterTitle?: string;
  chapterCount: number;
  totalWords: number;
}

/**
 * 完整快照：元数据 + 全书拷贝。
 * v1（旧）：project 字段 = 未压缩完整项目对象；
 * v2（新）：projectGz 字段 = gzip 压缩后的项目 JSON（体积小 5~10x）。
 * 读取统一走 readSnapshotProject，两种格式都兼容。
 */
export interface ProjectSnapshot extends ProjectSnapshotMeta {
  /** v1 旧格式：未压缩全书（向后兼容，仅迁移前存在） */
  project?: BookProject;
  /** v2 新格式：gzip(JSON.stringify(sanitizeProjectForExport(project))) */
  projectGz?: ArrayBuffer;
}

export interface CreateSnapshotOptions {
  reason: SnapshotReason;
  label?: string;
  chapterId?: string;
  chapterNumber?: number;
  chapterTitle?: string;
  /** 默认 true：写后自动裁剪超额 */
  prune?: boolean;
}

function deepCloneProject(project: BookProject): BookProject {
  // structuredClone 在现代浏览器可用；失败则 JSON 兜底
  try {
    return structuredClone(sanitizeProjectForExport(project));
  } catch {
    return JSON.parse(JSON.stringify(sanitizeProjectForExport(project))) as BookProject;
  }
}

/** gzip 压缩 JSON 对象 → ArrayBuffer（现代浏览器 CompressionStream；失败抛错由调用方降级） */
export async function compressSnapshotJson(obj: unknown): Promise<ArrayBuffer> {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return await new Response(stream).arrayBuffer();
}

/** 解压 gzip ArrayBuffer → 原对象 */
export async function decompressSnapshotJson(buf: ArrayBuffer): Promise<unknown> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  const json = await new Response(stream).text();
  return JSON.parse(json) as unknown;
}

/** 读取快照全书：兼容 v1（project）与 v2（projectGz）；解压失败/无载荷返回 null */
export async function readSnapshotProject(
  snap: ProjectSnapshot
): Promise<BookProject | null> {
  if (snap.project) return snap.project;
  if (snap.projectGz) {
    try {
      return (await decompressSnapshotJson(snap.projectGz)) as BookProject;
    } catch (e) {
      console.warn('快照解压失败（数据损坏?）:', snap.id, e);
      return null;
    }
  }
  return null;
}

function countWords(project: BookProject): number {
  return (project.chapters || []).reduce(
    (sum, c) => sum + (c.wordCount || (c.content || '').replace(/\s+/g, '').length || 0),
    0
  );
}

export function snapshotReasonLabel(reason: SnapshotReason): string {
  switch (reason) {
    case 'pre_write':
      return '写前保护';
    case 'post_write':
      return '章后自动';
    case 'manual':
      return '手动快照';
    case 'pre_restore':
      return '回滚前备份';
    case 'auto_pilot_round':
      return 'Auto-Pilot';
    case 'finalize':
      return '定稿锁定';
    case 'migration':
      return '迁移前备份';
    default:
      return reason;
  }
}

function defaultLabel(
  reason: SnapshotReason,
  project: BookProject,
  opts: CreateSnapshotOptions
): string {
  const ch =
    opts.chapterNumber != null
      ? `第${opts.chapterNumber}章${opts.chapterTitle ? `《${opts.chapterTitle}》` : ''}`
      : '';
  switch (reason) {
    case 'pre_write':
      return ch ? `写前 · ${ch}` : '写前保护快照';
    case 'post_write':
      return ch ? `写后 · ${ch}` : '章后快照';
    case 'manual':
      return ch ? `手动 · ${ch}` : `手动 · 《${project.title || '未命名'}》`;
    case 'pre_restore':
      return '回滚前自动备份（当前状态）';
    case 'auto_pilot_round':
      return ch ? `AP · ${ch}` : 'Auto-Pilot 节点';
    case 'finalize':
      return ch ? `定稿 · ${ch}` : '定稿锁定快照';
    case 'migration':
      return `迁移前备份 · v${opts.chapterNumber ?? '?'}`;
    default:
      return snapshotReasonLabel(reason);
  }
}

/** 创建全书快照并落盘 IndexedDB */
export async function createSnapshot(
  project: BookProject,
  options: CreateSnapshotOptions
): Promise<ProjectSnapshotMeta> {
  if (!project?.id) {
    throw new Error('无法快照：项目无效');
  }

  const sanitized = sanitizeProjectForExport(project);
  let payload: Pick<ProjectSnapshot, 'project' | 'projectGz'>;
  try {
    // v2：gzip 压缩全书（中文 JSON 可压 5~10x）
    payload = { projectGz: await compressSnapshotJson(sanitized) };
  } catch {
    // 环境不支持 CompressionStream（极老浏览器）：降级明文，与旧版一致
    payload = { project: deepCloneProject(project) };
  }

  const snap: ProjectSnapshot = {
    id: `snap-${project.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    projectId: project.id,
    createdAt: new Date().toISOString(),
    reason: options.reason,
    label: options.label || defaultLabel(options.reason, project, options),
    chapterId: options.chapterId,
    chapterNumber: options.chapterNumber,
    chapterTitle: options.chapterTitle,
    chapterCount: (project.chapters || []).length,
    totalWords: countWords(project),
    ...payload,
  };

  const db = await initDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SNAPSHOTS, 'readwrite');
    tx.objectStore(STORE_SNAPSHOTS).put(snap);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  if (options.prune !== false) {
    await pruneSnapshots(project.id, MAX_SNAPSHOTS_PER_PROJECT);
  }

  const { project: _p, projectGz: _gz, ...meta } = snap;
  return meta;
}

/** 列出某书快照（新→旧），不含 project 大字段以减负——仍从整行 map 抽出 meta */
export async function listSnapshots(projectId: string): Promise<ProjectSnapshotMeta[]> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SNAPSHOTS, 'readonly');
    const idx = tx.objectStore(STORE_SNAPSHOTS).index('by_project');
    const req = idx.getAll(IDBKeyRange.only(projectId));
    req.onsuccess = () => {
      const rows = (req.result || []) as ProjectSnapshot[];
      const metas: ProjectSnapshotMeta[] = rows.map((s) => ({
        id: s.id,
        projectId: s.projectId,
        createdAt: s.createdAt,
        reason: s.reason,
        label: s.label,
        chapterId: s.chapterId,
        chapterNumber: s.chapterNumber,
        chapterTitle: s.chapterTitle,
        chapterCount: s.chapterCount,
        totalWords: s.totalWords,
      }));
      metas.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      resolve(metas);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getSnapshot(snapshotId: string): Promise<ProjectSnapshot | null> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SNAPSHOTS, 'readonly');
    const req = tx.objectStore(STORE_SNAPSHOTS).get(snapshotId);
    req.onsuccess = () => resolve((req.result as ProjectSnapshot) || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 从最近快照找回文风仿写档案（当前 styleProfiles 为空时用）。
 * 扫描最多 maxScan 条，返回带档案的 styleConfig 片段；找不到则 null。
 */
export async function recoverStyleProfilesFromSnapshots(
  projectId: string,
  maxScan = 12
): Promise<{
  styleProfiles: NonNullable<BookProject['styleConfig']>['styleProfiles'];
  activeStyleProfileId?: string | null;
  fromSnapshotLabel: string;
  fromSnapshotId: string;
} | null> {
  const metas = await listSnapshots(projectId);
  for (const m of metas.slice(0, maxScan)) {
    const snap = await getSnapshot(m.id);
    if (!snap) continue;
    const sc = (await readSnapshotProject(snap))?.styleConfig;
    const profiles = sc?.styleProfiles;
    if (Array.isArray(profiles) && profiles.length > 0) {
      return {
        styleProfiles: profiles,
        activeStyleProfileId: sc?.activeStyleProfileId ?? profiles[0]?.id ?? null,
        fromSnapshotLabel: m.label || snapshotReasonLabel(m.reason),
        fromSnapshotId: m.id,
      };
    }
  }
  return null;
}

/** 项目级快照上限：未设置返回 null（调用方回退到 MAX_SNAPSHOTS_PER_PROJECT） */
export async function getSnapshotCap(projectId: string): Promise<number | null> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readonly');
    const req = tx.objectStore(STORE_META).get(snapshotCapKey(projectId));
    req.onsuccess = () => {
      const v = req.result?.value;
      resolve(typeof v === 'number' && v >= 1 ? Math.floor(v) : null);
    };
    req.onerror = () => reject(req.error);
  });
}

/** 设置项目级快照上限（null 恢复默认 MAX_SNAPSHOTS_PER_PROJECT） */
export async function setSnapshotCap(
  projectId: string,
  cap: number | null
): Promise<void> {
  const db = await initDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    if (cap == null || cap < 1) {
      store.delete(snapshotCapKey(projectId));
    } else {
      store.put({ key: snapshotCapKey(projectId), value: Math.floor(cap) });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteSnapshot(snapshotId: string): Promise<void> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SNAPSHOTS, 'readwrite');
    tx.objectStore(STORE_SNAPSHOTS).delete(snapshotId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 超出 keep（缺省读项目级 cap，再缺省 MAX_SNAPSHOTS_PER_PROJECT）时删除最旧快照 */
export async function pruneSnapshots(
  projectId: string,
  keep?: number
): Promise<number> {
  const cap =
    keep ?? (await getSnapshotCap(projectId)) ?? MAX_SNAPSHOTS_PER_PROJECT;
  const metas = await listSnapshots(projectId);
  if (metas.length <= cap) return 0;
  const toDelete = metas.slice(cap); // metas 已新→旧，保留前 cap 条
  const db = await initDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SNAPSHOTS, 'readwrite');
    const store = tx.objectStore(STORE_SNAPSHOTS);
    for (const m of toDelete) {
      store.delete(m.id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return toDelete.length;
}

/**
 * 一次性后台迁移：把旧格式明文快照（project 字段）压缩成 v2（projectGz）。
 * 幂等：已是 v2 或解压失败的单条跳过。可选限定某书；全量迁移传 undefined。
 * 在事务外先完成所有压缩，再开事务批量写（避免 await 期间事务自动提交）。
 */
export async function migrateLegacySnapshots(projectId?: string): Promise<number> {
  const db = await initDB();
  const all = await new Promise<ProjectSnapshot[]>((resolve, reject) => {
    const tx = db.transaction(STORE_SNAPSHOTS, 'readonly');
    const req = tx.objectStore(STORE_SNAPSHOTS).getAll();
    req.onsuccess = () => resolve((req.result || []) as ProjectSnapshot[]);
    req.onerror = () => reject(req.error);
  });

  const legacy = all.filter(
    (s) => s.project && !s.projectGz && (!projectId || s.projectId === projectId)
  );
  if (!legacy.length) return 0;

  const prepared: Array<{ id: string; gz: ArrayBuffer }> = [];
  for (const s of legacy) {
    try {
      prepared.push({ id: s.id, gz: await compressSnapshotJson(s.project) });
    } catch {
      // 单条压缩失败：保留明文，跳过
    }
  }
  if (!prepared.length) return 0;

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SNAPSHOTS, 'readwrite');
    const store = tx.objectStore(STORE_SNAPSHOTS);
    for (const p of prepared) {
      // 事务内重读确认仍是明文，避免覆盖并发写入的新 v2
      const getReq = store.get(p.id);
      getReq.onsuccess = () => {
        const row = getReq.result as ProjectSnapshot | undefined;
        if (row && row.project && !row.projectGz) {
          const next: ProjectSnapshot = { ...row, projectGz: p.gz };
          delete (next as { project?: BookProject }).project;
          store.put(next);
        }
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return prepared.length;
}

export interface RestoreSnapshotResult {
  project: BookProject;
  /** 回滚前为当前状态打的安全快照（可能失败则为 null） */
  safetySnapshot: ProjectSnapshotMeta | null;
  restoredFrom: ProjectSnapshotMeta;
}

/**
 * 恢复快照到项目库，并写回 IndexedDB projects。
 * 恢复前自动对 current 打 pre_restore 快照（失败不阻断恢复）。
 */
export async function restoreSnapshot(
  snapshotId: string,
  currentProject: BookProject | null
): Promise<RestoreSnapshotResult> {
  const snap = await getSnapshot(snapshotId);
  const snapProject = snap ? await readSnapshotProject(snap) : null;
  if (!snap || !snapProject) {
    throw new Error('快照不存在或数据损坏');
  }

  let safetySnapshot: ProjectSnapshotMeta | null = null;
  if (currentProject && currentProject.id === snap.projectId) {
    try {
      safetySnapshot = await createSnapshot(currentProject, {
        reason: 'pre_restore',
        label: `回滚前备份（将恢复：${snap.label}）`,
        prune: true,
      });
    } catch (e) {
      console.warn('回滚前安全快照失败，继续恢复:', e);
    }
  }

  // 恢复时强制使用当前 projectId（防止历史脏 id）
  const restored: BookProject = {
    ...deepCloneProject(snapProject),
    id: snap.projectId,
    lastModified: new Date().toISOString(),
  };

  await saveProject(restored);

  const { project: _p, projectGz: _gz, ...restoredFrom } = snap;
  return { project: restored, safetySnapshot, restoredFrom };
}
