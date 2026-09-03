import React, { useMemo, useState } from 'react';
import type { Chapter, Volume } from '../../types/novel';
import {
  Plus,
  Search,
  Layers,
  ChevronDown,
  ChevronRight,
  Trash2,
  Eraser,
  RotateCcw,
} from 'lucide-react';
import { isChapterLocked } from '../../services/chapterLock';
import { chapterDisplayTitle } from '../../services/chapterTitle';

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
  // 增量渲染（性能）：长书 500+ 章全量 .map 会卡——首屏 200 条，「显示更多」步进
  const [renderCap, setRenderCap] = useState(200);
  const bumpRenderCap = () => setRenderCap((c) => c + 200);
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
  // 增量渲染窗口：搜索时全量显示（结果通常不多），浏览时长列表截断
  const visibleChapters = searchTerm
    ? filteredChapters
    : filteredChapters.slice(0, renderCap);

  const statusLabel = (chapter: Chapter) => {
    if (isChapterLocked(chapter)) return '已锁定';
    switch (chapter.status) {
      case '校验通过':
      case '精修定稿':
      case '校验精修定稿':
        return '定稿';
      case '待人工确认':
      case '机检未通过':
        return '待人工';
      case '草稿生成中':
      case '正文草稿':
        return '草稿';
      default:
        return chapter.status || '构思中';
    }
  };

  const renderChapterItem = (chapter: Chapter) => {
    const isActive = chapter.id === activeChapterId;
    const todos = openTodoCount(chapter);
    const locked = isChapterLocked(chapter);
    // 设计稿状态圆点：琥珀=草稿/待人工 · 绿=定稿/绿通 · 灰=待拆/占位 · 墨=锁定
    const dotColor = locked
      ? 'var(--app-text-primary)'
      : chapter.status === '校验通过' || chapter.status === '精修定稿' || chapter.status === '校验精修定稿'
        ? '#10b981'
        : chapter.status === '正文草稿' || chapter.status === '待人工确认' || chapter.status === '机检未通过'
          ? '#f59e0b'
          : 'var(--app-text-muted)';
    const displayTitle = chapterDisplayTitle(chapter.title);
    const chapterName = displayTitle
      ? `第${chapter.number}章 ${displayTitle}`
      : `第${chapter.number}章`;
    const tip = [
      `${chapterName} · ${statusLabel(chapter)}`,
      chapter.summary || '暂无剧情梗概',
      `字数 ${chapter.wordCount} · ${chapter.lastModified || '近期'}`,
      ...(todos > 0 ? [`${todos} 项待修`] : []),
    ].join('\n');
    return (
      <div
        key={chapter.id}
        onClick={() => onSelectChapter(chapter.id)}
        title={tip}
        className={`group flex items-center justify-between gap-1.5 px-2 py-[6px] cursor-pointer transition-all rounded-[7px] border ${
          isActive
            ? 'bg-[#fafafa] border-[#e5e5e5]'
            : 'hover:bg-slate-100 border-transparent text-slate-700'
        }`}
      >
        {/* 设计稿 .ch：单行章名 + 行尾状态圆点 */}
        <span
          className={`text-[11.5px] truncate min-w-0 ${
            isActive ? 'text-slate-900 font-semibold' : 'text-slate-700'
          }`}
        >
          {chapterName}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          {todos > 0 && (
            <span
              className="inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-bold bg-[#be123c] text-white"
              title={`${todos} 项待修`}
            >
              {todos}
            </span>
          )}
          {onDeleteChapter && (
            <button
              type="button"
              disabled={deleteDisabled}
              onClick={(e) => {
                e.stopPropagation();
                if (deleteDisabled) return;
                onDeleteChapter(chapter.id);
              }}
              className={`p-0.5 rounded transition-colors ${
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
              <Trash2 size={11} />
            </button>
          )}
          <span
            aria-hidden
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: dotColor }}
          />
        </span>
      </div>
    );
  };

  // 未分卷章节兜底：历史/导入数据可能没有 volumeId/volumeNumber，
  // 分卷树存在时若不兜底，这些章节会在侧栏完全不可见（功能测试发现的缺陷）。
  const unassignedChapters =
    volumes.length > 0
      ? filteredChapters.filter(
          (c) =>
            !volumes.some(
              (v) => c.volumeId === v.id || c.volumeNumber === v.number
            )
        )
      : [];

  return (
    <aside className="w-60 bg-white border-r border-neutral-200 flex flex-col h-full shrink-0 select-none text-black rounded-bl-[28px] overflow-hidden">
      {/* 侧栏标题与全局新建按钮 */}
      <div className="px-3 py-2.5 border-b border-slate-200 flex items-center justify-between bg-white gap-2">
        <div className="flex items-center space-x-1.5 min-w-0">
          <Layers size={14} className="text-neutral-700 shrink-0" />
          <h2 className="font-bold text-xs text-slate-900 tracking-wide truncate">
            全书分卷 & 章节目录
          </h2>
          {totalOpenTodos > 0 && (
            <span
              className="shrink-0 inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-bold bg-[#be123c] text-white"
              title={`全书 ${totalOpenTodos} 项待修`}
            >
              {totalOpenTodos}
            </span>
          )}
        </div>
        <button
          onClick={() => onAddChapter()}
          className="flex items-center space-x-0.5 bg-black hover:bg-neutral-800 text-white px-2 py-1 rounded-lg text-[11px] font-medium transition-all shadow-sm shrink-0"
          title="创建新章节"
        >
          <Plus size={12} />
          <span>新章</span>
        </button>
      </div>

      {/* 搜索过滤框 */}
      <div className="px-2 py-2 border-b border-slate-200 bg-white">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-[7px] text-slate-400" />
          <input
            type="text"
            placeholder="搜索章节或剧情梗概..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-8 pr-2.5 py-1 text-[11px] bg-white border border-slate-200 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:border-neutral-900 transition-all"
          />
        </div>
      </div>

      {/* 章节与分卷树状手风琴列表 */}
      <div className="flex-1 overflow-y-auto py-2">
        {volumes && volumes.length > 0 && !searchTerm ? (
          <>
          {volumes.map((vol) => {
            const volChaps = filteredChapters.filter(
              (c) => c.volumeId === vol.id || c.volumeNumber === vol.number
            );
            const isExpanded = expandedVolIds.includes(vol.id);

            return (
              <div key={vol.id} className="bg-white">
                <div
                  onClick={() => toggleVol(vol.id)}
                  className="px-2.5 py-1.5 hover:bg-slate-100 cursor-pointer flex items-center justify-between transition-colors"
                >
                  <div className="flex items-center space-x-1 min-w-0 flex-1">
                    {isExpanded ? <ChevronDown size={12} className="text-slate-400 shrink-0" /> : <ChevronRight size={12} className="text-slate-400 shrink-0" />}
                    <span className="font-bold text-[10.5px] text-slate-500 tracking-[0.05em] truncate">{vol.title}</span>
                  </div>
                  <div className="flex items-center space-x-1 ml-2 shrink-0">
                    <span className="text-[9.5px] text-slate-400 font-mono font-bold">
                      {volChaps.length} 章
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onAddChapter(vol.id, vol.number);
                      }}
                      className="p-0.5 text-slate-400 hover:text-neutral-900 hover:bg-slate-200 rounded transition-colors"
                      title={`在 ${vol.title} 追加新章`}
                    >
                      <Plus size={11} />
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="px-2 pb-2 space-y-[3px] bg-white">
                    {volChaps.slice(0, renderCap).map(renderChapterItem)}
                    {volChaps.length > renderCap && (
                      <button
                        type="button"
                        onClick={bumpRenderCap}
                        className="w-full py-1.5 text-center text-[10.5px] font-bold text-slate-600 hover:bg-slate-100 rounded-[7px]"
                      >
                        显示更多（本卷还有 {volChaps.length - renderCap} 章）
                      </button>
                    )}
                    {volChaps.length === 0 && (
                      <div className="px-2 py-2 text-center text-[10.5px] text-slate-400">本卷暂无章节</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {/* 未分卷章节兜底分组：无 volumeId/volumeNumber 的章节在分卷树中也可见 */}
          {unassignedChapters.length > 0 && (
            <div className="bg-white">
              <div
                onClick={() => toggleVol('default-vol')}
                className="px-2.5 py-1.5 hover:bg-slate-100 cursor-pointer flex items-center justify-between transition-colors"
              >
                <div className="flex items-center space-x-1 min-w-0 flex-1">
                  {expandedVolIds.includes('default-vol') ? (
                    <ChevronDown size={12} className="text-slate-400 shrink-0" />
                  ) : (
                    <ChevronRight size={12} className="text-slate-400 shrink-0" />
                  )}
                  <span className="font-bold text-[10.5px] text-slate-500 tracking-[0.05em] truncate">未分卷</span>
                </div>
                <span className="text-[9.5px] text-slate-400 font-mono font-bold">
                  {unassignedChapters.length} 章
                </span>
              </div>
              {expandedVolIds.includes('default-vol') && (
                <div className="px-2 pb-2 space-y-[3px] bg-white">
                  {unassignedChapters.slice(0, renderCap).map(renderChapterItem)}
                  {unassignedChapters.length > renderCap && (
                    <button
                      type="button"
                      onClick={bumpRenderCap}
                      className="w-full py-1.5 text-center text-[10.5px] font-bold text-slate-600 hover:bg-slate-100 rounded-[7px]"
                    >
                      显示更多（未分卷还有 {unassignedChapters.length - renderCap} 章）
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          </>
        ) : (
          <div className="px-2 space-y-[3px]">
            {visibleChapters.map(renderChapterItem)}
            {!searchTerm && filteredChapters.length > renderCap && (
              <button
                type="button"
                onClick={bumpRenderCap}
                className="w-full py-1.5 text-center text-[10.5px] font-bold text-slate-600 hover:bg-slate-100 rounded-[7px]"
              >
                显示更多（{filteredChapters.length - renderCap} 章未展示）
              </button>
            )}
            {filteredChapters.length === 0 && (
              <div className="py-8 text-center text-[11px] text-slate-400">未找到匹配的章节</div>
            )}
          </div>
        )}
      </div>

      {/* 底部：卷/全书 chip（设计稿 side-foot，仅此一行）+ 清空本版章节 */}
      <div className="p-3 border-t border-slate-200 bg-white space-y-2 rounded-bl-[28px]">
        <div className="flex gap-1.5">
          <span className="text-[9.5px] text-slate-500 border border-slate-200 rounded-full px-2 py-0.5 bg-white">卷 {volumes?.length ?? 0}</span>
          <span className="text-[9.5px] text-slate-500 border border-slate-200 rounded-full px-2 py-0.5 bg-white">全书 {chapters.length} 章</span>
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
