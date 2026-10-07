/**
 * 设置分区：关于 InkMind · 版本与更新检测
 * （自 StyleAndEngineManager 拆出；更新检测 state 由壳层 useUpdateCheck 持有）
 */
import React from 'react';
import {
  Sparkles,
  RefreshCw,
  ExternalLink,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { CURRENT_APP_VERSION, GITHUB_REPO, GITHUB_RELEASES_URL } from '../../services/appUpdate';
import { ReleaseNotesViewer } from './ReleaseNotesViewer';
import { DesktopUpdaterPanel } from './DesktopUpdaterPanel';
import type { UpdateCheckApi } from './settingsHooks';

interface SettingsAboutSectionProps {
  update: UpdateCheckApi;
}

export const SettingsAboutSection: React.FC<SettingsAboutSectionProps> = ({ update }) => {
  const { updateCheckState, handleCheckUpdate, desktopUpdSupported, desktopUpdVersion } = update;

  return (
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
                v{desktopUpdVersion || CURRENT_APP_VERSION}
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
                （{desktopUpdSupported === true ? '应用内下载 · 自动覆盖安装' : '连接 GitHub Releases 官方发布源'}）
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {desktopUpdSupported === true
                ? '检测到新版本后可直接在软件内下载，完成后一键重启自动完成升级。'
                : '点击按钮即可实时查询线上是否有新版本安装包发布。'}
            </p>
          </div>
          {desktopUpdSupported === false && (
          <button
            type="button"
            disabled={updateCheckState.isChecking}
            onClick={handleCheckUpdate}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-bold rounded-xl bg-black text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-950 dark:hover:bg-slate-200 disabled:opacity-50 transition shadow-sm cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${updateCheckState.isChecking ? 'animate-spin' : ''}`} />
            {updateCheckState.isChecking ? '正在检测最新版本…' : '立即检查更新'}
          </button>
          )}
        </div>

        {/* Electron 安装版：应用内下载 + 一键重启覆盖安装 */}
        {desktopUpdSupported === true && (
          <DesktopUpdaterPanel currentVersion={desktopUpdVersion} />
        )}

        {/* 检查结果区域（Web / 单文件版：跳转 GitHub Releases） */}
        {desktopUpdSupported === false && updateCheckState.result && (
          <div className="pt-2 animate-fadeIn">
            {updateCheckState.result.status === 'latest' && (
              <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/70 text-emerald-900 flex items-start gap-3 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-200">
                <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <div className="font-bold text-sm">
                    当前已是最新版本 (v{CURRENT_APP_VERSION})
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
                        <span>发现新版本：v{updateCheckState.result.latestVersion}</span>
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
                  <ReleaseNotesViewer content={updateCheckState.result.releaseNotes} />
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
  );
};
