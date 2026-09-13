import { describe, it, expect } from 'vitest';
import {
  parseCnNumber,
  splitChapters,
  createTemplateProject,
  normalizeDeconstructed,
  buildChapterDigests,
  buildRhythmStats,
  formatDeconstructReport,
  extractChapterLinks,
  extractMainText,
  extractPageTitle,
  clampSourceText,
  clampEmotion,
  emotionSparkline,
  resolveCharacterRelations,
  applyCharacterIdMapping,
  type SplitChapter,
} from '../src/services/bookDeconstruct';
import type { BookProject, Chapter } from '../src/types/novel';

describe('parseCnNumber 中文数字解析', () => {
  it('基础数字与阿拉伯数字', () => {
    expect(parseCnNumber('12')).toBe(12);
    expect(parseCnNumber('九')).toBe(9);
    expect(parseCnNumber('十')).toBe(10);
    expect(parseCnNumber('十二')).toBe(12);
    expect(parseCnNumber('二十一')).toBe(21);
  });

  it('带单位进位', () => {
    expect(parseCnNumber('一百零三')).toBe(103);
    expect(parseCnNumber('两千五百')).toBe(2500);
    expect(parseCnNumber('九千九百九十九')).toBe(9999);
    expect(parseCnNumber('两')).toBe(2);
  });
});

describe('splitChapters 切章', () => {
  it('「第N章」标题切分（含中文数字）', () => {
    const raw = [
      '第一章 初入宗门',
      '正文甲。'.repeat(50),
      '',
      '第十二章 山雨欲来',
      '正文乙。'.repeat(50),
    ].join('\n');
    const out = splitChapters(raw);
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe('第一章 初入宗门');
    expect(out[1].title).toBe('第十二章 山雨欲来');
    expect(out[0].charCount).toBeGreaterThan(0);
    expect(out[1].charCount).toBeGreaterThan(0);
  });

  it('「Chapter 3」形态切分', () => {
    const raw = 'Chapter 1\nAlpha text.\n\nChapter 2\nBeta text.';
    const out = splitChapters(raw);
    expect(out.map((s) => s.title)).toEqual(['Chapter 1', 'Chapter 2']);
  });

  it('卷标题归组到后续章节', () => {
    const raw = [
      '第一卷 风起',
      '第一章 开局',
      '内容一',
      '第二卷 云涌',
      '第二章 转折',
      '内容二',
    ].join('\n');
    const out = splitChapters(raw);
    expect(out).toHaveLength(2);
    expect(out[0].volumeTitle).toBe('风起');
    expect(out[1].volumeTitle).toBe('云涌');
  });

  it('无章标题的长文按段落兜底分块', () => {
    const para = '这是一段没有章节标题的正文，用来测试兜底分块逻辑。';
    const raw = Array.from({ length: 300 }, (_, i) => `${para}${i}`).join('\n\n');
    const out = splitChapters(raw);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0].title).toContain('片段');
  });

  it('正文中的「1、」列表不误切（未出现正式章标题时）', () => {
    const raw = '他说：\n1、先去东方\n2、再去北方\n3、最后回家。'.repeat(20);
    const out = splitChapters(raw);
    expect(out).toHaveLength(1);
  });
});

describe('createTemplateProject 模板书组装', () => {
  const splits: SplitChapter[] = [
    { title: '第一章 起', content: '内容一'.repeat(100), volumeTitle: '卷一', charCount: 300 },
    { title: '第二章 承', content: '内容二'.repeat(100), volumeTitle: '卷一', charCount: 300 },
    { title: '第三章 转', content: '内容三'.repeat(100), volumeTitle: '卷二', charCount: 300 },
  ];

  it('章节锁定为精修定稿、编号连续、携带拆书元信息', () => {
    const p = createTemplateProject({ splits, source: 'file', sourceName: '书.txt' });
    expect(p.chapters).toHaveLength(3);
    expect(p.chapters.map((c) => c.number)).toEqual([1, 2, 3]);
    expect(p.chapters.every((c) => c.locked === true)).toBe(true);
    expect(p.chapters.every((c) => c.status === '精修定稿')).toBe(true);
    expect(p.deconstructMeta?.source).toBe('file');
    expect(p.deconstructMeta?.sourceName).toBe('书.txt');
    expect(p.styleConfig).toBeDefined();
  });

  it('卷结构按切章卷标题生成，start/end 章号正确', () => {
    const p = createTemplateProject({ splits, source: 'file', sourceName: '书.txt' });
    expect(p.volumes).toHaveLength(2);
    expect(p.volumes[0]).toMatchObject({ number: 1, startChapter: 1, endChapter: 2 });
    expect(p.volumes[1]).toMatchObject({ number: 2, startChapter: 3, endChapter: 3 });
    expect(p.chapters[2].volumeId).toBe(p.volumes[1].id);
  });

  it('无卷结构的书归入「正文」一卷', () => {
    const p = createTemplateProject({
      splits: splits.map((s) => ({ ...s, volumeTitle: undefined })),
      source: 'file',
      sourceName: '书.txt',
    });
    expect(p.volumes).toHaveLength(1);
    expect(p.volumes[0].title).toBe('正文');
    expect(p.volumes[0].endChapter).toBe(3);
  });

  it('卷标题乱序重复出现（1→2→1）→ 复用已建卷，不产生重复 id', () => {
    const p = createTemplateProject({
      splits: [
        { title: '第1章', content: 'a'.repeat(100), volumeTitle: '第一卷', charCount: 100 },
        { title: '第2章', content: 'b'.repeat(100), volumeTitle: '第二卷', charCount: 100 },
        { title: '第3章', content: 'c'.repeat(100), volumeTitle: '第一卷', charCount: 100 },
      ],
      source: 'file',
      sourceName: '书.txt',
    });
    // 此前用 indexOf 与当前卷号比较后无条件 push，会建出两个 id 相同的「第一卷」
    const ids = p.volumes.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(p.volumes).toHaveLength(2);
    // 第一卷跨到第 3 章
    expect(p.volumes[0]).toMatchObject({ title: '第一卷', startChapter: 1, endChapter: 3 });
    // 第 3 章回到第一卷
    expect(p.chapters[2].volumeId).toBe(p.volumes[0].id);
  });
});

