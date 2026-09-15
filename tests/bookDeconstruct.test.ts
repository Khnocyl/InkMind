import { describe, it, expect, afterEach, vi } from 'vitest';
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
  stripSiteChrome,
  isSiteChromeLine,
  assessDeconstructInput,
  deconstructChapterLLM,
  chapterNumberFromTitle,
  sortByTitleChapterNumber,
  extractTocPageUrls,
  deriveChapterPageUrls,
  analyzeChapterPagination,
  extractChapterLinksLoose,
  mergeChapterLinks,
  clampEmotion,
  emotionSparkline,
  emotionCurve,
  EMOTION_GAP_CHAR,
  EMOTION_CURVE_MAX_CHARS,
  DECONSTRUCT_SCHEMA_VERSION,
  isDeconstructComplete,
  countPendingDeconstruct,
  normalizeChapterDeconstruct,
  resolveCharacterRelations,
  applyCharacterIdMapping,
  type SplitChapter,
} from '../src/services/bookDeconstruct';
import type { BookProject, Chapter } from '../src/types/novel';
import { parseDeconstructReport } from '../src/services/deconstructReport';

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
    // 空值必须也是 undefined：Number(null)/Number('')/Number([]) 都等于 0，
    // 若不先排掉会被写成「0 = 平稳推进」，等于凭空造出中性值。
    expect(normalizeDeconstructed({ summary: 's', beats: [{ description: 'd' }], emotion: null })!.emotion).toBeUndefined();
    expect(normalizeDeconstructed({ summary: 's', beats: [{ description: 'd' }], emotion: '' })!.emotion).toBeUndefined();
    expect(normalizeDeconstructed({ summary: 's', beats: [{ description: 'd' }], emotion: '  ' })!.emotion).toBeUndefined();
    expect(normalizeDeconstructed({ summary: 's', beats: [{ description: 'd' }], emotion: false })!.emotion).toBeUndefined();
    expect(normalizeDeconstructed({ summary: 's', beats: [{ description: 'd' }], emotion: [] })!.emotion).toBeUndefined();
    // 合法数值字符串仍照常收
    expect(normalizeDeconstructed({ summary: 's', beats: [{ description: 'd' }], emotion: '7' })!.emotion).toBe(7);
  });

  it('normalizeDeconstructed 打上字段版本号（断点续跑据此识别待补齐）', () => {
    const n = normalizeDeconstructed({ summary: 's', beats: [{ description: 'd' }] })!;
    expect(n.v).toBe(DECONSTRUCT_SCHEMA_VERSION);
    expect(isDeconstructComplete(n)).toBe(true);
  });
});

