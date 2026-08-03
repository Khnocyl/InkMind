import { describe, expect, it } from 'vitest';
import { buildConservativeProse } from '../src/services/conservativeProse';
import type { Character, PlotBeat, WorldSetting } from '../src/types/novel';

const characters: Character[] = [
  {
    id: 'c1',
    name: '叶无痕',
    role: '主角',
    description: '冷峻刀客',
    status: '活跃',
  },
  {
    id: 'c2',
    name: '苏清雪',
    role: '女主',
    description: '剑客',
    status: '活跃',
  },
];

const settings: WorldSetting[] = [
  {
    id: 's1',
    name: '断魂谷',
    description: '凶险峡谷',
    category: '地点',
  },
  {
    id: 's2',
    name: '封天阵',
    description: '上古法阵',
    category: '规则',
  },
];

const beats: PlotBeat[] = [
  { id: 'b1', description: '叶无痕追入断魂谷，发现封天阵异动' },
  { id: 'b2', description: '苏清雪现身，两人对峙后联手' },
  { id: 'b3', description: '阵眼开启，强敌现身' },
];

describe('conservativeProse · buildConservativeProse', () => {
  it('非空且字数合理（≥300）', () => {
    const r = buildConservativeProse({ beats, characters, settings });
    expect(r.prose.length).toBeGreaterThan(0);
    expect(r.wordCount).toBeGreaterThanOrEqual(300);
    expect(r.wordCount).toBeLessThanOrEqual(1200);
  });

  it('包含每个 beat 描述的关键片段', () => {
    const r = buildConservativeProse({ beats, characters, settings });
    for (const b of beats) {
      const key = (b.description || '').slice(0, 8);
      expect(r.prose).toContain(key);
    }
  });

  it('包含角色名与设定名', () => {
    const r = buildConservativeProse({ beats, characters, settings });
    expect(r.prose).toContain('叶无痕');
    expect(r.prose).toContain('苏清雪');
    expect(r.prose).toContain('断魂谷');
    expect(r.prose).toContain('封天阵');
  });

  it('确定性：同输入 → 同输出', () => {
    const input = { beats, characters, settings };
    const a = buildConservativeProse(input);
    const b = buildConservativeProse(input);
    expect(a.prose).toBe(b.prose);
  });

  it('空 beats → 仍有兜底段落且非空', () => {
    const r = buildConservativeProse({ beats: [], characters, settings });
    expect(r.wordCount).toBeGreaterThanOrEqual(30);
    expect(r.reason).toContain('本地保守稿');
  });

  it('previousContext 尾部进入开篇过渡句', () => {
    const r = buildConservativeProse({
      beats,
      characters,
      settings,
      previousContext: '前文尾段：他推开了那扇锈蚀的铁门，走进了漫长的黑暗。',
    });
    expect(r.prose).toContain('铁门');
  });

  it('章节 summary 进入结尾收束句', () => {
    const r = buildConservativeProse({
      beats,
      characters,
      settings,
      chapter: { number: 3, title: '风起断魂', summary: '本章揭示封天阵的真相并埋下反派的伏笔' },
    });
    expect(r.prose).toContain('封天阵');
  });
});
