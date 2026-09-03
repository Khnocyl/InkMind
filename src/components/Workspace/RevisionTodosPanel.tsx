import React, { useMemo, useState } from 'react';
import type { Chapter } from '../../types/novel';
import { collectRevisionTodos } from '../../services/revisionTodos';
import { isChapterLocked } from '../../services/chapterLock';
import {
  ListTodo,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Circle,
  ExternalLink,
  Unlock,
  Wrench,
  Trash2,
  CheckCheck,
  Square,
  Zap,
} from 'lucide-react';

interface RevisionTodosPanelProps {
  chapters: Chapter[];
  activeChapterId?: string;
  /** 跳转章节；可带 todoId 以便正文侧高亮对应待修 */
  onJumpChapter: (chapterId: string, todoId?: string) => void;
  /**
   * 解锁（若锁定）并跳转定位，便于立刻改稿。
   * 未传时「解锁并开写」不显示。
   */
  onOpenForRewrite?: (chapterId: string, todoId?: string) => void;
  /** AI 修第一条（优先跨章 / 硬伤 / 去AI） */
  onFixFirst?: () => void;
  /** 一键修全部：串行 AI 局部改写全书所有 open 待修 */
  onFixAll?: () => void;
  /** 停止一键修全部（软停 + 中断当前 in-flight LLM 调用） */
  onStopFixAll?: () => void;
  /** 一键修全部运行中（按钮切换为「停止」） */
  fixAllRunning?: boolean;
  /** AI 修指定待修条目 */
  onAiFixTodo?: (chapterId: string, todoId: string) => void;
  /** 清空全书已完成待修 */
  onClearDone?: () => void;
  /** 全书 open 全部勾完（慎用） */
  onMarkAllDone?: () => void;
  onToggleTodo: (chapterId: string, todoId: string) => void;
  busy?: boolean;
}

