# Development and verification

All shell and PowerShell commands in this guide run from the repository root unless stated otherwise. See [packaging](packaging.md) for supported native runtimes, installer construction, signing, bundled OMP, and release metadata; [remote hosts](remote-hosts.md) and [deployment](deployment.md) cover remote daemon and Web/relay setup.

## Start development

```bash
npm install
npm run dev:desktop
```

Development uses:

- daemon: `127.0.0.1:6770`;
- renderer: an available Electron Metro port;
- state: `.dev/omp-desktop-home`.

The packaged app uses `~/.omp-desktop`. OMP keeps its own configuration, credentials, provider subscriptions, and sessions under `~/.omp`.

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

## Runtime and protocol notes

Main-process code keeps Electron-compatible `electron` imports; the stock `electron` package is retained only for TypeScript declarations. Project scripts do not download or substitute its runtime. Native runtime version selection and platform constraints are documented in [packaging](packaging.md#native-runtime-selection).

The daemon decodes OMP's JSONL stdout and diagnostic stderr as UTF-8 streams, preserving Chinese characters and emoji even when their bytes span pipe data blocks. JSONL line framing and protocol-v2 chunk reassembly remain unchanged.

### Startup and first-window work

Apple Silicon startup streams local frontend assets in bounded chunks up to 1 MiB, avoiding repeated small-file-read overhead. The main window stays native-hidden until the renderer has painted a branded startup surface and the runtime has copied that frame into the AppKit backing store, avoiding an unpainted first reveal.

Mermaid, WebSocket response validation, and terminal emulation load on first use instead of inflating the startup entry. Desktop daemon setup imports only its configuration/runtime helpers; updater and CLI-install graphs also stay off the first-window path. Login-shell environment inheritance and daemon readiness checks are unchanged.

Lazy-loaded CommonJS desktop modules must use typed `require`, not runtime `import()`. mini-electron resolves the native `electron` module through its CommonJS loader; Node's ESM-to-CommonJS loader bypasses that resolver and can fail with `Cannot find module 'electron'`, including in transitive dependencies. CLI/OMP shortcut installation and updater operations stay deferred through `require`; the Node worker and CLI entrypoint loaders retain `import()` for their ESM entrypoints. Qualify these paths in the native runtime, since Vitest's mocked Electron module does not exercise native resolution.

On Windows, the renderer normally reports content readiness after app settings load. If that signal never arrives, a bounded main-process fallback presents the successfully loaded first document. Navigation, close, hide, minimize, or normal readiness cancels it; the fallback cannot reopen a window hidden to the tray. macOS remains gated on its native paint handoff.

### Frontend work and generated output

Desktop/web status rings, synchronized loaders, and the homepage WebGPU poster stop scheduling animation while their retained panel or application is inactive. The homepage route supplies its navigation focus to the retained-panel context, so opening Settings also stops the covered poster while the window stays focused. Retained poster resources are reused within the mounted component and released on unmount or when the existing home-effects switch is disabled. Loaders share one timer at the six visible step boundaries per 950 ms cycle, not a permanent display-rate worklet. Reduced-motion preferences remain respected.

The frontend Babel pipeline resolves Lucide's actual named exports to individual icon modules, including legacy aliases; public type imports remain unchanged. Electron web exports use UTF-8 instead of ASCII-escaped strings. Protocol validator generation shares repeated, non-mutating IR containers without removing validation, defaults, transforms, or fallback schema behavior; see the [protocol code generator guide](../packages/protocol/codegen/README.md).

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

Run the targeted regressions from the repository root:

```bash
npm run test --workspace=@omp-desktop/app -- --project unit src/git/diff-document/model.test.ts src/git/diff-document/text-measurement.test.ts src/data/query.test.tsx src/data/push-router.test.ts
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

To exercise an unpacked application, including its renderer, daemon, bundled OMP, CLI, and terminal:

```bash
node packages/desktop/e2e/packaged-app-smoke.js --app "packages/desktop/release/mac-arm64/OMP Desktop.app"
```

Packaged smoke checks verify macOS Dock visibility, including a cold daemon launch, rather than requiring a separate Helper path. The packaged smoke keeps multiple native image launch configurations alive together inside the shipped runtime, in addition to invoking the OMP binary directly.

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

#### Renderer-loss recovery

To exercise renderer-loss recovery on Windows with a freshly built local runtime:

```powershell
npm --prefix packages/desktop run build:main
$env:ELECTRON_PATH = "D:/Project/mini-electron/out/windows-x64/mini-electron.exe"
node packages/desktop/e2e/renderer-loss-recovery-smoke.js
Remove-Item Env:ELECTRON_PATH
```

Choose **Reload window**, then click **Verify interaction** in the replacement. The smoke uses a temporary profile and terminates only its own renderer child; it does not use an existing Desktop process or require Inspector/CDP.

#### Installer switching and OMP preservation

Run the installation-switch regression on a **clean Windows VM**, with standard and `no omp` installers for the same version and architecture:

```powershell
node packages/desktop/e2e/windows-installer-switch-smoke.js --standard "packages/desktop/release/OMP-Desktop-Setup-<version>-<arch>.exe" --no-omp "packages/desktop/release/OMP-Desktop-No-OMP-Setup-<version>-<arch>.exe"
```

The smoke refuses to run if the configured application is already registered. It checks fresh installation, switching to `no omp`, repeated installation with a changed directory, switching back, and explicit uninstallation. It verifies the preserved executable's SHA-256 and runs the packaged renderer, daemon, OMP, CLI, and terminal checks after the `no omp` upgrades, including the daemon's actual runtime path. Wine checks do not replace this real Windows installation and startup verification.

Pass `--updated-omp "<path-to-another-omp.exe>"` to replace the initially installed runtime before switching, proving that `no omp` preserves independently updated bytes and that the standard installer restores its own packaged version. The replacement must differ from the standard payload. For disposable installers built with an isolated application identity, pass `--config "<electron-builder.cjs-or-yml>"` describing their `appId` and executable name; the registration safety check then uses that identity instead of the production application.

See [Windows packages without bundled OMP](packaging.md#windows-packages-without-bundled-omp) for the preservation and failure behavior being exercised.

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
