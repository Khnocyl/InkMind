/**
 * 文风仿写面板（对齐 InkOS：analyze → import → 写作注入）
 */
import React, { useEffect, useRef, useState } from 'react';
import type { StyleConfig, StyleProfile } from '../../types/novel';
import {
  analyzeReferenceStyle,
  importStyleProfile,
  removeStyleProfile,
  setActiveStyleProfile,
  updateStyleProfile,
} from '../../services/styleImitate';
import { formatFingerprintSummary } from '../../services/styleFingerprint';
import {
  removeGlobalStyleProfile,
  upsertGlobalStyleProfiles,
} from '../../services/styleProfileStore';
import {
  Fingerprint,
  Loader2,
  Sparkles,
  Upload,
  Trash2,
  CheckCircle2,
  Circle,
  PenLine,
} from 'lucide-react';

interface StyleImitatePanelProps {
  styleConfig: StyleConfig;
  /** 支持函数式更新，避免并发改配置时冲掉刚导入的档案；返回 Promise 以便 await 落盘 */
  onUpdateStyleConfig: (
    config: StyleConfig | ((prev: StyleConfig) => StyleConfig)
  ) => Promise<void> | void;
}

export const StyleImitatePanel: React.FC<StyleImitatePanelProps> = ({
  styleConfig,
  onUpdateStyleConfig,
}) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [sampleText, setSampleText] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editGuide, setEditGuide] = useState('');

  const profiles = styleConfig.styleProfiles || [];
  const activeId = styleConfig.activeStyleProfileId || null;

  // R3 收尾·文风全局化：挂载时把本书档案并入全局库（历史档案立即可在新书向导选择）
  useEffect(() => {
    if (profiles.length > 0) {
      upsertGlobalStyleProfiles(profiles);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runAnalyze = async (text: string, sourceLabel: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const { profile, fingerprintOnly } = await analyzeReferenceStyle({
        text,
        name: name.trim() || undefined,
        sourceLabel,
        onProgress: (m) => setMsg(m),
      });
      // R3 收尾：await 持久化，确保「导入 → 立即刷新」也不丢档案
      await onUpdateStyleConfig((prev) =>
        importStyleProfile(prev, profile, {
          activate: true,
          syncFewShot: true,
        })
      );
      // R3 收尾·文风全局化：同步进全局库（新书向导可选）
      upsertGlobalStyleProfiles([profile]);
      setMsg(
        fingerprintOnly
          ? `✅ 已导入「${profile.name}」（指纹启发式，模型指南失败）· 已激活并同步 Few-Shot，已保存到本地`
          : `✅ 已导入「${profile.name}」· 统计指纹 + 风格指南已激活，后续写作自动仿写（已保存）`
      );
      setSampleText('');
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      setMsg(`❌ ${m}`);
    } finally {
      setBusy(false);
    }
  };

  const handleAnalyzePaste = () => {
    if (busy) return;
    void runAnalyze(sampleText, '粘贴样本');
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busy) return;
    try {
      const text = await file.text();
      setSampleText(text.slice(0, 20000));
      setName((n) => n || file.name.replace(/\.[^.]+$/, '').slice(0, 40));
      await runAnalyze(text, file.name);
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      setMsg(`❌ 读文件失败：${m}`);
    }
  };

  const handleActivate = async (id: string | null) => {
    if (busy) return;
    await onUpdateStyleConfig((prev) => setActiveStyleProfile(prev, id));
    setMsg(id ? '已切换激活文风档案（已保存）' : '已关闭文风仿写注入（已保存）');
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('删除该文风档案？写作将不再使用其指纹/指南。')) return;
    await onUpdateStyleConfig((prev) => removeStyleProfile(prev, id));
    // R3 收尾·文风全局化：同步删除全局库
    removeGlobalStyleProfile(id);
    if (editId === id) setEditId(null);
    setMsg('已删除文风档案（已保存）');
  };

  const startEdit = (p: StyleProfile) => {
    setEditId(p.id);
    setEditGuide(p.styleGuide);
  };

  const saveEdit = async () => {
    if (!editId) return;
    await onUpdateStyleConfig((prev) =>
      updateStyleProfile(prev, editId, { styleGuide: editGuide.trim() })
    );
    // R3 收尾·文风全局化：同步更新全局库（取更新后的档案）
    const updated = profiles.find((p) => p.id === editId);
    if (updated) upsertGlobalStyleProfiles([updated]);
    setEditId(null);
    setMsg('风格指南已保存');
  };

  return (
    <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6 space-y-5 shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-3">
        <div className="flex items-center space-x-2.5 min-w-0">
          <div className="p-2 rounded-xl bg-black text-white shrink-0">
            <Fingerprint className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="font-bold text-base text-slate-900 flex items-center gap-2">
              文风仿写
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-800 border border-indigo-200">
                InkOS 式
              </span>
            </h2>
            <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">
              粘贴/导入真人作品片段 → 提取<strong>统计指纹</strong> +{' '}
              <strong>LLM 风格指南</strong> → 激活后写入本章正文与扩写 Prompt（类{' '}
              <code className="text-[10px] bg-slate-200 px-1 rounded">style analyze / import</code>
              ）
            </p>
          </div>
        </div>
        {activeId && (
          <span className="shrink-0 text-[10px] font-bold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-900 border border-emerald-300 flex items-center gap-1">
            <CheckCircle2 size={12} />
            仿写已激活
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-3">
          <label className="block text-xs font-semibold text-slate-700">
            档案名称（可选）
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：番茄爽文·短句 / 某白金作者质感"
              className="mt-1 w-full bg-white border border-slate-300 rounded-xl px-3 py-2 text-sm text-slate-900 focus:border-indigo-600 focus:outline-none"
              disabled={busy}
            />
          </label>
          <label className="block text-xs font-semibold text-slate-700">
            参考正文（建议 800–3000 字）
            <textarea
              value={sampleText}
              onChange={(e) => setSampleText(e.target.value)}
              rows={10}
              placeholder="粘贴要模仿的真人网文/文学片段（不要剧透你自己的大纲）…"
              className="mt-1 w-full bg-white border border-slate-300 rounded-xl p-3 text-sm text-slate-900 font-serif leading-relaxed focus:border-indigo-600 focus:outline-none shadow-inner"
              disabled={busy}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || sampleText.replace(/\s+/g, '').length < 80}
              onClick={handleAnalyzePaste}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-black text-white text-xs font-bold hover:bg-neutral-800 disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              分析并导入仿写
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-300 bg-white text-slate-800 text-xs font-bold hover:bg-slate-100 disabled:opacity-50"
            >
              <Upload className="w-3.5 h-3.5" />
              从 .txt 导入
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.md,text/plain"
              className="hidden"
              onChange={handleFile}
            />
            {activeId && (
              <button
                type="button"
                disabled={busy}
                onClick={() => handleActivate(null)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-600 hover:bg-slate-100"
              >
                关闭仿写
              </button>
            )}
          </div>
          {msg && (
            <p
              className={`text-xs leading-relaxed ${
                msg.startsWith('❌')
                  ? 'text-red-700'
                  : msg.startsWith('✅')
                    ? 'text-emerald-800'
                    : 'text-slate-600'
              }`}
            >
              {msg}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <div className="text-xs font-bold text-slate-700 uppercase tracking-wider">
            已导入档案 ({profiles.length})
          </div>
          {profiles.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-xs text-slate-500">
              尚无文风档案。粘贴样本后点「分析并导入仿写」。
            </div>
          ) : (
            <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
              {profiles.map((p) => {
                const isActive = p.id === activeId;
                return (
                  <div
                    key={p.id}
                    className={`rounded-xl border p-3.5 bg-white transition-all ${
                      isActive
                        ? 'border-indigo-600 shadow-md ring-1 ring-indigo-200'
                        : 'border-slate-200 hover:border-slate-400'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => handleActivate(p.id)}
                        className="flex items-center gap-2 text-left min-w-0"
                      >
                        {isActive ? (
                          <CheckCircle2 className="w-4 h-4 text-indigo-600 shrink-0" />
                        ) : (
                          <Circle className="w-4 h-4 text-slate-400 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="text-sm font-bold text-slate-900 truncate">
                            {p.name}
                            {isActive && (
                              <span className="ml-1.5 text-[10px] font-semibold text-indigo-700">
                                写作中
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 truncate">
                            {p.sourceLabel || '样本'} · {p.fingerprint.charCount} 字 · 均句长{' '}
                            {p.fingerprint.avgSentenceLen}
                          </div>
                        </div>
                      </button>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          title="编辑指南"
                          onClick={() => startEdit(p)}
                          className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-indigo-700"
                        >
                          <PenLine size={14} />
                        </button>
                        <button
                          type="button"
                          title="删除"
                          onClick={() => handleDelete(p.id)}
                          className="p-1.5 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    <p className="mt-2 text-[11px] text-slate-700 leading-relaxed line-clamp-2">
                      <strong className="text-slate-900">要诀：</strong>
                      {p.authorStyle}
                    </p>
                    <pre className="mt-2 text-[10px] text-slate-500 font-mono whitespace-pre-wrap bg-slate-50 border border-slate-100 rounded-lg p-2 max-h-24 overflow-y-auto">
                      {formatFingerprintSummary(p.fingerprint)}
                    </pre>
                    {editId === p.id && (
                      <div className="mt-2 space-y-2">
                        <textarea
                          value={editGuide}
                          onChange={(e) => setEditGuide(e.target.value)}
                          rows={5}
                          className="w-full text-xs border border-slate-300 rounded-lg p-2 focus:border-indigo-600 focus:outline-none"
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={saveEdit}
                            className="text-xs font-bold px-3 py-1.5 rounded-lg bg-black text-white"
                          >
                            保存指南
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditId(null)}
                            className="text-xs px-3 py-1.5 rounded-lg border border-slate-200"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                    {(p.doList?.length > 0 || p.dontList?.length > 0) && editId !== p.id && (
                      <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                        <div className="bg-emerald-50/80 border border-emerald-100 rounded-lg p-2">
                          <div className="font-bold text-emerald-900 mb-1">要做</div>
                          <ul className="list-disc pl-3 text-emerald-900/90 space-y-0.5">
                            {(p.doList || []).slice(0, 4).map((x) => (
                              <li key={x}>{x}</li>
                            ))}
                          </ul>
                        </div>
                        <div className="bg-rose-50/80 border border-rose-100 rounded-lg p-2">
                          <div className="font-bold text-rose-900 mb-1">不要</div>
                          <ul className="list-disc pl-3 text-rose-900/90 space-y-0.5">
                            {(p.dontList || []).slice(0, 4).map((x) => (
                              <li key={x}>{x}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
