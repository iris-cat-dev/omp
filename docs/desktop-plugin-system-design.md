# Desktop 统一插件系统设计

状态：通用插件宿主、统一管理和文件夹安装已实现；默认发行不携带具体插件。本文同时保留可选功能插件的设计约束与历史验收记录，专项验证边界见文末。

## 核心决策：统一管理，保留不同执行环境

将用户界面的 **OMP 插件**入口统一改为**插件**。插件管理器负责 Desktop 插件与 OMP 原生插件的发现、安装、信任授权、配置、启用状态、诊断和移除；两者继续使用各自的执行契约。

本次设计范围：

- 恢复有历史依据的 Desktop 插件契约，保留现有安装状态。
- 保持现有 OMP provider、工具、命令、hooks、插件市场及用户／项目作用域可用。
- 所有具体插件全部外置；桌面宠物、壁纸、速度监控和 QQ 连接不在默认发行中注册、预装或分发。
- 保留应用级服务和 UI 的通用插件宿主，支持用户显式从文件夹安装。
- 提供菜单、设置页面、工作区／agent Tab 扩展能力。

插件是可执行的功能代码。宠物清单、动画图集、壁纸文件和导入媒体是**插件管理的资源**，不是额外的可执行插件。

```text
插件管理器
  ├─ Desktop 应用运行时
  │    ├─ 本机客户端扩展：设置、菜单、Tab、回合指标、背景
  │    ├─ 本机功能服务：文件夹安装的插件 worker
  │    └─ 原生受控接口：悬浮窗口、输入、媒体、对话框、导航
  ├─ 选定 daemon 的运行时
  │    └─ 每个启用的安装实例对应一个服务实例：QQ 网关、旧插件服务
  └─ OMP 原生插件适配层
       └─ 现有 SDK 插件管理器与按会话执行的扩展、provider、工具、hooks
```

不能在 OMP 扩展 factory 中启动 QQ socket、原生窗口或应用后台任务。OMP factory 按 SDK 会话执行，也可能在启动检查时执行；JavaScript 模块单例不能跨越 Desktop 的多个 SDK 子进程。

## 产品入口：管理已安装功能，避免两套设置系统

管理器提供**已安装**和**发现**视图、搜索与目标选择器。目标必须明确：本机 Desktop 配置档案、选定的 daemon 主机，或该主机上的 OMP 项目。新配置档案的“已安装”初始视图为空；已有档案显示正常安装项，历史预装记录仅保留为非活动数据。切换主机不能移动本机资源，也不能改变本机插件配置。

插件列表显示名称、来源、版本、归属、执行环境、启用状态、健康状态及可操作的错误信息。详情提供**配置**、**权限**、**日志**以及升级／移除操作。混合插件包分别显示 Desktop 与 OMP 组件的状态；部分操作成功不能被报告为整体成功。

发行只包含通用 SDK、编译器、worker 与受控原生接口，不定义内置插件目录或默认插件名单。**发现 → 文件夹路径 → 检查／安装 → 信任确认**建立普通安装记录；本机 Desktop 新安装默认禁用，随后由用户显式启用。daemon 插件还受**允许主机插件运行**控制。

历史本机 `source.type === "builtin"` 与 daemon `bundled: true` 记录不展示、不加载 clientBundle、不自动运行，也不能直接授权或启用。原配置、授权记录和资源不删除。用户从文件夹显式重装同 ID 时，来源改为普通安装并保留按 ID 存储的数据；新代码仍须确认信任。连接旧主机的新客户端也过滤 `bundled: true` 条目，不操作该旧主机已经运行的 worker。

配置、权限、日志和扩展页面由实际安装项提供。禁用执行时可信客户端可进入管理模式；管理页面不能取得正在运行的背景、悬浮窗口或服务租约。OMP 原生管理继续使用唯一插件入口。

远端 daemon 离线时，本机插件仍可配置。主机插件显示断开的目标，不使整个管理器失效或阻塞。平台能力不可用时，在受影响功能旁明确显示，不能呈现为启用成功。

“发现”页面提供文件夹安装和现有 OMP 原生插件市场，不列出随应用分发的具体插件。它不另建共享市场后端，也不根据显示名称推断安装身份。本机和原生来源操作交给真实归属方执行。

## 安装身份与状态归属

区分插件包描述、安装记录和激活实例。

- **插件包：**发布者身份、版本、支持的 API／运行时／平台、执行入口、资源、声明的能力与扩展项。
- **安装记录：**精确来源身份、运行时类别、归属作用域、选定版本、用户期望的启用状态、全局执行开关、实际生效／被遮蔽状态、能力授权、配置修订号和迁移版本。
- **激活实例：**安装身份、单调变化的 generation、运行进程或文档归属，以及该实例拥有的清理句柄。

OMP 原生市场插件的身份必须保持为精确的 `plugin-name@marketplace-name`。不能合并不同市场的同名项、抹平用户／项目作用域，或仅因名称相同就把 Desktop 包与 OMP 插件认定为配套组件。混合插件包显式关联组件，并保留每个原生安装标识。

Desktop 安装 ID 继续使用现有 `PluginIdSchema` 的小写、数字、连字符格式；OMP 原生标识保留自身格式。UI 扩展项 ID 允许点分命名空间，例如 `qqbot.settings`、`qqbot.open`：每个非空分段以小写字母开头，其后允许小写字母、数字和连字符，不接受路径分隔符、冒号、空段或空格。UI 扩展键仍包含完整安装身份与扩展项 ID；面板还携带工作区或 agent 上下文。包名本身不能充当 UI 键。

权威数据保留在真实归属方：

