import React, { useMemo, useState } from 'react';
import type { Chapter, Volume } from '../../types/novel';
import {
  Plus,
  Search,
  CheckCircle2,
  Clock,
  Edit3,
  Layers,
  ChevronDown,
  ChevronRight,
  Lock,
  ListTodo,
  Trash2,
  Eraser,
  RotateCcw,
} from 'lucide-react';
import { isChapterLocked } from '../../services/chapterLock';

function openTodoCount(ch: Chapter): number {
  return (ch.revisionTodos || []).filter((t) => t.status === 'open').length;
}

interface ChapterSidebarProps {
  chapters: Chapter[];
  volumes?: Volume[];
  activeChapterId: string;
  onSelectChapter: (id: string) => void;
  onAddChapter: (volumeId?: string, volumeNumber?: number) => void;
  /** 删除章节（侧栏垃圾桶） */
  onDeleteChapter?: (id: string) => void;
  /** 清空本版全部章节（重置为 1 章空白） */
  onClearAllChapters?: () => void;
  /** 仅清空全部正文，保留章序与大纲 */
  onClearAllChapterBodies?: () => void;
  /** 生成中禁用删除 */
  deleteDisabled?: boolean;
}

export const ChapterSidebar: React.FC<ChapterSidebarProps> = ({
  chapters,
  volumes = [],
  activeChapterId,
  onSelectChapter,
  onAddChapter,
  onDeleteChapter,
  onClearAllChapters,
  onClearAllChapterBodies,
  deleteDisabled = false,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [clearMenuOpen, setClearMenuOpen] = useState(false);
  const [expandedVolIds, setExpandedVolIds] = useState<string[]>(
    volumes.map((v) => v.id).concat(['default-vol'])
  );
  const totalOpenTodos = useMemo(
    () => chapters.reduce((s, c) => s + openTodoCount(c), 0),
    [chapters]
  );

  const toggleVol = (id: string) => {
    setExpandedVolIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const filteredChapters = chapters.filter(
    (c) =>
      c.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.summary.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const getStatusBadge = (chapter: Chapter) => {
    const status = chapter.status;
    if (isChapterLocked(chapter)) {
      return (
        <span className="flex items-center space-x-1 text-[10px] bg-black border border-black text-white px-1.5 py-0.5 rounded font-medium">
          <Lock size={10} className="text-emerald-700" />
          <span>锁定</span>
        </span>
      );
    }
    switch (status) {
      case '校验通过':
      case '精修定稿':
      case '校验精修定稿':
        return (
          <span className="flex items-center space-x-1 text-[10px] bg-emerald-50 border border-emerald-300 text-emerald-800 px-1.5 py-0.5 rounded font-medium">
            <CheckCircle2 size={10} className="text-emerald-600" />
            <span>定稿</span>
          </span>
        );
      case '待人工确认':
      case '机检未通过':
        return (
          <span className="flex items-center space-x-1 text-[10px] bg-amber-50 border border-amber-400 text-amber-900 px-1.5 py-0.5 rounded font-medium">
            <Clock size={10} className="text-amber-600" />
            <span>待人工</span>
          </span>
        );
      case '草稿生成中':
      case '正文草稿':
        return (
          <span className="flex items-center space-x-1 text-[10px] bg-amber-50 border border-amber-300 text-amber-800 px-1.5 py-0.5 rounded font-medium">
            <Clock size={10} className="text-amber-600" />
            <span>草稿</span>
          </span>
        );
      default:
        return (
          <span className="flex items-center space-x-1 text-[10px] bg-slate-100 border border-slate-300 text-slate-700 px-1.5 py-0.5 rounded font-medium">
            <Edit3 size={10} className="text-slate-500" />
            <span>{status || '构思中'}</span>
          </span>
        );
    }
  };

  const renderChapterItem = (chapter: Chapter) => {
    const isActive = chapter.id === activeChapterId;
    const todos = openTodoCount(chapter);
    const locked = isChapterLocked(chapter);
    return (
      <div
        key={chapter.id}
        onClick={() => onSelectChapter(chapter.id)}
        className={`group p-3 cursor-pointer transition-all border-l-4 ${
          isActive
            ? 'bg-indigo-50 border-indigo-600 shadow-sm'
            : 'hover:bg-slate-100 border-transparent text-slate-700'
        }`}
      >
        <div className="flex items-center justify-between mb-1 gap-1">
          <span
            className={`text-xs font-bold flex items-center gap-1 min-w-0 ${
              isActive ? 'text-indigo-900' : 'text-slate-800'
            }`}
          >
            第 {chapter.number} 章
            {todos > 0 && (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1 py-0.5 rounded bg-rose-100 text-rose-800 border border-rose-200 shrink-0"
                title={`${todos} 项待修`}
              >
                <ListTodo size={9} />
                {todos}
              </span>
            )}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            {getStatusBadge(chapter)}
            {onDeleteChapter && (
              <button
                type="button"
                disabled={deleteDisabled}
                onClick={(e) => {
                  e.stopPropagation();
                  if (deleteDisabled) return;
                  onDeleteChapter(chapter.id);
                }}
                className={`p-1 rounded-md transition-colors ${
                  deleteDisabled
                    ? 'text-slate-300 cursor-not-allowed'
                    : 'text-slate-400 opacity-0 group-hover:opacity-100 hover:text-red-600 hover:bg-red-50 focus:opacity-100'
                } ${isActive && !deleteDisabled ? 'opacity-100' : ''}`}
                title={
                  locked
                    ? '删除已锁定章节（需确认）'
                    : deleteDisabled
                      ? '生成进行中，暂不可删除'
                      : '删除本章'
                }
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </div>
        <h3 className={`text-xs mb-1 line-clamp-1 font-serif ${isActive ? 'text-slate-900 font-bold' : 'text-slate-800'}`}>
          {chapter.title}
        </h3>
        <p className="text-[11px] text-slate-600 line-clamp-2 leading-relaxed mb-1.5">
          {chapter.summary || '暂无剧情梗概...'}
        </p>
        <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
          <span>字数: {chapter.wordCount}</span>
          <span>{chapter.lastModified || '近期'}</span>
        </div>
      </div>
    );
  };

  return (
    <aside className="w-72 bg-white border-r border-neutral-200 flex flex-col h-[calc(100vh-61px)] shrink-0 select-none text-black">
      {/* 侧栏标题与全局新建按钮 */}
      <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-white gap-2">
        <div className="flex items-center space-x-2 min-w-0">
          <Layers size={16} className="text-indigo-600 shrink-0" />
          <h2 className="font-bold text-sm text-slate-900 tracking-wide truncate">
            全书分卷 & 章节目录
          </h2>
          {totalOpenTodos > 0 && (
            <span
              className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-900 border border-rose-200"
              title={`全书 ${totalOpenTodos} 项待修`}
            >
              <ListTodo size={10} />
              {totalOpenTodos}
            </span>
          )}
        </div>
        <button
          onClick={() => onAddChapter()}
          className="flex items-center space-x-1 bg-black hover:bg-neutral-800 text-white px-2.5 py-1 rounded-lg text-xs font-medium transition-all shadow-sm shrink-0"
          title="创建新章节"
        >
          <Plus size={13} />
          <span>新章</span>
        </button>
      </div>

      {/* 搜索过滤框 */}
      <div className="p-3 border-b border-slate-200 bg-slate-100/60">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="搜索章节或剧情梗概..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-600 transition-all shadow-inner"
          />
        </div>
      </div>

      {/* 章节与分卷树状手风琴列表 */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-200">
        {volumes && volumes.length > 0 && !searchTerm ? (
          volumes.map((vol) => {
            const volChaps = filteredChapters.filter(
              (c) => c.volumeId === vol.id || c.volumeNumber === vol.number
            );
            const isExpanded = expandedVolIds.includes(vol.id);

            return (
              <div key={vol.id} className="bg-white">
                <div
                  onClick={() => toggleVol(vol.id)}
                  className="p-3 bg-slate-100/80 hover:bg-slate-200/80 cursor-pointer flex items-center justify-between border-b border-slate-200 transition-colors"
                >
                  <div className="flex items-center space-x-1.5 min-w-0 flex-1">
                    {isExpanded ? <ChevronDown size={14} className="text-indigo-600" /> : <ChevronRight size={14} className="text-slate-500" />}
                    <span className="font-bold text-xs text-slate-900 truncate">{vol.title}</span>
                  </div>
                  <div className="flex items-center space-x-1.5 ml-2">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white border border-slate-300 text-indigo-700 font-mono font-bold">
                      {volChaps.length} 章
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onAddChapter(vol.id, vol.number);
                      }}
                      className="p-1 text-slate-600 hover:text-indigo-600 hover:bg-slate-200 rounded transition-colors"
                      title={`在 ${vol.title} 追加新章`}
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="divide-y divide-slate-100 bg-white">
                    {volChaps.map(renderChapterItem)}
                    {volChaps.length === 0 && (
                      <div className="p-3 text-center text-[11px] text-slate-500">本卷暂无章节</div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div>
            {filteredChapters.map(renderChapterItem)}
            {filteredChapters.length === 0 && (
              <div className="p-8 text-center text-xs text-slate-500">未找到匹配的章节</div>
            )}
          </div>
        )}
      </div>

      {/* 底部：统计 + 清空本版章节 */}
      <div className="p-3 border-t border-slate-200 bg-white space-y-2">
        <div className="text-[11px] text-slate-600 flex justify-between items-center font-mono">
          <span>共 {chapters.length} 章节</span>
          <span className="flex items-center space-x-1 text-emerald-600 font-sans font-medium">
            <CheckCircle2 size={11} />
            <span>记忆切片就绪</span>
          </span>
        </div>
        {(onClearAllChapters || onClearAllChapterBodies) && (
          <div className="relative">
            <button
              type="button"
              disabled={deleteDisabled || chapters.length === 0}
              onClick={() => setClearMenuOpen((v) => !v)}
              className="w-full inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-rose-200 bg-rose-50 text-rose-900 text-[11px] font-bold hover:bg-rose-100 disabled:opacity-50 disabled:cursor-not-allowed"
              title="清空本版章节（双确认，建议先导出/快照）"
            >
              <Eraser size={12} />
              清空章节
              <ChevronDown size={12} className={clearMenuOpen ? 'rotate-180' : ''} />
            </button>
            {clearMenuOpen && (
              <div className="absolute bottom-full left-0 right-0 mb-1 rounded-lg border border-slate-200 bg-white shadow-lg overflow-hidden z-20">
                {onClearAllChapterBodies && (
                  <button
                    type="button"
                    disabled={deleteDisabled}
                    onClick={() => {
                      setClearMenuOpen(false);
                      onClearAllChapterBodies();
                    }}
                    className="w-full text-left px-3 py-2 text-[11px] text-slate-800 hover:bg-amber-50 border-b border-slate-100 disabled:opacity-50"
                  >
                    <span className="font-bold text-amber-900 flex items-center gap-1">
                      <RotateCcw size={11} />
                      仅清空全部正文
                    </span>
                    <span className="block text-[10px] text-slate-500 mt-0.5">
                      保留章序、标题、梗概；删正文与写前大纲，便于同一版重写
                    </span>
                  </button>
                )}
                {onClearAllChapters && (
                  <button
                    type="button"
                    disabled={deleteDisabled}
                    onClick={() => {
                      setClearMenuOpen(false);
                      onClearAllChapters();
                    }}
                    className="w-full text-left px-3 py-2 text-[11px] text-slate-800 hover:bg-rose-50 disabled:opacity-50"
                  >
                    <span className="font-bold text-rose-900 flex items-center gap-1">
                      <Trash2 size={11} />
                      删除全部章节
                    </span>
                    <span className="block text-[10px] text-slate-500 mt-0.5">
                      本版所有章删光，重置为 1 章空白（人物/记忆保留）
                    </span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};
