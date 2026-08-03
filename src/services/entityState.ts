/**
 * 地点 / 道具轻量状态（多实体记忆）。
 * 从 recap / 角色卡启发式抽取，写入 StoryMemory，写前注入防吃书。
 */

import type {
  Character,
  ChapterRecap,
  StoryMemory,
  WorldEntityState,
} from '../types/novel';
import { normalizeStoryMemory } from './storyMemory';

const MAX_LOCATIONS = 40;
const MAX_ITEMS = 40;

function nowIso(): string {
  return new Date().toISOString();
}

function entityId(kind: 'location' | 'item', name: string): string {
  const slug = name.replace(/\s+/g, '').slice(0, 24);
  return `${kind}-${slug}`;
}

function upsertEntity(
  list: WorldEntityState[],
  patch: Omit<WorldEntityState, 'updatedAt'> & { updatedAt?: string }
): WorldEntityState[] {
  const name = patch.name.trim();
  if (name.length < 2) return list;
  const id = patch.id || entityId(patch.kind, name);
  const idx = list.findIndex(
    (e) => e.id === id || (e.kind === patch.kind && e.name === name)
  );
  const next: WorldEntityState = {
    id,
    kind: patch.kind,
    name,
    status: patch.status?.trim().slice(0, 80) || undefined,
    note: patch.note?.trim().slice(0, 120) || undefined,
    lastChapterNumber: patch.lastChapterNumber,
    updatedAt: patch.updatedAt || nowIso(),
  };
  if (idx >= 0) {
    const prev = list[idx];
    const copy = [...list];
    copy[idx] = {
      ...prev,
      ...next,
      status: next.status || prev.status,
      note: next.note || prev.note,
      lastChapterNumber: next.lastChapterNumber ?? prev.lastChapterNumber,
    };
    return copy;
  }
  return [next, ...list].slice(0, patch.kind === 'location' ? MAX_LOCATIONS : MAX_ITEMS);
}

/** 从角色卡同步地点 */
export function syncLocationsFromCharacters(
  memory: StoryMemory,
  characters: Character[],
  chapterNumber?: number
): StoryMemory {
  let locations = [...(memory.locations || [])];
  for (const c of characters) {
    const loc = (c.currentLocation || '').trim();
    if (loc.length < 2) continue;
    locations = upsertEntity(locations, {
      id: entityId('location', loc),
      kind: 'location',
      name: loc,
      status: `${c.name}在此`,
      lastChapterNumber: chapterNumber ?? c.lastMemoryChapterNumber,
    });
  }
  return { ...memory, locations, updatedAt: nowIso() };
}

/**
 * 从 recap 文本抽地点 / 道具（启发式，不调 LLM）。
 */
export function extractEntitiesFromRecap(
  recap: ChapterRecap,
  chapterNumber: number
): { locations: WorldEntityState[]; items: WorldEntityState[] } {
  const blob = [
    recap.text || '',
    recap.endingState || '',
    ...(recap.keyFacts || []),
  ].join('\n');

  const locations: WorldEntityState[] = [];
  const items: WorldEntityState[] = [];
  const seenL = new Set<string>();
  const seenI = new Set<string>();

  const pushLoc = (name: string, status?: string) => {
    const n = name.trim().replace(/[的地]$/, '');
    if (n.length < 2 || n.length > 16 || seenL.has(n)) return;
    // 过滤太泛
    if (/^(这里|那里|此地|当场|途中|路上|其中|之后)$/.test(n)) return;
    seenL.add(n);
    locations.push({
      id: entityId('location', n),
      kind: 'location',
      name: n,
      status: status?.slice(0, 80),
      lastChapterNumber: chapterNumber,
      updatedAt: nowIso(),
    });
  };

  const pushItem = (name: string, status?: string) => {
    const n = name.trim();
    if (n.length < 2 || n.length > 14 || seenI.has(n)) return;
    if (/^(东西|物品|宝物|什么|那个)$/.test(n)) return;
    seenI.add(n);
    items.push({
      id: entityId('item', n),
      kind: 'item',
      name: n,
      status: status?.slice(0, 80),
      lastChapterNumber: chapterNumber,
      updatedAt: nowIso(),
    });
  };

  // 地点：在XXX / 位于XXX / 来到XXX / 前往XXX
  const locRe =
    /(?:在|于|位于|来到|抵达|逃往|退守|驻扎|藏身|潜回|回到|前往|奔向|杀入|攻入|闯出)([\u4e00-\u9fff]{2,10})(?:中|内|外|上|下|里|旁)?/g;
  let m: RegExpExecArray | null;
  while ((m = locRe.exec(blob)) !== null) {
    pushLoc(m[1], `章${chapterNumber}提及`);
  }

  // endingState 优先整句当现场
  if (recap.endingState?.trim()) {
    const end = recap.endingState.trim();
    const at = end.match(/在([\u4e00-\u9fff]{2,10})/);
    if (at) pushLoc(at[1], end.slice(0, 60));
  }

  // 道具：获得/失去/持有/夺/交/藏 + 名
  const itemRe =
    /(?:获得|得到|夺得|抢到|失去|遗失|持有|握着|收下|交还|藏起|毁掉|折断|炼化)了?([\u4e00-\u9fff]{2,8})(?:，|。|！|？|$)/g;
  while ((m = itemRe.exec(blob)) !== null) {
    const verb = blob.slice(Math.max(0, m.index - 2), m.index + 2);
    let st = `章${chapterNumber}`;
    if (/失去|遗失|毁掉|折断/.test(m[0]) || /失去|遗失/.test(verb)) st = `已失去·章${chapterNumber}`;
    else if (/获得|得到|夺|抢|收|持|握|藏/.test(m[0])) st = `持有/在场·章${chapterNumber}`;
    pushItem(m[1], st);
  }

  // keyFacts 里「…归XX所有」
  for (const f of recap.keyFacts || []) {
    const own = f.match(/([\u4e00-\u9fff]{2,8})(?:归|属于)([\u4e00-\u9fff]{2,8})/);
    if (own) pushItem(own[1], `归属：${own[2]}·章${chapterNumber}`);
  }

  return {
    locations: locations.slice(0, 12),
    items: items.slice(0, 12),
  };
}

