# Security Policy

## Supported Versions

Swoop Code 目前处于早期教学项目阶段，主分支 `main` 是唯一维护分支。安全修复会优先合入 `main`。

## Reporting a Vulnerability

如果你发现安全问题，请不要在公开 issue 中直接贴出可利用细节、真实 token、私钥或敏感日志。

推荐处理方式：

1. 优先使用 GitHub 的私密安全报告功能（Private Vulnerability Reporting），如果仓库已启用该功能。
2. 如果私密安全报告不可用，请先创建一个不含利用细节的 issue，说明需要联系维护者处理安全问题。
3. 在维护者确认沟通渠道后，再提供最小复现、影响范围和建议修复方式。

## Sensitive Data

请不要提交：

- `.env` 或任何真实 API key
- LLM 请求/响应中的敏感用户数据
- 私钥、访问令牌、cookie 或生产日志
- 真实用户 workspace 中的私有代码片段

如果你不小心提交了敏感信息，请立即撤销对应密钥，并在 issue 或 PR 中说明需要清理历史记录。
