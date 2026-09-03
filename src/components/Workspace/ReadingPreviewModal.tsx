import { contentWordsOrFallback } from '../../services/proseWords';
import { chapterDisplayTitle } from '../../services/chapterTitle';
import React, { useMemo, useState } from 'react';
import type { BookProject, Chapter } from '../../types/novel';
import { X, BookOpen, ChevronLeft, ChevronRight } from 'lucide-react';

interface ReadingPreviewModalProps {
  open: boolean;
  project: BookProject;
  initialChapterId?: string;
  onClose: () => void;
}

export const ReadingPreviewModal: React.FC<ReadingPreviewModalProps> = ({
  open,
  project,
  initialChapterId,
  onClose,
}) => {
  const chapters = useMemo(
    () => [...(project.chapters || [])].sort((a, b) => a.number - b.number),
    [project.chapters]
  );

  const initialIndex = Math.max(
    0,
    chapters.findIndex((c) => c.id === initialChapterId)
  );
  const [index, setIndex] = useState(initialIndex >= 0 ? initialIndex : 0);

  // 打开时同步到 initial
  React.useEffect(() => {
    if (!open) return;
    const i = chapters.findIndex((c) => c.id === initialChapterId);
    setIndex(i >= 0 ? i : 0);
  }, [open, initialChapterId, chapters]);

  // 关闭交互：Escape 键（与书库弹层一致）
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const chapter: Chapter | undefined = chapters[index];
  const words = contentWordsOrFallback(chapter?.content, chapter?.wordCount) || 0;

  return (
    <div
      data-modal-backdrop="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 backdrop-blur-sm p-3 sm:p-6 app-region-no-drag select-auto modal-backdrop-layer"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-stone-50 border border-stone-200 rounded-2xl w-full max-w-3xl max-h-[92vh] shadow-2xl flex flex-col overflow-hidden app-region-no-drag">
        <div className="px-5 py-3 border-b border-stone-200 bg-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <BookOpen className="w-4 h-4 text-indigo-600 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-slate-900 truncate">
                阅读预览 · {project.title}
              </h2>
              <p className="text-[10px] text-slate-500">
                纯阅读模式，不编辑。共 {chapters.length} 章
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {chapter ? (
          <>
            <div className="px-5 py-3 border-b border-stone-100 bg-white/80 flex items-center justify-between gap-2 shrink-0">
              <button
                type="button"
                disabled={index <= 0}
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
              >
                <ChevronLeft size={14} />
                上一章
              </button>
              <div className="text-center min-w-0">
                <div className="text-sm font-serif font-bold text-slate-900 truncate">
                  {(() => {
                    const display = chapterDisplayTitle(chapter.title);
                    return display ? `第 ${chapter.number} 章 ${display}` : `第 ${chapter.number} 章`;
                  })()}
                </div>
                <div className="text-[10px] text-slate-500 font-mono">
                  {chapter.status} · {words.toLocaleString()} 字 · {index + 1}/{chapters.length}
                </div>
              </div>
              <button
                type="button"
                disabled={index >= chapters.length - 1}
                onClick={() => setIndex((i) => Math.min(chapters.length - 1, i + 1))}
                className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
              >
                下一章
                <ChevronRight size={14} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 sm:px-10 py-8">
              {chapter.summary?.trim() && (
                <p className="text-xs text-stone-500 mb-6 leading-relaxed border-l-2 border-indigo-200 pl-3">
                  {chapter.summary}
                </p>
              )}
              <article
                className="font-serif text-[17px] sm:text-lg text-stone-900 leading-[1.9] whitespace-pre-wrap"
                style={{ fontFamily: '"Noto Serif SC", "Songti SC", Georgia, serif' }}
              >
                {(chapter.content || '').trim() || '（本章暂无正文）'}
              </article>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-slate-500 p-12">
            暂无章节可阅读
          </div>
        )}
      </div>
    </div>
  );
};
