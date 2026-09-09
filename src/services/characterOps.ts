import type { BookProject, Character, CharacterRole, CharacterStatus } from '../types/novel';

/**
 * 把 AI / 外部来源的角色补齐为完整形状。
 *
 * 背景（用户反馈的运行时崩溃）：`TypeError: Cannot read properties of undefined
 * (reading 'map')` 发生在 CharacterManager 的 `selectedChar.relations.map(...)`。
 * 模型返回的角色常常缺 `relations`（prompt 里要求了但不保证），而落盘路径
 * 直接 `characters: res.characters || []` 就存了 —— 于是角色图谱一选中就崩。
 * 这里在入口统一补默认值，渲染层再兜一层。
 */
export function normalizeCharacters(raw: unknown): Character[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c, i) => {
      const str = (v: unknown, fallback = ''): string =>
        typeof v === 'string' && v.trim() ? v : fallback;
      return {
        id: str(c.id) || `char-${Date.now()}-${i}`,
        name: str(c.name, `未命名角色${i + 1}`),
        alias: typeof c.alias === 'string' ? c.alias : '',
        role: (typeof c.role === 'string' ? c.role : '重要配角') as CharacterRole,
        status: (typeof c.status === 'string' ? c.status : '活跃') as CharacterStatus,
        realmOrTitle: typeof c.realmOrTitle === 'string' ? c.realmOrTitle : '',
        currentLocation: typeof c.currentLocation === 'string' ? c.currentLocation : '',
        personality: typeof c.personality === 'string' ? c.personality : '',
        appearance: typeof c.appearance === 'string' ? c.appearance : '',
        background: typeof c.background === 'string' ? c.background : '',
        secretNotes: typeof c.secretNotes === 'string' ? c.secretNotes : '',
        relations: Array.isArray(c.relations)
          ? (c.relations as Character['relations'])
          : [],
      } satisfies Character;
    });
}

/**
 * 角色增删改的纯函数（App 只负责落盘）。
 *
 * 删除角色时必须级联清理引用，否则会留下悬空 id：
 * - 章节的 involvedCharacterIds 仍指向已删角色（RAG 检索/上下文包会捞不到人）；
 * - 其他角色的 relations 仍指向它（关系图谱里显示成一串乱码 id）。
 */
export function removeCharacterFromProject(
  project: Pick<BookProject, 'characters' | 'chapters'>,
  characterId: string
): Pick<BookProject, 'characters' | 'chapters'> {
  const characters = (project.characters || [])
    .filter((c) => c.id !== characterId)
    .map((c) => {
      const relations = (c.relations || []).filter((r) => r.targetId !== characterId);
      return relations.length === (c.relations || []).length ? c : { ...c, relations };
    });

  const chapters = (project.chapters || []).map((ch) => {
    const ids = ch.involvedCharacterIds || [];
    if (!ids.includes(characterId)) return ch;
    return { ...ch, involvedCharacterIds: ids.filter((id) => id !== characterId) };
  });

  return { characters, chapters };
}

/** 按 id 覆盖更新一个角色（不存在则忽略），返回新的角色数组 */
export function updateCharacterInList(
  characters: Character[] | undefined,
  updated: Character
): Character[] {
  return (characters || []).map((c) => (c.id === updated.id ? updated : c));
}
