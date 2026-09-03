import { useCallback } from 'react';
import type {
  Dispatch,
  MouseEvent,
  MutableRefObject,
  SetStateAction,
} from 'react';
import type { BookProject, BookProjectSummary } from '../types/novel';
import {
  listProjects,
  getProject,
  saveProject,
  deleteProject,
  getActiveProjectId,
  setActiveProjectId,
} from '../services/storage';
import {
  exportProjectAsJson,
  exportProjectAsMarkdown,
  parseProjectImport,
  readFileAsText,
} from '../services/projectTransfer';
import { exportProjectAsEpub } from '../services/epubExport';
import { recoverStyleProfilesFromSnapshots } from '../services/snapshots';
import { mergeStyleConfigPreserve } from '../services/styleImitate';
import {
  initialBook,
  initialCharacters,
  initialSettings,
  initialChapters,
  defaultStyleConfig,
} from '../mockData/initialBook';

export interface UseProjectActionsOptions {
  /** 始终指向最新 project 的 ref（长异步工作流防闭包脏写） */
  projectRef: MutableRefObject<BookProject | null>;
  /** 防止双击并发跑多条工作流的锁 */
  generatingLockRef: MutableRefObject<boolean>;
  /** 当前项目（删除保护用） */
  currentProject: BookProject | null;
  /** 书库摘要列表（删除保护用） */
  projectsList: BookProjectSummary[];
  /** 同步 state + ref 的安全 setter */
  setProjectSafe: (next: BookProject | null) => void;
  setProjectsList: Dispatch<SetStateAction<BookProjectSummary[]>>;
  setActiveChapterId: Dispatch<SetStateAction<string>>;
  setIsWizardOpen: Dispatch<SetStateAction<boolean>>;
  setIsSelectorOpen: Dispatch<SetStateAction<boolean>>;
  setStatusMessage: Dispatch<SetStateAction<string>>;
  setInitError: Dispatch<SetStateAction<string | null>>;
}

/**
 * 项目生命周期 + 导入导出动作域（R1 拆分第二步）。
 *
 * 封装：选书/建书/删书/初始化书库（含空库示例书与记住活跃 ID 恢复）、
 * 文风档案快照找回、打开书时的向导决策（resolveWizardEntry）、
 * JSON/Markdown/EPUB 导出与 .novel.json 导入。
 *
 * 全部函数体自 App.tsx 零改动搬移，仅通过 options 接线依赖。
 */
