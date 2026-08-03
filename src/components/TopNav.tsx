import React from 'react';
import type { BookProject, StyleConfig } from '../types/novel';
import { computeBookProgress } from '../services/writingProgress';
import { evaluateDailyGoal } from '../services/dailyWordLog';
import { PenTool, Database, GitBranch, ShieldAlert, Cpu, Sparkles, BookOpen, Flame } from 'lucide-react';
import { UsageBadge } from './UsageBadge';

interface TopNavProps {
  project: BookProject;
  activeTab: 'workspace' | 'world' | 'outline' | 'style';
  setActiveTab: (tab: 'workspace' | 'world' | 'outline' | 'style') => void;
  styleConfig: StyleConfig;
  totalWords: number;
  onOpenProjectSelector: () => void;
  onOpenWizard: () => void;
  onOpenReadingPreview?: () => void;
}

export const TopNav: React.FC<TopNavProps> = ({
  project,
  activeTab,
  setActiveTab,
  styleConfig,
  totalWords: _totalWords,
  onOpenProjectSelector,
  onOpenWizard,
  onOpenReadingPreview,
}) => {
  const progress = computeBookProgress(project);
  const barPct = progress.wordPct ?? progress.chapterPct ?? null;
  const daily = evaluateDailyGoal(
    project.dailyWordLog,
    styleConfig.dailyWordTarget ?? 3000
  );

  return (
    <header className="bg-white border-b border-neutral-200 px-6 py-3 flex items-center justify-between sticky top-0 z-50 select-none text-black shadow-sm">
      {/* 左侧：书架切换与小说基本标识 */}
      <div className="flex items-center space-x-3 min-w-0 overflow-hidden">
        <button
          onClick={onOpenProjectSelector}
          className="flex items-center space-x-2 bg-slate-100 hover:bg-slate-200 px-2.5 py-1.5 rounded-xl border border-slate-200 transition-all text-sm group shadow-sm"
          title="切换小说项目或打开书库"
        >
          <div className="w-6 h-6 bg-black text-white flex items-center justify-center font-serif font-bold text-xs rounded-lg shadow-inner">
            墨
          </div>
          <span className="font-serif font-bold text-sm text-black tracking-wide group-hover:text-indigo-700 transition-colors max-w-[7rem] truncate">
            {project.title || '无标题小说'}
          </span>
          <span className="text-[10px] bg-white text-slate-600 px-1 py-0.5 rounded border border-slate-200">
            切换书库 ▾
          </span>
        </button>

        {onOpenReadingPreview && (
          <button
            onClick={onOpenReadingPreview}
            className="hidden sm:flex items-center space-x-1 text-xs text-stone-700 hover:text-stone-900 bg-stone-100 hover:bg-stone-200 border border-stone-300 px-2 py-0.5 rounded-full transition-all font-medium shrink-0"
            title="纯阅读预览正文"
          >
            <BookOpen size={12} className="text-stone-600" />
            <span>阅读预览</span>
          </button>
        )}
        <button
          onClick={onOpenWizard}
          className="hidden sm:flex items-center space-x-1 text-xs text-white bg-black hover:bg-neutral-800 border border-black px-2 py-0.5 rounded-full transition-all font-medium shrink-0"
          title="返回全自动设定向导调整大纲设定"
        >
          <Sparkles size={12} className="text-amber-600" />
          <span>向导设置</span>
        </button>

        <div className="hidden md:flex items-center space-x-2 shrink-0">
          <span className="text-xs text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full font-sans font-medium">
            {project.genre || '未设定分类'}
          </span>
        </div>
      </div>

      {/* 中间：四大核心模块工作区导航 Tab */}
      <nav className="flex items-center space-x-1 bg-slate-100 p-1 rounded-xl border border-slate-200 shadow-inner">
        <button
          onClick={() => setActiveTab('workspace')}
          className={`flex items-center space-x-1.5 px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-all whitespace-nowrap ${
            activeTab === 'workspace' ? 'bg-black text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-white'
          }`}
        >
          <PenTool size={13} />
          <span className="hidden lg:inline">沉浸创作台</span>
          <span className="lg:hidden">创作台</span>
        </button>

        <button
          onClick={() => setActiveTab('world')}
          className={`flex items-center space-x-1.5 px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-all whitespace-nowrap ${
            activeTab === 'world' ? 'bg-black text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-white'
          }`}
        >
          <Database size={13} />
          <span className="hidden lg:inline">设定与角色图谱</span>
          <span className="lg:hidden">设定</span>
        </button>

        <button
          onClick={() => setActiveTab('outline')}
          className={`flex items-center space-x-1.5 px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-all whitespace-nowrap ${
            activeTab === 'outline' ? 'bg-black text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-white'
          }`}
        >
          <GitBranch size={13} />
          <span className="hidden lg:inline">大纲剧情链</span>
          <span className="lg:hidden">大纲</span>
        </button>

        <button
          onClick={() => setActiveTab('style')}
          className={`flex items-center space-x-1.5 px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-all whitespace-nowrap ${
            activeTab === 'style' ? 'bg-black text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-white'
          }`}
        >
          <ShieldAlert size={13} />
          <span className="hidden lg:inline">去 AI 味与后端配置</span>
          <span className="lg:hidden">风格引擎</span>
        </button>
      </nav>

      {/* 右侧：引擎 + 用量 + 日更 + 全书进度 */}
      <div className="flex items-center space-x-3 text-xs text-slate-700 min-w-0">
        <UsageBadge styleConfig={styleConfig} />
        <div className="hidden xl:flex items-center space-x-2 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-xl shrink-0">
          <Cpu size={14} className="text-indigo-600" />
          <span className="font-semibold text-slate-800 max-w-[9rem] truncate">
            {styleConfig.modelName || 'DeepSeek / OpenAI 引擎'}
          </span>
        </div>

        {daily.target != null && (
          <div
            className={`hidden md:block text-right min-w-[7.5rem] max-w-[10rem] ${
              daily.met ? 'text-emerald-800' : 'text-orange-900'
            }`}
            title={daily.label}
          >
            <div className="text-[10px] uppercase tracking-wider flex items-center justify-end gap-1 opacity-80">
              <Flame size={10} />
              <span>今日日更</span>
            </div>
            <div className="font-mono font-bold text-sm truncate">
              {daily.todayWords.toLocaleString()}
              <span className="text-[10px] font-semibold opacity-70">
                /{daily.target.toLocaleString()}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full rounded-full bg-slate-200 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  daily.met ? 'bg-emerald-500' : 'bg-orange-400'
                }`}
                style={{
                  width: `${Math.min(100, Math.max(2, daily.pct ?? 0))}%`,
                }}
              />
            </div>
          </div>
        )}

        <div
          className="text-right min-w-[9.5rem] max-w-[14rem]"
          title={`${progress.chapterLabel}${
            progress.openTodos > 0 ? ` · 待修 ${progress.openTodos}` : ''
          }`}
        >
          <div className="text-[10px] text-slate-500 uppercase tracking-wider flex items-center justify-end gap-1.5">
            <span>全书进度</span>
            {progress.openTodos > 0 && (
              <span className="normal-case tracking-normal text-amber-700 font-semibold">
                待修{progress.openTodos}
              </span>
            )}
          </div>
          <div className="font-mono font-bold text-sm text-indigo-700 truncate">
            {progress.wordLabel}
          </div>
          {barPct != null && (
            <div className="mt-1 h-1.5 w-full rounded-full bg-slate-200 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  barPct >= 100
                    ? 'bg-emerald-500'
                    : barPct >= 60
                      ? 'bg-indigo-500'
                      : 'bg-indigo-400'
                }`}
                style={{ width: `${Math.min(100, Math.max(2, barPct))}%` }}
              />
            </div>
          )}
          <div className="text-[10px] text-slate-500 mt-0.5 truncate font-medium">
            {progress.chapterLabel}
          </div>
        </div>
      </div>
    </header>
  );
};
