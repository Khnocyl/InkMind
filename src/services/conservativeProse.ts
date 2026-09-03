/**
 * R3-A 降级链：本地保守稿生成器。
 * 当正文执笔（step2/Writer）API 彻底失败时，用分镜 beats + 角色/设定素材
 * 生成一段结构完整、可读、非空的过渡正文，保证单章闭环在 API 全挂时仍能产出可用稿。
 * 纯函数、确定性输出（无随机），便于单测与重放。
 */
import { proseWords } from './proseWords';
import type { Character, PlotBeat, WorldSetting } from '../types/novel';

export interface ConservativeProseInput {
  beats: PlotBeat[];
  characters: Character[];
  settings: WorldSetting[];
  /** 上一章正文尾段（可选，用于开篇过渡句） */
  previousContext?: string;
  chapter?: { number?: number; title?: string; summary?: string };
}

export interface ConservativeProseResult {
  prose: string;
  wordCount: number;
  /** 生成本稿的原因说明（展示给用户） */
  reason: string;
}

/** 段落模板池：按 beat 序号轮换，避免连续雷同 */
const OPENERS = [
  '夜色与风声一同沉下来，',
  '这一日并没有多少波澜，',
  '事情发生得比预想中更快，',
  '屋内的烛火晃了晃，',
  '远处的动静传来时，',
  '谁也没有先开口，',
];

const MIDDLES = [
  '脚步声在寂静中格外清晰。',
  '空气似乎凝滞了片刻。',
  '没有人立刻回答。',
  '一切都发生在一瞬间。',
  '局面比预想中更复杂。',
  '彼此的目光在暗处相遇。',
];

const CLOSERS = [
  '而这仅仅是个开始。',
  '真正的答案还在更深处。',
  '今夜注定无眠。',
  '前路未明，却已没有退路。',
  '风从原处吹来，带着新的变数。',
  '沉默被一声轻响打破。',
];

const BEAT_BRIDGES = [
  '紧接着，',
  '然而下一刻，',
  '与此同时，',
  '还未等众人反应过来，',
  '片刻之后，',
  '就在此时，',
];

/** 细节描写句：按 beat 序号轮换，拉长段落、增加画面感 */
const DETAILS = [
  '远处有风穿过廊檐，卷起几片枯叶，打着旋落进阴影里。',
  '指节在袖中收紧，又缓缓松开，呼吸却始终压在喉间。',
  '光从斜上方漏进来，把浮尘照成一条条细长的金线。',
  '脚下的石板带着潮气，每一步都留下浅浅的印痕。',
  '檐角的铜铃轻轻晃动，声音细得几乎听不见。',
  '影子在墙上拉长，又随着烛火明灭而轻轻摇摆。',
];

/** 推进句：承接 beat 描述，让事件继续向前 */
const PROGRESSIONS = [
  '这一变故让在场所有人都绷紧了神经。',
  '局面因此彻底转向，再无人能置身事外。',
  '话虽未出口，决定却已在各自心中落定。',
  '事已至此，迟疑只会让情况更糟。',
  '他们都知道，接下来的每一步都关乎生死。',
  '风未停，人心却已经先一步动了起来。',
];

function pick<T>(arr: T[], index: number): T {
  return arr[index % arr.length];
}

/** 从角色名/设定名中取可用的称呼（去空、去重复，最多各取 3 个） */
function collectNames(
  characters: Character[],
  settings: WorldSetting[]
): { charNames: string[]; settingNames: string[] } {
  const charNames = Array.from(
    new Set(
      (characters || [])
        .map((c) => (c.name || '').trim())
        .filter((n) => n.length >= 1 && n.length <= 8)
    )
  ).slice(0, 3);
  const settingNames = Array.from(
    new Set(
      (settings || [])
        .map((s) => (s.name || '').trim())
        .filter((n) => n.length >= 1 && n.length <= 10)
    )
  ).slice(0, 2);
  return { charNames, settingNames };
}

function summarizeBeats(beats: PlotBeat[]): string {
  return (beats || [])
    .map((b) => b.description || '')
    .filter(Boolean)
    .join('；');
}

/**
 * 按 beats 逐条展开为段落。
 * 每条：起手句 + 前情/设定衔接 + 角色动作 + beat 推进 + 收尾句。
 */
function buildParagraphs(
  beats: PlotBeat[],
  charNames: string[],
  settingNames: string[],
  previousContext: string
): string[] {
  if (!beats.length) {
    const fallback = `四下无人，唯有风声。${charNames.length ? charNames[0] + '独自立在原地，' : ''}心中翻涌着难以言说的情绪。他知道，真正的考验才刚刚开始。`;
    return [fallback];
  }

  const paragraphs: string[] = [];
  const lead = previousContext.replace(/\s+/g, '').slice(-40);
  if (lead && beats.length > 0) {
    paragraphs.push(
      `${lead.length >= 12 ? '前事未了，' : ''}这一章，从${lead.slice(-12)}处继续。`
    );
  }

  beats.forEach((beat, i) => {
    const desc = (beat.description || '').trim();
    const opener = pick(OPENERS, i);
    const middle = pick(MIDDLES, i + 1);
    const closer = pick(CLOSERS, i + 2);
    const bridge = i > 0 ? pick(BEAT_BRIDGES, i) : '';
    const detail = pick(DETAILS, i);
    const progression = pick(PROGRESSIONS, i);

    const charLine = charNames.length
      ? `${charNames[i % charNames.length]}的神色沉了沉，`
      : '有人低声道，';
    const settingLine = settingNames.length
      ? `在${settingNames[i % settingNames.length]}，`
      : '';
    const descLine = desc
      ? desc.length > 60
        ? desc.slice(0, 60)
        : desc
      : '局面悄然起了变化';

    paragraphs.push(
      `${bridge}${opener}${settingLine}${charLine}${middle}${descLine}。${detail}${progression}${closer}`
    );
  });

  return paragraphs;
}

/**
 * 生成保守稿。确定性输出：同输入 → 同输出。
 */
export function buildConservativeProse(
  input: ConservativeProseInput
): ConservativeProseResult {
  const beats = input.beats || [];
  const { charNames, settingNames } = collectNames(
    input.characters || [],
    input.settings || []
  );
  const summary = input.chapter?.summary || summarizeBeats(beats);
  const previousContext = (input.previousContext || '').trim();

  const paragraphs = buildParagraphs(
    beats,
    charNames,
    settingNames,
    previousContext
  );

  // 结尾统一收束：点明本章走向（用 summary 前 40 字）
  const tail = summary.replace(/\s+/g, '').slice(0, 40);
  paragraphs.push(
    tail
      ? `这一章行至此处，指向的正是——${tail}。至于结局如何，且待下回。`
      : '这一章行至此处，暂时收束。至于结局如何，且待下回。'
  );

  const prose = paragraphs.filter(Boolean).join('\n\n').trim();
  return {
    prose,
    wordCount: proseWords(prose),
    reason:
      'LLM 执笔接口连续失败，已生成本地保守稿（模板化、非 AI 生成）。请检查模型配置后重跑本章以获取正式稿。',
  };
}
