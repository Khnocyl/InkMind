import type { Chapter, ChapterIntent, Character, StoryMemory, StyleConfig, WorldSetting } from '../types/novel';
import type { PreviousContextPack } from './contextPack';
import { generateJSON, resolveRoleRouteAsync } from './llmClient';
import { formatStoryMemoryForPrompt } from './storyMemory';
import { listMemoryDebts, retrieveMemoryForChapter } from './memoryRetrieval';

export function emptyIntent(): ChapterIntent {
  return {
    mustDo: [],
    mustAvoid: [],
    endingHook: '',
    emotionalBeats: [],
    confirmed: false,
    source: 'manual',
  };
}

export function normalizeChapterIntent(raw: unknown): ChapterIntent {
  if (!raw || typeof raw !== 'object') return emptyIntent();
  const r = raw as Record<string, unknown>;
  const mustDo = Array.isArray(r.mustDo)
    ? r.mustDo.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 8)
    : [];
  const mustAvoid = Array.isArray(r.mustAvoid)
    ? r.mustAvoid.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 8)
    : [];
  const emotionalBeats = Array.isArray(r.emotionalBeats)
    ? r.emotionalBeats.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    mustDo,
    mustAvoid,
    endingHook: String(r.endingHook || '').trim().slice(0, 200),
    emotionalBeats,
    confirmed: r.confirmed === true,
    confirmedAt: typeof r.confirmedAt === 'string' ? r.confirmedAt : undefined,
    generatedAt: typeof r.generatedAt === 'string' ? r.generatedAt : undefined,
    source:
      r.source === 'llm' ||
      r.source === 'manual' ||
      r.source === 'fallback' ||
      r.source === 'auto_pilot'
        ? r.source
        : 'manual',
  };
}

/** 大纲是否已确认且具备最低可用内容 */
export function isIntentConfirmed(intent?: ChapterIntent | null): boolean {
  if (!intent?.confirmed) return false;
  return intent.mustDo.length >= 1 && intent.endingHook.trim().length >= 4;
}

/** 是否有可编辑的草稿意图（未确认也可展示） */
export function hasIntentDraft(intent?: ChapterIntent | null): boolean {
  if (!intent) return false;
  return (
    intent.mustDo.length > 0 ||
    intent.mustAvoid.length > 0 ||
    intent.endingHook.trim().length > 0
  );
}

export function confirmIntent(intent: ChapterIntent): ChapterIntent {
  return {
    ...intent,
    confirmed: true,
    confirmedAt: new Date().toISOString(),
  };
}

/**
 * Auto-Pilot 用：保证写前大纲达到 isIntentConfirmed 门槛并标已确认。
 * 避免 LLM 缺字段导致 confirmed=true 但仍未过门槛、或后续步骤缺料。
 */
export function ensureAutoPilotIntent(
  intent: ChapterIntent,
  chapter: Pick<Chapter, 'number' | 'title' | 'summary'>
): ChapterIntent {
  const base = normalizeChapterIntent(intent);
  const summary = (chapter.summary || '').trim();
  const mustDo =
    base.mustDo.length > 0
      ? base.mustDo
      : [
          summary
            ? `推进梗概核心：${summary.slice(0, 48)}${summary.length > 48 ? '…' : ''}`
            : `推进第${chapter.number}章核心冲突至少一步`,
          '章末留下可接续的具体动作/信息差钩子',
        ];
  const mustAvoid =
    base.mustAvoid.length > 0
      ? base.mustAvoid
      : ['不得推翻上章已定结果', '禁止章末升华与命运说教'];
  let endingHook = base.endingHook.trim();
  if (endingHook.length < 4) {
    endingHook = summary
      ? `在「${summary.slice(0, 20)}${summary.length > 20 ? '…' : ''}」相关冲突未解处收束`
      : `第${chapter.number}章末以具体动作收束，留下下一动作空间`;
  }
  const emotionalBeats =
    base.emotionalBeats && base.emotionalBeats.length > 0
      ? base.emotionalBeats
      : ['铺垫', '冲突升级', '小幅反转', '钩子收束'];

  return confirmIntent({
    ...base,
    mustDo: mustDo.slice(0, 8),
    mustAvoid: mustAvoid.slice(0, 8),
    endingHook: endingHook.slice(0, 200),
    emotionalBeats: emotionalBeats.slice(0, 8),
    source: 'auto_pilot',
    generatedAt: base.generatedAt || new Date().toISOString(),
  });
}

