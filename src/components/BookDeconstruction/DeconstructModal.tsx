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
  stripSiteChrome,
  assessDeconstructInput,
  hasUsableChapterBody,
  extractTocPageUrls,
  analyzeChapterPagination,
  extractChapterLinksLoose,
  mergeChapterLinks,
  sortByTitleChapterNumber,
  chapterNumberFromTitle,
  type TitleOrderResult,
  saveDeconstructJob,
  deleteDeconstructJob,
  listDeconstructJobs,
  isDeconstructComplete,
  countPendingDeconstruct,
  type SplitChapter,
  type DeconstructJob,
} from '../../services/bookDeconstruct';
import { isGenerationAborted } from '../../services/llmResilience';
import { loadProject, saveProject, getAllProjects } from '../../services/storage';
import { proseWords } from '../../services/proseWords';
import { readTextFileSmart } from '../../services/textEncoding';
import { DeconstructReportView } from './DeconstructReportView';
import type { BookProject, BookProjectSummary } from '../../types/novel';

type Step = 'select' | 'preview' | 'running' | 'synthesizing' | 'done';

/** 章节目录页逐章抓取的礼貌间隔（毫秒） */
const TOC_FETCH_DELAY_MS = 2000;

/** 清洗结果提示：如实告知用户文本被改动过（否则「正文怎么少了」无从解释） */
function chromeNotice(removedLines: number): string | null {
  return removedLines > 0
    ? `已自动清除 ${removedLines} 行站点导航/页脚（如「上一章 / 目录 / 第(1/3)页 / 本站声明 / 网站地图」）`
    : null;
}

/** 拆解失败的章节（done 步如实列出原因，用户才能分清是网站页问题还是拆解问题） */
interface RunFailure {
  chapterNumber: number;
  title: string;
  reason: string;
}

/**
 * 章序提示：目录页/文件若是倒序（最新章节在前），已按题名章号重排成阅读顺序。
 * 模板书仍从第 1 章连续编号——只调整顺序，不动章号。
 */
