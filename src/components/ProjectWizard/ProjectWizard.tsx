import React, { useEffect, useState } from 'react';
import type { BookProject, ProjectConfig, Character, WorldSetting, Volume, Chapter, WizardStep, StyleProfile, StyleConfig } from '../../types/novel';
import { InspirationStep } from './InspirationStep';
import { TitleReviewStep } from './TitleReviewStep';
import { CharactersReviewStep } from './CharactersReviewStep';
import { WorldReviewStep } from './WorldReviewStep';
import { OutlineReviewStep } from './OutlineReviewStep';
import { generateJSON } from '../../services/llmClient';
import {
  buildTitleAndSynopsisPrompt,
  buildCharactersPrompt,
  buildWorldbuildingPrompt,
  // 保留导出引用，避免热更新残留旧代码调用时 ReferenceError
  buildOutlinePrompt,
} from '../../services/prompts';
import { generateFullOutline, fillPlaceholderChapters } from '../../services/outlineGenerate';
import { saveProject } from '../../services/storage';
import {
  formatStyleStructureForPrompt,
  getActiveStyleProfile,
  importStyleProfile,
  setActiveStyleProfile,
} from '../../services/styleImitate';
import { ArrowLeft, Library, X } from 'lucide-react';
import { WizardStepper } from './WizardStepper';
import { WindowControls } from '../WindowControls';

// 防止 tree-shake 掉 buildOutlinePrompt（兼容热更新残留）
void buildOutlinePrompt;

interface ProjectWizardProps {
  project: BookProject;
  onProjectChange: (updated: BookProject) => void;
  onComplete: (finalProject: BookProject) => void;
  onBackToMenu?: () => void;
  onClose?: () => void;
}

const STEPS_LIST: { step: WizardStep; label: string; short: string; num: number }[] = [
  { step: 'inspiration', label: '1. 灵感与参数', short: '灵感', num: 1 },
  { step: 'title-review', label: '2. 书名与核心简介', short: '书名', num: 2 },
  { step: 'characters-review', label: '3. 核心出场人物', short: '角色', num: 3 },
  { step: 'world-review', label: '4. 世界观与红线铁律', short: '世界观', num: 4 },
  { step: 'outline-review', label: '5. 分卷与拆章梗概', short: '大纲', num: 5 },
];

const VIEW_STEPS: WizardStep[] = [
  'inspiration',
  'title-review',
  'characters-review',
  'world-review',
  'outline-review',
];

/** 已完成孵化：落盘为 ready；浏览某步不得把 ready 写回未完成 */
function isWizardReady(step?: WizardStep | null): boolean {
  return !step || step === 'ready';
}

function initialViewStep(project: BookProject): WizardStep {
  const step = project.wizardStep;
  if (!step || step === 'ready') return 'outline-review';
  if (VIEW_STEPS.includes(step)) return step;
  return 'inspiration';
}

