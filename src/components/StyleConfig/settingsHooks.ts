/**
 * 设置页领域状态容器（StyleAndEngineManager 拆分 · 第 2 步）
 *
 * 设计约束（勿破坏）：设置页分区是**条件渲染**——切走分区即卸载组件。
 * 因此 API Key 表单、路由草稿、Embedding 表单、Doctor 报告、更新检测结果
 * 这些 state 不能下沉到分区组件（否则分区往返即丢草稿），全部挂在本文件的
 * Hook 里，由壳组件 StyleAndEngineManager 调用并整包下传给分区做纯展示。
 *
 * 逻辑自 StyleAndEngineManager.tsx 组件体逐行等价迁入；
 * 仅 `pushStatus` 更名 `onStatus`（壳注入同一实现，含静默闸门语义）。
 */
import { useEffect, useState } from 'react';
import type { SyntheticEvent } from 'react';
import type { StyleConfig, LlmRole, LlmRoleRouting } from '../../types/novel';
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
import { ALL_LLM_ROLES } from '../../services/llmRouting';
import {
  checkForAppUpdates,
  CURRENT_APP_VERSION,
  GITHUB_RELEASES_URL,
  type CheckUpdateResult,
} from '../../services/appUpdate';
import { hasDesktopUpdater, probeDesktopUpdater } from '../../services/desktopUpdater';
import { runDoctorClient, type DoctorReport } from '../../services/doctorClient';

type StatusFn = (msg: string) => void;

type UpdateStyleConfigFn = (
  config: StyleConfig | ((prev: StyleConfig) => StyleConfig)
) => Promise<void> | void;

// ═══════════════════════════════════════════════════════════════════
// 模型配置档：多档管理 + 编辑表单草稿 + 可用模型列表拉取
// ═══════════════════════════════════════════════════════════════════

