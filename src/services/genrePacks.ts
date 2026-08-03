/**
 * 题材规则包：写入前注入 prompt，约束节奏、禁忌与常见崩坏点。
 */

export interface GenrePack {
  id: string;
  name: string;
  /** 用于匹配 project.genre / config.genre */
  aliases: string[];
  description: string;
  /** 节奏与爽点 */
  pacing: string;
  /** 禁忌（写作与审校都参考） */
  taboos: string[];
  /** 题材必给读者的感觉/要素 */
  mustHaves: string[];
  /** 审校额外关注 */
  auditHints: string[];
  /** 叠到黑名单的额外词 */
  extraBlacklist?: string[];
}

export const GENRE_PACKS: GenrePack[] = [
  {
    id: 'xuanhuan',
    name: '玄幻修真',
    aliases: ['玄幻', '修真', '修仙', '东方玄幻', '传统修真', '史诗玄幻', '高武'],
    description: '境界清晰、资源因果、装逼打脸有代价，避免无脑碾压与境界瞬跳。',
    pacing: '章内小兑现+章末钩子；战力展示用具体招式与空间反馈，忌空喊境界名。',
    taboos: [
      '境界无铺垫连跳两级以上',
      '主角无代价碾压同阶全体',
      '天材地宝随手捡完无争夺',
      '反派降智只为送经验',
      '用大段功法说明书代替冲突',
    ],
    mustHaves: ['可感知的实力差', '资源/因果代价', '至少一处信息差或反转', '具体地理/宗门势力触感'],
    auditHints: ['战力是否自洽', '功法 debuff 是否被忘记', '势力关系是否突变无因'],
    extraBlacklist: ['一股恐怖的气息', '仿佛要撕裂苍穹', '整个人都呆住了'],
  },
  {
    id: 'wuxia',
    name: '武侠',
    aliases: ['武侠', '传统武侠', '新派武侠', '江湖'],
    description: '招式、江湖规矩与人情冷暖优先于数值；刀光有声，恩仇有因。',
    pacing: '短打干净；对话藏锋；一章一事，恩怨推进，忌无意义游山玩水。',
    taboos: [
      '无门派规矩的随意杀人无后果',
      '轻功满天飞却无距离感',
      '把武侠写成修仙飞升',
      '全程内心独白不交手也不交谈',
    ],
    mustHaves: ['招式/身法细节', '江湖规矩或人情', '恩仇或承诺线'],
    auditHints: ['是否违反江湖规矩却无人反应', '兵器与身法是否前后一致'],
    extraBlacklist: ['那一刻', '心中暗道'],
  },
  {
    id: 'dushi',
    name: '都市现实',
    aliases: ['都市', '现实', '职场', '都市修真', '都市异能'],
    description: '社会关系、利益与信息差驱动；能力再强也要吃人间烟火约束。',
    pacing: '对话推进信息；每章至少一个利益节点或关系变化；忌纯装逼无代价。',
    taboos: [
      '无视法律与舆论的无限横行',
      '配角工具人只会跪舔',
      '能力升级无社会反馈',
      '大段成功学鸡汤',
    ],
    mustHaves: ['具体职业/场景', '利益或人情博弈', '对手有智商'],
    auditHints: ['人际关系是否突变', '金钱/权势获取是否跳步'],
  },
  {
    id: 'yanqing',
    name: '言情情感',
    aliases: ['言情', '甜宠', '虐恋', '爱情', '现代言情', '古言'],
    description: '关系张力与情绪兑现优先；冲突来自选择与误解，而非纯巧合。',
    pacing: '拉扯—靠近—新阻碍；章末情绪钩子；忌连续纯撒糖无推进。',
    taboos: [
      '用羞辱人格当情趣且无反思',
      '女主/男主无理由反复降智',
      '第三者工具化无动机',
      '大段心灵鸡汤收尾',
    ],
    mustHaves: ['关系状态变化', '至少一处具体互动细节', '冲突有人物动机'],
    auditHints: ['感情态度是否无故翻转', '是否只有误会驱动全剧'],
    extraBlacklist: ['心中一软', '眼眶不争气地红了'],
  },
  {
    id: 'kehuan',
    name: '科幻赛博',
    aliases: ['科幻', '赛博', '硬科幻', '星际', '未来'],
    description: '规则与设定自洽；技术有代价与限制；用具体界面/机制代替黑箱神迹。',
    pacing: '问题—尝试—新信息；每章揭示一点规则或风险；忌纯设定讲座。',
    taboos: [
      '科技万能无副作用',
      '前后设定互相打架',
      '用「量子」一词糊弄因果',
      '全员只有功能没有欲望',
    ],
    mustHaves: ['可理解的规则限制', '具体技术触感', '选择的代价'],
    auditHints: ['设定是否吃书', '时间线/通讯延迟是否合理'],
  },
  {
    id: 'xuanyi',
    name: '悬疑推理',
    aliases: ['悬疑', '推理', '诡案', '刑侦', '克苏鲁', '惊悚'],
    description: '线索可回溯；真相不靠最后一章乱编；氛围用细节而非空喊恐怖。',
    pacing: '线索投放—误导—修正；章末新疑点；忌连续回忆灌设定。',
    taboos: [
      '关键线索未出场却直接破案',
      '凶手动机临时发明',
      '用超自然无规则收尾硬科幻案件',
      '主角全知视角剧透真相',
    ],
    mustHaves: ['可检索线索', '人物隐瞒动机', '具体场景证据'],
    auditHints: ['时间线是否可推', '证据是否前后矛盾'],
  },
  {
    id: 'general',
    name: '通用网文',
    aliases: ['通用', '其他', '综合'],
    description: '黄金三章节奏：冲突清晰、人物有欲、章末有钩；忌注水与说教。',
    pacing: '起冲突—加压—小兑现—钩子；对话与动作交替。',
    taboos: ['章末升华说教', '无冲突流水账', '人设无故OOC', '重复信息三次以上'],
    mustHaves: ['清晰欲望', '阻力', '章末钩子'],
    auditHints: ['是否注水', '是否OOC'],
  },
];

