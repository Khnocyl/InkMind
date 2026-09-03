import React, { useEffect, useRef, useState } from 'react';
import type { BookProjectSummary } from '../types/novel';
import {
  BookOpen,
  Plus,
  Trash2,
  Sparkles,
  X,
  ChevronRight,
  Download,
  Upload,
  FileJson,
  FileText,
} from 'lucide-react';

interface ProjectSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  projects: BookProjectSummary[];
  activeProjectId: string;
  onSelectProject: (id: string) => void;
  onCreateNewProject: () => void;
  onDeleteProject: (id: string, e: React.MouseEvent) => void;
  /** 导出当前活跃项目为 JSON 完整备份 */
  onExportJson: () => void;
  /** 导出当前活跃项目为可读 Markdown */
  onExportMarkdown: () => void;
  /** 导出 EPUB（可选仅定稿章） */
  onExportEpub?: (approvedOnly?: boolean) => void;
  /** 从文件导入（JSON 备份） */
  onImportFile: (file: File) => Promise<void>;
  /** 生成中时禁用导入导出，避免竞态 */
  busy?: boolean;
  /** 打开时回调（用于刷新书库列表） */
  onOpen?: () => void | Promise<void>;
}

export const ProjectSelectorModal: React.FC<ProjectSelectorModalProps> = ({
  isOpen,
  onClose,
  projects,
  activeProjectId,
  onSelectProject,
  onCreateNewProject,
  onDeleteProject,
  onExportJson,
  onExportMarkdown,
  onExportEpub,
  onImportFile,
  busy = false,
  onOpen,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && onOpen) {
      void onOpen();
    }
    // 仅在打开瞬间刷新，避免 onOpen 引用变化反复触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const handlePickImport = () => {
    if (busy || importing) return;
    setFeedback(null);
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    setFeedback(null);
    try {
      await onImportFile(file);
      setFeedback(`已导入：${file.name}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback(`导入失败：${msg}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div
      data-modal-backdrop="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-fadeIn app-region-no-drag select-auto modal-backdrop-layer"
    >
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] app-region-no-drag">
        {/* Modal 标题头部 */}
        <div className="p-6 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center space-x-3">
            <img
              src="/icon.png"
              alt="InkMind"
              className="w-10 h-10 rounded-xl object-contain shadow-md shrink-0 bg-black"
            />
            <div>
              <h2 className="text-lg font-bold text-slate-900">我的小说书库与连载项目</h2>
              <p className="text-xs text-slate-600">
                选择要继续创作的小说，或导入/导出全书备份（敢写不丢稿）
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition-all"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 备份工具条 */}
        <div className="px-6 py-3 border-b border-slate-100 bg-white flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mr-1">
            备份
          </span>
          <button
            type="button"
            disabled={busy || importing}
            onClick={onExportJson}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="导出当前书完整 JSON（可完整恢复，含 recap/角色/设定）"
          >
            <FileJson className="w-3.5 h-3.5" />
            导出 JSON 备份
          </button>
          <button
            type="button"
            disabled={busy || importing}
            onClick={onExportMarkdown}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="导出可读 Markdown（便于审阅；完整恢复请用 JSON）"
          >
            <FileText className="w-3.5 h-3.5" />
            导出 Markdown
          </button>
          {onExportEpub && (
            <>
              <button
                type="button"
                disabled={busy || importing}
                onClick={() => onExportEpub(false)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title="导出 EPUB，可用手机/Kindle 类阅读器打开"
              >
                <BookOpen className="w-3.5 h-3.5" />
                导出 EPUB
              </button>
              <button
                type="button"
                disabled={busy || importing}
                onClick={() => onExportEpub(true)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title="仅导出已定稿/锁定章节"
              >
                EPUB·定稿
              </button>
            </>
          )}
          <button
            type="button"
            disabled={busy || importing}
            onClick={handlePickImport}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="从 .novel.json 备份导入为新项目（不覆盖现有书）"
          >
            <Upload className="w-3.5 h-3.5" />
            {importing ? '导入中…' : '导入备份'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.novel.json,application/json"
            className="hidden"
            onChange={handleFileChange}
          />
          <span className="text-[10px] text-slate-400 flex items-center gap-1 ml-auto">
            <Download className="w-3 h-3" />
            JSON 可完整恢复 · 导入始终新建项目
          </span>
        </div>

        {feedback && (
          <div
            className={`px-6 py-2 text-xs border-b ${
              feedback.startsWith('导入失败')
                ? 'bg-red-50 text-red-700 border-red-100'
                : 'bg-emerald-50 text-emerald-800 border-emerald-100'
            }`}
          >
            {feedback}
          </div>
        )}

        {/* 书单列表与新建入口 */}
        <div className="p-6 overflow-y-auto flex-1 space-y-4">
          {/* 新建书籍入口卡片 */}
          <div
            onClick={onCreateNewProject}
            className="p-5 border-2 border-dashed border-indigo-300 hover:border-indigo-600 bg-indigo-50/40 hover:bg-indigo-50 rounded-xl cursor-pointer transition-all flex items-center justify-between group shadow-sm"
          >
            <div className="flex items-center space-x-4">
              <div className="w-12 h-12 rounded-xl bg-black text-white flex items-center justify-center font-bold text-xl group-hover:scale-105 transition-transform shadow-md">
                <Plus className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-bold text-slate-900 text-sm flex items-center space-x-2">
                  <span>创建新小说并开启全自动向导</span>
                  <Sparkles className="w-4 h-4 text-indigo-600 animate-pulse" />
                </h3>
                <p className="text-xs text-slate-600 mt-1">
                  只写一段灵感，AI 自动为你推导出书名、简介、人物关系、世界观红线与几十卷拆章梗概！
                </p>
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-indigo-600 transform group-hover:translate-x-1 transition-transform" />
          </div>

          <div className="pt-2">
            <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">
              已有项目列表 ({projects.length})
            </h4>
            <div className="grid grid-cols-1 gap-3">
              {projects.map((proj) => {
                const isActive = proj.id === activeProjectId;
                return (
                  <div
                    key={proj.id}
                    onClick={() => onSelectProject(proj.id)}
                    className={`p-4 rounded-xl cursor-pointer transition-all border flex items-center justify-between ${
                      isActive
                        ? 'bg-indigo-50 border-indigo-600 shadow-md'
                        : 'bg-white hover:bg-slate-50 border-slate-200 hover:border-slate-400'
                    }`}
                  >
                    <div className="flex items-center space-x-3 min-w-0 flex-1">
                      <div
                        className={`w-10 h-10 rounded-lg flex items-center justify-center font-serif font-bold text-base ${
                          isActive
                            ? 'bg-black text-white shadow-md'
                            : 'bg-slate-100 text-slate-700 border border-slate-200'
                        }`}
                      >
                        {(proj.title || '书')[0]}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center space-x-2 flex-wrap gap-y-1">
                          <h5 className="font-bold text-sm text-slate-900 truncate">
                            {proj.title || '无标题小说'}
                          </h5>
                          {isActive && (
                            <span className="text-[10px] bg-indigo-100 text-indigo-800 border border-indigo-300 px-2 py-0.5 rounded-full font-semibold">
                              当前活跃
                            </span>
                          )}
                          {proj.wizardStep && proj.wizardStep !== 'ready' && (
                            <span className="text-[10px] bg-amber-50 text-amber-800 border border-amber-300 px-2 py-0.5 rounded-full font-semibold">
                              孵化中
                            </span>
                          )}
                          <span className="text-[10px] bg-slate-100 text-slate-700 border border-slate-200 px-2 py-0.5 rounded font-medium">
                            {proj.genre || '玄幻'}
                          </span>
                        </div>
                        <p className="text-xs text-slate-600 line-clamp-1 mt-1">
                          {proj.synopsis || '尚未填写的简介梗概...'}
                        </p>
                        <div className="flex items-center space-x-4 text-[11px] text-slate-500 font-mono mt-2">
                          <span>
                            最后修改:{' '}
                            {new Date(proj.lastModified || Date.now()).toLocaleString()}
                          </span>
                          <span>
                            {proj.completedChaptersCount}/{proj.totalChapters} 章 ·{' '}
                            {(proj.totalWords || 0).toLocaleString()} 字
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center space-x-2 ml-4">
                      <button
                        type="button"
                        onClick={(e) => onDeleteProject(proj.id, e)}
                        className="p-2 text-slate-400 hover:text-red-600 hover:bg-slate-100 rounded-lg transition-colors"
                        title="删除该项目"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
              {projects.length === 0 && (
                <div className="p-8 text-center bg-slate-50 border border-slate-200 rounded-xl text-slate-500 text-xs">
                  暂无保存的小说项目，点击上方创建你的第一部神作吧！
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
