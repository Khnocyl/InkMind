/**
 * 远记忆「相关章召回」top-K 回归守卫。
 *
 * 背景：召回上限曾在 TF-IDF 路径（recommendRelatedChapters 默认参 + 内部调用点显式 3）
 * 和 embedding 路径（slice(0, 3)）**三处**分别写死——只改一处会造成两路径静默分叉。
 * 现收敛到 semanticIndex.RELATED_CHAPTERS_TOP_K 单一来源。
 *
 * 本测试：① 值钉为 6；② 行为证明上限真的 >3；③ 源码扫描防三处再写死。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RELATED_CHAPTERS_TOP_K,
  recommendRelatedChapters,
} from '../src/services/semanticIndex';
import type { Chapter } from '../src/types/novel';

function ch(n: number, title: string, summary: string): Chapter {
  return {
    id: `c${n}`,
    number: n,
    title,
    summary,
    content: '',
    status: '正文草稿',
    lastModified: '',
    wordCount: summary.length,
  } as unknown as Chapter;
}

/** 章文档语料 = title+summary+recap（不含正文）。6 章含查询词 + 3 章干扰：全同词会 IDF 归零 */
function makeChapters(): Chapter[] {
  const scenes = [
    '演武场上他拔出断刃，赤霄剑的嗡鸣压过全场窃语，众人这才知剑有双生。',
    '矿脉深处灯油耗尽，唯有赤霄剑的微光照亮甬道，他在岩壁上摸到刻痕。',
    '比剑台第三招落空时，赤霄剑自行偏转寸许，护主之意藏都藏不住。',
    '拍卖行后巷雨气森冷，他用布裹紧赤霄剑，听见身后三道脚步同时停下。',
    '断崖古亭里他对着赤霄剑说了半句道歉，剑脊的裂纹又深了一分。',
    '雪夜山道尽头，赤霄剑骤然发烫，出鞘半寸便见林间伏兵寒光。',
    '他替老仆煎药至天明，炉火映着窗纸上往来的影子，谁也没提白日的旧事。',
    '渡口船资被抬了三倍，他付了钱登上乌篷船，橹声乃里小镇灯火渐远。',
    '藏书阁最底层积灰的卷宗里，他抄到半张没有落款的残图，墨色尚新。',
  ];
  return scenes.map((s, i) => ch(i + 1, `第${i + 1}章`, s));
}

describe('相关章召回 top-K · 单一来源', () => {
  it('常量值为 6（3→6 是长书召回第一杠杆，改动需显式决策）', () => {
    expect(RELATED_CHAPTERS_TOP_K).toBe(6);
  });

  it('行为：命中章多于 3 时按 6 截断（旧上限 3 会在此失败）', () => {
    const chapters = makeChapters();
    const hits = recommendRelatedChapters('赤霄剑', chapters, 99);
    expect(hits.length).toBe(RELATED_CHAPTERS_TOP_K);
    // 只收当前章之前的章
    expect(hits.every((h) => h.chapter.number < 99)).toBe(true);
  });

  it('显式传参仍可覆盖默认值（3 时行为不变）', () => {
    const chapters = makeChapters();
    expect(recommendRelatedChapters('赤霄剑', chapters, 99, 3).length).toBe(3);
  });
});

describe('防「top-K 又写死」· 源码扫描', () => {
  const read = (p: string) =>
    readFileSync(join(__dirname, '..', 'src', 'services', p), 'utf-8');

  it('embeddingIndex 不得再出现 slice(0, 3) 字面量', () => {
    expect(read('embeddingIndex.ts')).not.toMatch(/slice\(0,\s*3\)/);
  });

  it('semanticIndex 不得再出现 topK = 3 默认参或显式 , 3 调用参', () => {
    const src = read('semanticIndex.ts');
    expect(src).not.toMatch(/topK\s*=\s*3\b/);
    expect(src).not.toMatch(/chapterNumber \?\? 99999,\s*3\s*\)/);
  });
});
