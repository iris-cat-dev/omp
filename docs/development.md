# Development and verification

All shell and PowerShell commands in this guide run from the repository root unless stated otherwise. See [packaging](packaging.md) for supported native runtimes, installer construction, signing, bundled SDK, and release metadata; [remote hosts](remote-hosts.md) and [deployment](deployment.md) cover remote daemon and Web/relay setup.

## Start development

Build prerequisites: Node.js 24+ (CI uses 24.14.0), Bun, Rustup with [the SDK's pinned Rust toolchain](../omp-sdk/rust-toolchain.toml), and a native C/C++ toolchain (Xcode Command Line Tools on macOS; Visual Studio C++ Build Tools on Windows). Bun and Rust are build tools, not installed-application requirements. Desktop and Web development do not require Java or an Android SDK.

```bash
git submodule update --init --recursive
npm install
npm run dev:desktop
```

Development uses:

- daemon: `127.0.0.1:6770`;
- renderer: an available Electron Metro port;
- state: `.dev/omp-desktop-home`.

The packaged app uses `~/.omp-desktop`. OMP keeps its own configuration, credentials, provider subscriptions, and sessions under `~/.omp`.

`omp-sdk/` is a Git submodule of [iris-cat-dev/omp-sdk](https://github.com/iris-cat-dev/omp-sdk), pinned to the commit recorded by Desktop. Use `git clone --recurse-submodules` for a fresh checkout, or rerun `git submodule update --init --recursive` after pulling Desktop changes. Commit SDK changes in `omp-sdk/` and push them to its own remote before committing and pushing an updated submodule pointer here. The SDK package root is `omp-sdk/packages/coding-agent`; initializing the submodule does not install its dependencies or build its Node artifacts.

The syntax highlighter pins `@codemirror/legacy-modes` to `6.5.3`, whose Swift and Dart stream parsers use the same CodeMirror 6 language types as the application. Keep this pin when updating dependencies; `6.5.5` uses incompatible streamparser types.

## Workspace packages

| Package                                       | Responsibility                      |
| --------------------------------------------- | ----------------------------------- |
| [`packages/app`](../packages/app)             | Electron and Web renderer           |
| [`packages/desktop`](../packages/desktop)     | Electron main process and packaging |
| [`packages/server`](../packages/server)       | Local daemon and OMP adapter        |
| [`packages/client`](../packages/client)       | Daemon client                       |
| [`packages/protocol`](../packages/protocol)   | Shared wire schemas                 |
| [`packages/relay`](../packages/relay)         | Shared E2EE relay transport         |
| [`packages/cli`](../packages/cli)             | `omp-desktop` CLI                   |
| [`packages/highlight`](../packages/highlight) | Code and diff highlighting          |

The root `tsconfig.json` covers root `*.config.ts` files only. Each workspace uses its own TypeScript configuration; `npm run typecheck` checks those workspaces. To check root configuration files, run `npm exec --no -- tsgo --noEmit -p tsconfig.json`.

## Runtime and protocol notes

Main-process code keeps Electron-compatible `electron` imports; the stock `electron` package is retained only for TypeScript declarations. Project scripts do not download or substitute its runtime. Native runtime version selection and platform constraints are documented in [packaging](packaging.md#native-runtime-selection).

The daemon decodes OMP's JSONL stdout and diagnostic stderr as UTF-8 streams, preserving Chinese characters and emoji even when their bytes span pipe data blocks. JSONL line framing and protocol-v2 chunk reassembly remain unchanged.

Desktop/daemon WebSocket framing is separate from the SDK's JSONL transport.
Capable clients receive large history, directory and subagent JSON messages in
callback-paced 256 KiB chunks without relaxing the 64 MiB physical backlog guard.
See [chunked daemon messages](../packages/protocol/README.md#chunked-daemon-messages)
for negotiation, framing, queue limits and reconnect behavior.

OMP `compact` and `prompt` admission RPCs wait for their response, runtime exit, or session close rather than the short control-plane timeout. Prompt admission can wait for compaction, input hooks, and image preparation; a local timeout does not withdraw that input. Native `manual_compaction_start`/`manual_compaction_end` events use the same compaction timeline and deduplication path as Desktop's `/compact` marker.

### OMP SDK backend

Desktop development, packaged applications, and SSH-managed deployments use the SDK. `npm run build:omp-sdk` defaults to a release build and stages its complete runtime closure in `packages/desktop/sdk-dist/`. Unchanged SDK inputs and validated output bytes reuse that directory without installing dependencies, invoking Cargo, bundling, or packing again. Changed inputs run only the necessary native and bundle stages; dependency file lists are cached across staging runs.

`npm run build:server` and `npm run dev:desktop` select the development SDK: the Desktop addon uses Cargo `local` (thin LTO, 16 codegen units, incremental) in `native/desktop/local`, and staging prepares the runnable directory without generating `omp-sdk.tgz`. `npm run build:server:clean`, remote-backend assembly, and application packaging explicitly select release builds. Release addons remain in `native/desktop`, and release staging produces the validated archive. Production packaging and SDK artifact export/import reject development markers and local-profile native sidecars.

With an absolute `OMP_DESKTOP_SDK_ARTIFACT` directory, the build imports the matching **Package release** artifact, checking SDK commit/version, target/profile, and archive integrity without rebuilding native addons. This explicit override uses the artifact's release bytes, not uncommitted SDK changes. [Mac-to-Windows packaging](packaging.md#mac-to-windows-packaging) sets the target to Windows x64 and consumes the Windows-built SDK.

Desktop-managed configuration ignores legacy `ompBackend: "cli"` and CLI command overrides; model policy, provider environment, and explicit SDK package paths remain. Standalone servers without an SDK retain external CLI support; an installed SDK selects SDK unless that standalone server explicitly selects CLI.

For a custom SDK source, `OMP_DESKTOP_SDK_SOURCE` must be an absolute package root. Runtime `agents.providers.omp.ompSdkPath` also selects a package root, not a CLI executable or individual module. Installed packages must contain `package.json` and canonical `dist/node/` SDK, RPC, host, plugin-management, and module-registry artifacts.

Each top-level agent runs in a separate Node process with the existing RPC session adapter, streaming events, approval UI, host-tool bridge, and persistence format. SDK errors never trigger a CLI fallback. Packaged Desktop uses its embedded Node runtime and preserves `ELECTRON_RUN_AS_NODE=1` in SDK hosts and worker subprocesses; no external Node, Bun, or OMP executable is required. Remote bundles install Node 24.14.0.

Node RPC startup initializes the configured theme without a terminal theme watcher before constructing the session. `ask` uses theme-provided control labels even with a remote prompt UI; bypassing this initialization fails before a question reaches Desktop. Rebuild the SDK and restart existing session hosts to apply changes; running hosts retain their loaded code.

SDK sessions enable `set_ask_dialog` before startup completes. One RPC `extension_ui_request` with `method: "ask"` carries the entire question group. Desktop renders the existing question tabs and returns an ordered `answers` array of `{ id, selectedOptions, customInput? }`, preserving original option labels and separate custom input. IDs keep repeated headers distinct; comma-containing labels remain individual selections. Invalid or incomplete answers leave the permission pending, and closing the form cancels the group. Legacy external CLI startup retains its existing select/editor path. Rebuild the Desktop backend and renderer, then recreate existing sessions to load this bridge change.

`debug` is enabled in Node RPC hosts, including Desktop and SDK-backed remote sessions, subject to the normal `debug.enabled` setting, tool allowlists, and explicit denials. DAP adapter launch and `runInTerminal` use the shared cross-runtime process manager; stdio, TCP, and platform-specific socket transports no longer require Bun. Install/configure the target language's debugger adapter separately. Rebuild the SDK and recreate existing session hosts to load the repaired transport and tool registry; already-running hosts retain their loaded code.

Browser Relay also uses the embedded runtime: the first loopback relay browser open lazily starts `dist/node/host.mjs browser-relay` through the SDK's machine-global daemon broker. It does not invoke an `omp` executable from `PATH`. Concurrent SDK sessions share the existing relay; broker leases keep it alive while another consumer remains, and externally started relays remain under their owner's control. Remote relay endpoints are never auto-started.

Chrome still needs the OMP Browser Relay extension installed and enabled. Desktop ships `omp-desktop browser-relay status --json`, `omp-desktop browser-relay serve --no-group`, and `omp-desktop browser-relay install`; no global `omp` or Bun is needed. Use `--sdk-root <package root>` only for an explicit SDK override. After installation, use Chrome's **Load unpacked** or **Reload** action. Status distinguishes an absent service, an unrelated listener, a missing/disconnected extension, incompatible protocols, and a ready relay. Existing relays are never automatically replaced, even when incompatible: their owner must arrange a safe restart. Rebuild the SDK artifacts and restart the backend after changing this startup path.

Windows SDK hosts and Eval workers require the native async-context repair described in [packaging](packaging.md#windows-runtime-version-and-local-overrides). Eval fails explicitly if its run context is unavailable; it must not report successful empty output or route output through a global current run. Code may already have produced side effects before a context error, so inspect those effects before retrying.

Single-tool extension preferences use `setToolEnabled(name, enabled)`, not a read/modify/write snapshot of `getActiveTools()` and `setActiveTools()`. The SDK waits for pending registrations, then changes only that name inside the registry queue, retaining unrelated tools and their mounted/top-level presentation. Desktop image settings apply this only to `generate_image`. SDK `extension_error` events become error-level extension notifications with their event/source category preserved and credentials/local paths redacted. A plugin's discovered tool count is not proof that every tool was registered, enabled, or mounted.

`manage_skill` passes its cancellation signal through file-operation boundaries, discovery and prompt preparation. Skill/prompt candidates are committed only while the session and signal remain current; refresh does not re-enter its own registry queue. Tool results distinguish a persisted file change from a cancelled or failed refresh. Such a result is not an instruction to repeat the write/delete.

User Stop withdraws native steering and follow-up queues atomically before
aborting the active request. Withdrawn Desktop submissions are echoed once in
the canonical timeline with their client message IDs and original attachments;
they are not automatically submitted again. Replacement and other non-user
interruptions retain ordinary abort semantics. Length continuations are not
scheduled while interruption is active.

Stop waits for the selected agent and its managed descendants to finish cleanup,
even when the selected root is idle. This includes accepted host-tool calls,
background jobs, retained shell subprocesses, and idle JS/Python eval kernels and
their subprocess groups. Admissions and autonomous continuations are fenced
during cleanup; independent roots are not stopped. Tree cancellation uses one
15-second deadline shared by ownership admission, native children, interruption,
background cleanup, event drain, and run settlement. Replacement also waits for
accepted host-tool work. A timeout or unconfirmed shutdown returns a failure
instead of claiming that live execution is idle.

Cancellation tracks recorded execution and non-empty turn identities; the displayed `running` lifecycle alone never creates an autonomous registry entry. Busy state still blocks replacement while owned cleanup is unconfirmed, even after the model turn ends. A legacy autonomous registry entry with no turn identity is retired only after interruption is acknowledged, owned background cleanup succeeds, and session events drain with no active turn; this does not fabricate a cancellation event. Confirmed Stop also clears withdrawn replacement admission. Unconfirmed execution or cleanup remains busy and blocks replacement.

The prompt-admission lane captures the target and managed ancestors' Stop epochs when input is submitted, then rechecks that same admission before dispatch. Delayed provider admission responses cannot turn pre-Stop queued input into fresh post-Stop work. This lane stays separate from foreground/lifecycle mutations so cancellation and out-of-band controls cannot deadlock on it.

The conversation remains usable after Stop. A new prompt reopens admission and
recreates eval kernels lazily; variables, timers, and other retained eval effects
from before Stop are discarded. Explicit SDK clients requesting the same eval
namespace for multiple owners receive a strict-Stop error rather than terminating
another owner's kernel. Ordinary SDK aborts do not dispose retained eval kernels.

An unacknowledged cancellation still blocks replacement input and returns `agent_cancellation_unacknowledged` through send, Stop, and native-child cancellation responses. The composer shows cleanup progress and retains failed input and attachments; cancellation-refused queue items require explicit retry rather than automatic dispatch. Its inline **Recover runtime** action uses the existing dangerous-operation confirmation; `kill_agent({ agentId, force: true })` exposes the same targeted recovery to host tools. Default `kill_agent` remains safe unload. Recovery keeps persisted history and never resubmits input, but does not roll back completed writes or other side effects. New input is admitted only after the target runtime's exit and accepted host work are confirmed settled; failed recovery retains the admission fence and can be retried. Asynchronous feedback stays bound to the original host and conversation. Other independent agents are not terminated.

OMP background-process inventory uses a generation-scoped, authenticated loopback
bridge. A live session can rebind it through `execute_extension_command`, which
dispatches only a registered extension handler, never a prompt/input fallback.
Concurrent failures share one recovery; inventory reads retry once against the
new generation, while stop requests are never replayed automatically. Rebinding
preserves live jobs, their public IDs/output, and retained eval kernels. Ownership
tracks native session identity and actual job instances, including branch/fork
inheritance and failed-switch rollback. Unavailable/dead bridges and unresolved
outgoing work are not empty inventories: inventory failure never authorizes safe
unload.

Backend code updates require a daemon restart: refreshing one agent cannot
replace provider classes already loaded by the daemon. Refreshing an agent from
persistence does close only that agent's runtime and rehydrate its original
native session history, without replaying a prompt or replacing the conversation.

Cold OMP conversation history, the Chat outline and `get_agent_activity` share
`readPersistedAgentHistory`, which reuses the selected SDK's
`dist/node/modules.json` export
`@oh-my-pi/pi-coding-agent/session/indexed-session-journal` without starting an
SDK host or creating a parallel scanner. First-scan index/catalog cost is
separate from warm small-page I/O. History-primed loaded agents keep their live
timeline; concurrent activation keeps the complete cold page until replay is ready.
Persisted pages share an epoch distinct from the runtime.
Cold reads require that real built Node SDK even when a standalone server runs
agents through CLI. Missing packages/artifacts report the cold-history
prerequisite, with no scanner fallback or host startup. Tests may select their
independent built stage through `OMP_DESKTOP_TEST_SDK_ROOT`; production environment
sanitization remains unchanged.

The daemon retains at most an estimated 32 MiB of reloadable **closed-session**
timeline bodies. Closing/recovering a session checks the native journal header
and selected cold reader before admitting that history to the budget; oldest
closed entries are evicted first. Resuming removes an entry from this cache and
rehydrates evicted history through the existing provider path. Active timelines,
memory-only sessions, missing/malformed journals and unavailable readers remain
pinned rather than losing the only copy. This is not a hard RSS/heap limit for
running conversations, and the optional `durableTimelineStore` is not assumed
to be configured by production bootstrap. Tests may lower
`closedTimelineCacheBytes` without changing the production budget.

On Windows/macOS, native recursive file observation coalesces queued
classifications by path and admits at most eight `stat` calls concurrently.
Classification overflow requests a full audit instead of silently forgetting
changes. Scans, inventory diffs, subtree removal and inventory merging yield
every 512 entries; ignore-generation changes and shutdown fence delayed work.
Subtree removal follows the directory index instead of rescanning every tracked
file for each deleted child, and scoped diffs no longer copy the whole matching
file set. Safety audits and the 250,000-entry observation limit remain enabled.

The Windows real-filesystem smoke covered 6,000 files through full initial
inventory, every rename create/delete pair, every subtree deletion, and empty
inventory after unsubscribe. Its 10 ms event-loop probe observed a maximum
34.8 ms gap on this machine; this is not a long-duration or multi-repository
latency guarantee.

The activity tool reads the full canonical history before applying its projected
summary limit, preserving total counts and whole merged messages. Archived and
unarchived unloaded conversations follow the same read-only path; unavailable
history is an error, not a reason to activate a runtime.

If resumed live rows arrive in a different epoch above sequence 1, the client
requests an authoritative catch-up using its existing cursor. The reset response
replaces the cold window, allowing subsequent replies to display without scrolling
or restarting the app.
Subagent lists and paged child timelines also read from disk without loading the
parent runtime.
Cold focus, attention, model metadata and resource inventory also stay read-only;
dynamic state with no retained snapshot is explicitly unavailable.
`contentVersion` and `revisedEntries`/`revisedRows` carry tool-body revisions
behind the sequence cursor without resetting ordinary `after` windows. Old
same-sequence pages cannot overwrite newer revisions.

Desktop's background owner stays `desktop:<agentId>` across rewind, independent
of native transcript IDs. Idle unload eligibility begins at five minutes with a
30-second recheck. Safe unload is inventory → persistence drain → inventory →
synchronous final admission guard; active/admitted work, unconfirmed input,
permissions, background dependencies and retained variables/resources block it.
`getAgentRuntimeResources`, `releaseAgentRuntimeResource`, and
`unloadAgentRuntime` expose inventory, explicit destructive resource release and
safe unload. Busy/shared resources and background dependencies reject release.
`agent unload` and `kill_agent` preserve these gates and retained history.
Non-OMP sessions keep their provider-specific loading path. Automatic credential
lookup skips retry delays when there is no multi-account automatic selection.

Enhanced workflows synchronize the interface language immediately before sending
a message, not when the composer mounts. Opening cold history therefore stays
read-only; explicitly changing the workflow still synchronizes the language
immediately.
The renderer publishes the local message before asynchronous workspace checks
and language synchronization; both still finish before the prompt is sent.
Default composer submission clears the live editor and persisted draft synchronously,
canceling staged after-paint text publication before transport preparation. Submission
snapshots guard the post-clear draft and target: rejection restores an empty draft,
while acceptance never clears a later edit. Image retention spans preparation and
settlement so immediate clearing cannot release outgoing attachment bytes.

Cold background-process lists inspect durable OMP daemon metadata and its broker
without resuming the conversation. Only the original native session's daemons are
included; live runtime jobs remain on the loaded-session path.

Persisted OMP runtimes automatically close after five minutes without live
activity. Running turns, pending permissions, active subagents and unfinished
background processes prevent retirement; a failed process inventory also keeps
the runtime alive. Retirement releases the SDK process and daemon-side timeline
and subagent caches, not the stored conversation, title, settings or unread state.
History remains readable without starting an SDK process; sending another prompt
restores the original session through the normal persistence loader. The main
window, daemon, non-OMP providers and internal agents are unaffected.
`AgentManagerOptions.idleRuntimeTimeoutMs` controls the timeout for embedded
managers and deterministic verification; zero disables retirement.

Cold OMP snapshots retain saved workflow features and approval-mode options.
The composer reads active-directory entries or retained agent details, so
retirement does not reset controls or skip enhanced-workflow language sync.

Build a development SDK/server or a release SDK/unpacked application:

```bash
npm run build:omp-sdk:dev
npm run build:server
npm run build:omp-sdk:release
npm run build -- --dir --publish never
```

Build state and package file lists live under `.dev/omp-sdk-build-cache/`. Keys include source file contents (tracked files and non-ignored new files, including uncommitted edits), locks, build scripts, Bun environment files, platform/architecture, build mode, tool versions, relevant build environment, and resolved dependency contents. A TypeScript-only SDK edit reuses an unchanged native addon; a changed Rust input rebuilds it. Missing or altered generated/staged output also invalidates reuse. Removing the cache forces rebuilding; do not clear Cargo's `target` directory for normal iteration. The first use of Cargo `local` needs its own dependency build even if `release` is already warm.

Restart the daemon after changing its backend or SDK. Existing sessions are not switched in place. SDK model/auth and plugin management use the SDK itself; CLI install/update operations are unavailable. SDK statistics read the persisted SQLite index without launching a CLI refresh.

Passive background-daemon inspection calls `ipcEndpoint(runtimeDir, "broker")` from the selected SDK's own `@oh-my-pi/pi-natives` dependency and caches the endpoint for that runtime scope. Explicit `ompSdkPath` takes precedence over provider/launch SDK-root environment settings, as it does for session startup. Windows `omp-broker-*` pipe names and relocated Unix sockets therefore follow the listener's rules instead of deriving an address from the runtime directory basename. Resolving the endpoint does not initialize an SDK agent session, acquire a broker lease, or revive a broker; transport/authentication failures from a live broker remain errors, not an empty background list.

The runtime directory passed to the native IPC helper retains the SDK configuration's lexical path. Do not `realpath` it before endpoint selection: aliases such as macOS `/var` versus `/private/var` hash to different relocated sockets. Canonical project paths are used only to match scope metadata; output inspection still rejects symlinked daemon records and logs. SDK 18's separate `spec.json` supplies the command, working directory and PTY format alongside `meta.json`; legacy embedded specs remain readable without exposing their environment.

Standalone CLI inspection keeps direct Unix socket addressing. On Windows it also needs an accessible Node SDK helper, selected through `OMP_DESKTOP_SDK_ROOT` or the installed SDK package; it no longer guesses a legacy named-pipe address.

Host Agents settings omit standalone OMP installation and update controls. Update the bundled SDK through Desktop app updates; manage standalone CLI installations outside these settings. Desktop app update controls remain available.

Host Agents settings no longer expose Agent Shell selection. Desktop does not
probe Git Bash or inject a custom `shellPath`; Agent commands use OMP's built-in
shell behavior. Saved `agentShell` parameters are discarded for OMP providers,
including profiles extending OMP. The Desktop-owned config overlay is rewritten
without legacy shell paths and keeps Bash Interceptor enabled.

Daemon startup does not scan plugins in the user profile or saved workspaces before accepting WebSocket clients. Each Node RPC host checks enabled plugins for its own session cwd and configured profile before creating or resuming the OMP session, in the same SDK process. Missing entries, import errors, or factory failures persistently disable the failed plugin in its own runtime scope and synchronize matching marketplace registry entries. Healthy plugins, disabled plugins/features, and plugin settings are preserved. A failed check or plugin-state write fails that session's startup with a diagnostic; unrelated projects remain usable. Fix or precompile the plugin, then re-enable it in Host Plugins settings; the next session startup checks it again.

HTTP listening is not worker readiness. Until the WebSocket server begins accepting clients, HTTP upgrades receive `503 Service Unavailable` with `Connection: close`; connection-local errors close only that socket. The supervisor records `ready: false` in its PID metadata until worker-ready IPC arrives, and resets readiness before replacing an exited worker. CLI and Desktop report a live managed supervisor with explicit unready metadata as `starting`, without probing an unavailable WebSocket or spawning a duplicate supervisor. PID files without readiness metadata retain normal reachability checks.

If the supervisor cannot persist `ready: false` after a worker exits, it releases its owned PID lock and exits with a failure status instead of launching a replacement with stale readiness metadata.

Explicit stop and disabling built-in management can stop a starting managed supervisor. Desktop registers the matching local connection after the worker is reachable and ready, with distribution and version checks applied. An offline saved host connects immediately through that local endpoint, without waiting for probe backoff or an earlier relay probe; disabled hosts, online connections, and custom host labels are preserved. If readiness polling times out, the start request reports an error and leaves the existing supervisor running. Updating these modules requires restarting both the supervisor and Desktop main process; already-running processes retain their loaded code.

Build overrides, shared by development, Desktop packaging, and remote deployment:

| Variable                     | Default                         | Purpose                                                                                           |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `OMP_DESKTOP_SDK_SOURCE`     | `omp-sdk/packages/coding-agent` | Absolute source package root                                                                      |
| `OMP_DESKTOP_SDK_TARGET`     | `desktop`                       | `desktop` or `generic` Node artifact                                                              |
| `OMP_DESKTOP_SDK_PROFILE`    | `core`                          | `core` or `full` capability profile                                                               |
| `OMP_DESKTOP_SDK_BUILD_MODE` | `release` for direct SDK builds | `development` uses local native output and omits compression; release entrypoints force `release` |

The Desktop target builds `dist/node-desktop/` and installs it canonically at `dist/node/`, leaving generic source artifacts untouched. Extensions can import package roots and Desktop's SDK/headless/async/host-API aliases, not arbitrary source-file subpaths; select `generic` for extensions requiring those imports. Missing artifacts or stale source/target/profile metadata fail packaging instead of falling back.

The Desktop native addon omits PDF text extraction, Jujutsu (Git remains),
Snapcompact image-based context compression, recording/playback, local word
prediction, spelling, and Apple Foundation Models, in addition to SmolLM,
native WebRTC/Opus, and WASM grammars. Both `core` and `full` enforce this native
boundary. Saved settings cannot activate omitted engines; explicit requests
fail before native construction. Existing Snapcompact archives, ordinary images,
browser PDF screenshots/printing, and caller-owned SDP signaling remain usable.

Core preserves remote/API models, file/Bash/JS eval tools, browser support, RPC, saved sessions, and cancellation. It excludes local embedding, offline speech, and tiny helper runtimes, disables their automatic prefetching, and rejects explicit offline requests. `full` includes the profile's optional dependencies; Desktop-target native capabilities remain limited by that target. The installed package records its profile; launch-time environment changes cannot restore excluded capabilities.

SDK native dependencies must match the build host's OS and architecture. Windows x64 applications require Windows x64 builds; macOS arm64 applications require macOS arm64 builds. macOS core packaging resolves both the App resources root and addon to their real paths, rejects addons outside that root, and breaks packager hardlinks before stripping the release copy and signing; source addons remain unchanged.

Packaged SDK and Desktop image operations use Sharp 0.35.4 and target-native libvips. Packaging validates dependency versions, target metadata, and native payload hashes. macOS packages share one runtime through App-internal relative links; Windows keeps independent validated SDK and Desktop copies without requiring privileged directory symlinks or non-relocatable absolute junctions. The staged SDK and remote tar retain complete independent dependencies; moving the App requires neither the checkout nor external image libraries.

`npm run build:remote-backend` consumes the fixed public SDK release index configured in `omp-sdk/sdk/node-release.json`, not the locally staged SDK. It validates metadata for all four macOS/glibc Linux x64/arm64 targets and generates their Desktop backend npm lockfiles without downloading SDK archives. Only workspace archives, target package/lock files and the schema-2 manifest remain in `remote-backend-dist`; the selected SDK is downloaded and verified during SSH deployment, then extracted separately after `npm ci`. An unavailable, incomplete or version/profile-mismatched release index fails the build. See [SDK release construction](../omp-sdk/docs/sdk.md#platform-specific-desktop-core-releases).

Local remote-backend assembly stages beside `remote-backend-dist` before committing with `rename`, so Windows builds work when the system TEMP directory and checkout are on different drives.

The packaged SDK smoke copies the App outside the checkout, clears `NODE_PATH`, and loads a `.mjs` session-start extension to verify the loaded native capability flags and concurrent RPC sessions. Installation RPC must report the packaged SDK root and version, not a retired standalone executable. Node SDK plugins, custom tools/commands, and eval are JavaScript-only: precompile TS/TSX/JSX sources and dependencies to `.js`, `.mjs`, or `.cjs`. Development selects the server's built JavaScript helpers for internal background-job, image, and local-model extensions instead of asking the SDK to compile their TypeScript sources. CLI command overrides are not SDK entrypoints, and CLI-bound private plugin packages are unsupported. Discovered plugins must support Node; disable Bun-only plugins before using SDK mode.

Windows Node SDK hosts query `GetConsoleWindow` through the packaged Koffi backend and combine it with TTY evidence, rather than treating Node or redirected stdio as proof that a console exists. MCP servers and eval kernels retain a real inherited console, including fully redirected launches; GUI-hosted background helpers hide their windows. CPU probes, clipboard helpers, dependency installation, and native Git discovery/operations use explicit non-interactive window flags. Interactive editors and PTY tools retain their own terminal behavior.

### Startup and first-window work

Apple Silicon startup streams local frontend assets in bounded chunks up to 1 MiB, avoiding repeated small-file-read overhead. The main window stays native-hidden until the renderer has painted a branded startup surface and the runtime has copied that frame into the AppKit backing store, avoiding an unpainted first reveal.

Mermaid, WebSocket response validation, and terminal emulation load on first use instead of inflating the startup entry. Desktop daemon setup imports only its configuration/runtime helpers; updater and CLI-install graphs also stay off the first-window path. Login-shell environment inheritance and daemon readiness checks are unchanged.

Lazy-loaded CommonJS desktop modules must use typed `require`, not runtime `import()`. mini-electron resolves the native `electron` module through its CommonJS loader; Node's ESM-to-CommonJS loader bypasses that resolver and can fail with `Cannot find module 'electron'`, including in transitive dependencies. CLI/OMP shortcut installation and updater operations stay deferred through `require`; the Node worker and CLI entrypoint loaders retain `import()` for their ESM entrypoints. Qualify these paths in the native runtime, since Vitest's mocked Electron module does not exercise native resolution.

On Windows, the renderer normally reports content readiness after app settings load. If that signal never arrives, a bounded main-process fallback presents the successfully loaded first document. Navigation, close, hide, minimize, or normal readiness cancels it; the fallback cannot reopen a window hidden to the tray. macOS remains gated on its native paint handoff.

### Frontend work and generated output

Desktop/web status rings, synchronized loaders, and the homepage WebGPU poster stop scheduling animation while their retained panel or application is inactive. The homepage route supplies its navigation focus to the retained-panel context, so opening Settings also stops the covered poster while the window stays focused. Retained poster resources are reused within the mounted component and released on unmount or when the existing home-effects switch is disabled. Loaders share one timer at the six visible step boundaries per 950 ms cycle, not a permanent display-rate worklet. Reduced-motion preferences remain respected.

The frontend Babel pipeline resolves Lucide's actual named exports to individual icon modules, including legacy aliases; public type imports remain unchanged. Electron web exports use UTF-8 instead of ASCII-escaped strings. Protocol validator generation shares repeated, non-mutating IR containers without removing validation, defaults, transforms, or fallback schema behavior; see the [protocol code generator guide](../packages/protocol/codegen/README.md).

Draft text changes keep the 200 ms checkpoint interval without scheduling attachment
GC. GC is scheduled when active image references change, including nested visual
feedback originals/previews, or when lifecycle changes release references. Equivalent
normalized saves and unchanged GC pruning do not submit another checkpoint. Directory
and workspace-file additions do not require a scan of every loaded session.

Web history measurements are invalidated when the active scroll pane's available
width changes, including split-pane resizing; height-only changes retain the cache.
Refresh TanStack's lazy measurements before computing the saved reading offset.
Pending history-prepend anchors are rebased against committed width-dependent
geometry while their original progress key is unchanged, not against an intermediate
estimated spacer. The real-browser regression is
`src/agent-stream/strategy-web.browser.test.tsx` in the app workspace.

Windows #139 qualification used the publicly installed mini-electron `0.1.37`
with application source `2f15a7f5986fa4ffa03dd222307dd8b9210997d9`, including
upstream `793e0a403f020a2acbb0a9fe329594e11987a406` and SDK submodule
`682e4e293804151603386ef3374a6f7dec5249ce`. The unsigned Windows x64 NSIS
installer retains application version `0.6.0`; it is a local repaired build, not
a separately published Desktop release.

The actual EXE payload was extracted and passed all 12 groups of
`packages/desktop/e2e/packaged-app-smoke.js`, including native maximize/restore,
continuous restore-drag/Snap, OS/runtime/DOM geometry, guarded native screenshots,
bundled SDK/terminal and daemon lifecycle. Evidence is retained locally under
`.dev/issue-139-smoke/omp-native-packaged-evidence-TOW8qx/`.
The disposable copy's main entry and early metadata provide the smoke controls;
its renderer, preloads, daemon and SDK remain real. Existing user profiles were
not used, and the owned processes and temporary profile were removed.

The installer at `.dev/issue-139-fixed-app/OMP-Desktop-Setup-0.6.0-x64.exe` is
91,521,656 bytes, SHA-256
`8f77850338bc93b446dfc3cfba08c1bdf77da59c1c697294bbd4182164134aef`.
This verifies its extracted application, not interactive installer/uninstaller
flows or a long-session Windows 11 stutter timeline.

Replica persistence serializes only the latest 50 serializable canonical timeline
items. Pending local messages do not count toward that window; omitted canonical
rows still prevent authoritative coverage. Older rows are inspected only when
needed to fill the tail or verify coverage. Cache version 6 and restored cursor
semantics are unchanged. This bounds serialization work, not live timeline retention.

Syntax tokenization keeps a 200-entry LRU with an additional 2,000,000 UTF-16 code
unit budget across its extension/source keys. This is not a byte-accurate token
heap limit. Eviction only requires re-tokenization; highlighting output and the
existing per-block size limit are unchanged.

The task panel and expanded todo activity details share UI tree controls built
from the directory trees' disclosure chevrons and row presentation, without
terminal connector glyphs or display-only phase numbering. Every phase remains
visible and expands independently; the current phase opens by default. The
header expands or collapses all phases, and explicit disclosure choices survive
status updates. Web trees support roving focus, arrow-key navigation and
disclosure, Home and End.
Desktop task rows use a compact 24px minimum height; narrow screens retain
32px rows. Leaf rows omit the empty disclosure slot. Tighter panel padding and
prose-scaled 20px text line heights at the default content size reduce wasted
space while preserving label wrapping.
OMP task snapshots retain each non-empty phase's name and zero-based index across
live updates, history and replica caching. Completed and abandoned tasks count
as closed progress. Legacy and non-OMP tasks without phase metadata remain an
ungrouped task tree without a viewport cutoff; long labels wrap. Native partial
todo reminders merge into the full snapshot instead of discarding closed,
blocked or subsequent-phase tasks.

### Changes renderer memory

Wrapped diff lines search for each endpoint with exponential local bounds before
binary search, rather than repeatedly measuring the entire remaining line.
Rejected candidates produce advances only; per-grapheme geometry is materialized
for the selected fragment. Keep each fragment's own shaping context: subtracting
full-line prefix widths would change ligatures and contextual-script metrics.

Checkout-diff replicas are observer-owned. After the last observer leaves, React
Query collects the snapshot on its next GC turn (`gcTime: 0`), including old keys
from workspace, comparison, and expanded-path changes. Mounted retained panels,
even when disabled, still own their snapshots. Resubscribing receives a fresh
daemon snapshot; other replica domains keep their existing cache lifetime.

Renderer history budgets use conservative UTF-16 body accounting: visible
24 MiB and background 32 MiB. Encoded image data (12 MiB) and decoded image
estimates (24 MiB) are separate budgets. Active pinned content may exceed them;
diagnostics report retained over-budget bytes instead of claiming eviction.
SDK history uses bounded lazy facades with 8 MiB hot bodies plus an 8 MiB body
LRU and source rereads. Complete `File` bodies remain persisted without generic
500,000-character truncation; image externalization/private stripping remain.

Image visibility may release decoded previews, but must not release known layout
dimensions. Read source metadata learned by `onLoad` on subsequent renders, and
keep its aspect ratio while a preview is absent or being reacquired. Memoizing
an initial metadata miss makes offscreen images collapse to 160-pixel placeholders
and expand again on return. Changing the source must not reuse the previous
image's dimensions; offscreen bindings still release normally.

`useAssistantImage` uses `"use no memo"` to keep mutable metadata reads live
under React Compiler; its explicit `useMemo`/`useCallback` calls and offscreen
resource release remain intact. Geometry regressions compile the hook with the
production Expo/Babel configuration and cover delayed Blob preview reacquisition
as well as source changes. TypeScript-only tests miss compiler-cached metadata.

Window clipping and background LRU removal must not mutate previously published
session snapshots. They share privately owned map copies until one state
publication. Head pages, unacknowledged input, and active history fetches fence
background unload. Exercise the deferred 80ms store pass, not only the pure
window selector, when changing these paths.

Accounting bytes are not JavaScript heap, macOS `phys_footprint`, or Windows
process commit. Each measurement must name its category and process scope;
none increases the 4 GiB compressed V8 cage or substitutes for real Native UI
and platform-specific qualification.

Run the targeted regressions from the repository root:

```bash
npm run test --workspace=@omp-desktop/app -- --project unit src/git/diff-document/model.test.ts src/git/diff-document/text-measurement.test.ts src/data/query.test.tsx src/data/push-router.test.ts
npm run test --workspace=@omp-desktop/app -- --project unit src/stores/session-store.test.ts src/timeline/timeline-residency.test.ts src/assistant-image/timeline-assets.test.ts
npm run test --workspace=@omp-desktop/app -- --project unit src/assistant-image/use-assistant-image.test.tsx
```

These changes address allocation amplification and orphaned snapshot retention,
not a proven attribution of [issue #107](https://github.com/iris-cat-dev/omp/issues/107).
Native qualification still needs an isolated sandboxed renderer and OS process
commit sampling; bucketized `performance.memory` is not a precise live heap peak.

## Verification policy

```bash
npm run format
npm run lint
npm run typecheck
```

Run only targeted Vitest files; **do not run the full test suite locally**.

A successful build is not native acceptance. Qualify the actual packaged application, including generated-pet image conversion and right-click menu dismissal after one outside click. A minimal native menu probe is not substituted for that product path. The runtime requirements and known limitations in [packaging](packaging.md#native-runtime-contracts) remain part of qualification.

### Packaged macOS application

To exercise an unpacked application, including its renderer, daemon, bundled Node SDK, CLI, and terminal, use this entry point with a runtime that exposes a CDP debugging endpoint:

```bash
node packages/desktop/e2e/packaged-app-smoke.js --app "$PWD/packages/desktop/release/mac-arm64/OMP Desktop.app"
```

Cold-start checks wait for worker readiness before requiring `running` and `reachable`. The packaged smoke checks macOS Dock visibility, loads the Node SDK from an App copy outside the checkout, and verifies concurrent RPC sessions, the CLI/terminal path, and generated-pet image installation.

#### Native window-close interactions

Verify the packaged app with system mouse events, not direct `NSWindow.sendEvent` calls or a substituted close dialog:

```bash
swift packages/desktop/e2e/macos-window-close-smoke.swift \
  "packages/desktop/release/mac-arm64/OMP Desktop.app"
```

This requires macOS Accessibility, screen-capture and input-event permission. It uses isolated settings and a real managed daemon, checking Cancel, tray background/restore, and Exit through system mouse input and the original UI. It also checks equal traffic-light spacing, yellow-button minimization and Dock restore, and green-button enlargement followed by restoration of the actual size.

Known macOS host limitation: the optional pet overlay still requires the missing `BrowserWindow.setIgnoreMouseEvents` API. Activity publication was verified with the default hidden pet; this does not establish full overlay compatibility.

#### Locally repaired runtime regressions

On macOS, every renderer must service native AppKit application events even though it is a windowless `LSUIElement` process. JavaScript and daemon requests can remain live while Activity Monitor marks that renderer as not responding. Before packaging a locally repaired runtime, run its `test/macos-renderer-responsiveness-smoke.js` with the bundled `Electron.app`. The regression checks WindowServer responsiveness after targeted native events, sandbox isolation and renderer shutdown; changing Dock visibility or adding a JavaScript heartbeat is not a substitute for the native event loop.

For the [local idle-scheduling runtime](packaging.md#macos-runtime), run its `macos-idle-pump-smoke.js`, `macos-idle-visibility-smoke.js`, and `macos-threaded-animation-smoke.js` alongside the responsiveness regression. These regressions belong to the mini-electron checkout. Select the rebuilt runtime with `MINI_ELECTRON_DIST_PATH`; rebuilding only the frontend does not add the native changes. A visible animated homepage is still active GPU work, not a zero-CPU idle page.

#### Terminal trackpad scrolling

The macOS `0.1.21` runtime can deliver nonzero `WheelEvent.deltaY` with zero `wheelDeltaY`: its precise-wheel path leaves Blink's wheel ticks unset. xterm prefers the legacy field, so terminal scrollback ignores trackpad gestures while ordinary mouse-wheel input still works. The native repair populates ticks from the physical-pixel deltas divided by 120; Blink then applies display scaling to both DOM representations. Do not add a second frontend wheel handler.

Build the repaired mini-electron checkout with Python 3.12 or newer and `build.py --package-dist`. To install its validated distribution for development:

```bash
MINI_ELECTRON_DIST_PATH=/absolute/path/to/repaired/runtime-dist \
  npx mini-electron --update-runtime
npm run dev:desktop
```

For packaged builds, select the repaired distribution using the [packaging override](packaging.md#local-runtime-distributions); an already-installed application must be rebuilt/reinstalled, not merely have its frontend reloaded. This is an unpublished local runtime repair, not a new npm-installer version.

Run the runtime's `test/macos-precise-wheel-smoke.js` to check precise-wheel standard/legacy deltas in both directions on both axes, including one-pixel input, without requiring application focus. Native qualification must also exercise the production terminal runtime with scrollback: trackpad up reveals older rows, down returns toward the prompt, horizontal input does not scroll vertically, and an ordinary wheel still works without sending shell input. The existing `test/macos-scroll-smoke.js` hidden-window mouse-wheel assertion also fails on the unmodified `0.1.21` runtime (`0` versus `80` pixels); it is not counted as passing qualification for this repair. The broader pointer-interaction smoke additionally requires native window activation; failure to acquire focus is not a precise-wheel contract result.

### Packaged Windows application

Windows runtime builds disable Inspector/CDP, so the CDP-based `PASEO_DESKTOP_SMOKE=1` check is not supported there. Verify the real native window and bundled CLI/daemon instead; **do not enable Inspector or bypass IPC frame checks to pass a smoke**.

Run the actual unpacked Windows application on an unlocked interactive desktop:

```bash
node packages/desktop/e2e/packaged-app-smoke.js \
  --app packages/desktop/release/win-unpacked
```

The Windows driver uses a copied official runtime, isolated native profile paths, real renderer/preload/IPC/daemon/CLI/terminal/OMP, and synthetic numeric SQLite fixtures. It checks maximize/restore/minimize presentation, native resize-edge hit-tests, continuous restore-to-top dragging, companion assets and native menu input, and Chinese Usage ranges/refresh.

Native screen captures reject foreign-window overlap and use an owned opaque backing for transparent gaps. Only the copied main is temporarily topmost during window/Usage surface scenarios; its original native flag is checked after restoration and before companion tests. Other programs are never hidden, moved, or reconfigured. Input targets only verified owned windows; initial foreground acquisition does not loosen OS foreground policy or force repaint during restore measurements.

The continuous titlebar regression requires a safe native `HTCAPTION`, then uses one physical left-button press to drag a maximized window into its restored state and back to the current monitor's top edge. It records button state, window bounds, and the owned GUI thread's system move-loop state while held, then requires native maximization after release. It aborts on foreground/input contention, releases only its injected button, and restores the cursor only if the user has not taken it over. Keep the desktop unlocked and avoid mouse/keyboard input during this check.

The gesture trace proves continuous native dragging and release-to-Snap, not visual animation quality: it does not capture transition pixels, inspect the Snap preview, or exercise physical titlebar double-click or cross-monitor mixed-DPI transitions. Existing browser tests cover scoped interactive no-drag regions and top-corner resize regions. Inspect transient restore frames separately when investigating ghosting; settled screenshots alone cannot establish a clean transition.

Pet input waits for genuine, authenticated interactivity IPC to transition from an outside false state to a fresh true state for the same run, process, and pet HWND. The passive observer discards superseded events and never changes input state or opens the menu itself. Native ownership and `HTCLIENT` are safety checks, not proof that the runtime has stopped ignoring mouse events. Upstream contract failures remain failures, not skipped or replaced by mock bridges.

Windows runtime 0.1.15 has an observed [electron-log renderer-preload redeclaration issue](https://github.com/iris-cat-dev/mini-electron/issues/5). The native smoke retains this error; passing the application scenarios does not prove that renderer logging initialized successfully.

#### Native Explorer-file clipboard

Windows Explorer file paste requires the mini-electron `nativeClipboardFiles` capability described in [packaging](packaging.md#windows-runtime-version-and-local-overrides). Build that repaired checkout on Windows x64 and run its real native scenarios before selecting it for a Desktop package:

```powershell
python build.py --package-dist -j 2
out/windows-x64/runtime-dist/electron.exe --app=test/windows-native-input-smoke.js
out/windows-x64/runtime-dist/electron.exe --app=test/windows-clipboard-image-smoke.js
```

Then exercise the real Composer: single/multiple Explorer files, mixed PNG + text, Chinese/spaced names, busy-state paste, and ordinary text. Retain the sandbox, frame/document and clipboard-sequence identity checks; do not substitute reading text paths or enabling Windows Inspector. Native macOS `macos-clipboard-editing-smoke.js` checks the unchanged image/editing path but cannot qualify Windows `CF_HDROP`, a Windows installer, or the Composer's end-to-end behavior.

#### Renderer-loss recovery

To exercise renderer-loss recovery on Windows with a freshly built local runtime:

```powershell
npm --prefix packages/desktop run build:main
$env:ELECTRON_PATH = "D:/Project/mini-electron/out/windows-x64/mini-electron.exe"
node packages/desktop/e2e/renderer-loss-recovery-smoke.js
Remove-Item Env:ELECTRON_PATH
```

Choose **Reload window**, then click **Verify interaction** in the replacement. The smoke uses a temporary profile and terminates only its own renderer child; it does not use an existing Desktop process or require Inspector/CDP.

### Local monitor native regression

```bash
npm run build:main --workspace=@omp-desktop/desktop
node packages/desktop/e2e/local-monitor-smoke.js
```

This Windows surface smoke copies the configured official mini-electron runtime into an owned temporary profile and uses the real product controller, both production preloads, HTML, collector, and worker with synthetic numeric OMP files. It exercises a transparent orb plus separate dashboard/history/settings panels: original instruments and dark/porcelain pixels, nine title themes, four effect levels, measured-completion/peak feedback, independent project scopes, eight-orb capacity, hidden/click-through recovery, native pinning/menu/geometry, full and selected-date CSV, 38 offline currencies, worker failure, missing sources and cold reopen.

The native file-dialog driver modifies only the unique filename edit and Save button of a dialog owned by that disposable runtime; it never changes the system clipboard or another application's controls. Hit-policy checks use owned native pointer IPC plus Win32 point routing between two owned runtime processes, with both interactive and passthrough controls. Two desktop pixels are sampled only over an owned solid backdrop to check transparent corners and a still-visible instrument; the observer uses physical screen coordinates in its own subprocess. Positioning uses owned `BrowserWindow.setBounds`, real begin/end-drag commands and persisted reopen, not physical mouse dragging. Reduced motion uses a reversible fixture on the owned renderer's cached `MediaQueryList`, exercising its real change listener and art path without requiring CDP or changing operating-system preferences.

Native compositor captures check original-sized transparent viewports, alpha-zero corners and painted instrument pixels, not just text or DOM attributes. GPU observations also include the detached shared thumbnail owner; static thumbnails must not evict live orb contexts. These checks do not establish the original project's CPU/GPU benchmark budgets.

No provider credentials, daemon, or model requests are used. This is monitor-surface qualification, not a complete installer, upgrade, or packaged-application acceptance run.

Programmatic DOM clicks do not qualify native panel input. When the user's mouse and focus must remain available, use a fresh, non-input Win32 desktop without switching to it, isolated profiles, exact owned HWNDs and directed native mouse messages. Observe trusted DOM events, actual navigation and persisted preferences; check caption `WM_NCHITTEST = HTCAPTION` separately from control `HTCLIENT`. A geometry setter is not an OS caption-drag test. Report physical dragging and current-desktop hardware routing as untested when no physical input is permitted.

For settings clipping regressions, use the real 800×680 viewport and native wheel messages to reveal the complete martial-arts title-card caption, `name-mode` and `title-theme`. Require the actual `settings-scroller` to have `overflow-y: auto` and a viewport-bounded client height; an overflowing body or an `overflow: hidden` ancestor is not a replacement scroll port. Check trusted pointer sweeps leave ordinary UI labels unselected while existing attribution/license selection remains possible without clipboard access.

For Orb-tab navigation, observe actual shared WebGL context/program identities across repeated General↔Orb switches. A zero-lease preview pool is cached but idle: hidden previews must not draw, returning to Orb must not recreate the context or recompile its programs, and independent live orbs must continue rendering. Renderer teardown destroys instances before disposing the shared cache. Distinguish native-driver round-trip time from click-to-frame timing and hardware presentation latency; invalid or negative raw RAF timestamp differences are not usable latency samples.

Selector acceptance requires a pointer-opened, visibly painted option list and a pointer-selected real option. A focus ring or a value changed only with the keyboard does not qualify popup expansion. Cover all Monitor and History selectors, all 38 currencies including off-screen options, Escape/outside cancellation, reopening, live state arriving while a list is open, saved values and subsequent navigation. Bind the run to the extracted installer's exact compiled modules and verify that the in-document picker creates no separate native popup window. Physical-mouse runs need explicit user permission and must abort on unrelated input, foreground changes or foreign-window occlusion; never target the user's installed application.

For redraw regressions, drive the production collector with owned numeric JSONL, including a large backfilled file and many project scopes. Measure incoming state messages and option/ladder mutations separately from trusted click-to-frame callbacks; do not substitute a prebuilt snapshot or infer hardware input latency from those callbacks. Also visit the lazily rendered Cost/Orb/Data pages, change a currency, persist it, and verify a real project filter reduces the displayed usage. A worker publication is one scoped batch: an obsolete scope entry must not discard valid sibling entries from the same poll.

Set `PASEO_DESKTOP_SMOKE_ARTIFACT_DIR` to retain its numeric report and native compositor PNGs elsewhere. Focused filesystem/pricing/lifecycle/CSV/resource regressions are under `packages/desktop/src/monitor`; run that directory only, not the full repository suite. The pricing tests use deterministic transports; a separate real public-data exercise is needed to qualify live network availability.

### Companion layout regression

After building the workspace dependencies, run the companion's native regression:

```bash
npm run build:main --workspace=@omp-desktop/desktop
node packages/desktop/e2e/pet-layout-smoke.js
```

The smoke briefly opens a non-focusing companion with an isolated temporary profile. It covers changing captions and task counts, all three sizes, main-window zoom, viewport changes, and opaque/transparent pointer targets without calling a model. It uses an owned copy of the installed official Windows 0.1.15 runtime; stock Electron and legacy renderer-result wrappers are not used as fallbacks.