describe('情绪曲线与角色关系', () => {
  it('clampEmotion 边界', () => {
    expect(clampEmotion(9)).toBe(9);
    expect(clampEmotion(-9.6)).toBe(-9);
    expect(clampEmotion(NaN)).toBeUndefined();
    // 空值一律 undefined（不能落成 0，否则「没数据」被画成「平稳」）
    expect(clampEmotion(null)).toBeUndefined();
    expect(clampEmotion(undefined)).toBeUndefined();
    expect(clampEmotion('')).toBeUndefined();
    expect(clampEmotion('   ')).toBeUndefined();
    expect(clampEmotion(false)).toBeUndefined();
    expect(clampEmotion([])).toBeUndefined();
  });

  it('emotionSparkline：-9 与 +9 落在曲线两端（纯 ASCII，不依赖方块字形）', () => {
    const s = emotionSparkline([{ emotion: -9 }, { emotion: 0 }, { emotion: 9 }]);
    expect(s).toBe('.*@');
    // 全线只用 ASCII：等宽字体里不会渲染成豆腐块
    expect([...s].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
  });

  it('emotionSparkline：缺数据的章用占位符，保持章序对齐（不把洞抹掉）', () => {
    const s = emotionSparkline([{ emotion: 9 }, { emotion: null }, { emotion: -9 }]);
    expect(s).toBe(`@${EMOTION_GAP_CHAR}.`);
    expect(s).toHaveLength(3);
  });

  it('emotionCurve：短书逐章、长书按段降采样（长度≤上限、段内取有值均值）', () => {
    const short = emotionCurve([{ emotion: 1 }, { emotion: 2 }]);
    expect(short.bucketSize).toBe(1);
    expect(short.text).toHaveLength(2);

    // 300 章 → 每 3 章一段 → ≤120 字符（此前 >60 章干脆不画曲线）
    const long = Array.from({ length: 300 }, (_, i) => ({
      emotion: i % 3 === 0 ? 9 : i % 3 === 1 ? -9 : null,
    }));
    const { text, bucketSize } = emotionCurve(long);
    expect(bucketSize).toBe(3);
    expect(text.length).toBeLessThanOrEqual(EMOTION_CURVE_MAX_CHARS);
    // 首段 = (-9~+9, 缺) 的有值均值 = 0 → 中间档
    expect(text[0]).toBe('*');
    // 末段（第 298/299/300 章）：i=297→9, 298→-9, 299→null → 均值 0
    expect(text[text.length - 1]).toBe('*');

    // 整段都缺数据 → 画占位符，而不是 0（平稳）
    const allGap = emotionCurve(
      Array.from({ length: 300 }, () => ({ emotion: null as number | null }))
    );
    expect(allGap.text).toBe(EMOTION_GAP_CHAR.repeat(allGap.text.length));
    expect(allGap.text.length).toBeLessThanOrEqual(EMOTION_CURVE_MAX_CHARS);
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
    expect(s.emotionCoveredCount).toBe(3);
    expect(s.avgEmotion).toBe(-0.3);
    expect(s.emotionPeak).toEqual({ chapterNumber: 2, emotion: 7 });
    expect(s.emotionTrough).toEqual({ chapterNumber: 3, emotion: -5 });
  });

  it('buildRhythmStats：缺情绪的章以 null 占位，均值/峰谷只在有值章上算', () => {
    const chapters = [
      { number: 1, wordCount: 2000, content: '', deconstruct: { emotion: 8 } },
      { number: 2, wordCount: 2000, content: '', deconstruct: {} },
    ] as unknown as Chapter[];
    const s = buildRhythmStats(chapters);
    // 缺值章留在序列里（不然曲线中间有洞却看着连续），但不参与统计
    expect(s.emotionSeries).toEqual([
      { chapterNumber: 1, emotion: 8 },
      { chapterNumber: 2, emotion: null },
    ]);
    expect(s.emotionCoveredCount).toBe(1);
    expect(s.avgEmotion).toBe(8);
    expect(s.emotionPeak).toEqual({ chapterNumber: 1, emotion: 8 });
    expect(s.emotionTrough).toEqual({ chapterNumber: 1, emotion: 8 });
  });

  it('buildRhythmStats：**未拆解**的章同样占位（断点续跑留的缺口不被抹掉）', () => {
    const chapters = [
      { number: 1, wordCount: 2000, content: '', deconstruct: { emotion: 6 } },
      { number: 2, wordCount: 2000, content: '' }, // 未拆解（停止/失败留下的缺口）
      { number: 3, wordCount: 2000, content: '', deconstruct: { emotion: -4 } },
    ] as unknown as Chapter[];
    const s = buildRhythmStats(chapters);
    expect(s.emotionSeries).toEqual([
      { chapterNumber: 1, emotion: 6 },
      { chapterNumber: 2, emotion: null },
      { chapterNumber: 3, emotion: -4 },
    ]);
    expect(s.emotionCoveredCount).toBe(2);
    // 「已拆解 N 章」口径不受影响（仍只数真有拆解数据的章）
    expect(s.deconstructedCount).toBe(2);
    expect(s.avgEmotion).toBe(1);
  });

  it('formatDeconstructReport：部分拆解时覆盖率以**总章数**为分母、曲线保留缺口', () => {
    const chapters = [
      { number: 1, wordCount: 2000, content: '', summary: 'a', deconstruct: { emotion: 6 } },
      { number: 2, wordCount: 2000, content: '', summary: 'b', deconstruct: { emotion: -4 } },
      { number: 3, wordCount: 2000, content: '', summary: 'c' },
    ];
    const project = {
      title: '测试书',
      genre: '东方玄幻',
      chapters,
      characters: [],
      settings: [],
      deconstructMeta: { source: 'file', sourceName: '书.txt', importedAt: '2026-09-13T00:00:00.000Z' },
    } as unknown as BookProject;
    const report = formatDeconstructReport(project);
    // 3 章里只有 2 章有情绪值：分母必须是总章数，否则「部分拆解」会被当成整本结论
    expect(report).toContain('（2/3 章有情绪值）');
    const curveLine = report.split('\n').find((l) => l.startsWith('- 情绪曲线'))!;
    const text = curveLine.slice(curveLine.indexOf('：') + 1);
    expect(text).toHaveLength(3);
    expect(text[2]).toBe(EMOTION_GAP_CHAR);
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
    expect(report).toContain('；关系：李四（师徒）');
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
    expect(report).toContain('情绪曲线（左→右为章序，.=-9 @=+9）：');
    // 全量覆盖时不标注样本量/占位符（只有部分覆盖才需要）
    expect(report).not.toContain('章有情绪值');
    expect(report).not.toContain('=无情绪数据');
    // 报告要能被等宽字体原样渲染：不含方块/条块字符这类易缺字形的符号
    expect(/[\u2580-\u259f]/.test(report)).toBe(false);
  });

  it('formatDeconstructReport 部分章缺情绪时标注覆盖率与占位符', () => {
    const chapters = [
      { number: 1, wordCount: 2000, content: '', summary: 'a', deconstruct: { emotion: 6 } },
      { number: 2, wordCount: 2000, content: '', summary: 'b', deconstruct: {} },
    ];
    const project = {
      title: '测试书',
      genre: '东方玄幻',
      chapters,
      characters: [],
      settings: [],
      deconstructMeta: { source: 'file', sourceName: '书.txt', importedAt: '2026-09-13T00:00:00.000Z' },
    } as unknown as BookProject;
    const report = formatDeconstructReport(project);
    // 均值只说「有值的那 1 章」，必须标样本量，否则会被当成整本书的结论
    expect(report).toContain('（1/2 章有情绪值）');
    expect(report).toContain(`${EMOTION_GAP_CHAR}=无情绪数据`);
    const curveLine = report.split('\n').find((l) => l.startsWith('- 情绪曲线'))!;
    const text = curveLine.slice(curveLine.indexOf('：') + 1);
    // 两个章序位置都在（缺值章画占位符），而不是把洞抹掉变成 1 个字符
    expect(text).toHaveLength(2);
    expect(text[1]).toBe(EMOTION_GAP_CHAR);
    expect(text[0]).not.toBe(EMOTION_GAP_CHAR);
  });

  it('书名/字段里的换行不会把报告版面撑破', () => {
    const project = {
      title: '测试\n书',
      genre: '东方\n玄幻',
      chapters: [
        {
          number: 1,
          wordCount: 100,
          content: '',
          summary: 's',
          deconstruct: { hookType: '悬念', hookStrength: 1, payoffType: '无' },
        },
      ],
      characters: [
        { id: 'c1', name: '张三\n李四', role: '主角', personality: '坚韧\n果断', relations: [] },
      ],
      settings: [],
      deconstructMeta: { source: 'file', sourceName: '书\n.txt', importedAt: '2026-09-13T00:00:00.000Z' },
    } as unknown as BookProject;
    const report = formatDeconstructReport(project);
    expect(report.split('\n')[0]).toBe('# 拆书报告：测试 书');
    expect(report).toContain('题材判断：东方 玄幻');
    expect(report).toContain('**张三 李四**（主角）：坚韧 果断');
  });

  it('formatDeconstructReport 长书曲线降采样并标注段长', () => {    const chapters = Array.from({ length: 300 }, (_, i) => ({
      number: i + 1,
      wordCount: 2000,
      content: '',
      summary: 's',
      deconstruct: { emotion: i % 2 === 0 ? 9 : -9 },
    }));
    const project = {
      title: '测试书',
      genre: '东方玄幻',
      chapters,
      characters: [],
      settings: [],
      deconstructMeta: { source: 'file', sourceName: '书.txt', importedAt: '2026-09-13T00:00:00.000Z' },
    } as unknown as BookProject;
    const report = formatDeconstructReport(project);
    expect(report).toContain('每 3 章取均值');
    const curveLine = report.split('\n').find((l) => l.startsWith('- 情绪曲线'));
    expect(curveLine).toBeDefined();
    expect(curveLine!.length).toBeLessThan(EMOTION_CURVE_MAX_CHARS + 60);
  });
});

describe('拆解字段版本与补齐', () => {
  it('isDeconstructComplete：无 v 的旧数据判为不完整，当前版本判为完整', () => {
    expect(isDeconstructComplete(undefined)).toBe(false);
    // 缺 v = 本次新增 emotion 之前的版本（1）
    expect(isDeconstructComplete({ hookType: '悬念' })).toBe(false);
    expect(isDeconstructComplete({ v: 1 })).toBe(false);
    expect(isDeconstructComplete({ v: DECONSTRUCT_SCHEMA_VERSION })).toBe(true);
  });

  it('countPendingDeconstruct：从未拆的章与旧版章都算待补齐', () => {
    const chapters = [
      { number: 1, deconstruct: { v: DECONSTRUCT_SCHEMA_VERSION } },
      { number: 2, deconstruct: { hookType: '悬念' } },
      { number: 3 },
    ] as unknown as Chapter[];
    expect(countPendingDeconstruct(chapters)).toBe(2);
    expect(countPendingDeconstruct([])).toBe(0);
  });

  it('normalizeChapterDeconstruct：导入侧透传并收敛（不信任外部 JSON）', () => {
    const d = normalizeChapterDeconstruct({
      hookType: '悬念',
      hookStrength: 99,
      payoffType: '打脸',
      emotion: 42,
      foreshadowPlant: ['伏笔'],
      characterNames: ['张三', '', '李四'],
      analyzedAt: '2026-09-13T00:00:00.000Z',
      v: 2,
    })!;
    expect(d.hookStrength).toBe(10);
    expect(d.emotion).toBe(9);
    expect(d.characterNames).toEqual(['张三', '李四']);
    expect(d.v).toBe(2);
    // 空值不凭空造中性值
    expect(normalizeChapterDeconstruct({ emotion: null, hookType: '悬念' })!.emotion).toBeUndefined();
  });

  it('normalizeChapterDeconstruct：空对象/非对象 → undefined（不留「有拆解但全空」）', () => {
    expect(normalizeChapterDeconstruct({})).toBeUndefined();
    expect(normalizeChapterDeconstruct({ v: 2 })).toBeUndefined();
    expect(normalizeChapterDeconstruct('x')).toBeUndefined();
    expect(normalizeChapterDeconstruct(null)).toBeUndefined();
  });
});

describe('站点导航/页脚清洗', () => {
  it('清掉导航行、分页、版权声明、网站地图（用户报的那种）', () => {
    const raw = [
      '第一章 开局',
      '张三推门进来，屋里的人都在等他。',
      '第(1/3)页',
      '上一章',
      '目录',
      '存书签',
      '下一章',
      '本站所有收录的内容均来自互联网，如有侵权我们将尽快删除。',
      '网站地图',
      '他随手把门关上。',
    ].join('\n');
    const { text, removedLines } = stripSiteChrome(raw);
    expect(removedLines).toBe(7);
    expect(text).toContain('张三推门进来，屋里的人都在等他。');
    expect(text).toContain('他随手把门关上。');
    expect(text).not.toContain('存书签');
    expect(text).not.toContain('网站地图');
    expect(text).not.toContain('第(1/3)页');
    // 单行判据本身也要对：导航词命中、正文句子不命中
    expect(isSiteChromeLine('存书签')).toBe(true);
    expect(isSiteChromeLine('第(1/3)页')).toBe(true);
    expect(isSiteChromeLine('他翻开目录，找到第三章。')).toBe(false);
  });

  it('导航词挤在一行（含全角分隔符）也整行清掉', () => {
    const { text, removedLines } = stripSiteChrome(
      '上一章　目录　存书签　下一章\n第 1/3 页\n正文一句。'
    );
    expect(removedLines).toBe(2);
    expect(text).toBe('正文一句。');
  });

  it('不误伤正文：含「目录/上一章/请记住」的正常句子照旧', () => {
    const raw = [
      '他翻开目录，找到第三章。',
      '上一章我们说到，他在城门口等了整整一天。',
      '“请记住我的话。”老人说完就走了。',
      '她把收藏了十年的信拿出来。',
    ].join('\n');
    const { text, removedLines } = stripSiteChrome(raw);
    expect(removedLines).toBe(0);
    expect(text).toBe(raw);
  });

  it('正文里的分场符（*** / 单独一个 *）不被当成装饰线', () => {
    const raw = ['正文甲。', '***', '正文乙。', '＊', '正文丙。'].join('\n');
    const { text, removedLines } = stripSiteChrome(raw);
    expect(removedLines).toBe(0);
    expect(text).toBe(raw);
  });

  it('不误伤现代题材正文：含「扫码/手机版/公众号/域名」的句子照旧', () => {
    const raw = [
      '他扫码付了钱，转身出门。',
      '她把公众号推送转给了他。',
      '这个域名他记得很清楚。',
      '手机版页面排版很乱。',
      '他终于读完了那本书。',
    ].join('\n');
    const { text, removedLines } = stripSiteChrome(raw);
    expect(removedLines).toBe(0);
    expect(text).toBe(raw);
  });

  it('纯网址行与长分隔线清掉，水印域名不残留', () => {
    const { text, removedLines } = stripSiteChrome(
      '正文。\nwww.example-novel.com\n----------\nmore 正文。'
    );
    expect(removedLines).toBe(2);
    expect(text).toBe('正文。\nmore 正文。');
  });

  it('提取正文后再清洗：抓下来的 HTML 里导航与声明都被剔除', () => {
    const html = [
      '<div>第二章 转折</div>',
      '<div>正文内容。</div>',
      '<div>上一章 | 目录 | 下一章</div>',
      '<div>本站所有收录的内容均来自互联网，如有侵权我们将尽快删除。</div>',
    ].join('');
    const cleaned = stripSiteChrome(extractMainText(html));
    expect(cleaned.text).toContain('正文内容。');
    expect(cleaned.text).not.toContain('本站所有收录');
    expect(cleaned.text).not.toContain('下一章');
  });
});

describe('拆解输入体检（空正文不再白烧调用、原因说得清）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('assessDeconstructInput：空 / 超短 / 正常三档', () => {
    const empty = assessDeconstructInput('   \n  ');
    expect(empty.ok).toBe(false);
    expect(empty.charCount).toBe(0);
    expect(empty.reason).toContain('正文为空');

    const short = assessDeconstructInput('验证中，请稍候');
    expect(short.ok).toBe(false);
    expect(short.charCount).toBe(7);
    expect(short.reason).toContain('正文过短');

    const good = '正文一句话。'.repeat(30);
    expect(assessDeconstructInput(good).ok).toBe(true);
  });

  it('deconstructChapterLLM：空正文直接失败且**不发请求**，原因可判断', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    await expect(
      deconstructChapterLLM({ chapterNumber: 3, chapterTitle: '第三章 起', content: '' })
    ).rejects.toThrow(/第3章无法拆解：正文为空/);
    // 体检在调模型之前：一次请求都不该发出去
    expect(fn).not.toHaveBeenCalled();
  });

  it('formatDeconstructReport 点名未拆解章节并分开归因（抓取侧 vs 拆解侧）', () => {
    const project = {
      title: '测试书',
      genre: '东方玄幻',
      chapters: [
        {
          number: 1,
          wordCount: 2000,
          content: '',
          summary: 'a',
          deconstruct: { hookType: '悬念', hookStrength: 5, payoffType: '无' },
        },
        // 正文空 → 抓取侧没拿到
        { number: 2, wordCount: 0, content: '', summary: '' },
        // 正文正常但没拆出来 → 拆解侧（可重试）
        { number: 3, wordCount: 2000, content: '正文。'.repeat(50), summary: '' },
        // 旧版导入残留的占位正文
        { number: 4, wordCount: 0, content: '【抓取失败：ETIMEDOUT】', summary: '' },
      ],
      characters: [],
      settings: [],
      deconstructMeta: { source: 'file', sourceName: '书.txt', importedAt: '2026-09-13T00:00:00.000Z' },
    } as unknown as BookProject;
    const report = formatDeconstructReport(project);
    expect(report).toContain('未拆解章节：第 2、3、4 章');
    expect(report).toContain('共 3 章');
    expect(report).toContain('1 章正文为空/过短');
    expect(report).toContain('抓取侧');
    expect(report).toContain('1 章正文正常但拆解失败');
    expect(report).toContain('1 章正文是「抓取失败」占位');
  });
});