export const ProjectWizard: React.FC<ProjectWizardProps> = ({
  project,
  onProjectChange,
  onComplete,
  onBackToMenu,
  onClose,
}) => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  /** UI 当前页；与 project.wizardStep 分离，避免「已完成」点步骤条把 ready 冲掉 */
  const [viewStep, setViewStep] = useState<WizardStep>(() => initialViewStep(project));

  const persistedReady = isWizardReady(project.wizardStep);
  const currentStep = viewStep;

  // 换书时同步视图步
  useEffect(() => {
    setViewStep(initialViewStep(project));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const updateAndSave = async (updates: Partial<BookProject>) => {
    // 已完成书：禁止无意中把 wizardStep 改回非 ready（除非显式 ready）
    let nextUpdates = { ...updates };
    if (
      persistedReady &&
      nextUpdates.wizardStep &&
      nextUpdates.wizardStep !== 'ready'
    ) {
      const { wizardStep: _drop, ...rest } = nextUpdates;
      nextUpdates = rest;
    }
    const nextProject = {
      ...project,
      ...nextUpdates,
      lastModified: new Date().toISOString(),
    };
    onProjectChange(nextProject);
    await saveProject(nextProject);
    return nextProject;
  };

  /** 切换步骤：未完成书才写 wizardStep 以便下次续孵；已完成只改本地 view */
  const goToStep = (step: WizardStep) => {
    if (!VIEW_STEPS.includes(step)) return;
    setViewStep(step);
    if (!persistedReady) {
      void updateAndSave({ wizardStep: step });
    }
  };

  // Step 1 -> Step 2
  const handleGenerateTitle = async (
    config: ProjectConfig,
    meta?: { styleProfileId?: string | null; profile?: StyleProfile }
  ) => {
    setIsGenerating(true);
    setErrorMsg('');
    setProgressMsg('正在全盘解构你的灵感逻辑，脑暴推导引人入胜的绝佳书名与底层梗概...');
    try {
      const styleBlock = formatStyleStructureForPrompt(
        meta?.profile ?? getActiveStyleProfile(project.styleConfig),
        config.genre
      );
      const prompt = buildTitleAndSynopsisPrompt(config, styleBlock);
      const res = await generateJSON<{
        title: string;
        subtitle: string;
        genre: string;
        synopsis: string;
        hooks: string[];
        coreConflict: string;
      }>(prompt, 0.75);

      // 同步激活选中的文风仿写档案（与引擎页共用 styleProfiles）
      // R3 收尾·文风全局化：选中的是「全局库」档案时复制进新书 styleConfig
      let stylePatch: { styleConfig: StyleConfig } | {} = {};
      if (meta?.styleProfileId && project.styleConfig) {
        const base = project.styleConfig;
        const hasInBook = (base.styleProfiles || []).some(
          (p) => p.id === meta.styleProfileId
        );
        if (hasInBook) {
          stylePatch = {
            styleConfig: setActiveStyleProfile(base, meta.styleProfileId),
          };
        } else if (meta.profile) {
          stylePatch = {
            styleConfig: importStyleProfile(base, meta.profile, {
              activate: true,
              syncFewShot: true,
            }),
          };
        }
      }

      await updateAndSave({
        config,
        title: res.title || '神级异能传',
        subtitle: res.subtitle || '',
        genre: res.genre || config.genre || '玄幻',
        synopsis: res.synopsis || config.inspiration,
        ...stylePatch,
        ...(persistedReady ? {} : { wizardStep: 'title-review' as WizardStep }),
      });
      setViewStep('title-review');
    } catch (err: any) {
      setErrorMsg(err.message || 'AI 推导书名发生错误，请检查网络或 API Key 设置');
    } finally {
      setIsGenerating(false);
    }
  };

  // Step 2 -> Step 3
  const handleGenerateCharacters = async (titleData: {
    title: string;
    subtitle: string;
    genre: string;
    synopsis: string;
    hooks: string[];
    coreConflict: string;
  }) => {
    setIsGenerating(true);
    setErrorMsg('');
    setProgressMsg('正在精心设计立体核心出场人物，埋藏隐藏暗线与绝密性格动机...');
    try {
      await updateAndSave({
        title: titleData.title,
        subtitle: titleData.subtitle,
        genre: titleData.genre,
        synopsis: titleData.synopsis,
      });

      const styleBlock = formatStyleStructureForPrompt(
        getActiveStyleProfile(project.styleConfig),
        titleData.genre || project.genre || project.config.genre
      );
      const prompt = buildCharactersPrompt(project.config, titleData.title, titleData.synopsis, styleBlock);
      const res = await generateJSON<{ characters: Character[] }>(prompt, 0.75);

      await updateAndSave({
        characters: res.characters || [],
        ...(persistedReady ? {} : { wizardStep: 'characters-review' as WizardStep }),
      });
      setViewStep('characters-review');
    } catch (err: any) {
      setErrorMsg(err.message || 'AI 推导人物发生错误');
    } finally {
      setIsGenerating(false);
    }
  };

  // Step 3 -> Step 4
  const handleGenerateWorld = async (updatedChars: Character[]) => {
    setIsGenerating(true);
    setErrorMsg('');
    setProgressMsg('正在推导自洽森严的力量体系、地理势力以及绝不吃书的【绝对约束红线】...');
    try {
      await updateAndSave({ characters: updatedChars });

      const styleBlock = formatStyleStructureForPrompt(
        getActiveStyleProfile(project.styleConfig),
        project.genre || project.config.genre
      );
      const prompt = buildWorldbuildingPrompt(project.config, project.title, project.synopsis, updatedChars, styleBlock);
      const res = await generateJSON<{ settings: WorldSetting[] }>(prompt, 0.7);

      await updateAndSave({
        settings: res.settings || [],
        ...(persistedReady ? {} : { wizardStep: 'world-review' as WizardStep }),
      });
      setViewStep('world-review');
    } catch (err: any) {
      setErrorMsg(err.message || 'AI 推导设定发生错误');
    } finally {
      setIsGenerating(false);
    }
  };

  // Step 4 -> Step 5：分卷骨架 + 分批拆章（对齐目标章数，避免只拆前 30 章）
  const handleGenerateOutline = async (updatedSettings: WorldSetting[]) => {
    setIsGenerating(true);
    setErrorMsg('');
    setProgressMsg('分卷骨架 + 分批拆章进行中（对齐目标章数，可能多轮 API，请稍候）…');
    try {
      await updateAndSave({ settings: updatedSettings });

      // 多轮拆章：volumes → 每批 ≤20 章，勿再用单次 buildOutlinePrompt
      const result = await generateFullOutline({
        config: project.config,
        title: project.title,
        synopsis: project.synopsis,
        characters: project.characters,
        settings: updatedSettings,
        styleConfig: project.styleConfig,
        onProgress: (msg) => setProgressMsg(msg),
      });

      let generatedVolumes = result.volumes;
      let generatedChapters = result.chapters;

      if (generatedChapters.length === 0) {
        const defaultVolId = `vol-${Date.now()}-1`;
        generatedVolumes = [
          {
            id: defaultVolId,
            number: 1,
            title: '第一卷 初入风云',
            summary: '主角崭露头角的开局之路',
            startChapter: 1,
            endChapter: 1,
          },
        ];
        generatedChapters = [
          {
            id: `chap-${Date.now()}-1`,
            number: 1,
            title: '第1章 起手转折',
            summary: project.synopsis || '故事从这里开启',
            wordCount: 0,
            status: '大纲待拆',
            content: '',
            volumeId: defaultVolId,
            volumeNumber: 1,
            involvedCharacterIds: project.characters.map((ch) => ch.id),
            involvedSettingIds: updatedSettings.map((st) => st.id),
            beats: [],
            lastModified: new Date().toISOString(),
          },
        ];
      }

      await updateAndSave({
        volumes: generatedVolumes,
        chapters: generatedChapters,
        currentChapterId: generatedChapters[0]?.id,
        ...(persistedReady ? {} : { wizardStep: 'outline-review' as WizardStep }),
      });
      setViewStep('outline-review');

      if (result.placeholderCount > 0) {
        setErrorMsg(
          `已生成 ${result.chapters.length}/${result.totalTarget} 章骨架；其中 ${result.placeholderCount} 章为占位（标「待补全」），可手改或点「AI 重新规划」重跑失败批次。`
        );
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'AI 拆建大纲发生错误');
    } finally {
      setIsGenerating(false);
    }
  };

  // 第五步内「只补占位章」：保留现有分卷结构与已拆章，仅重写占位章梗概
  const handleFillPlaceholders = async () => {
    setIsGenerating(true);
    setErrorMsg('');
    setProgressMsg('AI 正在为占位章补齐详案梗概（保留现有分卷与拆章结果，多轮 API，请稍候）…');
    try {
      const result = await fillPlaceholderChapters({
        config: project.config,
        title: project.title,
        synopsis: project.synopsis,
        characters: project.characters,
        settings: project.settings,
        styleConfig: project.styleConfig,
        volumes: project.volumes,
        chapters: project.chapters,
        onProgress: (msg) => setProgressMsg(msg),
      });
      // 无损增量：只替换 chapters，不动 volumes / currentChapterId
      await updateAndSave({ chapters: result.chapters });
      if (result.remainingCount > 0) {
        setErrorMsg(
          `占位章补齐：本次成功 ${result.filledCount} 章，还剩 ${result.remainingCount} 章未补齐，可再点一次「AI 补齐占位章梗概」继续。`
        );
      } else {
        setErrorMsg('');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'AI 补齐占位章梗概发生错误');
    } finally {
      setIsGenerating(false);
    }
  };

  // Final confirmation step
  const handleFinishWizard = async (finalVolumes: Volume[], finalChapters: Chapter[]) => {
    // 强制落盘 ready（updateAndSave 对 ready 写入放行）
    const nextProject: BookProject = {
      ...project,
      volumes: finalVolumes,
      chapters: finalChapters,
      currentChapterId: finalChapters[0]?.id || project.currentChapterId,
      wizardStep: 'ready',
      lastModified: new Date().toISOString(),
    };
    onProjectChange(nextProject);
    await saveProject(nextProject);
    setViewStep('outline-review');
    onComplete(nextProject);
  };

  return (
    <div className="h-full flex-1 flex flex-col bg-slate-50 text-slate-900 overflow-hidden select-none">
      {/* 顶部导航与进度指示条 */}
      <header className="h-[48px] bg-white border-b border-slate-200 px-5 flex items-center justify-between shrink-0 select-none app-region-drag z-40 shadow-xs">
        {/* 左侧：返回按钮 + 标题 */}
        <div className="flex items-center space-x-2.5 min-w-0 app-region-no-drag">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg transition-all flex items-center space-x-1 text-xs font-medium border border-slate-200 cursor-pointer shrink-0"
              title="返回工作台（保持当前进度）"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">工作台</span>
            </button>
          )}
          {onBackToMenu && (
            <button
              type="button"
              onClick={onBackToMenu}
              className="p-1.5 text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg transition-all flex items-center space-x-1 text-xs font-medium border border-slate-200 cursor-pointer shrink-0"
              title="打开书库切换作品"
            >
              <Library className="w-3.5 h-3.5 text-slate-500" />
              <span className="hidden sm:inline">书库</span>
            </button>
          )}
          <div className="flex items-center space-x-2 min-w-0">
            <img
              src="/icon.png"
              alt="InkMind"
              className="w-5 h-5 rounded-md object-cover shadow-xs shrink-0"
              onError={(e) => {
                (e.currentTarget as HTMLElement).style.display = 'none';
              }}
            />
            <h1 className="text-xs sm:text-sm font-bold text-slate-900 flex items-center space-x-1.5 truncate">
              <span className="truncate max-w-[130px] sm:max-w-[200px] lg:max-w-[280px]">
                {project.title || '新书孵化'}
              </span>
              <span className="text-slate-400 font-normal">设定向导</span>
            </h1>
            {persistedReady && (
              <span className="hidden xl:inline text-[9.5px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5 rounded font-medium shrink-0">
                已完成孵化
              </span>
            )}
          </div>
        </div>

        {/* 中间：横向步骤指示条 */}
        <div className="flex items-center shrink-0 app-region-no-drag px-2">
          <WizardStepper
            steps={STEPS_LIST}
            currentStep={currentStep}
            allCompleted={persistedReady}
            onStepSelect={goToStep}
          />
        </div>

        {/* 右侧：关闭与桌面端窗口控件 */}
        <div className="flex items-center space-x-2 app-region-no-drag shrink-0">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="hidden sm:flex items-center space-x-1 text-xs text-slate-500 hover:text-slate-800 p-1.5 rounded-lg hover:bg-slate-100 transition-all cursor-pointer"
              title="退出向导（返回工作台）"
            >
              <X size={15} />
            </button>
          )}
          <WindowControls />
        </div>
      </header>

      {/* 错误警告条 */}
      {errorMsg && (
        <div className="max-w-4xl mx-auto mt-4 w-full px-6 shrink-0">
          <div className="bg-red-50 border border-red-300 text-red-800 px-4 py-3 rounded-xl flex items-center justify-between text-sm shadow-md">
            <span>⚠️ {errorMsg}</span>
            <button type="button" onClick={() => setErrorMsg('')} className="font-bold text-red-600 hover:text-red-900 px-2 cursor-pointer">
              ×
            </button>
          </div>
        </div>
      )}

      {/* 步骤页面容器 */}
      <main className="flex-1 overflow-y-auto px-4 pb-12 select-auto">
        {currentStep === 'inspiration' && (
          <InspirationStep
            initialConfig={project.config}
            styleProfiles={project.styleConfig?.styleProfiles || []}
            activeStyleProfileId={project.styleConfig?.activeStyleProfileId}
            styleConfig={project.styleConfig}
            onStyleConfigChange={(sc) => updateAndSave({ styleConfig: sc })}
            onNext={handleGenerateTitle}
            isGenerating={isGenerating}
            progressMsg={progressMsg}
          />
        )}

        {currentStep === 'title-review' && (
          <TitleReviewStep
            data={{
              title: project.title,
              subtitle: project.subtitle,
              genre: project.genre,
              synopsis: project.synopsis,
              hooks: [],
              coreConflict: '在这重重禁忌下，主角必须突破天道法则求生。',
            }}
            onNext={handleGenerateCharacters}
            onPrev={() => goToStep('inspiration')}
            onRegenerate={() => handleGenerateTitle(project.config)}
            isGenerating={isGenerating}
            progressMsg={progressMsg}
          />
        )}

        {currentStep === 'characters-review' && (
          <CharactersReviewStep
            characters={project.characters}
            onNext={handleGenerateWorld}
            onPrev={() => goToStep('title-review')}
            onRegenerate={() =>
              handleGenerateCharacters({
                title: project.title,
                subtitle: project.subtitle,
                genre: project.genre,
                synopsis: project.synopsis,
                hooks: [],
                coreConflict: '',
              })
            }
            isGenerating={isGenerating}
            progressMsg={progressMsg}
          />
        )}

        {currentStep === 'world-review' && (
          <WorldReviewStep
            settings={project.settings}
            onNext={handleGenerateOutline}
            onPrev={() => goToStep('characters-review')}
            onRegenerate={() => handleGenerateWorld(project.characters)}
            isGenerating={isGenerating}
            progressMsg={progressMsg}
          />
        )}

        {currentStep === 'outline-review' && (
          <OutlineReviewStep
            volumes={project.volumes}
            chapters={project.chapters}
            projectConfig={project.config}
            onNext={handleFinishWizard}
            onPrev={() => goToStep('world-review')}
            onRegenerate={() => handleGenerateOutline(project.settings)}
            onFillPlaceholders={handleFillPlaceholders}
            isGenerating={isGenerating}
            progressMsg={progressMsg}
          />
        )}
      </main>
    </div>
  );
};
