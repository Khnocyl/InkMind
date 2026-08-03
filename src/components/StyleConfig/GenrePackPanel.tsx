import React, { useEffect, useMemo, useState } from 'react';
import type { ProjectConfig } from '../../types/novel';
import {
  formatGenrePackForPrompt,
  getGenrePackById,
  listGenrePacks,
  mergePackWithOverride,
  normalizeGenreOverride,
  resolveGenrePack,
  resolveGenrePackForProject,
  type GenrePackOverride,
} from '../../services/genrePacks';
import { Library, RotateCcw, Save } from 'lucide-react';

interface GenrePackPanelProps {
  genre: string;
  config: ProjectConfig;
  onChangeGenre: (genre: string, packId: string) => void;
  /** 保存整包覆盖到 config */
  onSaveOverride?: (packId: string, override: GenrePackOverride | null) => void;
}

function linesToText(arr: string[]): string {
  return (arr || []).join('\n');
}

function textToLines(s: string): string[] {
  return s
    .split('\n')
    .map((x) => x.replace(/^[\d\.、\-\*\s]+/, '').trim())
    .filter(Boolean);
}

export const GenrePackPanel: React.FC<GenrePackPanelProps> = ({
  genre,
  config,
  onChangeGenre,
  onSaveOverride,
}) => {
  const packs = listGenrePacks();
  const packId =
    (config.customParameters?.genrePackId as string | undefined) ||
    resolveGenrePack(genre || config.genre).id;

  const storedOverride = useMemo(
    () => normalizeGenreOverride(config.customParameters?.genrePackOverride),
    [config.customParameters?.genrePackOverride]
  );

  const effective = useMemo(
    () =>
      resolveGenrePackForProject({
        genre: genre || config.genre,
        genrePackId: packId,
        override: storedOverride,
      }),
    [genre, config.genre, packId, storedOverride]
  );

  const basePack = getGenrePackById(packId) || resolveGenrePack(genre);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(effective.name);
  const [description, setDescription] = useState(effective.description);
  const [pacing, setPacing] = useState(effective.pacing);
  const [taboos, setTaboos] = useState(linesToText(effective.taboos));
  const [mustHaves, setMustHaves] = useState(linesToText(effective.mustHaves));
  const [auditHints, setAuditHints] = useState(linesToText(effective.auditHints || []));
  const [extraBlacklist, setExtraBlacklist] = useState(
    linesToText(effective.extraBlacklist || [])
  );
  const [savedHint, setSavedHint] = useState('');

  useEffect(() => {
    setName(effective.name);
    setDescription(effective.description);
    setPacing(effective.pacing);
    setTaboos(linesToText(effective.taboos));
    setMustHaves(linesToText(effective.mustHaves));
    setAuditHints(linesToText(effective.auditHints || []));
    setExtraBlacklist(linesToText(effective.extraBlacklist || []));
  }, [effective]);

  const hasCustom =
    !!storedOverride &&
    Object.keys(storedOverride).some((k) => k !== 'basePackId' && (storedOverride as any)[k]);

  const handleSelectPack = (id: string) => {
    const p = packs.find((x) => x.id === id) || packs[0];
    onChangeGenre(p.name, p.id);
    // 换包时清空旧覆盖（避免串包）
    onSaveOverride?.(p.id, null);
    setEditing(false);
    setSavedHint('已切换题材包，自定义覆盖已清空');
  };

  const handleSave = () => {
    if (!onSaveOverride) return;
    const override: GenrePackOverride = {
      basePackId: packId,
      name: name.trim() || basePack.name,
      description: description.trim(),
      pacing: pacing.trim(),
      taboos: textToLines(taboos),
      mustHaves: textToLines(mustHaves),
      auditHints: textToLines(auditHints),
      extraBlacklist: textToLines(extraBlacklist),
    };
    onSaveOverride(packId, override);
    setEditing(false);
    setSavedHint('✅ 自定义规则已保存，写章时将优先使用');
  };

  const handleReset = () => {
    if (!onSaveOverride) return;
    if (!window.confirm('恢复内置题材包默认规则？当前自定义将被清除。')) return;
    onSaveOverride(packId, null);
    const b = getGenrePackById(packId) || basePack;
    setName(b.name);
    setDescription(b.description);
    setPacing(b.pacing);
    setTaboos(linesToText(b.taboos));
    setMustHaves(linesToText(b.mustHaves));
    setAuditHints(linesToText(b.auditHints || []));
    setExtraBlacklist(linesToText(b.extraBlacklist || []));
    setEditing(false);
    setSavedHint('已恢复内置默认');
  };

  const previewPack = editing
    ? mergePackWithOverride(basePack, {
        basePackId: packId,
        name,
        description,
        pacing,
        taboos: textToLines(taboos),
        mustHaves: textToLines(mustHaves),
        auditHints: textToLines(auditHints),
        extraBlacklist: textToLines(extraBlacklist),
      })
    : effective;

  return (
    <div className="p-6 bg-violet-50 border border-violet-200 rounded-2xl space-y-4 shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-violet-200 pb-3">
        <div className="flex items-center gap-2">
          <Library className="w-5 h-5 text-violet-700" />
          <div>
            <h2 className="text-base font-bold text-slate-900">题材规则包</h2>
            <p className="text-[11px] text-slate-600">
              写入时自动注入。可切换内置包，也可为本项目自定义禁忌与节奏。
            </p>
          </div>
        </div>
        {hasCustom && (
          <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-violet-200 text-violet-900">
            已自定义
          </span>
        )}
      </div>

      <label className="block space-y-1.5 text-xs">
        <span className="font-semibold text-slate-700">选择内置题材包</span>
        <select
          value={packId}
          onChange={(e) => handleSelectPack(e.target.value)}
          className="w-full px-3 py-2 border border-violet-200 rounded-xl bg-white text-sm font-medium"
        >
          {packs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — {p.description.slice(0, 28)}…
            </option>
          ))}
        </select>
      </label>

      {!editing ? (
        <div className="rounded-xl border border-violet-100 bg-white p-4 space-y-3 text-xs">
          <div>
            <div className="font-bold text-violet-900">{effective.name}</div>
            <p className="text-slate-600 mt-1 leading-relaxed">{effective.description}</p>
          </div>
          <div>
            <div className="font-semibold text-slate-800 mb-1">节奏</div>
            <p className="text-slate-600 leading-relaxed">{effective.pacing}</p>
          </div>
          <div>
            <div className="font-semibold text-slate-800 mb-1">禁忌</div>
            <ul className="list-disc pl-4 space-y-0.5 text-slate-700">
              {effective.taboos.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className="font-semibold text-slate-800 mb-1">应具备</div>
            <ul className="list-disc pl-4 space-y-0.5 text-slate-700">
              {effective.mustHaves.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="px-3 py-1.5 rounded-lg bg-black text-white text-[11px] font-bold hover:bg-neutral-800"
            >
              编辑本项目规则
            </button>
            {hasCustom && (
              <button
                type="button"
                onClick={handleReset}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 text-[11px] font-bold hover:bg-slate-50"
              >
                <RotateCcw size={12} />
                恢复默认
              </button>
            )}
          </div>
          <details className="text-[10px] text-slate-500">
            <summary className="cursor-pointer font-semibold text-slate-600">
              查看注入 Prompt 预览
            </summary>
            <pre className="mt-2 p-2 bg-slate-50 rounded-lg whitespace-pre-wrap font-sans leading-relaxed">
              {formatGenrePackForPrompt(effective)}
            </pre>
          </details>
        </div>
      ) : (
        <div className="rounded-xl border border-violet-200 bg-white p-4 space-y-3 text-xs">
          <label className="block space-y-1">
            <span className="font-semibold text-slate-700">显示名称</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg"
            />
          </label>
          <label className="block space-y-1">
            <span className="font-semibold text-slate-700">简介</span>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg leading-relaxed"
            />
          </label>
          <label className="block space-y-1">
            <span className="font-semibold text-slate-700">节奏</span>
            <textarea
              rows={2}
              value={pacing}
              onChange={(e) => setPacing(e.target.value)}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg leading-relaxed"
            />
          </label>
          <label className="block space-y-1">
            <span className="font-semibold text-slate-700">禁忌（每行一条）</span>
            <textarea
              rows={4}
              value={taboos}
              onChange={(e) => setTaboos(e.target.value)}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg font-mono leading-relaxed"
            />
          </label>
          <label className="block space-y-1">
            <span className="font-semibold text-slate-700">应具备（每行一条）</span>
            <textarea
              rows={3}
              value={mustHaves}
              onChange={(e) => setMustHaves(e.target.value)}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg font-mono leading-relaxed"
            />
          </label>
          <label className="block space-y-1">
            <span className="font-semibold text-slate-700">审校额外关注（每行一条）</span>
            <textarea
              rows={2}
              value={auditHints}
              onChange={(e) => setAuditHints(e.target.value)}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg font-mono leading-relaxed"
            />
          </label>
          <label className="block space-y-1">
            <span className="font-semibold text-slate-700">附加黑名单词（每行一条）</span>
            <textarea
              rows={2}
              value={extraBlacklist}
              onChange={(e) => setExtraBlacklist(e.target.value)}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg font-mono leading-relaxed"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleSave}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-black text-white text-[11px] font-bold hover:bg-neutral-800"
            >
              <Save size={12} />
              保存自定义
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 text-[11px] font-bold"
            >
              取消
            </button>
          </div>
          <details className="text-[10px] text-slate-500">
            <summary className="cursor-pointer">预览将注入内容</summary>
            <pre className="mt-2 p-2 bg-slate-50 rounded-lg whitespace-pre-wrap">
              {formatGenrePackForPrompt(previewPack)}
            </pre>
          </details>
        </div>
      )}

      {savedHint && (
        <p className="text-[11px] text-violet-800 font-medium">{savedHint}</p>
      )}
    </div>
  );
};
