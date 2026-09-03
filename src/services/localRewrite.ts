import type { Chapter, Character, StyleConfig, StoryMemory, WorldSetting } from '../types/novel';
import { generateText } from './llmClient';
import { formatIntentForPrompt } from './chapterIntent';
import { formatStoryMemoryForPrompt } from './storyMemory';
import {
  formatStyleConstraintsForRewrite,
  getActiveStyleProfile,
} from './styleImitate';

export type LocalRewriteAction =
  | 'remove_cliche'
  | 'strip_sublimation'
  | 'expand'
  | 'compress'
  | 'more_restrained'
  | 'more_intense'
  | 'check_logic';

export const LOCAL_REWRITE_ACTIONS: {
  id: LocalRewriteAction;
  label: string;
  title: string;
  mutates: boolean;
}[] = [
  { id: 'remove_cliche', label: '去AI味', title: '清除套话与模板句', mutates: true },
  { id: 'compress', label: '压缩', title: '删注水，保留信息量', mutates: true },
  { id: 'expand', label: '扩写', title: '感官与微动作扩写', mutates: true },
  { id: 'more_restrained', label: '更克制', title: '降温煽情，少形容词', mutates: true },
  { id: 'more_intense', label: '更狠', title: '冲突更锋利，仍忌升华', mutates: true },
  { id: 'strip_sublimation', label: '截升华', title: '去掉说教与哲理收尾', mutates: true },
  { id: 'check_logic', label: '硬伤瞥', title: '只评估不改正文', mutates: false },
];

export interface LocalRewriteContext {
  chapter: Pick<Chapter, 'number' | 'title' | 'summary' | 'intent'>;
  characters?: Character[];
  settings?: WorldSetting[];
  styleConfig?: StyleConfig | null;
  storyMemory?: StoryMemory | null;
  /** 本书题材：文风档案题材不匹配时降级为只学文笔层 */
  bookGenre?: string | null;
  /** 选区前后各取若干字作为语境 */
  surroundingBefore?: string;
  surroundingAfter?: string;
}

function buildContextBlock(ctx: LocalRewriteContext): string {
  const parts: string[] = [];
  parts.push(`【章节】第${ctx.chapter.number}章《${ctx.chapter.title}》`);
  if (ctx.chapter.summary?.trim()) {
    parts.push(`【本章梗概】${ctx.chapter.summary.trim().slice(0, 200)}`);
  }
  if (ctx.chapter.intent) {
    parts.push(`【写前意图】\n${formatIntentForPrompt(ctx.chapter.intent).slice(0, 600)}`);
  }
  if (ctx.storyMemory && ctx.characters) {
    const mem = formatStoryMemoryForPrompt(ctx.storyMemory, ctx.characters, {
      maxFacts: 8,
      maxThreads: 5,
    });
    parts.push(`【书级记忆摘要】\n${mem.slice(0, 900)}`);
  }
  const styleBlock = formatStyleConstraintsForRewrite(ctx.styleConfig, {
    profileMaxChars: 1000,
    fewShotMaxChars: 260,
    blacklistMax: 25,
    bookGenre: ctx.bookGenre,
  });
  if (styleBlock) parts.push(styleBlock);
  if (ctx.surroundingBefore?.trim()) {
    parts.push(`【前文语境】…${ctx.surroundingBefore.trim().slice(-160)}`);
  }
  if (ctx.surroundingAfter?.trim()) {
    parts.push(`【后文语境】${ctx.surroundingAfter.trim().slice(0, 160)}…`);
  }
  return parts.join('\n\n');
}

function actionInstruction(action: LocalRewriteAction): string {
  switch (action) {
    case 'remove_cliche':
      return (
        '清洗 AI 套话与网文滥调，改为具体动作/感官。改最少：能换词不换句，能删一词不重写段。' +
        '重点处理：不是…而是…、…带着…、解释腔（她不知道的是/之所以…是因为）、连续排比。' +
        '不得改变情节结果与专有名词；禁止章末式升华。'
      );
    case 'strip_sublimation':
      return '删除哲理、命运说教、总结升华、上帝感旁白；在具体动作/对白/道具处收住。改最少，保剧情。';
    case 'expand':
      return '在信息不变前提下做感官与微动作扩写（Show don\'t tell），长度约为原文 1.3–1.8 倍，勿注水闲笔。';
    case 'compress':
      return '压缩注水与重复，保留关键信息与锋利句子，长度约为原文 50–70%。';
    case 'more_restrained':
      return '更克制：少形容词与煽情，短句，冷一点；情节结果不变。';
    case 'more_intense':
      return '更狠：冲突与信息差更锋利，压迫感更强；仍禁止升华说教，不改主线结果。';
    case 'check_logic':
      return '只做硬伤瞥见评估（战力/状态/吃书/时间线），80 字内结论；不要改写正文。';
    default:
      return '改写该片段。';
  }
}

/**
 * 局部重写：注入书级记忆与写前意图，避免改崩事实。
 * mutates 类动作只返回纯片段；check_logic 返回评估文本。
 */
export async function runLocalRewrite(
  selectedText: string,
  action: LocalRewriteAction,
  ctx: LocalRewriteContext
): Promise<{ text: string; mutates: boolean }> {
  const selected = selectedText.trim();
  if (!selected) throw new Error('未选中文本');

  const mutates = action !== 'check_logic';
  const contextBlock = buildContextBlock(ctx);

  const styleName = getActiveStyleProfile(ctx.styleConfig)?.name;
  const styleLine = styleName
    ? `5. 文风必须贴近已激活仿写「${styleName}」与下方风格约束，禁止通用 AI 网文腔。`
    : `5. 文风必须对齐下方风格约束 / few-shot，禁止通用 AI 网文腔。`;

  const system = mutates
    ? `你是连载小说的「局部精修编辑」，改写须服从本书文风设定。
硬性规则：
1. 只输出改写后的纯正文片段，无解释、无标题、无引号包裹整段。
2. 不得推翻书级钉死事实与写前禁止项。
3. 不得改变选区外情节；与前后语境自然衔接。
4. 禁止黑名单套话与章末式升华（即便在段中）。
${styleLine}`
    : `你是连载「硬伤瞥见官」。只输出简短评估（≤80字），指出是否有战力/状态/吃书/时间线问题；无问题写「未见明显硬伤」。不要改写正文。`;

  const user = `${contextBlock}

【任务】${actionInstruction(action)}${
    mutates ? '；改写时严格保持本书设定文风。' : ''
  }

【待处理选区】
${selected}`;

  const out = (
    await generateText(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      mutates ? 0.65 : 0.3
    )
  ).trim();

  if (!out) throw new Error('模型返回空结果');

  // 去掉偶发的代码围栏
  let text = out;
  if (text.startsWith('```')) {
    const lines = text.split('\n');
    if (lines[0].startsWith('```')) lines.shift();
    if (lines[lines.length - 1]?.startsWith('```')) lines.pop();
    text = lines.join('\n').trim();
  }

  return { text, mutates };
}

/** 取选区前后语境 */
export function sliceSurroundings(
  full: string,
  start: number,
  end: number,
  radius = 180
): { before: string; after: string } {
  const before = full.slice(Math.max(0, start - radius), start);
  const after = full.slice(end, Math.min(full.length, end + radius));
  return { before, after };
}