describe('normalizeDeconstructed 防御性归一', () => {
  it('合法输入完整转换，beats 补 id 与 order', () => {
    const n = normalizeDeconstructed({
      summary: '本章讲了些事',
      beats: [{ order: 2, description: 'b' }, { description: 'a' }],
      characterNames: ['张三', '', '李四'],
      hookStrength: 8,
      newSettings: '不是数组',
    });
    expect(n).not.toBeNull();
    expect(n!.summary).toBe('本章讲了些事');
    expect(n!.beats).toHaveLength(2);
    expect(n!.beats[0].order).toBe(2);
    expect(n!.beats[1].order).toBe(2); // 缺 order 时按下标补
    expect(n!.characterNames).toEqual(['张三', '李四']);
    expect(n!.newSettings).toEqual([]);
    expect(n!.hookStrength).toBe(8);
  });

  it('缺 summary → null（不产出无效拆解）', () => {
    expect(normalizeDeconstructed({ beats: [] })).toBeNull();
    expect(normalizeDeconstructed(null)).toBeNull();
    expect(normalizeDeconstructed('x')).toBeNull();
  });

  it('hookStrength 越界收敛到 0-10', () => {
    expect(normalizeDeconstructed({ summary: 's', beats: [{ description: 'd' }], hookStrength: 99 })!.hookStrength).toBe(10);
    expect(normalizeDeconstructed({ summary: 's', beats: [{ description: 'd' }], hookStrength: -3 })!.hookStrength).toBe(0);
  });

  it('emotion 收敛到 -9~+9，非法值不虚构', () => {
    expect(normalizeDeconstructed({ summary: 's', beats: [{ description: 'd' }], emotion: 12 })!.emotion).toBe(9);
    expect(normalizeDeconstructed({ summary: 's', beats: [{ description: 'd' }], emotion: -99 })!.emotion).toBe(-9);
    expect(normalizeDeconstructed({ summary: 's', beats: [{ description: 'd' }], emotion: 7.4 })!.emotion).toBe(7);
    expect(normalizeDeconstructed({ summary: 's', beats: [{ description: 'd' }], emotion: 'high' })!.emotion).toBeUndefined();
    expect(normalizeDeconstructed({ summary: 's', beats: [{ description: 'd' }] })!.emotion).toBeUndefined();
  });
});

