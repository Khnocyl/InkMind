import { proseWords } from '../../services/proseWords';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Chapter,
  ChapterRevisionTodo,
  Character,
  StoryMemory,
  StyleConfig,
  WorldSetting,
} from '../../types/novel';
import {
  Sparkles,
  Check,
  RefreshCw,
  Edit3,
  Lock,
  Unlock,
  Minimize2,
  Maximize2,
  Snowflake,
  Flame,
  Scissors,
  Search,
  ChevronDown,
  ChevronUp,
  ListTodo,
  Plus,
  Trash2,
} from 'lucide-react';
import { isChapterLocked, lockReason } from '../../services/chapterLock';
import { findProseSnippetRange } from '../../services/aiTasteScan';
import {
  LOCAL_REWRITE_ACTIONS,
  runLocalRewrite,
  sliceSurroundings,
  type LocalRewriteAction,
} from '../../services/localRewrite';
import { locateRevisionHighlightRanges } from '../../services/revisionAiFix';

function newTodoId(): string {
  return `todo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

interface WritingCanvasProps {
  chapter: Chapter;
  onUpdateChapter: (updated: Chapter) => void;
  isGenerating: boolean;
  onUnlockChapter?: () => void;
  onLockChapter?: () => void;
  /** 局部重写上下文 */
  characters?: Character[];
  settings?: WorldSetting[];
  styleConfig?: StyleConfig | null;
  storyMemory?: StoryMemory | null;
  /** 本书题材：文风档案题材不匹配时降级为只学文笔层 */
  bookGenre?: string | null;
  /**
   * 从「全书待修」跳转时传入的 todoId：展开清单、高亮条目，并尝试在正文选中相关片段。
   */
  focusTodoId?: string | null;
  /** 高亮消费后回调，避免反复触发 */
  onFocusTodoConsumed?: () => void;
  /** AI 味报告等：直接定位正文片段 */
  focusSnippet?: string | null;
  onFocusSnippetConsumed?: () => void;
}

const ACTION_ICON: Partial<Record<LocalRewriteAction, React.ReactNode>> = {
  remove_cliche: <Sparkles size={13} />,
  compress: <Minimize2 size={13} />,
  expand: <Maximize2 size={13} />,
  more_restrained: <Snowflake size={13} />,
  more_intense: <Flame size={13} />,
  strip_sublimation: <Scissors size={13} />,
  check_logic: <Search size={13} />,
};

export const WritingCanvas: React.FC<WritingCanvasProps> = ({
  chapter,
  onUpdateChapter,
  isGenerating,
  onUnlockChapter,
  onLockChapter,
  characters = [],
  settings = [],
  styleConfig,
  storyMemory,
  bookGenre,
  focusTodoId = null,
  onFocusTodoConsumed,
  focusSnippet = null,
  onFocusSnippetConsumed,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const proseMirrorRef = useRef<HTMLDivElement>(null);
  const todoItemRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const [selectedText, setSelectedText] = useState('');
  const [selRange, setSelRange] = useState<{ start: number; end: number } | null>(null);
  const [selectionPos, setSelectionPos] = useState<{ x: number; y: number } | null>(null);
  const [isInlineProcessing, setIsInlineProcessing] = useState(false);
  const [inlineFeedback, setInlineFeedback] = useState<string | null>(null);
  const openTodoCount = (chapter.revisionTodos || []).filter((t) => t.status === 'open').length;
  // 默认收起（收束）：标题栏保留「N 项未完成」徽标可感知，避免一进画布就占满清单
  const [todosOpen, setTodosOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [todoDraft, setTodoDraft] = useState('');
  /** 清单条目高亮（点击 / 外部跳转） */
  const [highlightedTodoId, setHighlightedTodoId] = useState<string | null>(null);
  /** 正文红色波浪线范围 */
  const [wavyRanges, setWavyRanges] = useState<{ start: number; end: number }[]>([]);
  const locked = isChapterLocked(chapter);
  // 局部精修期间同样锁正文：改写注入按偏移重建全文，期间击键会被静默覆盖
  const contentReadOnly = isGenerating || locked || isInlineProcessing;
  /** 最新正文快照：局部精修 await 后闭包内 chapter 是旧值，提交前用 ref 校验正文未被改动 */
  const chapterContentRef = useRef(chapter.content);
  chapterContentRef.current = chapter.content;

  const proseFontStyle: React.CSSProperties = {
    fontFamily: '"Noto Serif SC", "Songti SC", Georgia, serif',
    fontSize: undefined, // 由 class 控制
    lineHeight: 2.1,
  };

  const scrollProseToOffset = useCallback((start: number) => {
    const ta = textareaRef.current;
    if (!ta || !chapter.content) return;
    // 行高取实际渲染值（text-base/lg × lineHeight 2.1），避免常量与字号失配导致定位偏差
    const lineHeight = parseFloat(window.getComputedStyle(ta).lineHeight) || 28.5;
    const before = chapter.content.slice(0, start);
    const lineApprox = before.split('\n').length;
    const top = Math.max(0, (lineApprox - 3) * lineHeight);
    ta.scrollTop = top;
    if (proseMirrorRef.current) proseMirrorRef.current.scrollTop = top;
  }, [chapter.content]);

  /** 点击待修 / 外部定位：清单高亮 + 正文红波浪线 */
  const applyTodoProseHighlight = useCallback(
    (todo: ChapterRevisionTodo | undefined, options?: { scrollList?: boolean }) => {
      if (!todo) {
        setWavyRanges([]);
        setHighlightedTodoId(null);
        return;
      }
      setTodosOpen(true);
      setHighlightedTodoId(todo.id);
      if (options?.scrollList !== false) {
        requestAnimationFrame(() => {
          todoItemRefs.current[todo.id]?.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
          });
        });
      }

      const content = chapter.content || '';
      if (!content.trim()) {
        setWavyRanges([]);
        setInlineFeedback('本章暂无正文');
        window.setTimeout(() => setInlineFeedback(null), 2000);
        return;
      }

      const ranges = locateRevisionHighlightRanges(content, todo.text);
      setWavyRanges(ranges.map((r) => ({ start: r.start, end: r.end })));

      if (ranges.length && textareaRef.current) {
        const first = ranges[0];
        const ta = textareaRef.current;
        // 只读/生成中仍允许滚动定位；锁定时 focus 也可能
        try {
          ta.focus({ preventScroll: true });
          ta.setSelectionRange(first.start, Math.min(first.end, first.start + 80));
        } catch {
          /* ignore */
        }
        scrollProseToOffset(first.start);
        setSelRange({ start: first.start, end: first.end });
        setSelectedText(content.slice(first.start, first.end));
        const preview = content.slice(first.start, first.end).replace(/\s+/g, ' ').slice(0, 18);
        setInlineFeedback(
          ranges.length > 1
            ? `红色波浪线 · ${ranges.length} 处 · 「${preview}」…`
            : `红色波浪线定位 · 「${preview}」…`
        );
        window.setTimeout(() => setInlineFeedback(null), 3200);
      } else {
        setWavyRanges([]);
        setInlineFeedback('已选中待修（正文未匹配到相关片段）');
        window.setTimeout(() => setInlineFeedback(null), 2400);
      }
    },
    [chapter.content, scrollProseToOffset]
  );

  const handleClickTodo = (todo: ChapterRevisionTodo) => {
    // 再点同一条：取消波浪线
    if (highlightedTodoId === todo.id && wavyRanges.length > 0) {
      setHighlightedTodoId(null);
      setWavyRanges([]);
      setInlineFeedback(null);
      return;
    }
    applyTodoProseHighlight(todo, { scrollList: false });
  };

  // 换章时：重置面板为收起（待修清单默认收束，不再自动弹开占屏）
  useEffect(() => {
    setTodosOpen(false);
    setTodoDraft('');
    setHighlightedTodoId(null);
    setWavyRanges([]);
    // 划选弹窗状态一并清空：残留的 selRange 配新章 content 会把改写注入到错误偏移
    setSelectedText('');
    setSelRange(null);
    setSelectionPos(null);
    setInlineFeedback(null);
    // 刻意只按 chapter.id 触发（换章重置面板）；同章待修变化不重置，避免打断用户
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter.id]);

  // 全书待修 / 修第一处 → 定位：清单 + 红色波浪线
  useEffect(() => {
    if (!focusTodoId) return;
    const target = (chapter.revisionTodos || []).find((t) => t.id === focusTodoId);
    applyTodoProseHighlight(target, { scrollList: true });
    onFocusTodoConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTodoId]);

  // AI 味命中 → 正文选区 + 波浪线
  useEffect(() => {
    if (!focusSnippet?.trim() || !chapter.content) return;
    const range = findProseSnippetRange(chapter.content, focusSnippet);
    if (range && textareaRef.current) {
      const ta = textareaRef.current;
      try {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(range.start, range.end);
      } catch {
        /* ignore */
      }
      scrollProseToOffset(range.start);
      setSelRange(range);
      setSelectedText(chapter.content.slice(range.start, range.end));
      setWavyRanges([{ start: range.start, end: range.end }]);
      setInlineFeedback(
        `已定位「${chapter.content.slice(range.start, range.end).slice(0, 20)}」`
      );
      window.setTimeout(() => setInlineFeedback(null), 2800);
    } else {
      setInlineFeedback('正文中未找到该片段（可能已改写）');
      window.setTimeout(() => setInlineFeedback(null), 2200);
    }
    onFocusSnippetConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSnippet]);

  /** 镜像层：把正文切开，标红波浪 */
  const proseMirrorNodes = useMemo(() => {
    const content = chapter.content || '';
    if (!content) return null;
    if (!wavyRanges.length) return content;

    const sorted = [...wavyRanges]
      .filter((r) => r.end > r.start)
      .sort((a, b) => a.start - b.start);
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    sorted.forEach((r, i) => {
      const start = Math.max(0, Math.min(content.length, r.start));
      const end = Math.max(start, Math.min(content.length, r.end));
      if (start > cursor) {
        nodes.push(
          <React.Fragment key={`t-${i}-${cursor}`}>
            {content.slice(cursor, start)}
          </React.Fragment>
        );
      }
      if (end > start) {
        nodes.push(
          <span key={`w-${i}-${start}`} className="revision-wavy-mark">
            {content.slice(start, end)}
          </span>
        );
      }
      cursor = end;
    });
    if (cursor < content.length) {
      nodes.push(
        <React.Fragment key={`t-end-${cursor}`}>{content.slice(cursor)}</React.Fragment>
      );
    }
    return nodes;
  }, [chapter.content, wavyRanges]);

  const syncMirrorScroll = () => {
    const ta = textareaRef.current;
    const mir = proseMirrorRef.current;
    if (ta && mir) {
      mir.scrollTop = ta.scrollTop;
      mir.scrollLeft = ta.scrollLeft;
    }
  };

  const patchTodos = (todos: ChapterRevisionTodo[]) => {
    onUpdateChapter({
      ...chapter,
      revisionTodos: todos,
      lastModified: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    });
  };

  const handleAddTodo = () => {
    const text = todoDraft.trim();
    if (!text) return;
    const item: ChapterRevisionTodo = {
      id: newTodoId(),
      text,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    patchTodos([item, ...(chapter.revisionTodos || [])]);
    setTodoDraft('');
    setTodosOpen(true);
  };

  const handleToggleTodo = (id: string) => {
    const todos = (chapter.revisionTodos || []).map((t) => {
      if (t.id !== id) return t;
      if (t.status === 'open') {
        return { ...t, status: 'done' as const, doneAt: new Date().toISOString() };
      }
      return { ...t, status: 'open' as const, doneAt: undefined };
    });
    patchTodos(todos);
  };

  const handleRemoveTodo = (id: string) => {
    patchTodos((chapter.revisionTodos || []).filter((t) => t.id !== id));
  };

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (locked) return;
    onUpdateChapter({ ...chapter, title: e.target.value });
  };

  const handleSummaryChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onUpdateChapter({ ...chapter, summary: e.target.value });
  };

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (locked) return;
    const text = e.target.value;
    const wordCount = proseWords(text);
    // 编辑后波浪线索引易错位：按当前高亮待修重算，否则清空
    if (highlightedTodoId) {
      const todo = (chapter.revisionTodos || []).find((t) => t.id === highlightedTodoId);
      if (todo) {
        const ranges = locateRevisionHighlightRanges(text, todo.text);
        setWavyRanges(ranges.map((r) => ({ start: r.start, end: r.end })));
      } else {
        setWavyRanges([]);
      }
    } else if (wavyRanges.length) {
      setWavyRanges([]);
    }
    onUpdateChapter({
      ...chapter,
      content: text,
      wordCount,
      contentUpdatedAt: new Date().toISOString(),
      lastModified: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
  };

  const captureSelection = (e: React.MouseEvent<HTMLTextAreaElement> | React.KeyboardEvent<HTMLTextAreaElement>) => {
    const textarea = e.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value.substring(start, end);

    if (text.trim().length > 3) {
      setSelectedText(text);
      setSelRange({ start, end });
      if ('clientX' in e) {
        setSelectionPos({
          // 弹窗实宽可达 520px（max-w-[min(520px,96vw)]），钳位须按 540 预留，否则右缘溢出被裁
          x: Math.max(8, Math.min(e.clientX, window.innerWidth - 540)),
          y: Math.max(e.clientY - 80, 72),
        });
      } else {
        // 键盘选区：放在画布上方大致位置
        const rect = textarea.getBoundingClientRect();
        setSelectionPos({
          x: Math.max(8, Math.min(rect.left + 40, window.innerWidth - 540)),
          y: Math.max(rect.top + 40, 72),
        });
      }
    } else {
      setSelectedText('');
      setSelRange(null);
      setSelectionPos(null);
    }
  };

  const handleInlineAIAction = async (actionType: LocalRewriteAction) => {
    if (!selectedText || !selRange) return;
    const meta = LOCAL_REWRITE_ACTIONS.find((a) => a.id === actionType);
    if (locked && meta?.mutates) {
      setInlineFeedback('🔒 本章已定稿锁定，无法改写正文。请先解锁。');
      setSelectedText('');
      setSelRange(null);
      setSelectionPos(null);
      return;
    }
    setIsInlineProcessing(true);
    setInlineFeedback(null);

    try {
      const { before, after } = sliceSurroundings(
        chapter.content,
        selRange.start,
        selRange.end
      );
      const { text, mutates } = await runLocalRewrite(selectedText, actionType, {
        chapter,
        characters,
        settings,
        styleConfig,
        storyMemory,
        bookGenre,
        surroundingBefore: before,
        surroundingAfter: after,
      });

      if (!mutates) {
        setInlineFeedback(`🛡️ 硬伤瞥：${text}`);
      } else {
        // 按索引替换，避免同文多次出现时误伤。
        // await 期间闭包里的 chapter 是旧值：先取最新正文校验选区原文未被改动，再基于最新正文重建
        const latest = chapterContentRef.current || '';
        if (latest.slice(selRange.start, selRange.end) !== selectedText) {
          setInlineFeedback('⚠️ 正文在处理期间已变化，未注入改写。请重新划选。');
          return;
        }
        const newContent = latest.slice(0, selRange.start) + text + latest.slice(selRange.end);
        onUpdateChapter({
          ...chapter,
          content: newContent,
          wordCount: proseWords(newContent),
          contentUpdatedAt: new Date().toISOString(),
          lastModified: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
        const labels: Record<string, string> = {
          remove_cliche: '已去 AI 味',
          strip_sublimation: '已截断升华',
          expand: '已扩写',
          compress: '已压缩',
          more_restrained: '已调更克制',
          more_intense: '已调更狠',
        };
        setInlineFeedback(`✨ ${labels[actionType] || '已改写'}（已注入记忆/意图约束）`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setInlineFeedback(`❌ 操作失败: ${msg}`);
    } finally {
      setSelectedText('');
      setSelRange(null);
      setSelectionPos(null);
      setIsInlineProcessing(false);
    }
  };

  return (
    <main className="flex-1 bg-transparent text-slate-900 overflow-hidden px-6 pt-3 pb-0 relative flex flex-col items-center select-none theme-paper">
      {selectionPos && selectedText && (
        <div
          style={{ left: `${selectionPos.x}px`, top: `${selectionPos.y}px` }}
          className="fixed z-50 bg-white text-slate-900 px-2.5 py-2 rounded-xl shadow-2xl border border-slate-300 flex flex-wrap items-center gap-1 max-w-[min(520px,96vw)] text-xs backdrop-blur-xl animate-fadeIn"
        >
          {isInlineProcessing ? (
            <div className="flex items-center space-x-2 py-1 px-3 text-neutral-800 font-semibold">
              <RefreshCw size={14} className="animate-spin" />
              <span>局部精修中（记忆/意图已注入）...</span>
            </div>
          ) : (
            <>
              <span className="text-[10px] text-slate-500 font-semibold mr-1 flex items-center space-x-1 px-1">
                <Edit3 size={12} className="text-neutral-500" />
                <span>划线</span>
              </span>
              {locked && (
                <span className="text-[10px] font-semibold text-amber-800 bg-amber-50 border border-amber-300 rounded-lg px-2 py-1.5 mr-0.5">
                  🔒 已锁定 · 需先解锁
                </span>
              )}
              {LOCAL_REWRITE_ACTIONS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => handleInlineAIAction(a.id)}
                  title={locked ? '本章已锁定，解锁后才能改写' : a.title}
                  className="flex items-center space-x-1 bg-black hover:bg-neutral-800 text-white px-2 py-1.5 rounded-lg border border-black transition-all font-medium"
                >
                  {ACTION_ICON[a.id] || <Sparkles size={13} />}
                  <span>{a.label}</span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setSelectedText('');
                  setSelRange(null);
                  setSelectionPos(null);
                }}
                className="text-slate-400 hover:text-slate-700 ml-0.5 px-1.5 font-bold"
              >
                ✕
              </button>
            </>
          )}
        </div>
      )}

      {inlineFeedback && (
        <div className="w-full max-w-4xl mb-6 p-4 bg-slate-100 border border-slate-200 text-slate-900 text-xs font-semibold rounded-xl flex items-center justify-between shadow-md animate-fadeIn">
          <span className="leading-relaxed pr-2">{inlineFeedback}</span>
          <button
            type="button"
            onClick={() => setInlineFeedback(null)}
            className="text-slate-400 hover:text-slate-700 font-bold ml-2 px-2 py-0.5 shrink-0"
          >
            <Check size={16} />
          </button>
        </div>
      )}

      <div className="w-full max-w-[840px] mx-auto flex-1 flex flex-col min-h-0 space-y-2">
        {locked && (
          <div className="shrink-0 p-2.5 bg-emerald-50 border border-emerald-300 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow-sm">
            <div className="flex items-start gap-2 text-xs text-emerald-950">
              <Lock className="w-4 h-4 text-emerald-700 mt-0.5 shrink-0" />
              <div>
                <div className="font-bold">本章已定稿锁定</div>
                <p className="text-[11px] text-emerald-900/80 mt-0.5 leading-relaxed">
                  {lockReason(chapter)}。正文只读；划线精修需先解锁。
                </p>
              </div>
            </div>
            {onUnlockChapter && (
              <button
                type="button"
                onClick={onUnlockChapter}
                disabled={isGenerating}
                className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-black border border-black text-white text-xs font-bold hover:bg-neutral-800 disabled:opacity-50"
              >
                <Unlock size={13} />
                解锁重写
              </button>
            )}
          </div>
        )}

        {!locked &&
          (chapter.status === '待人工确认' || chapter.status === '机检未通过') &&
          onLockChapter && (
            <div className="shrink-0 p-2.5 bg-amber-50 border border-amber-200 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
              <span className="text-amber-950 font-medium">
                机检未绿通。若你认可正文，可「定稿锁定」。也可划线做局部精修。
              </span>
              <button
                type="button"
                onClick={onLockChapter}
                disabled={isGenerating}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black text-white font-bold hover:bg-neutral-800 disabled:opacity-50"
              >
                <Lock size={13} />
                人工定稿锁定
              </button>
            </div>
          )}

        {/* 顶部标题栏与快捷状态指标 */}
        <div className="shrink-0">
          <div className="flex items-center justify-between gap-3 border-b border-neutral-200 pb-2">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <input
                type="text"
                value={chapter.title}
                onChange={handleTitleChange}
                readOnly={locked}
                placeholder="输入章节标题..."
                className={`min-w-0 flex-1 font-serif font-bold text-xl lg:text-2xl text-black bg-white border-none focus:outline-none placeholder-neutral-400 tracking-tight ${
                  locked ? 'cursor-default opacity-90' : ''
                }`}
              />
              <span
                className={`shrink-0 text-[10px] font-bold rounded-full px-2 py-0.5 border whitespace-nowrap ${
                  chapter.status === '校验通过' ||
                  chapter.status === '精修定稿' ||
                  chapter.status === '校验精修定稿'
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                    : chapter.status === '正文草稿' ||
                        chapter.status === '草稿生成中' ||
                        chapter.status === '待人工确认' ||
                        chapter.status === '机检未通过'
                      ? 'bg-amber-50 text-amber-800 border-amber-300'
                      : 'bg-slate-100 text-slate-600 border-slate-300'
                }`}
              >
                {chapter.status || '构思中'}
              </span>
            </div>

            {/* 顶栏右侧快捷信息标识 */}
            <div className="flex items-center space-x-2 text-[11px] font-mono text-slate-500 shrink-0">
              {chapter.volumeNumber != null && (
                <span
                  className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded border border-slate-200 font-mono font-medium"
                  title={`第 ${chapter.volumeNumber} 卷`}
                >
                  {chapter.volumeNumber}
                </span>
              )}
              <span className="bg-emerald-50 text-emerald-800 border border-emerald-200 px-2 py-0.5 rounded font-medium">
                {chapter.wordCount} 字
              </span>
            </div>
          </div>
        </div>

        {/* 本章核心梗概（支持折叠/展开，大幅优化纵向高度） */}
        <div className="shrink-0 rounded-lg border border-slate-200 bg-slate-50/70 overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => setSummaryOpen((v) => !v)}
            className="w-full px-3 py-1.5 flex items-center justify-between text-xs text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <span className="flex items-center gap-1.5 truncate">
              <Sparkles className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
              <span className="font-bold text-slate-800">本章核心梗概</span>
              {chapter.summary ? (
                <span className="text-slate-500 font-normal truncate max-w-[480px]">
                  · {chapter.summary}
                </span>
              ) : (
                <span className="text-slate-400 font-normal">· 点击填写主要情节冲突与悬念钩子...</span>
              )}
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-slate-400 font-mono shrink-0 ml-2">
              {chapter.summary.length} 字
              {summaryOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </span>
          </button>
          {summaryOpen && (
            <div className="px-3 pb-2 pt-1 border-t border-slate-200/60 bg-white">
              <textarea
                rows={2}
                value={chapter.summary}
                onChange={handleSummaryChange}
                placeholder="简要写下本章主要情节冲突、人物转折与剧作悬念钩子..."
                className="w-full text-xs text-slate-800 bg-transparent border-none focus:outline-none resize-none placeholder-slate-400 leading-relaxed"
              />
            </div>
          )}
        </div>

        {/* 待修清单：勾选闭环，锁定后仍可改 */}
        <div className="shrink-0 rounded-xl border border-rose-200 bg-rose-50/40 shadow-sm overflow-hidden">
          <button
            type="button"
            onClick={() => setTodosOpen((v) => !v)}
            className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-bold text-rose-950 hover:bg-rose-50/80"
          >
            <span className="flex items-center gap-1.5">
              <ListTodo size={14} className="text-rose-700" />
              待修清单
              {openTodoCount > 0 ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-200/80 text-rose-900 font-bold">
                  {openTodoCount} 项未完成
                </span>
              ) : (chapter.revisionTodos || []).length > 0 ? (
                <span className="text-[10px] font-normal text-emerald-800">· 已全部勾完</span>
              ) : (
                <span className="text-[10px] font-normal text-rose-800/60">· 读者反馈 / 硬伤 / 节奏</span>
              )}
            </span>
            {todosOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {todosOpen && (
            <div className="px-4 pb-3 space-y-2">
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={todoDraft}
                  onChange={(e) => setTodoDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddTodo();
                    }
                  }}
                  placeholder="添加待修：如「第2段节奏拖沓」「玄清/玄青统一」"
                  disabled={isGenerating}
                  className="flex-1 text-xs text-slate-800 bg-white border border-rose-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-rose-300/40 placeholder-slate-400"
                />
                <button
                  type="button"
                  onClick={handleAddTodo}
                  disabled={isGenerating || !todoDraft.trim()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-black text-white text-[11px] font-bold hover:bg-neutral-800 disabled:opacity-50"
                >
                  <Plus size={13} />
                  添加
                </button>
              </div>
              <ul className="space-y-1 max-h-40 overflow-y-auto">
                {(chapter.revisionTodos || []).map((t) => (
                  <li
                    key={t.id}
                    ref={(node) => {
                      todoItemRefs.current[t.id] = node;
                    }}
                    className={`flex items-start gap-2 text-xs px-2 py-1.5 rounded-lg border transition-all duration-300 ${
                      highlightedTodoId === t.id
                        ? 'bg-rose-100 border-rose-400 ring-2 ring-rose-300 shadow-sm text-slate-900'
                        : t.status === 'done'
                          ? 'bg-white/60 border-slate-200 text-slate-500'
                          : 'bg-white border-rose-100 text-slate-800'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={t.status === 'done'}
                      onChange={() => handleToggleTodo(t.id)}
                      disabled={isGenerating}
                      className="mt-0.5 accent-rose-600"
                      onClick={(e) => e.stopPropagation()}
                    />
                    <button
                      type="button"
                      onClick={() => handleClickTodo(t)}
                      className={`flex-1 text-left leading-relaxed hover:text-rose-900 ${
                        t.status === 'done' ? 'line-through' : ''
                      }`}
                      title="点击在正文标红色波浪线（再点取消）"
                    >
                      {t.text}
                      {highlightedTodoId === t.id && wavyRanges.length > 0 && (
                        <span className="ml-1.5 text-[10px] font-bold text-rose-600 no-underline inline-block">
                          〰 正文
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveTodo(t.id)}
                      disabled={isGenerating}
                      className="text-slate-400 hover:text-red-600 p-0.5 disabled:opacity-50"
                      title="删除"
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
                {(chapter.revisionTodos || []).length === 0 && (
                  <li className="text-[10px] text-rose-900/50 text-center py-2">
                    暂无条目。审校未绿通或读者反馈可记在这里。
                  </li>
                )}
              </ul>
              {(chapter.revisionTodos || []).length > 0 && (
                <p className="text-[10px] text-rose-800/70">
                  点击待修文案 → 正文红色波浪线定位相关片段；再点同一条取消。
                </p>
              )}
            </div>
          )}
        </div>

        {/* 正文编辑区：单滚动条，充满剩余纵向空间 */}
        <div className="relative flex-1 min-h-0 w-full flex flex-col pt-1">
          <div className="flex items-center justify-between text-[10.5px] text-slate-400 py-1 shrink-0 select-none">
            <span title="划选 ≥4 字弹出局部精修：去AI味 / 压缩 / 扩写 / 更克制 / 更狠 / 截升华 / 硬伤瞥（自动带记忆与写前意图）">
              划选正文可局部精修（悬浮查看全部选项）。
            </span>
            {wavyRanges.length > 0 && (
              <span className="text-rose-600 font-semibold">
                · 待修波浪线 {wavyRanges.length} 段
                <button
                  type="button"
                  className="ml-1 underline font-bold hover:text-rose-800"
                  onClick={() => {
                    setWavyRanges([]);
                    setHighlightedTodoId(null);
                  }}
                >
                  清除
                </button>
              </span>
            )}
          </div>

          <div className="relative flex-1 min-h-0 w-full">
            {/* 镜像层：红色波浪线（textarea 无法自绘 underline） */}
            {wavyRanges.length > 0 && (
              <div
                ref={proseMirrorRef}
                aria-hidden
                className="prose-mirror-layer absolute inset-0 z-0 w-full h-full font-serif text-base lg:text-lg text-slate-900 bg-transparent leading-loose overflow-hidden"
                style={{
                  ...proseFontStyle,
                  padding: 0,
                }}
              >
                {proseMirrorNodes}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={chapter.content}
              onChange={handleContentChange}
              onScroll={syncMirrorScroll}
              onMouseUp={captureSelection}
              onKeyUp={captureSelection}
              placeholder={
                isGenerating
                  ? '✍️ AI 引擎正在流式执笔中...'
                  : locked
                    ? '本章已定稿锁定。需要改写请点「解锁重写」。'
                    : '在这里沉浸执笔，或点右侧启动闭环……\n划选段落可做局部精修。'
              }
              disabled={contentReadOnly}
              readOnly={locked}
              className={`relative z-10 w-full h-full font-serif text-base lg:text-lg border-none focus:outline-none resize-none leading-loose placeholder-neutral-400 p-0 select-text overflow-y-auto ${
                wavyRanges.length > 0
                  ? 'bg-transparent text-transparent caret-slate-900'
                  : 'bg-transparent text-slate-900 caret-current'
              }`}
              style={{
                ...proseFontStyle,
              }}
              spellCheck={false}
            />
          </div>
        </div>

        {/* 底部固定状态条：始终常驻可视，无需向下滚动 */}
        <div className="shrink-0 w-full py-2.5 border-t border-slate-200 text-xs text-slate-500 flex justify-between items-center font-mono bg-transparent select-none">
          <div className="flex items-center space-x-3">
            <span>
              状态: <strong className="text-neutral-900 font-medium">{chapter.status}</strong>
            </span>
            {chapter.volumeNumber && <span>卷属: 第 {chapter.volumeNumber} 卷</span>}
            {locked && (
              <span className="text-emerald-700 flex items-center gap-0.5">
                <Lock size={11} /> 锁定
              </span>
            )}
          </div>
          <div className="flex items-center space-x-4">
            <span>上次更新: {chapter.lastModified || '刚刚'}</span>
            <span>
              本章正文字数:{' '}
              <strong className="text-emerald-700 font-medium">{chapter.wordCount}</strong> 字
            </span>
          </div>
        </div>
      </div>
    </main>
  );
};
