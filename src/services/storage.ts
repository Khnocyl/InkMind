import type { BookProject, BookProjectSummary, StyleConfig } from '../types/novel';
import { migrateProjectToLatest } from './migrations';

const DB_NAME = 'novel_studio_db';
/** v2: 增加全书快照 store，用于写前/写后回滚 */
const DB_VERSION = 2;
const STORE_PROJECTS = 'projects';
export const STORE_META = 'meta';
export const STORE_SNAPSHOTS = 'snapshots';

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

export function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

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

export async function saveProject(project: BookProject): Promise<void> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readwrite');
    const store = tx.objectStore(STORE_PROJECTS);
    project.lastModified = new Date().toISOString();
    const request = store.put(project);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
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

  // R4：schema 版本迁移（纯函数，见 migrations.ts）
  const { project: migrated, fromVersion, toVersion, applied } =
    migrateProjectToLatest(raw);
  if (applied.length === 0) return migrated;

  // 迁移前自动快照（可回滚）。动态 import 避开 storage↔snapshots 静态循环依赖。
  try {
    const { createSnapshot } = await import('./snapshots');
    await createSnapshot(raw, {
      reason: 'migration',
      label: `迁移前备份 · schema v${fromVersion} → v${toVersion}`,
    });
  } catch (e) {
    console.warn('[migrations] 迁移前快照失败（继续迁移）', e);
  }

  // 迁移结果落盘（下次加载不再迁移）
  await saveProject(migrated);
  console.info(
    `[migrations] ${id}: v${fromVersion} → v${toVersion}（${applied
      .map((a) => a.name)
      .join(', ')}）`
  );
  return migrated;
}

export async function getAllProjects(): Promise<BookProjectSummary[]> {
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
          (acc, c) => acc + (c?.wordCount || (typeof c?.content === 'string' ? c.content.length : 0) || 0),
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
        };
      });
      // Sort by lastModified descending
      summaries.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
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

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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
    let request;
    if (id === null) {
      request = store.delete('active_project_id');
    } else {
      request = store.put({ key: 'active_project_id', value: id });
    }

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export const getProject = loadProject;
export const listProjects = getAllProjects;

