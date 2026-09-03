import React, { useEffect, useState } from 'react';
import type { Volume, Chapter, ProjectConfig } from '../../types/novel';
import { Layers, ChevronDown, ChevronRight, Plus, RefreshCw, CheckCircle, BookOpen, FileText, ArrowLeft, Target, Sparkles } from 'lucide-react';
import { isPlaceholderChapter } from '../../services/outlineGenerate';
import { resolveChapterWordTarget } from '../../services/proseWords';

interface OutlineReviewStepProps {
  volumes: Volume[];
  chapters: Chapter[];
  projectConfig?: ProjectConfig | null;
  onNext: (volumes: Volume[], chapters: Chapter[]) => void;
  onPrev?: () => void;
  onRegenerate: () => void;
  onFillPlaceholders: () => void;
  isGenerating: boolean;
  progressMsg?: string;
}

/** 章节行状态 tag 配色（纯展示）：定稿=绿 / 占位=红 / 其余=灰 */
const statusTagClass = (chap: Chapter): string => {
  if (chap.status === '校验通过' || chap.status === '校验精修定稿') {
    return 'bg-emerald-50 text-emerald-700 border border-emerald-300';
  }
  if (isPlaceholderChapter(chap)) {
    return 'bg-red-50 text-red-700 border border-red-300';
  }
  return 'bg-slate-100 text-slate-600 border border-slate-200';
};

