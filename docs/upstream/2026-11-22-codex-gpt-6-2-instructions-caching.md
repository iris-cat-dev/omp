# OpenAI Codex 与 GPT-6.2 `instructions` Prompt Caching 移植与验证分析

记录日期：2026-11-22。关联文档：[上游同步总览](README.md)、[已合入的上游变更记录](ports.md)。

## 固定状态

| 对象              | 固定参考与当前结论                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上游 `main` 参考  | [`b505770284deff6b2888a4eb26a7cc95497cc111`](https://github.com/can1357/oh-my-pi/commit/b505770284deff6b2888a4eb26a7cc95497cc111)（2026-11-22）                                         |
| 本次 `omp-sdk` 提交 | `7fd52c879f81f87c4b661f91eaf71436be2c980f`（`fix(ai,catalog,agent,utils): port GPT-6.2/Codex instructions caching and dynamic client version`，基于 `bed55d0057`，包版本保持 `18.14.0`） |
| 当前 Desktop 基线 | `dabf444daa7f3b20437ae9c20c8d3ad186ba0663`（`fix(app): preserve transcript quote snapshot across selection loss`）                                                                     |

## 问题根因与本地遥测证据

GPT-6.2 起，OpenAI Responses 后端会将顶层 `instructions` 追加到 `input` 末尾参与推理（见 `openai/codex#62312`），导致顶层 `instructions` 在 ChatGPT Codex OAuth 与 Responses API 路径上均**不再读写 prompt cache**，每轮按未命中全额计费；而把相同文本放在 `input[0]` 作为前置 `developer` 消息（Codex 侧需带 `model.base_instructions` 元数据标记与确定性 `msg_<uuidv5>` ID）则可正常命中缓存。

本地 `~/.omp/stats.db` 中 `provider = 'openai-codex'` 且已预热续轮（`cache_read_tokens > 0`）的实际分布验证了该退化：

| 模型            | 样本数 (n) | P50 未命中 tokens | 平均未命中 tokens | 缓存命中率 |
| --------------- | ---------- | ----------------- | ----------------- | ---------- |
| `gpt-5.6-sol`   | 19,822     | 791               | 2,260             | 98.18%     |
| `gpt-6-astra`   | 5,791      | 1,311             | 2,877             | 97.50%     |
| `gpt-6.1-sol`   | 24,224     | 1,443             | 3,458             | 97.13%     |
| `gpt-6.2-astra` | 1,410      | 9,082             | 10,919            | 90.93%     |
| `gpt-6.2-sol`   | 3,611      | 9,547             | 12,309            | 92.90%     |

GPT-6.2 每轮多出约 8k–9k 未命中 tokens，与系统提示词体积高度一致。

## 选择性移植范围

本次仅移植 Codex / GPT-6.2 prompt caching 与 Codex 客户端版本动态解析 4 个上游切片，未混入 MCP daemon 重写或其他无关改动：

| 上游提交                                                                                                                     | 日期       | 移植状态   | 内容与范围                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| [`dd75fddf6a`](https://github.com/can1357/oh-my-pi/commit/dd75fddf6a34f9bebf005db72ea9e00579af66ed)                         | 2026-11-17 | 已选择移植 | `moveCodexInstructionsToInput()`：Codex 常规请求、Lite、V1 `/responses/compact` 与 Codex V2 压缩将 `instructions` 移至 `input[0]` |
| [`f54745ac23`](https://github.com/can1357/oh-my-pi/commit/f54745ac235b89ce2775616a7f44275bbdf7b300)                         | 2026-11-17 | 已选择移植 | `getCodexClientVersion()`：从 npm `@openai/codex/latest` 后台刷新客户端版本，以 `CODEX_CLIENT_VERSION` 为下限               |
| [`88fc862ac4`](https://github.com/can1357/oh-my-pi/commit/88fc862ac496ee9158e48ed0dbd4e99c782ff634)                         | 2026-11-19 | 已选择移植 | 将 `codex-client-version.json` 缓存路径迁至 XDG cache（`getCodexClientVersionPath()`）                                      |
| [`acdfffa248d`](https://github.com/can1357/oh-my-pi/commit/acdfffa248d1cdb5e0a05173e44e441103a37daf)（仅 `uncached-instructions` 切片） | 2026-11-20 | 已选择移植 | 新增 `uncached-instructions` compat 轴，使 `openai-responses` 在第三方代理上也把 GPT-6.2+ 系统提示词作为前置 `developer` 项发送；不引入该提交的 MCP daemon 改造 |

## Fork 适配与相对上游的改进

1. **Node.js 24+ 可移植运行时**：上游直接使用 `Bun.randomUUIDv5` 与 `Bun.write`。本次在 `@oh-my-pi/pi-utils` 中补齐基于 `node:crypto`（SHA-1 RFC 4122）的 `runtime.randomUUIDv5` 并在 `codex-version.ts` 使用 `runtime.write` 与 `fs.mkdirSync(..., { recursive: true })`，同时重建 `packages/utils/dist/node/runtime.mjs` 并在纯 Node.js v25.6.1 下验证通过。
2. **Codex V2 压缩作用域守卫**：上游 `dd75fddf6a` 在 `buildCompactionV2Request` 的 `else` 分支无条件调用 `moveCodexInstructionsToInput(body)`，会把 Codex 私有字段 `internal_chat_message_metadata_passthrough` 泄漏到标准 `openai-responses` / Azure / Bedrock Mantle 的 V2 压缩请求中。本次改为 `else if (isCodexResponses)`（与 V1 `compaction/openai.ts` 保持一致），并补充回归测试。
3. **前向兼容规则边界**：`packages/catalog/src/compat/rules/classes/openai.kdl` 使用 `revision ">=6.2 <10"`（而非仅 `=6.2`），既覆盖未来 GPT-6.3+，又保持 `<10` 上界以排除无分隔符旧 ID（如 `gpt-52-codex` 解析为 `52`）。
4. **保留 fork 版本固定与离线重烘焙**：保持 `CODEX_CLIENT_VERSION = "0.169.1"`（不回退到上游 `"0.169.0"`）与 SDK 包版本 `18.14.0`；离线重烘焙 `models.json` 仅更新 933 条 Responses 行的 `compat.uncachedInstructions`（仅 `openai/gpt-6.2-astra`、`openai/gpt-6.2-sol` 为 `true`，其余 931 条为 `false`），运行 `node packages/app/scripts/project-omp-provider-catalog.mjs` 确认 `omp-provider-model-index.json` 零变更。不改动 `node-fetch.ts`、`model-websocket.ts`、`auth-gateway/server.ts` 及 Claude/Gemini 指纹。

## 实测验证结果

### 1. 真实 Codex WebSocket 链式多轮 E2E（直接经改动后的 `streamOpenAICodexResponses`，~9.9k token 提示词）

| 模型            | 轮次 | 传输与链式状态                             | 线缆形态                                                           | 未命中 tokens | 缓存命中 tokens | 命中率  |
| --------------- | ---- | ------------------------------------------ | ------------------------------------------------------------------ | ------------- | --------------- | ------- |
| `gpt-6.2-sol`   | 1    | `websocket`, `chained: false`, `delta: 0`  | `hasInstructions: false`, `inputLen: 3`, `input[0]`=`model.base_instructions` (`msg_373a…`) | 9,869         | 0               | 0%（冷） |
| `gpt-6.2-sol`   | 2    | `websocket`, `chained: true`, `delta: 1`   | `hasInstructions: false`, `inputLen: 1`                            | 31            | 9,856           | 99.69%  |
| `gpt-6.2-sol`   | 3    | `websocket`, `chained: true`, `delta: 2`   | `hasInstructions: false`, `inputLen: 1`                            | 49            | 9,856           | 99.51%  |
| `gpt-6.2-astra` | 1    | `websocket`, `chained: false`, `delta: 0`  | `hasInstructions: false`, `inputLen: 3`, `input[0]`=`model.base_instructions` (`msg_a62a…`) | 9,874         | 0               | 0%（冷） |
| `gpt-6.2-astra` | 2    | `websocket`, `chained: true`, `delta: 1`   | `hasInstructions: false`, `inputLen: 1`                            | 36            | 9,856           | 99.64%  |
| `gpt-6.2-astra` | 3    | `websocket`, `chained: true`, `delta: 2`   | `hasInstructions: false`, `inputLen: 1`（服务端分片瞬时未命中）    | 9,910         | 0               | 0%      |
| `gpt-6.1-sol`   | 1    | `websocket`, `chained: false`, `delta: 0`  | `hasInstructions: false`, `inputLen: 3`, `input[0]`=`model.base_instructions` (`msg_6d96…`) | 9,876         | 0               | 0%（冷） |
| `gpt-6.1-sol`   | 2    | `websocket`, `chained: true`, `delta: 1`   | `hasInstructions: false`, `inputLen: 1`                            | 166           | 9,728           | 98.32%  |

早期非链式 SSE 验证同样确认 `gpt-6.2-sol`（Turn 2/3 99.66%/99.48%）、`gpt-6.2-astra`（Turn 2/3 99.68%/99.50%）与 `gpt-5.6-sol`（零 400 错误）均可稳定命中。

### 2. 指令优先级回归验证（不修改 `system-prompt.md` / `project-prompt.md`）

在 `gpt-6.2-sol` 与 `gpt-6.2-astra` 上进行 `COBALT`/`AMBER` 互换冲突测试：

- **强约束基线规则 vs `<project-context>` 覆盖**：`top-level-instructions`、`dd75fddf6a-base-tagged` 与 `untagged-developer` 三种布局均 4/4 `BASE_WINS`。
- **同强度对称规则**：顶层 `instructions` 下 4/4 `FIRST_WINS`（因 GPT-6.2 将顶层 `instructions` 后置于 `input`）；迁入前置 `developer`（含 `dd75fddf6a-base-tagged`）后 4/4 `SECOND_WINS`，使 `<project-context>` 可细化基线默认值，与 `openai-responses` 及 `codex-rs` 行为一致。因此无需改动提示词模板。

### 3. 单测、类型、Lint 与纯 Node.js 验证

- `tsgo --noEmit`：5 个涉及包（`utils`、`catalog`、`ai`、`agent`、`coding-agent`）均 0 错误。
- `oxlint`：全部 24 个改动/新增 TS 文件 0 错误 0 警告。
- 单元测试：`utils` 7/7、`catalog` 171/171（含 `compat-parity.test.ts` 全量 6,014 行零 diff 与 `codex-client-version-xdg.test.ts`）、`ai` 261/261、`agent` `remote-compaction.test.ts` 108/108、`coding-agent` `model-discovery.test.ts` 112/112。
- 纯 Node.js v25.6.1 冒烟测试：无 `Bun` 全局，`runtime.capabilities.backend === "node"`，完整验证 `runtime.randomUUIDv5`（`6e6ddc8f-32b3-592b-a5b6-b5f2aface174`）、`moveCodexInstructionsToInput`、缺失 XDG 目录自动创建与 `getCodexClientVersion()` 刷新、以及 `uncachedInstructions` 目录解析。

## 明确不做与延后评估项

- **不改动 `../seedadapter`（TRAE DeepSeek）**：此前 3 臂实时基准已证明 `trae/deepseek-v4-pro@cn` 保持单段 `system` 块命中率 96.18%，高于拆分后的 94.59%。
- **延后评估的上游提交**（独立变更，非本次范围）：
  - [`0da37d35a1`](https://github.com/can1357/oh-my-pi/commit/0da37d35a1a08b606720ca3209338b120a24e2e4)（PR `#19988`，`fix(catalog): bind GPT-6.2 thinking to its prompt prefix`）：涉及 thinking-prefix 绑定策略与缓存键设计，需单独评估。
  - [`6c57f9091e`](https://github.com/can1357/oh-my-pi/commit/6c57f9091e8007c8b0ad0969b8545a82f358350d)（`feat(ai,agent): serialized Codex routing fields ahead of the request input`）：JSON 字段序列化排序优化，与本次缓存命中根因无关，可单独评估。
  - [`ad383b54c7`](https://github.com/can1357/oh-my-pi/commit/ad383b54c7ea46fe8d92007ffd034cdc86bcb8f9)（`fix(ai): sent codex session as session-id instead of underscore headers`）：Codex 请求头命名变更，独立于 `instructions` 缓存修复，需结合现网 header 契约单独评估。
