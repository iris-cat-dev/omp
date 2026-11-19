# OMP 上游同步与迁移文档

本目录集中维护 `omp-desktop` 与 `omp-sdk` 子模块跟踪原始上游 [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) 的变更分析、已合入台账与长期保留约束。

## 仓库关系与同步原则

| 对象                 | 仓库 / 固定参考                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原始上游             | [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi)                                                                                             |
| Desktop SDK fork     | [`iris-cat-dev/omp-sdk`](https://github.com/iris-cat-dev/omp-sdk)（以 `omp-sdk/` submodule 固定在 Desktop 中）                                        |
| 导入源码的上游基线   | [`338d2ce6658dfdbfba19efe0f006f0d5a8edd66d`](https://github.com/can1357/oh-my-pi/commit/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d)（2026-10-29）       |
| 对应的 fork 导入提交 | `ceee044fa076149e26cfc4a4be1fb1301f917230`（源码树与上述上游基线完全一致）                                                                            |
| 当前固定 SDK 发布    | [`omp-sdk/sdk/node-release.json`](../../omp-sdk/sdk/node-release.json)（`sdk-v18.14.0-desktop-core.3`，包版本保持 `18.14.0`，由发布标签标识实际构建） |

fork 与上游提交历史不相通，不能通过普通 `git merge-base` 判断某项能力是否已接入，也不能仅凭版本号推断缺口。所有上游同步均按功能选择性吸收，保留 fork 合同，不整包覆盖。

## 目录索引

### 持续维护台账

| 文档                             | 说明                                                                    |
| -------------------------------- | ----------------------------------------------------------------------- |
| [已合入的上游变更记录](ports.md) | 已选择性合入 `omp-sdk` / Desktop 的上游提交清单、对应发布标签与生效步骤 |

### 阶段性上游分析报告

| 文档                                                                 | 日期       | 范围与状态                                                                                                                         |
| -------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [Antigravity 安全修复与 ACP 集成分析](2026-11-18-antigravity-acp.md) | 2026-11-18 | `v18.22.0` 后 `main` 的 `google-antigravity` fail-closed 与 `antigravity-cli` ACP 评估；尚未合入                                   |
| [OMP 上游更新与 Desktop SDK 迁移分析](2026-11-08-oh-my-pi-18.18.md)  | 2026-11-08 | `18.14.0` → `18.18.0+` 全面评估（安全修复、子代理 worker、Shell 迁移）；其中 Shell 与部分 Cursor 项已落地，见 [ports.md](ports.md) |

### 关联文档

- [开发与验证指南 — OMP SDK 后端](../development.md#omp-sdk-backend)
- [打包指南 — 同步源码与 submodule](../packaging.md#2-synchronize-source-without-discarding-local-changes)
- [Catalog 变更日志](../../omp-sdk/packages/catalog/CHANGELOG.md)（上游模型目录同步的包级条目）

## 必须保留的 fork 合同

每次从 `can1357/oh-my-pi` 选择性移植变更时，以下 fork 合同均必须保留，不可被上游实现覆盖：

- Node.js 24+ SDK 托管、Node worker dispatcher、预编译 JavaScript 扩展/eval。
- `desktop/core` 原生功能裁剪与独立打包、发布配置。
- owned-work Stop 等待清理、稳定 runtime owner、资源盘点/释放、安全卸载与 rewind 内核身份。
- client message identity、命令专用 RPC、运行时权限与 proxy policy。
- Browser Relay broker 与 owner 控制。
- Node HTTP/WS 的代理、TLS/CA、FormData brand 转换和图片 multipart 修复。
- Desktop 自定义 native gateway 的无凭据模型支持；上游公共 gateway 的 keyless 修复不能被描述为当前 Desktop 完全缺失本地模型能力。

尤其不要用上游 Bun 实现覆盖 `omp-sdk/packages/ai/src/utils/node-fetch.ts`、`omp-sdk/packages/ai/src/utils/model-websocket.ts`、`omp-sdk/packages/coding-agent/src/auth-gateway/server.ts` 的 portable runtime 适配。上游的图片 multipart 实现也不能替代 fork 已修复的多图片 `image[]` 合同。

`ovnfs` 的准确启用条件是：找到配置或 `PATH` 中的 binary，任务本身要求 isolated，且 `isolation.backend=auto`。找到 binary 后创建 checkout 失败会使 task 失败，不会自动回退 native；daemon 搜索不可用则可以回退 native 搜索。是否在 Desktop 自动切换，仍需结合 daemon、checkout 与恢复记录的 owner 决定。

## 文件命名与维护约定

- 目录统一使用 `docs/upstream/`，不再在 `omp-sdk/` 根目录新增或保留上游分析文档。
- 全小写 kebab-case 命名：
  - 长期维护的台账使用功能名：`README.md`、`ports.md`。
  - 按时间点记录的上游分析/专题调研统一命名为 `YYYY-MM-DD-<topic>.md`（例如 `2026-11-18-antigravity-acp.md`）。
- 每次完成新的上游选择性合入后：
  1. 在 [ports.md](ports.md) 顶部追加本次合入的日期、上游提交、SDK/Desktop 提交与保留边界；
  2. 在本页目录表中更新相关分析报告的状态；
  3. 若涉及模型目录更新，在仓库根目录执行 `node packages/app/scripts/project-omp-provider-catalog.mjs` 并一并提交生成的 `omp-provider-model-index.json`。
