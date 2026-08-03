/**
 * 角色/主语索引：从事实正文推断 subject，写前按出场角色硬捞相关事实。
 * 服务 AI 自动连载 200～300+ 章时「第 180 章写某人仍能捞到第 20 章铁律」。
 */

import type { Character, PinnedFact } from '../types/novel';

/** 从角色表抽可匹配名（本名+别名） */
export function characterNameKeys(characters: Character[]): { id: string; keys: string[] }[] {
  return characters.map((c) => {
    const keys = [c.name, c.alias]
      .flatMap((s) => (s || '').split(/[、，,/|]/))
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);
    // 去重
    return { id: c.id, keys: [...new Set(keys)] };
  });
}

/** 在文本中命中的角色名（最长优先，减少短名误伤） */
export function matchCharacterNamesInText(
  text: string,
  characters: Character[]
): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  const allKeys = characterNameKeys(characters)
    .flatMap((x) => x.keys)
    .sort((a, b) => b.length - a.length);
  for (const k of allKeys) {
    if (text.includes(k) && !seen.has(k)) {
      seen.add(k);
      hits.push(k);
    }
  }
  return hits;
}

/**
 * 为事实推断 subject：已有 subject 保留；否则用角色名命中。
 */
export function inferFactSubject(
  fact: Pick<PinnedFact, 'text' | 'subject'>,
  characters: Character[]
): string | undefined {
  if (fact.subject?.trim()) return fact.subject.trim().slice(0, 40);
  const hits = matchCharacterNamesInText(fact.text || '', characters);
  if (hits.length) return hits[0].slice(0, 40);
  return undefined;
}

/** 批量为事实补 subject（不改 status） */
export function enrichFactsWithSubjects(
  facts: PinnedFact[],
  characters: Character[]
): PinnedFact[] {
  if (!characters.length) return facts;
  return facts.map((f) => {
    const subject = inferFactSubject(f, characters);
    if (!subject || f.subject === subject) return f;
    return { ...f, subject };
  });
}

/**
 * 出场角色相关事实：subject 命中或正文含角色名。
 * 用于检索时「硬配额」保留，防止被近章热事实挤掉。
 */
export function factsLinkedToCharacters(
  facts: PinnedFact[],
  characters: Character[],
  involvedIds?: string[]
): PinnedFact[] {
  const pool =
    involvedIds?.length
      ? characters.filter((c) => involvedIds.includes(c.id))
      : characters;
  if (!pool.length) return [];
  const keys = characterNameKeys(pool).flatMap((x) => x.keys);
  if (!keys.length) return [];

  return facts.filter((f) => {
    if (f.subject && keys.some((k) => f.subject!.includes(k) || k.includes(f.subject!))) {
      return true;
    }
    const t = f.text || '';
    return keys.some((k) => t.includes(k));
  });
}
