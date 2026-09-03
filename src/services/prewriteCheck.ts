import type {
  Chapter,
  Character,
  ProjectConfig,
  StoryMemory,
  StyleConfig,
  WorldSetting,
} from '../types/novel';
import type { PreviousContextPack } from './contextPack';
import { isChapterLocked, lockReason } from './chapterLock';
import { memorySummaryCounts } from './storyMemory';
import { retrieveMemoryForChapter } from './memoryRetrieval';
import { hasIntentDraft, isIntentConfirmed } from './chapterIntent';
import { resolveChapterWordTarget, contentWordsOrFallback } from './proseWords';

export type PrewriteSeverity = 'ok' | 'warn' | 'error';

export interface PrewriteIssue {
  id: string;
  severity: PrewriteSeverity;
  title: string;
  detail: string;
  /** 建议用户怎么修 */
  hint?: string;
}

export interface PrewriteCheckItem {
  id: string;
  label: string;
  severity: PrewriteSeverity;
  summary: string;
  detail?: string;
}

export interface PrewriteCheckReport {
  overall: PrewriteSeverity;
  /** 可否建议开写：error 级仍可强行写，但 UI 应二次确认 */
  canWriteSafely: boolean;
  score: number;
  items: PrewriteCheckItem[];
  issues: PrewriteIssue[];
  /** 将注入的资源摘要，给 UI 展示 */
  inject: {
    previousPreview: string;
    isFirstChapter: boolean;
    characterNames: string[];
    settingNames: string[];
    hardRuleCount: number;
    styleExampleTitle: string | null;
    blacklistCount: number;
    targetWords: number | null;
    chapterSummaryPreview: string;
    enforceShowDontTell: boolean;
    forbidEndingSublimation: boolean;
  };
}

export interface BuildPrewriteCheckInput {
  chapter: Chapter;
  allCharacters: Character[];
  allSettings: WorldSetting[];
  styleConfig: StyleConfig;
  previousContextPack: PreviousContextPack | null;
  projectConfig?: ProjectConfig | null;
  storyMemory?: StoryMemory | null;
  /** 默认占位梗概（新建章时的提示文案），命中则当「未写梗概」 */
  placeholderSummaryPatterns?: string[];
}

const DEFAULT_PLACEHOLDERS = [
  '在此写下章节核心情节钩子与高潮转折',
  '点击右侧按钮调用三步推理',
  '请输入',
  '待填写',
];

function isPlaceholderSummary(summary: string, patterns: string[]): boolean {
  const s = summary.trim();
  if (!s) return true;
  if (s.length < 12) return true;
  return patterns.some((p) => s.includes(p));
}

