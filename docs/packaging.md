# Desktop packaging and releases

All shell and PowerShell commands below run from the repository root unless stated otherwise. See [development and verification](development.md) for development setup and native smoke procedures. A successful build is not native acceptance: qualify the actual packaged application, including generated-pet image conversion and right-click menu dismissal after one outside click, rather than substituting a minimal native menu probe.

## Packaging commands and script layout

Package on either supported host with the same command:

```bash
npm run build:package
```

The Node.js launcher selects macOS on a Mac and Windows on Windows. It keeps native Windows builds independent of Git Bash. Published mini-electron runtimes support **macOS arm64 (Apple Silicon)** and **Windows x64**; Intel Mac and Windows arm64 packages are not currently supported.

Explicit targets remain available:

```bash
npm run build:mac           # Run on macOS; DMG + ZIP, arm64
npm run build:mac:arm64     # Same explicit architecture
npm run build:windows      # NSIS installer + ZIP, x64
npm run build:package -- --help
```

Installer builds default to `--publish never` and write artifacts to `packages/desktop/release/`. Additional electron-builder options are forwarded, for example:

```bash
npm run build:package -- mac --config.mac.identity=null
```

macOS packaging requires a Mac; the launcher rejects it on Windows before starting the workspace builds.

Packaging orchestration is centralized in [`scripts/packaging/`](../scripts/packaging):

| Script                                                                                        | Purpose                                                         |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`build-package.mjs`](../scripts/packaging/build-package.mjs)                                 | Cross-platform npm entry point; selects target and native shell |
| [`build-mac.sh`](../scripts/packaging/build-mac.sh)                                           | macOS packaging helper                                          |
| [`build-windows.ps1`](../scripts/packaging/build-windows.ps1)                                 | Native Windows packaging helper                                 |
| [`build-windows.sh`](../scripts/packaging/build-windows.sh)                                   | Bash Windows packaging helper for macOS/Linux                   |
| [`build-windows-no-omp.sh`](../scripts/packaging/build-windows-no-omp.sh)                     | Bash wrapper for Windows packages without bundled OMP           |
| [`merge-windows-update-metadata.mjs`](../scripts/packaging/merge-windows-update-metadata.mjs) | Merges Windows update metadata documents for the same version   |

General-purpose scripts remain directly under `scripts/`: [`download-omp-binaries.mjs`](../scripts/download-omp-binaries.mjs), [`build-remote-backend.mjs`](../scripts/build-remote-backend.mjs), [`build-daemon-web-ui.mjs`](../scripts/build-daemon-web-ui.mjs), [`deploy-webui.sh`](../scripts/deploy-webui.sh), and [`clean-package-dist.mjs`](../scripts/clean-package-dist.mjs).

For an unpacked application without creating installers, use the lower-level build:

```bash
npm run build:desktop -- --dir
```

The macOS arm64 application is written to:

```text
packages/desktop/release/mac-arm64/OMP Desktop.app
```

For local installer builds, pass `--publish never` to avoid uploading release artifacts.

## GitHub Actions release packaging

The [`Package release`](../.github/workflows/release.yml) workflow builds **Windows x64, both bundled-OMP and no-OMP variants**, by default. It runs when a digit-prefixed tag such as `0.5.3` is pushed or through **Actions → Package release → Run workflow**.

- The root and desktop package versions must match. A tag build also requires the exact tag `<packages/desktop/package.json version>` without a `v` prefix; the workflow does not bump versions.
- Each successful build uploads an Actions artifact named `OMP-Desktop-Setup-<version>-x64`, `OMP-Desktop-No-OMP-Setup-<version>-x64`, or optional `OMP-Desktop-<version>-arm64`, retained for 14 days. GitHub downloads each artifact as an outer ZIP containing the original installers, package ZIPs, and blockmaps when generated, not unpacked apps or builder diagnostics. Bundled-OMP builds also include update YAML metadata. Publish the files inside this outer ZIP, not the Actions wrapper itself; installer names and update metadata references are unchanged.
- The no-OMP job runs `npm run build:windows:no-omp` and skips the OMP download. Its installer and ZIP filenames contain `No-OMP`, so both variants can coexist in the release. Its update YAML is deliberately excluded: both Windows variants generate the same channel metadata filename, and the public auto-update feed must continue pointing to the standard bundled-OMP build. This does not create a separate no-OMP update channel.
- Once all selected platforms succeed, a tag build uploads the assets to a **draft GitHub Release**. Reruns replace same-named assets only in a draft, preserve its notes, and refuse to modify an already published release. A failed upload leaves the release drafted; rerun after resolving the failure.
- A manual run on a branch only creates Actions artifacts. A manual run with a tag selected also creates or updates its release draft.
- Review the draft, add release notes, and perform the native packaged-application checks before publishing. Building installers does not verify native application behavior.

