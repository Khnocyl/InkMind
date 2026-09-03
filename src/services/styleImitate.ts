/**
 * 文风仿写：
 * 1) 本地统计指纹  2) LLM 风格指南  3) 写入 StyleConfig 并注入写作
 */

import { proseWords } from './proseWords';
import type {
  FewShotExample,
  StyleConfig,
  StyleFingerprint,
  StyleProfile,
} from '../types/novel';
import { generateJSON } from './llmClient';
import {
  analyzeStyleFingerprint,
  excerptSample,
  formatFingerprintSummary,
} from './styleFingerprint';

export function getActiveStyleProfile(
  style?: StyleConfig | null
): StyleProfile | null {
  if (!style?.activeStyleProfileId || !style.styleProfiles?.length) return null;
  return (
    style.styleProfiles.find((p) => p.id === style.activeStyleProfileId) || null
  );
}

/**
 * 破折号白名单（写后校验豁免判定，两路取或）：
 * 1) 书级总开关 styleConfig.allowEmDash（引擎与风格页勾选）；
 * 2) 激活文风档案声明 punctuationTolerance='ellipsis-emphatic'（档案级豁免）。
 */
export function resolveAllowEmDash(style?: StyleConfig | null): boolean {
  if (style?.allowEmDash === true) return true;
  return (
    getActiveStyleProfile(style)?.punctuationTolerance === 'ellipsis-emphatic'
  );
}

/**
 * 题材适配判定：档案未标 genreTags（题材通用）或书题材未知时视为匹配；
 * 标了标签且与书题材（含题材规则包别名口径）无一命中 → 不匹配，
 * 触发降级（防「唐家三少团战六拍」带进言情/都市书）。
 */
export function isStyleGenreMismatch(
  profile: StyleProfile | null | undefined,
  bookGenre?: string | null
): boolean {
  const tags = (profile?.genreTags || [])
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (!tags.length) return false;
  const g = (bookGenre || '').trim().toLowerCase();
  if (!g) return false;
  return !tags.some((t) => g.includes(t) || t.includes(g));
}

/**
 * 注入结构层 Prompt 的「作家创作方法论」块（世界观/大纲/拆章/分镜）。
 * 与正文腔调层（formatStyleProfileForPrompt）分离：结构层只管体系、节奏循环、
 * 爽点/名场面分布、群像与伏笔规划，不含句法文风——让蒸馏的作家大脑参与结构建设。
 * 题材不匹配时不注入：结构层全是该作家的题材公式（团战分布/升级循环等），
 * 注进不匹配的书会把大纲/分镜整个带偏。
 */
export function formatStyleStructureForPrompt(
  profile: StyleProfile | null | undefined,
  bookGenre?: string | null
): string {
  if (!profile || !profile.structureGuide?.trim()) return '';
  if (isStyleGenreMismatch(profile, bookGenre)) return '';
  return [
    `【作家创作方法论 · '${profile.name}'】（结构层：设计世界观/大纲/拆章/分镜时以该作家的大脑推演）`,
    profile.structureGuide.trim(),
  ].join(String.fromCharCode(10));
}

/**
 * 题材不匹配时的降级铁律块：只学文笔层（节奏/对白/白描/比喻），
 * 显式禁用档案的题材性机制，题材节奏以题材规则包为准。
 */
function formatGenreDemotionBlock(
  profile: StyleProfile,
  bookGenre: string
): string {
  const mech = (profile.genreMechanisms || []).filter(Boolean);
  const mechLines = mech.length
    ? `该档案的题材性机制一律禁止执行、禁止在正文出现对应元素：\n${mech
        .map((m, i) => `${i + 1}. ${m}`)
        .join('\n')}`
    : '该档案的题材性机制（题材公式/专属场面类型）一律禁止执行，不得在正文出现对应元素。';
  return [
    `【题材不匹配降级铁律 · 优先级高于档案内一切条目】`,
    `本书题材为「${bookGenre}」，与文风档案「${profile.name}」的题材气质不匹配。本档案只执行文笔层：句长节奏、短句/长句分布、对白密度与声口、白描、具体名词、生活化比喻、动作过程链。`,
    mechLines,
    `题材节奏、冲突与爽点完全以【题材规则包】为准；档案「要做/不要做」中题材性条目同样不执行。禁止把正文写成该作家的题材公式。`,
  ].join('\n');
}