export const RevisionTodosPanel: React.FC<RevisionTodosPanelProps> = ({
  chapters,
  activeChapterId,
  onJumpChapter,
  onOpenForRewrite,
  onFixFirst,
  onFixAll,
  onStopFixAll,
  fixAllRunning = false,
  onAiFixTodo,
  onClearDone,
  onMarkAllDone,
  onToggleTodo,
  busy = false,
}) => {
  // 渐进披露：默认收起成一行（避免右栏一进就占满一堆待修）
  const overview = useMemo(() => collectRevisionTodos(chapters), [chapters]);
  const [open, setOpen] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const chapterById = useMemo(() => {
    const m = new Map<string, Chapter>();
    for (const c of chapters) m.set(c.id, c);
    return m;
  }, [chapters]);

  if (overview.openCount === 0 && overview.doneCount === 0) {
    return null;
  }

  const list = showDone ? overview.done : overview.open;

  return (
    <div className="p-4 border-b border-slate-200 bg-white space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between"
      >
        <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
          <ListTodo size={14} className="text-rose-600" />
          全书待修
          {overview.openCount > 0 ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-900 border border-rose-200 font-bold">
              {overview.openCount} 未完成
            </span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold">
              已清空
            </span>
          )}
        </span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {open && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 text-[10px]">
            <span className="text-slate-500">
              {overview.chaptersWithOpen} 章有待修 · 已完成 {overview.doneCount}
            </span>
            <div className="flex rounded-lg border border-slate-200 overflow-hidden">
              <button
                type="button"
                onClick={() => setShowDone(false)}
                className={`px-2 py-0.5 font-semibold ${
                  !showDone ? 'bg-rose-100 text-rose-900' : 'bg-white text-slate-600'
                }`}
              >
                未完成
              </button>
              <button
                type="button"
                onClick={() => setShowDone(true)}
                className={`px-2 py-0.5 font-semibold border-l border-slate-200 ${
                  showDone ? 'bg-emerald-50 text-emerald-900' : 'bg-white text-slate-600'
                }`}
              >
                已完成
              </button>
            </div>
          </div>

          {/* 批量 / 修第一处 */}
          {(onFixFirst || onFixAll || onClearDone || onMarkAllDone) && (
            <div className="flex flex-wrap gap-1.5">
              {onFixFirst && overview.openCount > 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onFixFirst}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-black text-white text-[11px] font-bold hover:bg-neutral-800 disabled:opacity-50"
                  title="AI 局部改写第一条优先待修（跨章/硬伤/去AI），成功后自动勾完成"
                >
                  <Wrench size={11} />
                  AI修第一处
                </button>
              )}
              {onFixAll &&
                (fixAllRunning ? (
                  onStopFixAll && (
                    <button
                      type="button"
                      onClick={onStopFixAll}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-rose-600 text-white text-[10px] font-bold hover:bg-rose-700"
                      title="停止一键修全部：置软停标志并中断当前 AI 调用，已修成果保留"
                    >
                      <Square size={11} />
                      ⏹ 停止
                    </button>
                  )
                ) : (
                  overview.openCount > 0 && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={onFixAll}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-indigo-600 text-white text-[10px] font-bold hover:bg-indigo-700 disabled:opacity-50"
                      title="串行 AI 局部改写全书所有未完成待修（优先跨章/硬伤/去AI），带进度与失败容忍"
                    >
                      <Zap size={11} />
                      ⚡ 一键修全部 ({overview.openCount})
                    </button>
                  )
                ))}
              {onClearDone && overview.doneCount > 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onClearDone}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-700 text-[10px] font-semibold hover:bg-slate-50 disabled:opacity-50"
                  title="删除全部已勾完成的待修"
                >
                  <Trash2 size={11} />
                  清空已完成
                </button>
              )}
              {onMarkAllDone && overview.openCount > 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onMarkAllDone}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-black bg-black text-white text-[11px] font-bold hover:bg-neutral-800 disabled:opacity-50"
                  title="将全书未完成待修全部标为完成（不改正文）"
                >
                  <CheckCheck size={11} />
                  全部勾完
                </button>
              )}
            </div>
          )}

          <ul className="space-y-1 max-h-52 overflow-y-auto">
            {list.length === 0 ? (
              <li className="text-[10px] text-slate-400 text-center py-3">
                {showDone ? '还没有勾完成的项' : '暂无未完成项'}
              </li>
            ) : (
              list.map((e) => {
                const isActive = e.chapterId === activeChapterId;
                const done = e.todo.status === 'done';
                const ch = chapterById.get(e.chapterId);
                const locked = ch ? isChapterLocked(ch) : false;
                return (
                  <li
                    key={`${e.chapterId}-${e.todo.id}`}
                    className={`flex items-start gap-1.5 text-[10px] p-2 rounded-lg border ${
                      isActive
                        ? 'border-rose-300 bg-rose-50/80'
                        : done
                          ? 'border-slate-100 bg-slate-50'
                          : 'border-slate-200 bg-white'
                    }`}
                  >
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onToggleTodo(e.chapterId, e.todo.id)}
                      className="mt-0.5 shrink-0 text-rose-700 disabled:opacity-50"
                      title={done ? '标为未完成' : '标为完成'}
                    >
                      {done ? (
                        <CheckCircle2 size={13} className="text-emerald-600" />
                      ) : (
                        <Circle size={13} />
                      )}
                    </button>
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => onJumpChapter(e.chapterId, e.todo.id)}
                        className={`block w-full text-left leading-relaxed text-slate-800 hover:text-indigo-900 ${
                          done ? 'line-through text-slate-500' : ''
                        }`}
                        title="跳转该章并高亮此待修"
                      >
                        {e.todo.text}
                      </button>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <button
                          type="button"
                          onClick={() => onJumpChapter(e.chapterId, e.todo.id)}
                          className="inline-flex items-center gap-0.5 text-indigo-700 hover:underline font-semibold"
                          title="定位到正文待修"
                        >
                          定位 · 第{e.chapterNumber}章
                          {e.chapterTitle ? ` · ${e.chapterTitle}` : ''}
                          <ExternalLink size={10} />
                        </button>
                        {!done && onAiFixTodo && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onAiFixTodo(e.chapterId, e.todo.id)}
                            className="inline-flex items-center gap-0.5 text-rose-800 hover:underline font-bold disabled:opacity-50"
                            title="AI 按本条待修局部改写正文，成功后自动勾完成"
                          >
                            <Wrench size={10} />
                            AI修
                          </button>
                        )}
                        {!done && onOpenForRewrite && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onOpenForRewrite(e.chapterId, e.todo.id)}
                            className="inline-flex items-center gap-0.5 text-amber-800 hover:underline font-semibold disabled:opacity-50"
                            title={
                              locked
                                ? '仅解锁并定位（不调 AI）'
                                : '仅定位正文（不调 AI）'
                            }
                          >
                            <Unlock size={10} />
                            {locked ? '解锁定位' : '定位'}
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
};
