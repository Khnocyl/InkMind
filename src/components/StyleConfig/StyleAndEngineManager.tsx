import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectConfig, StyleConfig, LlmRole, LlmRoleRouting } from '../../types/novel';
import {
  Plus,
  Trash2,
  Cpu,
  CheckCircle2,
  Sliders,
  Eye,
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
  Sun,
  Moon,
  Monitor,
  Palette,
  Check,
  Sparkles,
  ExternalLink,
  ShieldCheck,
} from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import {
  checkForAppUpdates,
  CURRENT_APP_VERSION,
  GITHUB_REPO,
  GITHUB_RELEASES_URL,
  type CheckUpdateResult,
} from '../../services/appUpdate';

import {
  getLLMConfig,
  saveLLMConfig,
  fetchLLMModels,
  listLLMProfiles,
  upsertLLMProfile,
  activateLLMProfile,
  deleteLLMProfile,
  getEmbeddingConfig,
  saveEmbeddingConfigApi,
  testEmbeddingApi,
  type BackendLLMConfig,
  type LLMModelInfo,
  type LLMProfilePublic,
  type EmbeddingConfigPublic,
} from '../../services/llmClient';
import { invalidateEmbeddingConfigCache } from '../../services/embeddingIndex';
import { resolveChapterWordTarget } from '../../services/proseWords';
import { ALL_LLM_ROLES, ROLE_LABELS } from '../../services/llmRouting';

/**
 * 常见模型官方 API 域名。Base URL 落在名单外时视为第三方中转——
 * 写作正文/设定/记忆会全文发送到该端点，UI 需给出隐私提醒。
 */
const OFFICIAL_LLM_HOSTS = new Set([
  'api.deepseek.com',
  'api.moonshot.cn',
  'open.bigmodel.cn',
  'api.siliconflow.cn',
  'api.openai.com',
  'api.anthropic.com',
  'dashscope.aliyuncs.com',
  'api.minimax.chat',
  'api.lingyiwanwu.com',
]);

/** 返回第三方中转域名；官方端点/空/非法 URL 返回 null */
function thirdPartyHost(baseURL: string): string | null {
  const t = (baseURL || '').trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    return OFFICIAL_LLM_HOSTS.has(u.hostname) ? null : u.hostname;
  } catch {
    return null;
  }
}
import {
  runDoctorClient,
  overallLabel,
  type DoctorReport,
  type DoctorCheckStatus,
} from '../../services/doctorClient';
import { GenrePackPanel } from './GenrePackPanel';
import { StyleImitatePanel } from './StyleImitatePanel';