export const OutlineReviewStep: React.FC<OutlineReviewStepProps> = ({
  volumes: initialVolumes,
  chapters: initialChapters,
  projectConfig,
  onNext,
  onPrev,
  onRegenerate,
  onFillPlaceholders,
  isGenerating,
  progressMsg,
}) => {
  const [volumes, setVolumes] = useState<Volume[]>(initialVolumes);
  const [chapters, setChapters] = useState<Chapter[]>(initialChapters);
  const [expandedVolId, setExpandedVolId] = useState<string>(initialVolumes[0]?.id || '');
  const [selectedChapId, setSelectedChapId] = useState<string>(initialChapters[0]?.id || '');

  // 父级 AI 重拆后同步 props（避免仍显示旧章数）
  useEffect(() => {
    setVolumes(initialVolumes);
    setChapters(initialChapters);
    if (initialVolumes[0]?.id) setExpandedVolId(initialVolumes[0].id);
    if (initialChapters[0]?.id) setSelectedChapId(initialChapters[0].id);
  }, [initialVolumes, initialChapters]);

  const activeVol = volumes.find((v) => v.id === expandedVolId) || volumes[0];
  const activeChap = chapters.find((c) => c.id === selectedChapId) || chapters[0];
  const placeholderCount = chapters.filter((c) => isPlaceholderChapter(c)).length;

  const handleAddChapterToVol = (vol: Volume) => {
    const nextNumber = chapters.length + 1;

    const newChap: Chapter = {
      id: `chap-${Date.now()}`,
      number: nextNumber,
      title: `第${nextNumber}章 新增转折章节`,
      summary: '在本章中，主角发现了卷末线索的新变故，为后续高潮拉开序幕...',
      wordCount: 0,
      status: '大纲待拆',
      content: '',
      volumeId: vol.id,
      volumeNumber: vol.number,
      involvedCharacterIds: [],
      involvedSettingIds: [],
      beats: [],
      lastModified: new Date().toISOString(),
    };
    setChapters([...chapters, newChap]);
    setSelectedChapId(newChap.id);
  };

  const handleUpdateActiveChap = (updates: Partial<Chapter>) => {
    if (!activeChap) return;
    setChapters(chapters.map((c) => (c.id === activeChap.id ? { ...c, ...updates } : c)));
  };

  const handleUpdateActiveVol = (updates: Partial<Volume>) => {
    if (!activeVol) return;
    setVolumes(volumes.map((v) => (v.id === activeVol.id ? { ...v, ...updates } : v)));
  };

  return (
    <div className="max-w-6xl mx-auto py-6 animate-fadeIn">
      <div className="bg-white border border-slate-200 rounded-2xl p-8 shadow-xl space-y-6">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-6">
          <div className="flex items-center space-x-3">
            <div className="p-3 bg-black rounded-2xl shadow-md text-white shrink-0">
              <Layers className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-900">
                第五步：全书分卷与章节梗概大纲审核
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                分卷规划决定节奏起伏，拆章梗概奠定每章的核心钩子。你可以自由调整卷名、章节剧情，准备进入创作。
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {placeholderCount > 0 && (
              <button
                onClick={onFillPlaceholders}
                disabled={isGenerating}
                className="flex items-center space-x-2 px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-full transition-all text-sm font-medium disabled:opacity-50"
              >
                <Sparkles className="w-4 h-4" />
                <span>AI 补齐占位章梗概 ({placeholderCount})</span>
              </button>
            )}
            <button
              onClick={onRegenerate}
              disabled={isGenerating}
                className="flex items-center space-x-2 px-4 py-2 bg-white hover:bg-slate-100 text-slate-700 rounded-full border border-slate-300 transition-all text-sm font-medium disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${isGenerating ? 'animate-spin' : ''}`} />
              <span>AI 重新规划大纲分卷</span>
            </button>
          </div>
        </div>

        {projectConfig && !isGenerating && (
          <div className="flex flex-wrap items-center gap-3 text-xs rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-amber-900">
            <span className="flex items-center gap-2 min-w-0">
              <Target size={14} className="text-amber-600 shrink-0" />
              <span>
                目标{' '}
                <strong>
                  {projectConfig.targetChapterCount ?? projectConfig.totalChapters ?? '—'}
                </strong>{' '}
                章 · 每章{' '}
                <strong>
                  {(resolveChapterWordTarget(projectConfig) ?? 0).toLocaleString()}
                </strong>{' '}
                字 · 当前大纲 <strong>{chapters.length}</strong> 章 · 分卷{' '}
                <strong>{volumes.length}</strong>
              </span>
            </span>
            <span className="ml-auto shrink-0 pl-3 text-right">
              {(() => {
                const target =
                  projectConfig.targetChapterCount ?? projectConfig.totalChapters ?? 0;
                const detailed = chapters.length - placeholderCount;
                return (
                  <>
                    {target > 0 && chapters.length !== target && (
                      <span className="text-amber-800 font-semibold">
                        {' '}
                        · 与目标差 {chapters.length - target} 章
                      </span>
                    )}
                    {placeholderCount > 0 && (
                      <span className="text-amber-800 font-semibold">
                        {' '}
                        · 详案 {detailed} / 占位 {placeholderCount}（可点「AI 重新规划」整本重拆或左侧手动改占位章；也可点「AI 补齐占位章梗概」只重写占位章，保留现有拆章结果）
                      </span>
                    )}
                    {target > 0 && chapters.length >= target && placeholderCount === 0 && (
                      <span className="text-emerald-800 font-semibold"> · 已对齐目标且无占位</span>
                    )}
                  </>
                );
              })()}
            </span>
          </div>
        )}

        {isGenerating ? (
          <div className="py-16 text-center space-y-4">
            <div className="w-12 h-12 border-4 border-slate-900 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm font-medium text-slate-700">{progressMsg || 'AI 正在分析几百万字网文排版规律，为你拆解宏伟分卷与具体章节剧情钩子...'}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* 左侧分卷与章节树状手风琴 */}
            <div className="lg:col-span-5 space-y-3 max-h-[600px] overflow-y-auto pr-2">
              {volumes.map((vol) => {
                const volChaps = chapters.filter((c) => c.volumeId === vol.id || c.volumeNumber === vol.number);
                const isExpanded = expandedVolId === vol.id;

                return (
                  <div
                    key={vol.id}
                    className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50 shadow-sm"
                  >
                    {/* 卷首标题栏 */}
                    <div
                      onClick={() => setExpandedVolId(isExpanded ? '' : vol.id)}
                      className="p-3.5 bg-slate-100 hover:bg-slate-200 cursor-pointer flex items-center justify-between transition-colors border-b border-slate-200"
                    >
                      <div className="flex items-center space-x-2 min-w-0 flex-1">
                        {isExpanded ? <ChevronDown className="w-4 h-4 text-amber-600" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
                        <span className="font-bold text-slate-900 text-sm truncate">{vol.title}</span>
                      </div>
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-white text-amber-700 border border-amber-300 font-semibold ml-2">
                        {volChaps.length} 章
                      </span>
                    </div>

                    {/* 展开的本卷章节列表 */}
                    {isExpanded && (
                      <div className="p-2 space-y-1.5 bg-white">
                        {volChaps.map((chap) => (
                          <div
                            key={chap.id}
                            onClick={() => setSelectedChapId(chap.id)}
                            className={`p-2.5 rounded-lg cursor-pointer transition-all flex items-center justify-between text-xs ${
                              selectedChapId === chap.id
                                ? 'bg-amber-50 border border-amber-400 text-amber-900 font-semibold shadow-sm'
                                : 'hover:bg-slate-100 text-slate-700 font-medium'
                            }`}
                          >
                            <span className="truncate pr-2">{chap.title}</span>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${statusTagClass(chap)}`}>
                              {chap.status}
                            </span>
                          </div>
                        ))}

                        <button
                          type="button"
                          onClick={() => handleAddChapterToVol(vol)}
                          className="w-full py-2 border border-dashed border-slate-300 hover:border-amber-400 rounded-lg text-xs text-slate-600 hover:text-amber-700 hover:bg-amber-50/50 flex items-center justify-center space-x-1 transition-colors mt-2 font-medium"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>在本卷末尾追加新章</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 右侧选定章节或卷底大纲详情修改 */}
            <div className="lg:col-span-7 space-y-6">
              {/* 当前卷简要管理 */}
              {activeVol && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 space-y-3 shadow-inner">
                  <div className="flex items-center space-x-2 text-xs font-bold text-amber-700 uppercase tracking-wider">
                    <BookOpen className="w-4 h-4" />
                    <span>分卷概述配置：{activeVol.title}</span>
                  </div>
                  <input
                    type="text"
                    value={activeVol.title}
                    onChange={(e) => handleUpdateActiveVol({ title: e.target.value })}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm font-bold text-slate-900 focus:border-amber-500 focus:outline-none"
                  />
                  <textarea
                    value={activeVol.summary}
                    onChange={(e) => handleUpdateActiveVol({ summary: e.target.value })}
                    rows={2}
                    className="w-full bg-white border border-slate-300 rounded-lg p-2.5 text-xs text-slate-900 focus:border-amber-500 focus:outline-none leading-relaxed"
                  />
                </div>
              )}

              {/* 当前选中章节详细梗概 */}
              {activeChap ? (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 space-y-5 shadow-inner">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                    <div className="flex items-center space-x-2 text-sm font-bold text-slate-900">
                      <FileText className="w-4 h-4" />
                      <span>正在审核章节梗概：{activeChap.title}</span>
                    </div>
                    <span className="text-xs px-2.5 py-1 rounded-full bg-slate-900 text-white border border-slate-900 font-semibold shrink-0">
                      第 {activeChap.number} 章
                    </span>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                      章节正式标题
                    </label>
                    <input
                      type="text"
                      value={activeChap.title}
                        onChange={(e) => handleUpdateActiveChap({ title: e.target.value })}
                        className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-base font-bold text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
                      本章核心剧情梗概与关键钩子 (Summary)
                    </label>
                    <textarea
                      value={activeChap.summary}
                        onChange={(e) => handleUpdateActiveChap({ summary: e.target.value })}
                        rows={5}
                        className="w-full bg-white border border-slate-300 rounded-lg p-3.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none leading-relaxed shadow-inner"
                    />
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center bg-slate-50 border border-slate-200 rounded-xl p-12 text-slate-500">
                  请在左侧点击任一章节进行查看与编辑
                </div>
              )}
            </div>
          </div>
        )}

        {/* 确认大纲并进入创作台或上一步 */}
        <div className="flex items-center justify-between pt-6 border-t border-slate-200">
          {onPrev ? (
            <button
              type="button"
              onClick={onPrev}
              className="px-6 py-3.5 bg-white hover:bg-slate-100 text-slate-700 font-medium rounded-full border border-slate-300 flex items-center space-x-2 transition-all text-sm"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>上一步 (调整世界观铁律)</span>
            </button>
          ) : <div />}
          <button
            type="button"
            onClick={() => onNext(volumes, chapters)}
            disabled={isGenerating}
            className="px-8 py-3.5 bg-black hover:bg-neutral-800 text-white font-bold rounded-full shadow-lg flex items-center space-x-2 transition-all transform hover:-translate-y-0.5 text-sm"
          >
            <CheckCircle className="w-5 h-5" />
            <span>🎯 骨架全部就绪！立即进入一章一章写作工作台</span>
          </button>
        </div>
      </div>
    </div>
  );
};
