import type {
  BookProject,
  Chapter,
  CrossChapterAuditReport,
  CrossChapterIssue,
} from '../types/novel';
import { generateJSON } from './llmClient';
import { listActiveFacts, listActiveThreads } from './storyMemory';

function sortChapters(chapters: Chapter[]): Chapter[] {
  return [...chapters].sort((a, b) => a.number - b.number);
}

function strip(s: string): string {
  return (s || '').replace(/\s+/g, '');
}

/**
 * 本地启发式跨章抽检（不调模型，可随时跑）。
 * 覆盖：未收伏笔是否在近章出现、已死角色是否「活着行动」、近章是否几乎无主线推进迹象。
 */
export function runHeuristicCrossAudit(
  project: Pick<BookProject, 'chapters' | 'characters' | 'memory' | 'title'>,
  options?: { recentCount?: number }
): CrossChapterAuditReport {
  const chapters = sortChapters(project.chapters || []).filter(
    (c) => (c.content || '').trim().length > 20 || c.recap
  );
  const recentCount = options?.recentCount ?? 5;
  const recent = chapters.slice(-recentCount);
  const rangeFrom = recent[0]?.number ?? 1;
  const rangeTo = recent[recent.length - 1]?.number ?? 1;
  const issues: CrossChapterIssue[] = [];
  const memory = project.memory;
  const recentBlob = recent
    .map(
      (c) =>
        `${c.title}\n${c.summary}\n${c.recap?.text || ''}\n${(c.content || '').slice(-800)}`
    )
    .join('\n');

  // 1) 未收伏笔是否在近章文本中出现关键词
  const threads = listActiveThreads(memory);
  for (const t of threads) {
    if (t.status === 'deferred') continue;
    const keys = extractKeywords(t.text);
    if (keys.length === 0) continue;
    const hit = keys.some((k) => recentBlob.includes(k));
    if (!hit && recent.length >= 2) {
      issues.push({
        id: `thread-${t.id}`,
        severity: 'warn',
        kind: '伏笔遗忘',
        title: `未收伏笔近 ${recent.length} 章未提及`,
        detail: t.text,
        chapterNumbers: [rangeFrom, rangeTo],
        suggestion: '推进、回收或在书级记忆中标为「延期」。',
      });
    }
  }

  // 2) 已阵亡角色是否在近章正文中以「他/她说/道/笑」等动作出现（弱启发）
  const dead = (project.characters || []).filter((c) => c.status === '已阵亡/退出');
  for (const c of dead) {
    if (!c.name || c.name.length < 2) continue;
    const re = new RegExp(
      `${escapeReg(c.name)}[^。]{0,12}(说|道|笑|喝道|拔刀|走来|点头|伸手)`,
      'g'
    );
    for (const ch of recent) {
      const body = ch.content || '';
      if (re.test(body)) {
        issues.push({
          id: `dead-${c.id}-${ch.number}`,
          severity: 'error',
          kind: '角色状态',
          title: `已阵亡角色「${c.name}」在第${ch.number}章似仍在行动`,
          detail: `角色卡状态为「已阵亡/退出」，但正文出现行动描写。`,
          chapterNumbers: [ch.number],
          suggestion: '改为回忆/幻觉/同名者，或修正角色状态。',
        });
      }
    }
  }

  // 3) 钉死事实关键词在近章是否被「否定式」粗暴推翻（极弱启发）
  const facts = listActiveFacts(memory).slice(-15);
  for (const f of facts) {
    const negPatterns = [
      new RegExp(`并没有?${escapeReg(f.text.slice(0, 8))}`),
      new RegExp(`${escapeReg(f.text.slice(0, 6))}[^。]{0,8}(从未|不曾|并无)`),
    ];
    for (const ch of recent) {
      const body = `${ch.content || ''}${ch.recap?.text || ''}`;
      if (negPatterns.some((re) => re.test(body))) {
        issues.push({
          id: `fact-${f.id}-${ch.number}`,
          severity: 'warn',
          kind: '事实冲突',
          title: `第${ch.number}章可能与钉死事实冲突`,
          detail: f.text,
          chapterNumbers: [ch.number],
          suggestion: '核对正文或更新/作废该书级事实。',
        });
      }
    }
  }

  // 4) 主线停滞：连续多章 summary 极短或高度相似
  if (recent.length >= 3) {
    const shorts = recent.filter((c) => strip(c.summary).length < 12);
    if (shorts.length >= 3) {
      issues.push({
        id: 'stagnate-summary',
        severity: 'info',
        kind: '主线停滞',
        title: '近章梗概过短或缺失',
        detail: `近 ${recent.length} 章中有 ${shorts.length} 章梗概不足，不利于连贯规划。`,
        chapterNumbers: shorts.map((c) => c.number),
        suggestion: '补全梗概，或跑写前大纲确认。',
      });
    }
  }

  // 5) 地点：角色 currentLocation 与近章 recap endingState 粗冲突（仅 info）
  const protag = (project.characters || []).find((c) => c.role === '主角');
  if (protag?.currentLocation && recent.length) {
    const last = recent[recent.length - 1];
    const end = last.recap?.endingState || '';
    if (
      end &&
      protag.currentLocation.length >= 2 &&
      !end.includes(protag.currentLocation) &&
      (last.content || '').length > 200
    ) {
      // 不强制报错，仅提示可能未回写
      issues.push({
        id: `loc-${protag.id}`,
        severity: 'info',
        kind: '地点跳跃',
        title: '主角卡地点可能未与最近章同步',
        detail: `角色卡所在「${protag.currentLocation}」，最近章末现场：${end.slice(0, 80)}`,
        chapterNumbers: [last.number],
        suggestion: '确认是否应跑状态回写或手改角色卡。',
      });
    }
  }

  // 6) 记忆中的地点实体：近章是否「瞬移」到完全无关地点（弱启发）
  const memLocs = memory?.locations || [];
  if (memLocs.length && recent.length) {
    const last = recent[recent.length - 1];
    const lastBlob = `${last.recap?.endingState || ''}\n${last.recap?.text || ''}\n${(
      last.content || ''
    ).slice(-600)}`;
    const topLocs = [...memLocs]
      .sort((a, b) => (b.lastChapterNumber || 0) - (a.lastChapterNumber || 0))
      .slice(0, 8);
    // 若记忆里最近地点在近章完全未出现，而正文又出现「来到/抵达」新地 → warn
    const recentKnown = topLocs.filter((l) => l.name.length >= 2 && lastBlob.includes(l.name));
    const travel = lastBlob.match(/(?:来到|抵达|杀入|闯出|退守)([\u4e00-\u9fff]{2,8})/);
    if (
      topLocs.length >= 1 &&
      recentKnown.length === 0 &&
      travel &&
      travel[1] &&
      !topLocs.some((l) => l.name.includes(travel[1]) || travel[1].includes(l.name))
    ) {
      issues.push({
        id: `mem-loc-jump-${last.number}`,
        severity: 'warn',
        kind: '地点跳跃',
        title: `第${last.number}章可能未承接已知地点`,
        detail: `记忆近点：${topLocs
          .slice(0, 3)
          .map((l) => l.name)
          .join('、')}；本章出现「${travel[0]}」`,
        chapterNumbers: [last.number],
        suggestion: '补过渡行程，或更新地点状态表。',
      });
    }
  }

  // 7) 已失去的道具是否在近章又被「持有/拔出/祭出」
  const lostItems = (memory?.items || []).filter(
    (it) => it.status && /失去|遗失|毁掉|折断|被夺|已毁/.test(it.status)
  );
  for (const it of lostItems) {
    if (it.name.length < 2) continue;
    const re = new RegExp(
      `${escapeReg(it.name)}[^。]{0,10}(握|持|拔|祭出|亮出|摸出|甩出|刺向)`,
      'g'
    );
    for (const ch of recent) {
      const body = `${ch.content || ''}${ch.recap?.text || ''}`;
      if (re.test(body)) {
        issues.push({
          id: `item-lost-${it.id}-${ch.number}`,
          severity: 'error',
          kind: '道具归属',
          title: `已标记失去的「${it.name}」在第${ch.number}章似仍被使用`,
          detail: `道具状态：${it.status}`,
          chapterNumbers: [ch.number],
          suggestion: '改为回忆/赝品/夺回情节，或更正道具状态。',
        });
      }
    }
  }

  // 8) 仍持有的关键道具近多章完全消失（info，提示可回收戏）
  const heldItems = (memory?.items || []).filter(
    (it) => it.status && /持有|在场|归属/.test(it.status) && !/失去|遗失|毁掉/.test(it.status)
  );
  for (const it of heldItems.slice(0, 6)) {
    if (it.name.length < 2 || recent.length < 3) continue;
    if (!recentBlob.includes(it.name)) {
      const lastTouch = it.lastChapterNumber ?? 0;
      if (rangeTo - lastTouch >= 4) {
        issues.push({
          id: `item-idle-${it.id}`,
          severity: 'info',
          kind: '道具归属',
          title: `道具「${it.name}」已久未出场`,
          detail: `状态「${it.status}」，最近记录约第${lastTouch || '?'}章，近 ${recent.length} 章正文未提及。`,
          chapterNumbers: [rangeFrom, rangeTo],
          suggestion: '可安排使用/转交/遗失，避免变成影子挂件。',
        });
      }
    }
  }

  const errorN = issues.filter((i) => i.severity === 'error').length;
  const warnN = issues.filter((i) => i.severity === 'warn').length;
  const score = Math.max(0, Math.min(100, 100 - errorN * 22 - warnN * 10));

  return {
    generatedAt: new Date().toISOString(),
    rangeFrom,
    rangeTo,
    score,
    summary:
      issues.length === 0
        ? `近 ${recent.length || 0} 章启发式抽检未发现明显风险`
        : `发现 ${errorN} 严重 / ${warnN} 警告 / ${issues.length - errorN - warnN} 提示`,
    issues: issues.slice(0, 40),
    source: 'heuristic',
  };
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractKeywords(text: string): string[] {
  const t = text.replace(/[，。！？、；：""''（）\s]/g, ' ');
  const parts = t.split(' ').filter((p) => p.length >= 2);
  // 取较长词优先
  return [...new Set(parts)].sort((a, b) => b.length - a.length).slice(0, 4);
}

/**
 * 启发式 + LLM 加深（可选）。LLM 失败则返回启发式结果。
 */
export async function runCrossChapterAudit(
  project: BookProject,
  options?: {
    recentCount?: number;
    useLlm?: boolean;
    onProgress?: (msg: string) => void;
  }
): Promise<CrossChapterAuditReport> {
  const base = runHeuristicCrossAudit(project, { recentCount: options?.recentCount });
  if (options?.useLlm === false) return base;

  options?.onProgress?.('跨章抽检：本地启发完成，调用模型加深…');

  try {
    const chapters = sortChapters(project.chapters || []).slice(-(options?.recentCount ?? 5));
    const chapterBrief = chapters
      .map((c) => {
        const recap = c.recap?.text?.slice(0, 180) || c.summary?.slice(0, 120) || '（无）';
        const tail = (c.content || '').replace(/\s+/g, '').slice(-120);
        return `第${c.number}章《${c.title}》状态=${c.status}\n梗概/recap：${recap}\n章末片段：${tail}`;
      })
      .join('\n\n');

    const facts = listActiveFacts(project.memory)
      .slice(-12)
      .map((f) => f.text)
      .join('；');
    const threads = listActiveThreads(project.memory)
      .slice(0, 10)
      .map((t) => `[${t.status}] ${t.text}`)
      .join('；');
    const chars = (project.characters || [])
      .slice(0, 8)
      .map((c) => `${c.name}:${c.status}@${c.currentLocation || '?'}`)
      .join('；');

    const heuristicBrief = base.issues
      .slice(0, 8)
      .map((i) => `${i.severity}/${i.kind}:${i.title}`)
      .join('\n');

    const messages = [
      {
        role: 'system',
        content: `你是连载「跨章连贯审查官」。根据近章摘要与书级记忆，找出吃书、伏笔遗忘、角色状态矛盾、地点不合理跳跃、命名混乱、主线停滞。
只输出 JSON：
{
  "score": 0-100,
  "summary": "一句话",
  "issues": [
    {
      "severity": "error|warn|info",
      "kind": "伏笔遗忘|角色状态|事实冲突|地点跳跃|命名不一致|主线停滞|其他",
      "title": "短标题",
      "detail": "说明",
      "chapterNumbers": [1,2],
      "suggestion": "怎么办"
    }
  ]
}
不要编造正文没有的情节；可合并本地已发现的问题并补充。`,
      },
      {
        role: 'user',
        content: `【书名】${project.title}
【角色】${chars || '无'}
【钉死事实】${facts || '无'}
【未收伏笔】${threads || '无'}
【本地已发现】
${heuristicBrief || '无'}

【近章材料】
${chapterBrief || '无章节'}

输出跨章 JSON。`,
      },
    ];

    const res = await generateJSON<{
      score?: number;
      summary?: string;
      issues?: {
        severity?: string;
        kind?: string;
        title?: string;
        detail?: string;
        chapterNumbers?: number[];
        suggestion?: string;
      }[];
    }>(messages, 0.4);

    const llmIssues: CrossChapterIssue[] = (res.issues || [])
      .map((i, idx): CrossChapterIssue => {
        const severity: CrossChapterIssue['severity'] =
          i.severity === 'error' || i.severity === 'warn' || i.severity === 'info'
            ? i.severity
            : 'warn';
        return {
          id: `llm-${idx}-${Date.now()}`,
          severity,
          kind: (normalizeKind(i.kind) as CrossChapterIssue['kind']) || '其他',
          title: String(i.title || '问题').slice(0, 80),
          detail: String(i.detail || '').slice(0, 400),
          chapterNumbers: Array.isArray(i.chapterNumbers)
            ? i.chapterNumbers.map(Number).filter((n) => Number.isFinite(n))
            : undefined,
          suggestion: i.suggestion ? String(i.suggestion).slice(0, 200) : undefined,
        };
      })
      .filter((i) => i.title);

    // 合并：本地 error 优先保留 + LLM 补充
    const merged = mergeIssues(base.issues, llmIssues);
    const errorN = merged.filter((i) => i.severity === 'error').length;
    const warnN = merged.filter((i) => i.severity === 'warn').length;
    const score =
      typeof res.score === 'number'
        ? Math.max(0, Math.min(100, Math.round((res.score + base.score) / 2)))
        : Math.max(0, Math.min(100, 100 - errorN * 20 - warnN * 8));

    options?.onProgress?.('跨章抽检完成（混合）');
    return {
      generatedAt: new Date().toISOString(),
      rangeFrom: base.rangeFrom,
      rangeTo: base.rangeTo,
      score,
      summary: (res.summary || '').trim() || base.summary,
      issues: merged.slice(0, 50),
      source: 'mixed',
    };
  } catch (e: any) {
    options?.onProgress?.(`模型加深失败，保留本地结果：${e?.message || e}`);
    return base;
  }
}

function normalizeKind(k?: string): string {
  const s = String(k || '');
  const allowed = [
    '伏笔遗忘',
    '角色状态',
    '事实冲突',
    '地点跳跃',
    '命名不一致',
    '主线停滞',
    '其他',
  ];
  if (allowed.includes(s)) return s;
  if (s.includes('伏笔')) return '伏笔遗忘';
  if (s.includes('角色') || s.includes('状态')) return '角色状态';
  if (s.includes('事实') || s.includes('吃书')) return '事实冲突';
  if (s.includes('地点')) return '地点跳跃';
  if (s.includes('名')) return '命名不一致';
  if (s.includes('主线') || s.includes('停滞')) return '主线停滞';
  return '其他';
}

function mergeIssues(
  a: CrossChapterIssue[],
  b: CrossChapterIssue[]
): CrossChapterIssue[] {
  const out = [...a];
  for (const item of b) {
    const dup = out.some(
      (x) =>
        x.title === item.title ||
        (x.kind === item.kind && x.detail.slice(0, 20) === item.detail.slice(0, 20))
    );
    if (!dup) out.push(item);
  }
  // error 在前
  const rank = { error: 0, warn: 1, info: 2 };
  return out.sort((x, y) => rank[x.severity] - rank[y.severity]);
}
