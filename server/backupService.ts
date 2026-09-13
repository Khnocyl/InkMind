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

  const dirExisted = fs.existsSync(BACKUP_DIR);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  // 只在**首次创建**时加固：目录权限是幂等的，而 Windows 上 icacls 要 spawn 一个
  // 进程（~150ms/次），此前每次写备份都重复加固，纯属浪费（测试里 44 次写入就要 9 秒）。
  // 安全性不打折：目录已存在时其 ACL 早已设好；即便缺失，父目录 .novel-data 已被
  // ensureDirectories 以 (OI)(CI) 加固，新建子目录会自动继承该保护。
  if (!dirExisted) hardenFilePermissions(BACKUP_DIR, true);
  const prefix = `${projectId}-`;
  // 秒级时间戳可能撞名（章末去抖备份与手动触发同秒）：冲突则追加序号，避免静默覆盖。
  // 时间戳只取一次——此前在循环体内每次重算，若循环期间跨过秒边界，候选名会变，
  // 碰撞检测与实际写入的名字对不上。
  const stamp = timestampName();
  let file = path.join(BACKUP_DIR, `${prefix}${stamp}.novel.json`);
  for (let i = 1; fs.existsSync(file); i++) {
    file = path.join(BACKUP_DIR, `${prefix}${stamp}-${i}.novel.json`);
  }
  // 原子写入：先写 .tmp 再 rename。
  // 直接 writeFileSync 目标文件时，进程被杀/断电/磁盘写满会留下**截断的半个 JSON**，
  // 而备份是 IndexedDB 之外的最后一道恢复手段——坏备份比没备份更危险：
  // 它能被 listProjectBackups 列出、体积看着正常，用户真去恢复时才发现解析失败。
  // rename 在同一文件系统内是原子的，读者只可能看到完整文件。
  const tmpFile = `${file}.tmp`;
  try {
    fs.writeFileSync(tmpFile, body, 'utf-8');
    fs.renameSync(tmpFile, file);
  } catch (err) {
    try {
      fs.rmSync(tmpFile, { force: true });
    } catch {
      // 清理临时文件失败不掩盖原始错误
    }
    throw err;
  }

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
