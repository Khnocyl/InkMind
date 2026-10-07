import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectConfig, StyleConfig } from '../../types/novel';
import {
  Trash2,
  Cpu,
  CheckCircle2,
  Sliders,
  Lock,
  Save,
  Stethoscope,
  AlertTriangle,
  XCircle,
  Loader2,
  RefreshCw,
  Zap,
  Database,
  PlusCircle,
} from 'lucide-react';

import { thirdPartyHost } from '../../services/llmClient';
import { ALL_LLM_ROLES, ROLE_LABELS } from '../../services/llmRouting';
import { overallLabel, type DoctorCheckStatus } from '../../services/doctorClient';
import { GenrePackPanel } from './GenrePackPanel';
import { StyleImitatePanel } from './StyleImitatePanel';
import { SettingsAppearanceSection } from './SettingsAppearanceSection';
import { SettingsAboutSection } from './SettingsAboutSection';
import { SettingsTargetsSection } from './SettingsTargetsSection';
import { SettingsAutopilotSection } from './SettingsAutopilotSection';
import { SettingsCoreStyleSection } from './SettingsCoreStyleSection';
import { SettingsBlacklistSection } from './SettingsBlacklistSection';
import {
  useLLMProfiles,
  useDoctor,
  useEmbeddingConfig,
  useRoleRouting,
  useUpdateCheck,
} from './settingsHooks';

/** 各服务商类型的默认/示例 Base URL（切换类型时自动填充） */
const PROVIDER_DEFAULT_BASE_URL: Record<
  'openai' | 'deepseek' | 'custom' | 'anthropic' | 'local',
  string
> = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  local: 'http://127.0.0.1:11434/v1',
  custom: 'https://api.openai.com/v1',
};

interface StyleAndEngineManagerProps {
  styleConfig: StyleConfig;
  onUpdateStyleConfig: (
    config: StyleConfig | ((prev: StyleConfig) => StyleConfig)
  ) => Promise<void> | void;
  /** 删除文风仿写档案（App 侧统一清全局库 + 清理 config 悬空引用） */
  onDeleteStyleProfile?: (id: string) => Promise<void> | void;
  /** 同步到 App 顶栏/工作流状态条，避免只写在页内看不见 */
  onNotifyStatus?: (msg: string) => void;
  /** 从快照找回丢失的文风仿写档案 */
  onRecoverStyleProfiles?: () => void;
  genre?: string;
  projectConfig?: ProjectConfig;
  onUpdateGenre?: (genre: string, packId: string) => void;
  onUpdateProjectConfig?: (config: ProjectConfig) => void;
  onSaveGenreOverride?: (
    packId: string,
    override: import('../../services/genrePacks').GenrePackOverride | null
  ) => void;
}

function statusIcon(status: DoctorCheckStatus) {
  switch (status) {
    case 'pass':
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />;
    case 'warn':
      return <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />;
    case 'fail':
      return <XCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />;
    default:
      return <span className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0" />;
  }
}

function statusRowClass(status: DoctorCheckStatus): string {
  switch (status) {
    case 'pass':
      return 'border-emerald-100 bg-emerald-50/40';
    case 'warn':
      return 'border-amber-100 bg-amber-50/50';
    case 'fail':
      return 'border-red-100 bg-red-50/50';
    default:
      return 'border-slate-100 bg-slate-50';
  }
}

/**
 * 左侧目录（「一栏里面有什么」）：按大分组列出每个具体设置卡片，
 * 点击滚动定位到对应卡片。key 与各卡片容器 id 一一对应。
 */
const SETTING_NAV: {
  group: string;
  items: { key: string; label: string; id: string }[];
}[] = [
  {
    group: '常规与外观',
    items: [
      { key: 'appearance', label: '外观设置 · 主题', id: 'sec-appearance' },
      { key: 'about', label: '关于 · 检查更新', id: 'sec-about' },
    ],
  },
  {
    group: '模型与成本',
    items: [
      { key: 'models', label: '模型配置 · Doctor', id: 'sec-api-config' },
      { key: 'routing', label: '按角色路由 · 向量检索', id: 'sec-llm-routing' },
    ],
  },
  {
    group: '写作引擎',
    items: [
      { key: 'genre', label: '题材规则包', id: 'sec-genre' },
      { key: 'targets', label: '全书 · 每日 · 抽检', id: 'sec-targets' },
      { key: 'autopilot', label: 'Auto-Pilot 参数', id: 'sec-autopilot' },
    ],
  },
  {
    group: '文风纪律',
    items: [
      { key: 'core-switch', label: '核心文风 · 样本库', id: 'sec-core-switch' },
      { key: 'blacklist', label: '黑名单 / 去AI味', id: 'sec-blacklist' },
      { key: 'imitate', label: '文风仿写档案', id: 'sec-imitate' },
    ],
  },
];