function orderNotice(where: string, r: TitleOrderResult<{ title: string }>): string | null {
  if (r.reordered) {
    const how = r.mode === 'reverse' ? '是倒序，已整体反转' : '顺序是乱的，已按题名章号重排';
    return `${where}${how}成阅读顺序：从「第 ${r.firstNumber ?? '?'} 章」开始抓`;
  }
  if (r.hasDuplicateNumbers && r.numberedCount === r.total) {
    return (
      `${where}的题名章号有重复（常见于分卷各自从第 1 章编号），为避免打乱卷序未调整顺序，` +
      `请自行核对目录页`
    );
  }
  if (r.total > 2 && r.numberedCount < r.total) {
    return `${where}的题名里多数没有章号，无法判断顺序，按原始顺序处理`;
  }
  if (r.firstNumber != null && r.firstNumber > 1) {
    return (
      `${where}最早的一章是「第 ${r.firstNumber} 章」——若你期望从第 1 章开始，` +
      `说明这里只列出了部分章节（如分页目录）`
    );
  }
  return null;
}

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
  /** 分页目录的其余页（index_2..index_N）；空 = 目录没有分页 */
  const [tocPages, setTocPages] = useState<string[]>([]);
  /** 目录顺序/分页提示（倒序重排、共 N 页、只列出部分章节） */
  const [tocNotice, setTocNotice] = useState<string | null>(null);
  /** 抓取阶段的说明（先抓目录页、再抓章节），与进度数字配套显示 */
  const [tocPhase, setTocPhase] = useState<string | null>(null);
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
  /** done 步当前展示报告的那本书：供「补齐旧版逐章字段」复用（避免只读报告看得到、改不了） */
  const [reportProject, setReportProject] = useState<BookProject | null>(null);
  /** done 步的提示（如「已无待补齐章节」）——runMsg 只在 running/synthesizing 步渲染 */
  const [doneNotice, setDoneNotice] = useState<string | null>(null);
  /** select 步的提示（停止后回到首页要有反馈，runMsg 在那里不渲染） */
  const [selectNotice, setSelectNotice] = useState<string | null>(null);
  /** 本次运行的逐章失败原因 */
  const [runFailures, setRunFailures] = useState<RunFailure[]>([]);
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
    setTocPages([]);
    setTocPhase(null);
    setTocNotice(null);
    setTocProgress(null);
    setPreviewNotice(null);
    setReport('');
    setCopied(false);
    setSynthesisFailed(false);
    // 跨书串台：失败清单此前既不在开窗复位、也不在查看报告时清空，
    // 于是 A 书的失败原因会挂在 B 书的报告下面。
    setRunFailures([]);
    setReportProject(null);
    setDoneNotice(null);
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
      // 必须按字节读再智能解码：国内小说站的 TXT 多为 GBK，File.text() 只按 UTF-8 解码
      // → 满屏「锟斤拷」，而它是「静默失败」：不报错，只是正文全变乱码。
      const decoded = await readTextFileSmart(file);
      // 本地 TXT 多数也是从站点另存的，同样带「上一章/目录/本站声明」这类行
      const cleaned = stripSiteChrome(decoded.text);
      const split = splitChapters(cleaned.text);
      if (!split.length) {
        setUrlMsg(
          `文件为空或无法切分出任何章节（按 ${decoded.encoding} 解码得到 ${proseWords(cleaned.text)} 字）`
        );
        return;
      }
      // 与目录页同理：从站点另存的文件也可能是倒序（最新章节在前）
      const ordered = sortByTitleChapterNumber(split);
      setSourceMode('file');
      setSourceName(file.name);
      setPreviewNotice(
        [
          decoded.encoding === 'UTF-8'
            ? null
            : `文件不是 UTF-8（按 ${decoded.encoding} 解码成功）——若正文仍是乱码，请另存为 UTF-8 后再导入`,
          chromeNotice(cleaned.removedLines),
          orderNotice('文件', ordered),
        ]
          .filter(Boolean)
          .join('；') || null
      );
      setSplits(ordered.items);
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
      // 单章也走同一条链路：章内分页会被合并（长章不再只剩第一页）
      const r = await fetchChapterText(urlInput.trim());
      const text = r.text;
      // 与拆解同判据（assessDeconstructInput）：不然抓取侧 200 字、拆解侧 60 字，
      // 低标点文本会「预览能过、拆解才报错」
      const intake = assessDeconstructInput(text);
      if (!intake.ok) {
        throw new Error(`无法导入这一章：${intake.reason}。页面可能是目录页或需要选择器，可尝试目录页模式`);
      }
      const firstLine = text.split('\n').find((l) => l.trim())?.trim() || '';
      const htmlTitle = extractPageTitle(r.html);
      const singleTitle =
        firstLine.length <= 40 ? firstLine : htmlTitle || r.finalUrl.slice(-40);
      // 单章导入必然被编为第 1 章（不做重排）——题名带章号时要说清，免得用户以为「没从第一章开始」
      const titleNumber = chapterNumberFromTitle(singleTitle);
      setPageTitle(htmlTitle);
      setSourceMode('url');
      setSourceName(r.finalUrl);
      setPreviewNotice(
        [
          chromeNotice(r.removedLines),
          r.subPages ? `已合并本章的 ${r.subPages} 个页内分页（长章被站点拆成多页）` : null,
          r.pageWarning,
          titleNumber != null && titleNumber > 1
            ? `本章题名是「第 ${titleNumber} 章」，单章导入会把它编为第 1 章；` +
              `要按原章号顺序导入整本，请改用「目录页」模式抓全部`
            : null,
        ]
          .filter(Boolean)
          .join('；') || null
      );
      setSplits([
        {
          title: singleTitle,
          content: text,
          // 字数口径全库统一走 proseWords（见 proseWords.ts 的模块说明）
          charCount: proseWords(text),
          warning: r.pageWarning ?? undefined,
        },
      ]);
      setStep('preview');
    });

  // ── 抓取运行 ──────────────────────────────────────────────────────────

  /**
   * 抓一章正文，并把**章内分页**（长章被站点拆成 X.html / X_2.html / X_3.html）合并进来。
   * 只抓第一页会**静默丢掉后 2/3 的正文**——句子看着完整，极难察觉。
   * 同时返回首页的 html/finalUrl，供调用方取页面标题与链接。
   */
  const fetchChapterText = async (
    url: string,
    signal?: AbortSignal
  ): Promise<{
    text: string;
    removedLines: number;
    subPages: number;
    subFailed: number;
    pageWarning: string | null;
    html: string;
    finalUrl: string;
  }> => {
    const page = await fetchArticleViaServer(url, signal);
    const first = stripSiteChrome(extractMainText(page.html), {
      pageTitle: extractPageTitle(page.html),
    });
    let text = first.text;
    let removedLines = first.removedLines;
    let subPages = 0;
    let subFailed = 0;
    let pageWarning: string | null = null;

    // 队列式合并：第 1 页给出后续页；若后续页自己还链着下一页，继续跟（最多 20 页）
    const info = analyzeChapterPagination(page.html, page.finalUrl);
    if (info.total > 1 && info.urls.length === 0) {
      pageWarning =
        `该页标为「第 ${info.page}/${info.total} 页」，但无法推导后续页地址` +
        `（站点分页命名不常见）——本章正文可能只有 1/${info.total}`;
    } else if (info.incompleteHint && info.urls.length === 0) {
      pageWarning = '页面提示「本章未完/点击下一页」，但没能认出后续页地址——本章正文可能不完整';
    }
    const queue = [...info.urls];
    const seenPages = new Set<string>([url]);
    while (queue.length && subPages + subFailed < 20) {
      const next = queue.shift()!;
      if (seenPages.has(next)) continue;
      seenPages.add(next);
      if (signal?.aborted) throw new Error('已停止抓取');
      try {
        const p = await fetchArticleViaServer(next, signal);
        const c = stripSiteChrome(extractMainText(p.html), {
          pageTitle: extractPageTitle(p.html),
        });
        if (c.text) {
          text += `\n\n${c.text}`;
          removedLines += c.removedLines;
          subPages += 1;
        }
        // 链式：这一页自己可能还链着下一页
        for (const u of analyzeChapterPagination(p.html, p.finalUrl).urls) {
          if (!seenPages.has(u)) queue.push(u);
        }
      } catch (err) {
        if (isGenerationAborted(err) || signal?.aborted) throw new Error('已停止抓取');
        subFailed += 1;
        break; // 后一页拿不到就不再往后试
      }
      await abortableSleep(TOC_FETCH_DELAY_MS, signal).catch(() => {
        throw new Error('已停止抓取');
      });
    }
    if (subFailed && !pageWarning) {
      pageWarning = `有 ${subFailed} 个页内分页没抓到——本章正文可能不完整`;
    }
    return { text, removedLines, subPages, subFailed, pageWarning, html: page.html, finalUrl: page.finalUrl };
  };

  const handleFetchToc = () =>
    runWithBusy(async () => {
      const page = await fetchArticleViaServer(urlInput.trim());
      let links = extractChapterLinks(page.html, page.finalUrl);
      let looseNotice: string | null = null;
      if (!links.length) {
        // 兜底：锚文本不是「第N章」形态的站点（`1、开局`／只有标题／只有序号），
        // 改用「同目录 + 数字文件名」的最大同构链接块，让用户在下面对一下是不是章节
        const loose = extractChapterLinksLoose(page.html, page.finalUrl);
        if (!loose.length) {
          throw new Error(
            '目录页中未识别出「第N章 / Chapter N」形态的链接——该站点结构不受支持'
          );
        }
        links = loose;
        looseNotice =
          `未认出「第N章」形态的链接，改用页面里最大的同构链接块（共 ${loose.length} 条）：` +
          `请核对下面前几条是不是章节标题`;
      }
      // 大书目录常被拆成 index_1..index_N，只抓当前页会少掉大半本书。
      // 只在「第N章」形态识别成功时才做分页探测：loose 兜底模式下锚文本本身就是数字，
      // 会被 extractTocPageUrls 误当成目录页（双信号成立），把 N 个章节页当目录页抓。
      const pagination = looseNotice
        ? { pageUrls: [] as string[], totalPages: null as number | null, currentPage: 1 }
        : extractTocPageUrls(page.html, page.finalUrl);
      // 先排成阅读顺序再抓：否则倒序目录页照文档顺序抓，模板书的第一章会变成最新章节
      const ordered = sortByTitleChapterNumber(links);
      setPageTitle(extractPageTitle(page.html));
      setSourceMode('url');
      setSourceName(page.finalUrl);
      setTocLinks(ordered.items);
      setTocPages(pagination.pageUrls);
      setTocNotice(
        [
          looseNotice,
          pagination.totalPages
            ? `目录共 ${pagination.totalPages} 页，当前是第 ${pagination.currentPage} 页` +
              `（本页识别 ${links.length} 章）；点「抓取全部」会先补抓其余 ${pagination.pageUrls.length} 页目录再逐章抓`
            : null,
          orderNotice('目录页', ordered),
        ]
          .filter(Boolean)
          .join('；') || null
      );
    });

  const handleFetchAllTocChapters = () =>
    runWithBusy(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      const out: SplitChapter[] = [];
      let stopped = false;
      let removedTotal = 0;
      let tocPagesFailed = 0;
      let subPagesTotal = 0;
      let subPagesFailed = 0;
      /** 章内分页无法合并/不完整的章，如实汇报（避免用户以为拿到的是全章） */
      const pageWarnings: string[] = [];

      // ── 阶段 1：补全分页目录 ──────────────────────────────────────────
      // 分页目录的第 1 页往往只有前几十章、外加一个置顶的「最新章节」块；
      // 不把其余目录页抓下来，导入的书就会又缺章、又掺着几十条最新章。
      const pageLinks: { url: string; title: string }[][] = [tocLinks];
      try {
        for (let i = 0; i < tocPages.length; i += 1) {
          setTocProgress({ done: i, total: tocPages.length });
          setTocPhase(`正在抓取目录页 ${i + 1}/${tocPages.length}…`);
          try {
            const page = await fetchArticleViaServer(tocPages[i], controller.signal);
            pageLinks.push(extractChapterLinks(page.html, page.finalUrl));
          } catch (err) {
            if (isGenerationAborted(err) || controller.signal.aborted) throw new Error('已停止抓取');
            tocPagesFailed += 1; // 单页失败不中断整本，最后如实汇报
          }
          await abortableSleep(TOC_FETCH_DELAY_MS, controller.signal).catch(() => {
            throw new Error('已停止抓取');
          });
        }
      } catch (err) {
        if (!pageLinks.length) throw err;
        stopped = true;
      }

      // 合并去重（同一章可能同时在「最新章节」块与目录列表里）+ 排成阅读顺序
      const orderedAll = mergeChapterLinks(pageLinks);
      setTocLinks(orderedAll.items);

      // ── 阶段 2：逐章抓正文 ────────────────────────────────────────────
      try {
        for (let i = 0; i < orderedAll.items.length; i += 1) {
          setTocProgress({ done: i, total: orderedAll.items.length });
          setTocPhase(`正在抓取章节 ${i + 1}/${orderedAll.items.length}…`);
          try {
            // 含章内分页合并：长章被站点拆成 X.html / X_2.html / X_3.html
            const r = await fetchChapterText(orderedAll.items[i].url, controller.signal);
            removedTotal += r.removedLines;
            subPagesTotal += r.subPages;
            subPagesFailed += r.subFailed;
            if (r.pageWarning && pageWarnings.length < 20) {
              pageWarnings.push(`第「${orderedAll.items[i].title}」：${r.pageWarning}`);
            }
            const intake = assessDeconstructInput(r.text);
            if (!intake.ok) {
              // 页面抓到了但不像正文（JS 渲染/反爬/目录页）：**不进模板书、不送 LLM**。
              // 此前只有「请求抛错」才算失败，这类「200 但没正文」的页会当正常章带进去，
              // 然后在拆解阶段白烧一次调用、最后变成报告里一行全「—」。
              out.push({
                title: orderedAll.items[i].title,
                content: '',
                charCount: 0,
                failed: true,
                failReason: intake.reason,
              });
            } else {
              out.push({
                title: orderedAll.items[i].title,
                content: r.text,
                charCount: intake.charCount,
                warning: r.pageWarning ?? undefined,
              });
            }
          } catch (err) {
            if (isGenerationAborted(err) || controller.signal.aborted) throw new Error('已停止抓取');
            // 单章失败跳过并留痕，不中断整本。
            // failed: true 标记它只是「预览里的失败提示」——绝不能被当成正文
            // 进模板书或送 LLM 拆解（否则白烧调用并产出垃圾章节）。
            out.push({
              title: orderedAll.items[i].title,
              content: '',
              charCount: 0,
              failed: true,
              failReason: `请求失败：${err instanceof Error ? err.message : String(err)}`,
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
        setTocPhase(null);
      }
      if (!out.length) throw new Error('未抓到任何章节');
      const notices: string[] = [];
      if (stopped) {
        notices.push(`抓取已停止：仅保留已抓到的 ${out.length} 章（目录共识别 ${orderedAll.items.length} 章）`);
      }
      if (tocPages.length) {
        notices.push(
          `已合并 ${tocPages.length + 1} 页目录，去重后共 ${orderedAll.items.length} 章` +
            (tocPagesFailed ? `（其中 ${tocPagesFailed} 页目录抓取失败，可能缺章）` : '')
        );
      }
      if (orderedAll.reordered) {
        notices.push(`已按题名章号排为阅读顺序：从「第 ${orderedAll.firstNumber} 章」开始`);
      }
      if (subPagesTotal) {
        notices.push(
          `已合并 ${subPagesTotal} 个章内分页（长章被站点拆成多页）` +
            (subPagesFailed ? `，另有 ${subPagesFailed} 页没抓到，相关章节正文可能不完整` : '')
        );
      }
      if (pageWarnings.length) {
        notices.push(
          `⚠️ 有 ${pageWarnings.length} 章可能不完整（页内分页没能自动合并）：` +
            pageWarnings.slice(0, 3).join('；') +
            (pageWarnings.length > 3 ? ' …' : '')
        );
      }
      const chrome = chromeNotice(removedTotal);
      if (chrome) notices.push(chrome);
      setPreviewNotice(notices.length ? notices.join('；') : null);
      setSplits(out);
      setStep('preview');
    });

  // ── 拆解运行 ──────────────────────────────────────────────────────────

  const runDeconstruct = async (
    project: BookProject,
    opts: { backfill?: boolean; lockHeld?: boolean } = {}
  ) => {
    // 同步互斥闸门（防双击/重复点「继续」）：running 是 state，同一事件循环内
    // 的第二次调用会读到旧值而双双通过；第二次还会覆盖 abortRef.current，
    // 使第一个循环的 controller 失去引用——停不掉、且两条循环并发写同一项目。
    // lockHeld：调用方（handleConfirmSplits）已在跨 await 之前占锁，此处仅确认——
    // 否则它「先占锁」会让本函数自己的检查当场把它挡回去。
    if (!opts.lockHeld && runLockRef.current) {
      // 同步互斥闸门被挡下时要有反馈——此前静默 return，用户点「继续」毫无反应
      setDoneNotice('已有一次拆解正在进行，请等它结束或先停止。');
      return;
    }
    runLockRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setDoneNotice(null);
    setSelectNotice(null);
    // 进度基数必须与循环里的跳过判据同源，否则补齐模式下会从「全满」起跳、越跑越超总数
    const pendingTotal = project.chapters.filter((c) =>
      opts.backfill ? !isDeconstructComplete(c.deconstruct) : !c.deconstruct
    ).length;
    setStep('running');
    setProgress({ done: project.chapters.length - pendingTotal, total: project.chapters.length, failed: 0 });
    setRunFailures([]);
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
    /** 落盘连续失败次数：存储写不进去时继续跑只是白烧 API 额度 */
    let saveFailStreak = 0;
    let stoppedBySaveFailure = false;
    /** 逐章失败原因：done 步要如实列出，用户才能判断是网站页没抓到正文还是拆解失败 */
    const failures: RunFailure[] = [];

    for (const ch of project.chapters) {
      // 两种跳过判据，按模式区分：
      // - 默认（开始/继续）：有 deconstruct 即跳过 —— 「继续」的承诺是只补未拆章 + 重跑综合；
      // - backfill：只有数据**已含当前 schema 全部字段**才跳过，否则重拆该章补齐新字段。
      //   （只看「有没有 deconstruct」会让本次更新前拆过的书永远拿不到新字段，如 emotion。）
      if (opts.backfill ? isDeconstructComplete(ch.deconstruct) : !!ch.deconstruct) continue;
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
        // 整体展开落盘（summary/beats 归章节，其余归 deconstruct）：
        // 此前逐字段手抄，新增字段漏抄一行就静默丢失——本轮的 emotion 正是这么来的风险。
        const { summary, beats, ...deconstruct } = result;
        ch.summary = summary;
        ch.beats = beats;
        ch.deconstruct = deconstruct;
        for (const n of result.characterNames || []) {
          if (!known.includes(n)) known.push(n);
        }
      } catch (err) {
        if (isGenerationAborted(err) || controller.signal.aborted) {
          aborted = true;
          break;
        }
        failed += 1;
        // 不清空 ch.deconstruct：backfill（补齐旧版字段）时该章可能已有 v=1 的
        // characterNames/hookType 等数据，一次限流/超时就把它们抹掉并落盘 = 真丢数据，
        // 而且 summary/beats 还在 → 报告里该章一半有值一半空。保留旧数据，下次继续再补。
        const reason = err instanceof Error ? err.message : String(err);
        failures.push({ chapterNumber: ch.number, title: ch.title, reason });
        setRunMsg(`第${ch.number}章拆解失败：${reason}`);
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
        saveFailStreak = 0;
      } catch (err) {
        saveFailStreak += 1;
        const msg = err instanceof Error ? err.message : String(err);
        setRunMsg(`落盘失败（${saveFailStreak}/3）：${msg}`);
        // 连续写不进去还继续跑 = 白烧 API 额度且成果全丢，第 3 次直接中止。
        // 此前只提示一句就继续，跑完几百章才发现一个字都没存下来。
        if (saveFailStreak >= 3) {
          stoppedBySaveFailure = true;
          break;
        }
      }
    }

    if (aborted) {
      runLockRef.current = false;
      setCurrentTitle('');
      // runMsg 只在 running/synthesizing 步渲染，回到 select 步会看不见——用 select 步自己的提示槽
      setSelectNotice('已停止——已拆章节已保存，可随时在下方「未完成的拆解」里点「继续」。');
      setStep('select');
      // 列表必须在此刷新：jobs 只在开窗时读过一次，而「继续」入口就在这份列表里——
      // 不刷新时上面那句提示指向一个**不存在的入口**（用户以为进度丢了，往往重导一遍、
      // 再拆一本、再花一次钱）。
      void listDeconstructJobs()
        .then((list) => setJobs(list.filter((j) => !(j.done >= j.total && j.synthesisDone))))
        .catch(() => {});
      return;
    }

    // 落盘连续失败熔断：不跑综合（同样写不进去），直接给报告 + 明确原因
    if (stoppedBySaveFailure) {
      runLockRef.current = false;
      setCurrentTitle('');
      setRunFailures(failures);
      setReportProject(project);
      setReport(formatDeconstructReport(project));
      setSynthesisFailed(true);
      setDoneNotice(
        '落盘连续失败 3 次，已中止本次拆解——否则会继续消耗 API 额度而成果存不下来。' +
          '请检查磁盘空间/目录权限（或是否有另一个窗口占用本机数据目录），处理好后点「继续」重试。'
      );
      setStep('done');
      return;
    }

    // ── 全书综合 ──
    setStep('synthesizing');
    let synthesisOk = false;
    /** 综合阶段被用户停止（不是「综合失败」——不要误报） */
    let stoppedInSynthesis = false;
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
      if (isGenerationAborted(err) || controller.signal.aborted) {
        // 用户点停止：不是失败，只是还没跑完（任务会保留在「未完成的拆解」，可续跑）
        stoppedInSynthesis = true;
      } else {
        setRunMsg(
          `全书综合失败（可稍后重跑）：${err instanceof Error ? err.message : String(err)}`
        );
      }
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
    // 用户主动停止 ≠ 综合失败：此前一律 setSynthesisFailed(true)，done 步会渲染
    // 「全书综合失败」，与同一屏的「点继续会接着做综合」自相矛盾。
    setSynthesisFailed(!synthesisOk && !stoppedInSynthesis);
    if (stoppedInSynthesis) {
      setDoneNotice('已停止——已拆章节已保存；全书综合还没跑完，点「继续」会接着做综合。');
      // 与章节阶段停止同理：列表刷新后「继续」入口才真的存在
      void listDeconstructJobs()
        .then((list) => setJobs(list.filter((j) => !(j.done >= j.total && j.synthesisDone))))
        .catch(() => {});
    }
    setRunFailures(failures);
    setFinishedTitle(project.title);
    setFinishedProjectId(project.id);
    setReportProject(project);
    setReport(formatDeconstructReport(project));
    setProgress((prev) => ({ ...prev, failed }));
    setStep('done');
  };

  const handleConfirmSplits = async () => {
    if (runLockRef.current) {
      setPreviewNotice('已有一次拆解正在进行，请等它结束或先停止。');
      return;
    }
    // 同步占锁：runDeconstruct 要到 saveProject/saveDeconstructJob 两个 await 之后才占锁，
    // 双击会在这段窗口里双双通过 → 两份同内容模板书 + 两条任务索引（第二条 done:0 永久
    // 挂在「未完成的拆解」里，日后误点「继续」= 整本再拆一遍、再花一次钱）。
    runLockRef.current = true;
    try {
      // 排除没取到正文的章：它们进模板书会变成空章节，
      // 还会被逐章送 LLM 拆解（白烧调用）。
      const failedCount = splits.filter((s) => s.failed).length;
      // 门槛必须与拆解侧同源（assessDeconstructInput / MIN_CHAPTER_CHARS=60）：
      // 此前用 charCount>0，恰好 1~59 字的残页能进模板书，却在逐章拆解时必然失败
      // → 该书永久「待补齐」，done 步一直显示补齐按钮。
      const usable = splits.filter((s) => !s.failed && hasUsableChapterBody(s.content));
      if (!usable.length) {
        // 不能静默 return：过滤后为空时用户点了「开始拆解」却毫无反应
        setPreviewNotice(
          failedCount > 0
            ? `没有可拆解的内容：${failedCount} 章全部没取到正文（原因见上方列表），请重新抓取或换目录页。`
            : '没有可拆解的内容：章节正文均为空或过短（不足 60 字）。'
        );
        return;
      }
      // 规模确认：拆解是逐章 LLM 调用，几百上千章会产生同量级的费用与耗时
      if (usable.length >= 50) {
        const totalWords = usable.reduce((a, s) => a + s.charCount, 0);
        const ok = window.confirm(
          `将对 ${usable.length} 章（约 ${totalWords.toLocaleString()} 字）逐章调用 LLM 拆解。\n` +
            `每章 1 次 API 调用，合计约 ${usable.length} 次，耗时与费用可能较高。\n` +
            (failedCount > 0 ? `\n（已跳过 ${failedCount} 章没取到正文的）\n` : '') +
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
        // 索引写失败与建书失败要分开报：混在一条 catch 里时，书已入库但索引没写成，
        // 会留下「已完成列表里可见、报告为空、又无法续跑」的孤儿模板书。
        try {
          await saveDeconstructJob({
            projectId: template.id,
            title: template.title,
            done: 0,
            total: template.chapters.length,
            synthesisDone: false,
            updatedAt: new Date().toISOString(),
          });
        } catch (err) {
          setUrlMsg(
            `模板书已创建，但断点续跑索引写入失败（仍可重跑拆解）：${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
        await runDeconstruct(template, { lockHeld: true });
      } catch (err) {
        setUrlMsg(`创建模板书失败：${err instanceof Error ? err.message : String(err)}`);
        setStep('select');
      }
    } finally {
      // runDeconstruct 正常/中止/熔断路径都会自行释放；这里兜住它没跑到的分支
      // （建书失败、用户取消规模确认、正文过滤后为空等提前 return），
      // 否则锁泄漏会让整个工作台此后点不动。
      runLockRef.current = false;
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
    setReportProject(project);
    setDoneNotice(null);
    setReport(formatDeconstructReport(project));
    setStep('done');
  };

  /**
   * 补齐旧版逐章字段（本次更新前拆的书没有 emotion）。
   * 已完成的书任务索引已删、也不在「未完成的拆解」列表里，若无此入口就只能整本重导
   * ——这是「有 deconstruct 即视为拆完」留下的死角。
   * 用 backfill 模式：只重拆「缺当前 schema 字段」或从未拆过的章。
   */
  const handleBackfill = async () => {
    if (!reportProject) return;
    // 被运行锁挡掉时必须给反馈，否则就是「点了没反应」（本项目已踩过的坑）
    if (runLockRef.current) {
      setDoneNotice('已有一次拆解正在进行，请等它结束或先停止。');
      return;
    }
    // 以库里最新数据为准（报告可能已展示一段时间，期间章节目录可能变过）
    const latest = (await loadProject(reportProject.id)) || reportProject;
    const n = countPendingDeconstruct(latest.chapters);
    if (!n) {
      setReportProject(latest);
      setDoneNotice('已经没有待补齐的章节。');
      return;
    }
    if (n >= 50 && !window.confirm(`将重拆 ${n} 章以补齐新字段（每章 1 次 LLM 调用）。继续？`)) {
      return;
    }
    await runDeconstruct(latest, { backfill: true });
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

  /** 当前报告这本书里「待处理」的章数（缺拆解，或拆解数据版本落后 → 提供补齐入口） */
  const backfillCount = reportProject ? countPendingDeconstruct(reportProject.chapters) : 0;

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
              {selectNotice && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  {selectNotice}
                </div>
              )}
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
                      {tocNotice && (
                        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                          {tocNotice}
                        </div>
                      )}
                      <div className="flex items-center justify-between text-xs text-slate-600">
                        <span>
                          识别出 {tocLinks.length} 个章节链接
                          {tocPages.length ? `（另需补抓 ${tocPages.length} 页目录）` : ''}
                          （按 2 秒/请求礼貌抓取；长章含页内分页时会追加请求）
                          {tocPhase
                            ? ` · ${tocPhase}`
                            : tocProgress
                              ? ` · ${tocProgress.done}/${tocProgress.total}`
                              : ''}
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
                      （{splits.filter((s) => s.failed).length} 章没取到正文，将跳过——每行下方有原因）
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
                  <div key={i} className="p-3 space-y-1">
                    <div className="flex items-center gap-2">
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
                        {s.failed ? '跳过' : `${s.charCount.toLocaleString()} 字`}
                      </span>
                      <button
                        onClick={() => setSplits(splits.filter((_, j) => j !== i))}
                        className="text-xs text-slate-400 hover:text-red-600 shrink-0 px-1"
                        title="删除本章（不拆不导）"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {s.failed && s.failReason && (
                      <div className="text-[11px] text-amber-700 pl-10 leading-relaxed">
                        {s.failReason}
                      </div>
                    )}
                    {!s.failed && s.warning && (
                      <div className="text-[11px] text-amber-700 pl-10 leading-relaxed">
                        ⚠️ {s.warning}
                      </div>
                    )}
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
              {backfillCount > 0 && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 space-y-2">
                  <div>
                    本书有 <b>{backfillCount}</b> 章还没按新版拆解（旧数据缺情绪等新字段，
                    或从未拆过），报告里这些章的情绪列为空、也不计入情绪曲线。
                  </div>
                  <button
                    onClick={() => void handleBackfill()}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-amber-300 bg-white text-amber-800 hover:border-amber-500 inline-flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> 只重拆这 {backfillCount} 章补齐（每章 1 次调用）
                  </button>
                </div>
              )}
              {doneNotice && (
                <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                  {doneNotice}
                </div>
              )}
              {runFailures.length > 0 && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 space-y-1">
                  <div className="font-semibold">
                    {runFailures.length} 章未拆解成功（正文缺失或模型返回不完整）：
                  </div>
                  <ul className="space-y-0.5">
                    {runFailures.slice(0, 10).map((f) => (
                      <li key={f.chapterNumber} className="leading-relaxed">
                        第 {f.chapterNumber} 章{f.title ? `（${f.title}）` : ''}：{f.reason}
                      </li>
                    ))}
                  </ul>
                  {runFailures.length > 10 && (
                    <div className="text-red-600">…另有 {runFailures.length - 10} 章，详见下方报告。</div>
                  )}
                  <div className="text-red-600">
                    这些章在模板书里是空的正文/占位，不会送出拆解；可在「未完成的拆解」里点「继续」重试。
                  </div>
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
              <div className="border border-slate-200 rounded-xl p-4 bg-slate-50 max-h-[45vh] overflow-y-auto">
                <DeconstructReportView report={report} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
