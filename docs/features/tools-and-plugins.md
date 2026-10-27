# Tools, plugins, and image generation

Configure native OMP tool requests, manage runtime plugins, and enable image generation. These controls do not replace filesystem permissions or [approval rules](conversations.md#approval-changes-during-a-session).

## Contents

- [OMP built-in tools](#omp-built-in-tools)
- [Browser and computer use](#browser-and-computer-use)
- [Screenshot annotation and text feedback](#screenshot-annotation-and-text-feedback)
- [Plugin management and native commands](#plugin-management-and-native-commands)
- [Bundled-plugin ownership and verification](#bundled-plugin-ownership-and-verification)
- [Private Windows three-plugin distribution](#private-windows-three-plugin-distribution)
- [Image generation with references](#image-generation-with-references)

## OMP built-in tools

**Host Settings → Agents → OMP built-in tools** requests tools for new/resumed sessions. Expand the initially collapsed list to toggle tools, request all off, or reset. Choices persist per host. All-off passes `--no-tools`; partial selection passes `--tools <enabled names>`; reset removes the additional flag. Checkpoint and rewind share one switch. Running sessions are unchanged.

Known releases use their tool catalog; unfamiliar versions use the combined known list, not a version whitelist. Desktop checks native `--tools`/`--no-tools` support rather than rejecting unfamiliar releases. Builds sharing a version may expose different tools, so partial selection briefly starts an ephemeral session to request only tools in that build's active roster. No custom OMP build is needed for supported versions.

**This is not a strict denylist.** OMP may add tools excluded from `--tools`, even under `--no-tools`; child agents may use a different list. OMP's own settings may disable selected tools. These choices do not affect standalone OMP sessions, Desktop-injected tools/extensions, or replace permission/approval enforcement. Custom OMP commands cannot combine these settings with their own `--tools`/`--no-tools` flags.

## Browser and computer use

For an idle conversation, choose **Browser use** from the composer's attachment menu for visible browser tools, or **Computer use** for session-specific native desktop capture/input. These run `/browser visible` and `/computer on`, retaining the current draft. They are unavailable while a conversation runs.

The external-link browser preference is separate from assistant browser relay/CDP configuration; see [Messages and media](messages-and-media.md#external-browser-selection).

## Screenshot annotation and text feedback

Choose **+ → Screenshot annotation** (**截图批注**) in the conversation composer to open the visual feedback editor. Import, paste, or drop a PNG, JPEG, or WebP image, take a screenshot, or edit text without an image. The existing composer text becomes editable in the window. **Submit feedback** sends the edited text, overall feedback, numbered annotations, original image, and annotated preview through the conversation's normal send/queue path.

AI can open the same editor with the Desktop host tool `request_visual_feedback`:

OMP receives this tool through its native host-tool catalog; this feature does not start a separate MCP service. When enabled, the existing shared MCP endpoint exposes the same tool for MCP integrations. The **+** menu opens the editor directly and does not require MCP.

```json
{
  "title": "Review the homepage",
  "instructions": "Mark the areas to change and revise the heading.",
  "text": "Current heading",
  "imagePath": "screenshots/homepage.png"
}
```

All fields are optional; relative image paths resolve against the calling agent's workspace. The tool requires an agent-scoped session and the optional Desktop host-tool capability. Requests appear globally, even when another conversation is selected, and wait for an explicit submission or cancellation. Pending requests remain available after reconnect. Closing the window, aborting the tool, daemon shutdown, or the 30-minute timeout returns cancellation without draft text or images.

The editor supports points, rectangles, arrows, freehand strokes, editable numbered notes, annotation movement, rectangle resizing, undo/redo, fit, and zoom. Replacing or removing an image clears incompatible annotations and history after confirmation. Failed submissions preserve edits in the open editor; editor drafts are not persisted across a renderer reload.

Annotations use the submitted original image's pixel coordinates, with a top-left origin, independent of display scaling or zoom. AI receives coordinate metadata and separate original/annotated image content, not base64 embedded in feedback text. The preview may be scaled to a 4096-pixel longest edge; coordinates always refer to the original. Each image is limited to 8 MiB, 32 × 1024 × 1024 pixels, and 32768 pixels per side.

On macOS Desktop, **Take screenshot** uses the system's interactive region selector and temporarily hides the requesting window. Screen-recording permission is required. On Windows Desktop it captures the virtual desktop. Web uses the browser's screen/window/tab picker and stops sharing after capturing one frame. Unsupported or denied capture reports an error; importing or pasting a screenshot remains independent. Capture and editing are local; submitted feedback and images are sent to the selected agent and its configured AI service.

This is an original implementation inspired by [EditHere's feedback workflow](https://github.com/Inginnng/EditHere), not an installation or copy of its noncommercial source.

## Plugin management and native commands

**Host Settings → OMP plugins** browses registered marketplaces and manages native runtime plugins. Marketplace entries show **Install**, **Installed** (current), or **Upgrade** (newer catalog version). Upgrade installs the current catalog version, not a repeated install.

Installed identity is exactly `plugin-name@marketplace-name`; a same-name plugin from another marketplace does not count. Upgrades preserve that exact entry's user/project scope and enabled state.

Management operations use the selected project's cwd, native `.env` discovery, and configured provider profile/environment. Explicit leading `launch` in a provider command is omitted for management only. Omitting enable/disable scope preserves native unique-scope inference; explicit user/project scope remains exact.

Busy actions, including **Remove** while confirmation is open, preserve button dimensions and adjacent spacing; progress overlays the existing icon/text footprint. A recovered catalog retry clears its old error without dismissing feedback from an operation's own refresh.

### Native extension replies and commands

Visible replies retain persisted native entry IDs, original text, and metadata in live/history views, even without model `agent_start`. They never complete a turn: RPC acknowledgements and model lifecycle events own completion. Literal punctuation, JSON quotes, and original text are not rewritten by smart typography; ordinary assistant Markdown keeps normal typography/math. Older history keeps each custom reply separate from adjacent model/custom replies.

Registered native commands are admitted before workflow/stale-plan reset envelopes, including after session restoration. They remain commands rather than model prompts; the next ordinary prompt still receives its workflow reset. Stopping while command discovery is pending cancels that turn: delayed discovery cannot dispatch it or claim a replacement request's identity.

## Bundled-plugin ownership and verification

In private bundled distributions, first-run provisioning holds a separate native process-owned OS lease for the resolved profile. It neither blocks ordinary management nor reaps PID files. Interrupted/unknown link outcomes are not automatically retried. A durable seed ledger preserves uninstall choices across restarts/updates.

Namespace ownership is published only after its marker is written and synced in an unpublished sibling directory while the native lease is still held. Interrupted initialization cannot publish a partial namespace. Existing directories with invalid/missing ownership markers are never adopted or automatically cleaned.

Subsequent provider launches still resolve native cwd/profile and acquire its lease. Payload hashes may be reused within the daemon only while file identity and nanosecond metadata match. Every check walks the complete inventory; changed files are rehashed, while missing, extra, non-regular, or symlinked paths remain errors. Cache is bounded to one payload/manifest and never persisted.

Host hashes are reused only within one launch/management operation with metadata checked at every boundary; the next operation rehashes the host. Settled ledgers are written only on state change. Conversation loading distinguishes actual verification, preparation, and first-install phases from history loading. Completion clears the phase indicator on success/failure, without claiming successful install or bypassing existing errors/degraded history.

Desktop reuses a managed daemon only when live status reports a matching distribution identity. Private identity includes the sealed native-host digest: equal app versions alone are insufficient. Startup, automatic version replacement, and quit cleanup preserve incompatible/unverified daemons even with **Keep daemon running after quit** off. Let tasks finish and explicitly stop that daemon before switching distributions.

The bundled CLI checks live identity before using an implicit local target. Explicit `--host` and `PASEO_HOST` retain their existing behavior. See [Remote hosts](../remote-hosts.md) for host management.

## Private Windows three-plugin distribution

### Contents and authorization boundaries

The separately named `OMP-Desktop-Plugins-Setup-0.5.2-x64.exe` is a **private build, not an upstream release**. It bundles ChatPro **0.1.0**, WorkBuddy **0.1.0**, and WeChat connector **0.1.2**, all sharing one patched native OMP **18.12.3**. It installs no second plugin SDK or account store. Ordered native patches, compiler/addon provenance, exact host digest, and frozen sources live under the ignored `vendor/omp-plugins` input directory, which must be supplied separately and is not part of a public checkout.

Public source releases are [ChatPro](https://github.com/Charlie-chulong/omp-bridge-chatpro) and [WorkBuddy](https://github.com/Charlie-chulong/omp-workbuddy-plugin). The WeChat connector, history, and provenance remain private, absent from the public Desktop repository/PR. All three authorized source/runtime inputs must be provided before opting into this build mode.

Payload includes required private runtimes/licenses, including CPython 3.12/Tk for WeChat. It excludes developer virtual environments, ambient site-packages, credentials, profiles, chat data, and runtime caches. ChatPro/WorkBuddy retain upstream-disabled defaults. WeChat stays disconnected until separate trusted local authorization: preinstallation grants no read/send permission and approves no message.

Private Windows Python supports long profile/snapshot paths without machine-wide policy changes. WorkBuddy uses extended filesystem paths for full manifest hashes/private-state I/O. WeChat's reviewed package-owned portable startup hook normalizes existing isolated import paths after `_pth`/site initialization; it adds no search directories and adopts no ambient interpreter/site-packages.

### First use, uninstall, and updates

The first plugin-management request or provider session seeds missing plugins into immutable profile-owned snapshots; setup does not block daemon listening. The Plugins loading state covers registration. Existing same-name registration, disabled state, and configuration remain. Normal uninstall creates no reinstall obligation: sessions and app updates retain that choice. Explicit local-path installs use native OMP's normal link route. Later apps do not silently upgrade existing plugins to their bundled versions.

Windows snapshot publication briefly waits out `EPERM` sharing conflicts under the same authoritative native lease. Only a new unpublished owned-directory move is retried, never native writes, failed link intents, or uninstall tombstones.

Public Desktop auto-update and generic native OMP download/replacement are intentionally blocked, including native self-update through packaged `manager.json`. Standalone update ownership comes from the executing binary before reading its marker, not another `omp` on `PATH`. Missing running executables fail closed instead of redirecting updates elsewhere.

Upgrade with a compatible private **whole-app installer**, never stock OMP replacement. Real account-backed consultations, WorkBuddy upstream requests, and WeChat reads/sends need separate authorization; no-account qualification does not establish them.

### Building and qualifying the private package

Commands below assume repository root. Build the exact pinned native host and portable WeChat runtime, then stage with:

```sh
node packages/desktop/scripts/stage-bundled-plugins.mjs --host <absolute-host>
```

The [stager](../../packages/desktop/scripts/stage-bundled-plugins.mjs) refuses existing output/binary instead of overwriting. Select the verified mini-electron distribution with `MINI_ELECTRON_DIST_PATH` and run:

```sh
npm run build:windows -- --with-bundled-plugins
```

Output is `packages/desktop/release-plugins`, separate from the previously qualified installer. Packaging loads configuration once, retains qualified resource exclusions, and checks the configured private host against its pinned digest before staging and after copy/packaging hooks, rejecting stock replacements. Private builds must package from source: **`--prepackaged` is unsupported** because it bypasses checks. See [Packaging](../packaging.md) and [Development](../development.md).

Qualification must exercise real Python/native extensions and production WeChat HelperClient ready/status/exit at long profile-owned snapshot depth. Use the packaged `scripts/verify-bundled-runtime.py` for complete WeChat inventory/native-import/Tcl checks; disconnected `/wechat status` alone neither launches nor qualifies that helper.

The first private-profile catalog request copies/verifies complete runtimes. Native packaged qualification uses the existing **180-second diagnostic RPC deadline plus CLI startup allowance**, not the ordinary 60-second command limit; real diagnostics/catalog/plugin checks must still finish successfully. Plugin-page mutation qualification waits for completed real UI refresh before one independent native readback, preventing test polling from queueing extra management behind the action.

## Image generation with references

Desktop uses native OMP `generate_image`, with no separate service or `image_gen` alias. Enable **Host Settings → Image generation**, independently of Desktop host-tool injection.

Choose an OpenAI-compatible API with image model, Base URL, and key, or a ChatGPT subscription account already signed into OMP. Subscription generation uses the selected account without changing chat account; OpenAI chooses the hosted image model. Sources never automatically fall back to each other.

Calls describe subject, scene, style, and requested changes. `input` accepts ordered local reference paths, absolute or relative to the agent workspace. Identify differing roles by list position, such as subject/composition/style. API reference requests use image-edit; subscription requests use OMP's hosted path. With OMP device tools enabled, the same tool is exposed through `xd://generate_image`.

Settings apply on the next agent input, including existing/resumed conversations. Missing/removed image credentials disable image access without blocking chat. See [Messages and media](messages-and-media.md#images-and-previews) for previews and saving, and [Desktop pet](desktop-pet.md#create-and-import-pets) for image-based pet creation.
