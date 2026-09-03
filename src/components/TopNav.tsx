import React, { useState } from 'react';
import type { BookProject, StyleConfig } from '../types/novel';
import { PenTool, Database, GitBranch, ShieldAlert, Sparkles, BookOpen, Terminal } from 'lucide-react';
import { LlmTraceModal } from './LlmTraceModal';
import { WindowControls } from './WindowControls';

interface TopNavProps {
  project: BookProject;
  activeTab: 'workspace' | 'world' | 'outline' | 'style';
  setActiveTab: (tab: 'workspace' | 'world' | 'outline' | 'style') => void;
  styleConfig?: StyleConfig;
  onOpenProjectSelector: () => void;
  onOpenWizard: () => void;
  onOpenReadingPreview?: () => void;
}

export const TopNav: React.FC<TopNavProps> = ({
  project,
  activeTab,
  setActiveTab,
  onOpenProjectSelector,
  onOpenWizard,
  onOpenReadingPreview,
}) => {
  const [traceOpen, setTraceOpen] = useState(false);

  return (
    <header className="h-[44px] bg-white border-b border-neutral-200 px-5 flex items-center justify-between sticky top-0 z-50 select-none text-black app-region-drag">
      {/* 左侧：书架切换与小说基本标识 */}
      <div className="flex items-center space-x-3 min-w-0 overflow-hidden app-region-no-drag">
        <button
          onClick={onOpenProjectSelector}
          className="flex items-center space-x-2 bg-slate-100 hover:bg-slate-200 px-2.5 py-1 rounded-lg border border-slate-200 transition-all text-[12.5px] group"
          title="切换小说项目或打开书库"
        >
          <img
            src="/icon.png"
            alt="InkMind"
            className="w-6 h-6 rounded-md object-cover shadow-xs shrink-0"
            onError={(e) => {
              (e.currentTarget as HTMLElement).style.display = 'none';
            }}
          />
          <span className="font-serif font-bold text-sm text-black tracking-wide group-hover:text-neutral-900 transition-colors max-w-[7rem] truncate">
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
          <Sparkles size={12} className="text-white" />
          <span>向导设置</span>
        </button>

        <div className="hidden md:flex items-center space-x-2 shrink-0">
          <span className="text-xs text-slate-600 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-full font-sans font-medium">
            {project.genre || '未设定分类'}
          </span>
        </div>
      </div>

      {/* 中间：四大核心模块工作区导航 Tab */}
      <nav className="flex items-center gap-[3px] bg-slate-100 p-[3px] rounded-[10px] border border-slate-200 app-region-no-drag">
        <button
          onClick={() => setActiveTab('workspace')}
          className={`flex items-center space-x-1.5 px-2.5 py-[5px] rounded-[7px] text-[11px] font-semibold transition-all whitespace-nowrap ${
            activeTab === 'workspace' ? 'bg-black text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-white'
          }`}
        >
          <PenTool size={13} />
          <span>写作</span>
        </button>

        <button
          onClick={() => setActiveTab('world')}
          className={`flex items-center space-x-1.5 px-2.5 py-[5px] rounded-[7px] text-[11px] font-semibold transition-all whitespace-nowrap ${
            activeTab === 'world' ? 'bg-black text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-white'
          }`}
        >
          <Database size={13} />
          <span>设定与角色</span>
        </button>

        <button
          onClick={() => setActiveTab('outline')}
          className={`flex items-center space-x-1.5 px-2.5 py-[5px] rounded-[7px] text-[11px] font-semibold transition-all whitespace-nowrap ${
            activeTab === 'outline' ? 'bg-black text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-white'
          }`}
        >
          <GitBranch size={13} />
          <span>大纲</span>
        </button>

        <button
          onClick={() => setActiveTab('style')}
          className={`flex items-center space-x-1.5 px-2.5 py-[5px] rounded-[7px] text-[11px] font-semibold transition-all whitespace-nowrap ${
            activeTab === 'style' ? 'bg-black text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-white'
          }`}
        >
          <ShieldAlert size={13} />
          <span>设置</span>
        </button>
      </nav>

      {/* 右侧：AI调用记录 + 桌面端窗口控件 */}
      <div className="flex items-center space-x-2 text-xs text-slate-700 min-w-0 app-region-no-drag">
        <button
          onClick={() => setTraceOpen(true)}
          className="hidden sm:flex items-center space-x-1 text-xs text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 border border-slate-200 px-2 py-0.5 rounded-full transition-all font-medium shrink-0"
          title="AI 调用记录：查看发给模型的 Prompt 与原始响应"
        >
          <Terminal size={12} className="text-slate-500" />
          <span>AI 调用记录</span>
        </button>
        <WindowControls />
      </div>
      {traceOpen && <LlmTraceModal onClose={() => setTraceOpen(false)} />}
    </header>
  );
};