describe('拆解报告解析（展示用）', () => {
  const sample = [
    '# 拆书报告：测试书',
    '',
    '- 来源：本地文件 · 书.txt',
    '- **重点**：带加粗',
    '',
    '## 逐章拆解',
    '',
    '| 章 | 梗概 |',
    '|---|---|',
    '| 1 | 前半 \\| 后半 |',
    '',
    '> 仅限个人学习分析使用',
  ].join('\n');

  it('解析出标题/列表/表格/引用，表格转义的竖线不拆列', () => {
    const blocks = parseDeconstructReport(sample);
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toEqual(['h1', 'list', 'h2', 'table', 'quote']);

    const list = blocks.find((b) => b.kind === 'list');
    expect(list && list.kind === 'list' && list.items).toHaveLength(2);
    // **加粗** 解析成独立片段而不是残留星号
    const boldItem = list && list.kind === 'list' ? list.items[1] : [];
    expect(boldItem).toEqual([
      { text: '重点', bold: true },
      { text: '：带加粗', bold: false },
    ]);

    const table = blocks.find((b) => b.kind === 'table');
    expect(table && table.kind === 'table' && table.header).toEqual(['章', '梗概']);
    expect(table && table.kind === 'table' && table.rows[0]).toEqual(['1', '前半 | 后半']);
  });

  it('空输入/只有空行 → 无块（视图显示「报告为空」）', () => {
    expect(parseDeconstructReport('')).toEqual([]);
    expect(parseDeconstructReport('\n\n')).toEqual([]);
  });

  it('与生成端契约一致：真实报告能被完整解析（表格列数与表头一致）', () => {
    const project = {
      title: '测试书',
      genre: '东方玄幻',
      chapters: [
        {
          number: 1,
          wordCount: 2000,
          content: '',
          summary: '前半 | 后半\n换行了',
          deconstruct: { hookType: '悬念', hookStrength: 6, payoffType: '无', emotion: 7 },
        },
      ],
      characters: [
        { id: 'c1', name: '张三', role: '主角', personality: '坚韧', relations: [] },
      ],
      settings: [{ name: '灵根', category: '力量与境界体系', description: '修炼资质' }],
      deconstructMeta: { source: 'file', sourceName: '书.txt', importedAt: '2026-09-13T00:00:00.000Z' },
    } as unknown as BookProject;
    const blocks = parseDeconstructReport(formatDeconstructReport(project));
    const table = blocks.find((b) => b.kind === 'table');
    expect(table).toBeDefined();
    if (table && table.kind === 'table') {
      // 表头 6 列（含情绪），行也必须 6 列；梗概里的 `|` 不该把它撑成 7 列
      expect(table.header).toEqual(['章', '字数', '钩子', '爽点', '情绪', '梗概']);
      expect(table.rows[0]).toHaveLength(6);
      expect(table.rows[0][5]).toBe('前半 | 后半 换行了');
    }
    // 各段都被解析出来，没有留下裸 Markdown 记号
    expect(blocks.some((b) => b.kind === 'h1')).toBe(true);
    expect(blocks.some((b) => b.kind === 'h2')).toBe(true);
    expect(blocks.some((b) => b.kind === 'quote')).toBe(true);
  });
});

