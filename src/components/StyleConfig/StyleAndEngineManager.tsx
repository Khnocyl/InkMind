import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectConfig, StyleConfig } from '../../types/novel';
import { GenrePackPanel } from './GenrePackPanel';
import { StyleImitatePanel } from './StyleImitatePanel';
import { SettingsAppearanceSection } from './SettingsAppearanceSection';
import { SettingsAboutSection } from './SettingsAboutSection';
import { SettingsTargetsSection } from './SettingsTargetsSection';
import { SettingsAutopilotSection } from './SettingsAutopilotSection';
import { SettingsCoreStyleSection } from './SettingsCoreStyleSection';
import { SettingsBlacklistSection } from './SettingsBlacklistSection';
import { SettingsRoutingSection } from './SettingsRoutingSection';
import { SettingsModelsSection } from './SettingsModelsSection';
import {
  useLLMProfiles,
  useDoctor,
  useEmbeddingConfig,
  useRoleRouting,
  useUpdateCheck,
} from './settingsHooks';

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
  const llm = useLLMProfiles(pushStatus);
  const doctor = useDoctor(pushStatus);
  const emb = useEmbeddingConfig(pushStatus);
  const routing = useRoleRouting(styleConfig, onUpdateStyleConfig, llm.profiles, pushStatus);
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
      {/* API Key 与服务端大模型配置 + Doctor 报告 */}
      {activeSection === 'models' && (
        <SettingsModelsSection
          llm={llm}
          doctor={doctor}
          statusMsg={saveStatusMsg}
          onClearStatus={() => setSaveStatusMsg('')}
          statusBannerRef={statusBannerRef}
          doctorSectionRef={doctorSectionRef}
        />
      )}
      {/* 按角色路由模型 + 向量检索 API（合并卡：写作用强模型、审校用轻量模型） */}
      {activeSection === 'routing' && (
        <SettingsRoutingSection
          routing={routing}
          embedding={emb}
          profiles={llm.profiles}
          isSavingConfig={llm.isSavingConfig}
          statusMsg={saveStatusMsg}
        />
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
