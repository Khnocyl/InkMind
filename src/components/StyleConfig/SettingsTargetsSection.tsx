/**
 * 设置分区：全书 · 每日 · 抽检目标
 * （自 StyleAndEngineManager 拆出；纯 props，无本地 state）
 *
 * 注意：目标总章数输入的 max 用 effectiveTargetChapterMax(当前值) 动态抬升，
 * 不得写死常量（存量 >5000 章的书一碰控件会被静默改小）——
 * tests/projectLimits.test.ts 按路径盯防本文件，勿回退。
 */
import React from 'react';
import type { ProjectConfig, StyleConfig } from '../../types/novel';
import { effectiveTargetChapterMax } from '../../services/projectLimits';
import { resolveChapterWordTarget } from '../../services/proseWords';

interface SettingsTargetsSectionProps {
  styleConfig: StyleConfig;
  onUpdateStyleConfig: (
    config: StyleConfig | ((prev: StyleConfig) => StyleConfig)
  ) => Promise<void> | void;
  projectConfig?: ProjectConfig;
  onUpdateProjectConfig?: (config: ProjectConfig) => void;
}

export const SettingsTargetsSection: React.FC<SettingsTargetsSectionProps> = ({
  styleConfig,
  onUpdateStyleConfig,
  projectConfig,
  onUpdateProjectConfig,
}) => {
  return (
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
                /* 上限随当前值抬升（effectiveTargetChapterMax）：导入不钳制，存量可能 >5000，
                   若 max 写死常量，用户一碰控件 HTML 就把既有值静默改小——违反 projectLimits 的不变量 */
                max={effectiveTargetChapterMax(
                  projectConfig.targetChapterCount ?? projectConfig.totalChapters ?? 100
                )}
                step={1}
                value={
                  projectConfig.targetChapterCount ?? projectConfig.totalChapters ?? 100
                }
                onChange={(e) => {
                  const n = Math.max(
                    1,
                    Math.min(
                      effectiveTargetChapterMax(
                        projectConfig.targetChapterCount ?? projectConfig.totalChapters ?? 100
                      ),
                      Number(e.target.value) || 1
                    )
                  );
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
  );
};