describe('题目顺序（倒序目录页 → 第一章变成最新章）', () => {
  it('chapterNumberFromTitle：中文/阿拉伯/Chapter/带前后缀', () => {
    expect(chapterNumberFromTitle('第一章 开局')).toBe(1);
    expect(chapterNumberFromTitle('第 十二 章 风起')).toBe(12);
    expect(chapterNumberFromTitle('第012章 起')).toBe(12);
    expect(chapterNumberFromTitle('第一百二十三章 决战')).toBe(123);
    expect(chapterNumberFromTitle('第0章 序')).toBe(0);
    expect(chapterNumberFromTitle('Chapter 3')).toBe(3);
    expect(chapterNumberFromTitle('某书 第37章 转折')).toBe(37);
    // 解析不出章号的题名 → null（切章兜底标题「片段N」就在此列）
    expect(chapterNumberFromTitle('片段1')).toBeNull();
    expect(chapterNumberFromTitle('序章 少年')).toBeNull();
    expect(chapterNumberFromTitle('')).toBeNull();
  });

  it('倒序目录 → 重排为阅读顺序（用户报的「第一章是新latest」）', () => {
    const desc = [
      { title: '第3章 转折', url: 'c' },
      { title: '第2章 承接', url: 'b' },
      { title: '第1章 开局', url: 'a' },
    ];
    const r = sortByTitleChapterNumber(desc);
    expect(r.reordered).toBe(true);
    expect(r.items.map((x) => x.title)).toEqual(['第1章 开局', '第2章 承接', '第3章 转折']);
    expect(r.firstNumber).toBe(1);
    // 原数组不被就地修改
    expect(desc[0].title).toBe('第3章 转折');
  });

  it('乱序（局部倒序）也能排成阅读顺序', () => {
    const messy = [
      { title: '第5章' },
      { title: '第1章' },
      { title: '第3章' },
      { title: '第2章' },
      { title: '第4章' },
    ];
    const r = sortByTitleChapterNumber(messy);
    expect(r.reordered).toBe(true);
    expect(r.items.map((x) => x.title)).toEqual(['第1章', '第2章', '第3章', '第4章', '第5章']);
  });

  it('已经是升序 → 不动（reordered=false）', () => {
    const asc = [{ title: '第1章' }, { title: '第2章' }, { title: '第3章' }];
    const r = sortByTitleChapterNumber(asc);
    expect(r.reordered).toBe(false);
    expect(r.items).toBe(asc);
    expect(r.firstNumber).toBe(1);
  });

  it('分卷各自从第 1 章编号（章号重复）→ 不重排，避免打乱卷序', () => {
    const byVolume = [
      { title: '第1章 卷一开局' },
      { title: '第2章 卷一承接' },
      { title: '第1章 卷二开局' },
      { title: '第2章 卷二承接' },
    ];
    const r = sortByTitleChapterNumber(byVolume);
    expect(r.reordered).toBe(false);
    expect(r.items).toBe(byVolume);
    expect(r.hasDuplicateNumbers).toBe(true);
  });

  it('题名缺章号 / 单条 → 不动', () => {
    const mixed = [{ title: '第3章' }, { title: '片段2' }, { title: '第1章' }];
    const r = sortByTitleChapterNumber(mixed);
    expect(r.reordered).toBe(false);
    expect(r.numberedCount).toBe(2);
    expect(r.total).toBe(3);

    const one = [{ title: '第9章' }];
    expect(sortByTitleChapterNumber(one).reordered).toBe(false);
    expect(sortByTitleChapterNumber([]).reordered).toBe(false);
  });

  it('目录页抽出来的链接（真实流程）会被排成从第一章开始', () => {
    const html = [
      '<a href="/3.html">第3章 转折</a>',
      '<a href="/2.html">第2章 承接</a>',
      '<a href="/1.html">第1章 开局</a>',
      '<a href="/toc.html">随便逛逛</a>',
    ].join('');
    const links = extractChapterLinks(html, 'https://example.com/book/');
    const r = sortByTitleChapterNumber(links);
    expect(r.reordered).toBe(true);
    expect(r.items.map((l) => l.url)).toEqual([
      'https://example.com/1.html',
      'https://example.com/2.html',
      'https://example.com/3.html',
    ]);
    expect(r.firstNumber).toBe(1);
  });
});

