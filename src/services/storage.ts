import type { BookProject, BookProjectSummary, StyleConfig } from '../types/novel';
import { proseWords } from './proseWords';
import {
  CURRENT_SCHEMA_VERSION,
  migrateProjectToLatest,
  peekMigration,
} from './migrations';

const DB_NAME = 'novel_studio_db';
/** v2: 增加全书快照 store，用于写前/写后回滚 */
const DB_VERSION = 2;
const STORE_PROJECTS = 'projects';
export const STORE_META = 'meta';
export const STORE_SNAPSHOTS = 'snapshots';
/** 导出仅用于测试直接写原始行；业务代码请走 saveProject */
export const STORE_PROJECTS_NAME = STORE_PROJECTS;

/**
 * meta store 中「属于某个项目」的键前缀/构造器。
 * 定义在这里（而不是各自的 service）是为了让 deleteProject 能在同一事务内
 * 级联清理，避免 storage 反向依赖 draftBackup/snapshots 造成循环导入。
 */
export const DRAFT_META_PREFIX = 'draft:';
/** 拆书任务索引的 meta 键前缀（同上：为让 deleteProject 级联清理而定义在此） */
export const DECONSTRUCT_JOB_PREFIX = 'deconstruct-job:';
/** 项目级快照上限的 meta 键 */
export function snapshotCapMetaKey(projectId: string): string {
  return `snapshot-cap:${projectId}`;
}

export function getDefaultStyleConfig(): StyleConfig {
  return {
    clicheBlacklist: [
      '那一刻',
      '不由得深吸一口气',
      '眼底闪过一丝警惕',
      '嘴角勾起一抹弧度',
      '心中暗自震惊',
      '一股恐怖的气息铺天盖地而来',
      '整个人都愣住了',
      '倒吸一口凉气',
      '如同断了线的风筝',
      '化作一道残影',
    ],
    customBlacklist: [
      '在这茫茫天地间',
      '命运的转轮已然开始转动',
      '这就是真实的残酷',
    ],
    enforceShowDontTell: true,
    forbidEndingSublimation: true,
    // 按角色路由模型：默认关闭（总开关 false），全部跟随激活档
    llmRoleRouting: { enabled: false, routes: {} },
    selectedExampleId: 'example-literary-dark',
    fewShotExamples: [
      {
        id: 'example-literary-dark',
        title: '冷峻沉浸式·细节质感风',
        authorStyle: '注重空间氛围与动作细节，无直接解说，无高高在上的叙事者视角',
        content: `雨水顺着兽首飞檐的瓦缝滴在青石板上，发出沉闷的嗒响。叶无痕把斗笠的帽檐往低压了三分，右指轻扣刀柄。街尾的茶肆没有挂风灯，暗处仅仅能看清几个人影握杯指节发红。\n\n“茶冷了。”坐在他对面的老者没有抬眼，把一锭沾着青苔泥迹的碎银推到了桌心。银锭底下压着一片半损的羽信，边缘留有北地霜莺特有的霜绒。`,
        analysis: `通过“雨水顺着瓦缝滴落”、“握杯指节发红”、“沾着青苔泥迹的碎银”直接展示场景与人物状态，完全没有“此时气氛特别紧张”、“他心里十分害怕”之类直接告诉读者的陈词滥调。结尾定格在具体道具（羽信）上，戛然而止。`,
      },
      {
        id: 'example-wuxia-crisp',
        title: '老派硬核武侠·利落短句风',
        authorStyle: '节凑紧凑快疾，交锋只在呼吸之间，充满力量法则与空间碰撞',
        content: `寒光骤起！\n\n那是一截从袖底错出的尺二短刺。没有呼啸风声，没有多余招式，刺尖直取锁骨下一寸三分的肩井穴。苏清雪脚下滴水未溅，身子却如风中残柳般斜折而去。就在错身之际，她指间的剑鞘斜扣，刚好架住短刺的刃根，发出一声令人耳膜刺痛的极锐金铁交鸣。`,
        analysis: `短句频出，“寒光骤起！”直接切入动作。具体指明“锁骨下一寸三分的肩井穴”、“指间的剑鞘斜扣”，增强可信度与真实交锋画面感。`,
      },
      {
        id: 'example-epic-dense',
        title: '东方史诗·深邃群像风',
        authorStyle: '讲究古朴词汇与深沉底蕴，世界观规则感强，克制沉稳',
        content: `归墟断层上空的青雾终年不散。这里的重力法则被上古封天阵扭曲，常人若是踏足，气血会随地脉反向倒逆。高台上，九名执事分立八方，手掌全数按在中央那尊刻满饕餮纹的震天铜鼎之上。鼎身转动一截，地面深坑便有一声沉闷的叹息自九泉传来。`,
        analysis: `清晰展现“重力法则被阵法扭曲、常人气血反向倒逆”的规则限制，环境渲染扎实，无任何多余情绪煽情。`,
      },
    ],
  };
}

