# 安全说明（Threat Model & Hardening）

本文档面向使用者与贡献者，说明 InkMind 的威胁模型、已内置的安全措施，以及使用时的注意事项。

## 威胁模型（Threat Model）

InkMind 是**本地优先、单用户**的小说写作工具：

- 作品数据默认只存在**你自己的浏览器 IndexedDB** 中（`novel_studio_db`）。
- 服务端（Express）默认只绑定 `127.0.0.1`（回环），对外只做两件事：**LLM 代理**（持有你填写的 API Key 并转发上游）与**作品磁盘备份**（`.novel-data/backups/`）。
- **没有账号体系、没有多租户**。`/api/*` 用一份本机生成的随机 API Token 做鉴权；同源浏览器请求（应用自身页面）豁免。

因此，本项目默认不面对"用户 A 攻击用户 B"这一威胁——该威胁不适用。真正的威胁面是：

1. **本机恶意程序 / 网页**：任何能访问 `localhost:3001` 的进程（curl、脚本、恶意软件）都可以调用 API。注意：**不带 Origin 头的本机进程免 token**（本机进程本可读取 token 文件，这是有意设计）。
2. **网络暴露**：若以 `HOST=0.0.0.0` 或 `TRUSTED_HOSTS` 暴露到局域网/公网，任何能访问该地址的人都可调用 API。
3. **数据落盘**：未发表作品与配置（含加密后的 API Key）以文件形式存在磁盘。

## 已内置的安全措施

- **API Key 加密落盘**：用「机器指纹 + 当前用户名」派生的密钥做 AES-256-GCM 加密，密钥不落盘。跨机器拷贝 `.novel-data` 无法解密。
  - ⚠️ 注意：加密只防"数据被拷走"，**不防"能在这台机器上执行代码的人"**（本机同权限进程可自行复现密钥派生）。
- **API Token 鉴权 + fail-closed**：token 不可用且未显式 `ALLOW_NO_AUTH=1` 时，全部 `/api/*` 返回 503。
- **SSRF 收敛**：LLM/Embedding 的 Base URL 强制 http/https；云元数据地址与链路本地段（`169.254.169.254` 等）始终阻断；重定向后复检最终 URL。
- **密钥不回退异源**：探测与已存配置不同的地址时，不会把已存密钥发往该地址。
- **危险请求头防覆盖**：`Host` / `Authorization` / `Content-Type` 等不可被 customHeaders 覆盖。
- **DNS rebinding 防护**：同源豁免要求 Host 为回环/显式可信主机。
- **服务端限流**：LLM / Doctor / Embedding / 模型探测 / 备份写入端点有按来源 IP 的滑动窗口 QPS 与并发上限（环境变量 `LLM_RATE_LIMIT_PER_MIN`、`LLM_MAX_CONCURRENT` 可调）。
- **model 白名单**：`/api/llm/generate` 只接受已配置档的模型名，拒绝伪造昂贵模型。
- **更换 Base URL 需重输 Key**：把已存配置档的 baseURL 改成不同主机时，原加密 Key 会被清空，防止被诱导把 Key 发往攻击者地址。
- **无 XSS 注入面**：代码不含 `dangerouslySetInnerHTML` / `innerHTML` / `eval`；AI 生成内容以纯文本渲染。
- **删除即清理**：删除项目会同时清理其在磁盘上的备份文件。
- **敏感文件权限收紧**：`.novel-data` 目录与 API Token 文件在 POSIX 下为 `700/600`，Windows 下用 `icacls` 移除继承并仅保留当前用户。

## 使用注意事项

- **不要用 `ALLOW_NO_AUTH=1`**（会关闭全部鉴权）。
- **不要**在共享/不可信/安装了可疑软件的机器上使用，或使用时保持警惕（本机恶意进程可全权调用 API）。
- **不要**以 `HOST=0.0.0.0` 暴露到不可信网络；确需局域网使用时，务必用 `TRUSTED_HOSTS` 精确声明可信主机，并知晓局域网内任何访问者都享有与你相同的 API 权限。
- `.novel-data/` 已加入 `.gitignore`，请勿提交（内含 token 与你的小说全文）。
- 从不可信来源导入 `.novel.json` 时请注意：小说内容会进入 AI 提示词（间接提示注入可影响生成质量，但本项目无工具调用/文件/网络能力，风险限于自身项目内容）。

## 漏洞上报

请通过 GitHub Issues（打 `security` 标签）或私信报告，避免公开 PoC 泄露他人数据。