- 本机原生设置与资源：Desktop 配置档案存储，不依赖 daemon 选择。
- daemon 插件安装／配置及 QQ 身份：该 daemon 的插件注册表与存储。
- OMP 原生安装／启用状态：现有 SDK 插件管理存储；统一管理器只做投影，不复制一份。
- 渲染进程草稿与临时媒体就绪状态：对应客户端／文档，不存为全局主机记录。
- agent 历史、模型凭据、工具审批、token 总量：现有宿主／SDK 归属方。

采用带修订号的字段补丁、串行持久化，并在提交成功后发布变更。不能用过期渲染进程缓存覆盖整份设置。禁用和普通移除保留插件配置与用户资源；**清除此插件数据**是独立、明确的操作。移除目录插件只删除安装引用，不删除用户源码目录。历史预装数据保持非活动，恢复功能需要用户提供插件文件夹并明确安装、启用。OMP 原生插件移除遵循其包管理器的既有语义。

## 源码插件接入：统一 OMP 命名，保留注册生命周期

明确的历史基线是 [Paseo 0.5.2 本地插件](https://github.com/getpaseo/paseo/blob/4092c2926500d51af6510bbe295591af0dfe52f7/docs/plugins.md)，包括：

- 严格的 `paseo-plugin.json`，只包含 `{ "id": "my-plugin" }`。
- `index.ts` 中默认导出的扩展注册函数，返回同步或异步清理函数；历史编译器也支持 `index.tsx`。
- 从同一个注册入口编译客户端、服务端两份产物，通过 `.client`、`.server`、`.shared` 文件边界隔离导入。
- 宿主注入的 `@getpaseo/plugin`、`@getpaseo/plugin/server`，以及共享的 React／RN／Query／Zod 依赖，避免产生多份运行时实例。
- `handle`、`addSurface`、`addSidebarItem`、`addWorkspacePanel`、`addCommandCenterItem`、`addAttachmentSource`、`addTheme`。

当前源码插件统一使用 `omp-plugin.json` 与 `@omp-desktop/plugin`／`@omp-desktop/plugin/server`。宿主 API 字段为 `context.omp`，React hook 为 `useOmp()`；客户端类型与工厂统一为 `OmpApi`、`OmpAgent`、`createOmpApi()`、`createOmpClient()`。旧清单文件名、包名和字段别名不再提供，外部源码插件须同步改名。

源码接入仍进入同一套服务注册表、客户端注册表和生命周期引擎。保留默认扩展注册函数与 cleanup，不添加没有依据的 `activate/deactivate`，也不要求业务代码改成 OMP factory。注册方法可以返回 `void`；对应扩展函数的 cleanup 和宿主清理集合仍负责释放所有注册项。

工作区面板贡献可通过 `addWorkspacePanel({ context: "workspace", fileSuffix: ".canva.json", … })` 为文件标签页提供自定义编辑器。宿主仅匹配已启用的本机插件或当前 daemon 的插件，忽略后缀大小写，优先使用最长匹配。组件收到相对于当前检出目录的 `filePath`（使用 `/` 分隔，不含行号）；从插件入口直接打开面板时没有此属性。文件仍使用原有标签页身份和文件树布局；无法定位到当前检出目录或没有匹配编辑器时，使用普通预览。此注册不影响系统文件关联，也不授予文件访问权限。

`omp-plugin.json` 保持严格的 `{ id }` 格式。新元数据放在带版本的 `package.json.ompDesktop` 描述中，不向 `{ id }` 塞额外字段。新公开契约的初始版本为 `apiVersion: 1`，与没有 API 版本字段的源码格式区分。

拟定的编译后 QQ 插件包描述示例：

```json
{
  "name": "@omp-desktop/plugin-qqbot",
  "version": "0.7.0",
  "type": "module",
  "files": ["dist"],
  "ompDesktop": {
    "apiVersion": 1,
    "id": "qqbot",
    "owner": "daemon",
    "entries": {
      "service": "./dist/service.mjs",
      "client": "./dist/client.mjs"
    },
    "capabilities": [
      "agents.create",
      "agents.prompt",
      "agents.events",
      "agents.permissions",
      "files.scoped",
      "secrets.scoped"
    ]
  },
  "omp": {
    "extensions": ["./dist/omp.mjs"]
  }
}
```

`owner` 只能是 `desktop` 或 `daemon`；同时需要两者的包采用明确关联的安装记录，明确各自的进程归属。OMP 配套组件可选，继续使用原生 manifest；安装来源和作用域由原生管理器解析。

编译后的 Desktop 入口执行 Node 兼容 JS 或浏览器兼容 JS，随包交付全部生产依赖与资源。旧源码保留独立、明确的宿主编译路径：恢复并打包兼容的分目标编译器，不把 TypeScript 交给 Node SDK loader。新源码在分发前构建。不能打包第二份 OMP SDK 或宿主 React 运行时。

`@omp-desktop/plugin` 是拟定的统一公开包，分别导出客户端和服务端角色接口。旧模块名仅在旧源码接入适配器中映射。两者进入同一实现和归一化契约，不维护两套独立演进的注册表。

新服务端、客户端入口默认导出对应角色的 setup／扩展注册 factory，并返回实例拥有的清理函数；服务初始化可异步执行。上下文包含绑定的安装实例、角色、当前激活 signal 和该角色支持的受控接口。模块求值和扩展声明不能启动 socket／窗口；服务初始化只在真实激活时执行。可信的客户端设置视图可在禁用执行时以管理模式加载，背景／悬浮窗口／服务副作用仍需有效激活授权。这样可以配置未绑定的 QQ 账号，而不自动建立连接。

### 保留旧安装与执行选择

现有 daemon `plugins` 配置继续作为 Desktop daemon 安装项的权威来源。配置键是安装／运行时 ID，manifest ID 只作为新安装的默认值。保留用户指定的 `--id`，允许同一个目录以不同 ID 安装，不能为了登记已有包而重新安装或重新链接。

保留 `pluginsEnabled` 作为 daemon Desktop 服务的全局执行开关，与单项期望启用状态分开。历史默认值为 false，普通来源缺少 enabled 时历史语义为 true；历史 `bundled: true` 来源始终不执行。界面同时显示全局开关和实际生效状态。此开关不作用于本机 Desktop 安装项或 OMP 原生插件，迁移时也不能自动打开。全局开关关闭时，管理器提供明确的**允许主机插件运行**操作。

对于已经启用／批准的来源，继承已有信任而不悄悄扩展能力。新来源或需要更高权限的来源变更必须取得明确信任授权。旧禁用来源保持禁用；发现和检查 manifest 不执行代码。旧全局暂停状态也保持暂停，并保留各插件选择。

旧 reload 保持“停止旧实例 → 编译新代码 → 启动新实例”的顺序；重载失败仍为失败，不静默恢复旧代码。日志保留／移除遵循历史契约。类型化 `handle` 接口在客户端与服务端校验 RPC 输入和输出。其 `paseo` 上下文借用精确选定的主机连接，或 worker 独占的 `plugin:<installationId>` 会话，不回退到其他主机。

## OMP 原生管理继续作为权威来源

统一页面代理选定 SDK 的安装、启停、features、settings、市场、升级和诊断操作。为原生 `features/config` 补齐缺失的公开管理 RPC，不绕过 SDK 修改其注册表。保留 provider 命令、profile、环境、代理及 cwd 发现规则。由选定 SDK 解析注册表／profile 路径；不能假定 `~/.omp`，也不能在 profile／XDG 路径未知时复制当前默认 home 回退逻辑。

以下状态保持区分：

- npm／Git／本地链接包身份、市场身份、显示名和运行时锁键。
- 用户与项目记录，包括“已启用项目副本遮蔽用户副本”以及“项目副本禁用后用户副本重新生效”。
- 可选功能采用默认选择（`enabledFeatures: null`）与不启用任何可选功能（`[]`）。
- 不支持升级的链接来源与可升级的版本化来源。
- 已存储 provider 凭据与环境变量／API key 配置。

只提供选定来源类型／SDK 实际支持的安装作用域。当前 SDK 支持项目作用域的市场插件安装；统一界面增加项目选择器，不代表本地／npm 安装获得了项目作用域支持。仅项目可发现的 provider，也不会自动进入现有以 home 为 cwd 的登录运行时。

原生设置适配器返回遵循 schema 的脱敏值和 secret 已配置标记。原生 CLI 的 JSON 配置输出可能包含原始 secret，不能直接作为管理器状态或日志返回。禁用／移除插件、修改原生设置、退出 provider 账号是不同操作。保留 OAuth 取消及真实 RPC 桥支持的流程；不支持的敏感输入或 TUI 专用 UI 返回明确兼容性结果，不能通过普通聊天收集 secret，也不能以空实现报告成功。

原生 doctor／启动检查可能执行 factory 并持久化禁用状态，界面必须将它呈现为真实操作，而不是无副作用的元数据预览。原生 TUI widget 不会自动成为 Desktop Tab，必须另有 Desktop 客户端扩展。

## 公开扩展点：复用现有 UI 机制

下列扩展名称是拟定契约，尚未公开导出。统一 Desktop SDK 和旧源码门面接入同一注册表，不让插件导入 `packages/app/src`、`packages/server/src` 或 `@omp-desktop/client/internal/*`。

| 扩展项                      | 插件提供                                                                             | 宿主负责                                                             |
| --------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `settings.page`             | 配置组件／schema、标题                                                               | 管理器路由、安装上下文、校验、禁用状态下的配置管理                   |
| `command` 和 `menu.item`    | 稳定动作 ID、标题、位置、排序、上下文条件、处理函数                                  | 命令中心、新建 Tab／工作区／agent 菜单、快捷键冲突处理、原生菜单分发 |
| `panel`                     | 稳定面板 ID、标题／图标、支持的 `workspace` 或 `agent` 上下文、视图、持久状态 schema | 现有 Tab 身份、分栏布局、恢复、导航和清理                            |
| `surface` 和 `sidebar.item` | 全局插件页面、图标、导航 ID                                                          | 页面嵌入应用中央内容区；保留 Desktop 侧栏和页头、主机绑定与选择记忆   |
| `attachment.source`         | 类型化搜索／选择契约、完整文本快照                                                   | 现有输入框选择器、草稿、附件标签和提交；移除插件后快照仍可读         |
| `theme`                     | 旧明／暗调色板、ID、显示名                                                           | 语义主题展开、预留插件主题槽位、稳定选择、不透明浮层                 |
| `turn.metric`               | 实时／已完成回合速度投影，包含值、单位、实测／估算来源                               | 稳定回合页脚槽位、当前上下文、可见性、可读布局                       |
| `background`                | 背景来源意图、媒体引用、透明度                                                       | 独占提供者选择、根背景层、就绪状态、主题表面策略                     |
| `overlay`                   | 宠物视图／内容、尺寸策略、命中区域意图、动作                                         | 隔离原生窗口、输入策略、显示器边界、鉴权 bridge                      |

每次注册返回由激活实例持有的清理句柄。注册 bridge 是接入现有 `registerPanel`、命令中心注册表、设置路由和 Tab launcher 的唯一受支持路径。增加一个真实的 `plugin` 面板注册，根据 `(installation, panelId, context)` 解析视图；不能为每个插件新增一个硬编码 Tab kind。

菜单通过所属激活实例分发 action ID，不跨 RPC 传递任意 Electron 回调。面板状态是经过注册 schema 校验的 JSON；secret 和原生／媒体句柄不能序列化到面板状态。插件被移除、禁用或失败时，Tab 显示**插件不可用**，保留身份和状态，并提供配置、启用或关闭操作。不能触发当前“缺少面板注册”的 invariant，也不能删除用户分栏布局。

背景提供者在每个本机配置档案内独占。安装或注册另一个提供者不自动选中它。已选提供者失败或被禁用时恢复普通主题表面，不静默选择其他插件。失去所选槽位所有权的注册项不能发布迟到的背景结果。

回合指标和命令扩展可叠加，排序必须确定。重复扩展 ID 是安装实例范围内的错误。插件不能用自身状态 widget 替换核心停止／审批控件或权威 agent 生命周期状态。

保留旧全局页面／主题的聚合与主机选择记忆：同 ID 的新连接主机不能用另一套调色板重绘应用。保留 `theme: "plugin"` 和精确的 `pluginThemeId`，例如 `catppuccin/theme/mocha`。提供者缺失时采用现有有效回退，同时保留已存引用。附件源只属于输入框所在主机，不跨主机聚合。这些兼容规则不能用于合并不同的原生安装记录。

客户端注册表按主机执行“快照 + 订阅”的 catalog 同步，忽略旧修订，并在替换／断连时清理旧实例。保留每个安装实例独立的 QueryClient／缓存语义。只读工作区／agent selector 使用当前归一化客户端快照；仅列出／打开面板不能通过 RPC 拉取活动上下文。宿主 DTO 是不可变输入，不是可写存储。

SDK 只为 API 命名空间与所属激活的资源句柄加调用 guard；普通 DTO 和数组按原值返回，不递归代理数据或数组回调生成的 React element。API 调用先检查能力与 generation；异步结果及回调交付时再次检查 generation。

客户端通过公开的 `ctx.hosts.list()/subscribe()/get(id)` 访问主机目录。daemon-owned 插件只返回同 package／installation 的受信任 active 实例，调用同时受发起端和目标端授权约束；management 模式不能取得这类连接。Desktop-owned 插件使用应用已有的真实主机连接，不要求远端安装同一个插件；仅在线主机可取得 `omp` 与变更订阅，本机服务 RPC 使用 `ctx.rpc()`。撤销和 generation 替换使旧调用／回调失效。

Desktop management 模式保留受限创作能力：`agents.events` 允许 provider 数据和 `host.info()`，`agents.create` 允许新建工作区及在该新工作区内创建会话。既有工作区／会话的读取和修改仍禁止；daemon management 的限制不变。公开 `omp.agents.list()` 保留协议的可选 `sync` 目录修订，用于完成读取后的 freshness 与 generation 再验证。

管理器路由和 catalog 返回真实运行时支持。只有运行时已经接通才能恢复 `plugin.*` 分发；`plugins/pluginManagement/pluginLogs/pluginThemes` 能力标记必须反映已实现能力。当前无条件发布的标记不能声称缺失服务可用。OMP `ompPlugins.*` 保留独立传输协议，但使用同一个管理页面。

## 运行时与生命周期契约

Desktop 静态校验检查 manifest、入口路径、API 兼容性和交付依赖，不执行服务 factory 来探测就绪。Desktop 服务 factory 仅在真实激活时执行一次。保留 OMP 原生启动检查和 factory 语义，不能将原生检查变成 Desktop 服务激活机制。

```text
已安装／用户选择禁用
  → 启用 → 校验 → 等待所需能力／就绪 → 激活中 → 已激活
                                             └→ 失败
已激活／失败／等待中 → 禁用 → 撤销授权 → 停止 → 已安装且禁用
已安装 → 移除 → 撤销授权 → 停止 → 移除可执行安装项
应用或 daemon 退出 → 撤销授权 → 停止 → 进程退出，保留用户期望的启用状态
```

激活前配置已经持久化。等待 QQ 凭据或 Desktop 就绪信号不能延迟宿主 ready 响应，也不能阻塞设置界面；管理器显示等待原因。已授权且 `effectiveEnabled` 的服务在 `waiting` 和 `running` 时均保留 active 客户端，等待账号时仍可打开登录侧栏和菜单。相同 generation 的 waiting → running 不重建客户端，不丢页面状态或在途 RPC。真正禁用或全局暂停则切回 manage，只保留配置入口。

daemon 不登记、搬迁或恢复分发插件，不再接受 `bundledPluginDirectories`。历史 `bundled: true` 记录保留原 enabled、installed、trustRevoked、approval 与按安装 ID 保存的数据，但不发现、启动或注入。显式从文件夹重装同 ID 才转换为普通来源；正常 reload 仍撤销旧 generation、停止旧 worker，再编译和激活新代码。

所有权规则：

- 每个已激活的主机安装实例只有一个 daemon 服务进程；设置页挂载和 SDK 会话不能重复创建它。
- 本机功能服务及其原生悬浮窗口属于 Desktop 配置档案，不属于某个主窗口、选定工作区或 agent。
- `desktop` 服务使用应用管理的 worker／bridge 和本机存储，无需已托管 daemon 也能工作。`daemon` 服务使用选定 daemon 管理的子进程与可信插件会话。两者不能关闭对方的归属方。
- UI 扩展属于窗口／文档和激活 generation。关闭一个窗口只释放该窗口租约，不释放其他窗口资源或主机级 QQ 连接。
- 每个回调／RPC／事件校验当前 generation。旧绑定结果、菜单动作和资源加载不能重新激活已禁用或替换的插件。
- 禁用／升级／移除时，先拒绝新操作；完成或明确取消已接受请求，撤销 UI 注册，释放租约／订阅／计时器，停止所属服务。终止过程有界，只影响该服务。
- 重要变更发生时就持久化，不放到退出阶段才做最后一次事务。普通退出不写 `enabled:false`。
- 服务崩溃只使该安装实例失败。对应面板显示局部错误，普通聊天、其他插件和管理器仍可用。提供明确重启操作，不采用无限重启循环。

reload 只作用于选定安装实例及其扩展项。OMP 原生变更需要新 SDK 运行时时，显示**在新建／恢复会话中生效**，保持运行中对话可用。不能为了让管理器开关看似立即生效而重载无关 SDK 会话。

## 能力声明与真实信任边界

capabilities 描述并授权宿主受控接口，不构成可执行 Node 插件的操作系统沙箱。同一 JavaScript 环境中的渲染模块也是可信应用代码，不能仅因 SDK 未提供 CSS setter 就称为隔离。安装此类包需要明确信任授权，不能标注为沙箱化。宿主本身、本机已批准的文件夹代码及配对远端 daemon 提供的任意 bundle 保持各自信任边界。

可列出远端 catalog 元数据而不执行代码。远端主机提供 `clientBundle` 不等于允许向本机渲染进程注入代码；加载前还需本设备对该主机、安装 ID、包 ID 和来源的执行信任。daemon 的执行信任同样绑定安装 ID、清单中的固定包 ID 和来源目录，版本号仅校验用户确认时看到的包。原来源的同一插件升级可复用已批准的能力，新增能力、变更来源或包 ID 需要再次批准；主动撤销不会被升级恢复。

为本次具体功能提供窄范围受控接口：

- 作用域存储与私密 secret 操作。
- 用户选择的文件／目录，以及可撤销的媒体／资源租约。
- 带上下文、序号／generation 的 agent 活动／用量快照与订阅。
- 已授权的工作区／agent 创建、消息提交、取消、权限响应。
- 原生悬浮窗口／显示器／输入／菜单操作及应用导航。
- 根背景槽位和主题可读性策略。
- `agents.configuration` 独立授权 `agent.configuration()` 的完整 agent-owned 创建配置；冷读不恢复运行时，不返回 launch env 或全局模型凭据。只有 `agents.events` 的插件不能读取该配置。
- `agents.events` 下的 `agents.watch()` 持有独立生命周期订阅及释放句柄，不替换普通 directory 订阅。仍存在但没有 project 的 Agent 发 `upsert`、`project:null`；实际删除才发 `remove`，归档保留 Agent 快照。
- `agents.prompt` 下的 `agent.run()` 提交真实 provider turn 并观察完成／失败；`send()` 保留宿主 out-of-band 命令语义。foreground 创建带 prompt 时等待真实回合，取消调用方等待不取消底层 Agent。
- `images.generate` 必须显式声明并批准，且只允许在 active 模式调用。`omp.images.generate({ prompt, images }, { signal })` 在所选主机启用并配置生图后直接生成或编辑图片，不创建 Agent。参考图合计最多 8 MiB，单图及结果最多 4 MiB，仅接受 PNG、JPEG、WebP。主机保管供应商凭据；中止调用、停用插件或断开连接均取消主机请求。
- `agents.tools` 授权安装实例绑定的 Agent 工具注册；`files.scoped` 授权 `files.data-directory` 与 `files.resolve-path` 原生操作，返回所属安装目录及主机解析后的路径。
- `workspace.files` 必须显式声明并批准，仅在 active 模式可用。`omp.workspaceFiles` 以已登记的工作区 ID 定位当前 checkout（`workspace`）或项目根目录（`project`），读取、列出、创建或按文件版本写入相对路径；不允许越出所选目录。原生 `files.scoped` 仍只用于插件私有目录。工作区插件面板可声明 `fileSuffix`，由文件标签在对应工作区内匹配，并将相对路径作为 `filePath` 传入；没有匹配的启用插件时沿用普通文件预览。
- `events.changed` 必须显式声明并批准；插件完成持久化后调用该原生操作，发布现有插件变更通知，客户端订阅刷新业务状态，不引入轮询。

宿主绑定安装实例、角色、进程或 `webContents/mainFrame`、文档 epoch 和激活实例，调用方不能自行选择 owner 字段。明确批准的 Node 代码仍拥有运行用户的系统权限。受控接口能阻止协议内跨所有者操作，但不能让高权限 Node worker 或可信渲染代码变成无害代码。

插件 API 不提供任意 Electron 主进程执行、`executeJavaScript`、导航／preload 覆盖、全局输入 hook 或通用设置 patch。将当前原生实现放到受控接口后复用。悬浮窗口使用 `nodeIntegration:false`、`contextIsolation:true`、严格 CSP 和现有独立 origin 行为。

悬浮窗口 preload 只能绑定本次生成的目标文档；初始空文档不能先占有 lease。目标 URL 是额外资格，不能替代 owner／mainFrame／文档 epoch／activation／installation guard。`onState` 或 PNG 加载成功不能替代真实 bind／`ready` Promise 成功。

设置协议不把 QQ AppSecret／模型凭据作为普通配置返回。secret 通过专用操作提交，读取只返回已配置状态。secret 句柄和签名不能进入日志、agent 上下文、面板状态或其他客户端。宠物资源不能授予能力或引入可执行内容。

## 插件文档入口与宿主边界

具体插件的功能、配置、业务规则、资源处理、迁移和专项验收在 [插件仓库文档](https://github.com/iris-cat-dev/omp-plugins) 中维护；各插件入口见本文的证据索引。

宿主保留通用设置发布、应用启动／退出协调、原生窗口／输入与导航、背景根层、不重建业务树的外观策略、鉴权原生媒体路由和资源生命周期。旧 CLI／WebSocket 业务入口只向启用的 canonical 插件实例转发，不在核心保留第二套业务引擎；插件不可用时明确报告 `plugin_unavailable`。

复用文档 epoch、独立背景／预览修订号、有界预览租约、Range 读取和既有 acquire／release 语义。当前媒体 ID 是共享 bearer capability，不是插件隔离能力；新公开租约必须绑定安装实例／文档／用途，不能把未改变的共享 ID 宣称为安全边界。释放一个窗口不能中断另一窗口已经接受的媒体读取。

### 核心原生 token 速度

核心负责 provider 用量采集、归一化原生请求事实、token／缓存总量、历史、权威回合状态，以及速度计算、格式化和实时／已完成回合页脚。无需安装 Agent Speed 即可显示原生输出速度；可选插件提供独立本地监控，禁用它不移除会话速度、用量、耗时、工具意图或普通生命周期指示。

保留现有源自 Agent Speed v1.5.0 的语义：

- 实时输出使用当前三秒重叠窗口，不按累计 token 计数器的墙钟差分计算。
- 实测与估算分开。生成阶段优先参考十分钟内最多三个自身请求，否则参考三十分钟内最多十个同模型自身请求；保留现有五分钟活动陈旧上限。
- 工具阶段不增加估算分量。无效／缺失样本表示没有速度值，不伪造零吞吐率。
- 原生 output 已包含 reasoning，不能重复加入推理 token，也不能混入子 agent／session 总量。
- 已完成平均速度是有效自身实测 output 除以实测请求时长。无计时、失败／中断请求可计入总量，但不计入实测速度；保留 replay 优先级。
- 保留当前可见且活动时每 500 ms 刷新及现有格式。隐藏／取消／禁用上下文停止刷新，不能覆盖另一个 `(host, agent, turn)`。

指标值和 tooltip 显示来源，估算值不能标为实测。不能新增第二套采集器，也不能在 Desktop 已发布样本时再让 OMP 速度扩展重复采集。

## 切换与状态迁移

当前切换保留通用执行链路，移除具体插件的默认分发链路：

1. **保留共享契约。** SDK、分目标编译器、worker、类型化 RPC、client catalog、原生受控接口与 OMP 原生管理继续可用。
2. **取消固定挂载。** app／main／daemon 不导入或注册具体宠物、壁纸、速度监控或 QQ 插件实现，不自动恢复旧预装来源；核心原生会话速度继续保留。
3. **保留用户数据。** 普通安装继续按真实归属方执行；历史预装记录、旧宠物设置和资源不删除、不转为活动安装。显式同 ID 文件夹重装保留私有配置与数据。
4. **收紧分发。** 清理编译输出，排除具体 `plugin-*` 包、宠物资源、`hatch-pet`、测试夹具与工作区 `.env`；保留基础 SDK/compiler/worker 闭包、原生用量统计和核心会话速度。
5. **验收实际安装包。** 通过真实 UI 输入包外目录、确认信任、安装、启用，再证明 worker、客户端贡献与 RPC；仅检查源码或调用安装 API不能替代这条路径。

迁移归属与不变量：

| 原数据                                | 目标及保留状态                                                                           | 提交／继续条件                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 旧 daemon `plugins`／`pluginsEnabled` | 普通来源保留配置 ID、目录、单项选择、全局开关；`bundled: true` 来源保留为非活动数据 | 不改名、不执行暂停或预装来源、不删除源码目录；同 ID 恢复须显式文件夹重装 |
| OMP 原生存储                          | 现有 SDK／profile／source／scope 存储；管理器只做投影                                    | 不重装、不建第二注册表、不复制凭据、不丢失 `null`／`[]` 的功能选择差异                              |
| 保存的插件 Tab／主题／附件            | 精确 plugin／panel／context／agent／theme 引用和已提交快照                               | 代码缺失表示不可用，不能据此丢弃布局、选择或内容                                                    |
| 原生速度／用量 | 核心原生用量事实、会话速度、历史和耗时继续保留；可选监控另行安装 | 不默认挂载具体插件、不改变 token／历史／耗时事实 |

旧功能恢复输入不再自动迁移成启用选择。当前执行只由真实安装、信任和启用状态决定。普通移除保留配置但停止执行，不因重装自动恢复此前移除的选择。插件自有数据的迁移条件见对应插件文档。

可选插件若提供数据导入，需校验来源并明确报告失败；保留旧恢复输入，不以空库或默认数据替换损坏数据。宿主不保留具体插件的读取、迁移或双写链路。

## 完整系统验收

以下保留通用宿主验收。具体插件及其资源不属于默认发行，专项要求、历史验证结果与暂停范围见各插件文档。

| 范围             | 必须覆盖的场景与结果                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 统一管理器       | 一个插件入口访问 Desktop／daemon／OMP 原生安装项；归属／来源／scope／版本／状态精确；历史预装项隐藏且不执行；禁用时可配置；远端离线时本机控制可用 |
| 旧源码兼容       | 旧 local-plugin 服务／counter 页面／工作区面板／命令中心流程、Linear 类附件源、Catppuccin 类主题通过恢复的契约注册、运行、清理，不虚构旧 API                                                                                                                             |
| 旧身份／全局开关 | 同目录以两个 ID 安装保持独立；manifest 改名不改安装 ID；全局暂停来源在发现或重启时不执行；暂停／恢复保留单项选择                                                                                                                                                         |
| 原生兼容         | CLI 与 Desktop 对身份、市场、profile、cwd、scope、有效／遮蔽状态、feature null／[]、settings 的理解一致；链接来源不显示虚假升级；provider／tool／command／hook 和受支持登录流程真实可用                                                                                  |
| UI 扩展生命周期  | 菜单打开正确主机／上下文面板；reload 卸载旧实例、拒绝旧 RPC；不可用 Tab 保留布局／状态，重启用后可解析；旧 catalog／菜单不能调用替换后的 generation                                                                                                                      |
| 主题／附件       | 同 ID 主题保留选择主机和引用；连接／断连不意外重绘；提供者缺失保留选择；已提交外部文本附件在移除来源后仍可读                                                                                                                                                             |
| 服务生命周期     | 两个窗口、多个 SDK 会话下仍每安装实例一个网关；静态检查不创建服务；禁用／reload／崩溃／移除只释放所属进程／socket／计时器／会话；应用正常退出保留 enabled                                                                                                                |
| 本机数据归属 | 远端连接／项目切换／手机配对不传输本机插件资源、路径、选择或播放授权；远端 bundle 需本机信任；错误 frame／epoch／activation／installation 的调用被拒绝 |
| 核心速度 | 无插件仍显示原生速度；精确实时重叠窗口、参考选择、生成／工具／陈旧状态、缺失数据不显示值、reasoning 归属、turn／session／child 区分、完成实测平均值、replay 优先级；隐藏／取消停止刷新但保留总量／历史／耗时／工具意图 |
| 失败／数据迁移   | 各提交边界中断后无重复重试；新用户编辑优先；写入失败保留旧数据和真实错误；无隐式回退、虚假 ready 或自动启用；切换后仅一个权威写入方                                                                                                                                      |
| 分发产物         | 验证真实 macOS／Windows／Linux 打包运行时并记录支持项；已知 mini-electron 输入穿透／媒体限制在验证前仍为特定版本失败，不能通过改文件名、猜版本或 mock bridge 宣称修复                                                                                                    |

历史兼容覆盖有文档依据的源码契约，不涵盖任意内部导入、未核实新版 Paseo API 或自动转换 Bun／TUI 专用 OMP 包。导入检查明确指出无法映射的 API、服务挂载和历史事件格式；完成真实源码／数据迁移后才能标记兼容。DSH preset 与 QQ 历史导入的具体限制见 [QQ 迁移约束](https://github.com/iris-cat-dev/omp-plugins/blob/main/qqbot/docs/qualification.md#integration-and-migration)。

## 仓库集成边界

- 恢复历史 `packages/plugin` SDK 的角色，作为统一插件包，不为各功能另建 SDK。接入适配器解析旧模块名，共享扩展／包描述 DTO 放入 `packages/protocol`。
- 恢复 `packages/server/src/server/plugins` 服务路径，接通当前 bootstrap／session／catalog 接口。补齐插件所需受支持 `packages/client` 门面和原生管理 RPC。
- 恢复 `packages/app/src/plugins` 的 catalog／registry／load／context 及 `plugin` 面板 bridge，复用设置路由、命令中心、分栏布局、附件和外观语义构建器。
- `packages/desktop` 拥有通用本机 worker／受控接口生命周期；app／main 入口不硬编码具体宠物、壁纸或速度监控插件挂载。
- 原生 SDK 插件发现、模型执行、工具、审批、AuthStorage、指标事实采集保留在当前归属方。管理器是投影／适配层，不替换 harness。
- Desktop 和远端 backend 分发保留源码编译支持及基础执行入口，不包含具体插件代码／资源、`hatch-pet` 或宠物安装命令。原生用量统计和核心会话速度保留。原生 API 依赖按目标／ABI 验收，不能从开发 Node 环境推断。
- 功能插件与源码示例位于根目录 `plugins/` 子模块，对应 [iris-cat-dev/omp-plugins](https://github.com/iris-cat-dev/omp-plugins)；当前包列表与文档入口见该仓库，各插件包直接位于仓库根目录，历史源码示例位于 `examples/`。共享插件 SDK 与编译器继续由 Desktop 的 `packages/plugin` 提供。

由一个集成负责人统一负责注册表、激活状态、RPC 授权和 schema 切换。各功能负责人基于确定的契约迁移独立包，不能各自引入管理器、全局事件总线、设置存储或 daemon 连接。

## 证据与当前验证范围

当前实现与验收使用的入口：

- [daemon 运行时接口与分发](../packages/server/src/server/session.ts)、[bootstrap 插件注入](../packages/server/src/server/bootstrap.ts)、[Desktop／原生插件协议](../packages/protocol/src/messages.ts)。
- [插件 Tab 类型](../packages/app/src/workspace-tabs/model.ts)、[面板注册表](../packages/app/src/panels/panel-registry.ts)、[内置注册](../packages/app/src/panels/register-panels.ts)、[命令中心注册表](../packages/app/src/command-center/registry.ts)、[设置路由](../packages/app/src/utils/host-routes.ts)。
- [OMP 原生管理语义](features/tools-and-plugins.md)、[原生管理适配器](../packages/server/src/server/omp-plugin-cli-service.ts)、[现有迁移指南](omp-desktop-plugin-migration.md)。
- [宠物插件文档](https://github.com/iris-cat-dev/omp-plugins/blob/main/desktop-pet/README.md)与[专项验收](https://github.com/iris-cat-dev/omp-plugins/blob/main/desktop-pet/docs/qualification.md)。
- [壁纸插件文档](https://github.com/iris-cat-dev/omp-plugins/blob/main/wallpaper/README.md)与[专项验收](https://github.com/iris-cat-dev/omp-plugins/blob/main/wallpaper/docs/qualification.md)；不随默认发行分发。
- [核心原生速度算法](../packages/app/src/agent-stream/token-output-speed.ts)、[会话速度页脚](../packages/app/src/agent-stream/turn-output-speed.tsx)、[turn-token-stats](../packages/app/src/agent-stream/turn-token-stats.ts)；独立本地监控见 [Agent Speed 文档](https://github.com/iris-cat-dev/omp-plugins/blob/main/agent-speed/README.md)。
- [QQ 插件文档](https://github.com/iris-cat-dev/omp-plugins/blob/main/qqbot/README.md)与[迁移及历史验收](https://github.com/iris-cat-dev/omp-plugins/blob/main/qqbot/docs/qualification.md)。
- [计划任务插件文档](https://github.com/iris-cat-dev/omp-plugins/blob/main/schedules/README.md)；默认应用不携带或启动该插件。

历史 [插件 SDK 契约](https://github.com/getpaseo/paseo/blob/4092c2926500d51af6510bbe295591af0dfe52f7/packages/plugin/src/contracts.ts)、[服务运行时](https://github.com/getpaseo/paseo/blob/4092c2926500d51af6510bbe295591af0dfe52f7/packages/server/src/server/plugins/runtime.ts)、[插件面板](https://github.com/getpaseo/paseo/blob/4092c2926500d51af6510bbe295591af0dfe52f7/packages/app/src/plugins/workspace-panels/panel.tsx)构成旧契约基线，不能据此认定文件是在最近一次合并时被删除。

当前 macOS arm64 本地签名包已通过完整原生验收：旧启用预装记录不展示、不执行，真实设置 UI 从包外文件夹安装并确认信任，显式启用后 worker 写入文件，客户端贡献实际 RPC 返回安装 ID、generation 与调用计数。独立 daemon CLI 同 ID 重装保留原存储，真实 counter RPC 从 10 增加到 13、重载后到 15，并保留其他配置。实际 App 与四目标远端清单保留基础 SDK，不携带具体插件包。该结果不扩展文末可选插件的历史专项验收范围。

设计阶段在隔离 Node／tsx 进程中调用了当前速度函数：使用 7,000 到 10,000 ms 的已完成请求、120 个 output token，再加一个在途请求。

| 观察场景                 | 实测 t/s | 估算 t/s | 显示 t/s |
| ------------------------ | -------- | -------- | -------- |
| 10,000 ms 时             | 40       | 0        | 40       |
| 11,500 ms 时处于生成阶段 | 20       | 20       | 40       |
| 11,500 ms 时处于工具阶段 | 20       | 0        | 20       |
| 缺少原生事实             | 0        | 0        | 不显示   |

一个完成回合包含 10 个 input token、150 个总 output token，但只有 120 个实测 output token／3,000 ms，结果为**总计 160 token，实测速度 40 t/s**。另外 30 个 output token 未用于抬高实测吞吐率。

实现后的真实 GUI 已通过菜单／命令的主机与 workspace／agent 上下文、不可用 Tab 的布局与状态恢复、同 ID 主题的主机引用及输入 DOM／焦点／选区／草稿／滚动保持。新 idle SDK 会话在发送前已有原生 header；实际提交的 local-only command annotation 在服务重启、v7 replica 冷恢复和来源禁用后仍保留完整附件卡片、全文与 metadata。AOT transformed discriminator、canonical 附件传递和旧损失 cache 的迁移均有消费者回归。

原生 owning frame／navigation identity、严格 Range 和跨窗口媒体 lease 隔离已由 mini-electron 真实 GUI 验证。宠物输入、任务导航和壁纸媒体的专项历史结果见对应插件验收文档。

原生 IPC 恢复标准 EventEmitter listener 身份后，真实 `removeListener`／`once`、frame 授权、导航 detach 和定向投递回归通过。Overlay 关闭失败及资源释放的历史验收见 [宠物资格记录](https://github.com/iris-cat-dev/omp-plugins/blob/main/desktop-pet/docs/qualification.md#历史原生输入与任务导航证据)。

本轮证据根目录为 `/tmp/omp-unified-plugin-smoke-2s3uFs`。此前完成 Native 验收的分发产物为 `package-output-qualified/mac-arm64/OMP Desktop.app`，使用 mini-electron 0.1.38 与当前源码 SDK 18.14.0 desktop/core；未签名、公证或发布。checkout 外消费者已验证旧 compiler／worker、SDK Native 读写与旧 prepare／manage 入口。QQ CJS／MJS 与 codec、宠物 helper／资源安装闭包和严格 NodeMode 结果分别保留在所属插件的历史验收中。

完整系统验收仍未完成，通用宿主验收条件全部保留。官方配置的 `sdk-v18.14.0-desktop-core.1` 已经真实 RPC 返回 `Unknown command: append_session_annotation`；本地新产物已证明 durable ack、原生 header／全文落盘及 cold resume 无模型 messages，四目标 remote-backend 构建成功不能替代新 SDK 发布。发布负责人需发布匹配合同、更新实际 release 配置，再验收下载后的远端闭包。Windows／Linux 专项验收仍暂停；Native 当前仅枚举主屏。模型创作、真实 QQ、人工文件对话框／壁纸选图、负坐标外接屏与严格外层解释器策略 Native 转换的历史暂停／EPERM 环境阻塞，保留在各插件的验收文档中。
