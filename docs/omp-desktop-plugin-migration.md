# omp 原生插件迁移到 omp-desktop

本指南适用于已有的 omp 扩展、模型 provider、工具、命令与 hooks。目标是保留原生插件契约，让插件能够运行在 omp-desktop 的 Node SDK 宿主中，并按需继续支持 Bun CLI。

迁移不是重写成 Electron 插件，也不是在 Desktop 内启动另一套 CLI、模型客户端或工具执行器。本文只描述通用方法，不包含具体项目、内部服务、个人目录、提交记录或凭据实现。

## 1. 明确迁移边界

```text
Desktop 界面
  → 宿主 RPC 适配器
  → Node SDK 进程
  → 插件发现与 JavaScript 模块加载
  → 原生 ExtensionAPI
  → 模型流、工具、审批、历史与生命周期
```

先记录目标宿主的运行时要求、SDK 支持面、构建 target/profile 与实际交互能力。开发机安装的 SDK 不等于 Desktop 使用的 SDK；更新全局 CLI 也不会更新 Desktop 自带的 SDK。

将差异分成下面几类，不把业务功能混入迁移要求：

| 类别 | 需要检查的内容 |
| --- | --- |
| 交付入口 | manifest、JavaScript 产物、资源、安装与发布脚本 |
| 运行时 | Bun 专用 API、进程、流、HTTP、SQLite、WebSocket |
| SDK 依赖 | 公共导出、宿主模块映射、共享实例与版本兼容 |
| 交互与登录 | RPC 问答、TUI 组件、授权 URL、敏感输入与取消 |
| 会话状态 | cwd、session id、并发、缓存、清理与持久化 |
| 业务功能 | 新模型、新协议、新租户等；通常不属于迁移本身 |

比较代码时使用仓库的实际主线引用，不默认一定叫 `main`。对外文档保留改造分类与方法，不复制内部提交标识、完整 diff、服务地址或本机验证日志。

## 2. 预编译所有可执行入口

### manifest 与构建

Node SDK 不提供插件 TypeScript/JSX 的运行时编译。源码可以继续使用 TypeScript，但 manifest 必须指向 `.js`、`.mjs` 或 `.cjs` 产物；传递依赖也必须可由 Node 执行。

单入口 ESM 插件的配置示例：

```json
{
  "name": "example-omp-plugin",
  "type": "module",
  "files": ["dist"],
  "omp": {
    "extensions": ["./dist/index.mjs"]
  },
  "scripts": {
    "build": "bun build ./src/index.ts --target=node --format=esm --packages=external --outfile=dist/index.mjs",
    "prepare": "bun run build"
  }
}
```

这是构建配置，不替代插件原有的注册实现。多入口插件应编译并声明全部入口。

- `--target=node --format=esm` 输出 Node 兼容 ESM。
- `--packages=external` 内联插件自己的模块，保留裸包导入。所有未打包的非 SDK 依赖都要另行交付。
- `package.json` 的 `main` / `exports` 不能代替 `omp.extensions` 的插件入口声明。
- Markdown、模板、图片、WASM 等资源应内联或随包交付。构建工具的资源 loader 语法不能留给 Node 现场解释。
- 忽略 `dist/` 只是版本管理策略，不表示安装时可以缺少产物。
- 源码安装可由 `prepare` 构建；若安装渠道跳过生命周期脚本，发布者必须预先构建。
- 修改源码后重新构建。不要通过改后缀、symlink 或 Node 的类型剥离选项绕过宿主的入口限制。

在插件目录运行已有构建、类型检查与测试命令。Bun 在这里是开发工具，不应成为 Desktop 用户额外安装的运行时要求。

## 3. 保留宿主 SDK 的共享实例

`@oh-my-pi/*` 的运行时 SDK 导入应由宿主解析，不把 SDK 实现打入插件 bundle。否则可能产生两份注册表、事件流或 job manager，出现“插件注册了，宿主却看不到”的问题。

迁移时逐项核对目标 SDK 的公开导出和模块映射：

1. 优先使用公开包根或文档明确支持的子路径。
2. 不从 SDK 源码目录导入私有模块，不依赖本机 workspace link。
3. 不认为源码包存在、类型检查通过，就意味着 Desktop 支持相同深层导入。
4. 不通过打包另一份 SDK 来填补宿主缺失的导出。
5. 确实需要更宽的 SDK 支持面时，明确宿主构建要求并验证目标产物；不同 target/profile 不能混为一谈。

