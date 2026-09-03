/**
 * 作品自动备份（落磁盘）：
 * IndexedDB 里的书可能被浏览器数据清理/换浏览器清空——章末把整书 JSON
 * 写到 .novel-data/backups/，每书保留最近 N 份，损坏/误删可从文件恢复
 * （现有 .novel.json 导入即可恢复）。
 */
import fs from 'fs';
import path from 'path';
import { getAppRoot, hardenFilePermissions } from './llmService';

const BACKUP_DIR = path.join(getAppRoot(), '.novel-data', 'backups');
/** 每本书保留的备份份数 */
const KEEP_PER_PROJECT = 20;
/** 单份备份体积上限（防异常巨型 payload 撑爆磁盘） */
const MAX_BACKUP_BYTES = 9 * 1024 * 1024;

function safeProjectId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const t = id.trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(t) ? t : null;
}

function timestampName(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function writeProjectBackup(input: {
  projectId: unknown;
  title?: unknown;
  payload: unknown;
}): { file: string; size: number; kept: number; pruned: number } {
  const projectId = safeProjectId(input.projectId);
  if (!projectId) throw new Error('projectId 非法（仅允许字母/数字/_/-，≤64 字符）');
  if (!input.payload || typeof input.payload !== 'object') {
    throw new Error('payload 必须为项目 JSON 对象');
  }
  const body = JSON.stringify(input.payload);
  // 用字节长度计量：body.length 是 UTF-16 码元数，中文在 UTF-8 下约 3 字节/字符，
  // 按 length 比较会让实际体积达到上限的 ~3 倍，检查形同虚设
  const byteSize = Buffer.byteLength(body, 'utf-8');
  if (byteSize > MAX_BACKUP_BYTES) {
    throw new Error(`备份过大（${(byteSize / 1048576).toFixed(1)}MB > 9MB），已跳过`);
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  hardenFilePermissions(BACKUP_DIR, true);
  const prefix = `${projectId}-`;
  // 秒级时间戳可能撞名（章末去抖备份与手动触发同秒）：冲突则追加序号，避免静默覆盖
  let file = path.join(BACKUP_DIR, `${prefix}${timestampName()}.novel.json`);
  for (let i = 1; fs.existsSync(file); i++) {
    file = path.join(BACKUP_DIR, `${prefix}${timestampName()}-${i}.novel.json`);
  }
  fs.writeFileSync(file, body, 'utf-8');

  // 修剪：每书只保留最近 KEEP_PER_PROJECT 份
  const all = fs
    .readdirSync(BACKUP_DIR)
    .filter((n) => n.startsWith(prefix) && n.endsWith('.novel.json'))
    .sort();
  const pruned = Math.max(0, all.length - KEEP_PER_PROJECT);
  for (const name of all.slice(0, pruned)) {
    try {
      fs.rmSync(path.join(BACKUP_DIR, name), { force: true });
    } catch {
      // 单个修剪失败不致命
    }
  }
  return {
    file: path.basename(file),
    size: Buffer.byteLength(body, 'utf-8'),
    kept: Math.min(all.length, KEEP_PER_PROJECT),
    pruned,
  };
}

export function listProjectBackups(projectId?: unknown): {
  file: string;
  projectId: string;
  size: number;
  mtime: string;
}[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  let prefix: string | null = null;
  if (projectId !== undefined) {
    prefix = safeProjectId(projectId);
    if (!prefix) throw new Error('projectId 非法');
    prefix = `${prefix}-`;
  }
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((n) => n.endsWith('.novel.json') && (!prefix || n.startsWith(prefix as string)))
    .map((n) => {
      const full = path.join(BACKUP_DIR, n);
      const st = fs.statSync(full);
      return {
        file: n,
        projectId: n.replace(/\.novel\.json$/, '').replace(/-\d{8}-\d{6}(-\d+)?$/, ''),
        size: st.size,
        mtime: st.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/**
 * 删除指定项目的全部磁盘备份（项目删除时同步清理，数据生命周期：
 * 避免「删除项目后备份仍残留可恢复」。projectId 同样走白名单校验。
 */
export function deleteProjectBackups(projectId: unknown): { removed: number } {
  const id = safeProjectId(projectId);
  if (!id) throw new Error('projectId 非法');
  if (!fs.existsSync(BACKUP_DIR)) return { removed: 0 };
  const prefix = `${id}-`;
  let removed = 0;
  for (const name of fs.readdirSync(BACKUP_DIR)) {
    if (name.startsWith(prefix) && name.endsWith('.novel.json')) {
      try {
        fs.rmSync(path.join(BACKUP_DIR, name), { force: true });
        removed += 1;
      } catch {
        // 单个删除失败不致命（下次再删）
      }
    }
  }
  return { removed };
}
