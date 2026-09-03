import React, { useState } from 'react';
import { Sparkles, BookOpen, Flame, ArrowRight, ArrowLeft, RefreshCw, CheckCircle, Tag, AlertTriangle } from 'lucide-react';

interface TitleData {
  title: string;
  subtitle: string;
  genre: string;
  synopsis: string;
  hooks: string[];
  coreConflict: string;
}

interface TitleReviewStepProps {
  data: TitleData;
  onNext: (updatedData: TitleData) => void;
  onPrev?: () => void;
  onRegenerate: () => void;
  isGenerating: boolean;
  progressMsg?: string;
}

export const TitleReviewStep: React.FC<TitleReviewStepProps> = ({
  data,
  onNext,
  onPrev,
  onRegenerate,
  isGenerating,
  progressMsg,
}) => {
  const [title, setTitle] = useState(data.title);
  const [subtitle, setSubtitle] = useState(data.subtitle);
  const [genre, setGenre] = useState(data.genre);
  const [synopsis, setSynopsis] = useState(data.synopsis);
  const [coreConflict, setCoreConflict] = useState(data.coreConflict);
  const [hooks, setHooks] = useState<string[]>(data.hooks || []);
  const [newHook, setNewHook] = useState('');

  const handleAddHook = () => {
    if (newHook.trim()) {
      setHooks([...hooks, newHook.trim()]);
      setNewHook('');
    }
  };

  const handleRemoveHook = (idx: number) => {
    setHooks(hooks.filter((_, i) => i !== idx));
  };

  const handleConfirm = () => {
    onNext({
      title,
      subtitle,
      genre,
      synopsis,
      coreConflict,
      hooks,
    });
  };

  return (
    <div className="max-w-5xl mx-auto py-6 animate-fadeIn">
      <div className="bg-white border border-slate-200 rounded-2xl p-6 md:p-8 shadow-xl space-y-7">
        {/* 标题区 + 右上角动作按钮 */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-6">
          <div className="flex items-center space-x-3">
            <div className="p-3 bg-black rounded-2xl shadow-md text-white shrink-0">
              <CheckCircle className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-900">
                第二步：书名与核心架构审核（可修改）
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                AI 已经为你打磨好了故事的门面与卖点。你可以直接在方框内敲字优化，或重新推导。
              </p>
            </div>
          </div>

          <button
            onClick={onRegenerate}
            disabled={isGenerating}
            className="flex items-center space-x-2 px-4 py-2 bg-white hover:bg-slate-100 text-slate-700 rounded-full border border-slate-300 transition-all text-sm font-medium disabled:opacity-50 shrink-0"
          >
            <RefreshCw className={`w-4 h-4 ${isGenerating ? 'animate-spin' : ''}`} />
            <span>AI 换一版构思</span>
          </button>
        </div>

        {isGenerating ? (
          <div className="py-16 text-center space-y-4">
            <div className="w-12 h-12 border-4 border-slate-900 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm font-medium text-slate-700">{progressMsg || 'AI 正在为你重构全新书名与梗概设计...'}</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* 正式书名 / 题材分类：两列 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-xs font-semibold text-slate-700 tracking-wide mb-2 flex items-center space-x-1.5">
                  <BookOpen className="w-4 h-4 text-slate-700" />
                  <span>正式书名 (Title)</span>
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-3 text-xl font-bold text-slate-900 focus:border-slate-900 focus:outline-none shadow-inner focus:bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 tracking-wide mb-2 flex items-center space-x-1.5">
                  <Tag className="w-4 h-4 text-slate-700" />
                  <span>精准题材分类</span>
                </label>
                <input
                  type="text"
                  value={genre}
                  onChange={(e) => setGenre(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-3 text-base font-semibold text-slate-900 focus:border-slate-900 focus:outline-none shadow-inner focus:bg-white"
                />
              </div>
            </div>

            {/* 副标题 / 标语 */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 tracking-wide mb-2">
                副标题 / 一句话标语 (Subtitle)
              </label>
              <input
                type="text"
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-2.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none focus:bg-white"
              />
            </div>

            {/* 核心剧情梗概 */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 tracking-wide mb-2 flex items-center space-x-1.5">
                <Sparkles className="w-4 h-4 text-slate-700" />
                <span>核心剧情与世界背景梗概 (Synopsis)</span>
              </label>
              <textarea
                value={synopsis}
                onChange={(e) => setSynopsis(e.target.value)}
                rows={7}
                className="w-full bg-slate-50 border border-slate-300 rounded-xl p-4 text-sm text-slate-900 leading-relaxed focus:border-slate-900 focus:outline-none focus:bg-white"
              />
            </div>

            {/* 全书核心矛盾与冲突红线（黄色强调框） */}
            <div className="border border-amber-300 bg-amber-50 rounded-xl p-4 space-y-2.5">
              <label className="block text-xs font-bold text-amber-800 tracking-wide flex items-center space-x-1.5">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                <span>全书终极矛盾与冲突红线 (Core Conflict)</span>
              </label>
              <textarea
                value={coreConflict}
                onChange={(e) => setCoreConflict(e.target.value)}
                rows={2}
                className="w-full bg-white/80 border border-amber-300 rounded-lg p-3 text-sm text-amber-900 focus:border-amber-600 focus:outline-none"
              />
            </div>

            {/* 核心吸睛卖点 / Hooks：chips + 输入框横排 wrap */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 tracking-wide mb-2 flex items-center space-x-1.5">
                <Flame className="w-4 h-4 text-amber-600" />
                <span>核心吸睛卖点 / 反套路爽点 Hooks</span>
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {hooks.map((hook, idx) => (
                  <div
                    key={idx}
                    className="bg-amber-50 border border-amber-300 rounded-full px-3 py-1.5 text-xs text-amber-900 flex items-center space-x-2 font-medium"
                  >
                    <span>{hook}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveHook(idx)}
                      className="text-amber-500 hover:text-amber-800 font-bold"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <input
                  type="text"
                  value={newHook}
                  onChange={(e) => setNewHook(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddHook())}
                  placeholder="输入额外亮点并回车添加"
                  className="flex-1 min-w-[180px] bg-slate-50 border border-slate-300 rounded-full px-3.5 py-1.5 text-xs text-slate-900 focus:border-slate-900 focus:outline-none focus:bg-white"
                />
                <button
                  type="button"
                  onClick={handleAddHook}
                  className="px-4 py-1.5 bg-black hover:bg-neutral-800 text-white rounded-full text-xs font-medium shrink-0"
                >
                  添加卖点
                </button>
              </div>
            </div>

            {/* 底部动作条：上一步 / 主 CTA */}
            <div className="flex items-center justify-between pt-6 border-t border-slate-200">
              {onPrev ? (
                <button
                  type="button"
                  onClick={onPrev}
                  className="px-6 py-3.5 bg-white hover:bg-slate-100 text-slate-700 font-medium rounded-full border border-slate-300 flex items-center space-x-2 transition-all text-sm"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>上一步 (调整灵感参数)</span>
                </button>
              ) : <div />}
              <button
                type="button"
                onClick={handleConfirm}
                className="px-8 py-3.5 bg-black hover:bg-neutral-800 text-white font-bold rounded-full shadow-lg flex items-center space-x-2 transition-all transform hover:-translate-y-0.5 text-sm"
              >
                <span>确认无误，开始推导核心出场角色</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
