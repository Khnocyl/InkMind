import React, { useState } from 'react';
import type { WorldSetting, SettingCategory } from '../../types/novel';
import { Plus, ShieldAlert, Tag, Layers, CheckCircle } from 'lucide-react';

interface SettingManagerProps {
  settings: WorldSetting[];
  onAddSetting: (setting: WorldSetting) => void;
}

export const SettingManager: React.FC<SettingManagerProps> = ({ settings, onAddSetting }) => {
  const [selectedCategory, setSelectedCategory] = useState<string>('全部');
  const [selectedSetId, setSelectedSetId] = useState<string>(settings[0]?.id || '');
  const [isCreating, setIsCreating] = useState(false);

  const categories: SettingCategory[] = [
    '力量与境界体系',
    '世界地理势力',
    '功法神兵道具',
    '天道禁忌与法则',
    '核心历史伏笔',
  ];

  const [formData, setFormData] = useState<Partial<WorldSetting>>({
    name: '',
    category: '力量与境界体系',
    description: '',
    hardRules: [''],
    tags: ['规则红线'],
    isActive: true,
  });

  const filteredSettings =
    selectedCategory === '全部'
      ? settings
      : settings.filter((s) => s.category === selectedCategory);

  const selectedSet = settings.find((s) => s.id === selectedSetId) || settings[0];

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name) return;
    const newSet: WorldSetting = {
      id: `set-${Date.now()}`,
      name: formData.name || '未知规则',
      category: (formData.category as SettingCategory) || '力量与境界体系',
      description: formData.description || '',
      hardRules: (formData.hardRules || []).filter((r) => r.trim() !== ''),
      tags: formData.tags || [],
      isActive: true,
    };
    onAddSetting(newSet);
    setSelectedSetId(newSet.id);
    setIsCreating(false);
  };

  return (
    <div className="flex-1 bg-white flex h-full overflow-hidden">
      <aside className="w-80 border-r border-[#e5e5e5] flex flex-col bg-[#fafafa] rounded-bl-[28px]">
        <div className="p-4 border-b border-[#e5e5e5] flex items-center justify-between">
          <span className="font-bold text-sm text-black">设定与世界观词条 ({settings.length})</span>
          <button
            onClick={() => setIsCreating(true)}
            className="flex items-center space-x-1 bg-black text-white px-2.5 py-1 rounded text-xs font-medium hover:bg-neutral-800 transition-all"
          >
            <Plus size={13} />
            <span>新建规则</span>
          </button>
        </div>

        <div className="p-2 border-b border-[#e5e5e5] flex flex-wrap gap-1 bg-[#f0f0f0]">
          <button
            onClick={() => setSelectedCategory('全部')}
            className={`px-2 py-1 rounded text-[11px] font-medium transition-all ${
              selectedCategory === '全部'
                ? 'bg-black text-white'
                : 'text-[#555555] hover:bg-[#e0e0e0]'
            }`}
          >
            全部 ({settings.length})
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`px-2 py-1 rounded text-[11px] font-medium transition-all ${
                selectedCategory === cat
                  ? 'bg-black text-white'
                  : 'text-[#555555] hover:bg-[#e0e0e0]'
              }`}
            >
              {cat.slice(0, 4)}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-[#f0f0f0]">
          {filteredSettings.map((set) => {
            const isSelected = set.id === selectedSetId && !isCreating;
            return (
              <div
                key={set.id}
                onClick={() => {
                  setSelectedSetId(set.id);
                  setIsCreating(false);
                }}
                className={`p-3.5 cursor-pointer transition-all ${
                  isSelected
                    ? 'bg-white border-l-4 border-black shadow-sm'
                    : 'hover:bg-[#f3f3f3] border-l-4 border-transparent'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-sm text-black">{set.name}</span>
                  <span className="text-[10px] bg-[#f0f0f0] text-black px-1.5 py-0.5 rounded border border-[#cccccc]">
                    {set.category}
                  </span>
                </div>
                <p className="text-xs text-[#666666] line-clamp-2 leading-relaxed">
                  {set.description}
                </p>
                <div className="mt-2 flex items-center space-x-1 text-[11px] text-black font-semibold">
                  <ShieldAlert size={12} />
                  <span>{set.hardRules.length} 条绝对红线规则</span>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-8 bg-white">
        {isCreating ? (
          <div className="max-w-3xl mx-auto">
            <h3 className="font-bold text-lg text-black mb-4 pb-2 border-b border-[#e5e5e5]">
              录入世界观与硬性红线规则（供 AI 自检引擎排查吃书冲突）
            </h3>
            <form onSubmit={handleCreateSubmit} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block font-bold text-black mb-1">设定名称 *</label>
                  <input
                    type="text"
                    required
                    placeholder="如：九重天劫与御空法则"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full p-2 border border-[#cccccc] rounded text-black bg-white focus:outline-none focus:border-black"
                  />
                </div>
                <div>
                  <label className="block font-bold text-black mb-1">类别分类</label>
                  <select
                    value={formData.category}
                    onChange={(e) => setFormData({ ...formData, category: e.target.value as SettingCategory })}
                    className="w-full p-2 border border-[#cccccc] rounded text-black bg-white focus:outline-none focus:border-black"
                  >
                    {categories.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-bold text-black mb-1">基础背景简述</label>
                <textarea
                  rows={3}
                  placeholder="该体系或地理环境的基本由来、特征与作用..."
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full p-2 border border-[#cccccc] rounded text-black bg-white focus:outline-none focus:border-black resize-none"
                />
              </div>

              <div>
                <label className="block font-bold text-black mb-1 flex items-center space-x-1">
                  <ShieldAlert size={14} className="text-black" />
                  <span>硬性红线规则（校验 Agent 严格比对这些条款以拦截幻觉）</span>
                </label>
                <textarea
                  rows={4}
                  placeholder="一行一条绝对无法违背的红线（例如：筑基期绝对无法单凭肉身御空飞行；进入幽冥废墟深处气血必定衰减三成……）"
                  onChange={(e) =>
                    setFormData({ ...formData, hardRules: e.target.value.split('\n') })
                  }
                  className="w-full p-2 border border-[#cccccc] rounded text-black bg-white focus:outline-none focus:border-black resize-none font-mono"
                />
              </div>

              <div className="flex space-x-3 pt-4 border-t border-[#e5e5e5]">
                <button
                  type="submit"
                  className="bg-black text-white px-4 py-2 rounded font-bold hover:bg-neutral-800 transition-all"
                >
                  保存并同步 RAG 索引
                </button>
                <button
                  type="button"
                  onClick={() => setIsCreating(false)}
                  className="bg-[#f0f0f0] text-black px-4 py-2 rounded hover:bg-[#e0e0e0] transition-all"
                >
                  取消
                </button>
              </div>
            </form>
          </div>
        ) : selectedSet ? (
          <div className="max-w-5xl mx-auto space-y-6">
            <div className="pb-4 border-b border-[#e5e5e5] flex items-start justify-between">
              <div>
                <span className="text-xs font-bold bg-black text-white px-2 py-0.5 rounded inline-block mb-2">
                  {selectedSet.category}
                </span>
                <h1 className="font-serif font-bold text-2xl text-black">{selectedSet.name}</h1>
              </div>
              <span className="flex items-center space-x-1 text-xs text-[#2e8b57] font-semibold bg-[#f0f9f4] border border-[#2e8b57] px-2.5 py-1 rounded">
                <CheckCircle size={13} />
                <span>RAG 检索索引激活</span>
              </span>
            </div>

            <div className="p-4 bg-[#fafafa] border border-[#e5e5e5] rounded text-xs">
              <div className="font-bold text-black text-sm mb-2 flex items-center space-x-1.5">
                <Layers size={14} />
                <span>设定概述与体系原理</span>
              </div>
              <p className="text-[#333333] leading-relaxed font-serif text-sm">
                {selectedSet.description}
              </p>
            </div>

            <div className="p-5 bg-white border-2 border-black rounded space-y-3">
              <div className="flex items-center justify-between border-b border-[#e5e5e5] pb-2">
                <div className="font-bold text-black text-sm flex items-center space-x-2">
                  <ShieldAlert size={16} className="text-black" />
                  <span>绝对底线与铁律红线 (Hard Constraints)</span>
                </div>
                <span className="text-[11px] bg-black text-white px-2 py-0.5 rounded font-mono">
                  已接入校验 Agent
                </span>
              </div>
              <p className="text-xs text-[#666666]">
                当本章节大纲中关联到该设定时，校验 Agent 会在最终自检阶段把以下每条规则作为严格红线进行冲突校验：
              </p>
              <div className="space-y-2 mt-3">
                {selectedSet.hardRules.map((rule, idx) => (
                  <div
                    key={idx}
                    className="p-3 bg-[#f9f9f9] border border-[#d1d1d1] rounded text-xs text-black font-semibold flex items-start space-x-2.5"
                  >
                    <span className="bg-black text-white w-4 h-4 rounded-full flex items-center justify-center text-[10px] shrink-0 mt-0.5 font-mono">
                      {idx + 1}
                    </span>
                    <span className="leading-relaxed font-serif">{rule}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center space-x-2 pt-2">
              <Tag size={13} className="text-black" />
              <div className="flex flex-wrap gap-1">
                {selectedSet.tags.map((tag, i) => (
                  <span key={i} className="text-xs bg-[#f0f0f0] text-black px-2 py-0.5 rounded border border-[#cccccc]">
                    #{tag}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
};
