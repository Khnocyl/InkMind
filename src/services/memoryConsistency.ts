/**
 * R7 · 记忆多路回写一致性。
 *
 * 原则：
 * - 书级 memory（pinnedFacts / factLedger）为权威，角色卡为派生视图（死亡双向同步已覆盖）。
 * - 本模块做「回写前冲突检测」：章末 recap 的新 keyFacts 若与既有钉死事实语义矛盾
 *   （同主语状态相反 / 归属冲突），降级为 warn + 提示，绝不静默吞掉。
 * - 全部为纯函数（可测试、可重放），不碰 IO；接入点在 useChapterPipeline 章末回写处。
 */
import type {
  ChapterRecap,
  Character,
  PinnedFact,
  StoryMemory,
} from '../types/novel';
import { listActiveFacts } from './storyMemory';

export interface MemoryConsistencyConflict {
  kind: 'recap_vs_pinned' | 'ledger_vs_character';
  severity: 'warn' | 'info';
  description: string;
  suggestion: string;
  /** 关联的新事实文本（recap 侧） */
  factText?: string;
  /** 关联的旧事实文本（pinned 侧） */
  oldFactText?: string;
}

const DEATH_TONE = /死|亡|陨|殒|阵亡|身亡|战死|毙命|殉|香消玉殒|驾鹤/;
const REVIVAL_TONE =
  /复生|复活|重生|苏醒|醒来|未死|没死|还活着|生还|归来|死而|起死回生|转世|借尸还魂|假死|诈死|假死过|并未死|没死透|未死透/;
const OWNERSHIP_RE = /(?:归|属于|持有|得到|获得|夺得|抢到)([\u4e00-\u9fff]{2,6})/;

/** 提取事实的主语候选：文本开头的连续汉字（取前 4 字） */
function extractSubject(text: string): string {
  const m = text.match(/[\u4e00-\u9fff]{2,}/);
  return m ? m[0].slice(0, 4) : '';
}

/** 公共前缀长度（字） */
function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  const max = Math.min(a.length, b.length);
  while (n < max && a[n] === b[n]) n += 1;
  return n;
}

/** 两个主语是否视为同一实体：相等 / 互相包含 / 公共前缀 ≥ 2 字（宁松勿严） */
function sameSubject(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  return commonPrefixLen(a, b) >= 2;
}

function isDeadTone(text: string): boolean {
  return DEATH_TONE.test(text);
}

function isRevivalTone(text: string): boolean {
  return REVIVAL_TONE.test(text);
}

/**
 * 章末 recap 新 keyFacts vs 既有钉死事实的矛盾检测。
 * 场景：旧「叶无痕已死」+ 新「叶无痕复活」——合法剧情反转，但必须显式（warn 不阻断）。
 */
export function detectRecapConflicts(
  memory: StoryMemory | null | undefined,
  recap: ChapterRecap | null | undefined
): MemoryConsistencyConflict[] {
  const conflicts: MemoryConsistencyConflict[] = [];
  const facts: PinnedFact[] = listActiveFacts(memory);
  if (!facts.length || !recap?.keyFacts?.length) return conflicts;

  for (const raw of recap.keyFacts) {
    const text = String(raw || '').trim();
    if (text.length < 4) continue;
    const subject = extractSubject(text);
    if (!subject) continue;

    for (const old of facts) {
      if (!sameSubject(extractSubject(old.text), subject)) continue;

      // 死 ↔ 复 反转
      if (isRevivalTone(text) && isDeadTone(old.text)) {
        conflicts.push({
          kind: 'recap_vs_pinned',
          severity: 'warn',
          description: `新事实「${text.slice(0, 60)}」与旧钉死事实「${old.text.slice(
            0,
            60
          )}」存在生死反转`,
          suggestion:
            '若是合法反转（复活/未死透），请在正文明确交代原因与代价；否则需作废旧事实或修正表述。',
          factText: text,
          oldFactText: old.text,
        });
        continue;
      }
      if (isDeadTone(text) && isRevivalTone(old.text)) {
        conflicts.push({
          kind: 'recap_vs_pinned',
          severity: 'warn',
          description: `新事实「${text.slice(0, 60)}」与旧钉死事实「${old.text.slice(
            0,
            60
          )}」矛盾（旧称未死/复活）`,
          suggestion: '核对是否吃书；若角色再度死亡，请作废旧事实并写明。',
          factText: text,
          oldFactText: old.text,
        });
        continue;
      }

      // 归属冲突：X 归 A vs X 归 B（A≠B）
      const newOwner = text.match(OWNERSHIP_RE)?.[1];
      const oldOwner = old.text.match(OWNERSHIP_RE)?.[1];
      if (newOwner && oldOwner && !sameSubject(newOwner, oldOwner)) {
        conflicts.push({
          kind: 'recap_vs_pinned',
          severity: 'warn',
          description: `新事实「${text.slice(0, 60)}」与旧钉死事实「${old.text.slice(
            0,
            60
          )}」归属冲突（${oldOwner} → ${newOwner}）`,
          suggestion: '道具易主需在正文交代，或作废旧归属事实。',
          factText: text,
          oldFactText: old.text,
        });
      }
    }
  }

  return conflicts;
}

/**
 * 账本死亡断言 vs 角色卡状态不一致（轻量对账）。
 * 方向约定：账本为权威（章末同步会以账本覆盖角色卡）；这里只做「即将发生静默覆盖」的提示。
 */
export function detectLedgerCharacterConflicts(
  memory: StoryMemory | null | undefined,
  characters: Character[]
): MemoryConsistencyConflict[] {
  const conflicts: MemoryConsistencyConflict[] = [];
  if (!characters.length) return conflicts;

  const deathSubjects = new Set<string>();
  for (const a of memory?.factLedger?.assertions || []) {
    if (a.kind === 'death' || a.value === 'dead') {
      const s = (a.subject || '').trim();
      if (s) deathSubjects.add(s);
    }
  }
  if (!deathSubjects.size) return conflicts;

  for (const c of characters) {
    if (c.status === '已阵亡/退出') continue;
    if (deathSubjects.has(c.name)) {
      conflicts.push({
        kind: 'ledger_vs_character',
        severity: 'info',
        description: `账本已记「${c.name}」死亡，角色卡仍为「${c.status}」`,
        suggestion: '章末同步会将角色卡改为已阵亡；若角色实际未死，请先修正账本。',
      });
    }
  }
  return conflicts;
}
