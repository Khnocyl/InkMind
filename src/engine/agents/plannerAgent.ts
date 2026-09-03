/**
 * Planner Agent — 分镜编排：本章节奏与分镜设计，不写正文。
 */
import type { PlotBeat } from '../../types/novel';
import { step1_GenerateBeats } from '../../services/aiEngine';
import { formatStyleStructureForPrompt, getActiveStyleProfile } from '../../services/styleImitate';
import type { AgentContext } from '../types';
import { PROSE_DISCIPLINE_ZH } from '../discipline';

export interface PlannerOutput {
  beats: PlotBeat[];
  /** 写入 writer 的纪律提醒 */
  disciplineBlock: string;
}

function fallbackBeats(
  _chapterNumber: number,
  summary: string,
  title: string,
  endingHook?: string
): PlotBeat[] {
  const s = (summary || '').trim() || title;
  return [
    {
      id: `beat-fb-${Date.now()}-1`,
      order: 1,
      description: `开场承接现场，切入：${s.slice(0, 80)}`,
      focusSense: '空间与人物状态',
    },
    {
      id: `beat-fb-${Date.now()}-2`,
      order: 2,
      description: `冲突推进：围绕本章目标升级压力，露出对手或代价`,
      focusSense: '动作与信息差',
    },
    {
      id: `beat-fb-${Date.now()}-3`,
      order: 3,
      description: `章末钩子：${endingHook || '留下下一动作的具体未解点'}`,
      focusSense: '悬念收束',
    },
  ];
}

export async function runPlannerAgent(ctx: AgentContext): Promise<PlannerOutput> {
  const { input, report, hooks } = ctx;
  const { chapter, characters, settings } = input;

  report('plan', `第${chapter.number}章 · [Planner] 拆解分镜与节拍…`);

  let beats: PlotBeat[] = [];
  try {
    beats = await step1_GenerateBeats(
      chapter.summary,
      characters,
      settings,
      (msg) => report('plan', msg.replace(/\[Step 1\/3\]/g, '[Planner]')),
      input.previousContext,
      input.storyMemoryBlock,
      // 规划阶段带上纪律，避免 memo/分镜要求「层层五感」
      [input.chapterIntentBlock, PROSE_DISCIPLINE_ZH, input.genrePackBlock]
        .filter(Boolean)
        .join('\n\n'),
      input.genrePackBlock,
      formatStyleStructureForPrompt(
        getActiveStyleProfile(input.styleConfig),
        input.project.genre
      )
    );
  } catch (err: any) {
    report('plan', `[Planner] 分镜失败，使用梗概兜底：${err?.message || err}`);
    beats = [];
  }

  if (!beats.length) {
    beats = fallbackBeats(
      chapter.number,
      chapter.summary,
      chapter.title,
      chapter.intent?.endingHook
    );
    report('plan', `[Planner] 已用梗概兜底 ${beats.length} 镜`);
  } else {
    report('plan', `[Planner] 完成 · ${beats.length} 个镜头`);
  }

  hooks.onBeats?.(beats);
  return {
    beats,
    disciplineBlock: PROSE_DISCIPLINE_ZH,
  };
}
