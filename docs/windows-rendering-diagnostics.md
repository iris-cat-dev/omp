# Windows rendering diagnostics and ghosting investigation

[Documentation index](README.md) · [Development](development.md) · [Packaging](packaging.md)

## Scope and current conclusion

The 2026-11-14 investigation concerns a long-running Windows OMP Desktop window with visible ghosting (重影) that the user could not capture in screenshots. Scrolling was never affected; the user identified Settings and the right-hand file/Git tree. The visible right-hand tab during inspection was **Changes**, which is not the same component as the Files tab.

The controlled recovery narrowed the problem to the old window's graphics-backing/repaint boundary. It did **not** identify a unique faulty statement or establish whether mini-electron or its interaction with the NVIDIA driver caused the original corruption. Resizing recreates graphics resources **and** triggers layout and repaint; do not turn this result into an unqualified driver or runtime-bug claim.

This diagnostic build records metadata and lifecycle history without automatically refreshing, resizing, recovering or restarting a window. The purpose is to preserve the next fault, not hide it.

## Incident evidence: 2026-11-14

### Environment and observations

- Installed Desktop: `0.7.0`; mini-electron Windows runtime: `0.1.41`; Chromium major: `132`; Electron-compatible API: `41.2.0`.
- Windows 10 build `19045`; NVIDIA GeForce RTX 3090; driver `617.42`; affected window on the primary display at approximately 144 Hz and 150% scale. A GameViewer virtual adapter was installed, but was not the active display hosting this window during the check.
- Original main PID `5060`, renderer PID `19256`; approximately 20.4 hours of uptime when initially sampled. These identifiers are historical, **not** reusable targets for a later investigation.
- Renderer private memory was approximately 1.46 GiB with approximately 14.6 GiB of system physical memory available. A short sample found stable main/renderer handle counts and no CPU saturation. This does not exclude slow growth over a longer period.
- The system-event query did not find a Display 4101 timeout/reset in the preceding three days. Absence of that event does not rule out every graphics-device or driver fault.
- The native window used DirectComposition and `WS_EX_NOREDIRECTIONBITMAP`. Its native scene contained one page layer plus the native caption overlay, not two page copies.
- Published GPU frame and browser successful-Present frame both reached `9176385`; producer error flags were zero. The inspected presenter had no pending backing replacement, armed swapchain wait or outstanding first-frame priming.
- The installed executable's `.text`, `.rdata` and `.data` sections matched the selected standalone runtime. A matching private PDB loaded successfully. The installed frontend bundle differed from the older workspace export, so source-level frontend hypotheses were not treated as proof of installed behavior.

### Controlled comparisons

The user, not screenshots, supplied the visible ghosting outcomes.

| Intervention                                                             | State retained or replaced                                                                              | Visible result                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Restore the minimized original window                                    | Original process, document and backing                                                                  | Ghosting remained                                       |
| Native retained-frame invalidation/presentation                          | No document or producer-source replacement                                                              | No recovery established                                 |
| Open a fresh window under the same main process                          | Fresh renderer and per-window resources; same installed program, GPU and display                        | Fresh Settings window normal; old window still affected |
| Reload the old page with Ctrl+R                                          | Original renderer PID, native window, producer source, texture and fence retained                       | Ghosting remained after loading completed               |
| Restore the maximized old window to its normal size, then maximize again | Original renderer and native window retained; producer backing and DirectComposition swapchain replaced | User confirmed ghosting disappeared                     |

The last intervention was verified against actual native state:

| Field                               | Before           | After final maximize                       |
| ----------------------------------- | ---------------- | ------------------------------------------ |
| Renderer PID                        | `19256`          | `19256`                                    |
| Native BrowserWindow object         | `0x69f800132100` | unchanged                                  |
| Producer source ID                  | `8`              | `11` (normal-size intermediate source `9`) |
| Producer texture HANDLE value       | `4112`           | `4400`                                     |
| Producer fence HANDLE value         | `3156`           | unchanged                                  |
| DirectComposition swapchain pointer | `0x270041195f0`  | `0x26dfabb9ea0`                            |
| Producer frame ID                   | `9179319`        | `9179328`                                  |

Raw pointers and HANDLE values are incident evidence only. Handles can be reused; use source IDs, diagnostic instance/generation IDs, process identity and lifecycle events to establish resource identity.

### Verification limits

Three fresh-runtime moving translucent-marker scenarios exercised GPU/DirectComposition, CPU/DirectComposition and CPU/GDI. Each completed 12 states with native desktop pixels and renderer captures within one RGB value of the expected pixels. These were short scenarios, not a 20-hour soak and not proof that the affected aged window was healthy.

