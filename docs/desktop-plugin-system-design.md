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
| `surface` 和 `sidebar.item` | 旧全局页面、图标、导航 ID                                                            | 现有页面／页头、选定主机绑定、不可用状态、主机选择记忆               |
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

客户端通过公开的 `ctx.hosts.list()/subscribe()/get(id)` 访问同一 daemon 插件的跨主机目录。`list()` 返回主机 ID、显示名与在线状态，并保留已见离线主机；`get()` 仅返回已在线、客户端已获本机信任、package ID 与 installation ID 都匹配的 active 实例，提供 `omp`、类型化 `rpc` 与变更 `subscribe`。调用同时受发起端和目标端能力授权约束，远端 grant 不能提升发起端权限；断连、撤销或 generation 替换使旧结果／回调失效。management 模式不能取得运行型连接。

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

可列出远端 catalog 元数据而不执行代码。远端主机提供 `clientBundle` 不等于允许向本机渲染进程注入代码。加载前暂存／校验精确插件包并取得本机执行信任，保留原生运行时的安装控制。升级信任覆盖具体来源／版本；新增能力请求需要批准。

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
- `agents.tools` 授权安装实例绑定的 Agent 工具注册；`files.scoped` 授权 `files.data-directory` 与 `files.resolve-path` 原生操作，返回所属安装目录及主机解析后的路径。
- `events.changed` 必须显式声明并批准；插件完成持久化后调用该原生操作，发布现有插件变更通知，客户端订阅刷新业务状态，不引入轮询。

宿主绑定安装实例、角色、进程或 `webContents/mainFrame`、文档 epoch 和激活实例，调用方不能自行选择 owner 字段。明确批准的 Node 代码仍拥有运行用户的系统权限。受控接口能阻止协议内跨所有者操作，但不能让高权限 Node worker 或可信渲染代码变成无害代码。

插件 API 不提供任意 Electron 主进程执行、`executeJavaScript`、导航／preload 覆盖、全局输入 hook 或通用设置 patch。将当前原生实现放到受控接口后复用。悬浮窗口使用 `nodeIntegration:false`、`contextIsolation:true`、严格 CSP 和现有独立 origin 行为。

悬浮窗口 preload 只能绑定本次生成的目标文档；初始空文档不能先占有 lease。目标 URL 是额外资格，不能替代 owner／mainFrame／文档 epoch／activation／installation guard。`onState` 或 PNG 加载成功不能替代真实 bind／`ready` Promise 成功。

设置协议不把 QQ AppSecret／模型凭据作为普通配置返回。secret 通过专用操作提交，读取只返回已配置状态。secret 句柄和签名不能进入日志、agent 上下文、面板状态或其他客户端。宠物资源不能授予能力或引入可执行内容。

## 功能边界：迁移实际行为，不只迁移开关

### 计划任务

`plugins/schedules` 是可选 daemon 插件，独立拥有侧栏／命令中心入口、管理页、cron／every 调度、心跳、持久化、运行记录与十一项 Agent 工具。核心不再启动调度引擎或注册计划任务工具；CLI 与旧 WebSocket 入口仅通过薄适配器转发启用的 canonical 安装实例，不保留第二套实现。未安装、未授权或禁用时明确返回 `plugin_unavailable`。

保留新建 Agent 和既有 Agent 心跳、项目选择、local／worktree、provider／model／mode／thinking、自动归档、最大次数、过期、错误与日志。页面通过公共主机目录聚合同 package／installation 的多主机任务，所有动作保留实际所属主机。心跳观察真实 Agent 生命周期，包括暂停期间的归档／删除；暂时缺少 project 不代表目标已删除。

只有安装 ID `schedules` 一次性接管 `<daemon home>/schedules` 的旧记录：持久化导入 marker、保留原文件，不覆盖插件已有记录；其他 ID 保持独立存储。任务 ID、历史与暂停状态保留。禁用插件／暂停主机执行停止未来触发，保留数据；重新启用从当前时间计算下一次，不补跑错过的触发。正在执行的普通 Agent 不因插件停止被终止。

### 桌面宠物

将宠物库／schema、动画与气泡规则、任务到宠物状态的投影、设置和创作流程移入 `desktop-pet`。通用设置发布、应用启动／退出协调、原生窗口／输入、媒体／图像转换和导航保留在宿主受控接口中。

提取前必须解除一处具体耦合：`pets/controller.ts` 当前广播所有 Desktop 设置变更。该广播需移到共享设置服务，避免禁用宠物后其他设置停止更新。

保留多个主窗口共享一个不抢焦点的宠物、透明像素输入穿透、显示器边界内拖动、真实任务／主机身份、活动新鲜度、语言／字体更新、减少动态效果、原有 Iris 行为及每个资源的气泡。运行时动画／对白不调用模型。等待现有 startup-ready 条件；离线和启动错误页面也可满足就绪，且就绪前禁用不能闪现宠物窗口。

