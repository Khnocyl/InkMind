import React, { useState, useRef, useEffect } from 'react';
import {
  X,
  FileText,
  Link2,
  Loader2,
  Play,
  Square,
  Copy,
  Check,
  BookOpen,
  ListChecks,
  RefreshCw,
} from 'lucide-react';
import {
  splitChapters,
  createTemplateProject,
  deconstructChapterLLM,
  synthesizeBookLLM,
  applyCharacterIdMapping,
  formatDeconstructReport,
  fetchArticleViaServer,
  extractChapterLinks,
  extractMainText,
  extractPageTitle,
  saveDeconstructJob,
  deleteDeconstructJob,
  listDeconstructJobs,
  type SplitChapter,
  type DeconstructJob,
} from '../../services/bookDeconstruct';
import { isGenerationAborted } from '../../services/llmResilience';
import { loadProject, saveProject, getAllProjects } from '../../services/storage';
import type { BookProject, BookProjectSummary } from '../../types/novel';

type Step = 'select' | 'preview' | 'running' | 'synthesizing' | 'done';

/** 章节目录页逐章抓取的礼貌间隔（毫秒） */
const TOC_FETCH_DELAY_MS = 2000;

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort);
  });
}

interface DeconstructModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 拆解完成后打开模板书（App 侧用 handleSelectProject） */
  onFinished?: (projectId: string) => void;
}

/**
 * 拆书工作台：导入成品小说（本地 TXT/MD 或 URL 抓取）→ 切章预览 → 逐章拆解
 * → 全书综合 → 模板书 + 拆解报告。
 * 只做站点无关的中性抓取（server 端收紧版 SSRF 校验），不内置站点适配。
 */
