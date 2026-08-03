import React, { useMemo, useRef, useState } from 'react';
import type { ProjectConfig, StyleConfig, StyleProfile } from '../../types/novel';
import { Sparkles, BookOpen, Layers, Type, Flame, Wand2, Compass, Library, Fingerprint, Upload, Loader2 } from 'lucide-react';
import { listGenrePacks, resolveGenrePack } from '../../services/genrePacks';
import { analyzeReferenceStyle, importStyleProfile } from '../../services/styleImitate';

interface InspirationStepProps {
  initialConfig: ProjectConfig;
  /** 本书已导入的文风仿写档案（引擎与风格页导入，或本向导内直接导入） */
  styleProfiles?: StyleProfile[];
  /** 当前激活的仿写 id */
  activeStyleProfileId?: string | null;
  /** R3 收尾：新书 styleConfig（含黑名单/few-shot 基线，导入档案基于它合并） */
  styleConfig?: StyleConfig;
  onNext: (
    config: ProjectConfig,
    meta?: { styleProfileId?: string | null }
  ) => void;
  isGenerating: boolean;
  progressMsg?: string;
  /** R3 收尾：向导内直接导入文风档案 → 写入新书 styleConfig（随向导落盘） */
  onStyleConfigChange?: (sc: StyleConfig) => Promise<unknown> | void;
}

const PRESET_INSPIRATIONS = [
  {
    title: '东方玄幻 · 逆命禁忌',
    text: '主角天生丹田封闭，被迫在宗门做杂役。无意间从古殿断墙缝隙中挖出一枚生锈的饕餮残齿，每当夜深人静便会吞噬周遭星力并返还凝练至速的荒古刀意。但他很快发现，这残齿的主人并不是传说中的神灵，而是正在被天道大阵镇压在归墟深处、企图利用宿主解封的毁灭之源……',
    genre: '东方玄幻·诡秘流',
    packId: 'xuanhuan',
  },
  {
    title: '赛博修仙 · 飞升陷阱',
    text: '在这个世界，修仙境界通过植入灵能芯片与高阶灵脉算力阵列提升。元婴即是分布式云端核心，渡劫则是对抗天上公司放出的杀毒机器人与超载雷击。主角是一名基层反编译骇客，意外捕获了三百年前上一代飞升大能遗落的底层未加密日记，得知所谓的“白日飞升”其实是把肉身火化、神魂上传成为天上集团的永生劳工电池……',
    genre: '科幻赛博·修仙智斗',
    packId: 'kehuan',
  },
  {
    title: '传统硬核武侠 · 杀手归隐',
    text: '江湖顶尖风媒组织“听雨楼”的天字第一号刺客在最后一次任务后退隐，隐姓埋名在小江南开了一家打铁铺。然而某日深夜，一具插着宫廷密旨与西域寒淬剧毒短箭的千户尸体死在铺子门前。为保护收养的孤女，他不得不重拾断刃，卷入一场朝堂倾轧与隐世十大名剑争夺的惊天旋涡。',
    genre: '传统硬核·冷酷武侠',
    packId: 'wuxia',
  },
  {
    title: '克苏鲁悬疑 · 守夜探秘',
    text: '大雾深锁的黑铁时代，帝国依靠燃烧煤精与古神化石维系蒸汽灯塔。主角作为最底层的巡夜巡官，每天的工作是在凌晨三点前清理街上那些因为聆听雾中呓语而变异成晶石怪物的市民。当他发现随身携带的怀表开始倒转，且每天清晨醒来口袋里都会多出一张写着自己死亡倒计时的陈旧羊皮纸时，求生的倒计时正式开启。',
    genre: '悬疑诡案·蒸汽克苏鲁',
    packId: 'xuanyi',
  },
];

const STYLE_PRESETS = [
  '冷峻简练·沉浸画面（严格短句，重动作细节，绝无多余解说，强力 Show Dont Tell）',
  '金庸传统·快疾硬核（交锋都在电光石火之间，招式清晰，力量感极致对冲）',
  '史诗群像·智斗深邃（古朴雄浑，重世界观法则与阵营博弈，逻辑严密）',
  '网文爽快·反转利落（节奏极其明快，悬念环环相扣，绝不拖泥带水）',
  '暗黑诗意·细微压抑（充满冷色调感官渲染，心理防备与潜流交锋层层递进）',
];