`pet.json` 继续只包含已校验数据和 PNG 资源。保留 20 MiB／4096×4096 限制、图集校验、五个必需动画状态、旧资源可选气泡，以及新图像创作必须完整提供气泡的更强约束。导入不执行额外文件、不覆盖已有资源、不自动选择或启用新宠物。

**使用 OMP 创建（Create with OMP）**仍建立独立本机创作工作区和普通 OMP 会话，使用用户独立选择的创作模型／Thinking／mode／features。`hatch-pet` 属于插件的 `assets/skills/hatch-pet/`，随插件分发，只复制到创作工作区的 `.omp/skills/hatch-pet/`，不加入 Desktop 的全局技能目录。新工作区的 helper 使用 bundled Electron 的 Node 模式直接运行插件的 `dist/cjs/install-pet.js`；转换／安装实现和 `sharp` 运行依赖由插件提供，不恢复已移除的 Desktop `--desktop-pet-install` 命令，也不启动 GUI／daemon 或参与升级退出清理。现有工作区保留复制的技能与旧脚本，使用新 helper 需要新建创作工作区；禁用／移除插件不删除普通创作会话，运行 helper 时需保留插件及其运行依赖。

### 壁纸

将候选库业务、文件／URL 选择、配置与重试 UI 移入 `wallpaper`。背景根层、不重建业务树的外观策略、鉴权原生媒体路由和资源生命周期机制保留在宿主中。

插件发布背景意图；每个窗口只有在当前图片／视频真正就绪后才变透明。保留媒体 alpha 为 `p`、普通面板 alpha 为 `1-p`、就绪后基础画布才全透明，以及菜单／对话框／模型列表不透明。背景／透明度变更不能重建对话，或丢失输入焦点、选区、草稿、滚动位置。关闭壁纸恢复此前装饰动画偏好。

保留候选 ID／顺序以及“添加不应用”的行为；原文件留在原位置，删除候选不删除文件。HTTP(S) URL 背景仍属于客户端本地，保留按 pathname 判断视频、query 和 fragment。文件背景使用持久授权资源引用；播放 URL／句柄短期存在，不能持久化。

复用文档 epoch、独立背景／预览修订号、有界预览租约、Range 读取和既有 acquire／release 语义。当前媒体 ID 是共享 bearer capability，不是插件隔离能力；新公开租约必须绑定安装实例／文档／用途，不能把未改变的共享 ID 宣称为安全边界。释放一个窗口不能中断另一窗口已经接受的媒体读取。

### token 速度监控

`agent-speed` 负责速度计算、格式化、实时／已完成回合页脚扩展。provider 用量采集、归一化原生请求事实、token／缓存总量、历史和权威回合状态留在核心。禁用插件只移除速度控件／刷新计时器，不移除用量数据、耗时、工具意图或普通生命周期指示。

保留现有源自 Agent Speed v1.5.0 的语义：

- 实时输出使用当前三秒重叠窗口，不按累计 token 计数器的墙钟差分计算。
- 实测与估算分开。生成阶段优先参考十分钟内最多三个自身请求，否则参考三十分钟内最多十个同模型自身请求；保留现有五分钟活动陈旧上限。
- 工具阶段不增加估算分量。无效／缺失样本表示没有速度值，不伪造零吞吐率。
- 原生 output 已包含 reasoning，不能重复加入推理 token，也不能混入子 agent／session 总量。
- 已完成平均速度是有效自身实测 output 除以实测请求时长。无计时、失败／中断请求可计入总量，但不计入实测速度；保留 replay 优先级。
- 保留当前可见且活动时每 500 ms 刷新及现有格式。隐藏／取消／禁用上下文停止刷新，不能覆盖另一个 `(host, agent, turn)`。

指标值和 tooltip 显示来源，估算值不能标为实测。不能新增第二套采集器，也不能在 Desktop 已发布样本时再让 OMP 速度扩展重复采集。

### QQ 连接

`qqbot` 负责一个 daemon 级网关、QQ connector／绑定状态、账号／身份访问、peer 队列、QQ 事件格式化／媒体投递，以及持久的 peer 到 Desktop agent 映射。客户端入口提供完整配置／绑定页、设置页操作按钮和插件面板。可选 OMP hooks／工具提供 QQ prompt 上下文与文件投递，复用已有网关，不再创建连接。

复用当前 QQ SDK 和协议模块。用 Desktop 公开服务 bridge 与 OMP 原生工具／hooks 替换 DSH `ctx.agents`、`session/event`、system-prompt sections、审批／问答、模型发现及 Cordis 持久化。为需要的控制补齐受支持客户端 API，不长期依赖 `internal/*`。

