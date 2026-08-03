/**
 * 正文标点确定性收尾（对齐 story-deslop/scripts/normalize-punctuation.js）
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