function maxSeverity(a: PrewriteSeverity, b: PrewriteSeverity): PrewriteSeverity {
  const rank = { ok: 0, warn: 1, error: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * 写前上下文体检：汇总将注入模型的上下文是否齐全、有无明显缺料。
 * 纯函数，不调 LLM。
 */
export function buildPrewriteCheckReport(input: BuildPrewriteCheckInput): PrewriteCheckReport {
  const {
    chapter,
    allCharacters,
    allSettings,
    styleConfig,
    previousContextPack: pack,
    projectConfig,
    storyMemory,
  } = input;
  const patterns = input.placeholderSummaryPatterns || DEFAULT_PLACEHOLDERS;

  const items: PrewriteCheckItem[] = [];
  const issues: PrewriteIssue[] = [];
  let overall: PrewriteSeverity = 'ok';

  const push = (item: PrewriteCheckItem, issue?: Omit<PrewriteIssue, 'severity'> & { severity?: PrewriteSeverity }) => {
    items.push(item);
    overall = maxSeverity(overall, item.severity);
    if (item.severity !== 'ok' && issue) {
      issues.push({
        id: issue.id || item.id,
        severity: issue.severity || item.severity,
        title: issue.title,
        detail: issue.detail,
        hint: issue.hint,
      });
    } else if (item.severity !== 'ok') {
      issues.push({
        id: item.id,
        severity: item.severity,
        title: item.label,
        detail: item.summary,
        hint: item.detail,
      });
    }
  };

  // —— 0. 写前大纲意图 ——
  if (isIntentConfirmed(chapter.intent)) {
    push({
      id: 'chapter_intent',
      label: '写前大纲',
      severity: 'ok',
      summary: `已确认 · 目标${chapter.intent!.mustDo.length} · 禁止${chapter.intent!.mustAvoid.length}`,
      detail: `钩子：${chapter.intent!.endingHook}`,
    });
  } else if (hasIntentDraft(chapter.intent)) {
    push({
      id: 'chapter_intent',
      label: '写前大纲',
      severity: 'warn',
      summary: '有草稿但未确认',
      detail: '请点「确认大纲」后再开写；未确认也可强行写，但易偏题。',
    });
  } else {
    push({
      id: 'chapter_intent',
      label: '写前大纲',
      severity: 'error',
      summary: '尚未生成目标/禁止/钩子',
      detail: '右侧「写前大纲确认」→ AI 生成 → 确认大纲。Auto-Pilot 会自动补全。',
    });
  }

  // —— 1. 本章梗概 ——
  const summary = (chapter.summary || '').trim();
  const summaryIsPlaceholder = isPlaceholderSummary(summary, patterns);
  if (!summary || summaryIsPlaceholder) {
    push(
      {
        id: 'chapter_summary',
        label: '本章梗概',
        severity: 'error',
        summary: summaryIsPlaceholder ? '仍是占位提示，未写真实大纲' : '梗概为空',
        detail: '请在左侧编辑区写清本章目标、冲突与章末钩子（建议 ≥30 字）。',
      },
      {
        id: 'chapter_summary',
        title: '缺少可用大纲',
        detail: '没有真实梗概时模型容易胡写或重复开书。',
        hint: '在写作画布上方/章节摘要处填写本章情节再开写。',
      }
    );
  } else if (summary.length < 30) {
    push({
      id: 'chapter_summary',
      label: '本章梗概',
      severity: 'warn',
      summary: `过短（${summary.length} 字），信息可能不够`,
      detail: summary.slice(0, 80),
    });
  } else {
    push({
      id: 'chapter_summary',
      label: '本章梗概',
      severity: 'ok',
      summary: `已就绪（${summary.length} 字）`,
      detail: summary.length > 100 ? `${summary.slice(0, 100)}…` : summary,
    });
  }

  // —— 2. 上章前情 ——
  if (!pack) {
    push({
      id: 'previous_context',
      label: '上章前情',
      severity: 'warn',
      summary: '前情包未组装',
      detail: '选择章节后应自动生成 previousContext。',
    });
  } else if (pack.isFirstChapter) {
    push({
      id: 'previous_context',
      label: '上章前情',
      severity: 'ok',
      summary: '开篇章 · 无上章可承（正常）',
      detail: pack.preview,
    });
  } else {
    const missingBits: string[] = [];
    if (!pack.hasRecap) missingBits.push('无 recap');
    if (!pack.hasContentTail) missingBits.push('无正文尾段');
    if (!pack.hasSummary) missingBits.push('无大纲');

    if (!pack.hasRecap && !pack.hasContentTail) {
      push({
        id: 'previous_context',
        label: '上章前情',
        severity: 'error',
        summary: `上章《${pack.sourceChapterTitle || pack.sourceChapterNumber}》几乎无记忆可注`,
        detail: '建议先完成上章闭环（生成 recap），或至少保留上章正文。',
      });
    } else if (!pack.hasRecap) {
      push({
        id: 'previous_context',
        label: '上章前情',
        severity: 'warn',
        summary: `已组装但缺 recap（${missingBits.join(' · ') || '部分缺失'}）`,
        detail: pack.preview + ' · 将主要依赖大纲/尾段，连贯性较弱。',
      });
    } else {
      push({
        id: 'previous_context',
        label: '上章前情',
        severity: 'ok',
        summary: pack.preview,
        detail: `recap ${pack.recapChars}字 · 尾段 ${pack.tailChars}字 · 近章链 ${pack.recentSummaryCount}`,
      });
    }
  }

  // —— 3. 角色切片 ——
  const activeChars = allCharacters.filter((c) =>
    (chapter.involvedCharacterIds || []).includes(c.id)
  );
  if (allCharacters.length === 0) {
    push({
      id: 'characters',
      label: '角色注入',
      severity: 'error',
      summary: '全书尚无角色卡',
      detail: '请到「设定与角色图谱」创建主角/配角，或通过开书向导生成。',
    });
  } else if (activeChars.length === 0) {
    push({
      id: 'characters',
      label: '角色注入',
      severity: 'warn',
      summary: '本章未关联角色（将弱注入）',
      detail: '可在章节 involvedCharacterIds 或大纲中绑定人物，避免人设漂移。',
    });
  } else {
    const thin = activeChars.filter(
      (c) => !(c.personality || '').trim() && !(c.background || '').trim()
    );
    if (thin.length === activeChars.length) {
      push({
        id: 'characters',
        label: '角色注入',
        severity: 'warn',
        summary: `将注入 ${activeChars.length} 人，但人设字段偏空`,
        detail: activeChars.map((c) => c.name).join('、'),
      });
    } else {
      push({
        id: 'characters',
        label: '角色注入',
        severity: 'ok',
        summary: `将注入 ${activeChars.length} 人：${activeChars.map((c) => c.name).join('、')}`,
        detail: activeChars
          .map((c) => `${c.name}（${c.status}/${c.currentLocation || '地点未设'}）`)
          .join('； ')
          .slice(0, 200),
      });
    }
  }

  // —— 4. 设定/硬规则 ——
  const activeSets = allSettings.filter((s) =>
    (chapter.involvedSettingIds || []).includes(s.id)
  );
  const hardRuleCount = activeSets.reduce(
    (n, s) => n + (s.hardRules?.filter((r) => r.trim()).length || 0),
    0
  );
  if (allSettings.length === 0) {
    push({
      id: 'settings',
      label: '设定红线',
      severity: 'warn',
      summary: '全书尚无世界观设定',
      detail: '无硬规则时战力/法则更容易崩，建议至少加 1～3 条红线。',
    });
  } else if (activeSets.length === 0) {
    push({
      id: 'settings',
      label: '设定红线',
      severity: 'warn',
      summary: '本章未关联设定条目',
      detail: `书中共有 ${allSettings.length} 条设定，本章未勾选。`,
    });
  } else if (hardRuleCount === 0) {
    push({
      id: 'settings',
      label: '设定红线',
      severity: 'warn',
      summary: `关联 ${activeSets.length} 条设定，但无 hardRules`,
      detail: activeSets.map((s) => s.name).join('、'),
    });
  } else {
    push({
      id: 'settings',
      label: '设定红线',
      severity: 'ok',
      summary: `关联 ${activeSets.length} 条设定 · ${hardRuleCount} 条硬规则`,
      detail: activeSets.map((s) => s.name).join('、'),
    });
  }

  // —— 5. 文风与去 AI 味 ——
  const bl =
    (styleConfig.clicheBlacklist?.length || 0) + (styleConfig.customBlacklist?.length || 0);
  const example = styleConfig.fewShotExamples?.find((e) => e.id === styleConfig.selectedExampleId);
  const activeStyleProfile = (styleConfig.styleProfiles || []).find(
    (p) => p.id === styleConfig.activeStyleProfileId
  );
  const styleBits: string[] = [];
  if (activeStyleProfile) styleBits.push(`仿写「${activeStyleProfile.name}」`);
  if (example) styleBits.push(`范例「${example.title}」`);
  else if (!activeStyleProfile) styleBits.push('未选 few-shot 范例');
  styleBits.push(styleConfig.enforceShowDontTell ? 'Show-don\'t-tell 开' : 'SdT 关');
  styleBits.push(styleConfig.forbidEndingSublimation ? '禁升华 开' : '禁升华 关');
  styleBits.push(`黑名单 ${bl} 条`);

  if (activeStyleProfile) {
    push({
      id: 'style_imitate',
      label: '文风仿写',
      severity: 'ok',
      summary: `已激活「${activeStyleProfile.name}」· 均句长 ${activeStyleProfile.fingerprint.avgSentenceLen} · 对白约 ${Math.round(activeStyleProfile.fingerprint.dialogueRatio * 100)}%`,
      detail: activeStyleProfile.authorStyle,
    });
  }

  if (!example && !activeStyleProfile) {
    push({
      id: 'style',
      label: '文风约束',
      severity: 'warn',
      summary: styleBits.join(' · '),
      detail: '建议在「引擎与风格」做文风仿写分析，或选中一条 few-shot。',
    });
  } else if (bl === 0 && !styleConfig.forbidEndingSublimation) {
    push({
      id: 'style',
      label: '文风约束',
      severity: 'warn',
      summary: styleBits.join(' · '),
      detail: '黑名单与禁升华均弱，AI 味可能较重。',
    });
  } else {
    push({
      id: 'style',
      label: '文风约束',
      severity: 'ok',
      summary: styleBits.join(' · '),
    });
  }

  // —— 6. 字数目标 ——
  const targetWords = resolveChapterWordTarget(projectConfig);
  if (targetWords && targetWords > 0) {
    push({
      id: 'word_target',
      label: '字数目标',
      severity: 'ok',
      summary: `约 ${targetWords} 字/章（项目配置）`,
      detail: '当前管线以风格与分镜为主，字数目标作提示注入。',
    });
  } else {
    push({
      id: 'word_target',
      label: '字数目标',
      severity: 'warn',
      summary: '未设置每章目标字数',
      detail: '可在项目配置中设置 targetWordCountPerChapter。',
    });
  }

  // —— 6.5 书级权威记忆（相关检索 + 伏笔债务） ——
  const memCounts = memorySummaryCounts(storyMemory);
  const retrieval = retrieveMemoryForChapter({
    chapter,
    memory: storyMemory,
    characters: allCharacters,
    chapterNumber: chapter.number,
  });
  const debts = retrieval.debtThreads;
  if (chapter.number > 1 && memCounts.facts === 0 && memCounts.threads === 0) {
    push({
      id: 'story_memory',
      label: '书级记忆',
      severity: 'warn',
      summary: '第2章+仍无钉死事实/未收伏笔',
      detail: '建议到「设定与角色 → 书级记忆」手写关键事实，或先完成上章闭环以自动汇入 recap。',
    });
  } else if (memCounts.facts === 0 && memCounts.threads === 0) {
    push({
      id: 'story_memory',
      label: '书级记忆',
      severity: 'ok',
      summary: '开篇阶段，记忆为空属正常',
      detail: '写完本章后会自动从 recap 汇入事实与伏笔。',
    });
  } else {
    push({
      id: 'story_memory',
      label: '书级记忆',
      severity: debts.length > 0 ? 'warn' : 'ok',
      summary: `相关注入 ${retrieval.facts.length} 事实 · ${retrieval.threads.length} 伏笔${
        debts.length ? ` · 债务 ${debts.length}` : ''
      }${retrieval.snapshot.semanticUsed ? ' · 语义' : ''}${
        retrieval.relatedChapters?.length
          ? ` · 相关章${retrieval.relatedChapters.length}`
          : ''
      }`,
      detail: [
        retrieval.snapshot.preview,
        ...retrieval.facts.slice(0, 2).map((f) => `事实：${f.fact.text}`),
        ...debts.slice(0, 2).map((t) => `债务静默${t.silence}章：${t.thread.text}`),
        ...(retrieval.relatedChapters || [])
          .slice(0, 2)
          .map((r) => `相关第${r.chapter.number}章《${r.chapter.title}》`),
      ]
        .filter(Boolean)
        .join('； ')
        .slice(0, 280),
    });
  }

  if (debts.length > 0) {
    push({
      id: 'memory_debt',
      label: '伏笔债务',
      severity: debts.some((d) => d.silence >= 10) ? 'error' : 'warn',
      summary: `${debts.length} 条伏笔静默过久，本章应推进/回收/延期`,
      detail: debts
        .slice(0, 4)
        .map((d) => `静默${d.silence}章 · ${d.thread.text}`)
        .join('； '),
    });
  }

  // 展示上次写前快照（若有）
  if (chapter.memoryInjection?.preview) {
    push({
      id: 'memory_snapshot',
      label: '上次记忆快照',
      severity: 'ok',
      summary: chapter.memoryInjection.preview,
      detail: `词项：${(chapter.memoryInjection.queryTerms || []).slice(0, 6).join(' / ') || '—'}`,
    });
  }

  // —— 7. 定稿锁定 / 覆盖风险 ——
  const existingWords =
    contentWordsOrFallback(chapter.content, chapter.wordCount) || 0;
  if (isChapterLocked(chapter)) {
    push({
      id: 'overwrite_risk',
      label: '定稿锁定',
      severity: 'error',
      summary: lockReason(chapter),
      detail: '流水线默认拒绝覆盖。强制重写需确认解锁；Auto-Pilot 会跳过本章。',
    });
  } else if (existingWords >= 200) {
    push({
      id: 'overwrite_risk',
      label: '覆盖风险',
      severity: 'warn',
      summary: `本章已有约 ${existingWords} 字正文，重跑将清空重写`,
      detail: '开写前会自动「写前快照」。重要段落请先导出 JSON 或手动快照。',
    });
  } else {
    push({
      id: 'overwrite_risk',
      label: '覆盖风险',
      severity: 'ok',
      summary: existingWords > 0 ? `仅有草稿 ${existingWords} 字` : '尚无正文，可安全开写',
    });
  }

  // —— 8. 章节状态 ——
  if (isChapterLocked(chapter)) {
    push({
      id: 'chapter_status',
      label: '章节状态',
      severity: 'error',
      summary: `已锁定 · ${chapter.status}`,
      detail: '请先「解锁重写」，或使用「强制重写」并确认。',
    });
  } else if (chapter.status === '校验通过') {
    push({
      id: 'chapter_status',
      label: '章节状态',
      severity: 'warn',
      summary: '状态为「校验通过」但已解锁，重跑会覆盖正文',
      detail: '确认后可开写；写完机检通过会再次自动锁定。',
    });
  } else if (chapter.status === '待人工确认' || chapter.status === '机检未通过') {
    push({
      id: 'chapter_status',
      label: '章节状态',
      severity: 'ok',
      summary: `状态「${chapter.status}」· 可重跑修复或人工定稿锁定`,
    });
  } else {
    push({
      id: 'chapter_status',
      label: '章节状态',
      severity: 'ok',
      summary: `状态「${chapter.status || '未标注'}」`,
    });
  }

  const errorCount = items.filter((i) => i.severity === 'error').length;
  const warnCount = items.filter((i) => i.severity === 'warn').length;
  // 分数：满分 100，error -25，warn -8
  const score = Math.max(0, Math.min(100, 100 - errorCount * 25 - warnCount * 8));

  return {
    overall,
    canWriteSafely: errorCount === 0,
    score,
    items,
    issues: issues.filter((i) => i.severity !== 'ok'),
    inject: {
      previousPreview: pack?.preview || '—',
      isFirstChapter: !!pack?.isFirstChapter,
      characterNames: activeChars.map((c) => c.name),
      settingNames: activeSets.map((s) => s.name),
      hardRuleCount,
      styleExampleTitle: example?.title || null,
      blacklistCount: bl,
      targetWords,
      chapterSummaryPreview: summary
        ? summary.length > 120
          ? `${summary.slice(0, 120)}…`
          : summary
        : '（空）',
      enforceShowDontTell: !!styleConfig.enforceShowDontTell,
      forbidEndingSublimation: !!styleConfig.forbidEndingSublimation,
    },
  };
}

export function overallPrewriteLabel(overall: PrewriteSeverity): string {
  switch (overall) {
    case 'ok':
      return '就绪 · 可开写';
    case 'warn':
      return '可写 · 有警告';
    case 'error':
      return '缺料 · 建议先补';
    default:
      return overall;
  }
}
