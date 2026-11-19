# Antigravity 安全修复与 ACP 集成分析

记录日期：2026-11-18。关联文档：[上游同步总览](README.md)、[已合入的上游变更记录](ports.md)。

## 固定状态

| 对象            | 固定参考与当前结论                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 本次上游 `main` | [`e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63`](https://github.com/can1357/oh-my-pi/commit/e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63)；最新 Antigravity 实质提交为 [`e0045481bc856497fdcdf63c0686dff2c8a3a7db`](https://github.com/can1357/oh-my-pi/commit/e0045481bc856497fdcdf63c0686dff2c8a3a7db) |
| 最新上游发布    | [`v18.22.0`](https://github.com/can1357/oh-my-pi/releases/tag/v18.22.0)，提交 `7c49c11aa5bbaf3f418406583096168ad5b8c6dc`；下列 2026-11-17 修复均在发布之后，仍属未发布 `main`                                                                                                                    |
| 当时 fork HEAD  | `722bc9f3021ae69947dbaa844a38458a14290f13`（`build(sdk): pin published desktop core.3 release`），包版本 18.14.0；仅有旧 `google-antigravity` 直连 OAuth 规则，没有上游的 `disabled`、`login-warning` 或 `antigravity-cli`                                                                       |

## 路径分离与政策边界

上游当前把两条路径明确分开：

- 旧 [`google-antigravity`](https://github.com/can1357/oh-my-pi/blob/e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63/packages/catalog/src/compat/rules/auth/google-antigravity.kdl) 由 `disabled` 规则暂停。登录、刷新、usage probe、已保存凭据和直接请求均应 fail closed；替代路径是 `GEMINI_API_KEY` 或 `google-vertex`。
- 新 [`antigravity-cli`](https://github.com/can1357/oh-my-pi/blob/e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63/packages/catalog/src/compat/rules/auth/antigravity-cli.kdl) 运行官方 `agy` 的 ACP 接口，但当前仅用 `login-warning` 要求新登录显式输入 `yes`，没有暂停。登录会把 consumer OAuth grant 导出到 OMP 凭据库，再按账号写入隔离的原生凭据目录；不能描述为“令牌只保留在官方客户端”。
- [#18341](https://github.com/can1357/oh-my-pi/issues/18341) 已记录旧直连路径出现账号级 Antigravity / Gemini Code Assist `403 TOS_VIOLATION`；[#19343](https://github.com/can1357/oh-my-pi/issues/19343) 记录 ACP 路径相关受限报告，但现有样本不能证明 ACP 是触发原因。当前 ACP host 尚未把服务禁用文本或 `TOS_VIOLATION` 分类成不可重试的 provider/account error。
- [Google AI Developers Forum 的回复](https://discuss.ai.google.dev/t/tos-clarification-is-t3-code-official-antigravity-acp-agent-permitted-under-the-antigravity-terms-of-service/192027) 把许可限定为单用户交互式开发、官方未修改的 `antigravity-acp` 和原生 `oauth-personal` 流程，并排除提取/代理令牌、多账号轮换等做法。OMP 的凭据导出与分发设计是否完全落在该边界内，必须作为集成前的政策审查项，不能仅凭使用官方二进制判定安全。

## 上游提交与依赖顺序

| 顺序 | 上游提交                                                                                                                                                                                                                                                             | 变更与迁移判断                                                                                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | [`8895c0fa328139e5629cb538439157f6cb760d38`](https://github.com/can1357/oh-my-pi/commit/8895c0fa328139e5629cb538439157f6cb760d38)、[`9a37046d3acef65b11554c220357a19aad250fdb`](https://github.com/can1357/oh-my-pi/commit/9a37046d3acef65b11554c220357a19aad250fdb) | 引入 provider `disabled` 的完整 fail-closed 语义，并再次暂停旧直连 Antigravity。当前 fork 不能只复制 `disabled` KDL 行；必须迁移规则编译、登录拒绝、凭据池过滤、usage probe、请求与图片入口的共同封锁。 |
| 2    | [`c3b7bed169a61aba1cd2f1164d3a68ea80c035a4`](https://github.com/can1357/oh-my-pi/commit/c3b7bed169a61aba1cd2f1164d3a68ea80c035a4)                                                                                                                                    | 新增 `antigravity-cli`：托管 `agy` 安装与校验、OAuth 凭据 staging、账号隔离目录、ACP 会话、MCP 工具桥和历史恢复。它是后续 ACP 修复的基础，不能跳过。                                                    |
| 3    | [`39f9483f66dd408ccf37bcf31d0bfbb6caccd49f`](https://github.com/can1357/oh-my-pi/commit/39f9483f66dd408ccf37bcf31d0bfbb6caccd49f)                                                                                                                                    | 给 OAuth prompt 增加 `riskAcknowledgement`；RPC/Desktop 宿主在授权 URL 之前显示风险确认，只有 `yes` 继续。Desktop 必须映射这一输入，不能绕过或自动接受。                                                |
| 4    | [`86bdd6085f3fc05326f617d7af525a8200d98d0b`](https://github.com/can1357/oh-my-pi/commit/86bdd6085f3fc05326f617d7af525a8200d98d0b)                                                                                                                                    | 无效工具参数返回有限长度的失败路径和预期 schema，保留当前 turn 供模型修正，不再直接终止 ACP 会话。                                                                                                      |
| 5    | [`d17cd72967f43bd2d468fffede59d23e267cfde6`](https://github.com/can1357/oh-my-pi/commit/d17cd72967f43bd2d468fffede59d23e267cfde6)                                                                                                                                    | 清理超过 24 小时且没有凭据的废弃登录目录；并发产生或目录冲突时保留已经写入的 OAuth 凭据。                                                                                                               |
| 6    | [`bf7bc9ef2fbe47b12d5ec676a4654d185f7e2190`](https://github.com/can1357/oh-my-pi/commit/bf7bc9ef2fbe47b12d5ec676a4654d185f7e2190)                                                                                                                                    | MCP 工具发布改用 `normalizeSchemaForMCP`，避免 mixed-type union 被 CCA normalizer 折叠成空对象，修复子代理无法提交 typed `yield`。                                                                      |
| 7    | [`e0045481bc856497fdcdf63c0686dff2c8a3a7db`](https://github.com/can1357/oh-my-pi/commit/e0045481bc856497fdcdf63c0686dff2c8a3a7db)                                                                                                                                    | 删除 `path`、`command`、`cwd`、`description` 等硬编码参数别名改写；按模型原样参数做 schema 校验和转发，保留第 4 项的可修正诊断。采用最终状态时不要停在中间的 alias-normalization 提交。                 |

前两项是不同目标：旧直连路径的 fail-closed 是安全修复，应先独立迁移；ACP 是新功能，必须经过单独产品与政策决策。若采用 ACP，应从基础提交连同 2026-11-17 的全部最终修复整体迁移，不能只挑最新几个补丁。

## Desktop 集成门槛

1. 先证明旧 `google-antigravity` 从登录列表、模型发现、已有凭据刷新、usage probe、前台/后台请求、图片和 role/fallback 选择中全部失效；已有凭据保留但不读取。
2. 若启用 `antigravity-cli`，Desktop 必须在任何授权或请求之前显示完整风险确认；拒绝、关闭或非 `yes` 输入都取消登录。明确决定已有凭据是否也要重新确认；上游 `login-warning` 当前只覆盖新登录。
3. 验证托管 `agy` 的平台选择、摘要校验、账号目录隔离、取消/崩溃后的目录清理，以及清理竞争下不删除已经生成的凭据。日志、RPC 和诊断不得输出 access token、refresh token 或账号标识。
4. 用真实 ACP smoke 覆盖普通回复、工具调用、工具参数修正、mixed-union/typed `yield`、多步工具后的会话保留、取消和冷恢复；保留 fork 的 Node worker、代理/CA、Desktop owner 与 Stop 合同。
5. 在决定默认开放 ACP 前，明确处理服务禁用通知的策略。当前上游可能把通知当普通 assistant 文本并以 `stop` 结束；至少不能把它计为成功响应、继续后台标题生成或自动尝试其他 Google 账号。
6. 发布说明必须区分“旧直连 OAuth 已禁用”“官方 `agy` ACP 可选且有风险提示”“AI Studio / Vertex API 是独立受支持路径”，不能把技术可用表述为无封禁风险。
