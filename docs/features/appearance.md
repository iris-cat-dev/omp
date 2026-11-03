# Appearance, wallpaper, and input

Customize local appearance and wallpaper, understand platform window behavior, and use touch/hybrid layouts. The [Desktop pet](desktop-pet.md) has its own guide.

## Contents

- [Language and display preferences](#language-and-display-preferences)
- [Window and theme behavior](#window-and-theme-behavior)
- [Wallpaper](#wallpaper)
- [Isolated Windows wallpaper trial](#isolated-windows-wallpaper-trial)
- [Touch and hybrid input](#touch-and-hybrid-input)

## Language and display preferences

**Settings → General → Language → System** chooses the first supported system language; an explicit selection takes precedence. macOS reads actual OS language preference order, not a fixed browser locale. Restart Desktop after changing macOS language preferences.

**Settings → Chat behavior → Detail level** controls reasoning expansion, tool-call detail, and the Web chat outline. **Settings → Chat behavior → Show files after each response** hides file chips without hiding statistics when off; it defaults on and persists across restarts. General no longer includes the Detail level section; existing values are retained.

Conversation prose uses medium weight with semibold emphasis, with deeper near-black primary text in the light theme. Code remains regular weight; font sizes, line heights, and secondary tones are unchanged. Math retains bundled KaTeX fonts even if the interface font changes; see [Messages and media](messages-and-media.md).

Task cards use one authored step below the conversation content font size and the prose line height scaled to it, including custom font-size settings. Card titles and phase labels also use the prose's medium weight; the active phase is emphasized by color and background, not heavier text. Phase and task rows have additional vertical padding, with wider icon gaps and card insets. Long tasks wrap without truncation; phase expansion and panel collapse remain independent.

## Window and theme behavior

Desktop's full-width titlebar sits above the sidebar and workspace tabs. The sidebar shares its background, and the sidebar toggle stays in the titlebar when collapsed. Panel toggles, script controls, and new-tab launcher occupy the right side; only the focused workspace supplies them, even when navigation keeps other workspaces mounted.

Workspace tabs sit directly below the titlebar without a duplicate header. Native window buttons keep reserved space. Tabs have edge-to-edge square corners, thin separators, an active content-matched background, and a close button on selection/hover.

On macOS, dragging and double-click zoom/restore use native AppKit, including when maximized; there is no Windows/Linux manual restore-and-drag fallback. Double-click respects the macOS titlebar action preference. On Windows, a single click on maximized titlebar leaves it maximized, double-click restores, and only actual drag motion starts restore-and-drag. Interactive buttons/controls stay outside drag regions.

The document `color-scheme` follows resolved theme so native selection and form controls match light/dark mode. Compact Web headers use a 44px row without extra top padding and retain safe-area insets; native mobile and Desktop-wrapper spacing is unchanged.

**Settings → Connections** lists saved hosts, connection state, and daemon version above relay/pairing controls. **About** shows app version and Desktop app updates, not the host list. Remote hosts offer **Disconnect / Reconnect** in host pickers, this list, and host overviews. Disconnect preserves the saved connection and cached workspace data, stops probing and automatic reconnection, and persists after restart. Reconnect resumes that connection. Neither action stops the remote daemon; **Remove host** is separate. See [Remote hosts](../remote-hosts.md).

## Wallpaper

In **Settings → Appearance**, enable **Wallpaper**, choose **File**, then **Add files** with the system picker. Ctrl/Shift multi-selection and files from different folders work. Candidates persist across restarts; originals remain where they are.

Media, candidate records, and Desktop selection stay on this computer. Pairing a phone/tablet does not copy them. A Web browser can independently configure URL wallpaper in browser-local settings; that is not Desktop synchronization. For connecting clients see [Remote hosts](../remote-hosts.md) and [Deployment](../deployment.md).

With Wallpaper enabled, the home screen hides decorative-motion controls and its poster overlay so media stays visible. Turning it off restores the control and previous value. Project/conversation shortcuts remain available either way.

### Candidate management and formats

The candidate grid is continuously scrollable and virtualized, not paginated or limited to 48 entries. Covers are static, including video covers. Adding does not apply media; select a card manually. There is no rotation.

**Manage** selects/removes multiple records, including offscreen candidates, without deleting source files. Removing the active candidate restores theme background rather than choosing another. Re-adding the same file makes a new candidate and does not reactivate the old selection. Missing/undecodable files remain listed: restore and retry or remove the record.

Accepted file extensions: `jpg`, `jpeg`, `png`, `gif`, `webp`, `bmp`, `avif`, `mp4`, `m4v`, `webm`, `mov`, `ogv`. Playback depends on the runtime and codec; Desktop does not transcode. **URL** accepts HTTP(S) images/videos and detects type from pathname, including signed video URLs with query strings.

**Windows mini-electron 0.1.28:** its media-player factory is not implemented. Valid MP4 and WebM files fail with “error creating media player” even over HTTP; changing a filename or codec does not repair that missing player. Images remain usable. The current Windows package retains this runtime; video-wallpaper support is deferred.

### Transparency and loading

**Interface transparency** spans 0–100%. At 0% regular surfaces use solid theme backgrounds; increasing reveals media, and 100% removes sidebar/titlebar/composer veils. Slider changes preview without persisting every intermediate value. Dragging preserves Settings mount, focus, and scroll position.

Base workspaces become transparent only after media loads, including newly selected tabs. Floating menus, palettes, tooltips, dialogs, and notifications stay opaque. Text still follows theme: match wallpaper/theme or reduce transparency if contrast suffers. Load errors appear in Wallpaper settings and retain normal surfaces. Source switching or load recovery preserves focused inputs and pet-creation drafts. Selected media and committed transparency persist across restarts.

Local media uses app-scoped opaque IDs rather than whole-file renderer IPC. The mini-electron 0.1.28 protocol adapter buffers each response before delivery, so that runtime does not provide end-to-end media streaming. Windows/Linux native caption controls use a transparent overlay on the HTML titlebar, not an opaque patch; the top resize strip remains inside titlebar bounds and aligned with the right edge when restored/maximized. Model lists and Thinking/Fast/Context window settings remain opaque, theme-matched, and readable over media.

## Isolated Windows wallpaper trial

For a prepared `packages/desktop/release/wallpaper-trial/win-unpacked/` build, launch from repository root with:

```bat
packages\desktop\scripts\launch-wallpaper-trial.cmd
```

Do not launch the unpacked EXE directly: the [launcher](../../packages/desktop/scripts/launch-wallpaper-trial.cmd) provides isolation. Open **Settings → Appearance → Wallpaper → File → Add files**. Local wallpaper testing needs no model configuration. See [Packaging](../packaging.md) for build workflows.

Trial settings remain in `%LOCALAPPDATA%\OMP-Desktop-Wallpaper-Trial`, with separate Electron storage, agent configuration, and loopback daemon. Installed-app conversations, model credentials, and provider environment are not copied. Existing trial data stays; existing non-trial directories are refused. Its native title identifies the trial; reopening foregrounds the same window without stopping its daemon.

Windows `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, and `LOCALAPPDATA` keep system values for native-picker Quick Access. Only `HOME` and explicit OMP/Electron/daemon directories are isolated. The launcher neither copies, resets, nor recreates Quick Access. Restart after launcher changes; prior wallpaper records/settings survive.

`PASEO_DISABLE_APP_UPDATES=1` disables updates, including manual install and install-on-quit. This is a wallpaper-only trial, **not a Windows sandbox**. Do not enable launch-at-login or install CLI/system integrations: OS-level effects lie outside its isolation.

## Touch and hybrid input

Touch-enabled browsers and compact layouts expose project, conversation, tab, and file actions without hover/right-click. Workspace-header **+** adds Agent, terminal, changes, or files tabs; tab **More** offers close actions. Project/conversation menus keep desktop-context-menu actions. Mouse hover, secondary click, drag, and shortcuts continue working with peripherals.

File explorer **Select files**, **Move selected items**, and explicit **Move here** include the workspace root. Touch actions also expose code copying and fullscreen-diagram panning. On touch/compact browsers, transcript text selection exposes **Quote** and **Ask** without hover; Desktop uses the mouse context menu instead. Tap context meter for details.

App-wide **Settings → Chat behavior** contains conversation defaults; **Settings → Host connections** contains relay/pairing controls on the compact interface. Projects and provider settings remain under their selected host. See [Models and providers](models-and-providers.md), [Usage and quotas](usage-and-quotas.md), and [Workspaces, files, and Git](workspaces-files-git.md).
