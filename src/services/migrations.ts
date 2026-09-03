/**
 * R4 · 数据模型迁移框架。
 *
 * 原则：
 * - 项目 JSON 带 `schemaVersion`（缺省=0，存量数据）。
 * - 平时新增可选字段只走读取层 normalize（见 storage / 各服务），不递增版本。
 * - 结构性变更（字段重命名、类型改变、拆分合并）才递增 CURRENT_SCHEMA_VERSION
 *   并在本文件注册 from→from+1 迁移函数。
 * - 迁移为纯数据变换（无 IO），由 storage.loadProject 调用；迁移前自动快照 +
 *   迁移后落盘由调用方（storage）负责，本文件不碰 IndexedDB。
 */
import type { BookProject } from '../types/novel';

/** 当前最新 schema 版本。新迁移 = 先 +1 这里，再注册函数。 */
export const CURRENT_SCHEMA_VERSION = 1;

export interface MigrationLogEntry {
  from: number;
  to: number;
  name: string;
  /** ISO 时间 */
  at: string;
}

export interface MigrationResult {
  project: BookProject;
  fromVersion: number;
  toVersion: number;
  /** 实际执行的迁移（空 = 无需迁移） */
  applied: MigrationLogEntry[];
}

/**
 * 迁移注册表：key = 起始版本，value = 迁移到 key+1 的纯函数。
 * 注意：迁移函数必须只依赖入参 project，不得访问外部状态（可测试、可重放）。
 */
type MigrationFn = (project: BookProject) => BookProject;

const MIGRATIONS: Record<number, { name: string; fn: MigrationFn }> = {
  // v0 → v1：存量数据（无 schemaVersion）打上版本标记。
  // 历史字段兼容已由读取层 normalize 承担（settings/memory/chapters 等兜底），
  // 这里只补版本号，不做字段级改动——避免与 normalize 重复逻辑。
  0: {
    name: 'stamp-schema-version-v1',
    fn: (p) => ({ ...p, schemaVersion: 1 }),
  },
};

function currentVersionOf(p: BookProject): number {
  const v = p.schemaVersion;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

export interface MigrationPreview {
  fromVersion: number;
  toVersion: number;
  /** 将会执行的迁移名（空 = 无需迁移） */
  applied: string[];
  /** 版本超前（未来数据）：不迁移，调用方应警示「旧代码读写新数据」 */
  isFuture: boolean;
}

/**
 * 只预检不执行：返回该项目将会经过的迁移链。
 * 供 storage.loadProject 在真正迁移前打快照（快照必须覆盖
 * 「迁移函数本身可能 throw」的失败路径，因此要先于执行发生）。
 */
export function peekMigration(project: BookProject): MigrationPreview {
  const fromVersion = currentVersionOf(project);
  const applied: string[] = [];

  if (fromVersion >= CURRENT_SCHEMA_VERSION) {
    return {
      fromVersion,
      toVersion: fromVersion,
      applied,
      isFuture: fromVersion > CURRENT_SCHEMA_VERSION,
    };
  }

  for (let v = fromVersion; v < CURRENT_SCHEMA_VERSION; v += 1) {
    const entry = MIGRATIONS[v];
    if (!entry) {
      throw new Error(
        `缺少 schema v${v} → v${v + 1} 的迁移函数（CURRENT_SCHEMA_VERSION=${CURRENT_SCHEMA_VERSION}）`
      );
    }
    applied.push(entry.name);
  }

  return { fromVersion, toVersion: CURRENT_SCHEMA_VERSION, applied, isFuture: false };
}

/**
 * 把项目逐级迁移到最新版本。
 * - 已是最新 / 版本超前（未来数据）→ 原样返回，applied 为空。
 * - 迁移链任意一步失败 → 抛出，调用方应保留原数据（快照已先行）。
 */
export function migrateProjectToLatest(
  project: BookProject
): MigrationResult {
  const fromVersion = currentVersionOf(project);
  const applied: MigrationLogEntry[] = [];
  let cur = project;

  // 版本超前（如从新版降级回旧版代码）：不迁移，保持原样
  if (fromVersion >= CURRENT_SCHEMA_VERSION) {
    return { project: cur, fromVersion, toVersion: fromVersion, applied };
  }

  for (let v = fromVersion; v < CURRENT_SCHEMA_VERSION; v += 1) {
    const entry = MIGRATIONS[v];
    if (!entry) {
      throw new Error(
        `缺少 schema v${v} → v${v + 1} 的迁移函数（CURRENT_SCHEMA_VERSION=${CURRENT_SCHEMA_VERSION}）`
      );
    }
    cur = entry.fn(cur);
    applied.push({
      from: v,
      to: v + 1,
      name: entry.name,
      at: new Date().toISOString(),
    });
  }

  return {
    project: cur,
    fromVersion,
    toVersion: CURRENT_SCHEMA_VERSION,
    applied,
  };
}
