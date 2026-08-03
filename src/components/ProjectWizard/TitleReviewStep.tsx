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
      <div className="bg-white border border-slate-200 rounded-2xl p-8 shadow-xl space-y-8">
        <div className="flex items-center justify-between border-b border-slate-200 pb-5">
          <div className="flex items-center space-x-3">
            <div className="p-3 bg-indigo-600 rounded-xl shadow-md text-white">
              <CheckCircle className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-slate-900">
                第二步：书名与核心架构审核（可修改）
              </h2>
              <p className="text-sm text-slate-600 mt-1">
                AI 已经为你打磨好了故事的门面与卖点。你可以直接在方框内敲字优化，或重新推导。
              </p>
            </div>
          </div>

          <button
            onClick={onRegenerate}
            disabled={isGenerating}
            className="flex items-center space-x-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-indigo-600 rounded-xl border border-slate-300 transition-all text-sm font-medium disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isGenerating ? 'animate-spin' : ''}`} />
            <span>AI 换一版构思</span>
          </button>
        </div>

        {isGenerating ? (
          <div className="py-16 text-center space-y-4">
            <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm font-medium text-indigo-600">{progressMsg || 'AI 正在为你重构全新书名与梗概设计...'}</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* 书名与题材卡片 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="md:col-span-2">
                <label className="block text-xs font-semibold text-indigo-700 uppercase tracking-wider mb-2 flex items-center space-x-1.5">
                  <BookOpen className="w-4 h-4" />
                  <span>正式书名 (Title)</span>
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-3 text-xl font-bold text-slate-900 focus:border-indigo-600 focus:outline-none shadow-inner focus:bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-blue-600 uppercase tracking-wider mb-2 flex items-center space-x-1.5">
                  <Tag className="w-4 h-4" />
                  <span>精准题材分类</span>
                </label>
                <input
                  type="text"
                  value={genre}
                  onChange={(e) => setGenre(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-3 text-base font-semibold text-slate-900 focus:border-blue-600 focus:outline-none shadow-inner focus:bg-white"
                />
              </div>
            </div>

            {/* 副标题 / 标语 */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2">
                副标题 / 一句话标语 (Subtitle)
              </label>
              <input
                type="text"
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-2.5 text-sm text-slate-900 focus:border-indigo-600 focus:outline-none focus:bg-white"
              />
            </div>

            {/* 核心剧情梗概 */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2 flex items-center space-x-1.5">
                <Sparkles className="w-4 h-4 text-indigo-600" />
                <span>核心剧情与世界背景梗概 (Synopsis)</span>
              </label>
              <textarea
                value={synopsis}
                onChange={(e) => setSynopsis(e.target.value)}
                rows={5}
                className="w-full bg-slate-50 border border-slate-300 rounded-xl p-4 text-sm text-slate-900 leading-relaxed focus:border-indigo-600 focus:outline-none focus:bg-white"
              />
            </div>

            {/* 终极冲突 */}
            <div>
              <label className="block text-xs font-semibold text-amber-700 uppercase tracking-wider mb-2 flex items-center space-x-1.5">
                <AlertTriangle className="w-4 h-4" />
                <span>全书终极矛盾与冲突红线 (Core Conflict)</span>
              </label>
              <textarea
                value={coreConflict}
                onChange={(e) => setCoreConflict(e.target.value)}
                rows={2}
                className="w-full bg-amber-50 border border-amber-300 rounded-xl p-3 text-sm text-amber-900 focus:border-amber-600 focus:outline-none"
              />
            </div>

            {/* 核心吸睛卖点 / Hooks */}
            <div>
              <label className="block text-xs font-semibold text-emerald-700 uppercase tracking-wider mb-2 flex items-center space-x-1.5">
                <Flame className="w-4 h-4" />
                <span>核心吸睛卖点 / 反套路爽点 Hooks</span>
              </label>
              <div className="flex flex-wrap gap-2 mb-3">
                {hooks.map((hook, idx) => (
                  <div
                    key={idx}
                    className="bg-emerald-50 border border-emerald-300 rounded-lg px-3 py-1.5 text-xs text-emerald-800 flex items-center space-x-2 font-medium"
                  >
                    <span>{hook}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveHook(idx)}
                      className="text-emerald-600 hover:text-emerald-900 font-bold"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex space-x-2">
                <input
                  type="text"
                  value={newHook}
                  onChange={(e) => setNewHook(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddHook())}
                  placeholder="输入额外亮点并回车添加"
                  className="flex-1 bg-slate-50 border border-slate-300 rounded-lg px-3 py-1.5 text-xs text-slate-900 focus:border-emerald-600 focus:outline-none focus:bg-white"
                />
                <button
                  type="button"
                  onClick={handleAddHook}
                  className="px-4 py-1.5 bg-black hover:bg-neutral-800 text-white rounded-lg text-xs font-medium"
                >
                  添加卖点
                </button>
              </div>
            </div>

            {/* 确认并下一步或上一步 */}
            <div className="flex items-center justify-between pt-6 border-t border-slate-200">
              {onPrev ? (
                <button
                  type="button"
                  onClick={onPrev}
                  className="px-6 py-3.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium rounded-xl border border-slate-300 flex items-center space-x-2 transition-all text-sm"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>上一步 (调整灵感参数)</span>
                </button>
              ) : <div />}
              <button
                type="button"
                onClick={handleConfirm}
                className="px-8 py-3.5 bg-black hover:bg-neutral-800 text-white font-bold rounded-xl shadow-lg flex items-center space-x-2 transition-all transform hover:-translate-y-0.5 text-sm"
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