export function useProjectActions({
  projectRef,
  generatingLockRef,
  currentProject,
  projectsList,
  setProjectSafe,
  setProjectsList,
  setActiveChapterId,
  setIsWizardOpen,
  setIsSelectorOpen,
  setStatusMessage,
  setInitError,
}: UseProjectActionsOptions) {
  /**
   * 是否应进入孵化向导。
   * ready / 空 step = 否；若 step 被误写成非 ready，但书已有完整设定与大纲 → 自动疗愈为 ready。
   */
  const resolveWizardEntry = useCallback(async (loaded: BookProject) => {
    const step = loaded.wizardStep;
    if (!step || step === 'ready') {
      return { project: loaded, incomplete: false };
    }
    const chapters = Array.isArray(loaded.chapters) ? loaded.chapters : [];
    const chars = loaded.characters || [];
    const settings = loaded.settings || [];
    const title = (loaded.title || '').trim();
    const looksFinished =
      title.length > 0 &&
      !title.includes('灵感孵化') &&
      chars.length > 0 &&
      settings.length > 0 &&
      chapters.length > 0 &&
      chapters.some((c) => (c.summary || '').trim().length >= 8);

    if (looksFinished) {
      const healed: BookProject = {
        ...loaded,
        chapters,
        wizardStep: 'ready',
        lastModified: new Date().toISOString(),
      };
      try {
        await saveProject(healed);
      } catch (e) {
        console.warn('疗愈 wizardStep→ready 失败:', e);
      }
      return { project: healed, incomplete: false };
    }
    return { project: { ...loaded, chapters }, incomplete: true };
  }, []);

  /** 进入某本书：同步 state + 记住活跃 ID（下次启动优先恢复） */
  const openProjectInWorkspace = useCallback(
    async (loaded: BookProject, opts?: { openWizardIfIncomplete?: boolean; openSelector?: boolean }) => {
      const { project: resolved, incomplete } = await resolveWizardEntry(loaded);
      const chapters = Array.isArray(resolved.chapters) ? resolved.chapters : [];
      let project = { ...resolved, chapters };

      // 文风档案丢失时尝试从快照找回
      if (!(project.styleConfig?.styleProfiles || []).length) {
        try {
          const recovered = await recoverStyleProfilesFromSnapshots(project.id);
          if (recovered?.styleProfiles?.length) {
            project = {
              ...project,
              styleConfig: mergeStyleConfigPreserve(project.styleConfig, {
                styleProfiles: recovered.styleProfiles,
                activeStyleProfileId: recovered.activeStyleProfileId,
              }),
              lastModified: new Date().toISOString(),
            };
            await saveProject(project);
            setStatusMessage(
              `🎨 已从快照「${recovered.fromSnapshotLabel}」恢复 ${recovered.styleProfiles.length} 条文风仿写`
            );
          }
        } catch (e) {
          console.warn('打开书时文风恢复失败:', e);
        }
      }

      setProjectSafe(project);
      setActiveChapterId(project.currentChapterId || chapters[0]?.id || '');
      await setActiveProjectId(project.id).catch(() => {});
      // 已完成孵化：一律关闭向导进写作台
      if (opts?.openSelector) {
        setIsWizardOpen(false);
        setIsSelectorOpen(true);
      } else if (opts?.openWizardIfIncomplete && incomplete) {
        setIsWizardOpen(true);
        setIsSelectorOpen(false);
      } else {
        setIsWizardOpen(false);
        setIsSelectorOpen(false);
      }
    },
    [setProjectSafe, resolveWizardEntry, setStatusMessage, setActiveChapterId, setIsWizardOpen, setIsSelectorOpen]
  );

  const refreshProjectsList = useCallback(async () => {
    const list = await listProjects();
    setProjectsList(list);
    return list;
  }, [setProjectsList]);

  /** 当前书没有文风档案时，尝试从快照自动找回 */
  const tryRecoverStyleProfiles = useCallback(
    async (project: BookProject, opts?: { silent?: boolean }) => {
      const existing = project.styleConfig?.styleProfiles || [];
      if (existing.length > 0) return project;
      try {
        const recovered = await recoverStyleProfilesFromSnapshots(project.id);
        if (!recovered?.styleProfiles?.length) return project;
        const styleConfig = mergeStyleConfigPreserve(project.styleConfig, {
          styleProfiles: recovered.styleProfiles,
          activeStyleProfileId: recovered.activeStyleProfileId,
        });
        const next: BookProject = {
          ...project,
          styleConfig,
          lastModified: new Date().toISOString(),
        };
        setProjectSafe(next);
        await saveProject(next);
        if (!opts?.silent) {
          setStatusMessage(
            `🎨 已从快照「${recovered.fromSnapshotLabel}」恢复 ${recovered.styleProfiles!.length} 条文风仿写档案`
          );
        }
        return next;
      } catch (e) {
        console.warn('文风档案快照恢复失败:', e);
        return project;
      }
    },
    [setProjectSafe, setStatusMessage]
  );

  const initWorkspace = async () => {
    try {
      setInitError(null);
      let list = await listProjects();

      // 空库：写入示例成书（ready），进入写作台，不进孵化向导
      if (list.length === 0) {
        const defaultProject: BookProject = {
          id: `proj-default-${Date.now()}`,
          title: initialBook.title,
          subtitle: '全自动高阶连载',
          genre: initialBook.genre,
          synopsis: initialBook.synopsis,
          config: {
            inspiration: initialBook.synopsis,
            genre: initialBook.genre,
            targetChapterCount: 100,
            targetWordCountPerChapter: 3000,
            totalChapters: 100,
            wordsPerChapter: 3000,
            writingStyle: '克制严谨、绝不吃书、网文大神黄金节奏',
            customParameters: {},
          },
          wizardStep: 'ready',
          characters: initialCharacters,
          settings: initialSettings,
          volumes: [
            {
              id: 'vol-1',
              number: 1,
              title: '卷一·初入风云',
              summary: '拉开世界帷幕与危机',
              startChapter: 1,
              endChapter: initialChapters.length,
            },
          ],
          chapters: initialChapters,
          currentChapterId: initialChapters[0]?.id || '',
          styleConfig: defaultStyleConfig,
          createdAt: new Date().toISOString(),
          createdDate: new Date().toISOString().slice(0, 10),
          lastModified: new Date().toISOString(),
        };

        await saveProject(defaultProject);
        list = await listProjects();
        setProjectsList(list);
        await openProjectInWorkspace(defaultProject);
        return;
      }

      setProjectsList(list);

      const readyIds = new Set(list.filter((p) => !p.wizardStep || p.wizardStep === 'ready').map((p) => p.id));
      const savedActiveId = await getActiveProjectId().catch(() => null);

      // 选书优先级：记住的活跃书 → 最近修改的已就绪书 → 最近修改任意书
      let pickId =
        (savedActiveId && list.some((p) => p.id === savedActiveId) ? savedActiveId : null) ||
        list.find((p) => readyIds.has(p.id))?.id ||
        list[0]?.id;

      // 若记住的是「孵化中」半成品，但库里还有成书 → 优先打开成书，避免一进门就是孵化向导
      if (pickId && !readyIds.has(pickId) && readyIds.size > 0) {
        pickId = list.find((p) => readyIds.has(p.id))?.id || pickId;
      }

      const loaded = pickId ? await getProject(pickId) : null;
      if (!loaded) {
        // 元数据脏了：退回列表第一本
        const fallback = await getProject(list[0].id);
        if (fallback) {
          const incomplete = Boolean(fallback.wizardStep && fallback.wizardStep !== 'ready');
          await openProjectInWorkspace(fallback, {
            openWizardIfIncomplete: incomplete && readyIds.size === 0,
            openSelector: incomplete && readyIds.size === 0,
          });
        }
        return;
      }

      const incomplete = Boolean(loaded.wizardStep && loaded.wizardStep !== 'ready');
      if (incomplete && readyIds.size === 0) {
        // 全书库都是未完成孵化：先打开书库，点进某一本再进向导（不强制全屏孵化）
        await openProjectInWorkspace(loaded, { openSelector: true });
        setStatusMessage('书架里有未完成的孵化草稿，点选后可继续向导，或新建一本。');
      } else {
        // 有成书则进写作台；半成品不自动弹向导
        await openProjectInWorkspace(loaded, { openWizardIfIncomplete: false });
        if (incomplete) {
          setStatusMessage('当前为孵化中草稿。可在「切换书库」继续向导，或切换到已完成设定的书。');
        }
      }
    } catch (err) {
      console.error('初始化工作区失败:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setInitError(msg || '未知错误');
      setStatusMessage('⚠️ 书库加载失败，请刷新页面或使用「导入备份」。');
    }
  };

  // 切换选中书籍（仅未完成孵化 → 向导；已就绪 / 已疗愈 → 写作台）
  const handleSelectProject = async (id: string) => {
    if (generatingLockRef.current) {
      setStatusMessage('⚠️ 当前章节仍在生成中，请稍后再切换书目。');
      return;
    }
    const loaded = await getProject(id);
    if (loaded) {
      // 先关向导再开书，避免旧 isWizardOpen 残影
      setIsWizardOpen(false);
      await openProjectInWorkspace(loaded, {
        openWizardIfIncomplete: true,
      });
      setIsSelectorOpen(false);
      const step = (projectRef.current || loaded).wizardStep;
      if (!step || step === 'ready') {
        setStatusMessage(`📖 已打开《${loaded.title || '未命名'}》写作台`);
      }
    } else {
      setStatusMessage('⚠️ 无法打开该项目，可能已被删除。正在刷新书库…');
      await refreshProjectsList();
    }
  };

  // 创建新小说开启向导
  const handleCreateNewProject = async () => {
    const newProj: BookProject = {
      id: `proj-${Date.now()}`,
      title: '灵感孵化新书...',
      subtitle: '',
      genre: '玄幻',
      synopsis: '请输入您关于主角、金手指与反转世界的灵感...',
      config: {
        inspiration: '例如：被退婚的主角偶然在废墟捡到了能吸收时光残影的古钟...',
        genre: '修真玄幻',
        targetChapterCount: 150,
        targetWordCountPerChapter: 3500,
        totalChapters: 150,
        wordsPerChapter: 3500,
        writingStyle: '快节奏，悬念层出不穷，爽点密布但绝不低俗',
        customParameters: {},
      },
      wizardStep: 'inspiration',
      characters: [],
      settings: [],
      volumes: [],
      chapters: [],
      styleConfig: defaultStyleConfig,
      createdAt: new Date().toISOString(),
      createdDate: new Date().toISOString().slice(0, 10),
      lastModified: new Date().toISOString(),
    };

    await saveProject(newProj);
    await refreshProjectsList();
    await openProjectInWorkspace(newProj, { openWizardIfIncomplete: true });
    setIsSelectorOpen(false);
  };

  // 删除项目
  const handleDeleteProject = async (id: string, e: MouseEvent) => {
    e.stopPropagation();
    if (projectsList.length <= 1 && currentProject?.id === id) {
      alert('请至少保留一部书籍。');
      return;
    }
    const target = projectsList.find((p) => p.id === id);
    const ok = window.confirm(
      `确定要删除《${target?.title || '这本书'}》吗？\n\n将删除全部正文、人物、设定与大纲，并同步清理磁盘备份，删除后不可恢复。\n建议先「导出 JSON 备份」再删除。`
    );
    if (!ok) return;
    await deleteProject(id);
    // 数据生命周期：同步清理服务端磁盘备份（best-effort，失败不阻断删除）
    try {
      await fetch(`/api/backup?projectId=${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      /* 备份清理失败不阻断项目删除 */
    }
    const updatedList = await listProjects();
    setProjectsList(updatedList);
    if (currentProject?.id === id) {
      const nextId = updatedList[0]?.id;
      if (nextId) {
        handleSelectProject(nextId);
      } else {
        initWorkspace();
      }
    }
  };

  /** 导出当前书 JSON 完整备份（可恢复） */
  const handleExportJson = () => {
    const proj = projectRef.current;
    if (!proj) {
      setStatusMessage('⚠️ 当前无项目可导出');
      return;
    }
    if (generatingLockRef.current) {
      setStatusMessage('⚠️ 生成进行中，请稍后再导出，以免备份到半成品状态。');
      return;
    }
    try {
      const { filename } = exportProjectAsJson(proj);
      setStatusMessage(`✅ 已导出 JSON 备份：${filename}（可完整导入恢复，不含 API Key）`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(`❌ 导出失败：${msg}`);
    }
  };

  /** 导出当前书 Markdown（可读，不可完整反导入） */
  const handleExportMarkdown = () => {
    const proj = projectRef.current;
    if (!proj) {
      setStatusMessage('⚠️ 当前无项目可导出');
      return;
    }
    try {
      const { filename } = exportProjectAsMarkdown(proj);
      setStatusMessage(`✅ 已导出 Markdown：${filename}（完整恢复请用 JSON 备份）`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(`❌ 导出失败：${msg}`);
    }
  };

  /** 导出 EPUB（阅读器用） */
  const handleExportEpub = (approvedOnly = false) => {
    const proj = projectRef.current;
    if (!proj) {
      setStatusMessage('⚠️ 当前无项目可导出');
      return;
    }
    if (generatingLockRef.current) {
      setStatusMessage('⚠️ 生成进行中，请稍后再导出。');
      return;
    }
    try {
      const { filename, chapterCount } = exportProjectAsEpub(proj, { approvedOnly });
      setStatusMessage(
        `✅ 已导出 EPUB：${filename}（${chapterCount} 章${approvedOnly ? '·仅定稿' : ''}）`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(`❌ EPUB 导出失败：${msg}`);
    }
  };

  /**
   * 从 .novel.json / 兼容 JSON 导入为新项目（不覆盖同 ID）。
   * 导入后切换为该书并关闭可能打开的向导（wizard 非 ready 则打开向导）。
   */
  const handleImportFile = async (file: File) => {
    if (generatingLockRef.current) {
      throw new Error('当前章节仍在生成中，请稍后再导入。');
    }
    const text = await readFileAsText(file);
    const { project, warnings } = parseProjectImport(text);
    await saveProject(project);
    await refreshProjectsList();
    await openProjectInWorkspace(project, {
      openWizardIfIncomplete: true,
    });
    setIsSelectorOpen(false);
    const warnText = warnings.length ? ` · 提示：${warnings.slice(0, 2).join('；')}` : '';
    setStatusMessage(
      `✅ 已导入《${project.title}》（${project.chapters.length} 章）并设为当前书${warnText}`
    );
  };

  return {
    initWorkspace,
    openProjectInWorkspace,
    refreshProjectsList,
    tryRecoverStyleProfiles,
    handleSelectProject,
    handleCreateNewProject,
    handleDeleteProject,
    handleExportJson,
    handleExportMarkdown,
    handleExportEpub,
    handleImportFile,
  };
}