describe('目录页分页（9ku 实测：大书目录被拆成 index_1..index_N）', () => {
  // 与真实页面同形：分页锚文本是数字/翻页符，href 是 index_N.html
  const tocHtml = [
    '<a href="/book/73/73917/1091755.html">第三百六十八节：方源、巨阳战星宿</a>',
    '<a href="/book/73/73917/1091754.html">第三百六十七节：三尊齐攻天庭！</a>',
    '<a href="/book/73/73917/1089356.html">第一节：纵身亡魔心仍不悔</a>',
    '<a href="/book/73/73917/index_1.html">1</a>',
    '<a href="/book/73/73917/index_2.html">2</a>',
    '<a href="/book/73/73917/index_3.html">3</a>',
    '<a href="/book/73/73917/index_2.html">&gt;</a>',
    '<a href="/book/73/73917/index_24.html">&raquo;</a>',
  ].join('');
  const base = 'https://www.9ku.net/book/73/73917/';

  it('认出其余目录页；章节链接（6-7 位 id）不会被当成页码', () => {
    const p = extractTocPageUrls(tocHtml, base);
    expect(p.currentPage).toBe(1);
    expect(p.totalPages).toBe(24);
    // 页面控件只列了「1 2 3 > »」，中间的页要按 index_N 模板补齐——否则共 24 页却只抓 3 页
    expect(p.pageUrls).toHaveLength(23);
    expect(p.pageUrls[0]).toBe('https://www.9ku.net/book/73/73917/index_2.html');
    expect(p.pageUrls[1]).toBe('https://www.9ku.net/book/73/73917/index_3.html');
    expect(p.pageUrls[2]).toBe('https://www.9ku.net/book/73/73917/index_4.html');
    expect(p.pageUrls.at(-1)).toBe('https://www.9ku.net/book/73/73917/index_24.html');
  });

  it('从 index_3.html 进入时，其余页不含自己', () => {
    const p = extractTocPageUrls(tocHtml, 'https://www.9ku.net/book/73/73917/index_3.html');
    expect(p.currentPage).toBe(3);
    expect(p.pageUrls).toHaveLength(23);
    expect(p.pageUrls).toContain('https://www.9ku.net/book/73/73917/index_1.html');
    expect(p.pageUrls).not.toContain('https://www.9ku.net/book/73/73917/index_3.html');
  });

  it('没有分页的目录 → 空；其它目录的链接被忽略', () => {
    const plain = [
      '<a href="/book/73/73917/1089356.html">第一节</a>',
      '<a href="/book/9/9573/index_2.html">2</a>',
      '<a href="/list2/">武侠</a>',
    ].join('');
    const p = extractTocPageUrls(plain, base);
    expect(p.pageUrls).toEqual([]);
    expect(p.totalPages).toBeNull();

    // 数字锚文本但指向别的书 → 不算本目录的页
    const crossBook = '<a href="/book/9/9573/index_2.html">2</a>';
    expect(extractTocPageUrls(crossBook, base).pageUrls).toEqual([]);
  });

  it('?page=N 形态（同路径 + 查询参数）也能认，并按模板补齐中间页', () => {
    const html = [
      '<a href="/book/73/73917/?page=2">2</a>',
      '<a href="/book/73/73917/?page=5">下一页</a>',
    ].join('');
    const p = extractTocPageUrls(html, base);
    expect(p.totalPages).toBe(5);
    expect(p.pageUrls).toHaveLength(4);
    expect(p.pageUrls).toContain('https://www.9ku.net/book/73/73917/?page=4');
    // 当前页（无 page 参数的第 1 页）不在列表里
    expect(p.pageUrls.every((u) => u.includes('page='))).toBe(true);
  });

  it('只有数字锚文本、href 不像页码 → 不认（防止把 「1、xxx」的正文列表当分页）', () => {
    const html = '<a href="/book/73/73917/1089356.html">1</a>';
    expect(extractTocPageUrls(html, base).pageUrls).toEqual([]);
  });

  it('mergeChapterLinks：合并多页目录 → 去重 → 排成阅读顺序', () => {
    // 第 1 页：置顶最新章节（倒序）+ 正文列表前半；第 2 页：后半
    const page1 = [
      { url: 'c368', title: '第三百六十八节：方源、巨阳战星宿' },
      { url: 'c367', title: '第三百六十七节：三尊齐攻天庭！' },
      { url: 'c1', title: '第一节：纵身亡魔心仍不悔' },
      { url: 'c2', title: '第二节：逆光阴五百年觉悟' },
    ];
    const page2 = [
      // 「最新章节」块在后续页又出现一次（真实站点就这样）
      { url: 'c368', title: '第三百六十八节：方源、巨阳战星宿' },
      { url: 'c3', title: '第三节：请一边玩蛋去' },
    ];
    const r = mergeChapterLinks([page1, page2]);
    expect(r.reordered).toBe(true);
    expect(r.items.map((l) => l.url)).toEqual(['c1', 'c2', 'c3', 'c367', 'c368']);
    expect(r.firstNumber).toBe(1);
    // 去重后章号唯一（否则排序保护会放弃排序，顺序又乱）
    expect(r.total).toBe(5);
  });
});

