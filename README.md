# OMP Desktop

An Electron and Web client for [Oh My Pi](https://github.com/can1357/oh-my-pi). It runs a private daemon on your machine and talks to `omp --mode rpc-ui` through OMP's native JSONL RPC protocol. Web clients can control a remote daemon through a self-hosted, end-to-end encrypted relay.

## Requirements

- Node.js from `.tool-versions` and npm workspaces for development and source builds
- `omp >= 16.3.9` on `PATH` for development and standalone daemon runs
- A configured OMP model provider

Packaged macOS, Linux, and Windows applications include OMP and do not require a system OMP installation.

## OMP built-in tools

Open **Host Settings → Agents → OMP built-in tools** to request a tool list for new or resumed sessions. The tool list starts collapsed; expand it to edit switches, request all off, or reset. Choices are saved per host. Desktop passes `--no-tools` when every tool is switched off, or `--tools <enabled names>` for a partial selection; resetting removes the extra tool flag. The list follows the installed OMP version (18.2.10 or 18.3.x), and checkpoint and rewind share one switch. Running sessions do not change.

This is not a strict denylist: OMP may automatically add tools excluded from `--tools` or even `--no-tools`, and child agents may use a different tool list. Builds reporting the same version may also expose different tools; for a partial selection, Desktop briefly starts an ephemeral OMP session to request only tools in that build's current active roster. OMP's own settings may disable selected tools. These controls do not change standalone OMP sessions or Desktop-injected tools and extensions, and do not replace filesystem permissions or approval rules. Custom OMP commands cannot combine this setting with their own `--tools` or `--no-tools` flags. No custom OMP build is required for supported versions.

## Image generation with references

When image generation is enabled in Host Settings, the `image_gen` tool can generate an image
from text alone or use one to sixteen local PNG, JPEG, or WebP files as ordered reference images.
Reference paths may be absolute or relative to the agent workspace. Prompts should identify each
reference by its list position when the images have different roles, such as subject, composition,
or style. Calls with references use the provider's image-edit endpoint; text-only calls continue to
use image generation.

## Model catalog refresh

Updating OMP, saving its provider configuration, or logging in or out refreshes the affected provider's catalog globally and in every previously loaded workspace. Workspace catalogs remain workspace-scoped. Open clients receive the refreshed result, or a terminal unavailable/error status, without reopening the model picker or reloading the application.

## Conversation names

Rename a conversation from its tab's context menu. Renaming the workspace's primary conversation changes the workspace name; additional conversations keep their own titles. Accepted renames update the local tab title immediately, without waiting for a directory event. Saved names remain visible when switching tabs, including when a conversation is not loaded or its provider history is unavailable.

Tab-width measurements do not own titles or selection state. The daemon publishes saved metadata changes for unloaded conversations, and loading a provider session preserves any rename made during initialization.

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

## Assistant message links

HTTP(S) links open externally. Text/source links open in the workspace file panel. On the local desktop host, links to existing images, documents, archives, and directories inside the workspace open with the operating system; executable files are shown in the file manager rather than launched. Web conversation headings support native `#heading` navigation.

Targets that cannot be opened are plain text rather than colored links, and clicking one shows an unsupported-link error. Failed file or URL opens also show an error. A `sandbox:` URL is not a local file path: conversation data does not contain an authoritative mapping to an attachment on this host, so those links cannot open until such a mapping is provided. Remote-host binary files likewise cannot be opened by the local desktop file manager.

On desktop, right-click an HTTP(S) conversation link to open it in a new OMP Desktop browser tab, open it in the system browser, or copy its address. Opening it internally preserves the current conversation and the URL's query, fragment, and encoding. Unsupported schemes never receive the internal-open action, and an unavailable plain **Copy** action is omitted. Read-only images offer image-specific actions without an ambiguous **Paste** action; editable targets still expose **Paste** according to their current edit capability. Native context menus follow the app's selected language.

On the local desktop host, right-click a resolvable workspace file link to reveal it in the system file manager (Explorer on Windows), without opening or executing it. Relative paths, URL-encoded names, and line suffixes use the same resolution as left-click. Remote-host links do not offer local reveal; missing targets and paths outside the workspace, including symlink escapes, are rejected with an error. Left-click behavior is unchanged.

## Assistant message math

Assistant Markdown renders inline formulas delimited by `$...$`, `\(...\)`, or same-line
`\[...\]`. Display formulas use standalone `$$...$$` or `\[...\]` blocks; these blocks also work
inside Markdown quotes and lists. Explicit `\vec{v}` notation renders with both a vector arrow and
a bold symbol, while `\mathbf{v}` remains available for bold-vector notation.

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

For a local test package, run:

```bash
npm run build:mac
```

Without notarization credentials this produces an unsigned package and prints a warning. Gatekeeper
will reject that package unless quarantine is explicitly removed on the test Mac.

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

To build Windows packages that rely on an `omp` installation on `PATH` instead of bundling the
OMP executable, run:

```bash
npm run build:windows:no-omp
npm run build:windows:no-omp:x64
npm run build:windows:no-omp:arm64
```

These artifacts use `OMP-Desktop-No-OMP-Setup-<version>-<arch>.exe` names so they do not overwrite
the standard installers. The application still includes its daemon and CLI; only `omp.exe` is
omitted.

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