For example, after setting matching package versions to `0.5.3` and committing the changes:

```bash
git tag 0.5.3
git push origin 0.5.3
```

The workflow uses the repository's `GITHUB_TOKEN`; no personal access token is required. Repository or organization policy must permit the release job's `contents: write` permission. Windows artifacts are unsigned, so Windows may display SmartScreen warnings.

### Enable macOS CI packaging

Set the repository Actions **variable** `MACOS_RELEASE_ENABLED=true` to include macOS arm64 in tag and manual builds, or check the `macos` input for a single manual run. CI builds unsigned, unnotarized DMG and ZIP packages; no Apple certificate or notarization secrets are required.

The workflow invokes `build:desktop` directly with `mac.identity=null`, `mac.notarize=false`, `forceCodeSigning=false`, and signing-identity discovery disabled. It does not run the local `build:mac` signing/verification helper. Local signing commands remain unchanged.

These CI packages do not satisfy Gatekeeper's signed and notarized distribution requirements and may be blocked on other Macs. Artifact creation alone does not establish launchability or native application acceptance.

CI uses Node.js from `.tool-versions`, installs dependencies with `npm ci`, and downloads the selected platform's checksum-verified OMP binary. The lockfile pins the mini-electron installer, but the installer selects its current native runtime and the OMP downloader selects the latest upstream release; rebuilding a tag later is not guaranteed to reproduce identical binaries.

Commit the root `package-lock.json` together with dependency changes. Both the setup-node npm cache and `npm ci` require it in a fresh checkout; a lockfile present only on the developer's machine is insufficient. Nested/generated lockfiles remain ignored. After fixing a workflow dependency, start a new run on the updated commit: rerunning an older failed run still uses its original commit.

CI deliberately sets `ELECTRON_SKIP_BINARY_DOWNLOAD` to the string `"0"`: the stock Electron installer skips downloads for any nonempty value, while the pinned mini-electron installer treats `"0"` as false and downloads its native runtime. Do not change this to `"1"`: that also disables mini-electron downloads and fails on fresh runners. Recheck both installer behaviors when upgrading these dependencies.

## Native runtime selection

The npm installer is pinned to official `@iriscat/mini-electron@0.1.12`; native runtime versions are released independently. Windows x64 discovers updates through `runtime-v1-win32-x64`; `runtime-v1` is the macOS channel, not a cross-platform latest pointer.

Packaging accepts newer native runtime releases without a script update, validating the selected distribution's platform, architecture, installer protocol, Electron API metadata, and executable SHA-256 instead of pinning a release number. Main-process code keeps Electron-compatible `electron` imports; the stock `electron` package is retained only for TypeScript declarations. Project scripts do not download or substitute its runtime.

Packaging uses the installed runtime (or `MINI_ELECTRON_DIST_PATH`) without downloading or downgrading it to a fixed release. Before packaging, refresh an existing installation with:

```bash
npx mini-electron --update-runtime
```

Normal dependency installation reuses an already valid native runtime; updating the npm installer alone does not refresh it. Verify the selected native version in `node_modules/@iriscat/mini-electron/dist/version.json`.

### Local runtime distributions

For an unpublished local mini-electron build, run its `build.py --package-dist` with Python 3.12 or newer, then select its verified distribution explicitly:

```bash
MINI_ELECTRON_DIST_PATH=/absolute/path/to/mini-electron/out/mac-arm64/runtime-dist \
  npm run build:desktop -- --dir --publish never
```

