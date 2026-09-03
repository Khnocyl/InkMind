/**
 * Writer Agent — 执笔写手：按分镜流式生成正文。
 * R3-A：正文执笔 API 连续失败时降级为本地保守稿（buildConservativeProse），
 * 保证闭环仍能产出可用稿，并标记 conservative 供上层提示/不自动锁章。
 */
import type { PlotBeat } from '../../types/novel';
import { step2_ExpandProse } from '../../services/aiEngine';
import { buildConservativeProse } from '../../services/conservativeProse';
import { isBudgetExceededError } from '../../services/llmClient';
import { isGenerationAborted } from '../../services/llmResilience';
import { proseWords } from '../../services/proseWords';
import type { AgentContext } from '../types';

export interface WriterOutput {
  prose: string;
  beats: PlotBeat[];
  /** R3-A：是否为本地保守稿（LLM 执笔失败降级） */
  conservative?: boolean;
}

export async function runWriterAgent(
  ctx: AgentContext,
  beats: PlotBeat[],
  disciplineBlock: string
): Promise<WriterOutput> {
  const { input, report, hooks } = ctx;
  const { chapter, characters, settings, styleConfig } = input;

  report('write', `第${chapter.number}章 · [Writer] 流式执笔…`);

  // 纪律叠入题材块，避免另开参数改动 step2 签名
  const genreWithDiscipline = [input.genrePackBlock, disciplineBlock]
    .filter((s) => s?.trim())
    .join('\n\n');

  let streamBuffer = '';
  try {
    const { rawProse } = await step2_ExpandProse(
      beats,
      characters,
      settings,
      styleConfig,
      (chunk) => {
        streamBuffer += chunk;
        const text = streamBuffer;
        hooks.onStreamProse?.(text);
      },
      (msg) => report('write', msg.replace(/\[Step 2\/3\]/g, '[Writer]')),
      {
        chapter,
        previousContext: input.previousContext,
        previousContextPack: input.contextPack,
        storyMemoryBlock: input.storyMemoryBlock,
        chapterIntentBlock: input.chapterIntentBlock,
        genrePackBlock: genreWithDiscipline,
        bookGenre: input.project.genre,
        targetWordCount: input.targetWordCount,
        previousProse: input.previousProse,
        // 补写轮 3：单轮续写也受模型输出上限约束（常 1500-2500 字/轮），
        // 目标 3000 字首稿被截时 2 轮不够稳
        wordCountExpandRounds: 3,
        wordCountMinRatio: 0.9,
      }
    );

    const prose = (rawProse || streamBuffer || '').trim();
    hooks.onStreamProse?.(prose);
    report('write', `[Writer] 草稿完成 · ${proseWords(prose)} 字`);
    return { prose, beats };
  } catch (err: any) {
    // 用户主动停止：不降级、不产稿——直接上抛由管线走中止语义
    if (isGenerationAborted(err)) throw err;
    // R3-A 降级链：正文执笔彻底失败 → 本地保守稿
    const msg = err?.message || String(err);
    const conservative = buildConservativeProse({
      beats,
      characters,
      settings,
      previousContext: input.previousContext,
      chapter: {
        number: chapter.number,
        title: chapter.title,
        summary: chapter.summary,
      },
    });
    const reason = isBudgetExceededError(err)
      ? '本月 LLM 预算已超限'
      : `LLM 执笔失败（${msg.slice(0, 80)}）`;
    report(
      'write',
      `[Writer] ⚠️ ${reason}，已降级为本地保守稿（${conservative.wordCount} 字）`
    );
    hooks.onStreamProse?.(conservative.prose);
    return { prose: conservative.prose, beats, conservative: true };
  }
}