第三方 JavaScript 依赖可以编译进插件，或作为生产依赖随插件安装。外置依赖必须能从插件实际安装位置解析，不能依赖开发仓库偶然存在的 `node_modules`。

原生 addon 需要匹配目标 OS、架构与 Node/Electron ABI 或 Node-API，并满足宿主的打包布局要求。插件可用不等于任意原生依赖都可用；需要逐平台验证。

## 4. 替换 Bun 专用运行时能力

优先使用 Node 标准 API。已有插件如需保留 Bun 快路径，应只为实际使用到的能力建立局部适配，不构造通用运行时框架。

| 原依赖 | Node 路径 | 需要保持的语义 |
| --- | --- | --- |
| `Bun.CryptoHasher` | `node:crypto` | 算法、输入、编码与截取方式不变，避免身份或缓存 key 改变 |
| `Bun.which` | PATH 与可执行文件探测 | 缺失依赖明确报错；Windows 扩展名与启动方式另测 |
| `Bun.spawn` | `node:child_process` | argv 不经 shell；stdout/stderr、退出码、取消与进程释放一致 |
| `Bun.sleep` | `node:timers/promises` | 等待与取消语义不变 |
| `Bun.serve` | `node:http` | 请求/响应、流、端口就绪、错误与关闭行为一致 |
| `bun:sqlite` | `node:sqlite` 或目标宿主明确支持的接口 | 读写权限、查询、事务与关闭语义一致 |

### 容易遗漏的边界

- Node 子进程通常提供 Node streams，插件接口可能要求 Web ReadableStream；在边界转换，不随意复制整个 payload。
- HTTP 监听就绪是异步的。同步 API 改为 Promise 后，迁移所有调用方，不能返回尚未就绪的端口或句柄。
- 只读数据库不能在迁移时改为默认读写打开；用临时数据库验证读取和拒写。
- 不在顶层静态导入 Bun 专用模块。若保留双运行时路径，专用模块只在对应分支加载。
- Node 与 Bun 的同名 WebSocket/fetch API 不保证扩展参数完全一致。自定义握手头、proxy、TLS、取消与事件行为要检查目标运行时并实际连接验证。
- 宿主注入的 fetch 代理不会自动接管插件自己创建的 WebSocket。
- 进程信号、`.cmd` 启动与原生依赖不能仅靠 macOS/Linux 的结果推断 Windows 行为。

类型断言只解决编译问题，不证明运行时协议兼容。避免为了消除类型错误而改写消息格式或复制大缓冲区。

## 5. 保留原生模型、工具与审批

继续使用原有 `ExtensionAPI` 注册 provider、工具、命令和 hooks。已经能复用原生协议传输的插件，不为 Desktop 新建另一份请求或流式状态机。

- 自定义 provider 返回原生事件流；工具调用进入宿主的执行、审批与结果回传流程。
- 不在插件里直接执行模型要求的 shell，绕过宿主工具链。
- 保留宿主传入的 `apiKey`、`fetch`、`signal`、`cwd`、`sessionId` 与 payload hooks。
- 不静默替换模型、伪造工具结果或把协议错误改成成功。
- 插件额外的子进程或网络连接不自动继承宿主的审批、代理与取消；需要明确边界。

运行验证必须观察实际工具调用与结果，不能只靠模型声称“已经读取文件”。

## 6. 将 TUI 交互改为真实 RPC 能力

`ctx.hasUI` 表示存在交互适配器，不表示完整 TUI 可用。终端组件应以 `ctx.mode === "tui"` 保护；Desktop 路径只能依赖目标版本实际支持的交互。

下面是需要逐项验证的边界，不是跨版本的统一支持承诺：

| 能力 | 迁移检查 |
| --- | --- |
| select / confirm | 是否映射为宿主问答；回答与取消是否按请求 id 配对 |
| input | 是否支持 placeholder、空值、超时；敏感输入是否保留保护语义 |
| editor | 是否保留预填内容与多行编辑语义，还是退化为自由文本问题 |
| notify | 是否保留级别及非敏感内容 |
| working / widget / status / title | 是否真的显示，还是 no-op 或未被 Desktop 消费的事件 |
| custom / footer / header / editor component | 是否仅支持 TUI；factory 是否会被执行 |
| composer / terminal API | 是否可读写输入框；不能依赖固定空值或无效方法 |
| 授权 URL | 普通会话显示链接与登录设置打开浏览器是否为不同路径 |

