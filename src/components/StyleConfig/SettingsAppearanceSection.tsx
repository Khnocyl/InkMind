/**
 * 设置分区：外观设置 · 界面主题
 * （自 StyleAndEngineManager 拆出；state 由 useTheme 全局持有，本组件无壳依赖）
 */
import React from 'react';
import { Monitor, Sun, Moon, Palette, Check } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';

interface SettingsAppearanceSectionProps {
  /** 壳层状态提示（成功切换主题时回执一条 ✅ 消息） */
  onStatus: (msg: string) => void;
}

export const SettingsAppearanceSection: React.FC<SettingsAppearanceSectionProps> = ({
  onStatus,
}) => {
  const { mode: currentThemeMode, resolvedTheme, setThemeMode } = useTheme();

  return (
    <div
      id="sec-appearance"
      className="bg-slate-50 border border-slate-200 rounded-2xl p-6 shadow-md space-y-6 animate-fadeIn"
    >
      <div className="flex items-center justify-between border-b border-slate-200 pb-4">
        <div className="flex items-center space-x-2.5">
          <Palette className="w-5 h-5 text-neutral-800" />
          <div>
            <h2 className="text-base font-bold text-slate-900">外观设置 · 界面主题</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              个性化定制应用界面的深浅显示模式。支持跟随操作系统实时自动切换。
            </p>
          </div>
        </div>
        <div className="flex items-center space-x-2 text-xs font-semibold px-3 py-1 rounded-full bg-slate-200 text-slate-800 border border-slate-300">
          <span>当前生效：{resolvedTheme === 'dark' ? '🌙 深色模式' : '☀️ 浅色模式'}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* 跟随系统 */}
        <button
          type="button"
          onClick={() => {
            setThemeMode('system');
            onStatus('✅ 外观设置已切换为：跟随系统（将自动随操作系统深浅切换）');
          }}
          className={`flex flex-col items-start p-4 rounded-xl border text-left transition-all cursor-pointer relative ${
            currentThemeMode === 'system'
              ? 'border-neutral-900 bg-white ring-2 ring-neutral-900 shadow-md'
              : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
          }`}
        >
          <div className="flex items-center justify-between w-full mb-3">
            <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-slate-800">
              <Monitor className="w-5 h-5" />
            </div>
            {currentThemeMode === 'system' && (
              <span className="flex items-center gap-1 text-[11px] font-bold text-neutral-900 bg-neutral-100 px-2 py-0.5 rounded-full">
                <Check className="w-3.5 h-3.5" /> 已选
              </span>
            )}
          </div>
          <div className="font-bold text-sm text-slate-900 mb-1">跟随系统</div>
          <p className="text-xs text-slate-500 leading-relaxed">
            自动检测并与操作系统的深浅色模式保持同步。系统主题切换时无需重启或刷新即时生效。
          </p>
        </button>

        {/* 浅色模式 */}
        <button
          type="button"
          onClick={() => {
            setThemeMode('light');
            onStatus('✅ 外观设置已强制切换为：浅色模式');
          }}
          className={`flex flex-col items-start p-4 rounded-xl border text-left transition-all cursor-pointer relative ${
            currentThemeMode === 'light'
              ? 'border-neutral-900 bg-white ring-2 ring-neutral-900 shadow-md'
              : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
          }`}
        >
          <div className="flex items-center justify-between w-full mb-3">
            <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center text-amber-600">
              <Sun className="w-5 h-5" />
            </div>
            {currentThemeMode === 'light' && (
              <span className="flex items-center gap-1 text-[11px] font-bold text-neutral-900 bg-neutral-100 px-2 py-0.5 rounded-full">
                <Check className="w-3.5 h-3.5" /> 已选
              </span>
            )}
          </div>
          <div className="font-bold text-sm text-slate-900 mb-1">浅色</div>
          <p className="text-xs text-slate-500 leading-relaxed">
            经典高清晰度纸面阅读质感，纯白底色黑字排版，适合白天或明亮环境下的长篇码字创作。
          </p>
        </button>

        {/* 深色模式 */}
        <button
          type="button"
          onClick={() => {
            setThemeMode('dark');
            onStatus('✅ 外观设置已强制切换为：深色模式');
          }}
          className={`flex flex-col items-start p-4 rounded-xl border text-left transition-all cursor-pointer relative ${
            currentThemeMode === 'dark'
              ? 'border-neutral-900 bg-white ring-2 ring-neutral-900 shadow-md'
              : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
          }`}
        >
          <div className="flex items-center justify-between w-full mb-3">
            <div className="w-9 h-9 rounded-lg bg-indigo-900/20 flex items-center justify-center text-indigo-400">
              <Moon className="w-5 h-5" />
            </div>
            {currentThemeMode === 'dark' && (
              <span className="flex items-center gap-1 text-[11px] font-bold text-neutral-900 bg-neutral-100 px-2 py-0.5 rounded-full">
                <Check className="w-3.5 h-3.5" /> 已选
              </span>
            )}
          </div>
          <div className="font-bold text-sm text-slate-900 mb-1">深色</div>
          <p className="text-xs text-slate-500 leading-relaxed">
            舒适护眼的深灰黑夜间配色，降低屏幕眩光与视觉疲劳，沉浸于深夜灵感爆发与小说执笔。
          </p>
        </button>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600 space-y-1.5 leading-relaxed">
        <div className="font-semibold text-slate-800 flex items-center gap-1.5">
          💡 外观配置说明
        </div>
        <ul className="list-disc pl-5 space-y-1 text-[11px]">
          <li>设置默认使用「跟随系统」，支持 Windows / macOS 系统外观的即时响应；</li>
          <li>手动指定「浅色」或「深色」后将锁定当前模式，且选项会自动永久保存至本地配置；</li>
          <li>页面重新加载或桌面端应用重启时将无缝恢复您的外观选择，且杜绝任何闪烁现象。</li>
        </ul>
      </div>
    </div>
  );
};