export const InspirationStep: React.FC<InspirationStepProps> = ({
  initialConfig,
  styleProfiles = [],
  activeStyleProfileId = null,
  onNext,
  isGenerating,
  progressMsg,
  onStyleConfigChange,
  styleConfig,
}) => {
  const packs = listGenrePacks();
  const [inspiration, setInspiration] = useState(initialConfig.inspiration || PRESET_INSPIRATIONS[0].text);
  const [totalChapters, setTotalChapters] = useState(
    initialConfig.targetChapterCount || initialConfig.totalChapters || 100
  );
  const [wordsPerChapter, setWordsPerChapter] = useState(
    initialConfig.targetWordCountPerChapter || initialConfig.wordsPerChapter || 3000
  );
  const [genre, setGenre] = useState(initialConfig.genre || PRESET_INSPIRATIONS[0].genre);
  const [packId, setPackId] = useState(
    (initialConfig.customParameters?.genrePackId as string) ||
      resolveGenrePack(initialConfig.genre || PRESET_INSPIRATIONS[0].genre).id
  );

  /** select value: preset 原文 或 profile:<id> */
  const initialStyleKey = useMemo(() => {
    const fromParam = initialConfig.customParameters?.wizardStyleProfileId as
      | string
      | undefined;
    if (fromParam && styleProfiles.some((p) => p.id === fromParam)) {
      return `profile:${fromParam}`;
    }
    if (
      activeStyleProfileId &&
      styleProfiles.some((p) => p.id === activeStyleProfileId)
    ) {
      return `profile:${activeStyleProfileId}`;
    }
    const ws = initialConfig.writingStyle || '';
    if (ws && STYLE_PRESETS.includes(ws)) return ws;
    // 与某档案 authorStyle 匹配
    const hit = styleProfiles.find(
      (p) => p.authorStyle === ws || `仿写·${p.name}` === ws
    );
    if (hit) return `profile:${hit.id}`;
    if (ws && !STYLE_PRESETS.includes(ws)) {
      // 自定义历史值：挂到自定义项
      return ws;
    }
    return STYLE_PRESETS[0];
  }, [initialConfig, styleProfiles, activeStyleProfileId]);

  const [styleKey, setStyleKey] = useState(initialStyleKey);

  // R3 收尾：向导内导入文风仿写（粘贴/上传 → 分析 → 写入新书 styleConfig）
  const styleFileRef = useRef<HTMLInputElement>(null);
  const [styleSample, setStyleSample] = useState('');
  const [styleBusy, setStyleBusy] = useState(false);
  const [styleMsg, setStyleMsg] = useState<string | null>(null);

  const importStyleInWizard = async (text: string, sourceLabel: string) => {
    if (!onStyleConfigChange || !text.trim() || styleBusy) return;
    setStyleBusy(true);
    setStyleMsg(null);
    try {
      const { profile } = await analyzeReferenceStyle({
        text,
        name: undefined,
        sourceLabel,
        onProgress: (m) => setStyleMsg(m),
      });
      const base = styleConfig || {
        clicheBlacklist: [],
        customBlacklist: [],
        enforceShowDontTell: true,
        forbidEndingSublimation: true,
        fewShotExamples: [],
        selectedExampleId: '',
      };
      await onStyleConfigChange(
        importStyleProfile(base, profile, {
          activate: true,
          syncFewShot: true,
        })
      );
      setStyleKey(`profile:${profile.id}`);
      setStyleSample('');
      setStyleMsg(`✅ 已导入并激活「${profile.name}」，将作为本新书默认文风`);
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      setStyleMsg(`❌ ${m}`);
    } finally {
      setStyleBusy(false);
    }
  };

  const handleStyleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || styleBusy) return;
    const text = await file.text();
    await importStyleInWizard(text.slice(0, 20000), file.name);
  };

  const selectedPack = packs.find((p) => p.id === packId) || packs[0];

  const resolveWritingStyle = (
    key: string
  ): { writingStyle: string; styleProfileId: string | null } => {
    if (key.startsWith('profile:')) {
      const id = key.slice('profile:'.length);
      const p = styleProfiles.find((x) => x.id === id);
      if (p) {
        const tip = (p.authorStyle || p.styleGuide || p.name).trim().slice(0, 200);
        return {
          writingStyle: `仿写·${p.name}${tip ? `：${tip}` : ''}`,
          styleProfileId: p.id,
        };
      }
    }
    return { writingStyle: key, styleProfileId: null };
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inspiration.trim()) return;
    const { writingStyle, styleProfileId } = resolveWritingStyle(styleKey);
    onNext(
      {
        inspiration,
        totalChapters,
        wordsPerChapter,
        targetChapterCount: totalChapters,
        targetWordCountPerChapter: wordsPerChapter,
        writingStyle,
        genre,
        customParameters: {
          ...(initialConfig.customParameters || {}),
          genrePackId: packId,
          wizardStyleProfileId: styleProfileId || undefined,
        },
      },
      { styleProfileId }
    );
  };

  const estimatedTotal = totalChapters * wordsPerChapter;

  return (
    <div className="max-w-5xl mx-auto py-6 animate-fadeIn">
      <div className="bg-white border border-slate-200 rounded-2xl p-8 shadow-xl">
        <div className="flex items-center space-x-3 mb-6 border-b border-slate-200 pb-5">
          <div className="p-3 bg-indigo-600 rounded-xl shadow-md text-white">
            <Wand2 className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-slate-900">
              第一步：注入最初灵感，全自动推导完整脉络
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              只需输入你心中渴望创作的故事起点，或直接点击下方灵感模板。AI 将帮你构建宏伟丰满的小说宇宙。
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-8">
          {/* 灵感模板快捷选择 */}
          <div>
            <label className="block text-xs font-semibold text-indigo-700 uppercase tracking-wider mb-3 flex items-center space-x-1.5">
              <Compass className="w-4 h-4" />
              <span>灵感火花速选预设（点击立即填充）</span>
            </label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {PRESET_INSPIRATIONS.map((preset, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    setInspiration(preset.text);
                    setGenre(preset.genre);
                    if (preset.packId) setPackId(preset.packId);
                  }}
                  className={`text-left p-4 rounded-xl border transition-all duration-300 relative overflow-hidden group ${
                    inspiration === preset.text
                      ? 'border-indigo-600 bg-indigo-50 shadow-md'
                      : 'border-slate-200 bg-slate-50 hover:border-slate-400 hover:bg-slate-100'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-semibold text-sm text-slate-900 group-hover:text-indigo-600 transition-colors">
                      {preset.title}
                    </span>
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-white text-indigo-700 border border-slate-200 font-medium">
                      {preset.genre}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 line-clamp-2 leading-relaxed">
                    {preset.text}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {/* 核心灵感输入框 */}
          <div className="relative">
            <label className="block text-sm font-semibold text-slate-900 mb-2 flex items-center justify-between">
              <span className="flex items-center space-x-2">
                <Sparkles className="w-4 h-4 text-indigo-600" />
                <span>你的故事灵感核心描述</span>
              </span>
              <span className="text-xs text-slate-500 font-normal">
                建议包含：背景设想、主角金手指或处境、你想展现的核心矛盾
              </span>
            </label>
            <textarea
              value={inspiration}
              onChange={(e) => setInspiration(e.target.value)}
              rows={6}
              disabled={isGenerating}
              placeholder="在这里写下你的灵感描述……"
              className="w-full bg-slate-50 border border-slate-300 rounded-xl p-4 text-slate-900 placeholder-slate-400 focus:border-indigo-600 focus:ring-2 focus:ring-indigo-600/20 focus:outline-none transition-all resize-y text-sm leading-relaxed shadow-inner focus:bg-white"
            />
          </div>

          {/* 参数和风格配置格 */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 bg-slate-50 p-6 rounded-xl border border-slate-200">
            {/* 题材包 */}
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-2 flex items-center space-x-1.5">
                <Library className="w-3.5 h-3.5 text-violet-600" />
                <span>题材规则包（写章约束）</span>
              </label>
              <select
                value={packId}
                disabled={isGenerating}
                onChange={(e) => {
                  const id = e.target.value;
                  setPackId(id);
                  const p = packs.find((x) => x.id === id);
                  if (p) setGenre(p.name);
                }}
                className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:border-indigo-600 focus:outline-none"
              >
                {packs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-slate-500 mt-1 line-clamp-2">{selectedPack.description}</p>
            </div>

            {/* 题材标签 */}
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-2 flex items-center space-x-1.5">
                <BookOpen className="w-3.5 h-3.5 text-blue-600" />
                <span>题材标签（展示用）</span>
              </label>
              <input
                type="text"
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                disabled={isGenerating}
                placeholder="如 东方玄幻·暗黑诡秘"
                className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:border-indigo-600 focus:outline-none"
              />
            </div>

            {/* 章节数量 */}
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-2 flex items-center space-x-1.5">
                <Layers className="w-3.5 h-3.5 text-emerald-600" />
                <span>目标总章节数：<strong className="text-emerald-700 font-bold">{totalChapters} 章</strong></span>
              </label>
              <input
                type="range"
                min={20}
                max={500}
                step={10}
                value={totalChapters}
                onChange={(e) => setTotalChapters(Number(e.target.value))}
                disabled={isGenerating}
                className="w-full accent-emerald-600 mt-1 cursor-pointer"
              />
              <div className="flex justify-between text-[11px] text-slate-500 mt-1 font-mono">
                <span>20章(短篇)</span>
                <span>100章(主流)</span>
                <span>500章(宏篇)</span>
              </div>
            </div>

            {/* 每章字数 */}
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-2 flex items-center space-x-1.5">
                <Type className="w-3.5 h-3.5 text-purple-600" />
                <span>单章目标字数：<strong className="text-purple-700 font-bold">{wordsPerChapter} 字</strong></span>
              </label>
              <input
                type="range"
                min={2000}
                max={6000}
                step={500}
                value={wordsPerChapter}
                onChange={(e) => setWordsPerChapter(Number(e.target.value))}
                disabled={isGenerating}
                className="w-full accent-purple-600 mt-1 cursor-pointer"
              />
              <div className="flex justify-between text-[11px] text-slate-500 mt-1 font-mono">
                <span>2000字(连载)</span>
                <span>3500(主流)</span>
                <span>6000(大章)</span>
              </div>
            </div>

            {/* 全书目标预估（与顶栏/仪表盘同源字段） */}
            <div className="md:col-span-2 lg:col-span-3 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-emerald-950">
                <div className="font-bold">预估全书目标（同步进度条）</div>
                <div className="text-[11px] text-emerald-900/80 mt-0.5 font-mono">
                  {totalChapters} 章 × {wordsPerChapter.toLocaleString()} 字/章
                </div>
              </div>
              <div className="text-right">
                <div className="text-lg font-mono font-bold text-emerald-800">
                  {estimatedTotal.toLocaleString()} 字
                </div>
                <div className="text-[11px] text-emerald-700">
                  ≈ {(estimatedTotal / 10000).toFixed(1)} 万字
                </div>
              </div>
            </div>

            {/* 写作风格：内置预设 + 本书已导入仿写 */}
            <div className="md:col-span-2 lg:col-span-1">
              <label className="block text-xs font-medium text-slate-700 mb-2 flex items-center space-x-1.5">
                <Flame className="w-3.5 h-3.5 text-amber-600" />
                <span>行文文风与短句约束</span>
              </label>
              <select
                value={styleKey}
                onChange={(e) => setStyleKey(e.target.value)}
                disabled={isGenerating}
                className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:border-indigo-600 focus:outline-none truncate"
              >
                {styleProfiles.length > 0 && (
                  <optgroup label="已导入文风仿写（引擎与风格）">
                    {styleProfiles.map((p) => (
                      <option key={p.id} value={`profile:${p.id}`}>
                        仿写 · {p.name}
                        {p.authorStyle ? ` · ${p.authorStyle.slice(0, 24)}` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="内置预设">
                  {STYLE_PRESETS.map((style, i) => (
                    <option key={i} value={style}>
                      {style}
                    </option>
                  ))}
                </optgroup>
                {/* 历史自定义 writingStyle 不在上述列表时保留一项 */}
                {styleKey &&
                  !styleKey.startsWith('profile:') &&
                  !STYLE_PRESETS.includes(styleKey) && (
                    <optgroup label="当前配置">
                      <option value={styleKey}>{styleKey.slice(0, 48)}</option>
                    </optgroup>
                  )}
              </select>
              <p className="text-[10px] text-slate-500 mt-1.5 leading-relaxed">
                {styleProfiles.length > 0
                  ? `已载入 ${styleProfiles.length} 条仿写档案；选「仿写·…」会在向导与正文中启用该档案。`
                  : '还没有仿写档案？可以直接在下方「导入参考文风」粘贴样本创建，无需离开向导。'}
              </p>
            </div>

            {/* R3 收尾：向导内直接导入参考文风（创建新书时选定文风） */}
            {onStyleConfigChange && (
              <div className="md:col-span-2 lg:col-span-1 mt-3 rounded-xl border border-dashed border-indigo-300 bg-indigo-50/40 p-3 space-y-2">
                <div className="flex items-center space-x-1.5 text-[11px] font-semibold text-indigo-800">
                  <Fingerprint className="w-3.5 h-3.5" />
                  <span>导入参考文风（可选，本新书直接启用）</span>
                </div>
                <textarea
                  value={styleSample}
                  onChange={(e) => setStyleSample(e.target.value)}
                  placeholder="粘贴一段目标作者的样章/片段（500–5000 字效果最佳）…"
                  rows={3}
                  disabled={styleBusy || isGenerating}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:border-indigo-600 focus:outline-none resize-none"
                />
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    disabled={!styleSample.trim() || styleBusy || isGenerating}
                    onClick={() => void importStyleInWizard(styleSample, '向导粘贴样本')}
                    className="flex items-center space-x-1 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-semibold rounded-lg disabled:opacity-50 disabled:pointer-events-none transition-all"
                  >
                    {styleBusy ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Wand2 className="w-3 h-3" />
                    )}
                    <span>{styleBusy ? '分析中…' : '分析并导入'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={styleBusy || isGenerating}
                    onClick={() => styleFileRef.current?.click()}
                    className="flex items-center space-x-1 px-3 py-1.5 bg-white hover:bg-slate-100 border border-slate-300 text-slate-700 text-[11px] font-semibold rounded-lg disabled:opacity-50 transition-all"
                  >
                    <Upload className="w-3 h-3" />
                    <span>上传文件</span>
                  </button>
                  <input
                    ref={styleFileRef}
                    type="file"
                    accept=".txt,.md,.docx,text/plain"
                    onChange={(e) => void handleStyleFile(e)}
                    className="hidden"
                  />
                </div>
                {styleMsg && (
                  <p className="text-[11px] text-slate-600 leading-relaxed whitespace-pre-line">
                    {styleMsg}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* 提交按钮及进度提示 */}
          <div className="flex flex-col items-center justify-center pt-4 border-t border-slate-200">
            {isGenerating ? (
              <div className="w-full max-w-md bg-indigo-50 border border-indigo-200 rounded-xl p-5 text-center space-y-3 shadow-md animate-pulse">
                <div className="flex items-center justify-center space-x-2 text-indigo-700 font-medium">
                  <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                  <span>AI 脑暴引擎极速构思中...</span>
                </div>
                <p className="text-xs text-slate-700 font-mono">
                  {progressMsg || '正在深度理解灵感逻辑，推导极具辨识度的爆款书名与简介...'}
                </p>
              </div>
            ) : (
              <button
                type="submit"
                disabled={!inspiration.trim()}
                className="px-8 py-4 bg-black hover:bg-neutral-800 text-white font-bold rounded-xl shadow-lg transition-all duration-300 transform hover:-translate-y-0.5 flex items-center space-x-3 text-base disabled:opacity-50 disabled:pointer-events-none"
              >
                <Sparkles className="w-5 h-5" />
                <span>✨ 启动 AI 推导：生成书名与核心简介</span>
              </button>
            )}
            <p className="text-xs text-slate-500 mt-3">
              💡 提示：按步暂停确认，每个阶段生成后你都可以自由编辑调整，再进行下阶段推导！
            </p>
          </div>
        </form>
      </div>
    </div>
  );
};