/** 编辑字段后取消确认，避免过期大纲当确认态 */
export function touchIntentUnconfirmed(intent: ChapterIntent): ChapterIntent {
  return {
    ...intent,
    confirmed: false,
    confirmedAt: undefined,
  };
}

export function formatIntentForPrompt(intent?: ChapterIntent | null): string {
  if (!intent || !hasIntentDraft(intent)) {
    return '（本章写前意图未设定；请严格按梗概与书级记忆推进，勿无目标注水。）';
  }
  const lines: string[] = [];
  lines.push(`确认状态：${intent.confirmed ? '已确认，必须严格执行' : '草稿未确认，仅作参考'}`);
  if (intent.mustDo.length) {
    lines.push('【必须完成 must-do】');
    intent.mustDo.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  }
  if (intent.mustAvoid.length) {
    lines.push('【禁止事项 must-avoid】');
    intent.mustAvoid.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  }
  if (intent.endingHook.trim()) {
    lines.push(`【章末钩子】${intent.endingHook.trim()}`);
  }
  if (intent.emotionalBeats?.length) {
    lines.push('【情绪/爽点节拍】');
    intent.emotionalBeats.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  }
  return lines.join('\n');
}

export function buildChapterIntentPrompt(input: {
  chapter: Pick<Chapter, 'number' | 'title' | 'summary'>;
  characters: Character[];
  settings: WorldSetting[];
  previousContext?: string;
  storyMemory?: StoryMemory | null;
}): { role: string; content: string }[] {
  const { chapter, characters, settings, previousContext, storyMemory } = input;
  const charLine = characters
    .map((c) => `${c.name}（${c.status}/${c.realmOrTitle || '—'}，在${c.currentLocation || '—'}）`)
    .join('； ');
  const rules = settings
    .flatMap((s) => (s.hardRules || []).map((r) => `《${s.name}》${r}`))
    .slice(0, 12)
    .join('\n');
  // 相关检索 + 债务（与写章管线同源）
  const asChapter = chapter as Chapter;
  const retrieval = retrieveMemoryForChapter({
    chapter: {
      ...asChapter,
      id: (asChapter as Chapter).id || `intent-${chapter.number}`,
      wordCount: (asChapter as Chapter).wordCount || 0,
      status: (asChapter as Chapter).status || '大纲待拆',
      content: (asChapter as Chapter).content || '',
      involvedCharacterIds: (asChapter as Chapter).involvedCharacterIds || [],
      involvedSettingIds: (asChapter as Chapter).involvedSettingIds || [],
      beats: (asChapter as Chapter).beats || [],
      lastModified: (asChapter as Chapter).lastModified || '',
    },
    memory: storyMemory,
    characters,
    chapterNumber: chapter.number,
  });
  const facts = retrieval.facts.map((f) => f.fact.text).join('； ');
  const threads = retrieval.threads.map((t) => t.thread.text).join('； ');
  const debts = retrieval.debtThreads
    .map((t) => `静默${t.silence}章:${t.thread.text}`)
    .join('； ');

  const system = `你是网文连载的「章节规划官」。根据梗概、前情与书级记忆，为即将开写的一章产出可执行的写前意图。
要求：
1. mustDo：2–5 条，具体可验收（谁做成了什么），不要空话。
2. mustAvoid：2–5 条，针对吃书、人设崩、战力崩、无故升华、重复开书等。
3. endingHook：一句具体可拍的章末钩子，禁止哲理总结。
4. emotionalBeats：3–5 条情绪/爽点节拍（压迫→反转→释放等）。
5. 不得与已钉死事实冲突；应照顾未收伏笔（推进或延期）。
6. 若存在「伏笔债务」，mustDo 中至少 1 条明确处理其中一条（推进/回收/延期并写清）。
严格只输出 JSON：
{
  "mustDo": ["..."],
  "mustAvoid": ["..."],
  "endingHook": "...",
  "emotionalBeats": ["..."]
}`;

  const user = `【章节】第 ${chapter.number} 章《${chapter.title}》
【梗概】
${chapter.summary || '（无）'}

【前情】
${previousContext?.trim() || '开篇章或无上章'}

【相关钉死事实】${facts || '（无）'}
【相关/债务伏笔】${threads || '（无）'}
【伏笔债务（优先处理）】${debts || '（无）'}
【出场角色】${charLine || '（未绑定）'}
【硬规则摘要】
${rules || '（无）'}

请输出 JSON。`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 启发式兜底（API 失败时） */
export function buildFallbackChapterIntent(
  chapter: Pick<Chapter, 'number' | 'title' | 'summary'>,
  pack?: PreviousContextPack | null,
  storyMemory?: StoryMemory | null
): ChapterIntent {
  const summary = (chapter.summary || '').trim();
  const hook = summary
    ? `在「${summary.slice(0, 24)}${summary.length > 24 ? '…' : ''}」相关冲突未解决处收束，留下下一动作空间`
    : '以具体动作或一句冷语收束，不写哲理';
  const debts = listMemoryDebts(storyMemory, chapter.number).slice(0, 2);
  const debtMust = debts.map(
    (d) =>
      `处理伏笔债务（静默${d.silence}章）：${d.thread.text.slice(0, 36)}${
        d.thread.text.length > 36 ? '…' : ''
      }（推进/回收/延期三选一）`
  );
  return {
    mustDo: [
      summary ? `推进梗概核心：${summary.slice(0, 40)}${summary.length > 40 ? '…' : ''}` : '建立本章核心冲突并推进至少一步',
      pack && !pack.isFirstChapter
        ? `承接第${pack.sourceChapterNumber}章现场，禁止重新开书`
        : '自然起笔，交代必要现场',
      ...debtMust,
      '章末给出可接续的具体钩子',
    ].slice(0, 5),
    mustAvoid: [
      '不得推翻上章已定结果与钉死事实',
      '禁止章末升华、命运说教与总结句',
      '禁止战力/人设无故跳变',
      ...(debts.length
        ? ['禁止让债务伏笔无故消失或装没看见']
        : []),
    ].slice(0, 5),
    endingHook: hook,
    emotionalBeats: ['铺垫压迫', '冲突升级', '小幅反转或信息差', '钩子收束'],
    confirmed: false,
    generatedAt: new Date().toISOString(),
    source: 'fallback',
  };
}

/**
 * 调用 LLM 生成写前意图（默认未确认，需用户点确认；AP 可随后 autoConfirm）。
 */
export async function generateChapterIntent(input: {
  chapter: Pick<Chapter, 'number' | 'title' | 'summary'>;
  characters: Character[];
  settings: WorldSetting[];
  previousContext?: string;
  storyMemory?: StoryMemory | null;
  previousContextPack?: PreviousContextPack | null;
  /** 按角色路由模型：传入书的 styleConfig 时，「写前意图」角色可路由到指定配置档 */
  styleConfig?: StyleConfig | null;
  onProgress?: (msg: string) => void;
}): Promise<ChapterIntent> {
  input.onProgress?.(' [规划] 正在生成写前大纲（目标/禁止/钩子）...');
  try {
    const messages = buildChapterIntentPrompt(input);
    // 角色路由（默认关闭 → undefined = 跟随激活档，行为与从前一致）
    const route = await resolveRoleRouteAsync(
      input.styleConfig?.llmRoleRouting,
      'intent'
    );
    const res = await generateJSON<{
      mustDo?: string[];
      mustAvoid?: string[];
      endingHook?: string;
      emotionalBeats?: string[];
    }>(
      messages,
      0.55,
      route ? { profileId: route.profileId, model: route.modelName } : undefined
    );

    const intent = normalizeChapterIntent({
      mustDo: res.mustDo,
      mustAvoid: res.mustAvoid,
      endingHook: res.endingHook,
      emotionalBeats: res.emotionalBeats,
      confirmed: false,
      generatedAt: new Date().toISOString(),
      source: 'llm',
    });

    if (intent.mustDo.length < 1 || !intent.endingHook) {
      throw new Error('意图字段不完整');
    }
    input.onProgress?.(
      ` [规划] 写前大纲已生成：目标 ${intent.mustDo.length} · 禁止 ${intent.mustAvoid.length} · 待确认`
    );
    return intent;
  } catch (e: any) {
    input.onProgress?.(` [规划警告] 生成失败，使用启发式：${e?.message || e}`);
    return buildFallbackChapterIntent(
      input.chapter,
      input.previousContextPack,
      input.storyMemory
    );
  }
}

/** 供 UI 快速校验完整度 */
export function intentCompleteness(intent?: ChapterIntent | null): {
  score: number;
  missing: string[];
} {
  const missing: string[] = [];
  if (!intent) return { score: 0, missing: ['无写前大纲'] };
  if (intent.mustDo.length < 2) missing.push('目标不足 2 条');
  if (intent.mustAvoid.length < 1) missing.push('缺少禁止项');
  if (intent.endingHook.trim().length < 4) missing.push('缺少章末钩子');
  if (!intent.confirmed) missing.push('未确认');
  const score = Math.max(0, 100 - missing.length * 22);
  return { score, missing };
}

// re-export helper used by prompts path
export { formatStoryMemoryForPrompt };
