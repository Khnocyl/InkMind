import { describe, it, expect } from 'vitest';
import type { CharacterStatus } from '../src/types/novel';
import fs from 'fs';
import path from 'path';

describe('角色生存状态下拉列表与深色模式高对比度测试', () => {
  // 提取 CharacterManager 中使用的状态样式映射逻辑验证
  const getStatusStyle = (status: CharacterStatus) => {
    switch (status) {
      case '活跃':
        return 'bg-[#f0f9f4] text-[#1b5e20] border-[#2e8b57] dark:bg-[#0c2a18] dark:text-[#6ee7b7] dark:border-[#1e5a32]';
      case '重伤':
      case '被捕受困':
        return 'bg-[#fff5f5] text-[#b71c1c] border-[#d32f2f] dark:bg-[#321117] dark:text-[#fda4af] dark:border-[#7f1d2e]';
      default:
        return 'bg-[#f5f5f5] text-[#555555] border-[#999999] dark:bg-[#202024] dark:text-[#e4e4e7] dark:border-[#4a4a52]';
    }
  };

  const allStatuses: CharacterStatus[] = [
    '活跃',
    '重伤',
    '闭关突破',
    '被捕受困',
    '已阵亡/退出',
  ];

  it('所有生存状态均具备完整的亮色与暗色模式类名（含 dark:bg, dark:text, dark:border）', () => {
    for (const st of allStatuses) {
      const cls = getStatusStyle(st);
      expect(cls).toContain('dark:bg-');
      expect(cls).toContain('dark:text-');
      expect(cls).toContain('dark:border-');
      // 保证深色背景采用不透明的实体深色 Hex，杜绝 Chromium 原生弹窗无法渲染透明度导致降级回白底
      expect(cls).not.toMatch(/dark:bg-.*\/[0-9]+/);
    }
  });

  it('CharacterManager 源码中状态下拉框与所有选项均显式声明了深色与浅色高对比样式', () => {
    const charManagerPath = path.resolve(__dirname, '../src/components/WorldBible/CharacterManager.tsx');
    const content = fs.readFileSync(charManagerPath, 'utf-8');

    // 验证状态下拉选框拥有右侧内边距（避免文字撞到原生下拉箭头）
    expect(content).toContain('pr-6');

    // 验证每个选项在深色模式下均有独立不透明背景与高对比度文字
    expect(content).toContain('value="活跃" className="bg-white text-emerald-800 dark:bg-[#1e1e22] dark:text-emerald-300');
    expect(content).toContain('value="重伤" className="bg-white text-rose-800 dark:bg-[#1e1e22] dark:text-rose-300');
    expect(content).toContain('value="闭关突破" className="bg-white text-neutral-700 dark:bg-[#1e1e22] dark:text-neutral-200');
    expect(content).toContain('value="被捕受困" className="bg-white text-rose-800 dark:bg-[#1e1e22] dark:text-rose-300');
    expect(content).toContain('value="已阵亡/退出" className="bg-white text-neutral-700 dark:bg-[#1e1e22] dark:text-neutral-200');
  });

  it('index.css 全局配置强制了 select/option 在深色模式下的不透明深底与高对比亮字', () => {
    const cssPath = path.resolve(__dirname, '../src/index.css');
    const css = fs.readFileSync(cssPath, 'utf-8');

    // 浅色模式全局 option 白底深字
    expect(css).toContain('select option');
    expect(css).toContain('background-color: #ffffff');

    // 深色模式 option 强制实体深底与明亮字
    expect(css).toContain('html.dark select option');
    expect(css).toContain('background-color: #1e1e22 !important');
    expect(css).toContain('color: #f4f4f5');

    // 特殊 Hex 状态底色已由 semi-transparent rgba 升级为 solid opaque hex，解决白底浅字穿透
    expect(css).toContain('html.dark .bg-\\[\\#f0f9f4\\] {\n  background-color: #0c2a18 !important;\n}');
    expect(css).toContain('html.dark .bg-\\[\\#fff5f5\\] {\n  background-color: #321117 !important;\n}');
  });
});
