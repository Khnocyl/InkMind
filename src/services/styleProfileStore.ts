/**
 * 全局文风仿写档案库（R3 收尾·文风全局化）。
 *
 * 背景：文风仿写档案原存放在各项目 styleConfig.styleProfiles 内，
 * 开新书向导时新项目 styleConfig 为空 → 看不到已创建的档案。
 * 这里提供跨项目的全局档案库（localStorage），引擎页维护、向导可选。
 *
 * 语义：
 * - 引擎页导入/编辑/删除 → 同步 upsert/remove 全局库
 * - 新书向导「行文文风与短句约束」下拉 = 本书档案 ∪ 全局档案（id 去重，本书优先）
 * - 选中全局档案 → 复制一份进新书 styleConfig（向导完成即随新书持久化）
 */
import type { StyleProfile } from '../types/novel';

const STORAGE_KEY = 'novel_studio_global_style_profiles_v1';
const MAX_PROFILES = 50;

function readRaw(): StyleProfile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StyleProfile[]) : [];
  } catch {
    return [];
  }
}

function writeRaw(profiles: StyleProfile[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles.slice(0, MAX_PROFILES)));
  } catch (e) {
    console.error('[styleProfileStore] 全局档案库写入失败:', e);
  }
}

/** 读取全局档案库（副本，避免外部误改缓存） */
export function loadGlobalStyleProfiles(): StyleProfile[] {
  return readRaw().map((p) => ({ ...p }));
}

/** 合并一组档案进全局库（同 id 覆盖；用于引擎页导入/编辑、或项目档案首次入库） */
export function upsertGlobalStyleProfiles(profiles: StyleProfile[]): StyleProfile[] {
  const next = [...readRaw()];
  for (const p of profiles) {
    const idx = next.findIndex((x) => x.id === p.id);
    if (idx >= 0) next[idx] = { ...p };
    else next.unshift({ ...p });
  }
  writeRaw(next);
  return loadGlobalStyleProfiles();
}

/** 删除全局档案（引擎页删除档案时同步） */
export function removeGlobalStyleProfile(id: string): StyleProfile[] {
  const next = readRaw().filter((p) => p.id !== id);
  writeRaw(next);
  return loadGlobalStyleProfiles();
}

/** 清空全局库（供测试/重置） */
export function clearGlobalStyleProfiles(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 合并「本书档案 + 全局档案」为可选列表（向导下拉用）。
 * - 按 id 去重，本书优先（同 id 时用本书版本）
 * - 返回 { profiles, source: 'local' | 'global' } 标注来源
 */
export function mergeWizardStyleProfiles(
  bookProfiles: StyleProfile[] | undefined
): { profile: StyleProfile; source: 'local' | 'global' }[] {
  const book = bookProfiles || [];
  const global = readRaw();
  const seen = new Set<string>();
  const out: { profile: StyleProfile; source: 'local' | 'global' }[] = [];
  for (const p of book) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ profile: { ...p }, source: 'local' });
  }
  for (const p of global) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ profile: { ...p }, source: 'global' });
  }
  return out;
}
