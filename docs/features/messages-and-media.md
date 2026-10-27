# Messages, links, and media

Read assistant output, inspect/save images, open workspace links safely, and configure external browsers. For generating images see [Tools and plugins](tools-and-plugins.md#image-generation-with-references); for file editing see [Workspaces, files, and Git](workspaces-files-git.md).

## Contents

- [Images and previews](#images-and-previews)
- [Links and local files](#links-and-local-files)
- [External browser selection](#external-browser-selection)
- [Math](#math)
- [Thinking and tool calls](#thinking-and-tool-calls)
- [Turn statistics](#turn-statistics)

## Images and previews

Click an image attachment or generated image to open a full-window preview. Loaded assistant images, including `generate_image` and `present_image`, also show **View full screen** at the upper-right; loading/failed images do not. Use mouse wheel or **Zoom in / Zoom out**, drag an enlarged image to pan, and choose **Fit to window** or **Actual size (100%)**. Close or **Esc** returns to chat. Desktop's window-close-choice dialog stays above the preview; canceling leaves the image open.

Image-tool badges follow interface language and show one action label without repeated status text. When multiple tools preview the same image in one turn, Desktop keeps the first preview and both tool records. Standalone tools, different images, and images repeated in a later turn retain previews.

Native generation/publication previews are copied into private content-addressed image files. History also understands OMP image-blob references, avoiding dependence on native temporary files. Workspace tabs preview ICO (case-insensitive `.ico`) alongside PNG, JPEG, GIF, WebP, and SVG; see [File discovery](workspaces-files-git.md#file-discovery-and-editing).

To annotate a screenshot or revise text before sending it back to AI, choose **+ → Screenshot annotation**. See [Screenshot annotation and text feedback](tools-and-plugins.md#screenshot-annotation-and-text-feedback) for the editor, AI tool, capture permissions, and submission behavior.

### Copy and save

On Desktop, right-click generated/displayed images, including fullscreen previews, for **Copy Image** or **Save Image As…**. Copy writes image pixels to the system clipboard; save preserves the original file, including `data:`/`blob:` previews. Native menus follow interface language.

On mobile Web, long-press an image in chat or fullscreen preview and use the browser's save-image action; desktop browsers can use their image context menu. Raster attachments stored in Web IndexedDB use self-contained data URLs rather than blob URLs so browsers unable to save blob URLs retain original bytes. Non-image attachments keep revocable blob previews.

## Links and local files

- HTTP(S) links open externally.
- Text/source links open in the workspace file panel.
- On a local Desktop host, existing images, documents, archives, and directories inside the workspace open with the OS. Executables are revealed in the file manager, **not executed**.
- Web conversation headings support native `#heading` navigation.

Unopenable targets appear as plain text, not colored links; clicking reports unsupported-link errors. Failed file/URL opens also show errors. `sandbox:` is not a local path: conversation data provides no authoritative host-attachment mapping, so it cannot open without one. Remote binary files cannot be opened by the local Desktop file manager.

Desktop HTTP(S) link context menus offer opening in the selected browser and copying the address. Unsupported schemes have no Open action; an unavailable plain **Copy** action is omitted.

For a resolvable workspace file link on the local Desktop host, right-click can reveal it in the system file manager (Explorer on Windows) without opening/executing. Relative paths, encoded names, and line suffixes resolve as on left-click. Remote links have no local reveal; missing targets and paths outside the workspace, including symlink escapes, are rejected with errors. Left-click behavior is unchanged.

The input's native context menu preserves selection and image-attachment paste behavior with **Cut / Copy / Paste / Select All**. Read-only targets do not offer Paste. See [Attachments and local previews](workspaces-files-git.md#attachments-and-local-previews) for drops and clipboard images.

## External browser selection

Choose **Settings → General → Browser**. **System default** follows the OS; installed Chrome, Edge, Firefox, Brave, Chromium, and Safari appear where supported. If the chosen browser is later removed, Desktop reports unavailable rather than silently switching.

For **Custom executable**, enter an absolute browser/launcher path and ordered arguments, then **Save custom browser**. Each argument is passed literally, preserving spaces, quotes, backslashes, newlines, and empty values. Exactly one argument must equal `{url}`; it is replaced in full with the original HTTP(S) URL. Do not shell-quote paths or embed `{url}` in another argument.

For example, select executable `C:\Program Files\Google\Chrome\Application\chrome.exe` and two separate arguments:

```text
--profile-directory=OMP Profile
{url}
```

Windows requires native `.exe` or `.com` launchers; `.cmd`/`.bat` are rejected because they require shell interpretation. On macOS choose the executable inside the app bundle, not the `.app` directory. Custom failure reports an error without fallback. Saved arguments survive changing targets and restarting.

This setting affects only OMP's external HTTP(S) links. It does not change the OS browser default, other apps, or assistant browser relay/CDP settings.

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

Native plugin custom replies preserve original punctuation and do not complete a turn; see [Plugin management](tools-and-plugins.md#native-extension-replies-and-commands).

## Turn statistics

Completed assistant turns display duration, completion time, total tokens, and average output speed in the selected interface language. Completion time is always beside duration, without hover/tap. Weekdays/dates follow interface language; the clock follows system 12/24-hour preference. Missing metadata is omitted independently; footers wrap on narrow screens. Running duration/speed use the same localized units.

For indexed host-wide totals, provider quotas, and billing caveats see [Usage and quotas](usage-and-quotas.md).
