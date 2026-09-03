/**
 * 正文标点确定性收尾
 * 对字符串就地规范化，不读文件。
 *
 * - …… / … → 句号或逗号语境下的中文断句（简化：多省略号→句号）
 * - —— / — / -- → 逗号或句号断句
 * - 独立行 --- 删除
 * 默认不改引号风格。
 */

export interface PunctuationFinding {
  type: 'ellipsis' | 'emdash' | 'double-hyphen' | 'md-divider';
  message: string;
  count: number;
}

export interface NormalizePunctuationResult {
  text: string;
  findings: PunctuationFinding[];
  changed: boolean;
}

// ── 正文符号规范化（管线 Writer 出口强制执行）──────────────────────────

export type SymbolFindingType =
  | 'md-heading-chapter'
  | 'md-heading'
  | 'md-emphasis'
  | 'quote-style';

export interface SymbolFinding {
  type: SymbolFindingType;
  message: string;
  count: number;
}

export interface NormalizeSymbolsResult {
  text: string;
  findings: SymbolFinding[];
  changed: boolean;
}

/**
 * 正文符号与 Markdown 残留清洗：
 * 1. Markdown 标题行——`# 第一章 · xxx` 这类与章节元信息重复的整行删除，
 *    其余标题仅去掉 # 记号保留文字；
 * 2. Markdown 强调/代码标记——**粗体**、*斜体*、`代码` 只留内容；
 * 3. 引号统一——对白直角引号「」/『』改为中文双引号 “”/‘’（大陆网文规范）。
 * 不碰省略号/破折号（那是文风层的事，由 punctuationTolerance 决定）。
 */
export function normalizeProseSymbols(input: string): NormalizeSymbolsResult {
  let text = input || '';
  const findings: SymbolFinding[] = [];

  // 1a. 与章节元信息重复的标题行（"# 第一章 · 雨夜订单"）——整行删除
  const chapterHeadingRe = /^[ \t]*#{1,6}[ \t]*第[一二三四五六七八九十百千0-9]+章[^\n]*$/gm;
  const chapterHeadings = countRe(chapterHeadingRe, text);
  if (chapterHeadings > 0) {
    text = text.replace(chapterHeadingRe, '');
    findings.push({
      type: 'md-heading-chapter',
      message: '删除正文中的章节标题行',
      count: chapterHeadings,
    });
  }

  // 1b. 其余 markdown 标题——只去 # 记号
  const headingRe = /^[ \t]*#{1,6}[ \t]+/gm;
  const headings = countRe(headingRe, text);
  if (headings > 0) {
    text = text.replace(headingRe, '');
    findings.push({
      type: 'md-heading',
      message: '去除标题记号 #',
      count: headings,
    });
  }

  // 2. 强调与代码标记：**粗体** → 粗体；*斜体* → 斜体；`代码` → 代码
  let emphasisCount = countRe(/\*\*([^*\n]+)\*\*/g, text);
  emphasisCount += countRe(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, text);
  emphasisCount += countRe(/`([^`\n]+)`/g, text);
  if (emphasisCount > 0) {
    text = text
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1');
    findings.push({
      type: 'md-emphasis',
      message: '去除 Markdown 加粗/斜体/代码记号',
      count: emphasisCount,
    });
  }

  // 3. 引号统一：直角 → 中文双引号（对白规范）；开闭按字符直接映射
  const cornerOpen = countRe(/[「『]/g, text);
  const cornerClose = countRe(/[」』]/g, text);
  if (cornerOpen > 0 || cornerClose > 0) {
    text = text
      .replace(/「/g, '\u201C')
      .replace(/『/g, '\u2018')
      .replace(/」/g, '\u201D')
      .replace(/』/g, '\u2019');
    findings.push({
      type: 'quote-style',
      message: '直角引号「」统一为双引号“”',
      count: cornerOpen + cornerClose,
    });
  }

  // 收尾：清掉删除标题行留下的连续空行与正文首部空行
  text = text.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');

  return {
    text,
    findings,
    changed: text !== (input || ''),
  };
}

function countRe(re: RegExp, text: string): number {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return (text.match(new RegExp(re.source, flags)) || []).length;
}

/**
 * 规范化正文标点。保守策略：停顿符号改成句号/逗号，避免「……」堆砌。
 */
export function normalizeProsePunctuation(input: string): NormalizePunctuationResult {
  let text = input || '';
  const findings: PunctuationFinding[] = [];

  // 独立行 markdown 分隔
  const dividerRe = /^[ \t]*---[ \t]*$/gm;
  const dividers = countRe(dividerRe, text);
  if (dividers > 0) {
    text = text.replace(dividerRe, '');
    findings.push({
      type: 'md-divider',
      message: '删除独立行 ---',
      count: dividers,
    });
  }

  // 破折号族
  const emCount = countRe(/——|—/g, text);
  const dhCount = countRe(/(?<![-\w])--(?![-\w])/g, text);
  if (emCount > 0) {
    // 句中 —— 多改成逗号；句首/独立时用句号较生硬，统一逗号后由作者微调
    text = text.replace(/——/g, '，').replace(/—/g, '，');
    findings.push({
      type: 'emdash',
      message: '破折号改为逗号断句',
      count: emCount,
    });
  }
  if (dhCount > 0) {
    text = text.replace(/(?<![-\w])--(?![-\w])/g, '，');
    findings.push({
      type: 'double-hyphen',
      message: '双连字符 -- 改为逗号',
      count: dhCount,
    });
  }

  // 省略号：…… / …{2,} / ...
  const ellipsisCount =
    countRe(/……/g, text) + countRe(/…{2,}/g, text) + countRe(/\.{3,}/g, text);
  if (ellipsisCount > 0) {
    text = text
      .replace(/……/g, '。')
      .replace(/…{2,}/g, '。')
      .replace(/\.{3,}/g, '。');
    // 残留单 … 在句中 → 逗号感
    text = text.replace(/…/g, '，');
    findings.push({
      type: 'ellipsis',
      message: '省略号停顿改为句号/逗号（用动作或短句表达未尽）',
      count: ellipsisCount,
    });
  }

  // 清理「，。」「。。」类叠标
  text = text.replace(/，。/g, '。').replace(/。{2,}/g, '。').replace(/，{2,}/g, '，');

  return {
    text,
    findings,
    changed: text !== (input || ''),
  };
}

/** 仅检测，不修改 */
export function scanProsePunctuationIssues(input: string): PunctuationFinding[] {
  const text = input || '';
  const findings: PunctuationFinding[] = [];
  const em = countRe(/——|—/g, text);
  if (em) {
    findings.push({
      type: 'emdash',
      message: '正文含破折号，建议改逗号/句号或动作断句',
      count: em,
    });
  }
  const ell =
    countRe(/……/g, text) + countRe(/…{2,}/g, text) + countRe(/\.{3,}/g, text);
  if (ell) {
    findings.push({
      type: 'ellipsis',
      message: '正文含省略号停顿堆砌，建议改动作/短句',
      count: ell,
    });
  }
  const dh = countRe(/(?<![-\w])--(?![-\w])/g, text);
  if (dh) {
    findings.push({
      type: 'double-hyphen',
      message: '正文含 --，建议改逗号',
      count: dh,
    });
  }
  return findings;
}