export function useLLMProfiles(onStatus: StatusFn) {
  const [backendConfig, setBackendConfig] = useState<BackendLLMConfig | null>(null);
  const [profiles, setProfiles] = useState<LLMProfilePublic[]>([]);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [inputProfileName, setInputProfileName] = useState('默认 DeepSeek');
  const [inputProvider, setInputProvider] = useState<
    'openai' | 'deepseek' | 'custom' | 'anthropic' | 'local'
  >('deepseek');
  /** 输出预算输入框字符串值（留空/0 = 服务端默认 8192） */
  const [inputMaxTokens, setInputMaxTokens] = useState('');
  const [inputApiKey, setInputApiKey] = useState('');
  const [inputBaseURL, setInputBaseURL] = useState('https://api.deepseek.com');
  const [inputModelName, setInputModelName] = useState('deepseek-chat');
  const [inputTemperature, setInputTemperature] = useState(0.7);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [modelOptions, setModelOptions] = useState<LLMModelInfo[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsHint, setModelsHint] = useState<string | null>(null);

  const applyProfiles = (list: LLMProfilePublic[], activeId?: string) => {
    setProfiles(list);
    const active =
      list.find((p) => p.id === activeId) || list.find((p) => p.isActive) || list[0];
    if (active) {
      setEditingProfileId(active.id);
      setInputProfileName(active.name);
      setInputProvider(
        (active.provider as 'openai' | 'deepseek' | 'custom' | 'anthropic' | 'local') || 'custom'
      );
      setInputBaseURL(active.baseURL || '');
      setInputModelName(active.modelName || '');
      setInputTemperature(active.temperature ?? 0.7);
      setInputMaxTokens(active.maxTokens ? String(active.maxTokens) : '');
      setInputApiKey(active.hasKey && active.maskedKey ? active.maskedKey : '');
    }
  };

  // 挂载时加载后端 LLM 配置（Embedding 配置由 useEmbeddingConfig 自行加载）
  useEffect(() => {
    void (async () => {
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
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveBackendConfig = async (e?: SyntheticEvent) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setIsSavingConfig(true);
    onStatus('⏳ 正在保存模型配置…');
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
          maxTokens: Number.isFinite(Number(inputMaxTokens)) ? Number(inputMaxTokens) : 0,
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
          onStatus(
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
          maxTokens: Number.isFinite(Number(inputMaxTokens)) ? Number(inputMaxTokens) : 0,
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
          maxTokens: Number.isFinite(Number(inputMaxTokens)) ? Number(inputMaxTokens) : 0,
          apiKey: inputApiKey.startsWith('sk-****') ? undefined : inputApiKey,
          name: inputProfileName.trim() || undefined,
        }).catch(() => null);
      }
      onStatus(
        `✅ 保存成功 ·「${inputProfileName.trim() || '配置档'}」已加密写入服务端。点「启用」可切换写作用模型。`
      );
    } catch (err: any) {
      onStatus(`❌ 保存失败: ${err?.message || err}`);
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleActivateProfile = async (id: string) => {
    setIsSavingConfig(true);
    onStatus('⏳ 正在启用模型…');
    try {
      const pl = await activateLLMProfile(id);
      applyProfiles(pl.profiles, pl.activeProfileId);
      const active = pl.profiles.find((p) => p.id === id);
      onStatus(
        `✅ 已启用「${active?.name || id}」· ${active?.modelName || ''} — 后续写作走此模型`
      );
    } catch (err: any) {
      onStatus(`❌ 启用失败: ${err?.message || err}`);
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
      onStatus('🗑️ 已删除配置档');
    } catch (err: any) {
      onStatus(`❌ 删除失败: ${err?.message || err}`);
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
    setInputMaxTokens('');
    setInputApiKey('');
    setModelOptions([]);
    setModelsHint('填写后保存，可再点「启用」切换到此档');
  };

  const handleSelectProfileForEdit = (p: LLMProfilePublic) => {
    setEditingProfileId(p.id);
    setInputProfileName(p.name);
    setInputProvider((p.provider as 'openai' | 'deepseek' | 'custom' | 'anthropic' | 'local') || 'custom');
    setInputBaseURL(p.baseURL);
    setInputModelName(p.modelName);
    setInputTemperature(p.temperature ?? 0.7);
    setInputMaxTokens(p.maxTokens ? String(p.maxTokens) : '');
    setInputApiKey(p.hasKey && p.maskedKey ? p.maskedKey : '');
    setModelOptions([]);
  };

  /** 从当前 Base URL + Key 刷新可用模型名（Key 未保存也可用表单明文探测） */
  const handleRefreshModels = async () => {
    setIsLoadingModels(true);
    setModelsHint(null);
    try {
      const result = await fetchLLMModels({
        baseURL: inputBaseURL.trim(),
        apiKey: inputApiKey.startsWith('sk-****') ? undefined : inputApiKey.trim() || undefined,
        provider: inputProvider,
        profileId: editingProfileId ?? undefined,
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
      onStatus(`✅ 模型列表已刷新：${result.count} 个（可点选填入）`);
    } catch (err: any) {
      setModelOptions([]);
      setModelsHint(null);
      onStatus(`❌ 刷新模型失败: ${err?.message || err}`);
    } finally {
      setIsLoadingModels(false);
    }
  };

  return {
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
  };
}

// ═══════════════════════════════════════════════════════════════════
// Doctor 一键诊断（报告只在「模型配置」分区展示）
// ═══════════════════════════════════════════════════════════════════

export function useDoctor(onStatus: StatusFn) {
  const [isDoctorRunning, setIsDoctorRunning] = useState(false);
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);

  const handleRunDoctor = async (e?: SyntheticEvent) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setIsDoctorRunning(true);
    setDoctorReport(null);
    onStatus('⏳ Doctor 诊断中（会真实调模型）…');
    try {
      const { report } = await runDoctorClient();
      setDoctorReport(report);
      if (report?.overall === 'healthy') {
        onStatus('✅ Doctor 成功：配置健康，可以开始写章');
      } else if (report?.overall === 'degraded') {
        onStatus('⚠️ Doctor：部分能力异常，请查看下方报告（仍留在本页）');
      } else {
        onStatus('❌ Doctor：配置不可用，请按建议修复');
      }
    } catch (err: any) {
      onStatus(`❌ Doctor 失败: ${err?.message || err}`);
    } finally {
      setIsDoctorRunning(false);
    }
  };

  return { isDoctorRunning, doctorReport, handleRunDoctor };
}

// ═══════════════════════════════════════════════════════════════════
// 向量检索（Embedding）配置表单
// ═══════════════════════════════════════════════════════════════════

export function useEmbeddingConfig(onStatus: StatusFn) {
  const [embConfig, setEmbConfig] = useState<EmbeddingConfigPublic | null>(null);
  const [embEnabled, setEmbEnabled] = useState(false);
  const [embUseSame, setEmbUseSame] = useState(true);
  const [embBaseURL, setEmbBaseURL] = useState('');
  const [embModel, setEmbModel] = useState('text-embedding-3-small');
  const [embDims, setEmbDims] = useState('');
  const [embApiKey, setEmbApiKey] = useState('');
  const [embBusy, setEmbBusy] = useState(false);

  // 挂载时加载 Embedding 配置（与 useLLMProfiles 各自加载，互不阻塞）
  useEffect(() => {
    void (async () => {
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
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveEmbedding = async (e?: SyntheticEvent) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setEmbBusy(true);
    onStatus('⏳ 正在保存向量检索配置…');
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
      onStatus(
        data.enabled
          ? '✅ 保存成功 · 向量检索 API 已启用'
          : '✅ 保存成功 · 向量配置已写入（当前未启用开关）'
      );
    } catch (err: any) {
      onStatus(`❌ 向量配置保存失败: ${err?.message || err}`);
    } finally {
      setEmbBusy(false);
    }
  };

  const handleTestEmbedding = async (e?: SyntheticEvent) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setEmbBusy(true);
    onStatus('⏳ 正在测试 Embedding 连通…');
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
      onStatus(
        `✅ 测试成功 · Embedding 连通 · ${r.model} · dim=${r.dimensions} · ${r.latencyMs}ms · norm≈${r.sampleNorm}`
      );
      const emb = await getEmbeddingConfig();
      setEmbConfig(emb);
    } catch (err: any) {
      onStatus(`❌ Embedding 测试失败: ${err?.message || err}`);
    } finally {
      setEmbBusy(false);
    }
  };

  return {
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
  };
}

// ═══════════════════════════════════════════════════════════════════
// 按角色路由模型：草稿态（保存时统一写回 + 清掉指向已删档的路由）
// ═══════════════════════════════════════════════════════════════════

export function useRoleRouting(
  styleConfig: StyleConfig,
  onUpdateStyleConfig: UpdateStyleConfigFn,
  profiles: LLMProfilePublic[],
  onStatus: StatusFn
) {
  const [routingEnabled, setRoutingEnabled] = useState(
    styleConfig.llmRoleRouting?.enabled === true
  );
  const [routingRoutes, setRoutingRoutes] = useState<Partial<Record<LlmRole, string>>>(
    () => styleConfig.llmRoleRouting?.routes || {}
  );

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
    onStatus(
      routingEnabled
        ? `🔀 按角色路由已保存（${Object.keys(routes).length} 个角色指定配置档）`
        : '按角色路由已关闭：全部跟随当前启用档'
    );
  };

  return {
    routingEnabled,
    setRoutingEnabled,
    routingRoutes,
    setRoutingRoutes,
    handleSaveRoleRouting,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 应用更新检测（Web 跳 GitHub / Electron 应用内更新）
// ═══════════════════════════════════════════════════════════════════

export function useUpdateCheck() {
  const [updateCheckState, setUpdateCheckState] = useState<{
    isChecking: boolean;
    result: CheckUpdateResult | null;
  }>({
    isChecking: false,
    result: null,
  });
  // Electron 安装版 → 应用内下载+覆盖安装；Web/单文件 SEA → 跳转 GitHub（null = 探测中）
  const [desktopUpdSupported, setDesktopUpdSupported] = useState<boolean | null>(() =>
    hasDesktopUpdater() ? null : false
  );
  const [desktopUpdVersion, setDesktopUpdVersion] = useState<string>('');

  useEffect(() => {
    if (desktopUpdSupported !== null) return;
    let alive = true;
    probeDesktopUpdater().then((res) => {
      if (!alive) return;
      setDesktopUpdSupported(Boolean(res.supported));
      if (res.currentVersion) setDesktopUpdVersion(res.currentVersion);
    });
    return () => {
      alive = false;
    };
  }, [desktopUpdSupported]);

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

  return { updateCheckState, handleCheckUpdate, desktopUpdSupported, desktopUpdVersion };
}

// ═══ 分区组件 props 类型（ReturnType 推导，避免手写巨型接口）═══

export type LLMProfilesApi = ReturnType<typeof useLLMProfiles>;
export type DoctorApi = ReturnType<typeof useDoctor>;
export type EmbeddingApi = ReturnType<typeof useEmbeddingConfig>;
export type RoleRoutingApi = ReturnType<typeof useRoleRouting>;
export type UpdateCheckApi = ReturnType<typeof useUpdateCheck>;