export const StyleAndEngineManager: React.FC<StyleAndEngineManagerProps> = ({
  styleConfig,
  onUpdateStyleConfig,
  onDeleteStyleProfile,
  onNotifyStatus,
  onRecoverStyleProfiles,
  genre,
  projectConfig,
  onUpdateGenre,
  onUpdateProjectConfig,
  onSaveGenreOverride,
}) => {
  // ── 壳层状态：视图 + 状态提示（领域状态见下方 settingsHooks 调用）──
  const [newBlacklistWord, setNewBlacklistWord] = useState('');
  const [newWhitelistWord, setNewWhitelistWord] = useState('');
  const [saveStatusMsg, setSaveStatusMsg] = useState('');
  /** 浮动 Toast（固定视口，刷新后仍可从 session 恢复） */
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  /** 左侧目录当前选中项（sticky 选中态；仅视图状态） */
  const [activeSection, setActiveSection] = useState<string>('models');

  const doctorSectionRef = React.useRef<HTMLDivElement>(null);
  const statusBannerRef = React.useRef<HTMLDivElement>(null);
  const toastTimerRef = React.useRef<number | null>(null);

  const STATUS_KEY = 'novel-engine-status-v1';

  /**
   * 设置面板提示闸门。
   *
   * 策略：常规保存类**成功**提示保持静默（此前用户反馈「繁琐」）；
   * 但两类必须可见，否则等于没反应：
   *  - **失败**（❌/失败/错误）——此前连「❌ 保存失败」都被一并吞掉，
   *    用户会以为 API Key 已保存成功，属于危险的信息缺失；
   *  - **用户显式点击的测试/诊断**（Doctor 诊断、Embedding 连通测试）。
   */
  const pushStatus = (msg: string) => {
    const isDoctor = /doctor/i.test(msg);
    const isFailure = msg.includes('❌') || msg.includes('失败') || msg.includes('错误');
    const isExplicitProbe = /embedding|向量/i.test(msg);
    if (!isDoctor && !isFailure && !isExplicitProbe) {
      return;
    }
    setSaveStatusMsg(msg);
    setToastMsg(msg);
    onNotifyStatus?.(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    // 进行中提示 3 秒，结果提示 5 秒自动淡出
    const ms = msg.includes('⏳') ? 3000 : 5000;
    toastTimerRef.current = window.setTimeout(() => {
      setToastMsg((cur) => (cur === msg ? null : cur));
    }, ms);
    requestAnimationFrame(() => {
      statusBannerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  // ── 领域状态（settingsHooks）：挂壳层——分区是条件渲染，state 下沉分区会丢草稿 ──
  const {
    backendConfig,
    profiles,
    editingProfileId,
    inputProfileName,
    setInputProfileName,
    inputProvider,
    setInputProvider,
    inputMaxTokens,
    setInputMaxTokens,
    inputApiKey,
    setInputApiKey,
    inputBaseURL,
    setInputBaseURL,
    inputModelName,
    setInputModelName,
    inputTemperature,
    setInputTemperature,
    isSavingConfig,
    modelOptions,
    isLoadingModels,
    modelsHint,
    setModelsHint,
    handleNewProfile,
    handleSelectProfileForEdit,
    handleSaveBackendConfig,
    handleActivateProfile,
    handleDeleteProfile,
    handleRefreshModels,
  } = useLLMProfiles(pushStatus);
  const { isDoctorRunning, doctorReport, handleRunDoctor } = useDoctor(pushStatus);
  const {
    embConfig,
    embEnabled,
    setEmbEnabled,
    embUseSame,
    setEmbUseSame,
    embBaseURL,
    setEmbBaseURL,
    embModel,
    setEmbModel,
    embDims,
    setEmbDims,
    embApiKey,
    setEmbApiKey,
    embBusy,
    handleSaveEmbedding,
    handleTestEmbedding,
  } = useEmbeddingConfig(pushStatus);
  const {
    routingEnabled,
    setRoutingEnabled,
    routingRoutes,
    setRoutingRoutes,
    handleSaveRoleRouting,
  } = useRoleRouting(styleConfig, onUpdateStyleConfig, profiles, pushStatus);
  const update = useUpdateCheck();

  // 挂载：清 session 状态锚 + 卸载清 Toast 计时器（配置加载由各领域 Hook 自行完成）
  useEffect(() => {
    try {
      sessionStorage.removeItem(STATUS_KEY);
    } catch {
      /* ignore */
    }
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 内容列滚动容器：分区切换后回到顶部（本页窗口不滚动，滚动发生在内容列） */
  const contentScrollRef = React.useRef<HTMLDivElement>(null);

  /** 左栏切换：点一项，右侧仅展示该面板；分区高度差异大，切后回顶避免跳动 */
  const selectSection = (key: string) => {
    setActiveSection(key);
    contentScrollRef.current?.scrollTo(0, 0);
  };

  /** 仅把当前可用的条目放进目录（如项目配置未就绪时隐藏题材包卡） */
  const navAvailable = (key: string): boolean => {
    switch (key) {
      case 'genre':
        return !!projectConfig && !!onUpdateGenre;
      default:
        return true;
    }
  };

  const toastTone =
    toastMsg?.includes('✅') || toastMsg?.includes('成功')
      ? 'border-emerald-400 bg-emerald-50 text-emerald-950'
      : toastMsg?.includes('❌') || toastMsg?.includes('失败')
        ? 'border-red-400 bg-red-50 text-red-950'
        : toastMsg?.includes('⏳')
          ? 'border-slate-300 bg-white text-slate-900'
          : 'border-amber-300 bg-amber-50 text-amber-950';

  return (
    <div className="flex-1 bg-white text-slate-900 animate-fadeIn flex items-stretch overflow-hidden h-full">
      {/* 视口顶栏 Toast：不依赖页面滚动；刷新后 90s 窗口内可恢复（手动关闭则不再恢复） */}
      {toastMsg &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed top-4 left-1/2 z-[9999] w-[min(92vw,36rem)] -translate-x-1/2 pointer-events-auto"
            role="status"
            aria-live="polite"
          >
            <div
              className={`rounded-xl border-2 shadow-xl px-4 py-3 text-sm font-semibold flex items-start gap-3 ${toastTone}`}
            >
              <span className="flex-1 leading-relaxed break-words">{toastMsg}</span>
              <button
                type="button"
                className="shrink-0 text-xs px-2.5 py-1 rounded-md bg-black/10 hover:bg-black/20 text-current transition-colors font-bold cursor-pointer"
                onClick={() => {
                  setToastMsg(null);
                  if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
                  // 手动关闭 = 终态：同步清除 session 恢复锚，否则切走再切回
                  // （组件重挂载读 STATUS_KEY）时 Toast 会原地复活
                  try {
                    sessionStorage.removeItem(STATUS_KEY);
                  } catch {
                    /* ignore */
                  }
                }}
              >
                关闭
              </button>
            </div>
          </div>,
          document.body
        )}

      {/* 左侧导航栏：贴屏幕最左、与内容列等高（App 行 overflow-hidden 会让 sticky 失效，
          故不用 sticky——本页改为「侧栏定高 + 内容列自滚」布局） */}
      <aside className="w-[200px] shrink-0 overflow-y-auto scrollbar-gutter-stable border-r border-slate-100 px-3 py-6 space-y-4">
        <div className="text-[10.5px] font-bold text-slate-500 tracking-[0.08em] px-2 pb-1">设置</div>
        {SETTING_NAV.map((group) => (
          <div key={group.group}>
            <div className="text-[10px] font-bold text-slate-400 tracking-[0.06em] px-2 pb-1">
              {group.group}
            </div>
            <div className="space-y-0.5">
              {group.items.filter((item) => navAvailable(item.key)).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => selectSection(item.key)}
                  className={`w-full text-left text-[11.5px] font-medium px-2.5 py-[6px] rounded-lg border transition-colors ${
                    activeSection === item.key
                      ? 'bg-[#fafafa] border-[#e5e5e5] text-[#111111]'
                      : 'border-transparent text-slate-600 hover:bg-[#fafafa] hover:text-[#111111]'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="pt-3 mt-1 border-t border-slate-100">
          <span className="inline-flex items-center gap-1.5 text-[10px] text-emerald-700 border border-emerald-200 bg-emerald-50 rounded-lg px-2 py-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            服务 · Doctor 可体检
          </span>
        </div>
      </aside>
      {/* 右侧内容列：自身滚动（窗口在本页不滚动），内容块居中自适应。
          不加 space-y——分组包裹层现在每次只显示一个，统一由 py-8 决定起点，
          避免不同分组的卡片起始高度差 48px 造成切换跳动 */}
      <div ref={contentScrollRef} className="flex-1 min-w-0 overflow-y-auto scrollbar-gutter-stable">
        <div className="w-full max-w-5xl mx-auto px-6 lg:px-8 py-8">

      {/* ── 分组：常规与外观 ── */}
      {activeSection === 'appearance' && <SettingsAppearanceSection onStatus={pushStatus} />}

      {/* ── 分组：关于与检查更新 ── */}
      {activeSection === 'about' && <SettingsAboutSection update={update} />}

      {/* ── 分组一：模型与成本（多模型配置档 / Doctor / LLM 成本预算；向量检索已并入「按角色路由」卡）── */}
      <div className="space-y-12 scroll-mt-14">
      {/* API Key 与服务端大模型配置 */}
      {activeSection === 'models' && (
      <div
        id="sec-api-config"
        ref={doctorSectionRef}
        className="bg-slate-50 border border-slate-200 rounded-2xl p-6 shadow-md space-y-6"
      >
        <div className="flex items-center justify-between border-b border-slate-200 pb-4">
          <div className="flex items-center space-x-2.5">
            <Cpu className="w-5 h-5 text-neutral-800" />
            <h2 className="text-base font-bold text-slate-900">多模型配置档 · 点启用切换</h2>
          </div>
          <div className="flex items-center space-x-2 text-xs font-semibold px-3 py-1 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">
            <Lock className="w-3.5 h-3.5" />
            <span>后端 AES-256 加密 · 前端不可见密钥</span>
          </div>
        </div>

        {/* 多模型卡片列表 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-slate-600">
              可保存多套 Base URL / 模型 / Key；写作与 Doctor 始终使用
              <strong className="text-neutral-900"> 当前启用 </strong>
              的一档。
              {backendConfig?.activeProfileName && (
                <span className="ml-1 font-mono text-emerald-800">
                  启用中：{backendConfig.activeProfileName}
                </span>
              )}
            </p>
            <button
              type="button"
              onClick={handleNewProfile}
              disabled={isSavingConfig}
              className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-black bg-black text-white text-[11px] font-bold hover:bg-neutral-800 disabled:opacity-50"
            >
              <PlusCircle size={12} />
              新增模型
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
            {profiles.map((p) => (
              <div
                key={p.id}
                className={`rounded-xl border p-3 text-xs transition-all ${
                  p.isActive
                    ? 'border-emerald-400 bg-emerald-50/80 ring-1 ring-emerald-300'
                    : editingProfileId === p.id
                      ? 'border-neutral-300 bg-neutral-100/50'
                      : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => handleSelectProfileForEdit(p)}
                    className="text-left min-w-0 flex-1"
                  >
                    <div className="font-bold text-slate-900 truncate flex items-center gap-1.5">
                      {p.name}
                      {p.isActive && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-600 text-white font-bold">
                          使用中
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[10px] text-slate-600 mt-0.5 truncate">
                      {p.modelName}
                    </div>
                    <div className="text-[10px] text-slate-500 mt-0.5 truncate" title={p.baseURL}>
                      {p.baseURL}
                    </div>
                    <div className="text-[10px] mt-1 text-slate-500">
                      {p.hasKey ? '🔑 已存密钥' : '⚠️ 无密钥'} · {p.provider}
                    </div>
                  </button>
                  <div className="flex flex-col gap-1 shrink-0">
                    <button
                      type="button"
                      disabled={p.isActive || isSavingConfig}
                      onClick={() => void handleActivateProfile(p.id)}
                      className={`inline-flex items-center justify-center gap-0.5 px-2 py-1 rounded-md text-[10px] font-bold ${
                        p.isActive
                          ? 'bg-emerald-200 text-emerald-900 cursor-default'
                          : 'bg-black text-white hover:bg-neutral-800 disabled:opacity-50'
                      }`}
                      title="启用后写作/Doctor 走此模型"
                    >
                      <Zap size={10} />
                      {p.isActive ? '已启用' : '启用'}
                    </button>
                    <button
                      type="button"
                      disabled={isSavingConfig || profiles.length <= 1}
                      onClick={() => void handleDeleteProfile(p.id)}
                      className="inline-flex items-center justify-center gap-0.5 px-2 py-1 rounded-md text-[10px] font-semibold border border-rose-200 text-rose-800 hover:bg-rose-50 disabled:opacity-40"
                    >
                      <Trash2 size={10} />
                      删
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {profiles.length === 0 && (
              <div className="sm:col-span-2 text-center text-[11px] text-slate-500 py-4 border border-dashed border-slate-200 rounded-xl">
                暂无配置档，请在下方填写后保存，或点「新增模型」
              </div>
            )}
          </div>
        </div>

        {/* 固定结果条：保存/测试成功只在此提示，绝不跳转工作台 */}
        {saveStatusMsg && (
          <div
            ref={statusBannerRef}
            role="status"
            className={`rounded-xl border px-3.5 py-2.5 text-xs font-semibold flex items-start justify-between gap-3 ${
              saveStatusMsg.includes('✅')
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                : saveStatusMsg.includes('⏳')
                  ? 'border-slate-300 bg-slate-50 text-slate-800'
                  : saveStatusMsg.includes('⚠️') || saveStatusMsg.includes('🩺')
                    ? 'border-amber-300 bg-amber-50 text-amber-950'
                    : saveStatusMsg.includes('❌')
                      ? 'border-red-300 bg-red-50 text-red-900'
                      : 'border-slate-200 bg-white text-slate-800'
            }`}
          >
            <span className="leading-relaxed">{saveStatusMsg}</span>
            <button
              type="button"
              className="shrink-0 text-[11px] opacity-70 hover:opacity-100"
              onClick={() => setSaveStatusMsg('')}
            >
              关闭
            </button>
          </div>
        )}

        <div
          className="grid grid-cols-1 md:grid-cols-2 gap-6"
          onKeyDown={(e) => {
            // 禁止回车触发表单式跳转；Ctrl/Cmd+Enter 保存
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void handleSaveBackendConfig(e);
            }
          }}
        >
          <div className="md:col-span-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
            <span className="font-bold text-slate-800">
              {editingProfileId ? '编辑配置档' : '新建配置档'}
            </span>
            {editingProfileId && (
              <span className="font-mono text-slate-500">id: {editingProfileId}</span>
            )}
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                配置档名称
              </label>
              <input
                type="text"
                value={inputProfileName}
                onChange={(e) => setInputProfileName(e.target.value)}
                placeholder="如：DeepSeek 主写 / GPT 润色 / 本地中转"
                className="w-full bg-white border border-slate-300 rounded-xl px-3.5 py-2.5 text-sm text-slate-900 focus:border-neutral-900 focus:outline-none shadow-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                服务商类型
              </label>
              <select
                value={inputProvider}
                onChange={(e) => {
                  const next = e.target.value as
                    | 'openai'
                    | 'deepseek'
                    | 'custom'
                    | 'anthropic'
                    | 'local';
                  setInputProvider(next);
                  // 切换类型时，若地址为空或仍是其他类型的示例地址，自动换成对应默认值
                  const knownDefaults = [
                    'https://api.deepseek.com',
                    'https://api.openai.com/v1',
                    'https://api.openai.com',
                    'https://api.anthropic.com',
                    'http://127.0.0.1:11434/v1',
                    'http://127.0.0.1:1234/v1',
                  ];
                  if (!inputBaseURL.trim() || knownDefaults.includes(inputBaseURL.trim())) {
                    setInputBaseURL(PROVIDER_DEFAULT_BASE_URL[next]);
                  }
                }}
                className="w-full bg-white border border-slate-300 rounded-xl px-3.5 py-2.5 text-sm text-slate-900 focus:border-neutral-900 focus:outline-none shadow-sm"
              >
                <option value="deepseek">DeepSeek</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic（Claude）</option>
                <option value="local">本地模型（Ollama / LM Studio 等）</option>
                <option value="custom">自定义 / 中转（OpenAI 兼容）</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5 flex items-center justify-between">
                <span>API Base URL (接口路径地址)</span>
                <span className="text-[11px] text-slate-500 font-normal">
                  {inputProvider === 'anthropic'
                    ? 'Anthropic 官方或兼容网关地址'
                    : inputProvider === 'local'
                      ? '本地服务地址，如 Ollama / LM Studio'
                      : '支持 DeepSeek/OpenAI 及各类中转接口'}
                </span>
              </label>
              <input
                type="text"
                value={inputBaseURL}
                onChange={(e) => setInputBaseURL(e.target.value)}
                placeholder={PROVIDER_DEFAULT_BASE_URL[inputProvider]}
                className="w-full bg-white border border-slate-300 rounded-xl px-3.5 py-2.5 text-sm text-slate-900 focus:border-neutral-900 focus:outline-none shadow-sm"
              />
              {inputProvider === 'local' && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                  本地服务通常无需 API Key，留空即可；Ollama 默认
                  http://127.0.0.1:11434/v1，LM Studio 默认 http://127.0.0.1:1234/v1。
                </p>
              )}
              {inputProvider === 'anthropic' && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                  使用 Anthropic Messages 接口（/v1/messages），需 sk-ant- 开头的 API Key。
                </p>
              )}
              {thirdPartyHost(inputBaseURL) && (
                <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    非官方端点（{thirdPartyHost(inputBaseURL)}）：生成时
                    <b>章节正文、设定与记忆会全文发送到该服务器</b>
                    ，作品数据本身仍只存本地，但请仅在信任该中转服务时使用。
                  </span>
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5 flex items-center justify-between gap-2">
                <span>Model Name (模型名称)</span>
                <button
                  type="button"
                  onClick={handleRefreshModels}
                  disabled={isLoadingModels || isSavingConfig || isDoctorRunning}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-neutral-700 hover:text-neutral-900 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="按当前 Base URL 与 API Key 调用服务商 /models 接口刷新列表"
                >
                  {isLoadingModels ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3 h-3" />
                  )}
                  <span>{isLoadingModels ? '拉取中…' : '刷新模型列表'}</span>
                </button>
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  list="llm-model-options"
                  value={inputModelName}
                  onChange={(e) => setInputModelName(e.target.value)}
                  placeholder="deepseek-chat 或点刷新后选择"
                  className="flex-1 min-w-0 bg-white border border-slate-300 rounded-xl px-3.5 py-2.5 text-sm text-slate-900 focus:border-neutral-900 focus:outline-none shadow-sm font-mono"
                />
                <button
                  type="button"
                  onClick={handleRefreshModels}
                  disabled={isLoadingModels || isSavingConfig || isDoctorRunning}
                  className="shrink-0 px-3 py-2.5 rounded-xl border border-black bg-black text-white text-xs font-bold hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                  title="刷新可用模型名称"
                >
                  {isLoadingModels ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  刷新
                </button>
              </div>
              <datalist id="llm-model-options">
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.owned_by ? `${m.id} · ${m.owned_by}` : m.id}
                  </option>
                ))}
              </datalist>
              {modelsHint && (
                <p className="text-[11px] text-slate-600 mt-1.5 leading-relaxed">{modelsHint}</p>
              )}
              {modelOptions.length > 0 && (
                <div className="mt-2 max-h-36 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 space-y-0.5">
                  {modelOptions.map((m) => {
                    const active = m.id === inputModelName;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          setInputModelName(m.id);
                          setModelsHint(`已选择模型：${m.id}（记得点「保存服务端参数配置」生效）`);
                        }}
                        className={`w-full text-left px-2.5 py-1.5 rounded-lg text-[11px] font-mono transition-colors ${
                          active
                            ? 'bg-black text-white'
                            : 'text-slate-800 hover:bg-slate-100'
                        }`}
                      >
                        <span className="font-semibold">{m.id}</span>
                        {m.owned_by && (
                          <span className={`ml-2 ${active ? 'text-white/70' : 'text-slate-500'}`}>
                            {m.owned_by}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {modelOptions.length === 0 && !isLoadingModels && (
                <p className="text-[11px] text-slate-500 mt-1 font-normal">
                  填写 Base URL 与 API Key 后点「刷新」，可从服务商拉取可选模型名。
                </p>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-amber-800 mb-1.5 flex items-center justify-between">
                <span>
                  {inputProvider === 'local'
                    ? 'API Key (本地服务可留空)'
                    : 'API Key (大模型密钥 - 服务端加密存储)'}
                </span>
                {backendConfig?.hasKey && (
                  <span className="text-[11px] text-emerald-700 flex items-center space-x-1 font-semibold">
                    <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                    <span>系统已绑定有效密钥</span>
                  </span>
                )}
              </label>
              <input
                type="password"
                value={inputApiKey}
                onChange={(e) => setInputApiKey(e.target.value)}
                placeholder="sk-xxxxxxxxxxxxxxxxxxxxxxxx"
                className="w-full bg-white border border-amber-300 rounded-xl px-3.5 py-2.5 text-sm text-amber-900 focus:border-amber-600 focus:outline-none shadow-sm font-mono"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                🔒 为保障您的密钥安全，API Key 仅在 Node 后端服务器运行或保存时处理，网络数据抓包及前端 LocalStorage 中均绝不留存明文。
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5 flex items-center justify-between">
                <span>创作创造力温度 (Temperature): <strong className="text-neutral-800">{inputTemperature}</strong></span>
                <span className="text-[11px] text-slate-500">数值越高创意越丰富</span>
              </label>
              <input
                type="range"
                min={0.1}
                max={1.3}
                step={0.05}
                value={inputTemperature}
                onChange={(e) => setInputTemperature(Number(e.target.value))}
                className="w-full accent-neutral-900 mt-2 cursor-pointer"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5 flex items-center justify-between">
                <span>输出预算 (max_tokens)</span>
                <span className="text-[11px] text-slate-500">留空或 0 = 默认 8192</span>
              </label>
              <input
                type="number"
                min={0}
                step={1024}
                value={inputMaxTokens}
                onChange={(e) => setInputMaxTokens(e.target.value)}
                placeholder="默认 8192"
                className="w-full bg-white border border-slate-300 rounded-xl px-3.5 py-2.5 text-sm text-slate-900 focus:border-neutral-900 focus:outline-none shadow-sm font-mono"
              />
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                单次生成的总输出上限（正文 + 思考共用）。使用思考模型（DeepSeek-R1 /
                GLM 思考 / MiniMax-M3 等）建议 16384 以上，否则思考可能烧尽预算导致空稿报错。
              </p>
            </div>
          </div>

          <div className="md:col-span-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 border-t border-slate-200">
            <p className="text-[11px] text-slate-500">
              保存/测试只更新本页提示，不会跳转创作台。Ctrl+Enter 亦可保存。
            </p>
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <button
                type="button"
                disabled={isDoctorRunning || isSavingConfig}
                onClick={(e) => void handleRunDoctor(e)}
                className="px-5 py-2.5 bg-black hover:bg-neutral-800 text-white border border-black font-bold rounded-xl shadow-sm flex items-center space-x-2 text-sm transition-all disabled:opacity-50"
                title="检测后端、API Key、文本/JSON/流式连通"
              >
                {isDoctorRunning ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Stethoscope className="w-4 h-4" />
                )}
                <span>{isDoctorRunning ? '诊断中（会真实调模型）…' : '一键 Doctor 诊断'}</span>
              </button>
              <button
                type="button"
                disabled={isSavingConfig || isDoctorRunning}
                onClick={(e) => void handleSaveBackendConfig(e)}
                className="px-6 py-2.5 bg-black hover:bg-neutral-800 text-white font-bold rounded-xl shadow-md flex items-center space-x-2 text-sm transition-all disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                <span>
                  {isSavingConfig
                    ? '服务端加密保存中...'
                    : editingProfileId
                      ? '保存当前配置档'
                      : '新建并保存配置档'}
                </span>
              </button>
            </div>
          </div>
        </div>

        </div>
      )}
      {/* 按角色路由模型 + 向量检索 API（合并卡：写作用强模型、审校用轻量模型） */}
      {activeSection === 'routing' && (
        <div
          id="sec-llm-routing"
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-3"
        >
          <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-3">
            <div className="flex items-start gap-2 min-w-0">
              <Sliders className="w-4 h-4 text-neutral-800 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-slate-900">按角色路由模型</h3>
                <p className="text-[11px] text-slate-600 mt-0.5 leading-relaxed">
                  为不同创作角色指定不同配置档（Base URL / 模型 / Key 整体切换）——
                  例如写作用强模型、审校与记忆回写用便宜模型。未指定的角色跟随当前启用档；
                  关闭总开关则全部走当前启用档。
                </p>
              </div>
            </div>
            <label className="inline-flex items-center gap-2 text-xs font-bold text-slate-900 cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={routingEnabled}
                onChange={(e) => setRoutingEnabled(e.target.checked)}
                className="accent-neutral-900"
              />
              启用路由
            </label>
          </div>
          {routingEnabled && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
              {ALL_LLM_ROLES.map((role) => {
                const configured = routingRoutes[role];
                // 指向已删除配置档的路由：显示为「跟随激活档」，保存时清空
                const value =
                  configured && profiles.some((p) => p.id === configured)
                    ? configured
                    : '';
                return (
                  <label
                    key={role}
                    className="grid grid-cols-[112px_minmax(0,1fr)] items-center gap-2 text-xs"
                  >
                    <span className="font-semibold text-slate-700 shrink-0">
                      {ROLE_LABELS[role]}
                    </span>
                    <select
                      value={value}
                      onChange={(e) =>
                        setRoutingRoutes((prev) => ({
                          ...prev,
                          [role]: e.target.value || undefined,
                        }))
                      }
                      className="flex-1 min-w-0 bg-white border border-slate-300 rounded-lg px-2 py-1.5 text-xs text-slate-900 focus:border-neutral-900 focus:outline-none"
                    >
                      <option value="">跟随激活档</option>
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}（{p.modelName}）
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <p className="text-[11px] text-slate-500">
              {profiles.length === 0
                ? '尚未加载到配置档；请先到左侧「模型配置 · Doctor」新增并保存。'
                : '配置档被删除的角色自动回落「跟随激活档」，保存时清空对应路由。'}
            </p>
            <button
              type="button"
              disabled={isSavingConfig}
              onClick={handleSaveRoleRouting}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-black bg-black text-white text-xs font-bold hover:bg-neutral-800 disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              保存路由
            </button>
          </div>

          {/* ── 向量检索 API（Embedding）：并入本卡片 ── */}
          <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-4 space-y-4">
          <div className="flex items-center justify-between gap-2 border-b border-violet-200/80 pb-3">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-violet-700" />
              <div>
                <h3 className="text-sm font-bold text-violet-950">向量检索 API（Embedding）</h3>
                <p className="text-[11px] text-violet-900/70 mt-0.5">
                  OpenAI 兼容 /v1/embeddings。启用后写章前的记忆/伏笔/相关章检索改用
                  <b>真·向量检索</b>：文档向量缓存在本地、仅新增内容与查询调用 API；
                  未启用或调用失败时自动降级本地 TF-IDF（n-gram），写作不中断。费用极低，不计入 LLM 预算。
                </p>
              </div>
            </div>
            <label className="inline-flex items-center gap-2 text-xs font-bold text-violet-950 cursor-pointer">
              <input
                type="checkbox"
                checked={embEnabled}
                onChange={(e) => setEmbEnabled(e.target.checked)}
                className="accent-violet-700"
              />
              启用向量检索
            </label>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="md:col-span-2 inline-flex items-center gap-2 text-xs text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={embUseSame}
                onChange={(e) => setEmbUseSame(e.target.checked)}
                className="accent-violet-700"
              />
              与当前启用 LLM 共用 Base URL 与 API Key（推荐）
            </label>
            {!embUseSame && (
              <>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Embedding Base URL
                  </label>
                  <input
                    type="text"
                    value={embBaseURL}
                    onChange={(e) => setEmbBaseURL(e.target.value)}
                    placeholder="https://api.openai.com/v1"
                    className="w-full bg-white border border-violet-200 rounded-lg px-3 py-2 text-sm font-mono"
                  />
                  {thirdPartyHost(embBaseURL) && (
                    <p className="mt-1.5 text-[11px] leading-relaxed text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                      ⚠️ 非官方端点（{thirdPartyHost(embBaseURL)}）：检索文本（设定/梗概/章摘要）会发送到该服务器，请确认信任。
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Embedding API Key
                  </label>
                  <input
                    type="password"
                    value={embApiKey}
                    onChange={(e) => setEmbApiKey(e.target.value)}
                    placeholder="可与聊天 Key 不同"
                    className="w-full bg-white border border-violet-200 rounded-lg px-3 py-2 text-sm font-mono"
                  />
                </div>
              </>
            )}
            <div>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                Embedding 模型名
              </label>
              <input
                type="text"
                value={embModel}
                onChange={(e) => setEmbModel(e.target.value)}
                placeholder="text-embedding-3-small"
                className="w-full bg-white border border-violet-200 rounded-lg px-3 py-2 text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                维度 dimensions（可选）
              </label>
              <input
                type="text"
                value={embDims}
                onChange={(e) => setEmbDims(e.target.value)}
                placeholder="留空=服务商默认"
                className="w-full bg-white border border-violet-200 rounded-lg px-3 py-2 text-sm font-mono"
              />
            </div>
          </div>
          {embConfig && (
            <p className="text-[10px] text-slate-600 font-mono">
              解析后 Base：{embConfig.resolvedBaseURL || '—'} · Key{' '}
              {embConfig.resolvedHasKey ? '就绪' : '缺失'} · 状态{' '}
              {embConfig.enabled ? '已启用' : '未启用'}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={embBusy}
              onClick={(e) => void handleSaveEmbedding(e)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-black text-white text-xs font-bold hover:bg-neutral-800 disabled:opacity-50"
            >
              <Save size={13} />
              保存向量配置
            </button>
            <button
              type="button"
              disabled={embBusy}
              onClick={(e) => void handleTestEmbedding(e)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-violet-400 bg-white text-violet-950 text-xs font-bold hover:bg-violet-50 disabled:opacity-50"
            >
              {embBusy ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Stethoscope size={13} />
              )}
              测试 Embedding 连通
            </button>
          </div>
          {saveStatusMsg &&
            (saveStatusMsg.includes('Embedding') ||
              saveStatusMsg.includes('向量') ||
              saveStatusMsg.includes('embedding') ||
              saveStatusMsg.includes('Embedding')) && (
              <p
                className={`text-xs font-semibold ${
                  saveStatusMsg.includes('✅')
                    ? 'text-emerald-800'
                    : saveStatusMsg.includes('❌')
                      ? 'text-red-700'
                      : 'text-slate-700'
                }`}
              >
                {saveStatusMsg}
              </p>
            )}
          </div>
        </div>
      )}
      {activeSection === 'models' && (
        <>
        {/* Doctor 报告 */}
        {doctorReport && (
          <div
            className={`rounded-xl border p-4 space-y-3 ${
              doctorReport.overall === 'healthy'
                ? 'border-emerald-200 bg-emerald-50/60'
                : doctorReport.overall === 'degraded'
                  ? 'border-amber-200 bg-amber-50/60'
                  : 'border-red-200 bg-red-50/60'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <Stethoscope
                  className={`w-5 h-5 ${
                    doctorReport.overall === 'healthy'
                      ? 'text-emerald-700'
                      : doctorReport.overall === 'degraded'
                        ? 'text-amber-700'
                        : 'text-red-700'
                  }`}
                />
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    Doctor 报告 · {overallLabel(doctorReport.overall)}
                  </h3>
                  <p className="text-[11px] text-slate-500 font-mono mt-0.5">
                    {new Date(doctorReport.checkedAt).toLocaleString()} ·{' '}
                    {doctorReport.configSummary.modelName || '—'} @{' '}
                    {doctorReport.configSummary.baseURL || '—'}
                  </p>
                </div>
              </div>
              <span
                className={`text-[10px] font-bold px-2 py-1 rounded-full border ${
                  doctorReport.ok
                    ? 'bg-white border-emerald-300 text-emerald-800'
                    : 'bg-white border-red-300 text-red-800'
                }`}
              >
                {doctorReport.ok ? '可写章' : '勿开写'}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-1.5">
              {doctorReport.checks.map((c) => (
                <div
                  key={c.id}
                  className={`flex items-start gap-2 px-2.5 py-2 rounded-lg border text-xs ${statusRowClass(c.status)}`}
                >
                  {statusIcon(c.status)}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900">{c.name}</span>
                      {c.durationMs != null && (
                        <span className="text-[10px] text-slate-400 font-mono shrink-0">
                          {c.durationMs}ms
                        </span>
                      )}
                    </div>
                    <p className="text-slate-700 mt-0.5 leading-relaxed">{c.message}</p>
                    {c.detail && (
                      <p className="text-[10px] text-slate-500 mt-0.5 font-mono break-all line-clamp-2">
                        {c.detail}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {doctorReport.suggestions.length > 0 && (
              <div className="bg-white/80 border border-slate-200 rounded-lg px-3 py-2">
                <div className="text-[11px] font-bold text-slate-800 mb-1">建议</div>
                <ul className="space-y-1">
                  {doctorReport.suggestions.map((s, i) => (
                    <li key={i} className="text-[11px] text-slate-600 leading-relaxed flex gap-1.5">
                      <span className="text-slate-400 font-bold shrink-0">{i + 1}.</span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        </>
      )}

      </div>

      {/* ── 分组二：写作引擎（题材包 / 全书与单章目标 / 日更目标 / 跨章抽检节奏 / Auto-Pilot 默认参数）── */}
      <div className="space-y-12 scroll-mt-14">
      {activeSection === 'genre' && projectConfig && onUpdateGenre && (
        <div id="sec-genre">
          <GenrePackPanel
            genre={genre || projectConfig.genre || ''}
            config={projectConfig}
            onChangeGenre={onUpdateGenre}
            onSaveOverride={onSaveGenreOverride}
          />
        </div>
      )}

      {activeSection === 'targets' && (
        <SettingsTargetsSection
          styleConfig={styleConfig}
          onUpdateStyleConfig={onUpdateStyleConfig}
          projectConfig={projectConfig}
          onUpdateProjectConfig={onUpdateProjectConfig}
        />
      )}

      {/* Auto-Pilot 默认参数 */}
      {activeSection === 'autopilot' && (
        <SettingsAutopilotSection
          styleConfig={styleConfig}
          onUpdateStyleConfig={onUpdateStyleConfig}
        />
      )}

      </div>

      {/* ── 分组三：文风纪律（核心文风开关 / 黑名单 / 去AI味 / 文风仿写 / 样本库）── */}
      <div className="space-y-12 scroll-mt-14">
      {/* 核心文风 · 风格样本库 */}
      {activeSection === 'core-switch' && (
        <SettingsCoreStyleSection
          styleConfig={styleConfig}
          onUpdateStyleConfig={onUpdateStyleConfig}
        />
      )}

      {/* 黑名单管理 */}
      {activeSection === 'blacklist' && (
        <SettingsBlacklistSection
          styleConfig={styleConfig}
          onUpdateStyleConfig={onUpdateStyleConfig}
          newBlacklistWord={newBlacklistWord}
          setNewBlacklistWord={setNewBlacklistWord}
          newWhitelistWord={newWhitelistWord}
          setNewWhitelistWord={setNewWhitelistWord}
        />
      )}

      {activeSection === 'imitate' && (
      <div id="sec-imitate">
        {!(styleConfig.styleProfiles || []).length && onRecoverStyleProfiles && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="text-xs text-amber-950">
              <div className="font-bold">当前没有文风仿写档案</div>
              <p className="text-[11px] text-amber-900/80 mt-0.5">
                若你曾导入过，可能被其它配置覆盖。可尝试从本书快照找回，或重新粘贴样本分析导入。
              </p>
            </div>
            <button
              type="button"
              onClick={() => onRecoverStyleProfiles()}
              className="shrink-0 px-3 py-2 rounded-lg bg-black text-white text-[11px] font-bold hover:bg-neutral-800"
            >
              从快照恢复文风
            </button>
          </div>
        )}
        <StyleImitatePanel
          styleConfig={styleConfig}
          onUpdateStyleConfig={onUpdateStyleConfig}
          onDeleteStyleProfile={onDeleteStyleProfile}
        />
      </div>
      )}
      </div>
      </div>
    </div>
    </div>
  );
};