部分 RPC 实现不会显示 working/widget，不执行自定义 TUI factory，也不保留 editor 的全部语义。关键 URL、错误或进度不能只放在这些通道中。需要将它们迁移到已支持的非敏感通知或真实授权桥；缺少必要能力时明确限制，不能静默丢弃。

`open_url` 是协议事件，不应未经接口核实就写成 `ui.openUrl` 公共方法。也不要把 transient 状态伪装成 assistant 正文写入历史。

### OAuth 与敏感输入

分别验证主动登录、自动续登、手动码、失败与取消。回调类型支持某个字段，不代表 RPC 桥已经提供它。

特别检查：

- 授权 URL 前是否允许 `onPrompt`。
- `secret: true` 是否被支持并贯穿整个交互链。
- `onAuth`、`onProgress`、`onManualCodeInput`、`onBrowserSession` 是否实际桥接。
- 是否传入 callback `signal`，还是通过关闭独立 runtime 取消。
- 续登期间的确认链接是否真实可见，不能由主动登录成功推导续登成功。

有些 RPC 登录桥只支持 URL-first、无 secret prompt 的流程。遇到限制时，补齐并验证 SDK 与 Desktop 的真实交互，或明确使用插件已有的外部鉴权路径。不能删除 `secret` 标记、伪造授权事件、改用普通聊天输入收集凭据。

凭据只进入服务的鉴权边界，不写入模型上下文、通知、日志或普通配置。存储登录由宿主凭据库负责；环境变量、外部授权与可登出的存储账号是不同概念。

若默认 `apiKey` 配置引用覆盖已登录凭据，或外部 key 被误算成存储账号，应核对宿主的凭据优先级和登录状态实现。不要为界面显示伪造登录记录。

## 7. 按会话管理状态与清理

Desktop 的顶层进程隔离不等于插件沙箱，也不保证同进程的请求严格串行。子会话可能共享已导入的模块，标题生成、utility 请求与主请求也可能并发。

- 可变状态优先归属于 extension factory 或实际 session id，不使用一个全局“当前请求/当前 UI”覆盖其他请求。
- handler 使用当前 `ctx.cwd` 和 `ctx.sessionManager`；provider 使用当前请求的 `options.cwd` / `sessionId`。
- 不把启动时 process cwd 或 Desktop 顶层环境标识当作所有子会话的身份。
- 缓存按真实账号、端点、模型和会话边界隔离；一个等待者取消不能破坏其他共享等待者。
- 环境配置通常在 worker 启动时合成；修改环境后使用新 runtime，不假定旧 worker 自动更新。
- shutdown 释放连接、设备、临时页面与进程，必须有界且可重复。
- 宿主可能给 shutdown handler 很短的上限，或直接终止进程。重要状态应在变更时保存，不能把 shutdown 当最终持久化事务。
- 自建原生 timers/server/subprocess 不会因为宿主清理 managed timers 就自动关闭。

## 8. 安装、更新与发布

安装入口是插件包目录及其 manifest，不是 TypeScript 源文件。源码更新顺序是：构建 → 确认产物交付 → 重新加载目标 runtime。

- 本地开发可在插件管理界面安装/链接插件目录；需要全局登录管理的 provider，应在该用户/profile 的发现范围内安装。
- 项目内扩展与全局/profile 插件不是同一作用域，不能假定登录设置的独立 runtime 会发现聊天项目中的扩展。
- 修改 extension JS/provider/tool/hook 后，保守使用新会话或重启对应 runtime。不要假定 `/reload-plugins` 重新求值 factory；某些实现只刷新缓存、skills 和文件命令。
- 修改 SDK/backend 需要更新宿主产物并重启后端，旧会话不会原地切换 SDK。
- 插件检查可能持久禁用加载失败的插件；修复构建后还要重新启用，不关闭检查或压掉错误。
- 发布包必须包含全部执行入口、资源和生产依赖。移出开发 checkout 后再次验证解析。

## 9. 真实 SDK 加载烟测

类型检查、`node --check` 和直接 import 插件都不能替代真实宿主加载。加载器还需要完成入口发现、共享模块解析和 factory 执行。

