/**
 * 设置分区：多模型配置档 + Doctor 诊断报告
 * （自 StyleAndEngineManager 拆出；表单草稿与 Doctor 报告 state 挂壳层 Hook，
 *  分区往返不丢 API Key 输入。报告与表单卡是兄弟节点，用 Fragment 保持 DOM 顺序。）
 */
import React from 'react';
import {
  Trash2,
  Cpu,
  CheckCircle2,
  Lock,
  Save,
  Stethoscope,
  AlertTriangle,
  XCircle,
  Loader2,
  RefreshCw,
  Zap,
  PlusCircle,
} from 'lucide-react';
import { thirdPartyHost } from '../../services/llmClient';
import { overallLabel, type DoctorCheckStatus } from '../../services/doctorClient';
import type { LLMProfilesApi, DoctorApi } from './settingsHooks';

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

interface SettingsModelsSectionProps {
  llm: LLMProfilesApi;
  doctor: DoctorApi;
  /** 壳层状态条消息（保存/启删/Doctor 结果在此回显） */
  statusMsg: string;
  onClearStatus: () => void;
  /** 壳层状态条容器 ref（pushStatus 滚动定位用） */
  statusBannerRef: React.RefObject<HTMLDivElement | null>;
  /** sec-api-config 容器 ref（历史遗留定位锚） */
  doctorSectionRef: React.RefObject<HTMLDivElement | null>;
}

export const SettingsModelsSection: React.FC<SettingsModelsSectionProps> = ({
  llm,
  doctor,
  statusMsg,
  onClearStatus,
  statusBannerRef,
  doctorSectionRef,
}) => {
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
  } = llm;
  const { isDoctorRunning, doctorReport, handleRunDoctor } = doctor;

  return (
    <>
      {/* API Key 与服务端大模型配置 */}
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
        {statusMsg && (
          <div
            ref={statusBannerRef}
            role="status"
            className={`rounded-xl border px-3.5 py-2.5 text-xs font-semibold flex items-start justify-between gap-3 ${
              statusMsg.includes('✅')
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                : statusMsg.includes('⏳')
                  ? 'border-slate-300 bg-slate-50 text-slate-800'
                  : statusMsg.includes('⚠️') || statusMsg.includes('🩺')
                    ? 'border-amber-300 bg-amber-50 text-amber-950'
                    : statusMsg.includes('❌')
                      ? 'border-red-300 bg-red-50 text-red-900'
                      : 'border-slate-200 bg-white text-slate-800'
            }`}
          >
            <span className="leading-relaxed">{statusMsg}</span>
            <button
              type="button"
              className="shrink-0 text-[11px] opacity-70 hover:opacity-100"
              onClick={onClearStatus}
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

      {/* Doctor 报告（与表单卡为兄弟节点） */}
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
  );
};
