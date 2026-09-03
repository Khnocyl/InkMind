import React, { useEffect, useReducer, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Trash2, Copy, Check, ChevronDown, ChevronRight } from 'lucide-react';
import {
  clearLlmTrace,
  getLlmTraceEntries,
  subscribeLlmTrace,
  type LlmTraceEntry,
} from '../services/llmTrace';

const KIND_LABEL: Record<LlmTraceEntry['kind'], string> = {
  json: 'JSON',
  text: '文本',
  stream: '流式',
};

const ROLE_STYLE: Record<string, string> = {
  system: 'bg-slate-100 text-slate-600 border-slate-200',
  user: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  assistant: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

const ROLE_LABEL: Record<string, string> = {
  system: '系统',
  user: '发给 AI',
  assistant: 'AI 上轮',
};

/** 顶部「AI 调用记录」小窗：每次调用的完整 Prompt 消息与原始响应 */
export const LlmTraceModal: React.FC<{ onClose: () => void }> = ({
  onClose,
}) => {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  useEffect(() => subscribeLlmTrace(force), [force]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const entries = getLlmTraceEntries();

  const copyEntry = (entry: LlmTraceEntry) => {
    const payload = JSON.stringify(
      { kind: entry.kind, stage: entry.stage, messages: entry.messages, response: entry.response },
      null,
      2
    );
    navigator.clipboard
      ?.writeText(payload)
      .then(() => {
        setCopiedId(entry.id);
        setTimeout(() => setCopiedId((cur) => (cur === entry.id ? null : cur)), 1500);
      })
      .catch(() => {});
  };

  return createPortal(
    <div
      data-modal-backdrop="true"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 app-region-no-drag select-auto modal-backdrop-layer"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden app-region-no-drag"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50 shrink-0">
          <div className="flex items-center space-x-2">
            <span className="font-semibold text-sm text-slate-800">AI 调用记录</span>
            <span className="text-[10px] text-slate-500 bg-white border border-slate-200 px-1.5 py-0.5 rounded-full">
              最近 {entries.length} 条 · 仅内存不落盘
            </span>
          </div>
          <div className="flex items-center space-x-1.5">
            <button
              type="button"
              onClick={() => clearLlmTrace()}
              className="flex items-center space-x-1 text-xs text-slate-600 hover:text-red-600 bg-white border border-slate-200 hover:border-red-300 px-2.5 py-1 rounded-lg transition-all cursor-pointer"
              title="清空记录"
            >
              <Trash2 size={12} />
              <span>清空</span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="text-slate-500 hover:text-slate-900 p-1.5 rounded-lg hover:bg-slate-200 transition-all cursor-pointer"
              title="关闭（Esc）"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* 列表 */}
        <div className="overflow-y-auto flex-1 divide-y divide-slate-100">
          {entries.length === 0 && (
            <div className="py-14 text-center text-xs text-slate-400">
              暂无调用记录 —— 发起一次生成/修复后这里会出现发给 AI 的 Prompt 与响应
            </div>
          )}
          {entries.map((entry) => {
            const expanded = expandedId === entry.id;
            return (
              <div key={entry.id} className="text-xs">
                <button
                  onClick={() => setExpandedId(expanded ? null : entry.id)}
                  className="w-full flex items-center space-x-2 px-4 py-2.5 hover:bg-slate-50 transition-all text-left"
                >
                  {expanded ? (
                    <ChevronDown size={13} className="text-slate-400 shrink-0" />
                  ) : (
                    <ChevronRight size={13} className="text-slate-400 shrink-0" />
                  )}
                  <span className="font-mono text-slate-400 shrink-0">{entry.time}</span>
                  <span className="px-1.5 py-0.5 rounded border border-slate-200 bg-slate-50 text-slate-600 shrink-0">
                    {KIND_LABEL[entry.kind]}
                  </span>
                  {entry.stage && (
                    <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-100 shrink-0 max-w-[10rem] truncate">
                      {entry.stage}
                    </span>
                  )}
                  {entry.strategy && entry.strategy !== 'direct' && (
                    <span
                      className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 shrink-0"
                      title="JSON 经修复策略抢救"
                    >
                      修复:{entry.strategy}
                    </span>
                  )}
                  <span
                    className={`shrink-0 ${entry.ok ? 'text-emerald-600' : 'text-red-600'}`}
                  >
                    {entry.ok ? '✓' : '✗'}
                  </span>
                  <span className="text-slate-500 truncate flex-1 min-w-0">
                    {entry.ok
                      ? entry.response.slice(0, 60).replace(/\s+/g, ' ')
                      : entry.error || '失败'}
                  </span>
                  <span className="font-mono text-[10px] text-slate-400 shrink-0">
                    {(entry.durationMs / 1000).toFixed(1)}s
                  </span>
                </button>

                {expanded && (
                  <div className="px-4 pb-4 pt-1 space-y-3 bg-slate-50/60">
                    <div className="flex justify-end">
                      <button
                        onClick={() => copyEntry(entry)}
                        className="flex items-center space-x-1 text-[11px] text-slate-600 hover:text-indigo-700 bg-white border border-slate-200 px-2 py-1 rounded-lg transition-all"
                      >
                        {copiedId === entry.id ? (
                          <Check size={11} className="text-emerald-600" />
                        ) : (
                          <Copy size={11} />
                        )}
                        <span>{copiedId === entry.id ? '已复制' : '复制 JSON'}</span>
                      </button>
                    </div>

                    {!entry.ok && (
                      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700 whitespace-pre-wrap break-words">
                        {entry.error || '调用失败'}
                      </div>
                    )}

                    <div>
                      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                        发给 AI 的 Prompt（{entry.messages.length} 条消息）
                      </div>
                      <div className="space-y-1.5 max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2">
                        {entry.messages.map((m, i) => (
                          <div key={i}>
                            <span
                              className={`inline-block px-1.5 py-0.5 rounded border text-[10px] mb-0.5 ${
                                ROLE_STYLE[m.role] || 'bg-white text-slate-500 border-slate-200'
                              }`}
                            >
                              {ROLE_LABEL[m.role] || m.role}
                            </span>
                            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-800 max-h-48 overflow-y-auto bg-slate-50 rounded p-1.5 m-0">
                              {m.content}
                            </pre>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                        AI 原始响应{entry.strategy ? `（修复策略：${entry.strategy}）` : ''}
                      </div>
                      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-800 bg-white border border-slate-200 rounded-lg p-2 max-h-64 overflow-y-auto m-0">
                        {entry.response || '（空）'}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body
  );
};
