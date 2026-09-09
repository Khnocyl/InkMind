import { describe, expect, it } from 'vitest';
import {
  normalizeCharacters,
  removeCharacterFromProject,
  updateCharacterInList,
} from '../src/services/characterOps';
import type { BookProject, Character } from '../src/types/novel';

function char(id: string, relations: Character['relations'] = []): Character {
  return {
    id,
    name: `角色${id}`,
    alias: '',
    role: '重要配角',
    status: '活跃',
    realmOrTitle: '',
    currentLocation: '',
    personality: '',
    appearance: '',
    background: '',
    secretNotes: '',
    relations,
  } as Character;
}

function project(overrides?: Partial<BookProject>): Pick<BookProject, 'characters' | 'chapters'> {
  return {
    characters: [
      char('a', [{ targetId: 'b', relation: '宿敌', intimacy: -80 }]),
      char('b', [{ targetId: 'a', relation: '师门', intimacy: 60 }]),
      char('c'),
    ],
    chapters: [
      { id: 'ch1', involvedCharacterIds: ['a', 'c'] },
      { id: 'ch2', involvedCharacterIds: ['b'] },
    ],
    ...overrides,
  } as Pick<BookProject, 'characters' | 'chapters'>;
}

describe('normalizeCharacters · 补齐 AI 缺字段（回归 .map 崩溃）', () => {
  it('缺 relations 的角色 → 补成空数组（否则角色图谱渲染崩溃）', () => {
    const out = normalizeCharacters([{ id: 'c1', name: '叶无痕' }]);
    expect(out).toHaveLength(1);
    expect(out[0].relations).toEqual([]);
    expect(out[0].role).toBe('重要配角');
    expect(out[0].status).toBe('活跃');
    expect(out[0].personality).toBe('');
  });

  it('保留已有 relations 与字段', () => {
    const out = normalizeCharacters([
      {
        id: 'c1',
        name: '甲',
        role: '主角',
        relations: [{ targetId: 'c2', relation: '宿敌', intimacy: -50 }],
      },
    ]);
    expect(out[0].role).toBe('主角');
    expect(out[0].relations).toHaveLength(1);
  });

  it('缺 id / name → 生成占位，不产生 undefined', () => {
    const out = normalizeCharacters([{ personality: 'x' }]);
    expect(out[0].id).toBeTruthy();
    expect(out[0].name).toBeTruthy();
  });

  it('非数组 / 非对象条目 → 安全过滤', () => {
    expect(normalizeCharacters(undefined)).toEqual([]);
    expect(normalizeCharacters('nope')).toEqual([]);
    expect(normalizeCharacters([null, 42, { id: 'ok' }])).toHaveLength(1);
  });
});

describe('removeCharacterFromProject · 级联清理', () => {
  it('删除角色本身 + 章节引用 + 其他角色指向它的关系', () => {
    const p = project();
    const out = removeCharacterFromProject(p, 'a');
    expect(out.characters.map((c) => c.id)).toEqual(['b', 'c']);
    // b 指向 a 的关系被清掉，b 本身保留
    expect(out.characters.find((c) => c.id === 'b')?.relations).toEqual([]);
    // ch1 不再包含 a，但仍保留 c
    expect(out.chapters.find((c) => c.id === 'ch1')?.involvedCharacterIds).toEqual(['c']);
    // 未被引用的章节原样返回（引用相等，避免无意义重渲染）
    expect(out.chapters.find((c) => c.id === 'ch2')).toBe(p.chapters![1]);
  });

  it('删除不存在的 id 不改变数据', () => {
    const p = project();
    const out = removeCharacterFromProject(p, 'nope');
    expect(out.characters).toEqual(p.characters);
    expect(out.chapters).toEqual(p.chapters);
  });

  it('缺字段（旧数据无 relations/involvedCharacterIds）不抛错', () => {
    const p = {
      characters: [{ ...char('a'), relations: undefined } as unknown as Character],
      chapters: [{ id: 'ch1' } as never],
    };
    const out = removeCharacterFromProject(p, 'a');
    expect(out.characters).toHaveLength(0);
    expect(out.chapters).toHaveLength(1);
  });
});

describe('updateCharacterInList', () => {
  it('按 id 覆盖，不新增不丢序', () => {
    const list = [char('a'), char('b')];
    const out = updateCharacterInList(list, { ...char('b'), name: '改名' });
    expect(out.map((c) => c.id)).toEqual(['a', 'b']);
    expect(out[1].name).toBe('改名');
  });

  it('undefined 安全', () => {
    expect(updateCharacterInList(undefined, char('a'))).toEqual([]);
  });
});
