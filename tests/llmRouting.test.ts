/**
 * 按角色路由模型（llmRouting）纯函数测试
 *
 * 覆盖：总开关关闭/旧数据无字段 → 全 undefined（零行为变化）；
 * 命中 → profileId；指向已删档/激活档自身/未配置/空 routes → undefined；
 * stageToRole 五阶段映射完整；getDefaultStyleConfig 默认值。
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  ALL_LLM_ROLES,
  ROLE_LABELS,
  resolveModelForRole,
  resolveRouteForRole,
  stageToRole,
} from '../src/services/llmRouting';
import { getDefaultStyleConfig } from '../src/services/storage';
import type { LlmRoleRouting } from '../src/types/novel';

const PROFILES = [
  { id: 'p-strong', modelName: 'glm-5' },
  { id: 'p-cheap', modelName: 'deepseek-chat' },
];
const ACTIVE_ID = 'p-cheap';

const enabledRouting = (routes: LlmRoleRouting['routes']): LlmRoleRouting => ({
  enabled: true,
  routes,
});

describe('resolveModelForRole / resolveRouteForRole', () => {
  it('enabled=false：任何角色都返回 undefined（全走激活档）', () => {
    const routing: LlmRoleRouting = { enabled: false, routes: { write: 'p-strong' } };
    for (const role of ALL_LLM_ROLES) {
      expect(resolveModelForRole(routing, role, PROFILES, ACTIVE_ID)).toBeUndefined();
    }
  });

  it('旧数据兼容：routing 为 undefined（无该字段）→ undefined', () => {
    expect(
      resolveModelForRole(undefined, 'write', PROFILES, ACTIVE_ID)
    ).toBeUndefined();
    expect(resolveRouteForRole(undefined, 'audit', PROFILES, ACTIVE_ID)).toBeUndefined();
  });

  it('命中非激活档 → 返回该档 id 与模型名', () => {
    expect(resolveModelForRole(enabledRouting({ write: 'p-strong' }), 'write', PROFILES, ACTIVE_ID)).toBe('p-strong');
    expect(
      resolveRouteForRole(enabledRouting({ write: 'p-strong' }), 'write', PROFILES, ACTIVE_ID)
    ).toEqual({ profileId: 'p-strong', modelName: 'glm-5' });
  });

  it('指向已删除的配置档 → undefined（跟随激活档）', () => {
    expect(
      resolveModelForRole(enabledRouting({ audit: 'p-deleted' }), 'audit', PROFILES, ACTIVE_ID)
    ).toBeUndefined();
  });

  it('角色未配置 / routes 为空对象 → undefined', () => {
    expect(
      resolveModelForRole(enabledRouting({}), 'revise', PROFILES, ACTIVE_ID)
    ).toBeUndefined();
    expect(
      resolveModelForRole({ enabled: true, routes: {} }, 'revise', PROFILES, ACTIVE_ID)
    ).toBeUndefined();
  });

  it('路由指向当前激活档自身 → undefined（无需覆盖，请求路径与现状一致）', () => {
    expect(
      resolveModelForRole(enabledRouting({ settle: 'p-cheap' }), 'settle', PROFILES, ACTIVE_ID)
    ).toBeUndefined();
  });
});

describe('stageToRole', () => {
  it('管线五阶段完整映射；post_validate 归入 audit', () => {
    expect(stageToRole('plan')).toBe('plan');
    expect(stageToRole('write')).toBe('write');
    expect(stageToRole('audit')).toBe('audit');
    expect(stageToRole('post_validate')).toBe('audit');
    expect(stageToRole('revise')).toBe('revise');
    expect(stageToRole('settle')).toBe('settle');
  });

  it('无 LLM 的阶段（done/error/init/未知）→ null', () => {
    expect(stageToRole('done')).toBeNull();
    expect(stageToRole('error')).toBeNull();
    expect(stageToRole('init')).toBeNull();
    expect(stageToRole('whatever')).toBeNull();
  });
});

describe('角色表与默认值', () => {
  it('7 个角色齐全且中文名非空', () => {
    expect(ALL_LLM_ROLES).toEqual([
      'write',
      'audit',
      'revise',
      'plan',
      'settle',
      'intent',
      'crossAudit',
    ]);
    for (const role of ALL_LLM_ROLES) {
      expect(ROLE_LABELS[role].length).toBeGreaterThan(0);
    }
    expect(ROLE_LABELS.write).toBe('正文写作');
    expect(ROLE_LABELS.crossAudit).toBe('跨章抽检');
  });

  it('getDefaultStyleConfig：默认关闭、空路由表（旧行为）', () => {
    const def = getDefaultStyleConfig();
    expect(def.llmRoleRouting).toEqual({ enabled: false, routes: {} });
    expect(def.llmRoleRouting?.enabled).not.toBe(true);
  });
});