The broader existing compositor smoke completed 25 pixel stages before a foreground-window prerequisite failed. It was **not** counted as a complete pass. A final hover exercise was stopped after one move because the physical pointer moved externally; it was not a hover-stress pass.

WPR GPU/DesktopComposition tracing could not start because profiling policy/privilege was unavailable. No tracing session remained active and no system policy was changed. Read-only, non-invasive CDB inspection and the renderer's read-only shared-frame mapping supplied the native evidence. Diagnostic mappings/handles were released. The original recovered window was not restarted; the fresh comparison window was minimized.

## Source boundaries to revisit

Paths in this section are relative to the separate mini-electron checkout, not this Desktop repository.

- `src/platform/windows/d3d_compositor.cc`: persistent D3D12/Skia root backing, source identity, damage, producer fence and publication, uploaded-image cache and explicit readback.
- `src/platform/windows/dcomp_presenter.cc`: D3D11 retained-texture import, fence release, swapchain creation/replacement, transient Present results, visual-tree commit and failure teardown.
- `src/runtime/electron/common/renderer_protocol.h`: shared-frame seqlock and exact producer source/frame/fence identities. A publication generation is not a physical-scanout acknowledgement.
- `components/viz/service/display/software_renderer.cc` and `direct_renderer.cc`: intermediate-pass reuse, clipping, damage and opaque-coverage invariants. The Windows D3D output device is hosted by Viz's SoftwareRenderer; a successful Present does not prove pixel correctness.
- `src/runtime/engine/viz/viz_host.cc`: opaque-root clearing policy. Disabled root clearing relies on correct opaque coverage; it is not, by itself, a demonstrated defect.

Frontend source candidates include hover/selection backgrounds shared by Settings navigation and tree rows, and filename opacity changes in tree primitives. They are repaint-sensitive paths, not confirmed causes. Do not mistake the right Changes tree for `FileExplorerPane` or keep investigating scroll FPS against the user's observation.

## Diagnostic recording

Windows recording is enabled by default. Start with `OMP_RENDER_DIAGNOSTICS=0` to disable it. The recorder does not send logs over the network.

Logs are under:

```text
%APPDATA%\OMP Desktop mini-electron\logs\rendering\
```

An explicit `OMP_ELECTRON_USER_DATA_DIR` changes the user-data root and therefore this location. The current file is `rendering.jsonl`; archives are `rendering.1.jsonl`, `rendering.2.jsonl`, and `rendering.3.jsonl`. Files are asynchronous JSONL with an 8 MiB limit per file, bounded to approximately 32 MiB of retained log data.

Recording consists of:

- startup/runtime identity and per-window lifecycle events;
- metadata-only native snapshots every 30 seconds;
- bounded native producer/consumer/presenter lifecycle and anomaly history, with event sequences and loss/overwrite information where applicable;
- a manual issue marker that is written before requesting native metadata, including when a renderer query is already pending or times out.

Records are capped at 128 KiB; oversized records become omission markers. The write queue is capped at 512 KiB plus one 128 KiB critical-record reserve. Queue loss/recovery and file-I/O failures are reported through the ordinary Desktop logger; include those application logs if recording failed. A file-I/O failure disables this recorder rather than retrying indefinitely.

Native queries time out for recording after 5 seconds, but retain their single-flight slot until the underlying request actually settles. This prevents a stuck renderer from accumulating requests. Late replies from closed windows or retired documents are discarded. Shutdown allows up to 2 seconds for local-file flushing and does not wait for renderer replies.

Use **View → Record Rendering Issue** or **Ctrl+Alt+Shift+D** before attempting recovery. Recording does not reload, resize or open a modal/folder. **View → Open Rendering Logs** is a separate action.

Native snapshots extend the existing private `_getCompositorInfo()` API with diagnostic schema version 1. Existing backend/frame/readback/VSync fields remain available. Exact 64-bit identities and event sequences are strings, not lossy floating-point counters. Unavailable or unsupported diagnostics are recorded explicitly, not represented as healthy zero values.

Startup identity includes the adjacent runtime manifest's version, diagnostic capability, and unmodified distribution executable SHA-256. This hash identifies the selected runtime before packaging/icon changes; it is **not** a claim that the branded installed EXE has that same file hash.

