/**
 * 设置分区：Auto-Pilot 连载默认参数
 * （自 StyleAndEngineManager 拆出；纯 props，无本地 state）
 */
import React from 'react';
import type { StyleConfig } from '../../types/novel';

interface SettingsAutopilotSectionProps {
  styleConfig: StyleConfig;
  onUpdateStyleConfig: (
    config: StyleConfig | ((prev: StyleConfig) => StyleConfig)
  ) => Promise<void> | void;
}

export const SettingsAutopilotSection: React.FC<SettingsAutopilotSectionProps> = ({
  styleConfig,
  onUpdateStyleConfig,
}) => {
  return (
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
  );
};