export const DeconstructModal: React.FC<DeconstructModalProps> = ({
  isOpen,
  onClose,
  onFinished,
}) => {
  const [step, setStep] = useState<Step>('select');
  const [splits, setSplits] = useState<SplitChapter[]>([]);
  const [sourceMode, setSourceMode] = useState<'file' | 'url'>('file');
  const [sourceName, setSourceName] = useState('');

  // URL 导入
  const [urlInput, setUrlInput] = useState('');
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlMsg, setUrlMsg] = useState<string | null>(null);
  const [tocLinks, setTocLinks] = useState<{ url: string; title: string }[]>([]);
  const [tocProgress, setTocProgress] = useState<{ done: number; total: number } | null>(null);
  /** 预览页顶部提示（如「抓取被停止，仅保留前 N 章」） */
  const [previewNotice, setPreviewNotice] = useState<string | null>(null);

  // 断点续跑列表
  const [jobs, setJobs] = useState<DeconstructJob[]>([]);
  /**
   * 已存在的模板书（含拆解已完成、任务索引已删的）。
   * 拆解报告此前**只在流程末尾渲染一次**，关掉弹窗即失联——想再看只能重跑整本
   * （几千次 LLM 调用）。报告是纯函数派生数据，这里让它可零成本重新查看。
   */
  const [doneBooks, setDoneBooks] = useState<BookProjectSummary[]>([]);

  // 运行态
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0 });
  const [currentTitle, setCurrentTitle] = useState('');
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [report, setReport] = useState('');
  const [copied, setCopied] = useState(false);
  const [finishedTitle, setFinishedTitle] = useState('');
  const [finishedProjectId, setFinishedProjectId] = useState('');
  /** 逐章拆解完成但全书综合失败：done 步需如实提示，不能显示「✅ 拆解完成」 */
  const [synthesisFailed, setSynthesisFailed] = useState(false);
  /** URL 抓取页面的 <title>，作为模板书初始标题（综合后由模型推断书名覆盖） */
  const [pageTitle, setPageTitle] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  /** 同步运行锁：防双击并发启动两条拆解循环（state 判据在同一事件循环内不可靠） */
  const runLockRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setStep('select');
    setSplits([]);
    setUrlMsg(null);
    setTocLinks([]);
    setTocProgress(null);
    setPreviewNotice(null);
    setReport('');
    setCopied(false);
    setSynthesisFailed(false);
    setPageTitle('');
    setProgress({ done: 0, total: 0, failed: 0 });
    let alive = true;
    listDeconstructJobs()
      .then((list) => {
        if (alive) setJobs(list.filter((j) => !(j.done >= j.total && j.synthesisDone)));
      })
      .catch(() => setJobs([]));
    getAllProjects()
      .then((list) => {
        if (alive) setDoneBooks(list.filter((p) => p.isDeconstruct));
      })
      .catch(() => setDoneBooks([]));
    return () => {
      alive = false;
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  // ── 输入源 ────────────────────────────────────────────────────────────

  const handleFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setUrlMsg(null);
      const raw = await file.text();
      const result = splitChapters(raw);
      if (!result.length) {
        setUrlMsg('文件为空或无法切分出任何章节');
        return;
      }
      setSourceMode('file');
      setSourceName(file.name);
      setPreviewNotice(null);
      setSplits(result);
      setStep('preview');
    } catch (err) {
      setUrlMsg(`读取文件失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const runWithBusy = async (fn: () => Promise<void>) => {
    if (urlBusy) return;
    setUrlBusy(true);
    setUrlMsg(null);
    try {
      await fn();
    } catch (err) {
      setUrlMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setUrlBusy(false);
    }
  };

  const handleFetchSingle = () =>
    runWithBusy(async () => {
      const page = await fetchArticleViaServer(urlInput.trim());
      const text = extractMainText(page.html);
      if (text.length < 200) {
        throw new Error('正文提取结果过短——页面可能是目录页或需要选择器，可尝试目录页模式');
      }
      const firstLine = text.split('\n').find((l) => l.trim())?.trim() || '';
      const htmlTitle = extractPageTitle(page.html);
      setPageTitle(htmlTitle);
      setSourceMode('url');
      setSourceName(page.finalUrl);
      setPreviewNotice(null);
      setSplits([
        {
          title: firstLine.length <= 40 ? firstLine : htmlTitle || page.finalUrl.slice(-40),
          content: text,
          charCount: text.replace(/\s/g, '').length,
        },
      ]);
      setStep('preview');
    });

  const handleFetchToc = () =>
    runWithBusy(async () => {
      const page = await fetchArticleViaServer(urlInput.trim());
      const links = extractChapterLinks(page.html, page.finalUrl);
      if (!links.length) {
        throw new Error('目录页中未识别出「第N章 / Chapter N」形态的链接——该站点结构不受支持');
      }
      setPageTitle(extractPageTitle(page.html));
      setSourceMode('url');
      setSourceName(page.finalUrl);
      setTocLinks(links);
    });

  const handleFetchAllTocChapters = () =>
    runWithBusy(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      const out: SplitChapter[] = [];
      let stopped = false;
      try {
        for (let i = 0; i < tocLinks.length; i += 1) {
          setTocProgress({ done: i, total: tocLinks.length });
          try {
            const page = await fetchArticleViaServer(tocLinks[i].url, controller.signal);
            const text = extractMainText(page.html);
            out.push({
              title: tocLinks[i].title,
              content: text,
              charCount: text.replace(/\s/g, '').length,
            });
          } catch (err) {
            if (isGenerationAborted(err) || controller.signal.aborted) throw new Error('已停止抓取');
            // 单章失败跳过并留痕，不中断整本。
            // failed: true 标记它只是「预览里的失败提示」——绝不能被当成正文
            // 进模板书或送 LLM 拆解（否则白烧调用并产出垃圾章节）。
            out.push({
              title: tocLinks[i].title,
              content: `【抓取失败：${err instanceof Error ? err.message : String(err)}】`,
              charCount: 0,
              failed: true,
            });
          }
          await abortableSleep(TOC_FETCH_DELAY_MS, controller.signal).catch(() => {
            throw new Error('已停止抓取');
          });
        }
      } catch (err) {
        // 用户点了「停止抓取」：已抓到的部分**保留**并进入预览。
        // 此前直接抛出会把十几分钟的抓取结果全丢掉。
        if (!out.length) throw err;
        stopped = true;
      } finally {
        // 无论完成/失败/被停止都要收掉进度与「停止抓取」按钮
        setTocProgress(null);
      }
      if (!out.length) throw new Error('未抓到任何章节');
      setPreviewNotice(
        stopped
          ? `抓取已停止：仅保留已抓到的 ${out.length} 章（目录页共识别 ${tocLinks.length} 章）`
          : null
      );
      setSplits(out);
      setStep('preview');
    });

  // ── 拆解运行 ──────────────────────────────────────────────────────────

  const runDeconstruct = async (project: BookProject) => {
    // 同步互斥闸门（防双击/重复点「继续」）：running 是 state，同一事件循环内
    // 的第二次调用会读到旧值而双双通过；第二次还会覆盖 abortRef.current，
    // 使第一个循环的 controller 失去引用——停不掉、且两条循环并发写同一项目。
    if (runLockRef.current) return;
    runLockRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    const pendingTotal = project.chapters.filter((c) => !c.deconstruct).length;
    setStep('running');
    setProgress({ done: project.chapters.length - pendingTotal, total: project.chapters.length, failed: 0 });
    setRunMsg(null);

    // 已知人物名从**已拆章节**里回灌：断点续跑时此前从空开始，导致续跑的
    // 逐章 prompt 丢失「前文已出现人物」上下文，前后拆解口径不一致。
    const known: string[] = [];
    for (const c of project.chapters) {
      for (const n of c.deconstruct?.characterNames || []) {
        if (!known.includes(n)) known.push(n);
      }
    }
    let failed = 0;
    let aborted = false;

    for (const ch of project.chapters) {
      if (ch.deconstruct) continue;
      if (controller.signal.aborted) {
        aborted = true;
        break;
      }
      setCurrentTitle(ch.title);
      try {
        const result = await deconstructChapterLLM({
          chapterNumber: ch.number,
          chapterTitle: ch.title,
          content: ch.content,
          knownCharacters: known,
          signal: controller.signal,
        });
        ch.summary = result.summary;
        ch.beats = result.beats;
        ch.deconstruct = {
          hookType: result.hookType,
          hookStrength: result.hookStrength,
          payoffType: result.payoffType,
          emotion: result.emotion,
          foreshadowPlant: result.foreshadowPlant,
          foreshadowPayoff: result.foreshadowPayoff,
          newSettings: result.newSettings,
          characterNames: result.characterNames,
          analyzedAt: result.analyzedAt,
        };
        for (const n of result.characterNames || []) {
          if (!known.includes(n)) known.push(n);
        }
      } catch (err) {
        if (isGenerationAborted(err) || controller.signal.aborted) {
          aborted = true;
          break;
        }
        failed += 1;
        ch.deconstruct = undefined; // 失败章保持待拆，下次继续
        setRunMsg(`第${ch.number}章拆解失败：${err instanceof Error ? err.message : String(err)}`);
      }
      setProgress((prev) => ({
        done: prev.done + 1,
        total: project.chapters.length,
        failed,
      }));
      // 每章即存（函数式落盘交给 saveProject 的事务；半途中断已有进度不丢）
      try {
        await saveProject(project);
        await saveDeconstructJob({
          projectId: project.id,
          title: project.title,
          done: project.chapters.filter((c) => c.deconstruct).length,
          total: project.chapters.length,
          synthesisDone: false,
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        setRunMsg(`落盘失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (aborted) {
      runLockRef.current = false;
      setCurrentTitle('');
      setRunMsg('已停止——已拆章节已保存，可随时在拆书工作台继续');
      setStep('select');
      return;
    }

    // ── 全书综合 ──
    setStep('synthesizing');
    let synthesisOk = false;
    try {
      const synthesis = await synthesizeBookLLM({
        bookTitle: project.title,
        chapters: project.chapters,
        signal: controller.signal,
      });
      project.characters = synthesis.characters;
      project.settings = synthesis.settings;
      if (synthesis.genre) project.genre = synthesis.genre;
      // 模型从内容推断出书名 → 覆盖初始的「页面标题/文件名」标题
      if (synthesis.suggestedTitle) project.title = synthesis.suggestedTitle;
      if (synthesis.synopsis) {
        project.synopsis = synthesis.synopsis;
        project.config.inspiration = synthesis.synopsis;
      }
      applyCharacterIdMapping(project);
      if (project.deconstructMeta) project.deconstructMeta.synthesisDone = true;
      synthesisOk = true;
    } catch (err) {
      setRunMsg(
        `全书综合失败（可稍后重跑）：${err instanceof Error ? err.message : String(err)}`
      );
    }
    try {
      await saveProject(project);
    } catch {
      /* 已在逐章保存过，综合失败不阻塞报告 */
    }
    // 任务索引只在综合**成功**时删除：此前无条件删除，而综合失败时提示
    // 「可稍后重跑」——索引已没了、又不存在单独重跑综合的入口，等于承诺落空。
    // 保留索引 → 该任务留在「未完成的拆解」列表，点「继续」即会重新走综合。
    if (synthesisOk) {
      await deleteDeconstructJob(project.id).catch(() => {});
    } else {
      await saveDeconstructJob({
        projectId: project.id,
        title: project.title,
        done: project.chapters.filter((c) => c.deconstruct).length,
        total: project.chapters.length,
        synthesisDone: false,
        updatedAt: new Date().toISOString(),
      }).catch(() => {});
      setJobs((prev) => {
        const rest = prev.filter((j) => j.projectId !== project.id);
        return [
          ...rest,
          {
            projectId: project.id,
            title: project.title,
            done: project.chapters.filter((c) => c.deconstruct).length,
            total: project.chapters.length,
            synthesisDone: false,
            updatedAt: new Date().toISOString(),
          },
        ];
      });
    }

    runLockRef.current = false;
    setSynthesisFailed(!synthesisOk);
    setFinishedTitle(project.title);
    setFinishedProjectId(project.id);
    setReport(formatDeconstructReport(project));
    setProgress((prev) => ({ ...prev, failed }));
    setStep('done');
  };

  const handleConfirmSplits = async () => {
    if (runLockRef.current) {
      setPreviewNotice('已有一次拆解正在进行，请等它结束或先停止。');
      return;
    }
    // 排除抓取失败的占位章：它们没有正文，进模板书会变成垃圾章节，
    // 还会被逐章送 LLM 拆解（白烧调用）。
    const failedCount = splits.filter((s) => s.failed).length;
    const usable = splits.filter((s) => !s.failed && (s.charCount > 0 || s.content.trim()));
    if (!usable.length) {
      // 不能静默 return：过滤后为空时用户点了「开始拆解」却毫无反应
      setPreviewNotice(
        failedCount > 0
          ? `没有可拆解的内容：${failedCount} 章全部抓取失败，请重新抓取。`
          : '没有可拆解的内容：章节正文均为空。'
      );
      return;
    }
    // 规模确认：拆解是逐章 LLM 调用，几百上千章会产生同量级的费用与耗时
    if (usable.length >= 50) {
      const totalWords = usable.reduce((a, s) => a + s.charCount, 0);
      const ok = window.confirm(
        `将对 ${usable.length} 章（约 ${totalWords.toLocaleString()} 字）逐章调用 LLM 拆解。\n` +
          `每章 1 次 API 调用，合计约 ${usable.length} 次，耗时与费用可能较高。\n` +
          (failedCount > 0 ? `\n（已跳过 ${failedCount} 章抓取失败的内容）\n` : '') +
          `\n建议先导出备份。继续？`
      );
      if (!ok) return;
    }
    // 初始标题：URL 模式用页面 <title>；文件模式用去掉扩展名的文件名。
    // 综合完成后会用模型推断的书名覆盖（见 runDeconstruct）。
    const suggestedTitle =
      sourceMode === 'url'
        ? pageTitle || undefined
        : sourceName.replace(/\.(txt|md)$/i, '') || undefined;
    const template = createTemplateProject({
      splits: usable,
      source: sourceMode === 'file' ? 'file' : 'url',
      sourceName,
      suggestedTitle,
    });
    try {
      await saveProject(template);
      await saveDeconstructJob({
        projectId: template.id,
        title: template.title,
        done: 0,
        total: template.chapters.length,
        synthesisDone: false,
        updatedAt: new Date().toISOString(),
      });
      await runDeconstruct(template);
    } catch (err) {
      setUrlMsg(`创建模板书失败：${err instanceof Error ? err.message : String(err)}`);
      setStep('select');
    }
  };

  const handleResumeJob = async (job: DeconstructJob) => {
    const project = await loadProject(job.projectId);
    if (!project) {
      setUrlMsg('找不到该模板书（可能已被删除）');
      await deleteDeconstructJob(job.projectId).catch(() => {});
      setJobs((prev) => prev.filter((j) => j.projectId !== job.projectId));
      return;
    }
    await runDeconstruct(project);
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  /**
   * 重新查看已存在模板书的拆解报告。
   * `formatDeconstructReport` 是纯函数，重算**零 LLM 调用**——所以「再看一次报告」
   * 不该要求用户重跑整本拆解。
   */
  const handleViewReport = async (summary: BookProjectSummary) => {
    const project = await loadProject(summary.id);
    if (!project) {
      setUrlMsg('找不到该模板书（可能已被删除）');
      setDoneBooks((prev) => prev.filter((p) => p.id !== summary.id));
      return;
    }
    setFinishedTitle(project.title);
    setFinishedProjectId(project.id);
    setSynthesisFailed(!project.deconstructMeta?.synthesisDone);
    setReport(formatDeconstructReport(project));
    setStep('done');
  };

  const handleCopyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  };

  // ── 渲染 ──────────────────────────────────────────────────────────────

  return (
    <div
      data-modal-backdrop="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-fadeIn app-region-no-drag select-auto modal-backdrop-layer"
    >
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        <div className="p-6 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-black flex items-center justify-center">
              <BookOpen className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">拆书工作台</h2>
              <p className="text-xs text-slate-600">
                导入成品小说 → 反推细纲/人物/设定/节奏，产出可参照的模板书（仅限个人学习分析）
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

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {step === 'select' && (
            <>
              {jobs.length > 0 && (
                <div className="border border-amber-200 bg-amber-50 rounded-xl p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-bold text-amber-800">
                    <RefreshCw className="w-4 h-4" /> 未完成的拆解
                  </div>
                  {jobs.map((j) => (
                    <div
                      key={j.projectId}
                      className="flex items-center justify-between gap-2 text-sm bg-white rounded-lg px-3 py-2 border border-amber-100"
                    >
                      <span className="truncate text-slate-700">
                        {j.title}（{j.done}/{j.total} 章
                        {!j.synthesisDone ? '，待综合' : ''}）
                      </span>
                      <button
                        onClick={() => void handleResumeJob(j)}
                        className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg border border-black bg-black text-white hover:bg-neutral-800"
                      >
                        继续
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {doneBooks.length > 0 && (
                <div className="border border-slate-200 bg-slate-50 rounded-xl p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-bold text-slate-700">
                    <BookOpen className="w-4 h-4" /> 已完成的拆解
                  </div>
                  {doneBooks.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between gap-2 text-sm bg-white rounded-lg px-3 py-2 border border-slate-100"
                    >
                      <span className="truncate text-slate-700">
                        {p.title}（{p.totalWords.toLocaleString()} 字）
                      </span>
                      <button
                        onClick={() => void handleViewReport(p)}
                        className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:border-slate-400"
                      >
                        查看报告
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => setSourceMode('file')}
                  className={`flex-1 p-3 rounded-xl border text-sm font-semibold transition-colors ${
                    sourceMode === 'file'
                      ? 'border-black bg-black text-white'
                      : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'
                  }`}
                >
                  本地 TXT / MD 文件
                </button>
                <button
                  onClick={() => setSourceMode('url')}
                  className={`flex-1 p-3 rounded-xl border text-sm font-semibold transition-colors ${
                    sourceMode === 'url'
                      ? 'border-black bg-black text-white'
                      : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'
                  }`}
                >
                  URL 抓取（单章 / 目录页）
                </button>
              </div>

              {sourceMode === 'file' ? (
                <div className="border-2 border-dashed border-slate-300 rounded-xl p-6 text-center">
                  <FileText className="w-8 h-8 mx-auto text-slate-400" />
                  <p className="mt-2 text-sm text-slate-600">
                    导入整本 TXT / MD（按「第N章 / Chapter N」自动切章，导入后可预览修正）
                  </p>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-3 text-xs font-semibold px-4 py-2 rounded-lg border border-black bg-black text-white hover:bg-neutral-800"
                  >
                    选择文件
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.md,text/plain"
                    className="hidden"
                    onChange={(e) => void handleFilePicked(e)}
                  />
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <div className="flex-1 flex items-center gap-2 border border-slate-200 rounded-xl px-3">
                      <Link2 className="w-4 h-4 text-slate-400 shrink-0" />
                      <input
                        value={urlInput}
                        onChange={(e) => setUrlInput(e.target.value)}
                        placeholder="https://…（章节页或目录页 URL）"
                        className="flex-1 py-2.5 text-sm outline-none bg-transparent"
                      />
                    </div>
                    <button
                      disabled={urlBusy || !urlInput.trim()}
                      onClick={() => void handleFetchSingle()}
                      className="text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:border-slate-400 disabled:opacity-50"
                    >
                      抓单章
                    </button>
                    <button
                      disabled={urlBusy || !urlInput.trim()}
                      onClick={() => void handleFetchToc()}
                      className="text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:border-slate-400 disabled:opacity-50"
                    >
                      识别目录
                    </button>
                  </div>
                  {tocLinks.length > 0 && (
                    <div className="border border-slate-200 rounded-xl p-3 space-y-2">
                      <div className="flex items-center justify-between text-xs text-slate-600">
                        <span>
                          识别出 {tocLinks.length} 个章节链接（按 2 秒/章礼貌抓取）
                          {tocProgress ? ` · ${tocProgress.done}/${tocProgress.total}` : ''}
                        </span>
                        <div className="flex items-center gap-2">
                          {/* 批量抓取按 2s/章串行，几百章要十几分钟——此前没有停止入口，
                              只能关弹窗中止。这里补一个与「停止」同语义的中断按钮。 */}
                          {tocProgress && (
                            <button
                              onClick={handleStop}
                              className="font-semibold px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:border-red-400 hover:text-red-600"
                            >
                              停止抓取
                            </button>
                          )}
                          <button
                            disabled={urlBusy}
                            onClick={() => void handleFetchAllTocChapters()}
                            className="font-semibold px-3 py-1.5 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
                          >
                            抓取全部
                          </button>
                        </div>
                      </div>
                      <div className="max-h-32 overflow-y-auto text-xs text-slate-500 space-y-1">
                        {tocLinks.slice(0, 50).map((l) => (
                          <div key={l.url} className="truncate">
                            {l.title}
                          </div>
                        ))}
                        {tocLinks.length > 50 && <div>…（共 {tocLinks.length} 条）</div>}
                      </div>
                    </div>
                  )}
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    仅支持可公开访问的 http(s) 页面；工具不内置任何站点适配，无法处理需要登录/付费的页面。
                    请仅抓取你有权访问的内容，并遵守目标站点条款。
                  </p>
                </div>
              )}

              {urlBusy && (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Loader2 className="w-4 h-4 animate-spin" /> 正在抓取…
                </div>
              )}
              {urlMsg && <p className="text-sm text-red-600">{urlMsg}</p>}
            </>
          )}

          {step === 'preview' && (
            <>
              {previewNotice && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  {previewNotice}
                </div>
              )}
              <div className="flex items-center justify-between">
                <div className="text-sm text-slate-700">
                  识别出 <b>{splits.filter((s) => !s.failed).length}</b> 章 · 共{' '}
                  {splits
                    .filter((s) => !s.failed)
                    .reduce((a, s) => a + s.charCount, 0)
                    .toLocaleString()}{' '}
                  字 —— 可修改标题后开始拆解
                  {splits.some((s) => s.failed) && (
                    <span className="text-amber-600">
                      （{splits.filter((s) => s.failed).length} 章抓取失败，将跳过）
                    </span>
                  )}
                </div>
                <button
                  onClick={() => void handleConfirmSplits()}
                  className="text-xs font-semibold px-4 py-2 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 inline-flex items-center gap-1.5"
                >
                  <Play className="w-3.5 h-3.5" /> 开始拆解
                </button>
              </div>
              <div className="border border-slate-200 rounded-xl divide-y divide-slate-100 max-h-[45vh] overflow-y-auto">
                {splits.map((s, i) => (
                  <div key={i} className="p-3 flex items-center gap-2">
                    <span className="text-xs text-slate-400 w-8 shrink-0 text-right">
                      {i + 1}
                    </span>
                    <input
                      value={s.title}
                      onChange={(e) => {
                        const next = [...splits];
                        next[i] = { ...s, title: e.target.value };
                        setSplits(next);
                      }}
                      className="flex-1 text-sm px-2 py-1 border border-transparent hover:border-slate-200 focus:border-slate-400 rounded-lg outline-none"
                    />
                    <span
                      className={`text-xs shrink-0 ${
                        s.failed ? 'text-amber-600' : 'text-slate-400'
                      }`}
                    >
                      {s.failed ? '抓取失败 · 跳过' : `${s.charCount.toLocaleString()} 字`}
                    </span>
                    <button
                      onClick={() => setSplits(splits.filter((_, j) => j !== i))}
                      className="text-xs text-slate-400 hover:text-red-600 shrink-0 px-1"
                      title="删除本章（不拆不导）"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {step === 'running' && (
            <div className="space-y-4 py-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <ListChecks className="w-4 h-4" /> 逐章拆解中：{progress.done}/
                  {progress.total}
                  {progress.failed > 0 && (
                    <span className="text-amber-600">（失败 {progress.failed}）</span>
                  )}
                </div>
                <button
                  onClick={handleStop}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:border-red-400 hover:text-red-600 inline-flex items-center gap-1.5"
                >
                  <Square className="w-3.5 h-3.5" /> 停止
                </button>
              </div>
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-black transition-all duration-300"
                  style={{
                    width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
                  }}
                />
              </div>
              {currentTitle && (
                <p className="text-xs text-slate-500 truncate">正在拆：{currentTitle}</p>
              )}
              {runMsg && <p className="text-xs text-amber-600">{runMsg}</p>}
              <p className="text-[11px] text-slate-400">
                每拆完一章即自动保存；中途停止/关机后可回到本工作台继续，已完成章节不会重拆。
              </p>
            </div>
          )}

          {step === 'synthesizing' && (
            <div className="py-10 text-center space-y-2">
              <Loader2 className="w-6 h-6 animate-spin mx-auto text-slate-400" />
              <p className="text-sm text-slate-600">全书综合中：归并人物卡与世界观…</p>
              {runMsg && <p className="text-xs text-amber-600">{runMsg}</p>}
            </div>
          )}

          {step === 'done' && (
            <div className="space-y-4">
              <div className="text-sm text-slate-700">
                {synthesisFailed ? (
                  <>
                    ⚠️ 逐章拆解已完成，但<b>全书综合失败</b>：<b>{finishedTitle}</b>
                  </>
                ) : (
                  <>
                    ✅ 拆解完成：<b>{finishedTitle}</b>
                  </>
                )}
              </div>
              {synthesisFailed && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  人物卡与世界观尚未生成。该任务已保留在拆书工作台的「未完成的拆解」里，
                  关闭本窗口后点「继续」即可只重跑综合（已拆章节不会重拆）。
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handleCopyReport}
                  className="text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:border-slate-400 inline-flex items-center gap-1.5"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? '已复制' : '复制报告'}
                </button>
                {onFinished && (
                  <button
                    onClick={() => onFinished(finishedProjectId)}
                    className="text-xs font-semibold px-4 py-2 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 inline-flex items-center gap-1.5"
                  >
                    <BookOpen className="w-3.5 h-3.5" /> 打开模板书
                  </button>
                )}
              </div>
              <pre className="text-xs bg-slate-50 border border-slate-200 rounded-xl p-4 whitespace-pre-wrap font-mono max-h-[40vh] overflow-y-auto">
                {report}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
