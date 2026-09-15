import React from 'react';
import { parseDeconstructReport, type ReportInline } from '../../services/deconstructReport';

const Inline: React.FC<{ spans: ReportInline[] }> = ({ spans }) =>
  (
    <>
      {spans.map((s, i) =>
        s.bold ? (
          <b key={i} className="font-semibold text-slate-900">
            {s.text}
          </b>
        ) : (
          <React.Fragment key={i}>{s.text}</React.Fragment>
        )
      )}
    </>
  );

/**
 * 拆解报告视图：把报告 Markdown 渲染成排版好的内容（标题/列表/表格/引用）。
 * 「复制报告」按钮仍给 Markdown 原文（可直接粘进作者笔记），这里只管展示。
 */
export const DeconstructReportView: React.FC<{ report: string }> = ({ report }) => {
  const blocks = parseDeconstructReport(report);
  if (!blocks.length) {
    return <p className="text-xs text-slate-400">（报告为空）</p>;
  }
  return (
    <div className="space-y-2.5">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h1':
            return (
              <h3 key={i} className="text-sm font-bold text-slate-900">
                <Inline spans={b.spans} />
              </h3>
            );
          case 'h2':
            return (
              <h4
                key={i}
                className="text-xs font-bold text-slate-800 pt-2 border-t border-slate-100"
              >
                <Inline spans={b.spans} />
              </h4>
            );
          case 'list':
            return (
              <ul key={i} className="space-y-1">
                {b.items.map((item, j) => (
                  <li key={j} className="flex gap-1.5 text-xs text-slate-700 leading-relaxed">
                    <span className="text-slate-300 shrink-0">•</span>
                    <span className="min-w-0">
                      <Inline spans={item} />
                    </span>
                  </li>
                ))}
              </ul>
            );
          case 'table':
            return (
              <div key={i} className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-[11px] border-collapse">
                  <thead>
                    <tr className="bg-slate-50">
                      {b.header.map((h, j) => (
                        <th
                          key={j}
                          className="px-2 py-1 text-left font-semibold text-slate-600 whitespace-nowrap"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, j) => (
                      <tr key={j} className="border-t border-slate-100 align-top">
                        {row.map((cell, k) => (
                          <td key={k} className="px-2 py-1 text-slate-700">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'quote':
            return (
              <p key={i} className="text-[11px] text-slate-500 border-l-2 border-slate-200 pl-2">
                <Inline spans={b.spans} />
              </p>
            );
          default:
            return (
              <p key={i} className="text-xs text-slate-700 leading-relaxed">
                <Inline spans={b.spans} />
              </p>
            );
        }
      })}
    </div>
  );
};