/** 注入正文 Prompt 的仿写块（bookGenre：本书题材，不匹配时降级为文笔层） */
export function formatStyleProfileForPrompt(
  profile: StyleProfile | null | undefined,
  bookGenre?: string | null
): string {
  if (!profile) return '';
  const demotion = isStyleGenreMismatch(profile, bookGenre)
    ? formatGenreDemotionBlock(profile, (bookGenre || '').trim())
    : '';
  const fp = profile.fingerprint;
  const doL = (profile.doList || []).map((x, i) => `${i + 1}. ${x}`).join('\n');
  const dontL = (profile.dontList || []).map((x, i) => `${i + 1}. ${x}`).join('\n');
  // 多场景范文：分场景锚语感（恐怖并置/对白立人/悬疑收尾…），比单段更贴
  const excerptBlocks = (profile.sampleExcerpts || []).slice(0, 3).map(
    (e) => `「场景：${e.label}」\n${e.text.slice(0, 400)}`
  );
  const sample = excerptBlocks.length
    ? excerptBlocks.join('\n\n')
    : (profile.sampleExcerpt || '').slice(0, 500);
  return [
    demotion,
    `【文风仿写档案 · ${profile.name}】（${
      demotion ? '降级模式：只学文笔层，' : ''
    }必须模仿，禁止写成通用 AI 网文腔）`,
    profile.authorStyle ? `行文要诀：${profile.authorStyle}` : '',
    '',
    '【统计指纹 · 尽量贴近】',
    formatFingerprintSummary(fp),
    `目标：均句长约 ${fp.avgSentenceLen} 字；短句占比约 ${Math.round(fp.shortSentenceRatio * 100)}%；对白密度约 ${Math.round(fp.dialogueRatio * 100)}%。`,
    '',
    '【风格指南】',
    profile.styleGuide || '（无）',
    doL ? `\n【要做】\n${doL}` : '',
    dontL ? `\n【不要做】\n${dontL}` : '',
    sample
      ? `\n【参考文气摘录（学语感、节奏与用词，勿照抄情节${
          demotion ? '；禁止把选段的题材场面（团战/升级/喊招式名等）带进本章' : ''
        }）】\n${sample}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 局部改写 / AI 修待修：注入当前书「引擎与风格」全部相关约束。
 * 含：激活文风仿写档案、few-shot 范例、黑名单、Show don't tell、禁升华。
 */
export function formatStyleConstraintsForRewrite(
  styleConfig?: StyleConfig | null,
  options?: {
    /** 仿写块上限字数，默认 1200 */
    profileMaxChars?: number;
    /** few-shot 摘录上限，默认 320 */
    fewShotMaxChars?: number;
    /** 黑名单条数，默认 25 */
    blacklistMax?: number;
    /** 本书题材：与激活档案不匹配时降级为只学文笔层 */
    bookGenre?: string | null;
  }
): string {
  if (!styleConfig) return '';
  const profileMax = options?.profileMaxChars ?? 1200;
  const fewMax = options?.fewShotMaxChars ?? 320;
  const blMax = options?.blacklistMax ?? 25;
  const parts: string[] = [];

  const profile = getActiveStyleProfile(styleConfig);
  const imitate = formatStyleProfileForPrompt(profile, options?.bookGenre);
  if (imitate) {
    parts.push(
      imitate.length > profileMax
        ? `${imitate.slice(0, profileMax)}\n…（仿写档案已截断）`
        : imitate
    );
    parts.push(
      '【文风铁律】改写后的句子必须贴近上述指纹与指南，禁止滑回通用 AI 网文腔。'
    );
  }

  const examples = styleConfig.fewShotExamples || [];
  const selected =
    examples.find((e) => e.id === styleConfig.selectedExampleId) || examples[0];
  if (selected?.content?.trim()) {
    // 已有仿写档案时仍保留 few-shot 作补充（用户在风格页点选的）
    const title = selected.title || '目标风格';
    const core = selected.authorStyle?.trim() || '';
    const excerpt = selected.content.trim().slice(0, fewMax);
    // 与仿写 sample 重复时缩短
    const sameAsProfile =
      !!profile?.sampleExcerpt &&
      profile.sampleExcerpt.slice(0, 40) === selected.content.trim().slice(0, 40);
    if (!sameAsProfile) {
      parts.push(
        [
          `【目标文风 few-shot · ${title}】`,
          core ? `核心要领：${core}` : '',
          `参考选段（学节奏与用词，勿照抄情节）：\n「${excerpt}」`,
        ]
          .filter(Boolean)
          .join('\n')
      );
    } else if (core && !profile?.authorStyle) {
      parts.push(`【目标文风要领】${core}`);
    }
  } else if (!profile) {
    parts.push(
      '【目标文风】未设置仿写档案/范例时：利落短句、动词具体、感官落地，忌解释腔与套话。'
    );
  }

  const bl = [
    ...(styleConfig.clicheBlacklist || []),
    ...(styleConfig.customBlacklist || []),
  ].slice(0, blMax);
  if (bl.length) {
    parts.push(`【禁用套话 · 改写中禁止出现】${bl.join('、')}`);
  }

  if (styleConfig.enforceShowDontTell !== false) {
    parts.push(
      '【展示而非陈述】禁止「心里感到…/气氛变得…/眼神露出…」类告诉句；用微动作与物理反馈呈现。'
    );
  }
  if (styleConfig.forbidEndingSublimation !== false) {
    parts.push(
      '【禁止升华】不得加入哲理、命运说教、总结感悟；在具体动作/对白/道具处收住。'
    );
  }

  return parts.filter(Boolean).join('\n\n');
}

export function buildStyleAnalyzePrompt(
  sampleText: string,
  fingerprint: StyleFingerprint,
  nameHint?: string
): { role: string; content: string }[] {
  const sample =
    sampleText.length > 4500
      ? `${sampleText.slice(0, 2200)}\n\n……\n\n${sampleText.slice(-2200)}`
      : sampleText;
  const system = `你是资深文风工程师（Style Engineer，负责文风仿写深度解构）。
任务：根据参考文本与统计指纹，产出可执行的「风格指南」，供 AI 后续章节严格仿写。
要求：
1. styleGuide 200–400 字，具体可操作（句式、用词、节奏、对白、环境、收束方式），禁止空泛「优美流畅」；
2. doList 4–8 条「要做」，dontList 4–8 条「不要做」（针对 AI 套话与偏离样本的写法）；
3. authorStyle 一句话要诀（≤40 字）；
4. analysis 80–150 字解构样本何以成立；
5. profileName 给档案起短名（可参考用户提示）；
6. 只输出合法 JSON。

JSON：
{
  "profileName": "冷硬短句·市井质感",
  "authorStyle": "……",
  "styleGuide": "……",
  "doList": ["……"],
  "dontList": ["……"],
  "analysis": "……"
}`;

  const user = `【用户命名提示】${nameHint || '（无，请自拟）'}

【统计指纹】
${formatFingerprintSummary(fingerprint)}

【参考文本】
${sample}

请输出风格指南 JSON。`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export interface AnalyzeStyleResult {
  profile: StyleProfile;
  fingerprintOnly: boolean;
}

/**
 * 分析参考文本 → StyleProfile
 * LLM 失败时仍返回指纹 + 启发式指南（fingerprintOnly=true）
 */
export async function analyzeReferenceStyle(options: {
  text: string;
  name?: string;
  sourceLabel?: string;
  onProgress?: (msg: string) => void;
}): Promise<AnalyzeStyleResult> {
  const text = (options.text || '').trim();
  if (proseWords(text) < 120) {
    throw new Error('参考文本过短：请至少粘贴约 120 字以上（建议 800–3000 字真人作品片段）');
  }

  options.onProgress?.('正在提取统计指纹（句长/对白/节奏）…');
  const fingerprint = analyzeStyleFingerprint(text);
  const sampleExcerpt = excerptSample(text, 420);
  const id = `style-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();

  try {
    options.onProgress?.('正在调用模型生成风格指南…');
    const messages = buildStyleAnalyzePrompt(text, fingerprint, options.name);
    const res = await generateJSON<{
      profileName?: string;
      authorStyle?: string;
      styleGuide?: string;
      doList?: string[];
      dontList?: string[];
      analysis?: string;
    }>(messages, 0.45);

    const name =
      (options.name || res.profileName || '仿写文风').trim().slice(0, 40) || '仿写文风';
    const profile: StyleProfile = {
      id,
      name,
      sourceLabel: options.sourceLabel || '粘贴样本',
      fingerprint,
      styleGuide: (res.styleGuide || '').trim() || heuristicGuide(fingerprint),
      doList: (res.doList || []).map(String).filter(Boolean).slice(0, 10),
      dontList: (res.dontList || []).map(String).filter(Boolean).slice(0, 10),
      authorStyle: (res.authorStyle || '').trim() || heuristicAuthorStyle(fingerprint),
      sampleExcerpt,
      analysis: (res.analysis || '').trim() || formatFingerprintSummary(fingerprint),
      createdAt: now,
      updatedAt: now,
    };
    if (!profile.doList.length) profile.doList = heuristicDo(fingerprint);
    if (!profile.dontList.length) profile.dontList = heuristicDont();
    options.onProgress?.(`文风档案已生成：${profile.name}`);
    return { profile, fingerprintOnly: false };
  } catch (e: any) {
    options.onProgress?.(
      `模型指南失败，使用指纹启发式：${e?.message || e}`
    );
    const profile: StyleProfile = {
      id,
      name: (options.name || '仿写文风·指纹').trim().slice(0, 40),
      sourceLabel: options.sourceLabel || '粘贴样本',
      fingerprint,
      styleGuide: heuristicGuide(fingerprint),
      doList: heuristicDo(fingerprint),
      dontList: heuristicDont(),
      authorStyle: heuristicAuthorStyle(fingerprint),
      sampleExcerpt,
      analysis: `本地指纹模式。${formatFingerprintSummary(fingerprint)}`,
      createdAt: now,
      updatedAt: now,
    };
    return { profile, fingerprintOnly: true };
  }
}

function heuristicAuthorStyle(fp: StyleFingerprint): string {
  if (fp.shortSentenceRatio >= 0.45) return '短句利落，动作推进快，少解释腔';
  if (fp.dialogueRatio >= 0.28) return '对白推动情节，叙述克制，现场感强';
  if (fp.avgSentenceLen >= 28) return '长句铺陈，信息密，语感沉稳';
  return '句长中等，场景与动作并重，克制不煽';
}

function heuristicGuide(fp: StyleFingerprint): string {
  return [
    `参考样本约 ${fp.charCount} 字，均句长 ${fp.avgSentenceLen}，短句占比 ${Math.round(fp.shortSentenceRatio * 100)}%，对白约 ${Math.round(fp.dialogueRatio * 100)}%。`,
    '写作时贴近上述节奏：短句处加快切镜，长句处压场景与因果，勿写成均匀 AI 流水句。',
    '情绪用动作与道具落地；章末落在具体动作/对白，禁止升华说教。',
    fp.topPhrases.length
      ? `可吸收样本语感片语的使用频率感（勿整段照搬）：${fp.topPhrases.slice(0, 6).join('、')}。`
      : '',
  ]
    .filter(Boolean)
    .join('');
}

function heuristicDo(fp: StyleFingerprint): string[] {
  const list = [
    `控制均句长靠近 ${fp.avgSentenceLen} 字`,
    '用具体动作与感官代替情绪标签',
    '场景变化要有道具/身体反馈',
  ];
  if (fp.dialogueRatio >= 0.2) list.push('适当用对白推进冲突与信息差');
  if (fp.shortSentenceRatio >= 0.35) list.push('冲突段多用短句切断节奏');
  list.push('章末定格在动作或冷语，不写感悟');
  return list;
}

function heuristicDont(): string[] {
  return [
    '禁止「那一刻/倒吸一口凉气/嘴角一抹弧度」等套话',
    '禁止章末升华与命运说教',
    '禁止均匀长句说明文腔',
    '禁止重复上章开篇氛围模板',
  ];
}

/**
 * 合并 styleConfig 时保护文风仿写档案 / few-shot，避免陈旧整表覆盖把 styleProfiles 冲掉。
 * - 若 patch 显式带数组（含空数组），以 patch 为准（支持删除）
 * - 若 patch 未带该字段，保留 base
 */
export function mergeStyleConfigPreserve(
  base: StyleConfig | null | undefined,
  patch: Partial<StyleConfig> | StyleConfig
): StyleConfig {
  const b = (base || {}) as StyleConfig;
  const p = patch || {};
  const next: StyleConfig = {
    ...b,
    ...p,
    clicheBlacklist: Array.isArray(p.clicheBlacklist)
      ? p.clicheBlacklist
      : b.clicheBlacklist || [],
    customBlacklist: Array.isArray(p.customBlacklist)
      ? p.customBlacklist
      : b.customBlacklist || [],
    fewShotExamples: Array.isArray(p.fewShotExamples)
      ? p.fewShotExamples
      : b.fewShotExamples || [],
    deslopWhitelist: Array.isArray(p.deslopWhitelist)
      ? p.deslopWhitelist
      : b.deslopWhitelist,
    styleProfiles: Array.isArray(p.styleProfiles)
      ? p.styleProfiles
      : b.styleProfiles,
  };
  if ('activeStyleProfileId' in p) {
    next.activeStyleProfileId = p.activeStyleProfileId;
  } else {
    next.activeStyleProfileId = b.activeStyleProfileId;
  }
  if (!next.selectedExampleId) {
    next.selectedExampleId = b.selectedExampleId || '';
  }
  return next;
}

/** import：写入档案库并可选激活 + 同步 few-shot 卡片 */
export function importStyleProfile(
  styleConfig: StyleConfig,
  profile: StyleProfile,
  options?: { activate?: boolean; syncFewShot?: boolean }
): StyleConfig {
  const activate = options?.activate !== false;
  const syncFewShot = options?.syncFewShot !== false;
  const profiles = [...(styleConfig.styleProfiles || [])];
  const idx = profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) profiles[idx] = profile;
  else profiles.unshift(profile);

  let fewShotExamples = [...(styleConfig.fewShotExamples || [])];
  let selectedExampleId = styleConfig.selectedExampleId;

  if (syncFewShot) {
    const fewId = `few-style-${profile.id}`;
    const example: FewShotExample = {
      id: fewId,
      title: `仿写·${profile.name}`,
      authorStyle: profile.authorStyle,
      content: profile.sampleExcerpt,
      analysis: profile.analysis || profile.styleGuide.slice(0, 200),
    };
    const fi = fewShotExamples.findIndex((e) => e.id === fewId || e.title === example.title);
    if (fi >= 0) fewShotExamples[fi] = example;
    else fewShotExamples = [example, ...fewShotExamples];
    if (activate) selectedExampleId = fewId;
  }

  return {
    ...styleConfig,
    styleProfiles: profiles.slice(0, 20),
    activeStyleProfileId: activate ? profile.id : styleConfig.activeStyleProfileId,
    fewShotExamples,
    selectedExampleId,
  };
}