Native history is bounded to 64 entries per ring. `eventHistoryFirstSeq`, `eventHistoryLastSeq`, `eventHistoryOverwrites`, and `eventHistoryCapacity` describe the ring before filtering for the queried owner. Producer/presenter histories can include other views/windows in the same process; gaps do not by themselves prove this window lost an event. `timeUs` is monotonic native time, not UTC; use record timestamps and markers for wall-clock correlation. Resource identities are logical process-local lifetime generations, not raw handles or pointers.

Metadata queries do not capture pixels, read GPU textures back, flush the GPU or invalidate the window. Default records exclude screenshots, page text, URLs, window titles, project/file names, authentication tokens and process argv. The logs nevertheless contain machine/process/window and graphics metadata; review them before sharing.

## Next-incident procedure

1. **Preserve the fault first.** Do not refresh, resize, minimize, change DPI/monitor, restart the application or change driver settings before marking it. Those operations can alter or discard evidence.
2. Record the issue using the menu/shortcut. Write down the approximate local time, affected Settings section or Files/Changes tab, whether the window is maximized, and whether an old row/hover remnant persists after the pointer leaves. Do not assume scrolling is involved.
3. If feasible, use an external camera. Note the screenshot method separately. `capturePage()` reads a renderer-side surface and can change GPU synchronization timing; a clean capture does not establish that physical display output was correct.
4. Keep the current and rotated JSONL files together. Correlate the manual marker with window/document epochs, renderer/output-device identity, producer source and frame, imported and presented identities, dimensions/DPI, last damage, pending waits, Present results and resource-replacement events.
5. Only after the marker, perform **one** controlled intervention and record its time and visual result. Prefer page reload before backing recreation when preserving that distinction is important. Mark again afterward, rather than combining several recovery actions without observations.
6. A normal fresh window does not exonerate an aging runtime. A successful Present does not establish correct pixels or completed physical scanout. Metadata alone cannot uniquely separate stale source pixels from a downstream display fault; if the next trace is inconclusive, capture synchronized producer/retained/back-buffer evidence in a separately qualified native diagnostic path **before** releasing the old resources.

Do not add periodic refresh, automatic resize or forced restart as a supposed fix. They can remove the symptom and the evidence without repairing its cause.

## Source synchronization for this diagnostic build

The following upstream revisions were fetched and fast-forwarded before instrumentation. Local diagnostic edits are additional to these revisions; this table is not a claim that the diagnostic code is already committed or published.

| Repository    | Upstream revision                          |
| ------------- | ------------------------------------------ |
| Desktop       | `564e47c6e3eb011768829f03b69de3aaf19db0f0` |
| OMP SDK       | `9c478e24a75336152b7254564e746d724394ee34` |
| Plugins       | `d4cdd5d2f0a883f57cf3e3a5e5089259ee873e13` |
| mini-electron | `4e3e3b5e8ffe7fa51065c467a84772bcf199b355` |

The latest runtime source declares `0.1.42`, while the published Windows channel at synchronization still referenced the `0.1.41` archive. Build and select the local instrumented Windows distribution explicitly; rebuilding Desktop alone cannot add native instrumentation to an old runtime.

## Build qualification evidence (2026-11-14)

The instrumented local runtime reports `0.1.42`. The built executable, staged distribution executable, and symbol archive image have the same SHA-256:

```text
037f658f4e8bdde58282522a6e63de3e0c49ed636ae4b9653a16b96ea70acba4
```

Matching PDB identity: GUID `83AA26F0C89C05614C4C44205044422E`, Age `1`. Preserve the symbol archive; the original incident's `0.1.41` symbols do not match this executable.

