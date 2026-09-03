import React, { useState } from 'react';
import type { WorldSetting, SettingCategory } from '../../types/novel';
import { Globe, Plus, Trash2, ArrowRight, ArrowLeft, RefreshCw, Zap, Check, Tag } from 'lucide-react';

interface WorldReviewStepProps {
  settings: WorldSetting[];
  onNext: (updatedSettings: WorldSetting[]) => void;
  onPrev?: () => void;
  onRegenerate: () => void;
  isGenerating: boolean;
  progressMsg?: string;
}

const CATEGORIES: SettingCategory[] = [
  '力量与境界体系',
  '世界地理势力',
  '功法神兵道具',
  '天道禁忌与法则',
  '核心历史伏笔',
];

export const WorldReviewStep: React.FC<WorldReviewStepProps> = ({
  settings: initialSettings,
  onNext,
  onPrev,
  onRegenerate,
  isGenerating,
  progressMsg,
}) => {
  const [settings, setSettings] = useState<WorldSetting[]>(initialSettings);
  const [activeCategory, setActiveCategory] = useState<SettingCategory>(CATEGORIES[0]);
  const [activeSettingId, setActiveSettingId] = useState<string>(initialSettings[0]?.id || '');
  const [newRuleInput, setNewRuleInput] = useState('');

  const filteredSettings = settings.filter((s) => s.category === activeCategory);
  const activeSetting = settings.find((s) => s.id === activeSettingId) || filteredSettings[0] || settings[0];

  const handleUpdateActive = (updates: Partial<WorldSetting>) => {
    if (!activeSetting) return;
    setSettings(settings.map((s) => (s.id === activeSetting.id ? { ...s, ...updates } : s)));
  };

  const handleAddRule = () => {
    if (!newRuleInput.trim() || !activeSetting) return;
    const nextRules = [...activeSetting.hardRules, newRuleInput.trim()];
    handleUpdateActive({ hardRules: nextRules });
    setNewRuleInput('');
  };

  const handleRemoveRule = (idx: number) => {
    if (!activeSetting) return;
    const nextRules = activeSetting.hardRules.filter((_, i) => i !== idx);
    handleUpdateActive({ hardRules: nextRules });
  };

  const handleAddSetting = () => {
    const newSet: WorldSetting = {
      id: `set-${Date.now()}`,
      category: activeCategory,
      name: `新增${activeCategory.slice(0, 4)}`,
      description: '此处描述该设定的历史由来与具体存在方式...',
      hardRules: [
        '第一条铁律：下位越级挑战必伴随不可逆转的神魂反噬。',
      ],
      tags: ['硬核法则', activeCategory.slice(0, 2)],
      isActive: true,
    };
    setSettings([...settings, newSet]);
    setActiveSettingId(newSet.id);
  };

  const handleDeleteSetting = (id: string) => {
    if (settings.length <= 1) return;
    const next = settings.filter((s) => s.id !== id);
    setSettings(next);
    if (activeSettingId === id) {
      setActiveSettingId(next[0].id);
    }
  };

  return (
    <div className="max-w-6xl mx-auto py-6 animate-fadeIn">
      <div className="bg-white border border-slate-200 rounded-2xl p-6 md:p-8 shadow-xl space-y-6">
        {/* 标题区 + 右上角动作按钮组 */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-6">
          <div className="flex items-center space-x-3">
            <div className="p-3 bg-black rounded-2xl shadow-md text-white shrink-0">
              <Globe className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-900">
                第四步：世界观设定与绝对红线铁律审核
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                每一个设定都绑定了【绝对硬性约束红线 (Hard Rules)】，AI 在后续逐章写作中将由自检机制严格遵守，确保永远不吃书！
              </p>
            </div>
          </div>

          <div className="flex space-x-2 shrink-0">
            <button
              onClick={handleAddSetting}
              disabled={isGenerating}
              className="flex items-center space-x-1.5 px-3 py-2 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded-full text-xs font-medium transition-all"
            >
              <Plus className="w-4 h-4" />
              <span>新建设定</span>
            </button>
            <button
              onClick={onRegenerate}
              disabled={isGenerating}
              className="flex items-center space-x-2 px-4 py-2 bg-white hover:bg-slate-100 text-slate-700 rounded-full border border-slate-300 transition-all text-sm font-medium disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${isGenerating ? 'animate-spin' : ''}`} />
              <span>AI 重新构建设定集</span>
            </button>
          </div>
        </div>

        {isGenerating ? (
          <div className="py-16 text-center space-y-4">
            <div className="w-12 h-12 border-4 border-slate-900 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm font-medium text-slate-700">{progressMsg || 'AI 正在为你构建严密自洽的体系铁律与反吃书红线...'}</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* 分类 chips 行 */}
            <div className="flex flex-wrap items-center gap-2">
              {CATEGORIES.map((cat) => {
                const count = settings.filter((s) => s.category === cat).length;
                const isChosen = activeCategory === cat;
                return (
                  <button
                    key={cat}
                    onClick={() => {
                      setActiveCategory(cat);
                      const first = settings.find((s) => s.category === cat);
                      if (first) setActiveSettingId(first.id);
                    }}
                    className={`flex items-center space-x-2 px-4 py-2 rounded-full font-medium text-sm transition-all ${
                      isChosen
                        ? 'bg-black text-white border border-black shadow-sm'
                        : 'bg-white hover:bg-slate-100 text-slate-700 border border-slate-300'
                    }`}
                  >
                    <span>{cat}</span>
                    <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${isChosen ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* 左栏：设定卡列表 */}
              <div className="lg:col-span-4 space-y-2 max-h-[550px] overflow-y-auto pr-1">
                {filteredSettings.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-500 border border-dashed border-slate-300 rounded-xl bg-slate-50">
                    当前类别下暂无设定，点击右上角新建
                  </div>
                ) : (
                  filteredSettings.map((s) => (
                    <div
                      key={s.id}
                      onClick={() => setActiveSettingId(s.id)}
                      className={`p-4 rounded-xl border cursor-pointer transition-all flex items-start justify-between ${
                        activeSetting?.id === s.id
                          ? 'bg-slate-50 border-slate-900 ring-1 ring-slate-900 shadow-md'
                          : 'bg-white border-slate-200 hover:border-slate-400 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex-1 min-w-0 pr-2">
                        <div className="flex items-center space-x-2">
                          <span className="font-bold text-slate-900 text-base truncate">{s.name}</span>
                          <span className="text-[11px] px-2 py-0.5 rounded-full font-semibold shrink-0 bg-amber-50 text-amber-700 border border-amber-200">
                            {s.hardRules.length} 条红线
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-1.5 line-clamp-2 leading-relaxed">
                          {s.description}
                        </p>
                      </div>

                      {settings.length > 1 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteSetting(s.id);
                          }}
                          className="text-slate-400 hover:text-rose-600 p-1 rounded transition-colors shrink-0"
                          title="删除设定"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>

              {/* 右栏：选定设定编辑表单 */}
              {activeSetting ? (
                <div className="lg:col-span-8 bg-slate-50 border border-slate-200 rounded-xl p-6 space-y-5 shadow-inner">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 tracking-wide mb-1">
                        设定名称 (Name)
                      </label>
                      <input
                        type="text"
                        value={activeSetting.name}
                        onChange={(e) => handleUpdateActive({ name: e.target.value })}
                        className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm font-bold text-slate-900 focus:border-slate-900 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-700 tracking-wide mb-1 flex items-center space-x-1">
                        <Tag className="w-3.5 h-3.5" />
                        <span>归属类别</span>
                      </label>
                      <select
                        value={activeSetting.category}
                        onChange={(e) => handleUpdateActive({ category: e.target.value as SettingCategory })}
                        className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                      >
                        {CATEGORIES.map((cat) => (
                          <option key={cat} value={cat}>{cat}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 tracking-wide mb-1">
                      详细设定内容阐述
                    </label>
                    <textarea
                      value={activeSetting.description}
                      onChange={(e) => handleUpdateActive({ description: e.target.value })}
                      rows={3}
                      className="w-full bg-white border border-slate-300 rounded-lg p-3 text-sm text-slate-900 focus:border-slate-900 focus:outline-none leading-relaxed"
                    />
                  </div>

                  {/* 核心红线规则（Hard Rules）— 黄色勾选框区 */}
                  <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-xs font-bold text-amber-800 tracking-wide flex items-center space-x-1.5">
                        <Zap className="w-4 h-4 text-amber-600" strokeWidth={2.5} />
                        <span>绝对硬性世界规则（Hard Rules — RAG 检索系红线）</span>
                      </label>
                      <span className="text-[11px] text-amber-700 font-medium text-right shrink-0">
                        写作引擎一旦越界将触发自动修复
                      </span>
                    </div>

                    <div className="space-y-2">
                      {activeSetting.hardRules.map((rule, idx) => (
                        <div
                          key={idx}
                          className="flex items-start justify-between bg-white border border-amber-200 rounded-lg p-3 text-xs text-amber-900 space-x-3"
                        >
                          <div className="flex items-start space-x-2.5 flex-1">
                            {/* 勾选框（勾选态为纯视觉：红线一经写入即由自检机制强制执行） */}
                            <span
                              aria-hidden
                              className="w-4 h-4 mt-0.5 rounded border border-amber-500 bg-amber-500 flex items-center justify-center shrink-0"
                            >
                              <Check className="w-3 h-3 text-white" strokeWidth={3} />
                            </span>
                            <span className="leading-relaxed font-medium">{rule}</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleRemoveRule(idx)}
                            className="text-amber-500 hover:text-amber-800 font-bold px-1"
                            title="移除此条红线"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>

                    <div className="flex space-x-2">
                      <input
                        type="text"
                        value={newRuleInput}
                        onChange={(e) => setNewRuleInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddRule())}
                        placeholder="输入新的一条绝对红线（如：极度依赖环境灵气，失去后一日内丧失战力）..."
                        className="flex-1 bg-white border border-amber-300 rounded-full px-3.5 py-2 text-xs text-slate-900 focus:border-amber-600 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={handleAddRule}
                        className="px-4 py-2 bg-black hover:bg-neutral-800 text-white rounded-full text-xs font-medium transition-colors shrink-0"
                      >
                        添加红线
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="lg:col-span-8 flex items-center justify-center bg-slate-50 border border-slate-200 rounded-xl p-12 text-slate-500">
                  请在左侧选择具体设定进行查看与优化
                </div>
              )}
            </div>
          </div>
        )}

        {/* 底部动作条：上一步 / 主 CTA */}
        <div className="flex items-center justify-between pt-6 border-t border-slate-200">
          {onPrev ? (
            <button
              type="button"
              onClick={onPrev}
              className="px-6 py-3.5 bg-white hover:bg-slate-100 text-slate-700 font-medium rounded-full border border-slate-300 flex items-center space-x-2 transition-all text-sm"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>上一步 (调整角色设定)</span>
            </button>
          ) : <div />}
          <button
            type="button"
            onClick={() => onNext(settings)}
            disabled={isGenerating}
            className="px-8 py-3.5 bg-black hover:bg-neutral-800 text-white font-bold rounded-full shadow-lg flex items-center space-x-2 transition-all transform hover:-translate-y-0.5 text-sm"
          >
            <span>确认无误，推导全书分卷与拆章大纲</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