/** 合并 recap 抽取 + 角色地点进 memory */
export function mergeEntitiesIntoMemory(
  memory: StoryMemory | null | undefined,
  options: {
    recap?: ChapterRecap | null;
    characters?: Character[];
    chapterNumber: number;
  }
): StoryMemory {
  let next = normalizeStoryMemory(memory || undefined);
  if (options.characters?.length) {
    next = syncLocationsFromCharacters(next, options.characters, options.chapterNumber);
  }
  if (options.recap) {
    const { locations, items } = extractEntitiesFromRecap(
      options.recap,
      options.chapterNumber
    );
    let locs = [...(next.locations || [])];
    let its = [...(next.items || [])];
    for (const l of locations) {
      locs = upsertEntity(locs, l);
    }
    for (const it of items) {
      its = upsertEntity(its, it);
    }
    next = {
      ...next,
      locations: locs.slice(0, MAX_LOCATIONS),
      items: its.slice(0, MAX_ITEMS),
      updatedAt: nowIso(),
    };
  }
  return next;
}

/** 写前注入块 */
export function formatEntitiesForPrompt(
  memory: StoryMemory | null | undefined,
  options?: { maxLoc?: number; maxItem?: number }
): string {
  const mem = normalizeStoryMemory(memory || undefined);
  const maxLoc = options?.maxLoc ?? 8;
  const maxItem = options?.maxItem ?? 8;
  const locs = [...(mem.locations || [])]
    .sort((a, b) => (b.lastChapterNumber || 0) - (a.lastChapterNumber || 0))
    .slice(0, maxLoc);
  const items = [...(mem.items || [])]
    .sort((a, b) => (b.lastChapterNumber || 0) - (a.lastChapterNumber || 0))
    .slice(0, maxItem);
  if (!locs.length && !items.length) return '';

  const lines: string[] = ['【地点/道具状态（不得无故吃书：人突然换地、丢物复活）】'];
  if (locs.length) {
    lines.push('地点：');
    locs.forEach((l, i) => {
      const ch = l.lastChapterNumber != null ? `·第${l.lastChapterNumber}章` : '';
      lines.push(`${i + 1}. ${l.name}${l.status ? `（${l.status}）` : ''}${ch}`);
    });
  }
  if (items.length) {
    lines.push('道具：');
    items.forEach((it, i) => {
      const ch = it.lastChapterNumber != null ? `·第${it.lastChapterNumber}章` : '';
      lines.push(`${i + 1}. ${it.name}${it.status ? `（${it.status}）` : ''}${ch}`);
    });
  }
  return lines.join('\n');
}

export function entitySummaryCounts(memory: StoryMemory | null | undefined): {
  locations: number;
  items: number;
} {
  const mem = normalizeStoryMemory(memory || undefined);
  return {
    locations: mem.locations?.length || 0,
    items: mem.items?.length || 0,
  };
}
