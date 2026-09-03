/**
 * LLM JSON 输出修复层：尽力抢救「近乎合法但 JSON.parse 失败」的模型输出。
 *
 * 分级修复链逐级累积变换，任何一级成功即返回；direct 能过就不会进入后续级别，
 * 因此合法 JSON 绝不会被改写坏。strategy 记录命中的级别名，供上层可观测（warn）与测试断言。
 *
 * 链序（最终）：
 *   direct → fence-strip → trailing-comma → inner-quote-escape → bracket-balance
 * 顺序理由：direct 幂等保底；fence-strip 只处理包装层（围栏/零宽/BOM/首尾控制符）；
 * trailing-comma 用轻量正则去尾逗号；inner-quote-escape 必须先于 bracket-balance 修复值内
 * 半角引号，否则错乱的引号会干扰括号栈配平；bracket-balance 最后收口补缺失的 `}`/`]`。
 */

export type SalvageResult<T> =
  | { ok: true; value: T; strategy: string }
  | { ok: false; error: string };

// BOM 与常见零宽字符（\u200B 零宽空格、\u200C 零宽非连字、\u200D 零宽连字）
const ZERO_WIDTH_OR_BOM = /[\uFEFF\u200B\u200C\u200D]/g;

function tryParse<T>(
  text: string
): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── 命中统计埋点：观测抢救修复率与病型分布（进程内存级，不落盘）──
const strategyHits: Record<string, number> = {};
let directHits = 0;
let repairedHits = 0;
let failureCount = 0;

export interface SalvageStats {
  /** 无需修复直出的次数 */
  direct: number;
  /** 需要走修复链成功的次数 */
  repaired: number;
  /** 各非 direct 策略命中次数（病型分布） */
  byStrategy: Record<string, number>;
  /** 全链失败（漏网）次数 */
  failures: number;
}

export function getSalvageStats(): SalvageStats {
  return {
    direct: directHits,
    repaired: repairedHits,
    byStrategy: { ...strategyHits },
    failures: failureCount,
  };
}

export function resetSalvageStats(): void {
  directHits = 0;
  repairedHits = 0;
  failureCount = 0;
  for (const key of Object.keys(strategyHits)) delete strategyHits[key];
}

function recordHit(strategy: string): void {
  if (strategy === 'direct') {
    directHits += 1;
    return;
  }
  repairedHits += 1;
  strategyHits[strategy] = (strategyHits[strategy] || 0) + 1;
}

function finishHit<T>(parsed: { ok: true; value: T }, strategy: string): SalvageResult<T> {
  recordHit(strategy);
  return { ok: true, value: parsed.value, strategy };
}

/** 去除首尾控制符（含 DEL \u007F；空白由后续 trim 处理）。 */
function stripLeadingTrailingControl(text: string): string {
  let start = 0;
  let end = text.length;
  const isControl = (code: number): boolean =>
    (code >= 0 && code <= 0x1f) || code === 0x7f;
  while (start < end && isControl(text.charCodeAt(start))) start += 1;
  while (end > start && isControl(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** 剥离 markdown 代码围栏、BOM、零宽字符与首尾控制符。 */
function stripFence(text: string): string {
  let t = text.replace(ZERO_WIDTH_OR_BOM, '');
  t = stripLeadingTrailingControl(t).trim();
  if (!t.startsWith('```')) return t;
  if (!t.includes('\n')) {
    // 单行围栏：```json{...}``` 或 ```{...}```
    return t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
  }
  const lines = t.split('\n');
  if (lines.length > 0 && lines[0].trim().startsWith('```')) lines.shift();
  if (lines.length > 0 && lines[lines.length - 1].trim().startsWith('```')) lines.pop();
  return lines.join('\n').trim();
}

/** 移除对象/数组末尾多余逗号：`,\s*]` 与 `,\s*}`。
 * 状态机实现：跳过字符串内部（含转义序列），绝不改动字符串内容——
 * 纯正则会误删值内的 `, }` 序列（如 `"look, } here"` → `"look} here"`）。 */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < text.length) {
          out += text[i + 1];
          i += 1;
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (j < text.length && (text[j] === '}' || text[j] === ']')) continue; // 尾逗号 → 丢弃
    }
    out += ch;
  }
  return out;
}

/**
 * 修复字符串内部未转义的 ASCII 双引号（中文模型常见病）。
 * 状态机：字符串内遇到 `"` 时向前看下一个非空白字符，仅当其为结构位
 * `,` `}` `]` `:`（或输入末尾）才视为闭引号，否则改写为 `\"`；已转义的 `\"` 跳过。
 */
function escapeInnerQuotes(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    // 字符串内
    if (ch === '\\') {
      out += ch;
      if (i + 1 < text.length) {
        out += text[i + 1];
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      const next = j < text.length ? text[j] : '';
      if (next === '' || next === ',' || next === '}' || next === ']' || next === ':') {
        out += ch; // 结构位 → 闭引号
        inString = false;
      } else {
        out += '\\"'; // 值内引号 → 转义，仍处于字符串内
      }
      continue;
    }
    out += ch;
  }
  return out;
}

