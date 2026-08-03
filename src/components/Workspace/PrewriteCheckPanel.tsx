import React, { useMemo, useState } from 'react';
import type {
  Chapter,
  Character,
  ProjectConfig,
  StoryMemory,
  StyleConfig,
  WorldSetting,
} from '../../types/novel';
import type { PreviousContextPack } from '../../services/contextPack';
import {
  buildPrewriteCheckReport,
  overallPrewriteLabel,
  type PrewriteSeverity,
} from '../../services/prewriteCheck';
import {
  ClipboardCheck,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Users,
  Shield,
  BookOpen,
  Palette,
} from 'lucide-react';

interface PrewriteCheckPanelProps {
  chapter: Chapter;
  characters: Character[];
  settings: WorldSetting[];
  styleConfig: StyleConfig;
  previousContextPack?: PreviousContextPack | null;
  projectConfig?: ProjectConfig | null;
  storyMemory?: StoryMemory | null;
}

function sevIcon(sev: PrewriteSeverity) {
  if (sev === 'ok') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />;
  if (sev === 'warn') return <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />;
  return <XCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />;
}

function bannerClass(sev: PrewriteSeverity): string {
  if (sev === 'ok') return 'border-emerald-200 bg-emerald-50';
  if (sev === 'warn') return 'border-amber-200 bg-amber-50';
  return 'border-red-200 bg-red-50';
}

export const PrewriteCheckPanel: React.FC<PrewriteCheckPanelProps> = ({
  chapter,
  characters,
  settings,
  styleConfig,
  previousContextPack,
  projectConfig,
  storyMemory,
}) => {
  const [open, setOpen] = useState(true);
  const [showInject, setShowInject] = useState(false);

  const report = useMemo(
    () =>
      buildPrewriteCheckReport({
        chapter,
        allCharacters: characters,
        allSettings: settings,
        styleConfig,
        previousContextPack: previousContextPack || null,
        projectConfig,
        storyMemory,
      }),
    [chapter, characters, settings, styleConfig, previousContextPack, projectConfig, storyMemory]
  );

  return (
    <div className="p-4 border-b border-slate-200 space-y-2.5 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between"
      >
        <span className="text-xs font-bold text-slate-900 flex items-center space-x-1.5">
          <ClipboardCheck size={14} className="text-teal-600" />
          <span>写前上下文体检</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className={`text-[10px] px-2 py-0.5 rounded-full border font-bold ${
              report.overall === 'ok'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                : report.overall === 'warn'
                  ? 'bg-amber-50 text-amber-900 border-amber-200'
                  : 'bg-red-50 text-red-800 border-red-200'
            }`}
          >
            {overallPrewriteLabel(report.overall)} · {report.score}分
          </span>
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {open && (
        <div className="space-y-2">
          <div className={`rounded-lg border px-2.5 py-2 text-[11px] ${bannerClass(report.overall)}`}>
            <p className="font-semibold text-slate-900 leading-relaxed">
              {report.canWriteSafely
                ? report.overall === 'ok'
                  ? '上下文齐全，建议开写。写前会自动打快照。'
                  : '可以开写，但有警告项，建议扫一眼下方列表。'
                : '存在缺料（红色项）。仍可强行开写，但质量风险高；建议先补梗概/角色/上章记忆。'}
            </p>
          </div>

          <div className="space-y-1 max-h-52 overflow-y-auto pr-0.5">
            {report.items.map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-1.5 px-2 py-1.5 rounded-lg border border-slate-100 bg-slate-50/80 text-[10px]"
              >
                {sevIcon(item.severity)}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-semibold text-slate-800">{item.label}</span>
                  </div>
                  <p className="text-slate-700 leading-relaxed mt-0.5">{item.summary}</p>
                  {item.detail && (
                    <p className="text-slate-500 mt-0.5 leading-relaxed line-clamp-2">{item.detail}</p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* 注入预览 */}
          <button
            type="button"
            onClick={() => setShowInject((v) => !v)}
            className="w-full text-left text-[10px] font-semibold text-teal-800 flex items-center gap-1 hover:underline"
          >
            {showInject ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            查看将注入的内容摘要
          </button>
          {showInject && (
            <div className="rounded-lg border border-teal-100 bg-teal-50/40 p-2.5 space-y-2 text-[10px] text-slate-700">
              <div className="flex items-start gap-1.5">
                <BookOpen size={12} className="text-teal-700 mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold text-slate-900">前情</div>
                  <p className="leading-relaxed">{report.inject.previousPreview}</p>
                </div>
              </div>
              <div className="flex items-start gap-1.5">
                <Users size={12} className="text-indigo-600 mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold text-slate-900">角色</div>
                  <p>
                    {report.inject.characterNames.length
                      ? report.inject.characterNames.join('、')
                      : '（无关联）'}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-1.5">
                <Shield size={12} className="text-amber-600 mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold text-slate-900">设定 / 硬规则</div>
                  <p>
                    {report.inject.settingNames.length
                      ? `${report.inject.settingNames.join('、')} · ${report.inject.hardRuleCount} 条硬规则`
                      : '（无关联）'}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-1.5">
                <Palette size={12} className="text-purple-600 mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold text-slate-900">文风</div>
                  <p>
                    范例：{report.inject.styleExampleTitle || '未选'} · 黑名单{' '}
                    {report.inject.blacklistCount} ·{' '}
                    {report.inject.enforceShowDontTell ? 'SdT开' : 'SdT关'} ·{' '}
                    {report.inject.forbidEndingSublimation ? '禁升华' : '允许升华'}
                    {report.inject.targetWords
                      ? ` · 目标约${report.inject.targetWords}字`
                      : ''}
                  </p>
                </div>
              </div>
              <div>
                <div className="font-semibold text-slate-900 mb-0.5">本章梗概预览</div>
                <p className="leading-relaxed text-slate-600 bg-white border border-slate-100 rounded px-2 py-1">
                  {report.inject.chapterSummaryPreview}
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/** 供开写按钮使用：是否需二次确认 */
export function shouldConfirmPrewrite(
  chapter: Chapter,
  characters: Character[],
  settings: WorldSetting[],
  styleConfig: StyleConfig,
  pack: PreviousContextPack | null,
  projectConfig?: ProjectConfig | null,
  storyMemory?: StoryMemory | null
): { needConfirm: boolean; message: string; report: ReturnType<typeof buildPrewriteCheckReport> } {
  const report = buildPrewriteCheckReport({
    chapter,
    allCharacters: characters,
    allSettings: settings,
    styleConfig,
    previousContextPack: pack,
    projectConfig,
    storyMemory,
  });
  if (report.canWriteSafely && report.overall === 'ok') {
    return { needConfirm: false, message: '', report };
  }
  const lines = report.issues
    .filter((i) => i.severity === 'error' || i.severity === 'warn')
    .slice(0, 6)
    .map((i) => `· [${i.severity === 'error' ? '缺料' : '警告'}] ${i.title}：${i.detail}`);
  const message = report.canWriteSafely
    ? `写前体检有警告（${report.score}分），仍要开写吗？\n\n${lines.join('\n')}`
    : `写前体检发现缺料（${report.score}分），强行开写质量风险高。仍要继续吗？\n\n${lines.join('\n')}`;
  return {
    needConfirm: true,
    message,
    report,
  };
}