/** 共享连接：此前每次 initDB 新开一个永不关闭的连接（Auto-Pilot 长会话可累积数百个） */
let cachedDb: IDBDatabase | null = null;

export function initDB(): Promise<IDBDatabase> {
  if (cachedDb) return Promise.resolve(cachedDb);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    // 其他标签页/旧版本页面持有连接时升级会被永久阻塞——明确失败而不是无声悬挂
    request.onblocked = () => {
      reject(
        new Error('数据库被本应用的其他标签页占用，无法完成打开/升级。请关闭其他页面后刷新重试。')
      );
    };
    request.onsuccess = () => {
      const db = request.result;
      // 他页请求升级时主动关闭并让缓存失效，避免阻塞对方的 onupgradeneeded
      db.onversionchange = () => {
        db.close();
        cachedDb = null;
      };
      // 连接被外部关闭（浏览器强制回收 / 数据库被 deleteDatabase）：必须让缓存失效，
      // 否则 cachedDb 指向已关闭连接，后续 db.transaction(...) 抛 InvalidStateError。
      db.onclose = () => {
        if (cachedDb === db) cachedDb = null;
      };
      cachedDb = db;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
        const snapStore = db.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'id' });
        snapStore.createIndex('by_project', 'projectId', { unique: false });
        snapStore.createIndex('by_project_time', ['projectId', 'createdAt'], { unique: false });
      }
    };
  });
}

/** 跨标签页写冲突：库中 rev 高于调用方携带值时拒写（防 last-writer-wins 静默覆盖） */
export class ProjectConflictError extends Error {
  readonly projectId: string;
  constructor(projectId: string) {
    super(
      '保存被拒绝：这本书已在其他标签页/窗口被修改。为避免覆盖那边的改动，本次修改未落盘——请刷新页面后再试。'
    );
    this.name = 'ProjectConflictError';
    this.projectId = projectId;
  }
}

export function isProjectConflictError(e: unknown): e is ProjectConflictError {
  return (
    e instanceof ProjectConflictError ||
    (e instanceof Error && e.name === 'ProjectConflictError')
  );
}

/**
 * 保存项目。在同一事务内读旧 rev、冲突检查、rev+1 落盘，并把新 rev 就地回写到
 * 传入对象（与 lastModified 同样的约定）——因此持有活对象的调用方自动获得正确 rev。
 * @param options.force 跳过冲突检查（快照恢复等明知要覆盖旧 rev 的路径）
 * @returns 落盘后的新 rev
 */