describe('章内分页（9ku 实测：长章被拆成 X.html / X_2.html / X_3.html）', () => {
  // 与真实页面同形：正文开头有「第(1/3)页」标记
  const chapterHtml = (page: number, total: number) =>
    `<article class="font_max"><br>&nbsp;&nbsp;第(${page}/${total})页<br><br>&nbsp;&nbsp;“方源，乖乖地交出春秋蝉。”</article>`;

  it('确证 b>1 时推导出后续页地址', () => {
    const urls = deriveChapterPageUrls(
      chapterHtml(1, 3),
      'https://www.9ku.net/book/73/73917/1089356.html'
    );
    expect(urls).toEqual([
      'https://www.9ku.net/book/73/73917/1089356_2.html',
      'https://www.9ku.net/book/73/73917/1089356_3.html',
    ]);
  });

  it('已经带 _N 的页：从基名重算，且不含自己', () => {
    const urls = deriveChapterPageUrls(
      chapterHtml(2, 3),
      'https://www.9ku.net/book/73/73917/1089356_2.html'
    );
    expect(urls).toEqual(['https://www.9ku.net/book/73/73917/1089356_3.html']);
  });

  it('单页章（第1/1页）/ 无标记 / 非 .html URL → 不猜地址', () => {
    expect(
      deriveChapterPageUrls(chapterHtml(1, 1), 'https://a.com/b/1.html')
    ).toEqual([]);
    expect(deriveChapterPageUrls('<article>正文</article>', 'https://a.com/b/1.html')).toEqual([]);
    expect(deriveChapterPageUrls(chapterHtml(1, 5), 'https://a.com/b/1089356/')).toEqual([]);
    // 页数离谱（>20）也不认
    expect(deriveChapterPageUrls(chapterHtml(1, 999), 'https://a.com/b/1.html')).toEqual([]);
  });

  it('清洗会把「第(1/3)页」整行去掉（用户看到的那行）', () => {
    const text = ['第(1/3)页', '“方源，乖乖地交出春秋蝉。”', '第 2/3 页', '更多正文。'].join('\n');
    const r = stripSiteChrome(text);
    expect(r.removedLines).toBe(2);
    expect(r.text).toBe('“方源，乖乖地交出春秋蝉。”\n更多正文。');
  });

  it('实测漏点：站点 UI 行（页面标题/站名/控件/拼在一起的导航条）也被清掉', () => {
    const raw = [
      '蛊真人_蛊真人_第一节：纵身亡魔心仍不悔_九库小说网',
      '九库小说网',
      '搜索',
      '首页玄幻武侠都市历史网游科幻言情其他排行完本',
      '字体',
      '换手',
      '关灯',
      '第一节：纵身亡魔心仍不悔-《蛊真人》',
      '“方源，乖乖地交出春秋蝉。”',
    ].join('\n');
    const r = stripSiteChrome(raw, {
      pageTitle: '蛊真人_蛊真人_第一节：纵身亡魔心仍不悔_九库小说网',
    });
    // 只剩章节标题行 + 正文
    expect(r.text).toBe('第一节：纵身亡魔心仍不悔-《蛊真人》\n“方源，乖乖地交出春秋蝉。”');
    expect(r.removedLines).toBe(7);
  });
});

