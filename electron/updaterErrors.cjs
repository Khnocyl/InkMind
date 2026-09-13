/**
 * electron-updater 报错分类与版本比较的纯函数（供 main.cjs 与单元测试共用）。
 * 原始报错（含 headers/堆栈）只留在主进程日志，绝不原样透给 UI。
 */

/** 简单语义化版本比较：>0 表示 a 更新 */
function semverCompare(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * 把 electron-updater 的报错压成一句用户可读的短提示。
 * kind = 'feed-missing' 表示 Release 存在但没上传 latest.yml，
 * tag 为从报错 URL 里解析出的该 Release 版本号（去掉 v 前缀）。
 */
function shortUpdaterError(err) {
  const raw = String((err && err.message) || err || '');
  const firstLine = raw.split('\n')[0].trim();
  const feedMiss = raw.match(/releases\/download\/([^/\s"']+)\/latest\.yml/i);
  if (feedMiss) {
    return {
      kind: 'feed-missing',
      tag: feedMiss[1].replace(/^v/i, ''),
      text: '更新源缺少更新清单（latest.yml），暂时无法应用内升级，请前往 GitHub 手动下载。',
    };
  }
  if (/rate limit|\b403\b/i.test(firstLine)) {
    return { kind: 'error', text: 'GitHub 请求受限，请稍后重试，或前往 GitHub 手动下载新版本。' };
  }
  if (/ENOTFOUND|getaddrinfo|ETIMEDOUT|ECONNRESET|net::ERR|certificate/i.test(raw)) {
    return { kind: 'error', text: '网络无法连接到 GitHub 更新源，请检查网络或代理后重试。' };
  }
  // 兜底文案抹掉 URL 等内部细节，避免透给 UI
  const sanitized = (firstLine || '更新操作失败，请稍后重试。')
    .replace(/https?:\/\/\S+/gi, '（链接已省略）')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 160);
  return { kind: 'error', text: sanitized };
}

/**
 * 更新 error 事件的处置决策：该不该广播、状态机该回退到哪。
 *
 * 单独抽成纯函数的理由：这段判断有两个容易错的耦合点——
 *  1. 检查期抑制用的 `checkingActive` 是**跨阶段共享**的计数器，不能只看它决定是否吞错误；
 *  2. 回退目标取决于当前阶段（downloading→available 可重试；其余→idle；downloaded 不动）。
 * 此前内联在主进程里无法单测，并因此漏掉了这条路径：
 * 「下载进行中用户又点一次『检查更新』→ checkingActive>0 → 下载失败被吞 →
 *  updatePhase 永远停在 downloading → 面板一直显示『下载中』、安装按钮永不启用」。
 *
 * @param {{ checkingActive?: number, updatePhase?: string }} state
 * @returns {{ suppress: boolean, nextPhase: string | null }}
 */
function decideUpdaterErrorAction(state) {
  const checkingActive = Number((state && state.checkingActive) || 0);
  const updatePhase = String((state && state.updatePhase) || 'idle');
  const isDownloadPhase = updatePhase === 'downloading';
  // 检查阶段的失败由 updater:check 的返回值统一汇报 → 抑制事件广播
  if (checkingActive > 0 && !isDownloadPhase) {
    return { suppress: true, nextPhase: null };
  }
  if (isDownloadPhase) return { suppress: false, nextPhase: 'available' };
  // 已下载完成时出错不动状态（用户仍可安装已下载的包）
  if (updatePhase !== 'downloaded') return { suppress: false, nextPhase: 'idle' };
  return { suppress: false, nextPhase: null };
}

module.exports = { semverCompare, shortUpdaterError, decideUpdaterErrorAction };
