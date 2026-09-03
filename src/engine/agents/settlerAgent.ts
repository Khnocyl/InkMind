/**
 * Settler Agent — 记忆沉淀：章末摘要提炼与实体状态回写。
 */
import type {
  ChapterRecap,
  Character,
  MemoryWriteLog,
  StoryMemory,
} from '../../types/novel';
import {
  generateChapterRecap,
  step5_AutoUpdateMemoryGraph,
} from '../../services/aiEngine';
import { evaluateRecapQuality } from '../../services/factGuard';
import { mergeRecapIntoMemory } from '../../services/storyMemory';
import type { AgentContext } from '../types';
import type { MemoryAuditLog } from '../../types/novel';

export interface SettlerOutput {
  recap: ChapterRecap;
  updatedCharacters: Character[];
  writeLog: MemoryWriteLog;
  memoryAfterRecap: StoryMemory;
  auditLog: MemoryAuditLog;
  recapBlockGreen: boolean;
  recapSummary: string;
}

export async function runSettlerAgent(
  ctx: AgentContext,
  prose: string,
  auditLogIn: MemoryAuditLog
): Promise<SettlerOutput> {
  const { input, report } = ctx;
  const { chapter, characters } = input;

  report('settle', `第${chapter.number}章 · [Settler] 沉淀 recap…`);

  let auditLog = auditLogIn;
  const recap = await generateChapterRecap(
    chapter,
    prose,
    characters,
    (msg) => report('settle', msg.replace(/\[记忆\]/g, '[Settler]'))
  );

  const recapQ = evaluateRecapQuality(recap, chapter.number, prose);
  if (recapQ.blockGreen) {
    auditLog = {
      ...auditLog,
      recapQualityBlocked: true,
      recapQualitySummary: recapQ.summary,
      verificationScore: Math.min(auditLog.verificationScore ?? 100, 72),
    };
    report('settle', `[Settler] recap 偏弱：${recapQ.summary}`);
  }

  report('settle', `[Settler] 回写角色记忆…`);
  const { updatedCharacters, writeLog } = await step5_AutoUpdateMemoryGraph(
    chapter,
    characters,
    prose,
    recap,
    (msg) => report('settle', msg.replace(/\[Step 5\]/g, '[Settler]'))
  );

  const memMerge = mergeRecapIntoMemory(
    input.project.memory,
    recap,
    chapter.number
  );

  report('settle', `[Settler] 完成 · 事实 ${recap.keyFacts.length} 条`);

  return {
    recap,
    updatedCharacters,
    writeLog,
    memoryAfterRecap: memMerge.memory,
    auditLog,
    recapBlockGreen: recapQ.blockGreen,
    recapSummary: recapQ.summary,
  };
}
