/**
 * 拆书报告（Markdown）→ 可渲染的结构块。
 *
 * 报告本体仍是 Markdown（「复制报告」给的是原文，可直接粘进作者笔记），
 * 但界面里直接把 Markdown 源文铺进 `<pre>`，用户看到的是 `#` / `|` / `**` / `---`
 * 这类记号而不是报告内容——所以展示前先解析成结构块，交视图渲染。
 *
 * 纯函数、不依赖 React（放 services 层：组件文件里导出非组件会被 oxlint
 * 的 only-export-components 记一条 warning，项目基线是 19 条不能涨）。
 */

/** 行内片段（报告只用 `**加粗**` 一种行内记号） */
export interface ReportInline {
  text: string;
  bold: boolean;
}

export type ReportBlock =
  | { kind: 'h1'; spans: ReportInline[] }
  | { kind: 'h2'; spans: ReportInline[] }
  | { kind: 'list'; items: ReportInline[][] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'quote'; spans: ReportInline[] }
  | { kind: 'p'; spans: ReportInline[] };

/** `**加粗**` → 分段（未闭合的 `**` 原样保留为普通文本） */
export function parseReportInline(text: string): ReportInline[] {
  const src = text || '';
  const out: ReportInline[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ text: src.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last), bold: false });
  return out.filter((s) => s.text.length > 0);
}

/**
 * 表格行拆列：`\|` 是**单元格内**的竖线（生成端 `cell()` 已转义），不能当分隔符。
 * 不处理这点，「前半 | 后半」的梗概会把行拆成多列、整张表错位。
 */
export function splitReportRow(line: string): string[] {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i += 1;
      continue;
    }
    if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** Markdown 表格的分隔行：| --- | :--: | */
const TABLE_SEPARATOR_RE = /^\|[\s:|-]+\|$/;

export function parseDeconstructReport(md: string): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  const lines = (md || '').split(/\r?\n/);

  let listItems: ReportInline[][] = [];
  let tableHeader: string[] | null = null;
  let tableRows: string[][] = [];

  const flushList = () => {
    if (listItems.length) blocks.push({ kind: 'list', items: listItems });
    listItems = [];
  };
  const flushTable = () => {
    if (tableHeader) blocks.push({ kind: 'table', header: tableHeader, rows: tableRows });
    tableHeader = null;
    tableRows = [];
  };
  const flushAll = () => {
    flushList();
    flushTable();
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushAll();
      continue;
    }
    if (line.startsWith('|')) {
      if (TABLE_SEPARATOR_RE.test(line)) continue;
      const cells = splitReportRow(line);
      if (!tableHeader) tableHeader = cells;
      else tableRows.push(cells);
      continue;
    }
    flushTable();
    if (line.startsWith('# ')) {
      flushList();
      blocks.push({ kind: 'h1', spans: parseReportInline(line.slice(2)) });
      continue;
    }
    if (line.startsWith('## ')) {
      flushList();
      blocks.push({ kind: 'h2', spans: parseReportInline(line.slice(3)) });
      continue;
    }
    if (line.startsWith('- ')) {
      listItems.push(parseReportInline(line.slice(2)));
      continue;
    }
    if (line.startsWith('> ')) {
      flushList();
      blocks.push({ kind: 'quote', spans: parseReportInline(line.slice(2)) });
      continue;
    }
    // 兜底：未知行当普通段落（宁可原样显示，也不要悄悄吞掉内容）
    flushList();
    blocks.push({ kind: 'p', spans: parseReportInline(line) });
  }
  flushAll();
  return blocks;
}