/** 若字符串截断点落在孤立反斜杠后（奇数个反斜杠），先移除再补闭引号。 */
function closeTruncatedString(s: string): string {
  let out = s;
  let trailing = 0;
  for (let i = out.length - 1; i >= 0 && out[i] === '\\'; i -= 1) trailing += 1;
  if (trailing % 2 === 1) out = out.slice(0, out.length - 1);
  return out + '"';
}

/**
 * 括号配平：补齐缺失的 `}`/`]`；截断发生在字符串中间时先闭合字符串；
 * 丢弃末尾残缺的 `"key"`（无值）片段。假定调用前引号已修复（inner-quote-escape）。
 */
function balanceBrackets(text: string): string {
  let t = text.replace(/,\s*$/, ''); // 末尾悬空逗号（如 [1,2, 截断）先移除
  const stack: Array<'[' | '{'> = [];
  let out = '';
  let inString = false;
  let stringStart = -1; // 当前字符串起始 `"` 在 out 中的下标
  let stringIsKey = false; // 当前（或最近一次打开的）字符串是否为键
  let lastStringStart = -1; // 最近一次「已闭合」字符串起始下标
  let lastStringWasKey = false; // 最近一次「已闭合」字符串是否为键
  let expectKey = false; // 下一个字符串（若出现）是否为键

  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < t.length) {
        out += t[i + 1];
        i += 1;
      } else if (ch === '"') {
        inString = false;
        lastStringStart = stringStart;
        lastStringWasKey = stringIsKey;
        if (!stringIsKey) expectKey = false;
      }
      continue;
    }
    // 字符串外
    if (ch === '"') {
      stringIsKey = expectKey;
      stringStart = out.length;
      inString = true;
      out += ch;
    } else if (ch === '{' || ch === '[') {
      stack.push(ch);
      expectKey = ch === '{';
      out += ch;
    } else if (ch === '}' || ch === ']') {
      const expected = ch === '}' ? '{' : '[';
      let closer = ch;
      if (stack.includes(expected)) {
        // 匹配开括号在栈中更深位置（如 emotionalBeats 缺 `]` 但对象 `}` 完整）：
        // 按栈序就地闭合中间层，再弹出匹配项，避免闭符被错误追加到文本末尾
        while (stack.length > 0 && stack[stack.length - 1] !== expected) {
          const skipped = stack.pop() as '[' | '{';
          out += skipped === '{' ? '}' : ']';
          expectKey = false;
        }
        stack.pop(); // 此时栈顶必为 expected
        expectKey = false;
      } else if (stack.length > 0) {
        // 杂散 closer（栈中无匹配开括号）→ 就近改写为栈顶开括号对应的闭合符，
        // 尽量抢救「写错闭合符类型」的模型输出；栈空时无物可闭，原样放行
        const top = stack.pop() as '[' | '{';
        closer = top === '{' ? '}' : ']';
        expectKey = false;
      }
      out += closer;
    } else if (ch === ',') {
      expectKey = stack[stack.length - 1] === '{';
      out += ch;
    } else if (ch === ':') {
      expectKey = false;
      out += ch;
    } else {
      out += ch;
    }
  }

  // 末尾处理
  if (inString) {
    if (stringIsKey) {
      // 残缺的键（连冒号都没有）→ 丢弃该键及其前缀悬空逗号
      out = out.slice(0, stringStart).replace(/[\s,]*$/, '');
    } else {
      out = closeTruncatedString(out);
    }
  } else {
    const tail = out.match(/[^\s]/g);
    const tailChar = tail && tail.length ? tail[tail.length - 1] : '';
    if (tailChar === ':') {
      out += 'null'; // `"key":` 后无值 → 补 null
    } else if (tailChar === '"' && lastStringWasKey) {
      // 已闭合的键但无冒号/值 → 丢弃
      out = out.slice(0, lastStringStart).replace(/[\s,]*$/, '');
    }
  }

  while (stack.length > 0) {
    const open = stack.pop() as '[' | '{';
    out += open === '{' ? '}' : ']';
  }
  return out;
}

/**
 * 尽力把模型返回的文本解析为 JSON。
 * 链：direct → fence-strip → trailing-comma → inner-quote-escape → bracket-balance。
 */
export function salvageJsonParse<T>(raw: string): SalvageResult<T> {
  let candidate = raw;

  const direct = tryParse<T>(candidate);
  if (direct.ok) {
    recordHit('direct');
    return { ok: true, value: direct.value, strategy: 'direct' };
  }

  candidate = stripFence(candidate);
  const fenced = tryParse<T>(candidate);
  if (fenced.ok) return finishHit(fenced, 'fence-strip');

  candidate = stripTrailingCommas(candidate);
  const commas = tryParse<T>(candidate);
  if (commas.ok) return finishHit(commas, 'trailing-comma');

  candidate = escapeInnerQuotes(candidate);
  const quotes = tryParse<T>(candidate);
  if (quotes.ok) return finishHit(quotes, 'inner-quote-escape');

  candidate = balanceBrackets(candidate);
  const balanced = tryParse<T>(candidate);
  if (balanced.ok) return finishHit(balanced, 'bracket-balance');

  failureCount += 1;
  return { ok: false, error: balanced.error };
}