describe('换站兼容：其它站点形态的兜底', () => {
  it('锚文本不是「第N章」时，用「同目录 + 数字 id」的最大同构链接块兜底', () => {
    const html = [
      // 目录：标题里没有「第N章」字样
      '<a href="/read/123/45671.html">开局</a>',
      '<a href="/read/123/45672.html">逆光阴</a>',
      '<a href="/read/123/45673.html">请一边玩蛋去</a>',
      '<a href="/read/123/45674.html">青茅山</a>',
      '<a href="/read/123/45675.html">五百年</a>',
      // 别处的干扰链接（不同目录 / 非数字 id / 功能链接）
      '<a href="/book/9/111.html">别的书</a>',
      '<a href="/read/123/about.html">关于</a>',
      '<a href="javascript:;">加入书架</a>',
      '<a href="/read/123/45671.html">开局</a>',
    ].join('');
    // 标准抽取认不出（锚文本没有「第N章」）
    expect(extractChapterLinks(html, 'https://x.com/read/123/')).toHaveLength(0);
    const loose = extractChapterLinksLoose(html, 'https://x.com/read/123/');
    expect(loose.map((l) => l.title)).toEqual(['开局', '逆光阴', '请一边玩蛋去', '青茅山', '五百年']);
    expect(loose[0].url).toBe('https://x.com/read/123/45671.html');
  });

  it('同构链接块不足 5 条 → 不采用（宁少不滥）', () => {
    const html = ['1', '2', '3', '4']
      .map((n) => `<a href="/read/123/4567${n}.html">第${n}节</a>`)
      .join('');
    // 这四条锚文本是「第N节」→ 标准抽取能认，兜底分组只有 4 条 → 返回空
    expect(extractChapterLinks(html, 'https://x.com/read/123/')).toHaveLength(4);
    expect(extractChapterLinksLoose(html, 'https://x.com/read/123/')).toEqual([]);
  });

  it('倒序且章号重复（第12章(下)/(上) 同章分页）→ 整体反转，保序不打乱', () => {
    const desc = [
      { title: '第12章 决战（下）' },
      { title: '第12章 决战（上）' },
      { title: '第11章 承前（下）' },
      { title: '第11章 承前（上）' },
    ];
    const r = sortByTitleChapterNumber(desc);
    expect(r.reordered).toBe(true);
    expect(r.mode).toBe('reverse');
    // 反转后：第11章(上) → (下) → 第12章(上) → (下)，同章内的先后不被对调
    expect(r.items.map((x) => x.title)).toEqual([
      '第11章 承前（上）',
      '第11章 承前（下）',
      '第12章 决战（上）',
      '第12章 决战（下）',
    ]);
    expect(r.firstNumber).toBe(11);
  });

  it('分卷各自编号（不是非递增）→ 仍然不动，避免毁卷序', () => {
    const byVolume = [
      { title: '第1章 卷一开局' },
      { title: '第2章 卷一承接' },
      { title: '第1章 卷二开局' },
    ];
    const r = sortByTitleChapterNumber(byVolume);
    expect(r.reordered).toBe(false);
    expect(r.mode).toBeNull();
  });

  it('唯一章号升序时 mode 为 null（本来就对，不该动）', () => {
    const asc = [{ title: '第1章' }, { title: '第2章' }];
    expect(sortByTitleChapterNumber(asc).mode).toBeNull();
  });

  it('无「第(a/b)页」标记时，从锚点认出同章其它页（X_2.html）', () => {
    const html =
      '<article>正文…</article>' +
      '<a href="/read/123/45671_2.html">下一页</a>' +
      '<a href="/read/123/45672.html">下一章</a>'; // 章节 id 相邻，不能误认
    const info = analyzeChapterPagination(html, 'https://x.com/read/123/45671.html');
    expect(info.total).toBe(1);
    expect(info.urls).toEqual(['https://x.com/read/123/45671_2.html']);
  });

  it('有「第(1/3)页」但地址推不出来 → urls 为空（调用方据此提示「可能只有 1/3」）', () => {
    const html = '<article>第(1/3)页 正文…</article>';
    const info = analyzeChapterPagination(html, 'https://x.com/read/123/45671/');
    expect(info.page).toBe(1);
    expect(info.total).toBe(3);
    expect(info.urls).toEqual([]);
  });

  it('「本章未完，请点击下一页继续阅读」→ incompleteHint，且该行会被清洗掉', () => {
    const html = '<article>正文…<br>本章未完，请点击下一页继续阅读</article>';
    expect(analyzeChapterPagination(html, 'https://x.com/read/123/45671.html').incompleteHint).toBe(
      true
    );
    const r = stripSiteChrome('正文…\n本章未完，请点击下一页继续阅读');
    expect(r.removedLines).toBe(1);
    expect(r.text).toBe('正文…');
  });
});

