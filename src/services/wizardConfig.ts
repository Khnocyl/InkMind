/**
 * 向导「第 1 步」表单 → ProjectConfig（单一构造口径）。
 *
 * 为什么单独成模块：这段此前是组件内的**逐字段字面量**，而向导提交走的是
 * `updateAndSave({ config })`——**整表替换**。于是任何「向导不管理」的 ProjectConfig
 * 字段都会在点「下一步」时被静默丢掉：
 *   - `crossAuditRecentCount`（跨章抽检窗口，用户刚在面板里设成 30 → 变回默认 5）
 *   - `targetAudience`（既有问题，同样在这里被吃掉）
 * 抽成纯函数后不变量可测：**只覆盖向导真正管理的字段，其余原样保留**——
 * 以后 ProjectConfig 再加字段，也不会重蹈覆辙。
 */
import type { ProjectConfig } from '../types/novel';

export interface WizardConfigForm {
  inspiration: string;
  totalChapters: number;
  wordsPerChapter: number;
  /** 已由 resolveWritingStyle 解析出的行文文风键 */
  writingStyle: string;
  genre: string;
  genrePackId?: string;
  /** 选中的文风档案 id（写入 customParameters.wizardStyleProfileId） */
  styleProfileId?: string | null;
}

export function buildWizardProjectConfig(
  initialConfig: ProjectConfig | null | undefined,
  form: WizardConfigForm
): ProjectConfig {
  const base = initialConfig || ({} as ProjectConfig);
  return {
    // 先展开既有配置：保住向导不管理的字段（crossAuditRecentCount / targetAudience / 未来新增字段）
    ...base,
    inspiration: form.inspiration,
    totalChapters: form.totalChapters,
    wordsPerChapter: form.wordsPerChapter,
    targetChapterCount: form.totalChapters,
    targetWordCountPerChapter: form.wordsPerChapter,
    writingStyle: form.writingStyle,
    genre: form.genre,
    // customParameters 是「向导管理的容器」：保留其中非向导键，覆盖向导键
    customParameters: {
      ...(base.customParameters || {}),
      genrePackId: form.genrePackId,
      wizardStyleProfileId: form.styleProfileId || undefined,
    },
  };
}