通过 Desktop 管理器创建／恢复 agent，确保会话可见、可恢复。保留私聊／群聊隔离、@ 门控、按发送者校验命令权限、有界同 peer 处理、C2C 流式、群聊分块、被动回复限额、附件路径约束、问答／审批关联及已配置外部回合投递。“快照 + 订阅”观察 Desktop 续聊和原生服务回合，不只观察 QQ 客户端发起的回合。

同 peer 队列在匹配回合完成或失败后立即释放。timeline 序号只在同一 `epoch` 内可比较；agent idle 卸载／恢复或历史重建后，路由重置序号与文本／工具修订缓存。已提交 QQ 输入按 `clientMessageId` 认领，即使新序号低于旧水位，也不能作为历史重放跳过。静态回复投递失败保留原始错误并使该输入失败，不阻塞下一条群消息。`lastDeliveredSequence` 是已处理 timeline 水位，不是腾讯投递确认；发送失败不会删除 Desktop 已生成的回复，也不自动重试。

保留 `/preset` 作为 QQ 插件命令，使用 `qqbot` 管理的具名、经 schema 校验的 agent 配置模板。模板包含受支持的 Desktop agent 创建设置与 QQ prompt／skill／tool 选择，切换只作用于下一次 `/new` 或 reset，不重建运行中对话。它不是权限模式别名。只有 DSH preset 设置和 Cordis 服务挂载已有等价原生实现时才导入，无法映射的服务需明确报告，不能静默丢弃。

secret 和绑定轮询留在 daemon。缺少凭据是非阻塞等待状态。插件页面保留真实的绑定、刷新、手动替换／解绑、三类访问名单、配对／撤销／导出、access-revision 冲突处理。QQ 文本不能通过转发未知斜杠命令调用任意宿主插件管理操作。

账号入口为 Settings → Plugins → 对应 daemon 的 QQ 连接 → 权限授权 → 配置。“重启 QQ 连接”等应用级操作直接显示在所选安装实例的设置页，不在侧栏增加拼图菜单。运行侧栏和设置页操作要求“允许主机插件运行”与 QQ 单项开关同时开启；未绑定账号显示等待原因，仍可进入“QQ 连接”绑定页。暂停全局执行保留单项启用选择与账号配置，撤销运行型入口。

peer 映射以 Bot AppID、scope、peer OpenID 为键，指向真实 host／workspace／agent ID。不能把 DSH session 标识复用为 OMP 标识，也不能把 DSH 事件日志当作原生 OMP 历史。导入账号／偏好时保留旧 DSH 数据；转换历史对话需要独立校验过的 importer。

禁用撤销网关路由、socket／计时器／订阅和旧按钮权限，不删除 Desktop agent、不自动批准／拒绝待处理原生请求、不停止无关对话。原生问题继续通过宿主正常 UI 可见。重新启用按持久映射和当前请求身份连接，旧卡片不能批准新激活实例的请求。

## 切换与状态迁移

当前切换保留通用执行链路，移除具体插件的默认分发链路：

1. **保留共享契约。** SDK、分目标编译器、worker、类型化 RPC、client catalog、原生受控接口与 OMP 原生管理继续可用。
2. **取消固定挂载。** app／main／daemon 不导入或注册宠物、壁纸、速度、QQ 实现，不自动恢复旧预装来源。
3. **保留用户数据。** 普通安装继续按真实归属方执行；历史预装记录、旧宠物设置和资源不删除、不转为活动安装。显式同 ID 文件夹重装保留私有配置与数据。
4. **收紧分发。** 清理编译输出，排除具体 `plugin-*` 包、宠物资源、`hatch-pet`、测试夹具与工作区 `.env`；保留基础 SDK/compiler/worker 闭包和独立核心监控。
5. **验收实际安装包。** 通过真实 UI 输入包外目录、确认信任、安装、启用，再证明 worker、客户端贡献与 RPC；仅检查源码或调用安装 API不能替代这条路径。

迁移归属与不变量：

