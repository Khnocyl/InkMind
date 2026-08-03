/**
 * 平台文笔纪律（对齐 InkOS prose-discipline）
 * 注入写手/修订 prompt，并供确定性校验使用。
 */

export const PROSE_DISCIPLINE_ZH = `## 平台文笔纪律（硬尺）

**描写克制**
- 每个关键动作/物件只抓 1 个核心感官锚，点到即走。
- 禁止同一拍连续写「触觉→温度→气味→质地→神经末梢」。
- 同一意象域（体内热流、伤口黏腻、残留物温热等）全章最多两轮。
- 过渡段（收拾、消毒、看后台）只保留有用信息。

**跨章事实**
- 外貌、伤势部位、攻击落点、昼夜、道具、数值、关键台词须与上章正文一致。
- 冲突时以上章正文为准，不得自创补丁。

**信息边界**
- 角色只能使用其当前认知内的专有名词与内幕；未铺垫的不得当常识脱口。`;

export const SENSORY_STACK_TOKENS = [
  '温热', '温的', '发烫', '冰凉', '刺骨',
  '黏腻', '黏糊', '黏湿', '湿滑',
  '刺麻', '发麻', '酥麻', '刺痛',
  '铁锈', '腥', '腐臭', '焦糊',
  '粗糙', '细腻', '柔软', '坚硬',
  '神经', '末梢', '毛孔', '汗毛',
  '微微', '隐隐', '缓缓',
] as const;

export function countSensoryStackHits(paragraph: string): number {
  let hits = 0;
  for (const token of SENSORY_STACK_TOKENS) {
    if (paragraph.includes(token)) hits += 1;
  }
  return hits;
}

export function findSensoryStackParagraphs(
  content: string,
  options?: { minHits?: number; maxParagraphLength?: number }
): string[] {
  const minHits = options?.minHits ?? 4;
  const maxParagraphLength = options?.maxParagraphLength ?? 280;
  return content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p.length <= maxParagraphLength)
    .filter((p) => countSensoryStackHits(p) >= minHits);
}

export interface EngineViolation {
  rule: string;
  severity: 'error' | 'warning';
  description: string;
  suggestion: string;
}

/** 零 LLM 写后校验（对齐 InkOS post-write-validator 子集） */
export function validatePostWrite(content: string): EngineViolation[] {
  const violations: EngineViolation[] = [];
  const text = content || '';

  if (/不是[^，。！？\n]{0,30}[，,]?\s*而是/.test(text)) {
    violations.push({
      rule: '禁止句式',
      severity: 'error',
      description: '出现了「不是……而是……」句式',
      suggestion: '改用直述句',
    });
  }
  if (text.includes('——')) {
    violations.push({
      rule: '禁止破折号',
      severity: 'error',
      description: '出现了破折号「——」',
      suggestion: '用逗号或句号断句',
    });
  }

  const markers = ['仿佛', '忽然', '竟然', '猛地', '猛然', '不禁', '宛如'];
  let markerCount = 0;
  const found: string[] = [];
  for (const w of markers) {
    const m = text.match(new RegExp(w, 'g'));
    if (m?.length) {
      markerCount += m.length;
      found.push(`${w}×${m.length}`);
    }
  }
  const markerLimit = Math.max(1, Math.floor(text.length / 3000));
  if (markerCount > markerLimit) {
    violations.push({
      rule: '转折词密度',
      severity: 'warning',
      description: `转折/惊讶标记词共${markerCount}次（上限${markerLimit}），${found.join('、')}`,
      suggestion: '改用具体动作传递突然性',
    });
  }

  const stacks = findSensoryStackParagraphs(text, { minHits: 4 });
  if (stacks.length >= 1) {
    const sample =
      stacks[0]!.length > 48 ? `${stacks[0]!.slice(0, 47)}…` : stacks[0]!;
    violations.push({
      rule: '描写过细',
      severity: stacks.length >= 3 ? 'error' : 'warning',
      description: `检测到${stacks.length}处疑似感官堆砌，例："${sample}"`,
      suggestion: '每个物件只留 1 个感官锚',
    });
  }

  const reportTerms = [
    '核心动机', '信息边界', '信息落差', '核心风险', '利益最大化',
    '当前处境', '行为约束', '性格过滤', '情绪外化',
  ];
  const hitTerms = reportTerms.filter((t) => text.includes(t));
  if (hitTerms.length) {
    violations.push({
      rule: '报告术语',
      severity: 'error',
      description: `正文出现分析术语：${hitTerms.join('、')}`,
      suggestion: '改成口语化内心戏或动作',
    });
  }

  return violations;
}
