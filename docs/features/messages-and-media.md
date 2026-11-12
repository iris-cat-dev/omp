# Messages, links, and media

Read assistant output, inspect/save images, open workspace links safely, and configure external browsers. For generating images see [Tools and plugins](tools-and-plugins.md#image-generation-with-references); for file editing see [Workspaces, files, and Git](workspaces-files-git.md).

## Contents

- [Sending messages](#sending-messages)
- [Long input messages](#long-input-messages)
- [Images and previews](#images-and-previews)
- [Links and local files](#links-and-local-files)
- [External browser selection](#external-browser-selection)
- [Math](#math)
- [Thinking and tool calls](#thinking-and-tool-calls)
- [Turn statistics](#turn-statistics)

## Sending messages

Sending immediately clears the composer and adds one message to the conversation, before workspace validation, workflow-language synchronization, attachment encoding, or host acceptance completes. Sending/loading indicators remain active until submission finishes. The host's canonical message reconciles with the local row by client message ID rather than creating a duplicate.

If validation or sending fails, the unacknowledged local row is removed and the error is shown. The submitted text and attachments return to an empty composer without overwriting newer input or another conversation's draft. A message already acknowledged by the host remains in the conversation.

Uploaded-file attachments preserve their Unicode basename in the composer, message, and agent input. Disk storage names are sanitized separately; path prefixes and control characters are not accepted as display names.

Enabled plugin attachment sources appear in the composer's **+** menu. Local Desktop sources remain available when changing hosts; daemon sources belong to the selected host. Choosing a resource captures its complete text and source metadata. Open the composer's attachment pill to read that snapshot. Sending submits the saved text, without searching or fetching the source again.

After sending, click the attachment card in the message to read its complete saved text. Reopening the conversation or disabling/removing the source plugin preserves both the text and metadata; the reader does not call the source plugin. Registered local commands that finish without invoking the agent also retain their submitted text and attachments in history.

## Long input messages

Sent input text taller than six rendered lines starts collapsed. Choose **Expand full message** to read it and **Collapse** to fold it again. Wrapping follows the available width; short text has no disclosure control. Copy and rewind retain the complete original message, and image/file attachments remain outside the collapsed text. Long skill arguments follow the same rule; expanding the skill still shows its full instructions.

History bodies are reloadable rather than retained without bound: the renderer uses conservative UTF-16 accounting with a 24 MiB visible-history budget and a 32 MiB background-history budget. Encoded image data has a separate 12 MiB budget; decoded image estimates have a 24 MiB budget. Active/pinned content can exceed a budget and is reported as retained over-budget rather than silently dropped. These accounting bytes are not a measured JavaScript heap or physical process-memory limit.

Complete `File` attachment bodies remain persisted and available for source rereads; they do not use the generic 500,000-character tool-text truncation. Image bodies remain externalized to private storage and private transport fields are stripped from public history.

## Images and previews

Click an image attachment or generated image to open a full-window preview. Loaded assistant images, including `generate_image` and `present_image`, also show **View full screen** at the upper-right; loading/failed images do not. Use mouse wheel or **Zoom in / Zoom out**, drag an enlarged image to pan, and choose **Fit to window** or **Actual size (100%)**. Close or **Esc** returns to chat. Desktop's window-close-choice dialog stays above the preview; canceling leaves the image open.

Chat previews match the image's displayed width and screen pixel density, updating when the pane is resized. Portrait images retain proportional height, and smaller originals are not resampled. Off-screen previews release their decoded resources; fullscreen loads the original image for inspecting fine text and details.

Image-tool badges follow interface language and show one action label without repeated status text. When multiple tools preview the same image in one turn, Desktop keeps the first preview and both tool records. Standalone tools, different images, and images repeated in a later turn retain previews.

Native generation/publication previews are copied into private content-addressed image files. History also understands OMP image-blob references, avoiding dependence on native temporary files. Workspace tabs preview ICO (case-insensitive `.ico`) alongside PNG, JPEG, GIF, WebP, and SVG; see [File discovery](workspaces-files-git.md#file-discovery-and-editing).

To annotate a screenshot or revise text before sending it back to AI, choose **+ → Screenshot annotation**. See [Screenshot annotation and text feedback](tools-and-plugins.md#screenshot-annotation-and-text-feedback) for the editor, AI tool, capture permissions, and submission behavior.

### Continuing after an image error

In SDK-backed conversations, an invalid, unsupported, undecodable, or over-limit image input ends the failed turn once instead of repeatedly resending it. The warning explains that images from the rejected request's history were removed while text and tool results were kept. Continue in the same conversation, or upload valid images within the provider's format, size, and count limits.

The cleanup is persisted. Previously stuck conversations also recover on their next message after reopening. Images attached after the failed turn and later uploads remain usable. Enhanced workflow stops automatic continuation for these image-input validation errors; authentication, quota, and service failures keep their existing handling.

### Copy and save

On Desktop, right-click generated/displayed images, including fullscreen previews, for **Copy Image** or **Save Image As…**. Copy writes image pixels to the system clipboard; save preserves the original file, including `data:`/`blob:` previews. Native menus follow interface language.

On mobile Web, long-press an image in chat or fullscreen preview and use the browser's save-image action; desktop browsers can use their image context menu. Raster attachments stored in Web IndexedDB use self-contained data URLs rather than blob URLs so browsers unable to save blob URLs retain original bytes. Non-image attachments keep revocable blob previews.

## Links and local files

- HTTP(S) links open externally.
- Text/source links open in the workspace file panel. Ordinary local Desktop `.html` / `.htm` links open in the selected external browser; explicit source-line links still open internally at that line.
- On a local Desktop host, existing images, documents, archives, and directories inside the workspace open with the OS. Executables are revealed in the file manager, **not executed**.
- Web conversation headings support native `#heading` navigation.

Unopenable targets appear as plain text, not colored links; clicking reports unsupported-link errors. Failed file/URL opens also show errors. `sandbox:` is not a local path: conversation data provides no authoritative host-attachment mapping, so it cannot open without one. Remote binary files cannot be opened by the local Desktop file manager.

Desktop HTTP(S) link context menus offer opening in the selected browser and copying the address. Unsupported schemes have no Open action; an unavailable plain **Copy** action is omitted.

For a resolvable local file link on Desktop, explicit right-click can reveal it in the system file manager (Explorer on Windows), including files outside the workspace such as Downloads. Relative paths, encoded names, and line suffixes resolve as on left-click. The main process requires existing absolute local paths and resolves symlinks, but reveal never opens/executes the target. Remote links have no local reveal. Ordinary OS/browser file opening remains workspace-confined and rejects symlink escapes.

The input's native context menu preserves selection and image-attachment paste behavior with **Cut / Copy / Paste / Select All**. Read-only targets do not offer Paste. See [Attachments and local previews](workspaces-files-git.md#attachments-and-local-previews) for drops and clipboard images.

## External browser selection

Choose **Settings → General → Browser**. **System default** follows the OS; installed Chrome, Edge, Firefox, Brave, Chromium, and Safari appear where supported. If the chosen browser is later removed, Desktop reports unavailable rather than silently switching.

For **Custom executable**, enter an absolute browser/launcher path and ordered arguments, then **Save custom browser**. Each argument is passed literally, preserving spaces, quotes, backslashes, newlines, and empty values. Exactly one argument must equal `{url}`; it is replaced in full with the original HTTP(S) URL or the validated local webpage's encoded file URL. Do not shell-quote paths or embed `{url}` in another argument.

For example, select executable `C:\Program Files\Google\Chrome\Application\chrome.exe` and two separate arguments:

```text
--profile-directory=OMP Profile
{url}
```

Windows requires native `.exe` or `.com` launchers; `.cmd`/`.bat` are rejected because they require shell interpretation. On macOS choose the executable inside the app bundle, not the `.app` directory. Custom failure reports an error without fallback. Saved arguments survive changing targets and restarting.

This setting affects OMP's external HTTP(S) links and ordinary local-workspace HTML/HTM opens. **System default** uses the OS's HTTPS browser even if HTML files are associated with an editor. Local webpage opening checks the existing real path, workspace containment, file type, and executable restrictions; it does not permit arbitrary `file:` URLs through the HTTP(S) opener. It does not change the OS browser default, other apps, or assistant browser relay/CDP settings.

## Math

Assistant Markdown supports:

- Inline `$...$`, `\(...\)`, and same-line `\[...\]`.
- Standalone display `$$...$$` or `\[...\]` blocks, including inside quotes and lists.
- `\vec{v}` as both vector arrow and bold symbol; `\mathbf{v}` for bold-vector notation.
- TeX-command dollar formulas with inner padding, such as `$ \dot x=Ax+Bu $` or `$ \frac{dy}{dx} $`.

Ordinary currency such as `$5 and $10` or `$ 5 and $ 10` remains prose. Inline formulas close at the first unescaped dollar. Bundled KaTeX fonts remain when interface fonts change. `\binom61` displays 6 above 1 in full-height parentheses without a fraction bar. Fraction bars follow foreground, including explicit TeX colors, in light/dark themes.

## Thinking and tool calls

**Settings → General → Detail level** controls reasoning expansion, tool detail, completed-response files, and the Web outline. **Show files after each response** defaults on, persists, and can hide file chips without hiding statistics. Existing preferences are retained from their former Appearance location.

Collapsed activity groups display a compact theme-aware layers/count pill, updating as activity arrives. Expansion hides the pill and reveals items. Read-tool file buttons strip range selectors before opening; comma-separated selectors use the first range for preview selection. Expanded tools with no additional details show a compact centered hint with regular secondary text and consistent light/dark padding.

OMP supervised-process completion notifications use the same collapsible rows as tools, with the process name, localized status, and exit code when supplied. Adjacent notifications, reasoning, and tools share a **Thinking and tool calls** group. Expand a process row to inspect its exit details; records without recognized process metadata retain their complete original notification in the expandable detail. These notifications do not become assistant-response footer anchors.

Native plugin custom replies preserve original punctuation and do not complete a turn; see [Plugin management](tools-and-plugins.md#native-extension-replies-and-commands).

## Turn statistics

Completed assistant turns display duration, completion time, total tokens, and average output speed in the selected interface language. Completion time is always beside duration, without hover/tap. Weekdays/dates follow interface language; the clock follows system 12/24-hour preference. Missing metadata is omitted independently; footers wrap on narrow screens. Running duration/speed use the same localized units.

For indexed host-wide totals, provider quotas, and billing caveats see [Usage and quotas](usage-and-quotas.md).