下面的示例使用公开 SDK 加载 API，仅写临时用户状态，不启动模型会话或访问云端。调用前在本地设置：

- `SDK_ROOT`：目标 Desktop 已安装的 SDK **包根目录**，不是单个模块或外层产物目录。
- `PLUGIN_ROOT`：待验证的插件包目录。

示例不包含个人路径；输出不列出本地目录、provider 名称或内部构建信息。

```sh
: "${SDK_ROOT:?Set SDK_ROOT to the installed SDK package root}"
: "${PLUGIN_ROOT:?Set PLUGIN_ROOT to the plugin package root}"
export SDK_ROOT PLUGIN_ROOT
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sdkRoot = path.resolve(process.env.SDK_ROOT);
const pluginRoot = path.resolve(process.env.PLUGIN_ROOT);
const originalCwd = process.cwd();
const scratch = await mkdtemp(path.join(tmpdir(), 'omp-plugin-smoke-'));
Object.assign(process.env, {
  HOME: scratch, PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
  PI_CONFIG_DIR: '.omp', PI_PROFILE: '',
  XDG_DATA_HOME: path.join(scratch, 'data'),
  XDG_STATE_HOME: path.join(scratch, 'state'),
  XDG_CACHE_HOME: path.join(scratch, 'cache'), NODE_PATH: '',
});
try {
  process.chdir(scratch);
  const sdk = await import(pathToFileURL(path.join(sdkRoot, 'dist/node/sdk.mjs')).href);
  assert.equal(globalThis.Bun, undefined);
  const entries = await sdk.discoverExtensionPaths(
    [pluginRoot], scratch, undefined, { ambient: false },
  );
  assert.ok(entries.length > 0, 'No executable extension entries found');
  const result = await sdk.loadExtensions(entries, scratch);
  if (result.errors.length) {
    throw new Error('Extension loading failed; inspect diagnostics locally and redact before sharing');
  }
  assert.equal(result.extensions.length, entries.length);
  console.log({ loaded: result.extensions.length, errors: result.errors.length });
} finally {
  process.chdir(originalCwd);
  await rm(scratch, { recursive: true, force: true });
}
JS
```

SDK API 以目标版本为准。此 smoke 证明发现、导入与 factory 加载，不证明注册后的功能、session hooks、登录或工具执行。工具/命令类型插件还应实际调用其注册功能，provider 还应验证模型与工具闭环。

## 10. 功能验收与公开交付

| 验收层 | 需要的证据 |
| --- | --- |
| 构建/发布 | manifest 文件存在；没有待运行时编译的依赖；资源与生产依赖齐全 |
| Node SDK 加载 | 使用实际目标宿主；发现和 factory 无错误；不是退回 Bun 执行 |
| CLI 回归 | 执行插件原有命令或会话路径，不仅检查 help |
| 注册功能 | 真实调用 provider/tool/command/hook，观察其消费者可见行为 |
| Desktop 交互 | URL、问答、敏感输入、错误与取消分别验证；不支持项明确列出 |
| 工具闭环 | 读取刚生成的随机文件内容，观察调用、审批、结果回传与最终答案 |
| 生命周期 | 并发、历史续聊/改写、工作目录变化、长工具、取消后下一轮和清理 |
| 平台/分发 | 在目标运行时与 OS/arch 上执行；移出 checkout；无外部 Bun/CLI 依赖 |

不能 mock 主协议后宣称迁移完成。无法验证的能力明确标注，不能用“加载通过”替代“端到端通过”。

对外共享前检查文档、截图与日志：删除个人目录、内部地址、账号/设备标识、提交记录、服务鉴权字段与完整网络捕获。保留方法、能力边界和匿名化的验证结论；不要把仓库内部研究材料链接进通用指南。

交付清单：

- [ ] 可执行入口与资源已编译、声明并交付。
- [ ] SDK 由宿主共享，使用目标版本支持的公开 API。
- [ ] Bun 专用能力已替换或在双运行时上验证，异步接口的全部调用方已迁移。
- [ ] 原生模型、工具、审批、历史、取消与凭据边界保持不变。
- [ ] UI、主动登录、续登与取消分别验证；没有不安全降级。
- [ ] 会话状态、并发与有界清理有真实行为证据。
- [ ] 目标平台与分发验证完成，未验证项明确列出。
- [ ] 文档示例可执行，公开材料不含项目私有信息或敏感日志。
