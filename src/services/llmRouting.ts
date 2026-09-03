/**
 * 按角色路由模型（写作用强模型、审校用轻量模型）。
 *
 * 纯解析层：不含 IO。配置档列表由调用方（pipeline / llmClient 的 API 助手）拉取
 * 后传入；返回 undefined 一律表示「跟随激活档」——与路由关闭时行为完全一致。
 */
import type { LlmRole, LlmRoleRouting } from '../types/novel';

/** 路由解析所需的最小配置档形状（LLMProfilePublic 的结构子集，便于测试） */
export interface RoutingProfileLike {
  id: string;
  modelName?: string;
}

/** 命中路由时的请求目标：profileId 交后端切换 baseURL/Key/模型，model 用于用量计价与调用轨迹 */
export interface LlmRouteTarget {
  profileId: string;
  modelName?: string;
}

/** 全部角色（UI 渲染顺序即此数组顺序） */
export const ALL_LLM_ROLES: LlmRole[] = [
  'write',
  'audit',
  'revise',
  'plan',
  'settle',
  'intent',
  'crossAudit',
];

/** 角色中文名（设置页与进度提示共用） */
export const ROLE_LABELS: Record<LlmRole, string> = {
  write: '正文写作',
  audit: '硬伤与文笔审',
  revise: '修复环',
  plan: '分镜规划',
  settle: '记忆回写',
  intent: '写前意图',
  crossAudit: '跨章抽检',
};

/**
 * 管线阶段 → 角色。post_validate 是确定性校验（零 LLM），归入 audit 档
 * 以覆盖同阶段可能出现的补写/复审调用；done/error/init 无 LLM 调用 → null。
 */
export function stageToRole(stage: string): LlmRole | null {
  switch (stage) {
    case 'plan':
      return 'plan';
    case 'write':
      return 'write';
    case 'audit':
    case 'post_validate':
      return 'audit';
    case 'revise':
      return 'revise';
    case 'settle':
      return 'settle';
    default:
      return null;
  }
}

/**
 * 解析角色的路由目标（完整版）。
 * - 总开关未开启 / 角色未配置 / 指向已删除的配置档 → undefined（跟随激活档）
 * - 指向当前激活档 → undefined（无需覆盖，请求路径与现状一致）
 */
export function resolveRouteForRole(
  routing: LlmRoleRouting | undefined | null,
  role: LlmRole,
  profiles: RoutingProfileLike[],
  activeProfileId?: string
): LlmRouteTarget | undefined {
  if (routing?.enabled !== true) return undefined;
  const id = routing.routes?.[role];
  if (!id) return undefined;
  if (id === activeProfileId) return undefined;
  const profile = profiles.find((p) => p.id === id);
  if (!profile) return undefined; // 档已删除：跟随激活档
  return { profileId: profile.id, modelName: profile.modelName || undefined };
}

/**
 * 解析角色应使用的配置档 id（规格接口，测试与 UI 校验用）。
 * 命中且非激活档 → 返回该配置档 id；否则 undefined（跟随激活档）。
 */
export function resolveModelForRole(
  routing: LlmRoleRouting | undefined | null,
  role: LlmRole,
  profiles: RoutingProfileLike[],
  activeProfileId?: string
): string | undefined {
  return resolveRouteForRole(routing, role, profiles, activeProfileId)?.profileId;
}