Evidence is retained under `%LOCALAPPDATA%\omp-desktop-render-build\2026-11-14\`:

- `runtime-diagnostics-dist\`: selected, hash-verified runtime distribution; use this directory with `MINI_ELECTRON_DIST_PATH`;
- `symbols\mini-electron.pdb\83AA26F0C89C05614C4C44205044422E1\`: matching EXE, PDB, and `symbols.json`;
- `native-gpu-smoke.log`: actual interactive hardware lifecycle evidence;
- `runtime-staging.log`: actual staged-executable async-context, broker-storage durability/error, and diagnostic API/CPU-fallback probes;
- `reload-boundary-comparison.json`: isolated `data:` versus file-document reload comparison against both runtime versions.

The upstream Windows archive filename still contains `0.1.41` even when the local build metadata reports `0.1.42`. Select the qualified directory above, not an archive solely by its filename. No installer channel or release was published.

| Check                                                   | Observed result                                                                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recorder, menu, and Windows runtime packaging contracts | 98 tests passed across three files                                                                                                                                               |
| Desktop TypeScript contracts                            | `typecheck` passed                                                                                                                                                               |
| Native runtime release unit checks                      | 22 tests passed; one skipped                                                                                                                                                     |
| Native source build                                     | Windows Release x64 completed with four compiler jobs                                                                                                                            |
| Interactive native lifecycle                            | File reload retained backing identity; resize replaced producer backing, consumer texture and swapchain; multi-window isolation and teardown passed; GPU readbacks remained zero |
| Exact staged runtime probes                             | Async-context/promise hooks, broker-storage persistence/error handling, and schema-one CPU-fallback unavailability passed                                                        |

Two qualification boundaries matter for future investigations:

1. `data:` reload did not create a new document or emit navigation events in either the baseline `0.1.41` or instrumented `0.1.42`; equivalent file-document reload did both. The compositor regression therefore uses a real file document, like Desktop, rather than treating a synthetic `data:` reload timeout as a rendering regression.
2. A static resize can leave the scheduler's final-Present confirmation cache at source/frame `0`, even after swapchain priming/attachment and with `waiting=false`, `priming=false`. Metadata queries preserved this state. A separately initiated ordinary page paint advanced the confirmed frame; no automatic recovery was added. This cache state does not prove wrong physical pixels and is **not** the demonstrated cause of the original incident, where producer/imported/presented frame identities matched.

These are short checks. They do not establish that the original approximately 20-hour aging fault is fixed, nor do they prove correct physical scanout when a screenshot looks normal.

## Packaged application verification and delivery

The final installer is:

```text
D:\Project\omp-desktop\packages\desktop\release\unbundled\OMP-Desktop-Setup-0.7.0-x64-render-diagnostics.exe
```

It is 92,087,971 bytes. SHA-256:

```text
6bffa88c24b811a8b6731940907a8cdd2d2a75b3581d0df896add379d27b7ccc
```

An adjacent `.exe.sha256` sidecar contains the same checksum. Authenticode status is `NotSigned`; this is a local diagnostic build, not a signed/published release. The Desktop version remains `0.7.0`; the diagnostic filename and runtime/build fingerprints distinguish this package.

The embedded application was extracted from this actual installer without executing installation hooks. Extraction completed with exit code zero; 7-Zip reported trailing data after the embedded archive. The extracted executable hash matched electron-builder's output, and its RSDS GUID/Age matched the archived PDB above. The actual extracted application then ran with an empty isolated profile and a separately started owned backend on `127.0.0.1:55477`.

Actual Home and Settings surfaces rendered. Idle records arrived at approximately 30-second intervals without injected input, including while Settings was static. Window/content bounds, display scale `1.5`, zoom and native schema-one diagnostics were present. The real keyboard shortcut persisted marker sequence `41` before native reply sequence `43`; renderer, backing, consumer texture, presenter and swapchain identities were unchanged across that marker. GPU readbacks remained zero. Normal application exit returned zero and persisted both `quit-requested` and `shutdown`; the owned backend was stopped gracefully through its lifecycle RPC.

`%LOCALAPPDATA%\omp-desktop-render-build\2026-11-14\packaged-rendering-smoke.json` records the final installer hash, extracted executable hash, PDB identity, sample times and lifecycle evidence. The final isolated profile and its rendering logs are under `packaged-render-final-s1iatyq6\`. Share the rendering JSONL and explicit evidence files, not entire profile/daemon homes, which can contain generated credentials.

Two recorder defects were found by running the first package and corrected before this final build:

- mini-electron does not expose Electron's `webContents.getOSProcessId()`. Calling it unconditionally discarded the entire window-metadata group. The getter is now optional; actual OS renderer PIDs still come from native producer/consumer diagnostics. A regression test checks that a missing getter does not discard geometry and DPI.
- An unreferenced sampling interval did not emit idle periodic records; keyboard input then triggered an overdue record. The enabled recorder now keeps the interval referenced and clears it during shutdown. The final package's unattended Home/Settings sampling and normal shutdown were exercised, rather than relying on fake timers to qualify this behavior.

For future isolated full-app runs, initialize a dedicated daemon home/listen address, start its own backend, and verify the CLI status PID **and** listen address before opening the GUI. Environment overrides alone did not prevent the first exploratory status check from finding the existing default-port backend. A completely uninitialized daemon home also produced a Windows config-initialization rename `EPERM` during that exploratory run; this separate startup boundary was not changed by the rendering instrumentation. The final smoke used an initialized owned daemon and does not qualify concurrent first-home initialization.

No installer was run against the user's installed application. The original installed window still belonged to main PID `5060` after verification; it was not restarted. The new recorder takes effect only when the newly packaged application is run, not retroactively inside the old process.
