import { describe, it, expect } from 'vitest';
import { parseReleaseNotes } from '../src/components/StyleConfig/ReleaseNotesViewer';

describe('ReleaseNotesViewer · 更新说明排版与代码标签净化', () => {
  it('正确解析 electron-updater 生成的 HTML 片段，消除裸露的 <p>/<br>/<li>/<h3> 标签', () => {
    const rawHtml = '<p>重点响应社区反馈 (Issue #1)<br>针对 @lixiyas 在 #1 中提出的需求：</p><ul><li>1. 单独角色支持全字段手动编辑与安全删除</li></ul><h3>其他核心改进</h3>';
    const nodes = parseReleaseNotes(rawHtml);

    expect(nodes.length).toBeGreaterThan(0);
    // 渲染出的 React 节点树中绝不应包含未转义的 "<p>" 或 "<br>" 纯文字
    const fullText = JSON.stringify(nodes);
    expect(fullText).not.toContain('&lt;p&gt;');
    expect(fullText).not.toContain('&lt;br&gt;');
    expect(fullText).not.toContain('<p>');
  });

  it('剥离不慎复制的外层 ```markdown ... ``` 围栏', () => {
    const fenced = '```markdown\n## 🚀 InkMind v1.0.3\n- 更新内容一\n```';
    const nodes = parseReleaseNotes(fenced);

    expect(nodes.length).toBeGreaterThan(0);
    const text = JSON.stringify(nodes);
    expect(text).not.toContain('```markdown');
    expect(text).not.toContain('```');
    expect(text).toContain('InkMind v1.0.3');
  });

  it('纯 Markdown 格式文本正常解析为结构化列表与标题', () => {
    const md = '## 新增特性\n- 角色自由编辑\n- 自由跳步重跑\n\n**加粗说明**';
    const nodes = parseReleaseNotes(md);

    expect(nodes.length).toBeGreaterThan(0);
    const text = JSON.stringify(nodes);
    expect(text).toContain('新增特性');
    expect(text).toContain('角色自由编辑');
    expect(text).toContain('加粗说明');
  });

  it('安全防护：过滤恶意的 script 与 iframe 标签', () => {
    const xss = '<script>alert("xss")</script><iframe src="evil.com"></iframe><p>正常说明</p>';
    const nodes = parseReleaseNotes(xss);

    const text = JSON.stringify(nodes);
    expect(text).not.toContain('alert');
    expect(text).not.toContain('evil.com');
    expect(text).toContain('正常说明');
  });
});