export function listGenrePacks(): GenrePack[] {
  return GENRE_PACKS;
}

export function getGenrePackById(id?: string | null): GenrePack | undefined {
  if (!id) return undefined;
  return GENRE_PACKS.find((p) => p.id === id);
}

/** 根据书的 genre 字符串解析规则包 */
export function resolveGenrePack(genre?: string | null): GenrePack {
  const g = (genre || '').trim().toLowerCase();
  if (!g) return GENRE_PACKS.find((p) => p.id === 'general')!;

  for (const pack of GENRE_PACKS) {
    if (pack.id === g || pack.name === genre) return pack;
    if (pack.aliases.some((a) => g.includes(a.toLowerCase()) || a.toLowerCase().includes(g))) {
      return pack;
    }
  }
  return GENRE_PACKS.find((p) => p.id === 'general')!;
}

/**
 * 项目级自定义覆盖（存 config.customParameters.genrePackOverride）
 * 可改名称/描述/节奏/禁忌/应具备/审校提示/附加黑名单，不改 id。
 */
export type GenrePackOverride = Partial<
  Pick<
    GenrePack,
    'name' | 'description' | 'pacing' | 'taboos' | 'mustHaves' | 'auditHints' | 'extraBlacklist'
  >
> & { basePackId?: string };

export function normalizeGenreOverride(raw: unknown): GenrePackOverride | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const lines = (v: unknown) =>
    Array.isArray(v)
      ? v.map(String).map((s) => s.trim()).filter(Boolean)
      : typeof v === 'string'
        ? v
            .split('\n')
            .map((s) => s.replace(/^[\d\.、\-\*\s]+/, '').trim())
            .filter(Boolean)
        : undefined;

  const o: GenrePackOverride = {};
  if (typeof r.basePackId === 'string') o.basePackId = r.basePackId;
  if (typeof r.name === 'string' && r.name.trim()) o.name = r.name.trim();
  if (typeof r.description === 'string') o.description = r.description.trim();
  if (typeof r.pacing === 'string') o.pacing = r.pacing.trim();
  const taboos = lines(r.taboos);
  if (taboos) o.taboos = taboos.slice(0, 20);
  const mustHaves = lines(r.mustHaves);
  if (mustHaves) o.mustHaves = mustHaves.slice(0, 20);
  const auditHints = lines(r.auditHints);
  if (auditHints) o.auditHints = auditHints.slice(0, 15);
  const extra = lines(r.extraBlacklist);
  if (extra) o.extraBlacklist = extra.slice(0, 30);
  return o;
}

export function mergePackWithOverride(
  base: GenrePack,
  override?: GenrePackOverride | null
): GenrePack {
  if (!override) return { ...base, taboos: [...base.taboos], mustHaves: [...base.mustHaves] };
  return {
    ...base,
    name: override.name?.trim() || base.name,
    description: override.description ?? base.description,
    pacing: override.pacing ?? base.pacing,
    taboos: override.taboos?.length ? override.taboos : [...base.taboos],
    mustHaves: override.mustHaves?.length ? override.mustHaves : [...base.mustHaves],
    auditHints: override.auditHints?.length ? override.auditHints : [...(base.auditHints || [])],
    extraBlacklist: override.extraBlacklist?.length
      ? override.extraBlacklist
      : [...(base.extraBlacklist || [])],
  };
}

/**
 * 从项目 config + genre 解析最终注入用规则包（含自定义覆盖）。
 */
export function resolveGenrePackForProject(input: {
  genre?: string | null;
  genrePackId?: string | null;
  override?: unknown;
}): GenrePack {
  const base =
    getGenrePackById(input.genrePackId) ||
    resolveGenrePack(input.genre);
  const ov = normalizeGenreOverride(input.override);
  // 若覆盖指定了 basePackId 且与当前 base 不同，以覆盖的 base 为准
  const base2 =
    ov?.basePackId && ov.basePackId !== base.id
      ? getGenrePackById(ov.basePackId) || base
      : base;
  return mergePackWithOverride(base2, ov);
}

export function formatGenrePackForPrompt(pack: GenrePack): string {
  const lines: string[] = [];
  lines.push(`【题材规则包：${pack.name}】${pack.description}`);
  lines.push(`节奏：${pack.pacing}`);
  lines.push('禁忌：');
  pack.taboos.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  lines.push('本章应具备：');
  pack.mustHaves.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  if (pack.auditHints?.length) {
    lines.push('审校额外关注：');
    pack.auditHints.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  }
  return lines.join('\n');
}

/** 合并题材附加黑名单 */
export function mergeGenreBlacklist(
  base: string[],
  pack: GenrePack
): string[] {
  return [...new Set([...base, ...(pack.extraBlacklist || [])])];
}

