# 已合入的上游变更记录

本文件按时间倒序记录从 [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) 选择性合入到 `iris-cat-dev/omp-sdk` 与 `omp-desktop` 的变更。迁移前须遵守 [必须保留的 fork 合同](README.md#必须保留的-fork-合同)。

## 2026-11-22 — Codex / GPT-6.2 `instructions` Prompt Caching 与客户端版本动态解析

- **上游提交**：
  - [`dd75fddf6a`](https://github.com/can1357/oh-my-pi/commit/dd75fddf6a34f9bebf005db72ea9e00579af66ed)（Codex base instructions 迁至前置 `developer` 项 `model.base_instructions`）
  - [`f54745ac23`](https://github.com/can1357/oh-my-pi/commit/f54745ac235b89ce2775616a7f44275bbdf7b300)（运行时从 npm `@openai/codex/latest` 解析 Codex 客户端版本）
  - [`88fc862ac4`](https://github.com/can1357/oh-my-pi/commit/88fc862ac496ee9158e48ed0dbd4e99c782ff634)（Codex 客户端版本缓存迁至 XDG cache）
  - [`acdfffa248d`](https://github.com/can1357/oh-my-pi/commit/acdfffa248d1cdb5e0a05173e44e441103a37daf) 的 `uncached-instructions` 切片（GPT-6.2+ 在所有 Responses 宿主含代理上将系统提示词作为前置 `developer` 项发送）
- **SDK 提交**：`7fd52c879f`（`fix(ai,catalog,agent,utils): port GPT-6.2/Codex instructions caching and dynamic client version`；目录投影 `omp-provider-model-index.json` 零差异）
- **Fork 适配与改进**：
  - 在 `@oh-my-pi/pi-utils` 中补齐可移植 `runtime.randomUUIDv5`（Node.js `node:crypto` SHA-1 + Bun 代理），`codex-version.ts` 使用 `runtime.write` 与递归建目录，避免在 `packages/*/src/` 引入原始 `Bun.*` API。
  - 将 `buildCompactionV2Request` 中的 `moveCodexInstructionsToInput` 限定于 Codex（`isCodexResponses`），防止向非 Codex OpenAI Responses / Azure / Bedrock Mantle 压缩请求泄漏 `internal_chat_message_metadata_passthrough`。
  - `classes/openai.kdl` 采用 `revision ">=6.2 <10"` 兼顾未来 GPT-6.3+ 并排除 `gpt-52-codex` 等无分隔符 ID。
- **未合入 / 保留边界**：保留 `CODEX_CLIENT_VERSION = "0.169.1"`、SDK 包版本 `18.14.0`、Node 传输/代理实现、Claude/Gemini 指纹，不合入 `acdfffa248d` 的 MCP daemon 重写及延后项（`0da37d35a1`、`6c57f9091e`、`ad383b54c7`）。详见 [Codex / GPT-6.2 Prompt Caching 移植与验证分析](2026-11-22-codex-gpt-6-2-instructions-caching.md)。

## 2026-11-18 — 上游 18.22.2 模型目录与兼容规则同步

- **上游参考**：[`b96a1ed7a4`](https://github.com/can1357/oh-my-pi/commit/b96a1ed7a4)（`18.22.2`）
- **SDK 提交**：`1972a51905`（`feat(catalog): sync upstream 18.22.2 model catalog`）
- **Desktop 固定提交**：`499af2e9`（`build(sdk): pin synced model catalog`）
- **同步范围**：
  - 同步兼容的模型目录数据与 provider 规则，包含 Gemini 4 Hydrogen / Carbon、Claude Fable / Mythos 5.2、GPT-6.2 Astra / Sol、Kimi K3.1 Pro 与 Muse Ember。
  - 修正 Cursor 发现、上下文窗口、费率及按账号隔离的缓存失效；在支持 Long Decode 前保留 Google 单次响应输出上限。
- **未合入 / 保留边界**：保留 Desktop 本地 runner、SDK 包版本（`18.14.0`）与已退役 provider 排除策略；本次同步不包含新的 ACP 与 decision transport。详细包级记录见 [`omp-sdk/packages/catalog/CHANGELOG.md`](../../omp-sdk/packages/catalog/CHANGELOG.md)。

## 2026-11-17 — Shell 引擎替换与执行 Trace

- **上游提交**：
  - [`488cafa0e0d0`](https://github.com/can1357/oh-my-pi/commit/488cafa0e0d0)（Shell 执行 trace）
  - [`44711a78c1be`](https://github.com/can1357/oh-my-pi/commit/44711a78c1be)（自研 Bash 5.3 引擎替换 Brush）
  - 截至 [`1bdbf6d242d9`](https://github.com/can1357/oh-my-pi/commit/1bdbf6d242d9) 的 trace 与编码修复
- **SDK 提交**：`f75eada1bd`（`feat(shell): add native execution traces`）
- **Desktop 集成提交**：`e7397865`（`feat(tools): show shell execution and compiler progress`）
- **包含于发布**：`sdk-v18.14.0-desktop-core.3`
- **未合入 / 保留边界**：替换 Brush，同时保留 Node SDK、`desktop/core` 功能裁剪、PTY/外部 shell 路由、artifact 捕获以及 fork 的 owned Stop 与 Git 守卫合同；不引入上游 CLI 更新器、TUI 行移动或 TTY writer 优化。前置分析见 [2026-11-08 上游迁移分析](2026-11-08-oh-my-pi-18.18.md#shell-迁移的优势与代价)。

## 2026-11-17 — Cursor 目录、协议与运行时修复

- **SDK 提交**：`cfaae98752`（`fix(cursor): port upstream catalog and runtime fixes`）
- **Desktop 集成提交**：`182ae0e6`（`fix(sdk): integrate upstream Cursor fixes`）
- **包含于发布**：`sdk-v18.14.0-desktop-core.3`
- **合入的上游提交**：
  - 模型发现与缓存 v6：[`b4e0bf241166`](https://github.com/can1357/oh-my-pi/commit/b4e0bf241166)（[#18248](https://github.com/can1357/oh-my-pi/pull/18248)）；隐藏 / Cmd-K 专用模型过滤：[`51adeafb7f24`](https://github.com/can1357/oh-my-pi/commit/51adeafb7f24)。
  - Hook 注入上下文与服务端历史回放：[`d47018947a77`](https://github.com/can1357/oh-my-pi/commit/d47018947a77)（[#19156](https://github.com/can1357/oh-my-pi/pull/19156)）。
  - TLS reset 与 RunSSE 回退：[`8215aa30af09`](https://github.com/can1357/oh-my-pi/commit/8215aa30af09)、[`b202a2f096c5`](https://github.com/can1357/oh-my-pi/commit/b202a2f096c5)、[`a295dae85344`](https://github.com/can1357/oh-my-pi/commit/a295dae85344)（[#17985](https://github.com/can1357/oh-my-pi/pull/17985)）；ClientHello fixture 修正：[`526f30567435`](https://github.com/can1357/oh-my-pi/commit/526f30567435)。
  - Native/MCP 工具排序：[`0a1390308492`](https://github.com/can1357/oh-my-pi/commit/0a1390308492)（[#18434](https://github.com/can1357/oh-my-pi/pull/18434)）、[`8b8611eb8e20`](https://github.com/can1357/oh-my-pi/commit/8b8611eb8e20)、[`b1fba1dc937b`](https://github.com/can1357/oh-my-pi/commit/b1fba1dc937b)（[#18502](https://github.com/can1357/oh-my-pi/pull/18502)）；共享并发判定：[`ad77cd087769`](https://github.com/can1357/oh-my-pi/commit/ad77cd087769)。
  - Gemini 4 Carbon 分期定价：[`0de8205510f1`](https://github.com/can1357/oh-my-pi/commit/0de8205510f1)（[#18734](https://github.com/can1357/oh-my-pi/pull/18734)）。
- **保留边界**：保留 fork 的 Node 传输、CONNECT 代理策略、`runtime.hash` 与按账号隔离的缓存。

## 发布与生效约定

- SDK npm 包版本继续保持 `18.14.0`，由发布标签（例如 `sdk-v18.14.0-desktop-core.3`，固定于 [`omp-sdk/sdk/node-release.json`](../../omp-sdk/sdk/node-release.json)）标识实际构建产物。
- 更新远程 SDK pin 后，需要重新构建 Desktop 的 `remote-backend` 产物，执行常规主机更新流程，并重建已加载的 SDK 会话才能生效；仅发布 SDK 或 Desktop 版本不会重启现有会话宿主。
- 更新模型目录后，需要在仓库根目录运行 `node packages/app/scripts/project-omp-provider-catalog.mjs`，将重新生成的 `omp-provider-model-index.json` 一并提交。
- submodule 同步命令与提交顺序见 [打包指南 — 同步源码与 submodule](../packaging.md#2-synchronize-source-without-discarding-local-changes) 与 [开发与验证指南](../development.md#start-development)。