describe('情绪曲线与角色关系', () => {
  it('clampEmotion 边界', () => {
    expect(clampEmotion(9)).toBe(9);
    expect(clampEmotion(-9.6)).toBe(-9);
    expect(clampEmotion(NaN)).toBeUndefined();
  });

  it('emotionSparkline：-9 与 +9 落在方块两端', () => {
    const s = emotionSparkline([{ emotion: -9 }, { emotion: 0 }, { emotion: 9 }]);
    expect(s).toBe('▁▅█');
  });

  it('resolveCharacterRelations 按名字解析 targetId，未知名/自指/重复跳过，intimacy 收敛', () => {
    const characters = [
      { id: 'c1', name: '张三', relations: [] },
      { id: 'c2', name: '李四', relations: [] },
    ] as unknown as import('../src/types/novel').Character[];
    resolveCharacterRelations(characters, [
      {
        name: '张三',
        relations: [
          { name: '李四', relation: '师徒', intimacy: 60 },
          { name: '路人甲', relation: '未知对象' },
          { name: '张三', relation: '自己' },
          { name: '李四', relation: '重复' },
          { name: '王五', relation: '列表外对象' },
        ],
      },
      { name: '不在列表里的人', relations: [{ name: '张三', relation: '幻觉' }] },
    ]);
    expect(characters[0].relations).toEqual([{ targetId: 'c2', relation: '师徒', intimacy: 60 }]);
    expect(characters[1].relations).toEqual([]);
  });

  it('buildRhythmStats 聚合情绪序列/均值/峰谷', () => {
    const chapters = [1, 2, 3].map((n) => ({
      number: n,
      wordCount: 2000,
      content: '',
      deconstruct: { emotion: [-3, 7, -5][n - 1] },
    })) as unknown as Chapter[];
    const s = buildRhythmStats(chapters);
    expect(s.emotionSeries).toEqual([
      { chapterNumber: 1, emotion: -3 },
      { chapterNumber: 2, emotion: 7 },
      { chapterNumber: 3, emotion: -5 },
    ]);
    expect(s.avgEmotion).toBe(-0.3);
    expect(s.emotionPeak).toEqual({ chapterNumber: 2, emotion: 7 });
    expect(s.emotionTrough).toEqual({ chapterNumber: 3, emotion: -5 });
  });

  it('formatDeconstructReport 含情绪列、峰值行与关系行', () => {
    const project = {
      title: '测试书',
      genre: '东方玄幻',
      chapters: [
        { number: 1, wordCount: 2000, content: '', summary: '开局', deconstruct: { hookStrength: 6, hookType: '悬念', payoffType: '无' } },
      ],
      characters: [
        { id: 'c1', name: '张三', role: '主角', realmOrTitle: '炼气', personality: '坚韧', relations: [{ targetId: 'c2', relation: '师徒', intimacy: 60 }] },
        { id: 'c2', name: '李四', role: '重要配角', personality: '沉稳', relations: [] },
      ],
      settings: [],
      deconstructMeta: { source: 'file', sourceName: '书.txt', importedAt: '2026-09-13T00:00:00.000Z' },
    } as unknown as BookProject;
    const report = formatDeconstructReport(project);
    expect(report).toContain('| 章 | 字数 | 钩子 | 爽点 | 情绪 | 梗概 |');
    expect(report).toContain('| 1 | 2000 | 悬念·6 | 无 | — |');
    expect(report).toContain('｜ 关系：李四（师徒）');
  });

  it('formatDeconstructReport 情绪全量时输出走向与曲线', () => {
    const project = {
      title: '测试书',
      genre: '东方玄幻',
      chapters: [
        { number: 1, wordCount: 2000, content: '', summary: 'a', deconstruct: { emotion: -3 } },
        { number: 2, wordCount: 2000, content: '', summary: 'b', deconstruct: { emotion: 7 } },
      ],
      characters: [],
      settings: [],
      deconstructMeta: { source: 'file', sourceName: '书.txt', importedAt: '2026-09-13T00:00:00.000Z' },
    } as unknown as BookProject;
    const report = formatDeconstructReport(project);
    expect(report).toContain('均值 +2 · 峰值 第2章（+7） · 低谷 第1章（-3）');
    expect(report).toContain('情绪曲线：');
  });
});

describe('综合与回填', () => {
  it('buildChapterDigests 生成「章号｜梗概｜人物｜设定」行', () => {
    const chapters = [
      { number: 1, summary: '开局', deconstruct: { characterNames: ['张三'], newSettings: ['灵根'] } },
      { number: 2, summary: '冲突' },
    ] as unknown as Chapter[];
    const lines = buildChapterDigests(chapters);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('1｜开局｜张三｜灵根');
    expect(lines[1]).toBe('2｜冲突｜—｜—');
  });

  it('applyCharacterIdMapping 把人物名映射为角色 id', () => {
    const project = {
      characters: [
        { id: 'c1', name: '张三' },
        { id: 'c2', name: '李四' },
      ],
      chapters: [
        { number: 1, involvedCharacterIds: [], deconstruct: { characterNames: ['张三', '王五'] } },
        { number: 2, involvedCharacterIds: [], deconstruct: { characterNames: [] } },
      ],
    } as unknown as BookProject;
    applyCharacterIdMapping(project);
    expect(project.chapters[0].involvedCharacterIds).toEqual(['c1']);
    expect(project.chapters[1].involvedCharacterIds).toEqual([]);
  });
});

