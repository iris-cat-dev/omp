# OMP Desktop

An Electron and Web client for [Oh My Pi](https://github.com/can1357/oh-my-pi). It runs a private daemon on your machine and talks to `omp --mode rpc-ui` through OMP's native JSONL RPC protocol. Web clients can control a remote daemon through a self-hosted, end-to-end encrypted relay.

Current source version: **0.4.1**.

## Requirements

- Node.js from `.tool-versions` and npm workspaces for development and source builds
- `omp >= 16.3.9` on `PATH` for development and standalone daemon runs
- A configured OMP model provider

Packaged macOS, Linux, and Windows applications include OMP and do not require a system OMP installation.

**Host Settings → Agents** reports the version, source, and path of the exact OMP executable used
for Agent sessions. Update checks and installs target that same executable. Packaged applications
label their bundled runtime separately from standalone, configured, and `PATH` installations.

## Completing conversations

After OMP finishes a model turn and reports that it is no longer streaming or compacting,
Desktop completes the turn automatically; **Stop** is for interruption, not acknowledgement.
OMP's internal `developer` messages, including project-rule reminders, are accepted in
completion events and RPC history without appearing as user or assistant chat messages.
Reopening a saved conversation likewise keeps these reminders out of the visible history.

If an older Desktop build remains running after the final answer, update Desktop and restart
its daemon after saving any active work. Updating only the bundled OMP executable does not
update Desktop's RPC adapter.

## Enhanced workflow

Select **Enhanced**, identified by the Sparkles icon in the workflow menu, to keep
model-request failures running automatically. Both **Standard** and **Enhanced**
continue responses that reach the model's output-length limit.

When OMP reports a terminal model-request error with HTTP status **400–599**,
Enhanced waits **five seconds** and sends a localized **Continue** message
(`继续` in Chinese). Every 4xx and 5xx status is eligible, including invalid requests,
authentication failures, rate limits, and server errors. Repeated errors repeat this
wait with no attempt limit or increasing backoff; non-HTTP errors remain terminal.

The conversation stays active until a continuation succeeds or is stopped.
**Stop**, closing the session, or leaving Enhanced prevents pending continuations.
OMP's internal request retries are unchanged; the five-second wait starts after OMP
reports the terminal error, not after each internal HTTP attempt.

## Switching approval modes

Select **Full access** in a running conversation to approve its pending and subsequent
OMP tool requests automatically. The daemon sends the native approval response without
restarting the conversation or changing OMP's immutable launch-time approval flags.
Automatic approval does not depend on an open client. Questions and plan confirmations
still require an explicit answer.

Switching back to the approval mode used when the current OMP process launched stops
automatic approval and restores its native behavior. Other approval-mode changes still
require a new session; a process launched with **Full access** cannot enable native
approval prompts by switching to **Always ask** or **Write approval**.

## Saving images in the mobile Web client

Long-press an image in the conversation or its fullscreen preview and choose the browser's
save-image action. Desktop browsers can use the image's right-click menu. Raster image
attachments stored in the Web client's IndexedDB use self-contained data URLs instead of
blob URLs, preserving the original bytes for browsers whose image-saving menus cannot
resolve blob URLs. Non-image attachments retain revocable blob previews.

## Stopping conversations and subagents

The conversation's **Stop** button interrupts its current run and all running managed descendants,
including children still active if the parent turn finishes while the stop request is processed.
Detached agents are independent and are not stopped. The subagent list also has a **Stop** button
on each running child; stopping a child leaves it in the list, unlike archiving it.

OMP-native subagents require OMP **18.4.9 or newer** for individual or parent-initiated cancellation
(`cancel_subagent` RPC). With an older OMP binary, the daemon reports that the native child could
not be stopped and keeps it marked running rather than claiming success. Update OMP through Host
Settings, or run `npm run download:omp` before packaging a desktop build. The general minimum OMP
version above still applies when native-subagent stopping is not needed.

## Guiding a running conversation

The composer defaults to **Steer** while a conversation is running. A steer guides the active turn
without canceling it or its managed descendants. The submitted message remains visibly pending
until OMP emits the canonical user-message event that confirms the model consumed it; an RPC
acknowledgement alone only confirms admission.

If the active provider cannot accept steering, Desktop reports the send failure and leaves the
current turn running. Agent-to-agent prompts and completion notifications use the same
non-destructive rule rather than falling back to replacement.

## Answering grouped questions

When OMP asks several questions together, use the labeled question tabs to move between them in
any order. Selections and typed answers remain intact while switching. After every required
question has an answer, **Submit** sends the complete group.

## Permanently deleting conversation history

Desktop-injected agent tools distinguish four operations: `cancel_agent` stops a run,
`archive_agent` hides a conversation while retaining history, `kill_agent` terminates a
loaded runtime while retaining its record, and `delete_agent` permanently removes the
Desktop conversation record and retained timeline.

Use `delete_agent({ agentId, confirm: true })` only after explicit user authorization.
It supports loaded, archived, and unloaded records without loading a provider session.
The result is `deleted` or `not_found`; runtime-close and storage errors are reported as
failures rather than successful deletions. The calling agent and its managed ancestors
cannot be deleted through this tool.

Connected clients refresh their directories and history/search caches after deletion.
Project files, deliverables, workspaces, Git worktrees/branches, and provider-owned session
files are not deleted. This tool removes Desktop history, not the provider's independent logs.

## Zhipu Coding Plan usage

The built-in `zhipu-coding-plan` provider reuses API keys saved through OMP sign-in.
Each enabled stored key has its own labelled usage entry; a rejected key does not
hide another key's available quota. No `models.yml` entry is required for built-in usage.
For a custom China Zhipu provider, configure its `baseUrl` (for example,
`https://open.bigmodel.cn/api/coding/paas/v4`) and `apiKey` in OMP's `models.yml`;
Desktop retains the custom provider name.
The sidebar, active model's context tooltip, and Host Settings usage page show the
quota windows reported by Zhipu: five-hour, weekly when present, and MCP/tool calls.
Both token-based `TOKENS_LIMIT` and credit-based `CREDIT_LIMIT` responses are supported.
Percentages show **used quota**; missing percentages remain unknown rather than
implying an unused quota. Reset times appear only when supplied by the service.

Desktop queries the China service's official-plugin monitor endpoint on
`https://open.bigmodel.cn` with the raw API key and does not follow redirects.
This does not add support for the separate `api.z.ai` service or arbitrary
OpenAI-compatible `/v1/usage` endpoints. Usage lookup failures do not change model
availability or interrupt inference.

## Codex quota and reset cards

Open **Host Settings → Model providers → Signed-in providers** to view each Codex account's
five-hour and weekly quota windows. Desktop identifies windows by their reported durations;
when durations are absent it retains the legacy plan/window mapping. A five-hour window
is shown only when its usage or reset time is reported, including for Pro accounts.
Codex percentages show **remaining quota**; unknown usage is never treated as 100% remaining.
The context tooltip lists labelled accounts rather than guessing an account from the provider
namespace alone. Settings and the sidebar show live compact reset countdowns such as
`3d21h` and `2h12min`. At the deadline, Desktop refreshes server usage and shows an
awaiting-refresh state rather than assuming the quota reset.

Each account lists its banked Codex reset cards, server-reported available count, status,
and grant/expiry timestamps with a timezone. **Use reset card** asks you to confirm the selected
account, card, and applicable quota windows. Only available, unexpired `codex_rate_limits` cards
can be submitted. The daemon rechecks the card with OpenAI before consuming it and preserves the
redemption request ID; duplicate submissions do not intentionally spend another card. A confirmed
server result refreshes both cards and quota. Errors and already-redeemed/nothing-to-reset results
are displayed separately from a successful reset. Older daemons cannot consume cards.

Subscription validity is separate from quota resets. Desktop displays a timezone-qualified
`chatgpt_subscription_active_until` claim when the current OAuth credential supplies one.
Otherwise it queries the official Codex [`/backend-api/wham/accounts/check` account source](https://github.com/openai/codex/blob/a5130128697b10022a88e8f5eae6dca77393b4b0/codex-rs/backend-client/src/client.rs#L398-L407),
matching the selected account ID rather than using the default workspace. If the response
includes subscription entitlement expiry, Desktop displays that reported date and live remaining
time, with its source labeled separately from token metadata. Neither is an auto-renewal guarantee.

Current Codex OAuth responses can contain only account/plan information, with no subscription
date. Desktop explicitly reports that this sign-in does not support expiry lookup; a successful
entitlement response with no date instead reports **Subscription expiry unavailable**. HTTP,
network, malformed-response, and timeout failures report **Could not query subscription expiry**
without discarding independently available quota/reset cards. None of these states means no
subscription or an expired subscription. **No subscription** requires a reported Free plan or
an explicit inactive entitlement without an expiry; Desktop never substitutes OAuth expiration,
quota reset times, or a fabricated `0`.

ChatGPT browser billing has a separate authentication boundary. Desktop does not scrape browser
cookies or send Codex credentials to the old browser-only account endpoint; check ChatGPT billing
settings when the current sign-in does not provide a date.

## OMP built-in tools

Open **Host Settings → Agents → OMP built-in tools** to request a tool list for new or resumed sessions. The tool list starts collapsed; expand it to edit switches, request all off, or reset. Choices are saved per host. Desktop passes `--no-tools` when every tool is switched off, or `--tools <enabled names>` for a partial selection; resetting removes the extra tool flag. Known releases use their tool catalog; other versions use the combined known tool list without a version whitelist. Desktop checks native `--tools`/`--no-tools` support instead of rejecting an unfamiliar release. Checkpoint and rewind share one switch. Running sessions do not change.

This is not a strict denylist: OMP may automatically add tools excluded from `--tools` or even `--no-tools`, and child agents may use a different tool list. Builds reporting the same version may also expose different tools; for a partial selection, Desktop briefly starts an ephemeral OMP session to request only tools in that build's current active roster. OMP's own settings may disable selected tools. These controls do not change standalone OMP sessions or Desktop-injected tools and extensions, and do not replace filesystem permissions or approval rules. Custom OMP commands cannot combine this setting with their own `--tools` or `--no-tools` flags. No custom OMP build is required for supported versions.

## OMP plugins

Open **Host Settings → OMP plugins** to browse registered marketplaces and manage OMP runtime
plugins. Marketplace entries show **Install** when not installed, **Installed** when already
current, and **Upgrade** when the catalog has a newer version. Upgrade installs the catalog's
current version rather than repeating the install operation.

Installed entries are matched by their exact `plugin-name@marketplace-name` identity, so a plugin
with the same name from another marketplace does not count as installed. Upgrades target that
exact identity and preserve the existing user or project scope and enabled/disabled state.

## Image generation with references

When image generation is enabled in Host Settings, the `image_gen` tool can generate an image
from text alone or use one to sixteen local PNG, JPEG, or WebP files as ordered reference images.
Reference paths may be absolute or relative to the agent workspace. Prompts should identify each
reference by its list position when the images have different roles, such as subject, composition,
or style. Calls with references use the provider's image-edit endpoint; text-only calls continue to
use image generation.

## Image previews

Images in assistant messages, including `image_gen` and `present_image` previews, show a
**View full screen** button in the image's top-right corner once loaded. The preview fills the
app window while preserving the image's aspect ratio. Use the close button or **Esc** to return
to the conversation. Loading and failed images do not show the full-screen button.

Workspace file tabs preview ICO (`.ico`, case-insensitive) icons as images, alongside PNG, JPEG,
GIF, WebP, and SVG files, rather than showing the binary-file placeholder.

## Official provider account numbers

Each official provider assigns its OAuth accounts stable, provider-local numbers. Deleting
an account releases its number; the next account receives the smallest free positive number.
Remaining accounts keep their numbers across reordering and daemon restarts. Settings,
account selectors, and usage cards use these numbers when an account has no name or note.

Account numbers are separate from OMP's globally increasing credential IDs. Desktop stores
the number mapping in `agent.db` without renumbering credentials or changing existing notes,
provider configuration, or session references. OMP's disabled credential records remain
disabled; releasing a display number does not reactivate or reuse an old credential.

## Model catalog refresh

Updating OMP, saving its provider configuration, or logging in or out refreshes the affected provider's catalog globally and in every previously loaded workspace. Workspace catalogs remain workspace-scoped. Open clients receive the refreshed result, or a terminal unavailable/error status, without reopening the model picker or reloading the application.

Browser OAuth refreshes these catalogs as soon as OMP confirms authorization; clicking
**Complete sign-in** again is not required. The sign-in panel closes automatically and the
provider's signed-in state updates. Providers that request an OAuth code or redirect URL
still support entering it and completing sign-in manually. Catalog refresh does not switch
an existing conversation's selected model.

## Conversation setting feedback

Changing Fast mode in an existing conversation adds a system notice after OMP confirms the
state changed. Switching models adds the same kind of notice with the selected model ID,
but only after the conversation has received a user message. Selecting a model before
the first message does not add a notice. Notices use centered, muted text with an
information icon and separator lines, not user or assistant message bubbles. They remain
in conversation history after reloading and are not sent to the model. Failed requests,
unchanged settings, and initial draft preferences do not add switch notices.

## Assistant turn statistics

Completed assistant turns show duration, completion time, total tokens, and average output
speed in the app's selected language. Completion time stays visible alongside duration;
hovering or tapping is not required. Weekdays and dates follow the selected language, while
the clock retains the system's 12/24-hour preference. Missing metadata is omitted independently,
and the footer wraps on narrow screens. Running-turn duration and output speed use the same
localized units.

## Conversation names

Rename a conversation from its tab's context menu. Renaming the workspace's primary conversation changes the workspace name; additional conversations keep their own titles. Accepted renames update the local tab title immediately, without waiting for a directory event. Saved names remain visible when switching tabs, including when a conversation is not loaded or its provider history is unavailable.

Each tab reads its title and chooses its rename target from the conversation's own workspace,
including when conversations from multiple workspaces are hosted in the same tab container.
Changing tabs or pane focus can change the tools' active workspace, but never a conversation's
primary-workspace identity or saved name.

Tab-width measurements do not own titles or selection state. The daemon publishes saved metadata changes for unloaded conversations, and loading a provider session preserves any rename made during initialization.

## Split conversation panes

Side-by-side conversations adapt to each pane's width rather than the desktop window's total
width. If an expanded task rail would leave less than a complete compact conversation and
composer, the rail and its toggle hide until that pane is wide enough again; its expanded state
is restored when space returns. Resizing or maximizing the window therefore keeps message text
and composer controls within each pane.

## Pinned conversation ordering

In project view, pinned conversations stay above unpinned conversations and can be dragged to
change their priority. The drop position is previewed before release, and the manual order is
stored locally across restarts, project switches, and sidebar collapse or expansion. Reordering a
pinned conversation does not open it or change the order of unpinned conversations. Reordering is
disabled while a host or label filter hides part of the pinned list.

## Closing unused conversations

Closing the last empty conversation tab returns to the project creation page. On supported hosts, the daemon also archives the unused workspace record so it does not remain in the sidebar under its branch name. This does not delete project files or the project itself.

Cleanup preserves workspaces with agent history (including archived agents), live or pending resources, a custom title, pins, labels, or worktree ownership. Older hosts must be updated before automatic cleanup is available. An existing empty sidebar entry can be reopened and its empty tab closed to retry cleanup; entries are never bulk-removed merely because they are named `main`.

Opening a new conversation from the sidebar keeps the current header tabs visible. The draft still owns a newly created workspace for execution, while the existing workspace remains the tab host until navigation explicitly changes it.

Clicking a conversation notification reveals its tab in the current tab host on the same server,
preserving the other tabs, their order, and split panes. An unopened conversation is added there
without changing its owning workspace. Cold starts, notifications from another server, and
draft-only workspaces navigate to the conversation's own workspace instead.

## File drag and drop

- Drop files onto the message input to add attachments without sending a message.
- Drop external UTF-8 text files onto the conversation history or other ordinary areas to open local, read-only file tabs, not a dialog. Each tab offers **Preview / Source** modes; Markdown and HTML render in Preview mode. Files are not uploaded.
  - Outside a workspace, files open on a dedicated preview page with file tabs.
  - Preview tabs and their contents are session-only. Switching tabs retains the selected mode; closing a tab releases its content, and reloading removes local preview tabs.
- Local text previews support files up to 2 MiB, including extensionless files. Directories, binary files, and larger files show an explanation instead.
- Terminal surfaces keep their existing file-path drop behavior.

## Text editor shortcuts

In an editable source tab, press **Ctrl+/** to comment or uncomment the selected lines. **Cmd+/**
continues to work on macOS. The editor uses the comment syntax of the current file type.

Right-click a file tab on the local desktop host to reveal the file in **Finder** (macOS),
**Explorer** (Windows), or **Files** (Linux). The action follows the app's selected language
and is unavailable for remote-host files and web clients.

Desktop editor targets expose only their ID, label, and kind. Editor detection and opening
do not depend on bundled editor icon images.

## Assistant message links

HTTP(S) links open externally. Text/source links open in the workspace file panel. On the local desktop host, links to existing images, documents, archives, and directories inside the workspace open with the operating system; executable files are shown in the file manager rather than launched. Web conversation headings support native `#heading` navigation.

Targets that cannot be opened are plain text rather than colored links, and clicking one shows an unsupported-link error. Failed file or URL opens also show an error. A `sandbox:` URL is not a local file path: conversation data does not contain an authoritative mapping to an attachment on this host, so those links cannot open until such a mapping is provided. Remote-host binary files likewise cannot be opened by the local desktop file manager.

On desktop, right-click an HTTP(S) conversation link to open it in the system browser or copy its address. Unsupported schemes do not receive an open action, and an unavailable plain **Copy** action is omitted. Read-only images offer image-specific actions without an ambiguous **Paste** action; editable targets still expose **Paste** according to their current edit capability. Native context menus follow the app's selected language.

On the local desktop host, right-click a resolvable workspace file link to reveal it in the system file manager (Explorer on Windows), without opening or executing it. Relative paths, URL-encoded names, and line suffixes use the same resolution as left-click. Remote-host links do not offer local reveal; missing targets and paths outside the workspace, including symlink escapes, are rejected with an error. Left-click behavior is unchanged.

## Assistant message math

Assistant Markdown renders inline formulas delimited by `$...$`, `\(...\)`, or same-line
`\[...\]`. Display formulas use standalone `$$...$$` or `\[...\]` blocks; these blocks also work
inside Markdown quotes and lists. Explicit `\vec{v}` notation renders with both a vector arrow and
a bold symbol, while `\mathbf{v}` remains available for bold-vector notation.

## Thinking and tool calls

Collapsed activity groups show their item count in a compact, theme-aware pill with a layers icon. The count updates as activity arrives; expanding the group hides the pill and reveals the individual items.

## Background processes

Background commands started by the current Agent appear beside the workspace branch under the composer. The indicator shows the active count; opening it lists live and recently completed commands. Select a command to open its read-only terminal output in a bottom pane, or use **Stop** to terminate that command. Closing the output pane does not stop the process. Stopping the current Agent response terminates that Agent's running background commands and suppresses their late completion events; reconnecting restores retained process state and output.

## Independent agent conversations

Agent-scoped `create_agent` calls create a child agent in the caller's workspace by default.
Each workspace can have only one unarchived independent root conversation. To start another
independent conversation, call `create_workspace` first, then call `create_agent` with
`detached: true` and the new `workspaceId`. Normal child agents remain in their parent's
workspace.

For workspaces created by older versions with multiple active roots, selecting the workspace
restores every root as a tab and focuses the one needing attention. The workspace menu lists
those conversations and lets users open or archive each one without visiting global history.
Archiving preserves conversation history. Sharing a workspace does not isolate concurrent file
edits.

`notifyOnFinish: true` can notify the creator when an independently created agent finishes,
fails, or needs permission without establishing a parent relationship. Notifications do
not revive an archived creator. Regular child agents retain parent-owned notifications,
which stop if the child is subsequently detached.

## Development

```bash
npm install
npm run dev:desktop
```

The syntax highlighter pins `@codemirror/legacy-modes` to `6.5.3`, whose Swift and
Dart stream parsers use the same CodeMirror 6 language types as the application.
Keep this pin when updating dependencies; `6.5.5` uses incompatible streamparser types.

Development uses:

- daemon: `127.0.0.1:6770`
- renderer: an available Electron Metro port
- state: `.dev/omp-desktop-home`

The packaged app uses `~/.omp-desktop`. OMP keeps its own configuration, credentials, provider subscriptions, and sessions under `~/.omp`.

## SSH remote hosts

The Electron app can provision a remote daemon from **Settings → General → Add host → Connect via SSH**. It uses the system OpenSSH client, including `~/.ssh/config`, agent identities, `ProxyJump`, host-key verification, passwords, passphrases, and MFA prompts.

SSH is used only to inspect the host, upload the version-matched backend, start the daemon, and obtain its pairing offer. After pairing, SSH closes and the app connects through the configured end-to-end encrypted Relay. The remote daemon remains bound to `127.0.0.1:6770`; do not expose that port to the Internet.

Supported remote targets are glibc Linux and macOS on x64 or arm64. The remote account needs:

- a POSIX shell, `tar`, and either `curl` or `wget`;
- outbound HTTPS access to `nodejs.org` and the npm registry;
- write access to its home directory.

No root access is required. Managed runtime files are installed under `~/.omp-desktop/remote-runtime`, while daemon identity and state remain under `~/.omp-desktop`. OMP itself is installed separately from the paired host's settings.

Remote releases are staged and checksum-verified before an atomic switch. Failed starts roll back to the previous managed release. Hosts provisioned this way update through **Host Settings → Update daemon → Update via SSH** because the workspace packages are bundled with the Desktop application rather than installed from the public npm registry. Removing a Host from the app forgets its local SSH management profile but does not stop or delete the remote daemon.

SSH passwords, private-key passphrases, MFA responses, and pairing links are never persisted. The local management profile stores only the SSH target fields, identity-file path, remote runtime path, server ID, and deployed version. Remote Windows and musl-based Linux distributions such as Alpine are not supported.

## Build

```bash
npm run build:desktop -- --dir
```

The macOS arm64 application is written to:

```text
packages/desktop/release/mac-arm64/OMP Desktop.app
```

Desktop packaging keeps build/test-only dependencies out of the production dependency graph and
excludes third-party TypeScript sources, declarations, and MCP SDK examples from the ASAR.
Standard packages retain the bundled OMP executable, runtime workers, shell integration, and
the target platform's native bindings. Windows ConPTY files are loaded from the matching
node-pty prebuild, not its duplicate `third_party` directory.

The Electron language allowlists retain all nine application languages and common regional
variants. macOS also retains each selected language's grammatical-gender `.lproj` variants.
Update both platform allowlists in `packages/desktop/electron-builder.yml` when adding a language.

The frontend Babel pipeline resolves Lucide's actual named exports to individual icon modules,
including legacy aliases; public type imports remain unchanged. Electron web exports use UTF-8
instead of ASCII-escaped strings. Protocol validator generation shares repeated, non-mutating
IR containers without removing validation, defaults, transforms, or fallback schema behavior;
see `packages/protocol/codegen/README.md`.

For local installer builds, pass `--publish never` to avoid uploading release artifacts. To
exercise an unpacked application, including its renderer, daemon, bundled OMP, CLI and terminal:

```bash
node packages/desktop/e2e/packaged-app-smoke.js --app "packages/desktop/release/mac-arm64/OMP Desktop.app"
```

For a local test package, run:

```bash
npm run build:mac
```

Without notarization credentials this produces an unsigned package and prints a warning. Gatekeeper
will reject that package unless quarantine is explicitly removed on the test Mac.

macOS signing uses electron-builder's bundled entitlement template for the app and
helpers; no separate entitlement files are required in `packages/desktop/build`.

For a signed, notarized release, the build machine needs a valid `Developer ID Application`
certificate (or `CSC_LINK`) and one of electron-builder's notarization credential sets:

- `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` (recommended);
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`; or
- `APPLE_KEYCHAIN_PROFILE`, with optional `APPLE_KEYCHAIN`.

When those credentials are present, the script verifies the application's code signature, stapled
notarization ticket, and Gatekeeper assessment after packaging.

Windows installers are produced in separate electron-builder invocations. Build one architecture with:

```bash
npm run build:windows:x64
npm run build:windows:arm64
```

Run `npm run build:windows` to build both sequentially. Publish the resulting `OMP-Desktop-Setup-<version>-x64.exe` and `OMP-Desktop-Setup-<version>-arm64.exe`; no combined installer is produced.

Windows daemon and CLI process-tree cleanup launch `taskkill.exe /T /F` directly with a hidden
console, avoiding transient `cmd.exe` windows during provider refresh and process shutdown.
Interactive terminal launches are unchanged. macOS and Linux retain signal-based tree cleanup.

Desktop updates use the public
[`iris-cat-dev/omp-desktop` GitHub Releases](https://github.com/iris-cat-dev/omp-desktop/releases)
feed. The app checks its configured Stable or Beta channel at startup, downloads a newer package in
the background, verifies the SHA-512 value from electron-builder's update metadata, and installs it
when the user chooses **Install & restart** or next quits the app.

Every release must upload the updater metadata and payloads generated from the same build:

- macOS: `OMP-Desktop-<version>-<arch>.dmg`, the matching `.zip`, and the channel metadata
  (`latest-mac.yml` for Stable or `beta-mac.yml` for Beta);
- Windows: both architecture-specific `.exe` installers, their `.blockmap` files, and the merged
  channel metadata (`latest.yml` for Stable or `beta.yml` for Beta);
- Linux AppImage releases: the AppImage, its blockmap, and the matching `*-linux.yml` metadata.

`build-windows.sh` merges the x64 and arm64 metadata so `electron-updater` selects the installer
matching `process.arch`. A GitHub Release that only contains DMG or EXE files remains available for
manual download but cannot be installed by the in-app updater. Publish the generated files only
after every target for that release is complete; do not use `--publish always` during the individual
Windows architecture builds because it can publish incomplete channel metadata.

To build Windows packages without shipping a new OMP executable, run:

```bash
npm run build:windows:no-omp
npm run build:windows:no-omp:x64
npm run build:windows:no-omp:arm64
```

These artifacts use `OMP-Desktop-No-OMP-Setup-<version>-<arch>.exe` names so they do not overwrite
the standard installers. The application still includes its daemon and CLI; only `omp.exe` is
omitted.

A fresh `no omp` installation uses `omp` on `PATH`. When switching from an installation with
`resources\bin\omp.exe`, the NSIS installer backs up that existing executable before invoking
the old uninstaller, then restores the exact file into the selected installation directory.
This also preserves an independently updated bundled runtime and works when changing the
installation directory. Repeated `no omp` installations retain it; switching back to the
standard installer replaces it with that package's bundled runtime.

If the existing runtime cannot be backed up, installation stops before removing the previous
version. If restoration fails, installation reports the location of the retained backup.
The `no omp` ZIP payload itself still contains no OMP executable.

Run the installation-switch regression on a clean Windows VM, with standard and `no omp`
installers for the same version and architecture:

```powershell
node packages/desktop/e2e/windows-installer-switch-smoke.js --standard "packages/desktop/release/OMP-Desktop-Setup-<version>-<arch>.exe" --no-omp "packages/desktop/release/OMP-Desktop-No-OMP-Setup-<version>-<arch>.exe"
```

The smoke refuses to run if Desktop is already registered. It checks fresh installation,
switching to `no omp`, repeated installation with a changed directory, and switching back.
It verifies the preserved executable's SHA-256 and runs the packaged renderer, daemon, OMP,
CLI, and terminal checks after the `no omp` upgrades. Wine checks do not replace this real
Windows installation and startup verification.

Download and checksum-verify the latest supported OMP binaries:

```bash
npm run download:omp
```

Specific targets can be refreshed without downloading every architecture:

```bash
npm run download:omp -- linux-x64 linux-arm64
```

The script writes these release assets to the repository-root `bin/` directory:

- `omp-darwin-arm64`
- `omp-darwin-x64`
- `omp-linux-arm64`
- `omp-linux-x64`
- `omp-windows-arm64.exe`
- `omp-windows-x64.exe`

electron-builder selects the target architecture and installs the executable as `Resources/bin/omp` on macOS, `resources/bin/omp` on Linux, or `resources/bin/omp.exe` on Windows.

### Bundled skills

The repository-root `skills/` directory is the source catalog for bundled orchestration skills. During the server build, `packages/server/package.json` removes the previous `dist/server/skills` directory and recursively copies `../../skills` into it. This makes the same catalog available to the development server and packaged application.

The directory currently contains only `.gitkeep`, which keeps the otherwise-empty catalog under version control. Keep the `skills/` directory even when no bundled skills are present: removing it causes the recursive copy step to fail. Add future bundled skills as subdirectories containing their `SKILL.md` files.

## Self-hosted Web and relay

The default configuration enables the hosted Relay at `relay.paseo.sh:443` with TLS. Self-hosted deployments can replace that endpoint and do not otherwise depend on a hosted Paseo service.

### Build

```bash
npm install
npm run build:server
npm run build --workspace=@omp-desktop/cli
npm run build:web --workspace=@omp-desktop/app
```

The Web export is `packages/app/dist`. These commands build artifacts; they do not start the daemon.

### Cloudflare Pages

```bash
./deploy.sh
# or: npm run deploy:web
```

`deploy.sh` builds the Web export and runs `wrangler pages deploy` against project `omp-desktop` on branch `main`. Override with `CF_PAGES_PROJECT` / `CF_PAGES_BRANCH` if needed. SPA routes fall back through `packages/app/public/_redirects`. Pairing links should use the Pages origin as `app.baseUrl`.

Deploy the `paseo-relay` repository using its `deployment/self-hosted/compose.yaml`, `Caddyfile`, and `.env.example`. That deployment serves both your WSS relay and the Web export on your own domains, with automatic HTTPS and SPA route fallback. The relay machine does not need OMP or access to the daemon's private listening port.

### Configure the machine running OMP

Merge this configuration into `~/.omp-desktop/config.json`, retaining your other settings. Replace the example domains with those in the relay deployment:

```json
{
  "version": 1,
  "daemon": {
    "listen": "127.0.0.1:6770",
    "relay": {
      "enabled": true,
      "endpoint": "relay.example.com:443",
      "useTls": true
    }
  },
  "app": {
    "baseUrl": "https://omp.example.com"
  }
}
```

Start the backend, then obtain a pairing link in another terminal:

```bash
node packages/cli/bin/omp-desktop daemon start --foreground --no-web-ui
node packages/cli/bin/omp-desktop daemon pair --json
```

In the Web app, open **Settings → Connections → Relay server address**. It defaults to `wss://relay.paseo.sh:443`; replace it with `wss://relay.example.com` for a self-hosted deployment. Leave the setting empty only when the browser should use the relay address advertised by each pairing link. An already connected host can generate another link from **Settings → Host → Pair device**. Treat pairing links like passwords: anyone holding one can access that daemon. Legacy placeholder identities require re-pairing after upgrading.

The daemon initiates the outbound connection; do not expose port `6770` to the Internet. Keep `PASEO_APP_BASE_URL` / `app.baseUrl` pointed at your own Web deployment so generated links open the right client.

Environment overrides, useful when the daemon and browser reach different sides of a reverse proxy:

| Environment variable          | Config field                  | Purpose                                                         |
| ----------------------------- | ----------------------------- | --------------------------------------------------------------- |
| `PASEO_RELAY_ENABLED`         | `daemon.relay.enabled`        | Enable or disable Relay access                                  |
| `PASEO_RELAY_ENDPOINT`        | `daemon.relay.endpoint`       | Relay `host:port` dialed by the daemon                          |
| `PASEO_RELAY_USE_TLS`         | `daemon.relay.useTls`         | Outbound daemon TLS                                             |
| `PASEO_RELAY_PUBLIC_ENDPOINT` | `daemon.relay.publicEndpoint` | Browser-facing relay `host:port`; defaults to outbound endpoint |
| `PASEO_RELAY_PUBLIC_USE_TLS`  | `daemon.relay.publicUseTls`   | Browser-facing TLS; defaults to outbound TLS                    |
| `PASEO_APP_BASE_URL`          | `app.baseUrl`                 | Your Web origin in pairing links                                |

Use `true` / `false` for boolean overrides. Relay endpoints are authorities such as `relay.example.com:443`, without a scheme or `/ws` path. Public HTTPS Web deployments need WSS. Disabling TLS for a trusted local development relay does not disable E2EE.

The relay carries daemon WebSocket traffic, including workspace, agent, and terminal control. It does not tunnel arbitrary HTTP endpoints: file downloads and HTTP service previews still need their own reachable address.

## Workspace packages

- `packages/app` — Electron and Web renderer
- `packages/desktop` — Electron main process and packaging
- `packages/server` — local daemon and OMP adapter
- `packages/client` — daemon client
- `packages/protocol` — shared wire schemas
- `packages/relay` — shared E2EE relay transport
- `packages/cli` — `omp-desktop` CLI
- `packages/highlight` — code and diff highlighting

## Verification

```bash
npm run format
npm run lint
npm run typecheck
```

Run only targeted Vitest files; do not run the full test suite locally.

## License

AGPL-3.0-or-later. This project is derived from Paseo and retains its original Git history and license notices.
