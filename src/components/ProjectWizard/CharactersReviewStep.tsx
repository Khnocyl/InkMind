import React, { useState } from 'react';
import type { Character, CharacterRole } from '../../types/novel';

import { Users, UserPlus, Trash2, ArrowRight, ArrowLeft, RefreshCw, Eye, ShieldAlert, Sparkles, MapPin, Award } from 'lucide-react';

interface CharactersReviewStepProps {
  characters: Character[];
  onNext: (updatedCharacters: Character[]) => void;
  onPrev?: () => void;
  onRegenerate: () => void;
  isGenerating: boolean;
  progressMsg?: string;
}

/** 身份 tag pill 色分：主角=黑 / 反派=红 / 神秘人=灰 / 其余=玫红 */
const rolePillClass = (role: CharacterRole): string => {
  switch (role) {
    case '主角':
      return 'bg-slate-900 text-white border border-slate-900';
    case '反派':
      return 'bg-rose-100 text-rose-800 border border-rose-300';
    case '神秘路人':
      return 'bg-slate-100 text-slate-600 border border-slate-300';
    default:
      return 'bg-rose-50 text-rose-700 border border-rose-200';
  }
};

export const CharactersReviewStep: React.FC<CharactersReviewStepProps> = ({
  characters: initialChars,
  onNext,
  onPrev,
  onRegenerate,
  isGenerating,
  progressMsg,
}) => {
  const [characters, setCharacters] = useState<Character[]>(initialChars);
  const [activeCharId, setActiveCharId] = useState<string>(initialChars[0]?.id || '');

  const activeChar = characters.find((c) => c.id === activeCharId) || characters[0];

  const handleUpdateActive = (updates: Partial<Character>) => {
    if (!activeChar) return;
    setCharacters(characters.map((c) => (c.id === activeChar.id ? { ...c, ...updates } : c)));
  };

  const handleAddCharacter = () => {
    const newChar: Character = {
      id: `char-${Date.now()}`,
      name: '神秘新角色',
      alias: '隐藏高人/过客',
      role: '重要配角',
      status: '活跃',
      realmOrTitle: '隐秘高阶',
      currentLocation: '未知疆域',
      personality: '表里不一，行事乖张却暗藏良知',
      appearance: '黑袍金丝微纹，眼神极具侵略性，指节处留有一道浅色烙印',
      background: '近期从极北之地神秘来到主角所在风云之地，意图搜寻上古密匙。',
      secretNotes: '实际上是天道执事安插的眼线，但背叛了组织，准备寻找机会与主角结盟。',
      relations: [],
    };
    setCharacters([...characters, newChar]);
    setActiveCharId(newChar.id);
  };

  const handleDeleteCharacter = (id: string) => {
    if (characters.length <= 1) return;
    const nextList = characters.filter((c) => c.id !== id);
    setCharacters(nextList);
    if (activeCharId === id) {
      setActiveCharId(nextList[0].id);
    }
  };

  return (
    <div className="max-w-6xl mx-auto py-6 animate-fadeIn">
      <div className="bg-white border border-slate-200 rounded-2xl p-6 md:p-8 shadow-xl space-y-6">
        {/* 标题区 + 右上角动作按钮组 */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-6">
          <div className="flex items-center space-x-3">
            <div className="p-3 bg-black rounded-2xl shadow-md text-white shrink-0">
              <Users className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-900">
                第三步：核心出场人物图谱审核与深度精细调优
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                AI 为故事量身定制了拥有极高质感与潜层秘密的核心阵营。你可以挑选、增添或直接修改他们的秘密伏笔。
              </p>
            </div>
          </div>

          <div className="flex space-x-2 shrink-0">
            <button
              onClick={handleAddCharacter}
              disabled={isGenerating}
              className="flex items-center space-x-1.5 px-3 py-2 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded-full text-xs font-medium transition-all"
            >
              <UserPlus className="w-4 h-4" />
              <span>新建角色</span>
            </button>
            <button
              onClick={onRegenerate}
              disabled={isGenerating}
              className="flex items-center space-x-2 px-4 py-2 bg-white hover:bg-slate-100 text-slate-700 rounded-full border border-slate-300 transition-all text-sm font-medium disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${isGenerating ? 'animate-spin' : ''}`} />
              <span>AI 重新推导全员角色</span>
            </button>
          </div>
        </div>

        {isGenerating ? (
          <div className="py-16 text-center space-y-4">
            <div className="w-12 h-12 border-4 border-slate-900 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm font-medium text-slate-700">{progressMsg || 'AI 正在为你勾勒极其丰满的人物性格与隐藏深层伏笔...'}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* 左栏：角色卡列表 */}
            <div className="lg:col-span-4 space-y-2 max-h-[600px] overflow-y-auto pr-1">
              {characters.map((c) => (
                <div
                  key={c.id}
                  onClick={() => setActiveCharId(c.id)}
                  className={`p-4 rounded-xl border cursor-pointer transition-all flex items-start justify-between ${
                    activeChar?.id === c.id
                      ? 'bg-slate-50 border-slate-900 ring-1 ring-slate-900 shadow-md'
                      : 'bg-white border-slate-200 hover:border-slate-400 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex-1 min-w-0 pr-2">
                    <div className="flex items-center space-x-2">
                      <span className="font-bold text-slate-900 text-base truncate">{c.name}</span>
                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold shrink-0 ${rolePillClass(c.role)}`}>
                        {c.role}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1 truncate">
                      头衔/境界：{c.realmOrTitle || '暂无'}
                    </p>
                    <p className="text-[11px] text-slate-600 mt-1 line-clamp-1">
                      {c.personality}
                    </p>
                  </div>

                  {characters.length > 1 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteCharacter(c.id);
                      }}
                      className="text-slate-400 hover:text-rose-600 p-1 rounded transition-colors shrink-0"
                      title="删除此角色"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* 右栏：选定角色编辑表单 */}
            {activeChar ? (
              <div className="lg:col-span-8 bg-slate-50 border border-slate-200 rounded-xl p-6 space-y-5 shadow-inner">
                {/* 姓名 / 别名 */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 tracking-wide mb-1">
                      角色姓名 (Name)
                    </label>
                    <input
                      type="text"
                      value={activeChar.name}
                      onChange={(e) => handleUpdateActive({ name: e.target.value })}
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm font-bold text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 tracking-wide mb-1">
                      化名 / 外号 (Alias)
                    </label>
                    <input
                      type="text"
                      value={activeChar.alias}
                      onChange={(e) => handleUpdateActive({ alias: e.target.value })}
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                </div>

                {/* 阵营与身份 / 功法境界 / 当前所在 */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 tracking-wide mb-1">
                      阵营与身份角色
                    </label>
                    <select
                      value={activeChar.role}
                      onChange={(e) => handleUpdateActive({ role: e.target.value as CharacterRole })}
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                    >
                      <option value="主角">主角</option>
                      <option value="重要配角">重要配角</option>
                      <option value="反派">反派</option>
                      <option value="势力首领">势力首领</option>
                      <option value="神秘路人">神秘路人</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 tracking-wide mb-1 flex items-center space-x-1">
                      <Award className="w-3.5 h-3.5" />
                      <span>功法境界 / 核心头衔</span>
                    </label>
                    <input
                      type="text"
                      value={activeChar.realmOrTitle}
                      onChange={(e) => handleUpdateActive({ realmOrTitle: e.target.value })}
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 tracking-wide mb-1 flex items-center space-x-1">
                      <MapPin className="w-3.5 h-3.5" />
                      <span>当前主要所在地域/位置</span>
                    </label>
                    <input
                      type="text"
                      value={activeChar.currentLocation}
                      onChange={(e) => handleUpdateActive({ currentLocation: e.target.value })}
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                </div>

                {/* 性格与行为准则 */}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 tracking-wide mb-1 flex items-center space-x-1">
                    <Sparkles className="w-3.5 h-3.5 text-amber-600" />
                    <span>性格矛盾与行为准则</span>
                  </label>
                  <input
                    type="text"
                    value={activeChar.personality}
                    onChange={(e) => handleUpdateActive({ personality: e.target.value })}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                  />
                </div>

                {/* Show Don't Tell 演示（◉ 前缀） */}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 tracking-wide mb-1 flex items-center space-x-1">
                    <Eye className="w-3.5 h-3.5 text-amber-600" />
                    <span>◉ 微细辨识度外貌特征 (用于 Show Don't Tell 渲染)</span>
                  </label>
                  <textarea
                    value={activeChar.appearance}
                    onChange={(e) => handleUpdateActive({ appearance: e.target.value })}
                    rows={2}
                    className="w-full bg-white border border-slate-300 rounded-lg p-3 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                  />
                </div>

                {/* 深层背景与核心动机 */}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 tracking-wide mb-1">
                    过往经历与核心动机简述
                  </label>
                  <textarea
                    value={activeChar.background}
                    onChange={(e) => handleUpdateActive({ background: e.target.value })}
                    rows={3}
                    className="w-full bg-white border border-slate-300 rounded-lg p-3 text-sm text-slate-900 focus:border-slate-900 focus:outline-none leading-relaxed"
                  />
                </div>

                {/* 隐藏秘密 / 真实身份与致命软肋（红色保密框） */}
                <div className="bg-rose-50 border border-rose-300 rounded-xl p-4">
                  <label className="block text-xs font-bold text-rose-800 tracking-wide mb-2 flex items-center space-x-1.5">
                    <ShieldAlert className="w-4 h-4 text-rose-600 animate-pulse" />
                    <span>🔒 隐藏暗线 / 真实身份与致命软肋（绝密伏笔，仅 AI 与作者可见）</span>
                  </label>
                  <textarea
                    value={activeChar.secretNotes}
                    onChange={(e) => handleUpdateActive({ secretNotes: e.target.value })}
                    rows={3}
                    placeholder="在这里写下角色不为人知的秘密，比如其实是上一代古魔转世、背后操纵着宗门决裂等..."
                    className="w-full bg-white border border-rose-200 rounded-lg p-3 text-sm text-rose-900 focus:border-rose-500 focus:outline-none leading-relaxed"
                  />
                </div>
              </div>
            ) : (
              <div className="lg:col-span-8 flex items-center justify-center bg-slate-50 border border-slate-200 rounded-xl p-12 text-slate-500">
                请在左侧选择一个角色进行查看与优化
              </div>
            )}
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
              <span>上一步 (调整书名与梗概)</span>
            </button>
          ) : <div />}
          <button
            type="button"
            onClick={() => onNext(characters)}
            disabled={isGenerating}
            className="px-8 py-3.5 bg-black hover:bg-neutral-800 text-white font-bold rounded-full shadow-lg flex items-center space-x-2 transition-all transform hover:-translate-y-0.5 text-sm"
          >
            <span>确认无误，构思世界观与铁律红线</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