describe('节奏统计与报告', () => {
  const chapters = [1, 2, 3, 4, 5].map((n) => ({
    number: n,
    wordCount: 2000 + n,
    content: '',
    deconstruct: {
      hookStrength: n,
      hookType: '悬念',
      payoffType: n % 2 === 0 ? '打脸' : '无',
    },
  })) as unknown as Chapter[];

  it('buildRhythmStats 聚合均值与爽点间隔', () => {
    const s = buildRhythmStats(chapters);
    expect(s.deconstructedCount).toBe(5);
    expect(s.avgWords).toBe(2003);
    expect(s.avgHook).toBe(3);
    expect(s.payoffGaps).toEqual([2]);
  });

  it('formatDeconstructReport 输出含统计与逐章表', () => {
    const project = {
      title: '测试书',
      genre: '东方玄幻',
      chapters,
      characters: [{ name: '张三', role: '主角', realmOrTitle: '炼气', personality: '坚韧' }],
      settings: [{ name: '灵根', category: '力量与境界体系', description: '修炼资质' }],
      deconstructMeta: { source: 'file', sourceName: '书.txt', importedAt: '2026-09-12T00:00:00.000Z' },
    } as unknown as BookProject;
    const report = formatDeconstructReport(project);
    expect(report).toContain('# 拆书报告：测试书');
    expect(report).toContain('平均 2003 字/章');
    expect(report).toContain('平均每 2 章一个爽点');
    expect(report).toContain('| 1 | 2001 |');
    expect(report).toContain('**张三**（主角）');
    expect(report).toContain('**灵根**（力量与境界体系）');
    expect(report).toContain('仅限个人学习分析使用');
  });

  it('梗概含竖线/换行时转义，不撑破 Markdown 表格', () => {
    const project = {
      title: '测试书',
      genre: '东方玄幻',
      chapters: [
        {
          number: 1,
          wordCount: 100,
          summary: '前半 | 后半\n换行了',
          deconstruct: { hookType: '悬念', hookStrength: 7, payoffType: '打脸' },
        },
      ],
      characters: [],
      settings: [],
      deconstructMeta: { source: 'file', sourceName: '书.txt', importedAt: '2026-09-12T00:00:00.000Z' },
    } as unknown as BookProject;
    const report = formatDeconstructReport(project);
    const row = report.split('\n').find((l) => l.startsWith('| 1 |'));
    expect(row).toBeDefined();
    expect(row).toContain('前半 \\| 后半 换行了');
    // 未转义的话这行会被拆成 7 列。先剔除转义竖线再数分隔符，应为 6 列 = 7 个分隔符。
    const unescaped = row!.replace(/\\\|/g, '');
    expect((unescaped.match(/\|/g) || []).length).toBe(7);
  });
});

describe('URL 抓取辅助（站点无关）', () => {
  it('extractChapterLinks 只认「第N章/Chapter N」链接并解析相对地址', () => {
    const html = `
      <a href="/1.html">第一章 起步</a>
      <a href="https://x.com/2.html">第2章 冲突</a>
      <a href="/other.html">随便逛逛</a>
      <a href="javascript:void(0)">第3章 假链接</a>
      <a href="/1.html">第一章 起步</a>
    `;
    const out = extractChapterLinks(html, 'https://example.com/toc/');
    // 相对路径按目录页解析；绝对 URL 原样保留
    expect(out.map((l) => l.url)).toEqual([
      'https://example.com/1.html',
      'https://x.com/2.html',
    ]);
    expect(out[0].title).toBe('第一章 起步');
  });

  it('extractMainText 去 script/style/标签并解码实体', () => {
    const html = [
      '<html><head><style>.a{}</style><script>evil()</script></head><body>',
      '<div>第一段&amp;内容</div><div>第二段&lt;X&gt;</div>',
      '</body></html>',
    ].join('');
    const text = extractMainText(html);
    expect(text).toContain('第一段&内容');
    expect(text).toContain('第二段<X>');
    expect(text).not.toContain('evil');
    expect(text).not.toContain('.a{}');
    expect(text).not.toContain('<div');
    expect(text).not.toContain('<script');
  });

  it('extractPageTitle 取 <title> 并清洗标签与实体', () => {
    expect(
      extractPageTitle('<html><head><title>第一章 起步_某某小说网</title></head></html>')
    ).toBe('第一章 起步_某某小说网');
    expect(extractPageTitle('<title>A &amp; B</title>')).toBe('A & B');
    expect(extractPageTitle('<title><b>粗体书名</b></title>')).toBe('粗体书名');
    expect(extractPageTitle('<html><head></head></html>')).toBe('');
  });

  it('clampSourceText 超长截断保留头尾', () => {
    const long = 'a'.repeat(100) + '中段内容' + 'b'.repeat(10000);
    const clamped = clampSourceText(long);
    expect(clamped.length).toBeLessThan(long.length);
    expect(clamped).toContain('中段内容');
    expect(clamped).toContain('（中段略）');
    expect(clampSourceText('短文本')).toBe('短文本');
  });
});