export async function saveProject(
  project: BookProject,
  options?: { force?: boolean }
): Promise<number> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readwrite');
    const store = tx.objectStore(STORE_PROJECTS);
    project.lastModified = new Date().toISOString();

    const getReq = store.get(project.id);
    getReq.onerror = () => reject(getReq.error);
    // 新 rev 先在闭包里算出，**只在事务提交成功后**才写回调用方活对象。
    // 若在 put 前就改写 project.rev，事务 commit 失败（配额/abort）时内存 rev
    // 已"前进"而磁盘未变——下次保存的冲突判定 existingRev > callerRev 会失效，
    // 从而静默覆盖另一标签页的写入，ProjectConflictError 这道防线被绕过。
    let nextRev = project.rev ?? 0;
    getReq.onsuccess = () => {
      const existing = getReq.result as BookProject | undefined;
      const existingRev = existing?.rev ?? 0;
      const callerRev = project.rev ?? 0;
      // 桌面端为单实例单窗口（无跨标签页），且 callerRev === 0 属初始写入或迁移，均不应误判为冲突拒写
      const isDesktop = typeof window !== 'undefined' && !!(window as any).electron;
      if (!options?.force && !isDesktop && callerRev > 0 && existing && existingRev > callerRev) {
        // 另一标签页在我们最后一次读盘之后写过：拒写，让调用方提示刷新
        reject(new ProjectConflictError(project.id));
        return;
      }
      nextRev = existingRev + 1;
      store.put({ ...project, rev: nextRev });
    };

    // 以事务提交为准（而非 request.onsuccess）：commit 阶段失败（典型
    // QuotaExceededError）时必须让调用方知道「没落盘」——useProjectPersistence
    // 的不变量是 resolve 即已落盘。
    tx.oncomplete = () => {
      project.rev = nextRev;
      invalidateProjectListCache();
      resolve(nextRev);
    };
    tx.onabort = () => reject(tx.error || new Error('saveProject 事务中止'));
    tx.onerror = () => reject(tx.error || new Error('saveProject 事务失败'));
  });
}

/**
 * 本次会话内已确认过「迁移/降级保护快照」的项目+标签。
 * 降级（isFuture）状态会一直存在到用户升级版本，若不记这一笔，每次打开这本书
 * 都要全量列一次快照——等于给「打开书」平白加一次全库快照读取。
 */
const ensuredMigrationSnapshots = new Set<string>();

/**
 * 幂等建立「迁移/降级前」保护快照：同 (项目, 标签) 已存在则跳过。
 *
 * 必须幂等的原因：迁移结果落盘可能失败（跨页冲突 / 配额）。此时磁盘上仍是旧
 * schema，下次加载会再次进入迁移分支——若无条件建快照，就会每次加载都新增一条
 * pinned（永不裁剪）的整书 gzip 快照，IndexedDB 体积单调增长，最终触发
 * QuotaExceededError，反过来让迁移落盘继续失败，形成死循环。
 */
async function ensureMigrationSnapshot(raw: BookProject, label: string): Promise<void> {
  const key = `${raw.id}::${label}`;
  if (ensuredMigrationSnapshots.has(key)) return;
  // 动态 import 避开 storage↔snapshots 循环依赖
  const { createSnapshot, listSnapshots } = await import('./snapshots');
  const existing = await listSnapshots(raw.id);
  if (!existing.some((m) => m.reason === 'migration' && m.label === label)) {
    await createSnapshot(raw, { reason: 'migration', label });
  }
  ensuredMigrationSnapshots.add(key);
}