| 原数据                                | 目标及保留状态                                                                           | 提交／继续条件                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 旧 daemon `plugins`／`pluginsEnabled` | 普通来源保留配置 ID、目录、单项选择、全局开关；`bundled: true` 来源保留为非活动数据 | 不改名、不执行暂停或预装来源、不删除源码目录；同 ID 恢复须显式文件夹重装 |
| OMP 原生存储                          | 现有 SDK／profile／source／scope 存储；管理器只做投影                                    | 不重装、不建第二注册表、不复制凭据、不丢失 `null`／`[]` 的功能选择差异                              |
| 保存的插件 Tab／主题／附件            | 精确 plugin／panel／context／agent／theme 引用和已提交快照                               | 代码缺失表示不可用，不能据此丢弃布局、选择或内容                                                    |
| 宠物设置                              | 旧 `settings.pet` 与插件私有配置原样保留，不驱动安装或执行 | 同 ID 文件夹重装保留记录配置和 generation；本机安装默认禁用 |
| 宠物资源／工作区根目录                | 原资源、ID 与普通创作 agent 保留；默认发行不携带宠物资源或技能 | 插件自行提供技能与转换／安装工具，不删除用户资源或工作区 |
| 壁纸设置／候选库                      | 原配置、候选 ID、revision 和导入标记保留，不自动挂载背景 | 显式安装、授权与启用；删除记录仍不删除源文件 |
| 壁纸多窗口持久化                      | 已安装插件的提交以本机主进程／配置档案为权威来源 | 带 revision 的字段补丁；预览仅本窗口，提交广播 |
| 速度显示                              | 由显式安装的速度插件提供；核心原生用量事实和独立监控保留 | 不默认挂载插件、不改变 token／历史／耗时事实 |
| DSH QQ 凭据／访问／偏好               | 主机作用域 `qqbot` 设置／secret／身份数据和新的 Desktop agent 映射                       | 仅在显式选择来源后导入，保留旧数据；校验 access revision、不暴露 AppSecret、不重新解释 DSH 事件日志 |

旧 `wallpaperEnabled`、`pet.enabled` 等恢复输入不再自动迁移成启用选择。当前执行只由真实安装、信任和启用状态决定；背景选择和媒体就绪仍是独立条件。普通移除保留配置但停止执行，不因重装自动恢复此前移除的选择。

可选插件若提供数据导入，需校验来源并明确报告失败；保留旧恢复输入，不以空库或默认 Iris 替换损坏数据。宿主不保留具体插件的读取、迁移或双写链路。

## 完整系统验收

以下包括通用宿主验收和可选功能插件的专项要求。具体插件及其资源不属于默认发行；历史专项验证结果与暂停范围见文末。

| 范围             | 必须覆盖的场景与结果                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 统一管理器       | 一个插件入口访问 Desktop／daemon／OMP 原生安装项；归属／来源／scope／版本／状态精确；历史预装项隐藏且不执行；禁用时可配置；远端离线时本机控制可用 |
| 旧源码兼容       | 旧 local-plugin 服务／counter 页面／工作区面板／命令中心流程、Linear 类附件源、Catppuccin 类主题通过恢复的契约注册、运行、清理，不虚构旧 API                                                                                                                             |
| 旧身份／全局开关 | 同目录以两个 ID 安装保持独立；manifest 改名不改安装 ID；全局暂停来源在发现或重启时不执行；暂停／恢复保留单项选择                                                                                                                                                         |
| 原生兼容         | CLI 与 Desktop 对身份、市场、profile、cwd、scope、有效／遮蔽状态、feature null／[]、settings 的理解一致；链接来源不显示虚假升级；provider／tool／command／hook 和受支持登录流程真实可用                                                                                  |
| UI 扩展生命周期  | 菜单打开正确主机／上下文面板；reload 卸载旧实例、拒绝旧 RPC；不可用 Tab 保留布局／状态，重启用后可解析；旧 catalog／菜单不能调用替换后的 generation                                                                                                                      |
| 主题／附件       | 同 ID 主题保留选择主机和引用；连接／断连不意外重绘；提供者缺失保留选择；已提交外部文本附件在移除来源后仍可读                                                                                                                                                             |
| 服务生命周期     | 两个窗口、多个 SDK 会话下仍每安装实例一个网关；静态检查不创建服务；禁用／reload／崩溃／移除只释放所属进程／socket／计时器／会话；应用正常退出保留 enabled                                                                                                                |
| 宠物             | startup-ready／无闪现、默认和旧设置、真实像素穿透、4 px 拖动阈值、不抢焦点、三档尺寸、DPI／zoom／多显示器／负坐标、真实最高优先任务导航、多主机活动新鲜度均保持                                                                                                          |
| 宠物资源／创作   | PNG／manifest／图集严格限额、旧无气泡兼容和新创作完整气泡；资源不执行代码；独立本机创作不改变模型／默认设置边界；旧 shell／helper／安装入口不依赖全局 Node／Python；转换器退出不停止真实 daemon                                                                          |
| 壁纸             | file／URL／off／none／null、透明度 0／0.85／1 保持；添加不应用／复制，删除不删原文件，同路径重新添加不复活旧候选；当前媒体真正加载后才透明                                                                                                                               |
| 壁纸竞争／可读性 | A→B→A／重试／迟到回调、Range、文档租约、预览上限保持；一个窗口释放／失败不影响另一个；菜单／对话框／模型控件不透明；主题／背景变化保留输入身份、焦点、选区、草稿、滚动                                                                                                   |
| 本机数据归属     | 远端连接／项目切换／手机配对不传输宠物／壁纸资源、路径、选择或播放授权；远端 bundle 需本机信任；错误 frame／epoch／activation／installation 的调用被拒绝                                                                                                                 |
| 速度             | 精确实时重叠窗口、参考选择、生成／工具／陈旧状态、缺失数据不显示值、reasoning 归属、turn／session／child 区分、完成实测平均值、replay 优先级；禁用／隐藏／取消停止刷新但保留总量／历史／耗时／工具意图                                                                   |
| QQ               | 扫码／刷新／手动绑定／更换／解绑，私聊／群／命令访问、配对／撤销／导出／冲突；peer agent 在 Desktop 可见；@ 门控、stop／new／compact／model、下一次 new／reset 生效的具名 preset；有界队列／超时、C2C 流／群分块／回复限额、图片／视频／文件／视觉路径和当前授权文件目标 |
| QQ 交互／投递    | 分组 ask 的 ID／顺序／多选／自定义答案，审批 nonce／点击者授权／取消／过期卡片；Desktop 续聊、配置的服务／外部回合投递；禁用不删除 agent 或自动解决原生权限；重启用不重复连接或重复过期输出                                                                              |
| 失败／数据迁移   | 各提交边界中断后无重复重试；新用户编辑优先；写入失败保留旧数据和真实错误；无隐式回退、虚假 ready 或自动启用；切换后仅一个权威写入方                                                                                                                                      |
| 分发产物         | 验证真实 macOS／Windows／Linux 打包运行时并记录支持项；已知 mini-electron 输入穿透／媒体限制在验证前仍为特定版本失败，不能通过改文件名、猜版本或 mock bridge 宣称修复                                                                                                    |

