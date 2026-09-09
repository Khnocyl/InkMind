import React, { useMemo } from 'react';

interface ReleaseNotesViewerProps {
  content?: string;
  maxHeightClass?: string;
}

/**
 * 格式化展示更新日志：
 * 1. 兼容 electron-updater（Atom feed 产出的 HTML 片段，如 <p>、<ul>、<h3>、<br> 等）；
 * 2. 兼容 GitHub REST API（Markdown 文本，如 ##、-、** 等）；
 * 3. 剥离外层可能携带的 ```markdown 围栏；
 * 4. 彻底剔除等宽代码字体（font-mono），采用清晰易读的正文排版（font-sans）与明暗自适应高对比色彩；
 * 5. 杜绝原生 HTML 标签作为纯文本字符在界面上裸露呈现。
 */
export const ReleaseNotesViewer: React.FC<ReleaseNotesViewerProps> = ({
  content,
  maxHeightClass = 'max-h-60',
}) => {
  const nodes = useMemo(() => {
    if (!content || typeof content !== 'string') return null;
    return parseReleaseNotes(content);
  }, [content]);

  if (!nodes || nodes.length === 0) return null;

  return (
    <div
      className={`bg-white/90 border border-indigo-100 rounded-xl p-3.5 text-xs text-slate-700 ${maxHeightClass} overflow-y-auto font-sans leading-relaxed dark:bg-slate-900/90 dark:border-indigo-900/60 dark:text-slate-200 space-y-2 scrollbar-thin`}
    >
      <div className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 tracking-wide uppercase flex items-center gap-1.5 pb-1 border-b border-indigo-100/70 dark:border-indigo-950/60">
        <span>更新内容说明</span>
      </div>
      <div className="space-y-1.5">{nodes}</div>
    </div>
  );
};

export function parseReleaseNotes(raw: string): React.ReactNode[] {
  if (!raw || typeof raw !== 'string') return [];

  // 1. 去除首尾空白及可能携带的代码围栏（如 ```markdown ... ``` 或 ```text ... ```）
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\r?\n/, '').replace(/\r?\n```$/, '').trim();
  }

  // 2. 过滤危险标签
  text = text.replace(/<(?:script|style|iframe|object|embed)[\s\S]*?<\/(?:script|style|iframe|object|embed)>/gi, '');
  text = text.replace(/<(?:script|style|iframe|object|embed)[\s\S]*?>/gi, '');

  // 3. 若为 HTML 文本，先转换为结构化纯文本 / 标准 Markdown 记号
  if (/<[a-z][\s\S]*>/i.test(text)) {
    text = htmlToStandardText(text);
  }

  // 4. 按行解析为结构化的 React 元素
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const elements: React.ReactNode[] = [];

  lines.forEach((line, idx) => {
    const key = `rn-line-${idx}`;

    // 大标题
    if (line.startsWith('# ') || line.startsWith('## ')) {
      const headingText = line.replace(/^#{1,2}\s*/, '');
      elements.push(
        <div
          key={key}
          className="font-bold text-sm text-slate-900 dark:text-slate-100 pt-2 pb-1 border-b border-indigo-100/60 dark:border-indigo-950/60 first:pt-0"
        >
          {renderInline(headingText, key)}
        </div>
      );
      return;
    }

    // 中小标题
    if (line.startsWith('### ') || line.startsWith('#### ') || line.startsWith('##### ')) {
      const headingText = line.replace(/^#{3,5}\s*/, '');
      elements.push(
        <div key={key} className="font-bold text-xs text-slate-800 dark:text-slate-200 pt-1.5 first:pt-0">
          {renderInline(headingText, key)}
        </div>
      );
      return;
    }

    // 分割线
    if (line === '---' || line === '***' || line === '___') {
      elements.push(<hr key={key} className="my-2 border-slate-200 dark:border-slate-800" />);
      return;
    }

    // 无序列表（• 或 - 或 *）
    if (line.startsWith('• ') || line.startsWith('- ') || line.startsWith('* ')) {
      const itemText = line.replace(/^[•\-*]\s*/, '');
      elements.push(
        <div key={key} className="flex items-start gap-2 text-slate-700 dark:text-slate-300 pl-1 leading-relaxed">
          <span className="text-indigo-500 dark:text-indigo-400 font-bold shrink-0 mt-0.5">•</span>
          <span className="flex-1">{renderInline(itemText, key)}</span>
        </div>
      );
      return;
    }

    // 有序列表（1. 2. 等）
    const numMatch = line.match(/^(\d+[\.、])\s*(.*)$/);
    if (numMatch) {
      const prefix = numMatch[1];
      const itemText = numMatch[2];
      elements.push(
        <div key={key} className="flex items-start gap-2 text-slate-700 dark:text-slate-300 pl-1 leading-relaxed">
          <span className="font-semibold text-indigo-600 dark:text-indigo-400 shrink-0">{prefix}</span>
          <span className="flex-1">{renderInline(itemText, key)}</span>
        </div>
      );
      return;
    }

    // 普通段落
    elements.push(
      <p key={key} className="leading-relaxed text-slate-700 dark:text-slate-300">
        {renderInline(line, key)}
      </p>
    );
  });

  return elements;
}

/**
 * 将来自 electron-updater / Atom feed 的 HTML 片段安全转换为规范的纯文本行
 */
function htmlToStandardText(html: string): string {
  let s = html;

  // 换行与块级标签
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n\n');
  s = s.replace(/<\/div>/gi, '\n');
  s = s.replace(/<\/tr>/gi, '\n');
  s = s.replace(/<hr\s*\/?>/gi, '\n---\n');

  // 标题
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  s = s.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n#### $1\n');

  // 列表项
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n• $1\n');

  // 加粗与行内代码
  s = s.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**');
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  s = s.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // 剥离剩余的所有未解析 HTML 标签
  s = s.replace(/<[^>]+>/g, '');

  // 还原常见 HTML 实体
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');

  return s;
}

/**
 * 渲染行内格式（**加粗**、`行内代码`、[链接](url)）
 */
function renderInline(text: string, parentKey: string): React.ReactNode {
  // 匹配 **bold**, `code`, [label](url)
  const tokenRegex = /(\*\*.*?\*\*|`.*?`|\[.*?\]\(.*?\))/g;
  const parts = text.split(tokenRegex);

  if (parts.length === 1) {
    return text;
  }

  return parts.map((part, i) => {
    const key = `${parentKey}-p-${i}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return (
        <strong key={key} className="font-semibold text-slate-900 dark:text-slate-100">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code
          key={key}
          className="px-1.5 py-0.5 rounded bg-indigo-50 border border-indigo-100 dark:bg-slate-800 dark:border-indigo-900/60 text-[11px] font-mono text-indigo-700 dark:text-indigo-300"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    const linkMatch = part.match(/^\[(.*?)\]\((.*?)\)$/);
    if (linkMatch) {
      return (
        <a
          key={key}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-600 dark:text-indigo-400 hover:underline font-medium"
        >
          {linkMatch[1]}
        </a>
      );
    }
    return part;
  });
}