describe('切章：纯「1、标题」编号的书与「节课」误伤', () => {
  it('纯「1、标题」编号（无「第N章」）能按编号切章（此前整本被 4000 字硬切）', () => {
    const lines: string[] = [];
    for (let n = 1; n <= 3; n += 1) {
      lines.push(`${n}、第${n}章的标题`);
      for (let k = 0; k < 25; k += 1) lines.push(`第${n}章第${k}段正文内容，凑够行数。`);
    }
    const splits = splitChapters(lines.join('\n'));
    expect(splits).toHaveLength(3);
    expect(splits[0].title).toBe('1、第1章的标题');
    expect(splits[1].title).toBe('2、第2章的标题');
    expect(splits[2].title).toBe('3、第3章的标题');
  });

  it('正文里的短列表（连着几行 1、2、3，间距太小）不误切', () => {
    const raw = [
      '他列了个单子：',
      '1、煮水',
      '2、下米',
      '3、开火',
      '4、起锅',
      '5、上桌',
      '然后就开吃了。',
    ].join('\n');
    const splits = splitChapters(raw);
    // 不该按列表切（整段是正文，不是目录）
    expect(splits.length).toBe(1);
  });

  it('「第四节课是体育。」「第四节车厢很空。」不被当成章标题', () => {
    const raw = ['第五节课是体育。', '老师走进来。', '第四节车厢很空。', '他坐下。'].join('\n');
    const splits = splitChapters(raw);
    expect(splits.length).toBe(1);
    expect(splits[0].content).toContain('第五节课是体育');
  });

  it('「第四章」单独成行、及「第四章 决战」都认', () => {
    const raw = ['第四章', '决战开始。'.repeat(30), '第四章 决战', '开打。'.repeat(30)].join('\n');
    const splits = splitChapters(raw);
    expect(splits.length).toBeGreaterThanOrEqual(2);
    expect(splits[0].title).toBe('第四章');
    expect(splits.some((s) => s.title === '第四章 决战')).toBe(true);
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
