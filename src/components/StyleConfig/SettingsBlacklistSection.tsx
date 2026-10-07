/**
 * 设置分区：黑名单 / 去AI味（Cliché Blacklist + deslop 白名单）
 * （自 StyleAndEngineManager 拆出；输入草稿 state 挂壳层以保证分区切换不丢字）
 */
import React from 'react';
import { Sliders, Plus, Trash2 } from 'lucide-react';
import type { StyleConfig } from '../../types/novel';
import { collectBlacklistExemptions } from '../../services/aiTasteScan';

interface SettingsBlacklistSectionProps {
  styleConfig: StyleConfig;
  onUpdateStyleConfig: (
    config: StyleConfig | ((prev: StyleConfig) => StyleConfig)
  ) => Promise<void> | void;
  /** 黑名单输入草稿（壳层持有，分区切换间存活） */
  newBlacklistWord: string;
  setNewBlacklistWord: (v: string) => void;
  /** 白名单输入草稿（壳层持有，分区切换间存活） */
  newWhitelistWord: string;
  setNewWhitelistWord: (v: string) => void;
}

export const SettingsBlacklistSection: React.FC<SettingsBlacklistSectionProps> = ({
  styleConfig,
  onUpdateStyleConfig,
  newBlacklistWord,
  setNewBlacklistWord,
  newWhitelistWord,
  setNewWhitelistWord,
}) => {
  const handleAddBlacklist = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBlacklistWord.trim()) return;
    onUpdateStyleConfig((prev) => {
      if ((prev.customBlacklist || []).includes(newBlacklistWord.trim())) return prev;
      return {
        ...prev,
        customBlacklist: [...(prev.customBlacklist || []), newBlacklistWord.trim()],
      };
    });
    setNewBlacklistWord('');
  };

  const handleRemoveCustomWord = (word: string) => {
    onUpdateStyleConfig((prev) => ({
      ...prev,
      customBlacklist: (prev.customBlacklist || []).filter((w) => w !== word),
    }));
  };

  const handleAddWhitelist = (e: React.FormEvent) => {
    e.preventDefault();
    const w = newWhitelistWord.trim();
    if (!w) return;
    onUpdateStyleConfig((prev) => {
      const list = prev.deslopWhitelist || [];
      if (list.includes(w)) return prev;
      return { ...prev, deslopWhitelist: [...list, w] };
    });
    setNewWhitelistWord('');
  };

  const handleRemoveWhitelist = (word: string) => {
    onUpdateStyleConfig((prev) => ({
      ...prev,
      deslopWhitelist: (prev.deslopWhitelist || []).filter((w) => w !== word),
    }));
  };

  return (
      <div id="sec-blacklist" className="bg-slate-50 border border-slate-200 rounded-2xl p-6 space-y-5 shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 pb-3">
          <div className="font-bold text-base text-slate-900 flex items-center space-x-2">
            <Sliders className="w-5 h-5 text-purple-600" />
            <span>网文高频 AI 套话屏蔽词库 (Cliché Blacklist)</span>
          </div>
          <span className="text-xs font-mono bg-purple-100 text-purple-800 px-2.5 py-1 rounded-full border border-purple-300 font-semibold">
            实时拦截净化中
          </span>
        </div>

        <div className="p-4 bg-white border border-slate-200 rounded-xl space-y-3 shadow-sm">
          <div className="text-xs font-bold text-slate-700">
            系统内置反套路黑名单（执笔 & 审校双层覆盖）:
          </div>
          <div className="flex flex-wrap gap-2">
            {(styleConfig.clicheBlacklist || []).map((word, idx) => (
              <span
                key={idx}
                className="text-xs bg-slate-100 text-slate-800 border border-slate-300 px-2.5 py-1 rounded-lg font-mono font-medium shadow-sm"
              >
                🚫 {word}
              </span>
            ))}
          </div>
        </div>

        <div className="p-4 bg-white border border-slate-200 rounded-xl space-y-3 shadow-sm">
          <div className="text-xs font-bold text-slate-800 flex items-center justify-between">
            <span>您自定义追加的屏蔽词或禁言句式：</span>
            <span className="text-slate-500 font-normal">
              {(styleConfig.customBlacklist || []).length} 个自定义规则
            </span>
          </div>

          <form onSubmit={handleAddBlacklist} className="flex space-x-2">
            <input
              type="text"
              placeholder="添加您想要彻底断绝的 AI 惯用词句（例如：不由得感到一阵心惊……）"
              value={newBlacklistWord}
              onChange={(e) => setNewBlacklistWord(e.target.value)}
              className="flex-1 text-xs p-2.5 border border-slate-300 rounded-xl text-slate-900 bg-white focus:outline-none focus:border-neutral-900"
            />
            <button
              type="submit"
              className="bg-black hover:bg-neutral-800 text-white px-5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center space-x-1 shrink-0 shadow-md"
            >
              <Plus size={14} />
              <span>追加黑名单</span>
            </button>
          </form>

          <div className="flex flex-wrap gap-2 pt-1">
            {(styleConfig.customBlacklist || []).map((word, idx) => (
              <span
                key={idx}
                className="text-xs bg-purple-50 text-purple-900 border border-purple-300 px-3 py-1 rounded-lg font-mono flex items-center space-x-2 font-medium"
              >
                <span>🚫 {word}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveCustomWord(word)}
                  className="text-purple-600 hover:text-red-600 font-bold"
                >
                  <Trash2 size={13} />
                </button>
              </span>
            ))}
          </div>
        </div>

        {/* 去AI味：白名单 + 扩展机检 */}
        <div className="p-4 bg-white border border-teal-200 rounded-xl space-y-3 shadow-sm">
          <div className="text-xs font-bold text-teal-900">
            去AI味扩展机检（句式 / 节奏 / 解释腔 · 对齐网文 deslop）
          </div>
          <p className="text-[11px] text-slate-600 leading-relaxed">
            写后对润色稿复扫：否定翻转、万能「带着」、解释腔、段均句数、对话标签密度等。
            默认 warn 压分；可勾选严格/重度阻断。
          </p>
          <div className="flex flex-col gap-2 text-xs font-semibold text-slate-700">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={styleConfig.useExtendedClicheList !== false}
                onChange={(e) =>
                  onUpdateStyleConfig({
                    ...styleConfig,
                    useExtendedClicheList: e.target.checked,
                  })
                }
              />
              使用内置扩展套话表（眼中闪过、缓缓开口等）
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={styleConfig.aiTasteStrict === true}
                onChange={(e) =>
                  onUpdateStyleConfig({
                    ...styleConfig,
                    aiTasteStrict: e.target.checked,
                  })
                }
              />
              严格模式（解释腔等升 error）
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={styleConfig.aiTasteBlockHeavy === true}
                onChange={(e) =>
                  onUpdateStyleConfig({
                    ...styleConfig,
                    aiTasteBlockHeavy: e.target.checked,
                  })
                }
              />
              AI 味「重度」阻断自动绿通/锁章
            </label>
          </div>
          <div className="text-xs font-bold text-slate-800 pt-1">
            白名单（功法名/绰号/专名命中豁免）
          </div>
          <form onSubmit={handleAddWhitelist} className="flex space-x-2">
            <input
              type="text"
              placeholder="例如：缓缓（角色绰号）、仿佛山海（书名）"
              value={newWhitelistWord}
              onChange={(e) => setNewWhitelistWord(e.target.value)}
              className="flex-1 text-xs p-2.5 border border-slate-300 rounded-xl text-slate-900 bg-white focus:outline-none focus:border-teal-600"
            />
            <button
              type="submit"
              className="bg-black hover:bg-neutral-800 text-white px-4 py-2.5 rounded-xl text-xs font-bold shrink-0"
            >
              <Plus size={14} className="inline mr-1" />
              豁免
            </button>
          </form>
          <div className="flex flex-wrap gap-2">
            {(styleConfig.deslopWhitelist || []).length === 0 ? (
              <span className="text-[10px] text-slate-400">暂无白名单</span>
            ) : (
              (styleConfig.deslopWhitelist || []).map((word) => (
                <span
                  key={word}
                  className="text-xs bg-teal-50 text-teal-900 border border-teal-200 px-2.5 py-1 rounded-lg font-mono flex items-center gap-1.5"
                >
                  ✅ {word}
                  <button
                    type="button"
                    onClick={() => handleRemoveWhitelist(word)}
                    className="text-teal-700 hover:text-red-600"
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              ))
            )}
          </div>
          {/* 豁免明示：白名单当前实际放行了多少条黑名单（防静默击穿）；短词仅精确匹配生效 */}
          {(() => {
            const exempted = collectBlacklistExemptions(styleConfig);
            return (
              <p className="text-[10px] text-slate-500 mt-2 leading-relaxed">
                {exempted.length > 0 ? (
                  <>
                    当前白名单豁免了 {exempted.length} 条黑名单：
                    <span className="font-mono text-amber-700">
                      {exempted.slice(0, 6).join('、')}
                      {exempted.length > 6 ? ` 等 ${exempted.length} 条` : ''}
                    </span>
                  </>
                ) : (
                  '白名单当前未豁免任何黑名单条目。'
                )}
                <br />
                规则：仅「与黑名单条目完全相同」或「≥4 字且占条目大半」的白名单词才生效，短词不再整条放行。
              </p>
            );
          })()}
        </div>
      </div>
  );
};