export function setActiveStyleProfile(
  styleConfig: StyleConfig,
  profileId: string | null
): StyleConfig {
  if (!profileId) {
    return { ...styleConfig, activeStyleProfileId: null };
  }
  const exists = (styleConfig.styleProfiles || []).some((p) => p.id === profileId);
  if (!exists) return styleConfig;
  const profile = styleConfig.styleProfiles!.find((p) => p.id === profileId)!;
  // 同步选中对应 few-shot（若有）
  const fewId = `few-style-${profile.id}`;
  const hasFew = (styleConfig.fewShotExamples || []).some((e) => e.id === fewId);
  return {
    ...styleConfig,
    activeStyleProfileId: profileId,
    selectedExampleId: hasFew ? fewId : styleConfig.selectedExampleId,
  };
}

export function removeStyleProfile(
  styleConfig: StyleConfig,
  profileId: string
): StyleConfig {
  const profiles = (styleConfig.styleProfiles || []).filter((p) => p.id !== profileId);
  const fewId = `few-style-${profileId}`;
  const fewShotExamples = (styleConfig.fewShotExamples || []).filter((e) => e.id !== fewId);
  const activeStyleProfileId =
    styleConfig.activeStyleProfileId === profileId
      ? null
      : styleConfig.activeStyleProfileId;
  const selectedExampleId =
    styleConfig.selectedExampleId === fewId
      ? fewShotExamples[0]?.id || ''
      : styleConfig.selectedExampleId;
  return {
    ...styleConfig,
    styleProfiles: profiles,
    activeStyleProfileId,
    fewShotExamples,
    selectedExampleId,
  };
}

export function updateStyleProfile(
  styleConfig: StyleConfig,
  profileId: string,
  patch: Partial<StyleProfile>
): StyleConfig {
  const profiles = (styleConfig.styleProfiles || []).map((p) =>
    p.id === profileId
      ? { ...p, ...patch, id: p.id, updatedAt: new Date().toISOString() }
      : p
  );
  return { ...styleConfig, styleProfiles: profiles };
}
