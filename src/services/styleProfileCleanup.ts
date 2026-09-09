import type { BookProject, StyleProfile } from '../types/novel';

/**
 * 文风仿写档案被删除后，清理项目里对它的**悬空引用**。
 *
 * 背景（用户反馈）：向导第一步的「行文文风」下拉会把 `config.writingStyle` 里
 * 既不是内置预设、又匹配不到任何档案的历史字符串，原样渲染成「当前配置」一项。
 * 而选中档案时写入的正是 `仿写·<档案名>：…`（InspirationStep.resolveWritingStyle），
 * 删除档案时没人清它 —— 于是已删档案的名字继续出现在下拉里。
 *
 * 同时清理 `customParameters.wizardStyleProfileId`（向导选中的档案 id）。
 */
export function pruneDeletedStyleReferences(
  project: Pick<BookProject, 'config' | 'styleConfig'>,
  removed: StyleProfile[]
): Partial<BookProject> {
  if (!removed.length || !project.config) return {};
  const nextConfig = { ...project.config };
  let changed = false;

  const ws = (nextConfig.writingStyle || '').trim();
  if (
    ws &&
    removed.some(
      (p) =>
        (p.name && ws.startsWith(`仿写·${p.name}`)) ||
        (p.authorStyle && ws === p.authorStyle.trim())
    )
  ) {
    nextConfig.writingStyle = '';
    changed = true;
  }

  const params = { ...(nextConfig.customParameters || {}) } as Record<string, unknown>;
  const pinned = params.wizardStyleProfileId;
  if (typeof pinned === 'string' && removed.some((p) => p.id === pinned)) {
    delete params.wizardStyleProfileId;
    nextConfig.customParameters = params as typeof nextConfig.customParameters;
    changed = true;
  }

  return changed ? { config: nextConfig } : {};
}

/**
 * 找出「上一次有、这一次没有」的档案（用于检测删除）。
 * 注意只按 id 判断：编辑（同 id 改名）不算删除。
 */
export function removedStyleProfiles(
  prev: StyleProfile[] | undefined,
  next: StyleProfile[] | undefined
): StyleProfile[] {
  const nextIds = new Set((next || []).map((p) => p.id));
  return (prev || []).filter((p) => !nextIds.has(p.id));
}