interface StyleAndEngineManagerProps {
  styleConfig: StyleConfig;
  onUpdateStyleConfig: (
    config: StyleConfig | ((prev: StyleConfig) => StyleConfig)
  ) => Promise<void> | void;
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
  onNotifyStatus,
  onRecoverStyleProfiles,
  genre,
  projectConfig,
  onUpdateGenre,
  onUpdateProjectConfig,
  onSaveGenreOverride,
}) => {
  const [newBlacklistWord, setNewBlacklistWord] = useState('');
  const [newWhitelistWord, setNewWhitelistWord] = useState('');
  const [backendConfig, setBackendConfig] = useState<BackendLLMConfig | null>(null);
  const [profiles, setProfiles] = useState<LLMProfilePublic[]>([]);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [inputProfileName, setInputProfileName] = useState('默认 DeepSeek');
  const [inputProvider, setInputProvider] = useState<'openai' | 'deepseek' | 'custom'>('deepseek');
  const [inputApiKey, setInputApiKey] = useState('');
  const [inputBaseURL, setInputBaseURL] = useState('https://api.deepseek.com');
  const [inputModelName, setInputModelName] = useState('deepseek-chat');
  const [inputTemperature, setInputTemperature] = useState(0.7);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [saveStatusMsg, setSaveStatusMsg] = useState('');
  const [isDoctorRunning, setIsDoctorRunning] = useState(false);
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [modelOptions, setModelOptions] = useState<LLMModelInfo[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsHint, setModelsHint] = useState<string | null>(null);
  const [embConfig, setEmbConfig] = useState<EmbeddingConfigPublic | null>(null);
  const [embEnabled, setEmbEnabled] = useState(false);
  const [embUseSame, setEmbUseSame] = useState(true);
  const [embBaseURL, setEmbBaseURL] = useState('');
  const [embModel, setEmbModel] = useState('text-embedding-3-small');
  const [embDims, setEmbDims] = useState('');
  const [embApiKey, setEmbApiKey] = useState('');
  const [embBusy, setEmbBusy] = useState(false);
  // 按角色路由模型：草稿态（保存时统一写回 + 清掉指向已删档的路由）
  const [routingEnabled, setRoutingEnabled] = useState(
    styleConfig.llmRoleRouting?.enabled === true
  );
  const [routingRoutes, setRoutingRoutes] = useState<Partial<Record<LlmRole, string>>>(
    () => styleConfig.llmRoleRouting?.routes || {}
  );
  /** 浮动 Toast（固定视口，刷新后仍可从 session 恢复） */
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  /** 左侧目录当前选中项（sticky 选中态；仅视图状态） */
  const [activeSection, setActiveSection] = useState<string>('models');
  const { mode: currentThemeMode, resolvedTheme, setThemeMode } = useTheme();
  const [updateCheckState, setUpdateCheckState] = useState<{
    isChecking: boolean;
    result: CheckUpdateResult | null;
  }>({
    isChecking: false,
    result: null,
  });

  const handleCheckUpdate = async () => {
    setUpdateCheckState({ isChecking: true, result: null });
    try {
      const res = await checkForAppUpdates();
      setUpdateCheckState({ isChecking: false, result: res });
    } catch (err) {
      setUpdateCheckState({
        isChecking: false,
        result: {
          status: 'error',
          currentVersion: CURRENT_APP_VERSION,
          errorMsg: err instanceof Error ? err.message : String(err),
          releaseUrl: GITHUB_RELEASES_URL,
        },
      });
    }
  };
  const doctorSectionRef = React.useRef<HTMLDivElement>(null);
  const statusBannerRef = React.useRef<HTMLDivElement>(null);
  const toastTimerRef = React.useRef<number | null>(null);

  const STATUS_KEY = 'novel-engine-status-v1';

  /** 页内横幅 + 顶栏 Toast + App 状态条；写入 session，防止热重载丢结果 */
  /** 设置面板提示闸门：仅允许 Doctor 诊断相关的提示出现，其他设置操作保持静默无打扰 */
  const pushStatus = (msg: string) => {
    // 严格过滤：除 Doctor 诊断提示外，其他一律不展示弹窗与横幅
    if (!/doctor/i.test(msg)) {
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

  const applyProfiles = (list: LLMProfilePublic[], activeId?: string) => {
    setProfiles(list);
    const active =
      list.find((p) => p.id === activeId) || list.find((p) => p.isActive) || list[0];
    if (active) {
      setEditingProfileId(active.id);
      setInputProfileName(active.name);
      setInputProvider(
        (active.provider as 'openai' | 'deepseek' | 'custom') || 'custom'
      );
      setInputBaseURL(active.baseURL || '');
      setInputModelName(active.modelName || '');
      setInputTemperature(active.temperature ?? 0.7);
      setInputApiKey(active.hasKey && active.maskedKey ? active.maskedKey : '');
    }
  };

  const loadAllEngineConfig = async () => {
    try {
      const cfg = await getLLMConfig();
      setBackendConfig(cfg);
      if (cfg.profiles?.length) {
        applyProfiles(cfg.profiles, cfg.activeProfileId);
      } else {
        const pl = await listLLMProfiles();
        applyProfiles(pl.profiles, pl.activeProfileId);
      }
    } catch (err) {
      console.error('获取 LLM 后端配置失败:', err);
    }
    try {
      const emb = await getEmbeddingConfig();
      setEmbConfig(emb);
      setEmbEnabled(emb.enabled);
      setEmbUseSame(emb.useSameAsLlm);
      setEmbBaseURL(emb.baseURL || '');
      setEmbModel(emb.modelName || 'text-embedding-3-small');
      setEmbDims(emb.dimensions != null ? String(emb.dimensions) : '');
      setEmbApiKey(emb.hasKey && emb.maskedKey ? emb.maskedKey : '');
    } catch (err) {
      console.error('获取 Embedding 配置失败:', err);
    }
  };

  useEffect(() => {
    void loadAllEngineConfig();
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

  // styleConfig.llmRoleRouting 外部变更（切书/快照恢复/保存写回）时同步草稿
  useEffect(() => {
    setRoutingEnabled(styleConfig.llmRoleRouting?.enabled === true);
    setRoutingRoutes(styleConfig.llmRoleRouting?.routes || {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleConfig.llmRoleRouting]);

  /** 保存按角色路由：只保留指向现存配置档的路由（已删档自动清空 = 跟随激活档） */
  const handleSaveRoleRouting = () => {
    const validIds = new Set(profiles.map((p) => p.id));
    const routes: Partial<Record<LlmRole, string>> = {};
    for (const role of ALL_LLM_ROLES) {
      const id = routingRoutes[role];
      if (id && validIds.has(id)) routes[role] = id;
    }
    const next: LlmRoleRouting = { enabled: routingEnabled, routes };
    void onUpdateStyleConfig({ ...styleConfig, llmRoleRouting: next });
    pushStatus(
      routingEnabled
        ? `🔀 按角色路由已保存（${Object.keys(routes).length} 个角色指定配置档）`
        : '按角色路由已关闭：全部跟随当前启用档'
    );
  };

  const handleSaveBackendConfig = async (e?: React.SyntheticEvent) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setIsSavingConfig(true);
    pushStatus('⏳ 正在保存模型配置…');
    try {
      const keepEditId = editingProfileId;
      if (editingProfileId) {
        const pl = await upsertLLMProfile({
          id: editingProfileId,
          name: inputProfileName.trim() || '未命名模型',
          provider: inputProvider,
          baseURL: inputBaseURL.trim(),
          modelName: inputModelName.trim(),
          temperature: inputTemperature,
          apiKey: inputApiKey.startsWith('sk-****') ? undefined : inputApiKey,
          activate: false,
        });
        applyProfiles(pl.profiles, pl.activeProfileId);
        // 保持正在编辑的档，不要被 active 抢走焦点
        const edited = pl.profiles.find((p) => p.id === keepEditId);
        if (edited) handleSelectProfileForEdit(edited);
        const active = pl.profiles.find((p) => p.isActive);
        if (active) {
          setBackendConfig({
            provider: (active.provider as BackendLLMConfig['provider']) || 'custom',
            baseURL: active.baseURL,
            modelName: active.modelName,
            temperature: active.temperature,
            hasKey: active.hasKey,
            maskedKey: active.maskedKey,
            activeProfileId: pl.activeProfileId,
            activeProfileName: active.name,
            profiles: pl.profiles,
          });
        }
      } else {
        // 防误建：已存在「名称 + Base URL + 模型」完全相同的配置档时不再新建，
        // 避免点「新增模型」后原样重填保存悄悄多出一张重复卡
        const dup = profiles.find(
          (p) =>
            p.name === (inputProfileName.trim() || '新模型') &&
            p.baseURL === inputBaseURL.trim() &&
            p.modelName === inputModelName.trim()
        );
        if (dup) {
          pushStatus(
            `⚠️ 已有完全相同的配置档「${dup.name}」（同 Base URL + 模型）。要改它请点该卡片编辑；确要新建请换个名称。`
          );
          return;
        }
        const pl = await upsertLLMProfile({
          name: inputProfileName.trim() || '新模型',
          provider: inputProvider,
          baseURL: inputBaseURL.trim(),
          modelName: inputModelName.trim(),
          temperature: inputTemperature,
          apiKey: inputApiKey.startsWith('sk-****') ? undefined : inputApiKey,
          activate: profiles.length === 0,
        });
        applyProfiles(pl.profiles, pl.activeProfileId);
        const created =
          pl.profiles.find((p) => p.name === (inputProfileName.trim() || '新模型')) ||
          pl.profiles[pl.profiles.length - 1];
        if (created) handleSelectProfileForEdit(created);
      }
      const editingIsActive = profiles.find((p) => p.id === keepEditId)?.isActive;
      // 仅当编辑的就是当前启用档才同步旧接口；新建配置档绝不能反写启用档
      //（否则 saveStoredConfig 会把启用档整体改成本档表单值的克隆）
      if (keepEditId && editingIsActive) {
        await saveLLMConfig({
          provider: inputProvider,
          baseURL: inputBaseURL.trim(),
          modelName: inputModelName.trim(),
          temperature: inputTemperature,
          apiKey: inputApiKey.startsWith('sk-****') ? undefined : inputApiKey,
          name: inputProfileName.trim() || undefined,
        }).catch(() => null);
      }
      pushStatus(
        `✅ 保存成功 ·「${inputProfileName.trim() || '配置档'}」已加密写入服务端。点「启用」可切换写作用模型。`
      );
    } catch (err: any) {
      pushStatus(`❌ 保存失败: ${err?.message || err}`);
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleActivateProfile = async (id: string) => {
    setIsSavingConfig(true);
    pushStatus('⏳ 正在启用模型…');
    try {
      const pl = await activateLLMProfile(id);
      applyProfiles(pl.profiles, pl.activeProfileId);
      const active = pl.profiles.find((p) => p.id === id);
      pushStatus(
        `✅ 已启用「${active?.name || id}」· ${active?.modelName || ''} — 后续写作走此模型`
      );
    } catch (err: any) {
      pushStatus(`❌ 启用失败: ${err?.message || err}`);
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleDeleteProfile = async (id: string) => {
    const p = profiles.find((x) => x.id === id);
    if (!window.confirm(`删除模型配置档「${p?.name || id}」？\n密钥一并删除，不可恢复。`)) {
      return;
    }
    setIsSavingConfig(true);
    try {
      const pl = await deleteLLMProfile(id);
      applyProfiles(pl.profiles, pl.activeProfileId);
      pushStatus('🗑️ 已删除配置档');
    } catch (err: any) {
      pushStatus(`❌ 删除失败: ${err?.message || err}`);
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleNewProfile = () => {
    setEditingProfileId(null);
    setInputProfileName('新模型');
    setInputProvider('custom');
    setInputBaseURL('https://api.openai.com/v1');
    setInputModelName('gpt-4o');
    setInputTemperature(0.7);
    setInputApiKey('');
    setModelOptions([]);
    setModelsHint('填写后保存，可再点「启用」切换到此档');
  };

  const handleSelectProfileForEdit = (p: LLMProfilePublic) => {
    setEditingProfileId(p.id);
    setInputProfileName(p.name);
    setInputProvider((p.provider as 'openai' | 'deepseek' | 'custom') || 'custom');
    setInputBaseURL(p.baseURL);
    setInputModelName(p.modelName);
    setInputTemperature(p.temperature ?? 0.7);
    setInputApiKey(p.hasKey && p.maskedKey ? p.maskedKey : '');
    setModelOptions([]);
  };

  const handleSaveEmbedding = async (e?: React.SyntheticEvent) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setEmbBusy(true);
    pushStatus('⏳ 正在保存向量检索配置…');
    try {
      const data = await saveEmbeddingConfigApi({
        enabled: embEnabled,
        useSameAsLlm: embUseSame,
        baseURL: embBaseURL.trim(),
        modelName: embModel.trim(),
        dimensions: embDims.trim() ? Number(embDims) : null,
        apiKey: embApiKey.startsWith('sk-****') ? undefined : embApiKey || undefined,
      });
      setEmbConfig(data);
      if (data.maskedKey) setEmbApiKey(data.maskedKey);
      invalidateEmbeddingConfigCache(); // 让检索端配置立即生效（不等 60s TTL）
      pushStatus(
        data.enabled
          ? '✅ 保存成功 · 向量检索 API 已启用'
          : '✅ 保存成功 · 向量配置已写入（当前未启用开关）'
      );
    } catch (err: any) {
      pushStatus(`❌ 向量配置保存失败: ${err?.message || err}`);
    } finally {
      setEmbBusy(false);
    }
  };

  const handleTestEmbedding = async (e?: React.SyntheticEvent) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setEmbBusy(true);
    pushStatus('⏳ 正在测试 Embedding 连通…');
    try {
      await saveEmbeddingConfigApi({
        enabled: embEnabled,
        useSameAsLlm: embUseSame,
        baseURL: embBaseURL.trim(),
        modelName: embModel.trim(),
        dimensions: embDims.trim() ? Number(embDims) : null,
        apiKey: embApiKey.startsWith('sk-****') ? undefined : embApiKey || undefined,
      });
      const r = await testEmbeddingApi();
      pushStatus(
        `✅ 测试成功 · Embedding 连通 · ${r.model} · dim=${r.dimensions} · ${r.latencyMs}ms · norm≈${r.sampleNorm}`
      );
      const emb = await getEmbeddingConfig();
      setEmbConfig(emb);
    } catch (err: any) {
      pushStatus(`❌ Embedding 测试失败: ${err?.message || err}`);
    } finally {
      setEmbBusy(false);
    }
  };

  const handleRunDoctor = async (e?: React.SyntheticEvent) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setIsDoctorRunning(true);
    setDoctorReport(null);
    pushStatus('⏳ Doctor 诊断中（会真实调模型）…');
    try {
      const { report } = await runDoctorClient();
      setDoctorReport(report);
      if (report?.overall === 'healthy') {
        pushStatus('✅ Doctor 成功：配置健康，可以开始写章');
      } else if (report?.overall === 'degraded') {
        pushStatus('⚠️ Doctor：部分能力异常，请查看下方报告（仍留在本页）');
      } else {
        pushStatus('❌ Doctor：配置不可用，请按建议修复');
      }
    } catch (err: any) {
      pushStatus(`❌ Doctor 失败: ${err?.message || err}`);
    } finally {
      setIsDoctorRunning(false);
    }
  };

  /** 从当前 Base URL + Key 刷新可用模型名（Key 未保存也可用表单明文探测） */
  const handleRefreshModels = async () => {
    setIsLoadingModels(true);
    setModelsHint(null);
    try {
      const result = await fetchLLMModels({
        baseURL: inputBaseURL.trim(),
        apiKey: inputApiKey.startsWith('sk-****') ? undefined : inputApiKey.trim() || undefined,
      });
      setModelOptions(result.models || []);
      const ids = (result.models || []).map((m) => m.id);
      // 当前模型不在列表里时保留手输值，仅提示
      if (inputModelName && ids.length && !ids.includes(inputModelName)) {
        setModelsHint(
          `已拉取 ${result.count} 个模型（${result.endpoint}）。当前「${inputModelName}」不在列表中，可点选下方切换，或继续手输。`
        );
      } else {
        setModelsHint(`已拉取 ${result.count} 个模型（${result.endpoint}）。点选即可填入模型名。`);
      }
      // 若当前为空且有结果，默认填第一个
      if (!inputModelName.trim() && ids[0]) {
        setInputModelName(ids[0]);
      }
      pushStatus(`✅ 模型列表已刷新：${result.count} 个（可点选填入）`);
    } catch (err: any) {
      setModelOptions([]);
      setModelsHint(null);
      pushStatus(`❌ 刷新模型失败: ${err?.message || err}`);
    } finally {
      setIsLoadingModels(false);
    }
  };

  const handleAddBlacklist = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBlacklistWord.trim()) return;
    onUpdateStyleConfig((prev) => {
      if ((prev.customBlacklist || []).includes(newBlacklistWord.trim())) return prev;
      return {
        ...prev,
        customBlacklist: [...(prev.customBlacklist || []), newBlacklistWord.trim()],
      };
    });
    setNewBlacklistWord('');
  };

  const handleRemoveCustomWord = (word: string) => {
    onUpdateStyleConfig((prev) => ({
      ...prev,
      customBlacklist: (prev.customBlacklist || []).filter((w) => w !== word),
    }));
  };

  const handleAddWhitelist = (e: React.FormEvent) => {
    e.preventDefault();
    const w = newWhitelistWord.trim();
    if (!w) return;
    onUpdateStyleConfig((prev) => {
      const list = prev.deslopWhitelist || [];
      if (list.includes(w)) return prev;
      return { ...prev, deslopWhitelist: [...list, w] };
    });
    setNewWhitelistWord('');
  };

  const handleRemoveWhitelist = (word: string) => {
    onUpdateStyleConfig((prev) => ({
      ...prev,
      deslopWhitelist: (prev.deslopWhitelist || []).filter((w) => w !== word),
    }));
  };

  const handleSelectExample = (id: string) => {
    onUpdateStyleConfig((prev) => ({
      ...prev,
      selectedExampleId: id,
    }));
  };

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
      {activeSection === 'appearance' && (
        <div
          id="sec-appearance"
          className="bg-slate-50 border border-slate-200 rounded-2xl p-6 shadow-md space-y-6 animate-fadeIn"
        >
          <div className="flex items-center justify-between border-b border-slate-200 pb-4">
            <div className="flex items-center space-x-2.5">
              <Palette className="w-5 h-5 text-neutral-800" />
              <div>
                <h2 className="text-base font-bold text-slate-900">外观设置 · 界面主题</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  个性化定制应用界面的深浅显示模式。支持跟随操作系统实时自动切换。
                </p>
              </div>
            </div>
            <div className="flex items-center space-x-2 text-xs font-semibold px-3 py-1 rounded-full bg-slate-200 text-slate-800 border border-slate-300">
              <span>当前生效：{resolvedTheme === 'dark' ? '🌙 深色模式' : '☀️ 浅色模式'}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* 跟随系统 */}
            <button
              type="button"
              onClick={() => {
                setThemeMode('system');
                pushStatus('✅ 外观设置已切换为：跟随系统（将自动随操作系统深浅切换）');
              }}
              className={`flex flex-col items-start p-4 rounded-xl border text-left transition-all cursor-pointer relative ${
                currentThemeMode === 'system'
                  ? 'border-neutral-900 bg-white ring-2 ring-neutral-900 shadow-md'
                  : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center justify-between w-full mb-3">
                <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-slate-800">
                  <Monitor className="w-5 h-5" />
                </div>
                {currentThemeMode === 'system' && (
                  <span className="flex items-center gap-1 text-[11px] font-bold text-neutral-900 bg-neutral-100 px-2 py-0.5 rounded-full">
                    <Check className="w-3.5 h-3.5" /> 已选
                  </span>
                )}
              </div>
              <div className="font-bold text-sm text-slate-900 mb-1">跟随系统</div>
              <p className="text-xs text-slate-500 leading-relaxed">
                自动检测并与操作系统的深浅色模式保持同步。系统主题切换时无需重启或刷新即时生效。
              </p>
            </button>

            {/* 浅色模式 */}
            <button
              type="button"
              onClick={() => {
                setThemeMode('light');
                pushStatus('✅ 外观设置已强制切换为：浅色模式');
              }}
              className={`flex flex-col items-start p-4 rounded-xl border text-left transition-all cursor-pointer relative ${
                currentThemeMode === 'light'
                  ? 'border-neutral-900 bg-white ring-2 ring-neutral-900 shadow-md'
                  : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center justify-between w-full mb-3">
                <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center text-amber-600">
                  <Sun className="w-5 h-5" />
                </div>
                {currentThemeMode === 'light' && (
                  <span className="flex items-center gap-1 text-[11px] font-bold text-neutral-900 bg-neutral-100 px-2 py-0.5 rounded-full">
                    <Check className="w-3.5 h-3.5" /> 已选
                  </span>
                )}
              </div>
              <div className="font-bold text-sm text-slate-900 mb-1">浅色</div>
              <p className="text-xs text-slate-500 leading-relaxed">
                经典高清晰度纸面阅读质感，纯白底色黑字排版，适合白天或明亮环境下的长篇码字创作。
              </p>
            </button>

            {/* 深色模式 */}
            <button
              type="button"
              onClick={() => {
                setThemeMode('dark');
                pushStatus('✅ 外观设置已强制切换为：深色模式');
              }}
              className={`flex flex-col items-start p-4 rounded-xl border text-left transition-all cursor-pointer relative ${
                currentThemeMode === 'dark'
                  ? 'border-neutral-900 bg-white ring-2 ring-neutral-900 shadow-md'
                  : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center justify-between w-full mb-3">
                <div className="w-9 h-9 rounded-lg bg-indigo-900/20 flex items-center justify-center text-indigo-400">
                  <Moon className="w-5 h-5" />
                </div>
                {currentThemeMode === 'dark' && (
                  <span className="flex items-center gap-1 text-[11px] font-bold text-neutral-900 bg-neutral-100 px-2 py-0.5 rounded-full">
                    <Check className="w-3.5 h-3.5" /> 已选
                  </span>
                )}
              </div>
              <div className="font-bold text-sm text-slate-900 mb-1">深色</div>
              <p className="text-xs text-slate-500 leading-relaxed">
                舒适护眼的深灰黑夜间配色，降低屏幕眩光与视觉疲劳，沉浸于深夜灵感爆发与小说执笔。
              </p>
            </button>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600 space-y-1.5 leading-relaxed">
            <div className="font-semibold text-slate-800 flex items-center gap-1.5">
              💡 外观配置说明
            </div>
            <ul className="list-disc pl-5 space-y-1 text-[11px]">
              <li>设置默认使用「跟随系统」，支持 Windows / macOS 系统外观的即时响应；</li>
              <li>手动指定「浅色」或「深色」后将锁定当前模式，且选项会自动永久保存至本地配置；</li>
              <li>页面重新加载或桌面端应用重启时将无缝恢复您的外观选择，且杜绝任何闪烁现象。</li>
            </ul>
          </div>
        </div>
      )}

      {/* ── 分组：关于与检查更新 ── */}
      {activeSection === 'about' && (
        <div
          id="sec-about"
          className="bg-slate-50 border border-slate-200 rounded-2xl p-6 shadow-md space-y-6 animate-fadeIn"
        >
          <div className="flex items-center justify-between border-b border-slate-200 pb-4">
            <div className="flex items-center space-x-2.5">
              <Sparkles className="w-5 h-5 text-neutral-800" />
              <div>
                <h2 className="text-base font-bold text-slate-900">关于 InkMind · 版本与更新</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  长篇小说创作工作台客户端版本信息与官方开源更新检测。
                </p>
              </div>
            </div>
            <div className="flex items-center space-x-2 text-xs font-semibold px-3 py-1 rounded-full bg-slate-200 text-slate-800 border border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:border-slate-700">
              <span>当前版本：v{CURRENT_APP_VERSION}</span>
            </div>
          </div>

          {/* 软件主信息展示卡 */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm dark:bg-slate-900/60 dark:border-slate-800">
            <div className="flex items-start gap-4">
              <img
                src="/icon.png"
                alt="InkMind Logo"
                className="w-14 h-14 rounded-xl border border-slate-200 shadow-sm object-contain p-1 bg-white dark:bg-slate-800 dark:border-slate-700"
                onError={(e) => {
                  (e.target as HTMLElement).style.display = 'none';
                }}
              />
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-lg text-slate-900">InkMind</h3>
                  <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-md bg-black text-white dark:bg-white dark:text-neutral-950 shadow-xs">
                    v{CURRENT_APP_VERSION}
                  </span>
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800 flex items-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5" /> GNU AGPL v3
                  </span>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-300">
                  本地优先的长篇小说创作工作台 · 严格六阶段 Agent 管线 · 杜绝长篇写崩与吃设定
                </p>
                <div className="text-[11px] text-slate-400 dark:text-slate-400">
                  作者 / 维护者：Khnocyl · 开源许可证：GNU Affero General Public License v3.0
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <a
                href={`https://github.com/${GITHUB_REPO}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-100 transition shadow-sm"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                访问 GitHub 主页
              </a>
            </div>
          </div>

          {/* 在线检测更新面板 */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm dark:bg-slate-900/60 dark:border-slate-800">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="font-bold text-sm text-slate-900 flex items-center gap-2">
                  <span>官方在线更新检测</span>
                  <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                    （连接 GitHub Releases 官方发布源）
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  点击按钮即可实时查询线上是否有新版本安装包发布。
                </p>
              </div>
              <button
                type="button"
                disabled={updateCheckState.isChecking}
                onClick={handleCheckUpdate}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-bold rounded-xl bg-black text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-950 dark:hover:bg-slate-200 disabled:opacity-50 transition shadow-sm cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${updateCheckState.isChecking ? 'animate-spin' : ''}`} />
                {updateCheckState.isChecking ? '正在检测最新版本…' : '立即检查更新'}
              </button>
            </div>

            {/* 检查结果区域 */}
            {updateCheckState.result && (
              <div className="pt-2 animate-fadeIn">
                {updateCheckState.result.status === 'latest' && (
                  <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/70 text-emerald-900 flex items-start gap-3 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-200">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <div className="font-bold text-sm">
                        🎉 当前已是最新版本 (v{CURRENT_APP_VERSION})
                      </div>
                      <p className="text-xs text-emerald-700 dark:text-emerald-300">
                        您的客户端已是官方最新版本，无需更新。祝您长篇小说创作灵感泉涌！
                      </p>
                    </div>
                  </div>
                )}

                {updateCheckState.result.status === 'update-available' && (
                  <div className="p-4 rounded-xl border border-indigo-200 bg-indigo-50/70 text-indigo-950 space-y-3 dark:border-indigo-800/60 dark:bg-indigo-950/30 dark:text-indigo-200">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <Sparkles className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
                        <div>
                          <div className="font-bold text-sm flex items-center gap-2">
                            <span>🚀 发现新版本：v{updateCheckState.result.latestVersion}</span>
                            {updateCheckState.result.publishedAt && (
                              <span className="text-[11px] font-normal text-indigo-600 dark:text-indigo-300">
                                （发布于 {new Date(updateCheckState.result.publishedAt).toLocaleDateString()}）
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-indigo-700 dark:text-indigo-300 mt-0.5">
                            {updateCheckState.result.releaseName || 'InkMind 官方新版本已发布，建议升级以体验最新特性与稳定性修复。'}
                          </p>
                        </div>
                      </div>
                      <a
                        href={updateCheckState.result.releaseUrl || GITHUB_RELEASES_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition shadow shrink-0"
                      >
                        前往下载安装包
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                    {updateCheckState.result.releaseNotes && (
                      <div className="bg-white/80 border border-indigo-100 rounded-lg p-3 text-xs text-slate-700 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono dark:bg-slate-900/90 dark:border-indigo-900/60 dark:text-slate-200">
                        {updateCheckState.result.releaseNotes}
                      </div>
                    )}
                  </div>
                )}

                {updateCheckState.result.status === 'error' && (
                  <div className="p-4 rounded-xl border border-amber-200 bg-amber-50/70 text-amber-900 flex items-start justify-between gap-3 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-bold text-sm">
                          无法连接到 GitHub 版本服务
                        </div>
                        <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
                          {updateCheckState.result.errorMsg || '网络请求超时或受到限制，请检查本地网络连接。'}
                        </p>
                      </div>
                    </div>
                    <a
                      href={GITHUB_RELEASES_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-bold text-amber-800 hover:underline shrink-0 dark:text-amber-300"
                    >
                      手动查看 Releases
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 底部架构说明 */}
          <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600 space-y-1.5 leading-relaxed dark:bg-slate-900/60 dark:border-slate-800 dark:text-slate-300">
            <div className="font-semibold text-slate-800 flex items-center gap-1.5 dark:text-slate-100">
              🛡️ 开源声明与数据隐私
            </div>
            <ul className="list-disc pl-5 space-y-1 text-[11px]">
              <li>InkMind 恪守「本地优先」原则：所有创作数据、设定集与本地向量索引均存储于您的设备上；</li>
              <li>服务端加密存储：您的 LLM API Key 均经过高强度 AES-256-GCM 机器唯一加密，绝不经由任何第三方中转；</li>
              <li>基于 GNU AGPL v3 开源协议，我们坚决抵制任何侵害作者权益的商业套壳与闭源转售。</li>
            </ul>
          </div>
        </div>
      )}

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
                onChange={(e) =>
                  setInputProvider(e.target.value as 'openai' | 'deepseek' | 'custom')
                }
                className="w-full bg-white border border-slate-300 rounded-xl px-3.5 py-2.5 text-sm text-slate-900 focus:border-neutral-900 focus:outline-none shadow-sm"
              >
                <option value="deepseek">DeepSeek</option>
                <option value="openai">OpenAI</option>
                <option value="custom">自定义 / 中转（OpenAI 兼容）</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5 flex items-center justify-between">
                <span>API Base URL (接口路径地址)</span>
                <span className="text-[11px] text-slate-500 font-normal">支持 DeepSeek/OpenAI 及各类中转接口</span>
              </label>
              <input
                type="text"
                value={inputBaseURL}
                onChange={(e) => setInputBaseURL(e.target.value)}
                placeholder="例如: https://api.deepseek.com"
                className="w-full bg-white border border-slate-300 rounded-xl px-3.5 py-2.5 text-sm text-slate-900 focus:border-neutral-900 focus:outline-none shadow-sm"
              />
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
                <span>API Key (大模型密钥 - 服务端加密存储)</span>
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
                      ? '💾 保存当前配置档'
                      : '💾 新建并保存配置档'}
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
      <div id="sec-targets" className="space-y-6">
      <div className="p-6 bg-slate-50 border border-slate-200 rounded-2xl space-y-6 shadow-sm">
        <h2 className="text-base font-bold text-slate-900 border-b border-slate-200 pb-3">
          📏 全书 · 每日 · 抽检目标
        </h2>
      {projectConfig && onUpdateProjectConfig && (
        <div className="p-5 bg-sky-50 border border-sky-200 rounded-xl space-y-4">
          <h3 className="text-sm font-bold text-slate-900 border-b border-sky-200 pb-2">
            📏 全书与单章目标
          </h3>
          <p className="text-[11px] text-slate-600 leading-relaxed">
            单章字数写入正文 Prompt（约 ±15%）；目标章数 × 每章字数 = 全书目标，用于顶栏与仪表盘进度条。不硬截断正文。
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <label className="space-y-1">
              <span className="font-semibold text-slate-700">目标总章数</span>
              <input
                type="number"
                min={1}
                max={5000}
                step={1}
                value={
                  projectConfig.targetChapterCount ?? projectConfig.totalChapters ?? 100
                }
                onChange={(e) => {
                  const n = Math.max(1, Math.min(5000, Number(e.target.value) || 1));
                  onUpdateProjectConfig({
                    ...projectConfig,
                    targetChapterCount: n,
                    totalChapters: n,
                  });
                }}
                className="w-full px-3 py-2 border border-sky-200 rounded-xl bg-white font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="font-semibold text-slate-700">目标字数 / 章</span>
              <input
                type="number"
                min={500}
                max={20000}
                step={100}
                value={resolveChapterWordTarget(projectConfig) ?? 3000}
                onChange={(e) => {
                  const n = Math.max(500, Math.min(20000, Number(e.target.value) || 3000));
                  onUpdateProjectConfig({
                    ...projectConfig,
                    targetWordCountPerChapter: n,
                    wordsPerChapter: n,
                  });
                }}
                className="w-full px-3 py-2 border border-sky-200 rounded-xl bg-white font-mono"
              />
            </label>
          </div>
          {(() => {
            const ch =
              projectConfig.targetChapterCount ?? projectConfig.totalChapters ?? 100;
            const per = resolveChapterWordTarget(projectConfig) ?? 3000;
            const total = ch * per;
            return (
              <div className="rounded-xl border border-sky-200 bg-white/80 px-3.5 py-2.5 text-xs space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-slate-700">预估全书目标</span>
                  <span className="font-mono font-bold text-sky-800">
                    {total.toLocaleString()} 字
                  </span>
                </div>
                <div className="text-[11px] text-slate-500 font-mono">
                  {ch} 章 × {per.toLocaleString()} 字/章
                  {total >= 10000 ? ` ≈ ${(total / 10000).toFixed(1)} 万字` : ''}
                </div>
                <div className="h-1.5 rounded-full bg-sky-100 overflow-hidden mt-1">
                  <div className="h-full w-full rounded-full bg-gradient-to-r from-neutral-300 to-neutral-500 opacity-80" />
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* 日更目标 */}
      <div className="p-5 bg-orange-50 border border-orange-200 rounded-xl space-y-3">
        <h3 className="text-sm font-bold text-slate-900 border-b border-orange-200 pb-2">
          🔥 每日字数目标
        </h3>
        <p className="text-[11px] text-slate-600 leading-relaxed">
          按正文净增字数记账（手改 / 流水线写章）。填 0 可关闭达标提示。顶栏与仪表盘会显示今日进度。
        </p>
        <label className="block space-y-1 text-xs max-w-xs">
          <span className="font-semibold text-slate-700">每日目标字数</span>
          <input
            type="number"
            min={0}
            max={50000}
            step={100}
            value={styleConfig.dailyWordTarget ?? 3000}
            onChange={(e) =>
              onUpdateStyleConfig({
                ...styleConfig,
                dailyWordTarget: Math.max(0, Math.min(50000, Number(e.target.value) || 0)),
              })
            }
            className="w-full px-3 py-2 border border-orange-200 rounded-lg bg-white font-mono"
          />
        </label>
        <p className="text-[10px] text-orange-900/70">
          当前：{(styleConfig.dailyWordTarget ?? 3000) === 0 ? '已关闭' : `${styleConfig.dailyWordTarget ?? 3000} 字/日`}
        </p>
      </div>

      {/* 跨章抽检节奏 */}
      <div className="p-5 bg-cyan-50 border border-cyan-200 rounded-xl space-y-3">
        <h3 className="text-sm font-bold text-slate-900 border-b border-cyan-200 pb-2">
          📡 跨章抽检提醒
        </h3>
        <p className="text-[11px] text-slate-600 leading-relaxed">
          每写满若干章有正文后，工作台会提示再跑跨章连贯抽检（伏笔 / 状态 / 事实）。可随时手动跑。
        </p>
        <label className="block space-y-1 text-xs max-w-xs">
          <span className="font-semibold text-slate-700">提醒间隔（章）</span>
          <input
            type="number"
            min={2}
            max={20}
            value={styleConfig.crossAuditIntervalChapters ?? 5}
            onChange={(e) =>
              onUpdateStyleConfig({
                ...styleConfig,
                crossAuditIntervalChapters: Math.max(
                  2,
                  Math.min(20, Number(e.target.value) || 5)
                ),
              })
            }
            className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
          />
        </label>
      </div>
      </div>
      </div>
      )}

      {/* Auto-Pilot 默认参数 */}
      {activeSection === 'autopilot' && (
      <div id="sec-autopilot" className="p-6 bg-rose-50 border border-rose-200 rounded-2xl space-y-4 shadow-sm">
        <h2 className="text-base font-bold text-slate-900 border-b border-rose-200 pb-3">
          🚀 Auto-Pilot 连载默认参数
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <label className="space-y-1">
            <span className="font-semibold text-slate-700">默认连写章数</span>
            <input
              type="number"
              min={1}
              max={100}
              value={styleConfig.autoPilotTargetChapters ?? 3}
              onChange={(e) =>
                onUpdateStyleConfig({
                  ...styleConfig,
                  autoPilotTargetChapters: Math.max(1, Math.min(100, Number(e.target.value) || 1)),
                })
              }
              className="w-full px-3 py-2 border border-slate-300 rounded-lg"
            />
            <span className="text-[10px] text-slate-500">AI 长跑单次最多 100 章（受停机条件约束）</span>
          </label>
          <label className="space-y-1 md:col-span-2">
            <span className="font-semibold text-slate-700">写作深度（Auto-Pilot）</span>
            <select
              value={styleConfig.autoPilotWriteMode || 'until_green'}
              onChange={(e) =>
                onUpdateStyleConfig({
                  ...styleConfig,
                  autoPilotWriteMode: e.target.value as
                    | 'until_green'
                    | 'draft_only'
                    | 'until_review',
                })
              }
              className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
            >
              <option value="until_green">写到机检过并锁定（默认·记忆最全）</option>
              <option value="draft_only">只写草稿（分镜+正文，不审校·不更新记忆）</option>
              <option value="until_review">写到待人工（完整审校，不自动锁）</option>
            </select>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              AI 冲 200～300 章请用「机检过并锁定」：才会 recap / 摘要 / 角色回写。draft_only 会断记忆。
            </p>
          </label>
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 md:col-span-3">
            <input
              type="checkbox"
              checked={styleConfig.autoPilotAutoResolveHooks !== false}
              onChange={(e) =>
                onUpdateStyleConfig({
                  ...styleConfig,
                  autoPilotAutoResolveHooks: e.target.checked,
                })
              }
            />
            AP 自动确认「高置信」伏笔回收（长跑推荐开；medium/low 仍待手确）
          </label>
          <label className="flex items-start gap-2 text-xs font-semibold text-slate-700 md:col-span-3">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={styleConfig.progressionReviewEnabled !== false}
              onChange={(e) =>
                onUpdateStyleConfig({
                  ...styleConfig,
                  progressionReviewEnabled: e.target.checked,
                })
              }
            />
            <span>
              启用推进度审（每章 +1 次 LLM 调用）
              <span className="block text-[10px] font-normal text-slate-500 mt-0.5">
                检查分镜完成度 / 主线推进 / 注水度 / 伏笔触达；弱推进不自动锁章、转人工确认。
                关闭后不跑此项检查（省调用，但「水了一章」不再拦截）。
              </span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 md:col-span-3">
            <input
              type="checkbox"
              checked={styleConfig.autoLedgerLlmEnrich === true}
              onChange={(e) =>
                onUpdateStyleConfig({
                  ...styleConfig,
                  autoLedgerLlmEnrich: e.target.checked,
                })
              }
            />
            章末 LLM 补抽事实账本（费 token，默认关；启发式之后补漏死亡/道具）
          </label>
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 md:col-span-3">
            <input
              type="checkbox"
              checked={styleConfig.autoSyncDeathToCharacters !== false}
              onChange={(e) =>
                onUpdateStyleConfig({
                  ...styleConfig,
                  autoSyncDeathToCharacters: e.target.checked,
                })
              }
            />
            账本「死亡」自动同步到角色卡「已阵亡/退出」（默认开，仅精确匹配角色名）
          </label>
          <label className="space-y-1">
            <span className="font-semibold text-slate-700">周期跨章抽检（章）</span>
            <input
              type="number"
              min={0}
              max={30}
              value={styleConfig.autoPilotCrossAuditEvery ?? 5}
              onChange={(e) =>
                onUpdateStyleConfig({
                  ...styleConfig,
                  autoPilotCrossAuditEvery: Math.max(
                    0,
                    Math.min(30, Number(e.target.value) || 0)
                  ),
                })
              }
              className="w-full px-3 py-2 border border-slate-300 rounded-lg"
            />
            <span className="text-[10px] text-slate-500">0=关闭；默认每 5 章本地抽检，不达标停机</span>
          </label>
          <label className="space-y-1">
            <span className="font-semibold text-slate-700">抽检最低分</span>
            <input
              type="number"
              min={0}
              max={100}
              value={styleConfig.autoPilotCrossAuditMinScore ?? 55}
              onChange={(e) =>
                onUpdateStyleConfig({
                  ...styleConfig,
                  autoPilotCrossAuditMinScore: Math.max(
                    0,
                    Math.min(100, Number(e.target.value) || 0)
                  ),
                })
              }
              className="w-full px-3 py-2 border border-slate-300 rounded-lg"
            />
          </label>
          <label className="space-y-1">
            <span className="font-semibold text-slate-700">低分阈值（分）</span>
            <input
              type="number"
              min={0}
              max={100}
              value={styleConfig.autoPilotMinScore ?? 65}
              onChange={(e) =>
                onUpdateStyleConfig({
                  ...styleConfig,
                  autoPilotMinScore: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                })
              }
              className="w-full px-3 py-2 border border-slate-300 rounded-lg"
            />
          </label>
          <label className="space-y-1">
            <span className="font-semibold text-slate-700">连续低分停机次数</span>
            <input
              type="number"
              min={1}
              max={10}
              value={styleConfig.autoPilotLowScoreStreakLimit ?? 2}
              onChange={(e) =>
                onUpdateStyleConfig({
                  ...styleConfig,
                  autoPilotLowScoreStreakLimit: Math.max(1, Math.min(10, Number(e.target.value) || 1)),
                })
              }
              className="w-full px-3 py-2 border border-slate-300 rounded-lg"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-4 text-xs">
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={styleConfig.autoPilotStopOnFail !== false}
              onChange={(e) =>
                onUpdateStyleConfig({ ...styleConfig, autoPilotStopOnFail: e.target.checked })
              }
            />
            <span>机检未过立即停机</span>
          </label>
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={styleConfig.autoPilotCreateMissingChapters !== false}
              onChange={(e) =>
                onUpdateStyleConfig({
                  ...styleConfig,
                  autoPilotCreateMissingChapters: e.target.checked,
                })
              }
            />
            <span>缺章时自动规划新建</span>
          </label>
        </div>
        <p className="text-[11px] text-slate-600">
          在工作台右侧可一键启动 Auto-Pilot；参数也可在侧栏临时改「本轮章数」。
        </p>
      </div>
      )}

      </div>

      {/* ── 分组三：文风纪律（核心文风开关 / 黑名单 / 去AI味 / 文风仿写 / 样本库）── */}
      <div className="space-y-12 scroll-mt-14">
      {/* 核心文风 · 风格样本库 */}
      {activeSection === 'core-switch' && (
      <div id="sec-core-switch" className="space-y-6">
      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6 space-y-6 shadow-sm">
        <h2 className="text-base font-bold text-slate-900 border-b border-slate-200 pb-3">
          🎛 核心文风开关
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="p-5 bg-white border border-slate-200 rounded-xl space-y-4">
          <div className="flex items-center justify-between border-b border-slate-200 pb-3">
            <span className="font-bold text-sm text-slate-900 flex items-center space-x-2">
              <span>🚫 禁止结尾升华与多余哲理说教</span>
            </span>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={styleConfig.forbidEndingSublimation}
                onChange={(e) =>
                  onUpdateStyleConfig({ ...styleConfig, forbidEndingSublimation: e.target.checked })
                }
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-black"></div>
            </label>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            AI 常见通病之一是在章节或段落末尾强制进行“人生哲理升华”或“宿命感慨”（如：<i>“在这茫茫天地间，命运的转轮已然悄悄转动……”</i>）。
          </p>
          <div className="text-[11px] text-neutral-900 font-semibold bg-neutral-100 p-3 border border-neutral-200 rounded-xl">
            👉 开启后：执笔和自检 Agent 将严厉压制总结倾向，强制要求章节结尾必须<strong>“戛然而止在具体的动作、冲突画面或短语断口上”</strong>。
          </div>
        </div>

        <div className="p-5 bg-white border border-slate-200 rounded-xl space-y-4">
          <div className="flex items-center justify-between border-b border-slate-200 pb-3">
            <span className="font-bold text-sm text-slate-900 flex items-center space-x-2">
              <span>🎬 Show, Don't Tell (展示而非阐述)</span>
            </span>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={styleConfig.enforceShowDontTell}
                onChange={(e) =>
                  onUpdateStyleConfig({ ...styleConfig, enforceShowDontTell: e.target.checked })
                }
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-black"></div>
            </label>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            严禁 AI 直接陈述人物情绪（如“他极度震撼与恐惧”），要求强行将心理转化为具体的生理细节（如指骨微冷、剑刃蜂鸣、内息凝滞）。
          </p>
          <div className="text-[11px] text-slate-800 bg-white p-3 border border-slate-200 rounded-xl shadow-sm">
            配合分镜头细纲使用，可以大幅消除注水感，使文字具有沉浸的剧作电影张力。
          </div>
        </div>

        <div className="p-5 bg-white border border-slate-200 rounded-xl space-y-4">
          <div className="flex items-center justify-between border-b border-slate-200 pb-3">
            <span className="font-bold text-sm text-slate-900 flex items-center space-x-2">
              <span>✍️ 破折号白名单（允许「——」）</span>
            </span>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={styleConfig.allowEmDash === true}
                onChange={(e) =>
                  onUpdateStyleConfig({ ...styleConfig, allowEmDash: e.target.checked })
                }
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-black"></div>
            </label>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            默认关闭：写后校验会把正文中的破折号「——」记为 error 并阻断绿通（破折号是常见 AI 味标记）。
          </p>
          <div className="text-[11px] text-slate-800 bg-white p-3 border border-slate-200 rounded-xl shadow-sm">
            👉 开启后：写后校验放行破折号，已有/新增的「——」不再计违规。适合以破折号为节奏器官的文风；
            激活文风档案若声明了省略号/破折号容忍（ellipsis-emphatic），无需开启本开关。
          </div>
        </div>
        </div>
        <div className="border-t border-slate-200 pt-5">
        <div className="flex items-center justify-between border-b border-slate-200 pb-3">
          <div className="font-bold text-base text-slate-900 flex items-center space-x-2">
            <Eye className="w-5 h-5 text-emerald-600" />
            <span>Few-Shot 目标短句风格示例克隆库 (Style Cloner)</span>
          </div>
          <span className="text-xs text-emerald-800 bg-emerald-100 border border-emerald-300 px-3 py-1 rounded-full font-bold flex items-center space-x-1.5">
            <CheckCircle2 size={13} className="text-emerald-600" />
            <span>当前已激活目标语感</span>
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {(styleConfig.fewShotExamples || []).map((example) => {
            const isSelected = example.id === styleConfig.selectedExampleId;
            return (
              <div
                key={example.id}
                onClick={() => handleSelectExample(example.id)}
                className={`p-5 rounded-xl cursor-pointer transition-all border flex flex-col justify-between ${
                  isSelected
                    ? 'bg-white border-neutral-900 shadow-lg'
                    : 'bg-white border-slate-200 hover:border-slate-400 shadow-sm'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <span className={`font-bold text-sm ${isSelected ? 'text-neutral-800' : 'text-slate-900'}`}>
                      {example.title}
                    </span>
                    {isSelected && (
                      <span className="text-[10px] bg-black text-white px-2 py-0.5 rounded-full font-bold">
                        当前激活
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-600 mb-3 border-b border-slate-200 pb-2.5">
                    <strong className="text-slate-900">行文要诀：</strong>
                    {example.authorStyle}
                  </div>
                  <div className="text-xs text-slate-800 font-serif leading-relaxed bg-slate-50 p-3 rounded-lg border border-slate-200 line-clamp-6">
                    {example.content}
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-200 text-[11px] text-slate-600">
                  <strong className="text-neutral-800">核心解构：</strong>
                  {example.analysis}
                </div>
              </div>
            );
          })}
        </div>
        </div>
        </div>
      </div>
      )}

      {/* 黑名单管理 */}
      {activeSection === 'blacklist' && (
      <div id="sec-blacklist" className="bg-slate-50 border border-slate-200 rounded-2xl p-6 space-y-5 shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 pb-3">
          <div className="font-bold text-base text-slate-900 flex items-center space-x-2">
            <Sliders className="w-5 h-5 text-purple-600" />
            <span>网文高频 AI 套话屏蔽词库 (Cliché Blacklist)</span>
          </div>
          <span className="text-xs font-mono bg-purple-100 text-purple-800 px-2.5 py-1 rounded-full border border-purple-300 font-semibold">
            实时拦截净化中
          </span>
        </div>

        <div className="p-4 bg-white border border-slate-200 rounded-xl space-y-3 shadow-sm">
          <div className="text-xs font-bold text-slate-700">
            系统内置反套路黑名单（执笔 & 审校双层覆盖）:
          </div>
          <div className="flex flex-wrap gap-2">
            {(styleConfig.clicheBlacklist || []).map((word, idx) => (
              <span
                key={idx}
                className="text-xs bg-slate-100 text-slate-800 border border-slate-300 px-2.5 py-1 rounded-lg font-mono font-medium shadow-sm"
              >
                🚫 {word}
              </span>
            ))}
          </div>
        </div>

        <div className="p-4 bg-white border border-slate-200 rounded-xl space-y-3 shadow-sm">
          <div className="text-xs font-bold text-slate-800 flex items-center justify-between">
            <span>您自定义追加的屏蔽词或禁言句式：</span>
            <span className="text-slate-500 font-normal">
              {(styleConfig.customBlacklist || []).length} 个自定义规则
            </span>
          </div>

          <form onSubmit={handleAddBlacklist} className="flex space-x-2">
            <input
              type="text"
              placeholder="添加您想要彻底断绝的 AI 惯用词句（例如：不由得感到一阵心惊……）"
              value={newBlacklistWord}
              onChange={(e) => setNewBlacklistWord(e.target.value)}
              className="flex-1 text-xs p-2.5 border border-slate-300 rounded-xl text-slate-900 bg-white focus:outline-none focus:border-neutral-900"
            />
            <button
              type="submit"
              className="bg-black hover:bg-neutral-800 text-white px-5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center space-x-1 shrink-0 shadow-md"
            >
              <Plus size={14} />
              <span>追加黑名单</span>
            </button>
          </form>

          <div className="flex flex-wrap gap-2 pt-1">
            {(styleConfig.customBlacklist || []).map((word, idx) => (
              <span
                key={idx}
                className="text-xs bg-purple-50 text-purple-900 border border-purple-300 px-3 py-1 rounded-lg font-mono flex items-center space-x-2 font-medium"
              >
                <span>🚫 {word}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveCustomWord(word)}
                  className="text-purple-600 hover:text-red-600 font-bold"
                >
                  <Trash2 size={13} />
                </button>
              </span>
            ))}
          </div>
        </div>

        {/* 去AI味：白名单 + 扩展机检 */}
        <div className="p-4 bg-white border border-teal-200 rounded-xl space-y-3 shadow-sm">
          <div className="text-xs font-bold text-teal-900">
            去AI味扩展机检（句式 / 节奏 / 解释腔 · 对齐网文 deslop）
          </div>
          <p className="text-[11px] text-slate-600 leading-relaxed">
            写后对润色稿复扫：否定翻转、万能「带着」、解释腔、段均句数、对话标签密度等。
            默认 warn 压分；可勾选严格/重度阻断。
          </p>
          <div className="flex flex-col gap-2 text-xs font-semibold text-slate-700">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={styleConfig.useExtendedClicheList !== false}
                onChange={(e) =>
                  onUpdateStyleConfig({
                    ...styleConfig,
                    useExtendedClicheList: e.target.checked,
                  })
                }
              />
              使用内置扩展套话表（眼中闪过、缓缓开口等）
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={styleConfig.aiTasteStrict === true}
                onChange={(e) =>
                  onUpdateStyleConfig({
                    ...styleConfig,
                    aiTasteStrict: e.target.checked,
                  })
                }
              />
              严格模式（解释腔等升 error）
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={styleConfig.aiTasteBlockHeavy === true}
                onChange={(e) =>
                  onUpdateStyleConfig({
                    ...styleConfig,
                    aiTasteBlockHeavy: e.target.checked,
                  })
                }
              />
              AI 味「重度」阻断自动绿通/锁章
            </label>
          </div>
          <div className="text-xs font-bold text-slate-800 pt-1">
            白名单（功法名/绰号/专名命中豁免）
          </div>
          <form onSubmit={handleAddWhitelist} className="flex space-x-2">
            <input
              type="text"
              placeholder="例如：缓缓（角色绰号）、仿佛山海（书名）"
              value={newWhitelistWord}
              onChange={(e) => setNewWhitelistWord(e.target.value)}
              className="flex-1 text-xs p-2.5 border border-slate-300 rounded-xl text-slate-900 bg-white focus:outline-none focus:border-teal-600"
            />
            <button
              type="submit"
              className="bg-black hover:bg-neutral-800 text-white px-4 py-2.5 rounded-xl text-xs font-bold shrink-0"
            >
              <Plus size={14} className="inline mr-1" />
              豁免
            </button>
          </form>
          <div className="flex flex-wrap gap-2">
            {(styleConfig.deslopWhitelist || []).length === 0 ? (
              <span className="text-[10px] text-slate-400">暂无白名单</span>
            ) : (
              (styleConfig.deslopWhitelist || []).map((word) => (
                <span
                  key={word}
                  className="text-xs bg-teal-50 text-teal-900 border border-teal-200 px-2.5 py-1 rounded-lg font-mono flex items-center gap-1.5"
                >
                  ✅ {word}
                  <button
                    type="button"
                    onClick={() => handleRemoveWhitelist(word)}
                    className="text-teal-700 hover:text-red-600"
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              ))
            )}
          </div>
        </div>
      </div>
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
        />
      </div>
      )}
      </div>
      </div>
    </div>
    </div>
  );
};
