/**
 * 设置分区：按角色路由模型 + 向量检索 API（Embedding）
 * （自 StyleAndEngineManager 拆出；路由草稿与 Embedding 表单 state 挂壳层 Hook）
 */
import React from 'react';
import { Sliders, Database, Save, Loader2, Stethoscope } from 'lucide-react';
import { thirdPartyHost } from '../../services/llmClient';
import type { LLMProfilePublic } from '../../services/llmClient';
import { ALL_LLM_ROLES, ROLE_LABELS } from '../../services/llmRouting';
import type { RoleRoutingApi, EmbeddingApi } from './settingsHooks';

interface SettingsRoutingSectionProps {
  routing: RoleRoutingApi;
  embedding: EmbeddingApi;
  /** 现存配置档（路由下拉与「已删档自动回落」校验共用） */
  profiles: LLMProfilePublic[];
  /** 模型域保存中标志（避免保存路由与保存配置档并发） */
  isSavingConfig: boolean;
  /** 壳层状态条（仅渲染 Embedding/向量相关消息） */
  statusMsg: string;
}

export const SettingsRoutingSection: React.FC<SettingsRoutingSectionProps> = ({
  routing,
  embedding,
  profiles,
  isSavingConfig,
  statusMsg,
}) => {
  const {
    routingEnabled,
    setRoutingEnabled,
    routingRoutes,
    setRoutingRoutes,
    handleSaveRoleRouting,
  } = routing;
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
  } = embedding;

  return (
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
          {statusMsg &&
            (statusMsg.includes('Embedding') ||
              statusMsg.includes('向量') ||
              statusMsg.includes('embedding') ||
              statusMsg.includes('Embedding')) && (
              <p
                className={`text-xs font-semibold ${
                  statusMsg.includes('✅')
                    ? 'text-emerald-800'
                    : statusMsg.includes('❌')
                      ? 'text-red-700'
                      : 'text-slate-700'
                }`}
              >
                {statusMsg}
              </p>
            )}
          </div>
        </div>
  );
};