export async function loadProject(id: string): Promise<BookProject | null> {
  const db = await initDB();
  const raw = await new Promise<BookProject | null>((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readonly');
    const store = tx.objectStore(STORE_PROJECTS);
    const request = store.get(id);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  if (!raw) return null;

  // 迁移/降级前自动保护快照（可回滚）——必须在迁移函数执行之前：
  // migrateProjectToLatest 可能 throw（缺迁移函数/非法数据），快照保护
  // 恰恰要覆盖这条最需要它的失败路径。
  //
  // 预检与建快照解耦：peekMigration 在「缺迁移函数」时会抛错，若把建快照
  // 放在它之后，最需要快照的场景反而拿不到快照。预检失败 → 保守建一份。
  let preview: ReturnType<typeof peekMigration> | null = null;
  try {
    preview = peekMigration(raw);
  } catch (e) {
    console.warn(`[migrations] ${id}: 迁移预检失败（可能缺迁移函数），仍先建保护快照`, e);
  }
  try {
    if (preview?.isFuture) {
      // 降级：数据由更新版本写入，旧代码读写新数据可能丢字段。先留一份
      // 不可裁剪的保护快照，保证「不可逆损坏」至少可恢复。
      await ensureMigrationSnapshot(
        raw,
        `降级保护备份 · schema v${preview.fromVersion}（当前代码仅支持 v${CURRENT_SCHEMA_VERSION}）`
      );
      console.warn(
        `[migrations] ${id}: 数据 schema v${preview.fromVersion} 高于当前代码支持的 v${CURRENT_SCHEMA_VERSION}` +
          '（可能从新版降级）。已留保护快照并原样加载——旧代码读写新数据，请尽快升级版本。'
      );
    } else if (!preview || preview.applied.length > 0) {
      const fromV =
        preview?.fromVersion ?? (typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0);
      const toV = preview?.toVersion ?? CURRENT_SCHEMA_VERSION;
      await ensureMigrationSnapshot(raw, `迁移前备份 · schema v${fromV} → v${toV}`);
    }
  } catch (e) {
    console.warn('[migrations] 迁移前快照失败（继续迁移）', e);
  }

  // R4：schema 版本迁移（纯函数，见 migrations.ts）
  // 迁移函数本身抛错（缺迁移函数/脏数据）不能让整本书打不开——原样返回并告警。
  let migrated: BookProject;
  let fromVersion: number;
  let toVersion: number;
  let applied: ReturnType<typeof migrateProjectToLatest>['applied'];
  try {
    ({ project: migrated, fromVersion, toVersion, applied } = migrateProjectToLatest(raw));
  } catch (e) {
    console.error(`[migrations] ${id}: 迁移失败，按原数据加载（请勿在此状态继续写作）`, e);
    return raw;
  }
  if (applied.length === 0) return migrated;

  // 迁移结果落盘（下次加载不再迁移）。落盘失败不阻断本次加载：
  // 并发写导致的 ProjectConflictError 不该让「书打不开」。
  try {
    await saveProject(migrated);
  } catch (e) {
    console.warn(`[migrations] ${id}: 迁移结果落盘失败（本次仍按迁移后数据使用）`, e);
    return migrated;
  }
  console.info(
    `[migrations] ${id}: v${fromVersion} → v${toVersion}（${applied
      .map((a) => a.name)
      .join(', ')}）`
  );
  return migrated;
}

/**
 * 书列表缓存（性能）：此前每次落盘都伴随 listProjects() —— IndexedDB
 * 全库 getAll 反序列化所有书再逐书统计，书多时每次击键级别落盘都在全库扫描。
 * TTL 3s + 写路径失效：saveProject/deleteProject 即刻失效，书库选择等
 * 场景最多看 3 秒旧的 lastModified（仅侧栏摘要展示，可接受）。
 */
const PROJECT_LIST_TTL_MS = 3000;
let projectListCache: { at: number; data: BookProjectSummary[] } | null = null;

export function invalidateProjectListCache(): void {
  projectListCache = null;
}

export async function getAllProjects(): Promise<BookProjectSummary[]> {
  if (projectListCache && Date.now() - projectListCache.at < PROJECT_LIST_TTL_MS) {
    return projectListCache.data;
  }
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readonly');
    const store = tx.objectStore(STORE_PROJECTS);
    const request = store.getAll();

    request.onsuccess = () => {
      const projects: BookProject[] = request.result || [];
      const summaries = projects.map((p) => {
        // 容错：旧数据 / 孵化中途项目可能缺 chapters 字段
        const chapters = Array.isArray(p.chapters) ? p.chapters : [];
        const completedChaptersCount = chapters.filter(
          (c) =>
            c?.status === '校验精修定稿' ||
            (typeof c?.content === 'string' && c.content.trim().length > 100)
        ).length;
        const totalWords = chapters.reduce(
          (acc, c) => acc + (c?.wordCount || (typeof c?.content === 'string' ? proseWords(c.content) : 0) || 0),
          0
        );
        const targetTotal =
          p.config?.totalChapters ||
          p.config?.targetChapterCount ||
          chapters.length ||
          100;
        return {
          id: p.id,
          title: p.title || '未命名小说项目',
          subtitle: p.subtitle || '',
          genre: p.genre || p.config?.genre || '玄幻',
          synopsis: p.synopsis || p.config?.inspiration || '',
          createdDate: p.createdDate || p.createdAt,
          createdAt: p.createdAt || p.createdDate,
          lastModified: p.lastModified || p.createdAt || p.createdDate || new Date(0).toISOString(),
          wizardStep: p.wizardStep || 'ready',
          totalChapters: targetTotal,
          completedChaptersCount,
          totalWords,
          isDeconstruct: !!p.deconstructMeta,
        };
      });
      // Sort by lastModified descending
      summaries.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
      projectListCache = { at: Date.now(), data: summaries };
      resolve(summaries);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deleteProject(id: string): Promise<void> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const storeNames = db.objectStoreNames.contains(STORE_SNAPSHOTS)
      ? [STORE_PROJECTS, STORE_META, STORE_SNAPSHOTS]
      : [STORE_PROJECTS, STORE_META];
    const tx = db.transaction(storeNames, 'readwrite');
    const projectStore = tx.objectStore(STORE_PROJECTS);
    projectStore.delete(id);

    // If active project is deleted, clear active project meta
    const metaStore = tx.objectStore(STORE_META);
    const getActiveReq = metaStore.get('active_project_id');
    getActiveReq.onsuccess = () => {
      if (getActiveReq.result && getActiveReq.result.value === id) {
        metaStore.delete('active_project_id');
      }
    };

    // 级联清理该书遗留的 meta：流式草稿备份 + 项目级快照上限 + 拆书任务索引。
    // 此前只删 projects/snapshots，导致被删项目的整章正文长期残留在 IndexedDB。
    metaStore.delete(snapshotCapMetaKey(id));
    metaStore.delete(`${DECONSTRUCT_JOB_PREFIX}${id}`);
    const draftPrefix = `${DRAFT_META_PREFIX}${id}:`;
    const metaCursorReq = metaStore.openCursor();
    metaCursorReq.onsuccess = () => {
      const cursor = metaCursorReq.result;
      if (!cursor) return;
      if (String(cursor.key).startsWith(draftPrefix)) cursor.delete();
      cursor.continue();
    };

    // 级联删除该书全部快照
    if (db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
      const snapStore = tx.objectStore(STORE_SNAPSHOTS);
      const idx = snapStore.index('by_project');
      const range = IDBKeyRange.only(id);
      const cursorReq = idx.openCursor(range);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    }

    tx.oncomplete = () => {
      invalidateProjectListCache();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('deleteProject 事务中止'));
  });
}

export async function getActiveProjectId(): Promise<string | null> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readonly');
    const store = tx.objectStore(STORE_META);
    const request = store.get('active_project_id');

    request.onsuccess = () => resolve(request.result ? request.result.value : null);
    request.onerror = () => reject(request.error);
  });
}

export async function setActiveProjectId(id: string | null): Promise<void> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    if (id === null) {
      store.delete('active_project_id');
    } else {
      store.put({ key: 'active_project_id', value: id });
    }

    // 以事务提交为准（同 saveProject）：commit 阶段失败（配额）时不能误报成功，
    // 否则「活跃书」没落盘却以为成功，下次启动恢复的书不对。
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('setActiveProjectId 事务失败'));
    tx.onabort = () => reject(tx.error || new Error('setActiveProjectId 事务中止'));
  });
}

export const getProject = loadProject;
export const listProjects = getAllProjects;

