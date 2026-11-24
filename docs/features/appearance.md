# Appearance and input

Customize local appearance, understand platform window behavior, and use touch/hybrid layouts. Optional [Wallpaper](https://github.com/iris-cat-dev/omp-plugins/blob/main/wallpaper/README.md) and [Desktop pet](https://github.com/iris-cat-dev/omp-plugins/blob/main/desktop-pet/README.md) features have plugin-owned guides.

## Contents

- [Language and display preferences](#language-and-display-preferences)
- [Window and theme behavior](#window-and-theme-behavior)
- [Wallpaper plugin](https://github.com/iris-cat-dev/omp-plugins/blob/main/wallpaper/README.md)
- [Touch and hybrid input](#touch-and-hybrid-input)

## Language and display preferences

**Settings → General → Language → System** chooses the first supported system language; an explicit selection takes precedence. macOS reads actual OS language preference order, not a fixed browser locale. Restart Desktop after changing macOS language preferences.

**Settings → General** groups language, terminal scrollback, editor preferences, notifications, and diagnostics. **Vim keybindings** applies to source files on Web and Desktop. Desktop keeps notification permission/settings, refresh, sound, and test-send controls together in its **Notifications** group. **App diagnostic → Run** opens the diagnostic report from the same page. Editor, Notifications, and Diagnostics no longer have separate navigation entries or pages; existing preference values are retained.

**Settings → Chat behavior → Detail level** controls reasoning expansion, tool-call detail, and the Web chat outline. **Settings → Chat behavior → Show files after each response** hides file chips without hiding statistics when off; it defaults on and persists across restarts. General no longer includes the Detail level section; existing values are retained.

Conversation prose uses medium weight with semibold emphasis, with deeper near-black primary text in the light theme. Code remains regular weight; font sizes, line heights, and secondary tones are unchanged. Math retains bundled KaTeX fonts even if the interface font changes; see [Messages and media](messages-and-media.md).

Task cards use one authored step below the conversation content font size and the prose line height scaled to it, including custom font-size settings. Card titles and phase labels also use the prose's medium weight; the active phase is emphasized by color and background, not heavier text. Phase and task rows have additional vertical padding, with wider icon gaps and card insets. Long tasks wrap without truncation; phase expansion and panel collapse remain independent.

## Window and theme behavior

Desktop's full-width titlebar sits above the sidebar and workspace tabs. The sidebar shares its background, and the sidebar toggle stays in the titlebar when collapsed. Panel toggles, script controls, and new-tab launcher occupy the right side; only the focused workspace supplies them, even when navigation keeps other workspaces mounted.

Workspace tabs sit directly below the titlebar without a duplicate header. Native window buttons keep reserved space. Tabs have edge-to-edge square corners, thin separators, an active content-matched background, and a close button on selection/hover.

On macOS, dragging and double-click zoom/restore use native AppKit, including when maximized; there is no Windows/Linux manual restore-and-drag fallback. Double-click respects the macOS titlebar action preference. On Windows, a single click on maximized titlebar leaves it maximized, double-click restores, and only actual drag motion starts restore-and-drag. Interactive buttons/controls stay outside drag regions.

Sidebar and workspace dividers clear hover highlights and release mouse capture when the window loses focus, regains focus, or becomes hidden. Interrupted workspace resizing keeps the last previewed pane sizes; moving the mouse after returning does not continue the old drag.

The document `color-scheme` follows resolved theme so native selection and form controls match light/dark mode. Compact Web headers use a 44px row without extra top padding and retain safe-area insets; native mobile and Desktop-wrapper spacing is unchanged.

**Settings → Connections** lists saved hosts, connection state, and daemon version above relay/pairing controls. **About** shows app version and Desktop app updates, not the host list. Remote hosts offer **Disconnect / Reconnect** in host pickers, this list, and host overviews. Disconnect preserves the saved connection and cached workspace data, stops probing and automatic reconnection, and persists after restart. Reconnect resumes that connection. Neither action stops the remote daemon; **Remove host** is separate. See [Remote hosts](../remote-hosts.md).

Windows/Linux native caption controls use a transparent overlay on the HTML titlebar, not an opaque patch; the top resize strip remains inside titlebar bounds and aligned with the right edge when restored/maximized.

## Wallpaper

Setup, local candidate management, file/URL formats, transparency, loading, resource handling, and platform limits are maintained in the [Wallpaper plugin guide](https://github.com/iris-cat-dev/omp-plugins/blob/main/wallpaper/README.md). Required regressions and historical GUI evidence are in its [qualification notes](https://github.com/iris-cat-dev/omp-plugins/blob/main/wallpaper/docs/qualification.md).

## Touch and hybrid input

Touch-enabled browsers and compact layouts expose project, conversation, tab, and file actions without hover/right-click. Workspace-header **+** adds Agent, terminal, changes, or files tabs; tab **More** offers close actions. Project/conversation menus keep desktop-context-menu actions. Mouse hover, secondary click, drag, and shortcuts continue working with peripherals.

File explorer **Select files**, **Move selected items**, and explicit **Move here** include the workspace root. Touch actions also expose code copying and fullscreen-diagram panning. On touch/compact browsers, transcript text selection exposes **Quote** and **Ask** without hover; Desktop uses the mouse context menu instead. Tap context meter for details.

App-wide **Settings → Chat behavior** contains conversation defaults; **Settings → Host connections** contains relay/pairing controls on the compact interface. Projects and provider settings remain under their selected host. See [Models and providers](models-and-providers.md), [Usage and quotas](usage-and-quotas.md), and [Workspaces, files, and Git](workspaces-files-git.md).