历史兼容覆盖有文档依据的源码契约，不涵盖任意内部导入、未核实新版 Paseo API 或自动转换 Bun／TUI 专用 OMP 包。导入检查明确指出无法映射的 API、DSH 专用 preset 服务挂载和历史事件格式；完成真实源码／数据迁移后才能标记兼容。

## 仓库集成边界

- 恢复历史 `packages/plugin` SDK 的角色，作为统一插件包，不为各功能另建 SDK。接入适配器解析旧模块名，共享扩展／包描述 DTO 放入 `packages/protocol`。
- 恢复 `packages/server/src/server/plugins` 服务路径，接通当前 bootstrap／session／catalog 接口。补齐插件所需受支持 `packages/client` 门面和原生管理 RPC。
- 恢复 `packages/app/src/plugins` 的 catalog／registry／load／context 及 `plugin` 面板 bridge，复用设置路由、命令中心、分栏布局、附件和外观语义构建器。
- `packages/desktop` 拥有通用本机 worker／受控接口生命周期；app／main 入口不硬编码宠物、壁纸或速度挂载。
- 原生 SDK 插件发现、模型执行、工具、审批、AuthStorage、指标事实采集保留在当前归属方。管理器是投影／适配层，不替换 harness。
- Desktop 和远端 backend 分发保留源码编译支持及基础执行入口，不包含具体插件代码／资源、`hatch-pet` 或宠物安装命令。独立核心监控保留。原生 API 依赖按目标／ABI 验收，不能从开发 Node 环境推断。
- 功能插件与源码示例位于根目录 `plugins/` 子模块，对应 [iris-cat-dev/omp-plugins](https://github.com/iris-cat-dev/omp-plugins)；五个插件包直接位于该仓库根目录，历史源码示例位于 `examples/`。共享插件 SDK 与编译器继续由 Desktop 的 `packages/plugin` 提供。

由一个集成负责人统一负责注册表、激活状态、RPC 授权和 schema 切换。各功能负责人基于确定的契约迁移独立包，不能各自引入管理器、全局事件总线、设置存储或 daemon 连接。

## 证据与当前验证范围

当前实现与验收使用的入口：

- [daemon 运行时接口与分发](../packages/server/src/server/session.ts)、[bootstrap 插件注入](../packages/server/src/server/bootstrap.ts)、[Desktop／原生插件协议](../packages/protocol/src/messages.ts)。
- [插件 Tab 类型](../packages/app/src/workspace-tabs/model.ts)、[面板注册表](../packages/app/src/panels/panel-registry.ts)、[内置注册](../packages/app/src/panels/register-panels.ts)、[命令中心注册表](../packages/app/src/command-center/registry.ts)、[设置路由](../packages/app/src/utils/host-routes.ts)。
- [OMP 原生管理语义](features/tools-and-plugins.md)、[原生管理适配器](../packages/server/src/server/omp-plugin-cli-service.ts)、[现有迁移指南](omp-desktop-plugin-migration.md)。
- [宠物插件](../plugins/desktop-pet)、[本机创作工作区](../plugins/desktop-pet/src/creation-workspace.ts)、[资源 manifest](../plugins/desktop-pet/src/manifest.ts)、[宠物使用指南](features/desktop-pet.md)。
- [壁纸插件源码](../plugins/wallpaper/src/builtin.ts)、[客户端](../plugins/wallpaper/src/client.tsx)、[背景控制器](../plugins/wallpaper/src/controller.ts)、[壁纸使用指南](features/appearance.md#wallpaper)；不随默认发行分发。
- [速度插件](../plugins/agent-speed/src/index.tsx)、[实时算法](../plugins/agent-speed/src/metrics.ts)、[刷新订阅](../plugins/agent-speed/src/use-output-rate.ts)、[完成值](../plugins/agent-speed/src/completed.ts)、[turn-token-stats](../packages/app/src/agent-stream/turn-token-stats.ts)；默认应用不挂载该插件。
- [QQ 插件](../plugins/qqbot)包含独立网关、会话与事件适配、访问／配对、问答／审批和文件工具；当前 producer 将有效 QQ SDK 内联到 CJS／MJS 服务产物。
- [计划任务插件](../plugins/schedules)、[引擎](../plugins/schedules/engine.ts)、[迁移器](../plugins/schedules/importer.ts)、[管理页](../plugins/schedules/ui/page.tsx)、[使用指南](features/conversations.md#schedules)；默认应用不携带或启动该插件。

历史 [插件 SDK 契约](https://github.com/getpaseo/paseo/blob/4092c2926500d51af6510bbe295591af0dfe52f7/packages/plugin/src/contracts.ts)、[服务运行时](https://github.com/getpaseo/paseo/blob/4092c2926500d51af6510bbe295591af0dfe52f7/packages/server/src/server/plugins/runtime.ts)、[插件面板](https://github.com/getpaseo/paseo/blob/4092c2926500d51af6510bbe295591af0dfe52f7/packages/app/src/plugins/workspace-panels/panel.tsx)构成旧契约基线，不能据此认定文件是在最近一次合并时被删除。Agent Speed 是从独立原生应用移植的算法／功能，尚未证实存在对应历史 Paseo 插件包。

当前 macOS arm64 本地签名包已通过完整原生验收：旧启用预装记录不展示、不执行，真实设置 UI 从包外文件夹安装并确认信任，显式启用后 worker 写入文件，客户端贡献实际 RPC 返回安装 ID、generation 与调用计数。独立 daemon CLI 同 ID 重装保留原存储，真实 counter RPC 从 10 增加到 13、重载后到 15，并保留其他配置。实际 App 与四目标远端清单保留基础 SDK，不携带具体插件包。该结果不扩展文末可选插件的历史专项验收范围。

计划任务迁移已在两台隔离测试 daemon 与真实插件 worker 中执行：未安装／禁用错误、旧暂停记录及历史接管、cron 手动运行、暂停心跳随目标归档完成、禁用跨过 due 后不触发及重新启用不补跑均通过。独立 WebSocket 生命周期回归覆盖缺 project 的 live／cold stored Agent、归档与实际删除，并保留原 directory 投影语义。

真实 Web renderer 已通过客户端信任授权、侧栏与命令中心导航、双主机聚合及筛选，以及新建／编辑／删除确认、暂停／恢复、立即运行与运行记录。固定间隔 `1000001` ms 在名称编辑后重新打开仍保持精确值；实际选择模型、模式和 thinking，并将任务改为 `15 9 * * 1-5`／`Asia/Tokyo` 与新建工作树，保留最大次数、到期与完成后归档。local 与 worktree 两次实际执行均成功，运行记录保留各自 Agent／工作区与输出 `timeline test`；执行使用确定性测试 provider。既有心跳在目标归档后显示已完成，编辑最大次数不重新激活；禁用第一主机后其所选侧栏入口消失，第二主机仍能通过插件命令独立管理任务，重新启用恢复聚合、旧任务与暂停状态。

实际模型菜单暴露的冻结 React element Proxy 错误已按上述数据／句柄边界修复，SDK 回归与真实服务端插件执行回归通过。计划任务的这些结果仅覆盖隔离 daemon／worker 与 Web renderer，尚未进行打包 Native 或跨平台专项验收。

设计阶段在隔离 Node／tsx 进程中调用了当前速度函数：使用 7,000 到 10,000 ms 的已完成请求、120 个 output token，再加一个在途请求。

| 观察场景                 | 实测 t/s | 估算 t/s | 显示 t/s |
| ------------------------ | -------- | -------- | -------- |
| 10,000 ms 时             | 40       | 0        | 40       |
| 11,500 ms 时处于生成阶段 | 20       | 20       | 40       |
| 11,500 ms 时处于工具阶段 | 20       | 0        | 20       |
| 缺少原生事实             | 0        | 0        | 不显示   |

一个完成回合包含 10 个 input token、150 个总 output token，但只有 120 个实测 output token／3,000 ms，结果为**总计 160 token，实测速度 40 t/s**。另外 30 个 output token 未用于抬高实测吞吐率。

此前有界探测确认 DSH Cordis 入口不能直接作为 OMP 扩展加载；迁移后的 QQ 服务已由真实 compiler／isolated worker 消费。两个客户端和两个 SDK 会话的离线管理、独立安装、禁用／重启用／reload／移除与退出保持 enabled 均通过。生产 QQ SDK 的 owned loopback 验证每安装一个真实 socket，释放互不影响；这不替代 Tencent 登录或投递。

本次 QQ 入口回归先复现真实分发 factory 注册 `qqbot.settings` 时抛出 `Invalid plugin settings id`，以及 enabled／waiting 插件没有 active surface。修正统一贡献 ID 校验与 catalog 的 waiting 语义后，两个相关测试文件共 11 项通过，覆盖真实 QQ factory 的 manage／active 账号控件、非法 ID 边界和 waiting → running 的实例／在途 RPC 保持；应用类型检查与正式 renderer 导出通过。

实现后的真实 GUI 已通过菜单／命令的主机与 workspace／agent 上下文、不可用 Tab 的布局与状态恢复、同 ID 主题的主机引用及输入 DOM／焦点／选区／草稿／滚动保持。新 idle SDK 会话在发送前已有原生 header；实际提交的 local-only command annotation 在服务重启、v7 replica 冷恢复和来源禁用后仍保留完整附件卡片、全文与 metadata。AOT transformed discriminator、canonical 附件传递和旧损失 cache 的迁移均有消费者回归。

原生 owning frame／navigation identity、严格 Range 和跨窗口媒体 lease 隔离已由 mini-electron 真实 GUI 验证。宠物空 bootstrap frame 不再抢占正式文档的绑定；主屏 zoom 1／1.5 的 30 项真实输入通过，覆盖 3 px 不拖、4／5 px 拖动与持久化、释放不 pat／open、opaque 命中、透明穿透和不抢焦点。zoom 1.5 的三尺寸 × 0／1／12 气泡九组 bounds／scale 与截图均通过。

此前已验收分发产物的 `native-qualified-production-43My0r` 完整通过真实任务导航与关闭验收：两个实际 daemon／SDK 会话先确认无模型 command 注册，再生成真实待办；NSEvent 点击打开最高优先任务的精确主机／workspace／完整会话。已读后该主机 revision 从 seq 8 到 9，待办从两项降为一项；关闭发布窗口后再次点击仍打开另一主机的剩余任务。正式 App 的 `production-agent-navigation.png` 和宠物的 `production-two-task-pet.png` 已逐张检视；主窗实际 visible／key、scale 2、2400 × 1600。

此前 `native-qualified-production-xta1dd` 已真实复现 Overlay `closed` 回调访问失效 `webContents.id` 的退出失败。按既有主窗模式在创建期缓存 ID，并新增关闭后文档与旧 action 撤销回归；`native-overlay.test.ts` 九项测试、主进程构建及最新 Native 关闭均通过。owned windows 归零、光标／原应用恢复请求成功，两套私有 daemon 均由同 profile CLI 正常停止。原生 IPC 恢复标准 EventEmitter listener 身份后，真实 `removeListener`／`once`、frame 授权、导航 detach 和定向投递回归通过。

本轮证据根目录为 `/tmp/omp-unified-plugin-smoke-2s3uFs`。此前完成 Native 验收的分发产物为 `package-output-qualified/mac-arm64/OMP Desktop.app`，使用 mini-electron 0.1.38 与当前源码 SDK 18.14.0 desktop/core；未签名、公证或发布。checkout 外消费者已验证旧 compiler／worker、QQ CJS／MJS 管理、SILK／MPEG Wasm、SDK Native 读写、旧 prepare／manage 入口、独立 helper 工作区和资源安装闭包。严格禁全局 Node／Python 的 NodeMode 消费者通过 29 项资源／CLI 边界检查。

前次 QQ 入口修复分发产物为同一证据根目录下的 `package-output-qq-fix/mac-arm64/OMP Desktop.app`，复用上述 Native／SDK，仅重建 renderer 与 macOS 分发目录，未替换用户 Desktop。`qq-native-ui-yj95TF` 已实际启动 packaged main、独立 daemon，确认 bundled `qqbot` 精确来源，并通过真实 NSEvent 权限确认、QQ 单项启用／全局暂停、恢复执行后的无凭据 waiting、侧栏打开账号页、AppID 原生输入、拼图菜单显示与收起、再次暂停撤销运行入口但保留单项选择与配置。三张 2400 × 1600 Native 截图 `qq-paused-configuration.png`、`qq-login-surface.png`、`qq-application-menu.png` 已逐张检视。初次锁屏阻塞在用户解锁后解除；验收未绕 owning-window 输入资格或 TCC，外网保持隔离，不计作 Tencent 登录／投递。退出后 owned windows 为零，光标恢复、原应用恢复请求成功，私有 daemon 由同 profile CLI 正常停止。上述历史 GUI 证据保留各自产物归属，不计作新候选的重跑结果。

最新 QQ 搬迁修复产物为 `package-output-qq-relocation-fix/mac-arm64/OMP Desktop.app`，包含重建后的 daemon 与四目标 remote-backend 分发，复用 mini-electron 0.1.38、既有 renderer 和源码 SDK 18.14.0 desktop/core。本地产物已补 ad-hoc 签名并通过 `codesign --verify --deep --strict`，没有公证或发布。此前配置仍指向已删除的桌面 App 时，注册逻辑跳过已有 ID，导致查询 `paseo-plugin.json` 失败；修复后 18 项安装生命周期回归、服务类型检查和构建通过，覆盖搬迁、暂停／配置保留、撤销信任、已移除状态、新版本拒绝隐式授权、用户同 ID 来源隔离与旧 generation 撤销。

`qq-relocation-native-EF2fEM` 已将真实新 App 复制到隔离的 Applications 目录，以不存在的 Desktop 插件路径和全局暂停／QQ 单项启用配置启动实际 packaged GUI。真实 renderer 启动私有 daemon 后，catalog 与持久配置均迁移至新目录，QQ 版本为 1.0.0，无清单错误，暂停和单项选择保留。真实 NSEvent 完成当前来源权限确认并打开 QQ 配置；AppID／AppSecret 控件及扫码／刷新操作可见，无 alert，真实公开客户端 `qqbot.status` RPC 返回无凭据管理状态。`qq-relocated-account.png`（2400 × 1600）已检视，最终 `result.json` 为 PASS；owned windows 归零，光标／原应用恢复请求成功，私有 daemon PID 41749 由同 profile CLI 正常停止。未替换／重启用户 App 或 daemon，未恢复真实腾讯绑定或投递。

安装该修复包后，需在无运行任务时从新 App 重启内置 daemon 才能加载新服务实现；只关闭 App 或点 QQ 的重启／重载按钮不会更新仍在运行的旧 daemon。路径变化后，在插件权限页确认当前客户端来源；不自动搬移旧 source path 的客户端信任。

未修改生产 main 入口、无 `--app` 的真实 GUI 在 `native-qualified-production-cJPeQD` 通过：packaged renderer／preload bridge、私有 daemon 启动及实际 generated shell → bundled NodeMode helper → Desktop CLI → Native 图片转换均可用。转换前后 daemon PID／serverId／完整设置相同，退出后 owned windows 为零，私有 daemon 由同 profile CLI 正常停止。外层 `sandbox-exec` 禁解释器策略下，生产 renderer sandbox 初始化返回 EPERM；完整 Native 转换的严格策略验收仍受该环境限制，未禁用 renderer sandbox 绕过。

壁纸真实 file／URL decode、透明度 0／0.85／1、off／none／null、加载前 opaque、A→B→A 迟到回调与输入保持已有 GUI 证据。双窗／关闭隔离、项目切换、本机归属、预览 48／49 上限及竞争／释放通过。最新 Native 验证通过真实附件菜单实体 opaque、同媒体 lease 解码，以及实际 Cmd+Alt+T → 生产 theme.cycle → light／dark／auto；同 composer DOM、焦点、3190 字草稿、选区和滚动保持。Native async file dialog 已通过实际 panel 可见后的 Node ticks、owner／queued close／destroy／shutdown 和 exact-once 清理；程序调用 cancel 不记作真实 Escape，人工接受／取消和候选添加／删除／同路径重加仍暂停。

完整系统验收仍未完成，上表验收条件全部保留。官方配置的 `sdk-v18.14.0-desktop-core.1` 已经真实 RPC 返回 `Unknown command: append_session_annotation`；本地新产物已证明 durable ack、原生 header／全文落盘及 cold resume 无模型 messages，四目标 remote-backend 构建成功不能替代新 SDK 发布。发布负责人需发布匹配合同、更新实际 release 配置，再验收下载后的远端闭包。用户选择继续暂停模型创作、真实 QQ、人工文件对话框／壁纸选图、Windows／Linux 和真实负坐标外接屏验收；Native 当前仅枚举主屏。严格外层解释器策略的完整 Native 转换另有上述 EPERM 环境阻塞。