The packager reads the selected runtime's `version.json`, defaults to that runtime's architecture (including when Node runs under Rosetta), and rejects a different target OS or architecture. `MINI_ELECTRON_DIST_PATH` must point to an extracted distribution for the requested target; it cannot reuse the host's runtime for another platform.

See [local runtime regressions](development.md#locally-repaired-runtime-regressions) before packaging a repaired macOS runtime, and [Windows builds](#windows-builds) for a PowerShell distribution override.

## macOS signing

For a local test package, run:

```bash
npm run build:mac
```

Without notarization credentials, this requires a valid code-signing identity named `OMP Desktop Local` in the macOS keychain and signs the test package with it. Create this self-signed code-signing certificate once and reuse the same certificate and private key across rebuilds so Keychain access can recognize the application. The first launch after switching signing identities may require allowing credential access again. A missing or invalid identity fails the build instead of falling back to an ad-hoc signature.

This local signature is not notarized and does not satisfy Gatekeeper's distribution requirements on other Macs.

macOS signing uses electron-builder's bundled entitlement template for the app; no separate Helper applications or entitlement files are required in `packages/desktop/build`.

For a signed, notarized release, the build machine needs a valid `Developer ID Application` certificate (or `CSC_LINK`) and one of electron-builder's notarization credential sets:

- `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` (recommended);
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`; or
- `APPLE_KEYCHAIN_PROFILE`, with optional `APPLE_KEYCHAIN`.

Both local and release builds verify the application's code signature after packaging. When notarization credentials are present, the script also verifies the stapled notarization ticket and Gatekeeper assessment.

## Windows builds

Windows mini-electron packages currently support x64 only. On Windows, the npm scripts use [`scripts/packaging/build-windows.ps1`](../scripts/packaging/build-windows.ps1) with Windows PowerShell 5.1 or newer; Git Bash is not required. Node.js, npm, and Windows' built-in `tar.exe` must be on `PATH`.

```powershell
npm run build:windows
# Equivalent explicit target:
npm run build:windows:x64
```

You can also run the native script directly from PowerShell, forwarding additional electron-builder arguments after the script path:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\packaging\build-windows.ps1
```

On macOS and Linux, the Windows commands use [`scripts/packaging/build-windows.sh`](../scripts/packaging/build-windows.sh) through Bash. Cross-builds require an extracted **win32-x64** mini-electron distribution selected with `MINI_ELECTRON_DIST_PATH`, plus electron-builder's Wine toolchain. Apple Silicon Macs also require Rosetta 2. For example, on macOS:

```bash
MINI_ELECTRON_DIST_PATH=/absolute/path/to/windows-x64/runtime-dist \
  npm run build:windows
```

### Windows runtime version and local overrides

Windows packages use `@iriscat/mini-electron` installer 0.1.12. Use Windows runtime **0.1.23 or newer** for the screen-coordinate and DPI-position fixes in [mini-electron #7](https://github.com/iris-cat-dev/mini-electron/issues/7); the macOS channel remains independent. Native SQLite, IPC frame identity, clipboard/keyboard/OLE input, selection colors, and IME remain supported.

To package an unpublished local runtime instead, build its checkout with `python build.py --package-dist` and select that distribution explicitly (PowerShell):

```powershell
$env:MINI_ELECTRON_DIST_PATH = "D:/Project/mini-electron/out/windows-x64/runtime-dist"
npm run build:windows
Remove-Item Env:MINI_ELECTRON_DIST_PATH
```

Update the native runtime explicitly before packaging an existing checkout:

```bash
npx mini-electron --update-runtime 0.1.23
node -p "require('@iriscat/mini-electron/dist/version.json').runtimeVersion"
```

For a reproducible fresh Windows install, set `MINI_ELECTRON_RUNTIME_VERSION=0.1.23` when running `npm ci`. The npm lockfile pins the installer, not the native runtime; ordinary postinstall reuses an already valid distribution instead of refreshing it.

### Unsigned local candidate

For a local unsigned NSIS candidate with signing credentials absent and publishing disabled:

```bash
npm exec -- cross-env CSC_IDENTITY_AUTO_DISCOVERY=false \
  npm run build:desktop -- --win nsis --x64 --publish never
```

The output includes `OMP-Desktop-Setup-<version>-x64.exe`, its `.blockmap`, a `.zip`, and `latest.yml` (or the prerelease channel's metadata) in `packages/desktop/release`.

Windows runtime builds disable Inspector/CDP. Qualify the real native window and bundled CLI/daemon using the [Windows packaged application smoke](development.md#packaged-windows-application); do not enable Inspector or bypass IPC frame checks to pass a smoke.

## Native runtime contracts

These are application runtime requirements, not evidence that a particular local build passed acceptance. See [verification](development.md#verification-policy) for commands, exercised scenarios, and limitations.

### macOS runtime

#### Bundle, transport, authority, and fonts

The macOS mini-electron distribution uses one runtime executable for the GUI, sandboxed renderer processes, and `ELECTRON_RUN_AS_NODE` daemon/CLI workers. It does not need the four Electron Helper application bundles. The remaining Squirrel, Mantle, and ReactiveObjC frameworks support updates and must remain.

The runtime bundle defaults to `LSUIElement=true`; only the GUI window host promotes itself to a normal Dock application. Background renderers and Node workers must not create additional Dock icons. The `app-builder-lib` patch applied by `npm install` allows distributions without a generic Helper bundle.

The macOS runtime must include a WebSocket-enabled libcurl build. A reachable daemon reported by the CLI is not sufficient: renderer TCP connections use native WebSocket, not the Node-side CLI transport. mini-electron statically links this network library and reuses its TLS implementation without adding another framework bundle.

IPC must also expose native-validated, stable `senderFrame`/`mainFrame` identity: desktop pet activity publication enforces main-window and main-frame authority. The macOS renderer permits only the extra `/System` directory metadata lookup needed by CoreText's system CJK font fallback, without bundling additional fonts.

#### Presentation and resize invariants

Native macOS presentation keeps the last complete shared frame during renderer writes. Hover and scroll animations must not clear the entire window when the new frame is temporarily unavailable; they remain enabled.

Hidden-titlebar macOS windows also require native edge/corner resize handling: the runtime reserves a five-point border ahead of caption and webpage input, preserving opposite-edge anchoring, size limits, and interior titlebar controls. Resize presentation must also retain the active child surface until replacement content activates. Latest size/scale updates coalesce, and completed software swaps are published before acknowledging the draw; newly allocated, unpainted pixels must never replace the visible page.

Retained frames must preserve pixel geometry rather than stretch to changed window proportions. Both publication and child-readiness transitions retry a pending latest viewport, so static session pages cannot remain at an old size; delayed metadata must not roll the canonical parent surface ID backward.

#### Native event loop, idle scheduling, and compatibility

Every renderer must service native AppKit application events even though it is a windowless `LSUIElement` process; live JavaScript or daemon requests do not establish WindowServer responsiveness. See [the responsiveness regression](development.md#locally-repaired-runtime-regressions).

The local macOS idle-scheduling runtime additionally replaces the fixed 10 ms AppKit/libuv poll with native events, backend I/O readiness and timer deadlines. It propagates physical visibility to Blink/Viz, including BrowserViews and guests, while preserving hidden first-frame preparation and `backgroundThrottling: false`. Select that rebuilt runtime with `MINI_ELECTRON_DIST_PATH`; rebuilding only the frontend does not add these native changes. The [idle regressions and frontend scheduling notes](development.md) distinguish hidden/inactive work from a visible animated homepage, which remains active GPU work.

Precise trackpad input must populate Blink's wheel ticks as well as pixel deltas. macOS runtime `0.1.21` leaves those ticks at zero, making xterm ignore gestures because it reads `wheelDeltaX/Y` before `deltaX/Y`. Package the locally repaired runtime until that native fix is released; [terminal qualification and local installation](development.md#terminal-trackpad-scrolling) describe the regression and selection steps. Rebuilding only the frontend cannot repair these native event fields.

QQ clipboard compatibility requires native runtime `0.1.12` or newer: QQ can advertise PNG bytes as TIFF, so the runtime must identify the actual encoding. The distribution override also selects a locally built fix.

Known macOS host limitation: the optional pet overlay still requires the missing `BrowserWindow.setIgnoreMouseEvents` API. Activity publication was verified with the default hidden pet; this does not establish full overlay compatibility.

### Window lifecycle and recovery

Plain relaunch, native reopen, tray and pet requests reuse the existing main window and share one pending creation when none exists. Explicit New Window and project launches retain their additional-window behavior. Only the successful desktop single-instance lock owner performs daemon/update shutdown; a secondary launch must not stop the primary's daemon.

If a running main window loses its renderer, Desktop logs the exit reason and available exit code and opens a native recovery dialog, including for hidden or minimized windows. **Reload window** creates a new renderer at the same route, query, and fragment before closing the failed window; it does not restart the daemon or its Agent sessions. Unsent input may be lost. **Close window** closes the failed window through the normal application lifecycle. Initial startup failures retain their separate error dialog.

Window-close choices retain the application's existing modal sheet, including Cancel, Exit, background-to-tray, and the remembered choice. The main process holds pending requests until that renderer is ready. Choosing Exit hides the window before daemon and updater shutdown for immediate visual feedback.

Titlebars and empty workspace-tab strip areas use native draggable regions in both normal and maximized windows. Windows owns the entire press, restore-drag, return-to-top, and release-to-Snap gesture; Desktop does not capture the pointer or drive window positions through renderer IPC. Interactive controls and the top resize strip remain non-draggable. Keep the native path rather than reintroducing a manual `unmaximize()`/`setPosition()` loop or disabling window animations to hide its restore transition.

The macOS runtime must preserve native click gestures across event-pump turns: repeated `NSApplication.run`/`stop` calls cancel a normal mouse-down before its mouse-up. The native runtime must report `WebContents.isDestroyed()` from object lifetime, not renderer liveness, and deliver storage acknowledgements after pending mutations are registered. Synchronous reply notification must complete before its waiter's stack condition variable can be destroyed. See the [system-input window-close regression](development.md#native-window-close-interactions).

Startup paint handoff, the bounded Windows first-document fallback, and the rule that it cannot reopen a tray-hidden window are described in [startup and first-window work](development.md#startup-and-first-window-work).

### Windows runtime

The Windows runtime includes the upstream [`executeJavaScript` value/Promise/error fix](https://github.com/iris-cat-dev/mini-electron/issues/3) and [nonactivating companion focus fix](https://github.com/iris-cat-dev/mini-electron/issues/4).

Windows runtime 0.1.15 also has an observed [electron-log renderer-preload redeclaration issue](https://github.com/iris-cat-dev/mini-electron/issues/5). The native smoke retains this error; passing the application scenarios does not prove that renderer logging initialized successfully.

Windows runtimes must use system randomness for `mkdtemp`: repeated suffixes can block agent history loading before OMP starts, eventually reporting a 60-second message timeout.

Windows daemon and CLI process-tree cleanup launch `taskkill.exe /T /F` directly with a hidden console, avoiding transient `cmd.exe` windows during provider refresh and process shutdown. Interactive terminal launches are unchanged. macOS and Linux retain signal-based tree cleanup.

## Packaged dependency and language policy

Desktop packaging keeps build/test-only dependencies out of the production dependency graph and excludes third-party TypeScript sources, declarations, and MCP SDK examples from the unpacked `resources/app` tree. Standard packages retain the bundled OMP executable, runtime workers, shell integration, and the target platform's native bindings.

The early OMP catalog hook is loaded through an encoded module URL, so installation directories containing spaces remain valid. Windows ConPTY files are loaded from the matching node-pty prebuild, not its duplicate `third_party` directory.

The Windows local monitor lazily loads Koffi 3.3.4 and its `@koromix/koffi-win32-x64` Node-API binding for process-local HWND passthrough. Keep optional dependencies enabled. Koffi's `src/` contains runtime JavaScript and must not be excluded as build-only source; the after-pack hook checks its complete loader chain and native binary. Existing `asar: false` keeps these relative loaders on disk. The adapter pairs Windows layered/transparent input flags only while needed, preserves DirectComposition and unrelated window styles, and never installs native callbacks or global hooks.

Daemon command execution collects `execFile` callback stdout and stderr explicitly. The mini-electron runtime does not expose Node's custom `promisify(execFile)` result shape; using it can misreport a supported bundled OMP as older than the required version. The actual minimum remains **OMP 18.8.7**.

The Electron language allowlists retain all nine application languages and common regional variants. macOS also retains each selected language's grammatical-gender `.lproj` variants. Update both platform allowlists in [`packages/desktop/electron-builder.yml`](../packages/desktop/electron-builder.yml) when adding a language.

## Desktop updates and release metadata

Desktop updates use the public [`iris-cat-dev/omp-desktop` GitHub Releases](https://github.com/iris-cat-dev/omp-desktop/releases) feed. The app checks its configured Stable or Beta channel at startup, downloads a newer package in the background, verifies the SHA-512 value from electron-builder's update metadata, and installs it when the user chooses **Install & restart** or next quits the app.

Every release must upload the updater metadata and payloads generated from the same build:

| Target                  | Required release assets                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| macOS                   | `OMP-Desktop-<version>-<arch>.dmg`, the matching `.zip`, and channel metadata (`latest-mac.yml` for Stable or `beta-mac.yml` for Beta) |
| Windows                 | The x64 `.exe` installer, its `.blockmap`, and channel metadata (`latest.yml` for Stable or `beta.yml` for Beta)                       |
| Linux AppImage releases | The AppImage, its blockmap, and matching `*-linux.yml` metadata                                                                        |

The Linux asset rule describes release metadata requirements, not an additional currently supported mini-electron packaging target.

Both `scripts/packaging/build-windows.ps1` and `scripts/packaging/build-windows.sh` write the updater metadata for the supported x64 target. A GitHub Release that only contains DMG or EXE files remains available for manual download but cannot be installed by the in-app updater. Publish the generated files only after every target for that release is complete; local Windows builds use `--publish never`.

## Windows packages without bundled OMP

To build Windows packages without shipping a new OMP executable:

```bash
npm run build:windows:no-omp
npm run build:windows:no-omp:x64
```

These artifacts use `OMP-Desktop-No-OMP-Setup-<version>-<arch>.exe` names so they do not overwrite the standard installers. The application still includes its daemon and CLI; only `omp.exe` is omitted.

A fresh `no omp` installation uses `omp` on `PATH`. When switching from an installation with `resources\bin\omp.exe`, the NSIS installer backs up that existing executable before invoking the old uninstaller, then restores the exact file into the selected installation directory. This also preserves an independently updated bundled runtime and works when changing the installation directory. Repeated `no omp` installations retain it; switching back to the standard installer replaces it with that package's bundled runtime.

Preservation applies only to installing the `no omp` upgrade, including silent installation. **Explicitly uninstalling Desktop still removes its installation directory and bundled OMP.**

If the existing runtime cannot be backed up, installation stops before removing the previous version. If restoration fails, installation reports the location of the retained backup. The `no omp` ZIP payload itself still contains no OMP executable.

Run the [installation-switch regression](development.md#installer-switching-and-omp-preservation) on a clean Windows VM, including independently updated OMP bytes when appropriate; Wine checks do not replace real Windows installation and startup verification.

## Bundled OMP binaries

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

electron-builder selects the target architecture and installs the executable as `Resources/bin/omp` on macOS, `resources/bin/omp` on Linux, or `resources/bin/omp.exe` on Windows. Available OMP binary targets do not expand the supported Desktop runtime targets.

## Bundled skills

The repository-root [`skills/`](../skills) directory is the source catalog for bundled orchestration skills. During the server build, [`packages/server/package.json`](../packages/server/package.json) removes the previous `dist/server/skills` directory and recursively copies `../../skills` into it. This makes the same catalog available to the development server and packaged application.

The catalog currently includes [`skills/hatch-pet/SKILL.md`](../skills/hatch-pet/SKILL.md), which guides creation and installation of a custom animated desktop pet from a description or reference images using the configured image-generation tool and local installation helper. It is not an empty catalog: `.gitkeep` remains alongside `hatch-pet`.

Keep the `skills/` directory even when no bundled skills are present: removing it causes the recursive copy step to fail. Add bundled skills as subdirectories containing their `SKILL.md` files.
