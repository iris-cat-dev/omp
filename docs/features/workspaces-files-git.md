# Workspaces, files, and Git

Manage project layouts and conversation ownership, work with files and terminals, and review Git changes. See [Conversations](conversations.md) for execution and [Messages and media](messages-and-media.md) for file links and image rendering.

## Contents

- [Project focus and panel ownership](#project-focus-and-panel-ownership)
- [Conversation names and navigation](#conversation-names-and-navigation)
- [Empty workspaces and drafts](#empty-workspaces-and-drafts)
- [Terminals and split panes](#terminals-and-split-panes)
- [File selection and moves](#file-selection-and-moves)
- [Attachments and local previews](#attachments-and-local-previews)
- [File discovery and editing](#file-discovery-and-editing)
- [Git changes](#git-changes)

## Project focus and panel ownership

On macOS, **Cmd-click a project in the workspace sidebar** to focus it. Ordinary click still expands/collapses it; focus does not change collapse state. The sidebar remains global, while center tabs, right panel, bottom terminal panel, selections, and split sizes are saved per project and host.

Switching projects restores panels without closing conversations, terminating terminals, or archiving workspaces. Unsent drafts and unsaved editors survive. Files and terminals retain their owning checkout even when two worktrees have identical relative paths. Empty projects can be focused without creating workspaces; **New conversation** creates the first draft.

### Existing layout migration

Old mixed layouts are automatically assigned using the same ownership/checkout context as new tabs. Conversations and terminals follow their actual workspace. Files follow their recorded opener or focused checkout, defaulting to the original route workspace if no opener was saved. No manual workspace-selection page is needed.

Migration waits for necessary workspace/conversation/terminal metadata and retries after hydration, directory updates, or reconnection. Pending records remain saved without blocking the workspace. Only references proven deleted by a complete catalog are removed; migration never creates, unarchives, restarts, or stops backend resources.

When old layouts merge into one project, tab state remains, the first split tree is kept, and incoming tabs join matching panes. Entity tabs use current identity/deduplication rules. Migrated layouts persist across client restart.

## Conversation names and navigation

Double-click a sidebar conversation row to rename inline; **Enter** confirms and **Esc** cancels/restores the original. The row's Rename action uses the same editor, and tab context menus also rename. Renaming a primary conversation changes its workspace name; additional conversations retain their own titles.

Accepted names update tabs immediately, without waiting for directory events, and remain visible across tab changes even for unloaded conversations or unavailable provider history. Each tab's title and rename target come from its conversation's own workspace, including mixed-workspace tabs within one project. Focus changes may change tools' active workspace, never a conversation's primary-workspace identity or saved name. Tab-width measurements do not own names or selection. Saved metadata is published for unloaded conversations, and session initialization preserves concurrent renames.

Opening a sidebar conversation preserves existing tabs in that project. Its draft keeps its own execution workspace. Opening a conversation from another project switches to that project's layout instead of adding to the current tabs.

A workspace without a conversation opens its own overview rather than showing a sibling conversation. The overview shows name, branch, changes, **New conversation**, and **View changes**. On desktop splits, changes open **Changes** in the side panel once per overview tab. A draft already containing text/attachments is focused instead; untouched drafts become the overview, so repeated clicks do not stack tabs. Titled empty workspaces (including those from `create_workspace`) retain titled sidebar rows; only untitled drafts are **New workspace**.

Archiving closes only that conversation's tabs, without creating drafts or relabeling surviving entries. Another focused conversation in the same project stays focused and navigation uses its owner. Workspace-open intents are page-scoped so consumed parent-route intents cannot reopen archived conversations elsewhere. Notification navigation likewise reveals/adds in the owning project while preserving tabs, order, and splits, never changing ownership.

## Empty workspaces and drafts

Closing the last empty conversation tab returns to the project page. Supported hosts also archive its unused workspace record, removing the branch-named sidebar row without deleting project files or the project.

Cleanup preserves history (including archived agents), live/pending resources, custom titles, pins, labels, and worktree ownership. Older hosts need updates. To retry an existing empty entry, reopen it and close its empty tab; entries are never bulk-removed just for being named `main`.

Delete an unsent **New workspace** draft with its sidebar hover button or context menu. Only that draft's input/attachments are cleared; other conversations and files remain. Removing the last content tab returns to the project page.

Sidebar draft deletion retires its workspace once no other content tab hosts it. **Files**, **Changes**, and **Pull request** companions do not keep an empty conversation alive and close only after daemon archive confirmation. Other editors/drafts remain. Each sidebar draft has a distinct workspace, so siblings cannot keep a deleted draft alive or leave a checkout-named row.

If the deleted workspace owns the current route, navigation follows a surviving focused conversation. Draft tabs with missing workspace records are pruned when layouts load. The daemon rechecks emptiness before archiving.

Conditional cleanup scopes in-flight content changes and agent registration to their owning workspace. Creating a conversation or renaming another workspace—even from another client on the same host—does not leave a deleted empty draft behind as a branch-named row. Operations whose workspace ownership is not yet known still conservatively prevent cleanup until they finish.

## Terminals and split panes

Side-by-side conversations respond to their pane width, not whole-window width. If an expanded task rail leaves insufficient room for a complete compact conversation/composer, both rail and toggle hide until space returns, restoring expansion. Resizing/maximizing keeps text and controls within the pane.

The header bottom-panel button and **Cmd+Shift+\\** on macOS toggle terminals. Hiding retains tabs, selected terminal, split sizes, and live shell processes, including across client reload. Showing restores them; a terminal is created only if no bottom terminal panel exists. Use terminal-tab **Close** to terminate a session.

The **+** beside the bottom terminal tabs creates and selects another terminal in the same pane. With the built-in zsh integration, starting a command changes the tab title to the executable name (for example, `sleep` or `node`); returning to the prompt restores the current directory. Application-provided terminal titles still take precedence while running, and manually renamed terminals keep their titles. Other shells retain their own terminal-title escape-sequence behavior.

Desktop scroll surfaces use compact terminal-style scrollbars. Sidebar and vertical splitters have two-pixel accent hover highlights without reducing invisible drag targets. Hit areas sit above adjacent panes, including horizontal terminal splits, and opt out of native window dragging so overhanging edges resize rather than move the window. Divider movement follows pointer distance even beside hidden panes; hidden panes retain stored sizes for restoration.

Adding or removing split panes invalidates saved resize weights with a different pane count. The current layout's sizes apply instead, keeping the Files divider draggable in both directions after opening a second side-by-side conversation. Compatible saved weights, including those of temporarily hidden panes, remain in use.

## File selection and moves

- **Ctrl/Cmd-click** toggles individual file/folder selection. **Shift-click** selects a contiguous range from the anchor; **Ctrl/Cmd+Shift-click** adds that range. These select without opening files or expanding folders.
- macOS **Control-click** is a context menu, never selection toggle. A menu on selected entries preserves the group and anchor; on an unselected entry it selects only that row.
- **Select files**, selection checkboxes, and row **More actions** work on desktop and touch without modifiers or secondary clicks. In checkbox mode, folder labels still expand/collapse and file labels toggle selection instead of opening.
- Multi-selection menus show count, **Copy path**, **Copy relative path** (one path per line), and **Delete**. Single-item rename/duplicate/download/reveal are hidden for groups; **Move selected** remains in the selection toolbar. Single-item menus retain normal actions.

Desktop Files-tree pointer dragging moves a file/folder into another folder in the same workspace; selected items move together. Blank tree space targets the root. Folder/nested-row indentation and action controls are not root-drop space: drop on the folder label to enter it; gutters/control drops do nothing. A translucent icon/name preview with multi-selection count follows the pointer within the window without blocking targets, disappearing on completion/cancellation.

Tree moves use pointer dragging, not native HTML drag-and-drop. **Escape** cancels before release. Folders cannot move into themselves/descendants, and cross-workspace moves are unsupported.

On touch, **Select files → Move selected items → Move here** provides explicit destinations, including workspace root. See [Appearance and input](appearance.md#touch-and-hybrid-input) for other non-hover controls.

## Attachments and local previews

These actions add content without sending the draft:

- Desktop/Web: drag a Files-tree entry to the composer in the same workspace for a workspace-file reference or directory attachment, not a move. Directories carry absolute paths, not uploaded contents. The input highlights and gains focus on drop; repeat drops avoid duplicate references. With multiple selected rows, only the row where dragging starts goes to chat (tree-to-tree still moves all). **Escape** cancels.
- Drop external files onto the input for attachments. On a local Desktop host, folders become directory attachments. macOS Retina and Windows high-DPI use the same visible target; Windows native OLE drops reject access through reparse-point path components.
- Paste clipboard images, including Windows native PNG and DIB/DIBV5. Windows editable-input context menus provide native Cut/Copy/Paste/Select All.

Drop external UTF-8 text files onto history or ordinary areas to open local read-only file tabs, not a dialog or upload. Each offers **Preview / Source**, rendering Markdown/HTML in Preview. Outside workspaces they use a dedicated tabbed preview page. Mode survives tab switching; closing releases content; reload removes these session-only tabs. Files up to **2 MiB**, including extensionless files, are supported; directories, binary files, and larger files show explanations. Terminal surfaces retain their file-path drop behavior.

## File discovery and editing

File tabs preview PNG, JPEG, GIF, WebP, SVG, and case-insensitive `.ico` as images rather than binary placeholders.

A file tab's **Reveal in Files** opens the right Files panel, expands parents, selects, and scrolls to the file, making hidden files visible if needed. It uses the owning workspace on local/remote hosts and cannot reveal files outside that workspace.

Visible Files-tree roots and expanded directories refresh when a conversation in their workspace finishes, fails, or is canceled. Hidden retained panels defer initialization and coalesce completion revisions until shown again. Background conversations refresh only their own workspace, and older replies cannot overwrite newer ones. Reopening collapsed directories rereads children instead of trusting unchecked cache. Failed directory refreshes stay visible even if another succeeds. Manual refresh covers external filesystem changes.

Large directories remain complete: listing metadata work has bounded concurrency, and the tree mounts a viewport-sized window rather than every file. Measured row geometry provides the full scroll range, including the last file, while preserving inline create/rename and move-mode sizing. Unchanged directory ordering is reused until its listing, sort, or hidden-file setting changes; selections in collapsed directories remain available.

Desktop native editing shortcuts:

| Action                                 | macOS         | Windows        |
| -------------------------------------- | ------------- | -------------- |
| Select all / copy / cut / paste / undo | Cmd+A/C/X/V/Z | Ctrl+A/C/X/V/Z |
| Redo                                   | Cmd+Shift+Z   | Ctrl+Y         |

Zoom uses **Cmd+=** or **Cmd+Shift+=**, **Cmd+-**, and **Cmd+0** (actual size); Windows/Linux substitute Ctrl. Zoom is suspended during custom-shortcut recording. Windows **Ctrl+K** opens command palette and **Ctrl+,** opens Settings.

Editable source tabs use **Ctrl+/** to toggle comments in the current file type; macOS **Cmd+/** also works. On a local Desktop host, a file tab's context menu reveals in **Finder**, **Explorer**, or **Files**, localized to the app language. Remote files and Web clients do not offer it. Desktop editor targets expose only ID, label, and kind; detection/opening does not depend on bundled editor icon images.

On Windows, desktop file-manager actions normalize forward or mixed path separators to native backslashes before opening a directory or revealing an entry in Explorer. This includes paths with spaces, Unicode names, and UNC shares; macOS/Linux paths remain unchanged.

## Git changes

### Comparison modes

Open **Changes → Git actions → Diff mode**. The checked mode is:

- **Uncommitted** (default): working-tree and staged changes. A clean checkout says **No uncommitted changes** even with committed/unpushed branch work.
- **Compared with `<baseRef>`**: differences from the displayed comparison branch, such as `origin/main`; commits do not clear those differences.

Modes can switch with empty or populated lists. Forge account setup never blocks local diff viewing or mode changes. Operation names, comparison labels, and action feedback follow General language in every supported locale. **Archive workspace** and **Open Changes tab** are not Git-menu actions.

Diff scrolling preserves transparent wallpaper without accumulated red/green shading or text trails. Pixel reuse depends on document/viewport heights, not a fixed changed-line threshold.

The Changes tree keeps full file summaries while virtualizing rows. Folder stage, unstage, and discard actions resolve descendant paths when invoked, preserving rename source/destination pathspecs. A single uncommitted summary shares untracked-file inspections across its net and unstaged views; later requests reread files. Closing or replacing a subscription prevents abandoned results and queued refreshes from being published, without canceling remaining shared consumers. Already-running Git and filesystem operations may finish.

### Discard behavior and large selections

Discarding unstaged changes preserves staged content. Full discard restores selected tracked paths to `HEAD` and removes selected untracked files. Large selections use NUL-separated stdin for `reset`, `checkout`, and `rm --cached`; `status`/`clean` split path arguments by Windows-escaped UTF-16 length to avoid command limits without broadening selection.

Only a symbolic branch with no existing ref counts as unborn `HEAD`. Process-start, index-lock, and corrupt-HEAD failures propagate instead of triggering index removal.
