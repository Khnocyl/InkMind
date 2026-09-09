import type { BookProject, Character } from '../types/novel';

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
