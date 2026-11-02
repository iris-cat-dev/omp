# Tools, plugins, and image generation

Configure native OMP tool requests, manage runtime plugins, and enable image generation. These controls do not replace filesystem permissions or [approval rules](conversations.md#approval-changes-during-a-session).

## Contents

- [OMP built-in tools](#omp-built-in-tools)
- [OMP working status](#omp-working-status)
- [Browser and computer use](#browser-and-computer-use)
- [Screenshot annotation and text feedback](#screenshot-annotation-and-text-feedback)
- [Plugin management and native commands](#plugin-management-and-native-commands)
- [Distribution compatibility](#distribution-compatibility)
- [Image generation with references](#image-generation-with-references)

## OMP built-in tools

**Host Settings → Agents → OMP built-in tools** requests tools for new/resumed sessions. Expand the initially collapsed list to toggle tools, request all off, or reset. Choices persist per host. All-off passes `--no-tools`; partial selection passes `--tools <enabled names>`; reset removes the additional flag. Checkpoint and rewind share one switch. Running sessions are unchanged.

Known releases use their tool catalog; unfamiliar versions use the combined known list, not a version whitelist. Desktop checks native `--tools`/`--no-tools` support rather than rejecting unfamiliar releases. Builds sharing a version may expose different tools, so partial selection briefly starts an ephemeral session to request only tools in that build's active roster. No custom OMP build is needed for supported versions.

**This is not a strict denylist.** OMP may add tools excluded from `--tools`, even under `--no-tools`; child agents may use a different list. OMP's own settings may disable selected tools. These choices do not affect standalone OMP sessions, Desktop-injected tools/extensions, or replace permission/approval enforcement. Custom OMP commands cannot combine these settings with their own `--tools`/`--no-tools` flags.

## OMP working status

During an OMP run, the conversation footer shows the latest tool intent next to the loading indicator, token speed, and elapsed time. The label can update while a tool call is being generated, before execution starts; it does not depend on a visible tool card. Missing or empty intent leaves the existing loading indicator unchanged.

New tool intent labels follow **App Settings → General → Language**, including the resolved system language. Desktop supplies an intent-only language instruction before ordinary messages and steering; it does not change assistant response language, commands, code, paths, or other tool arguments. Existing labels are retained as generated, not translated when the interface language changes.

The label belongs to the active run, survives reconnect, and clears when the run completes, fails, or stops. Late events from another or closed run cannot replace it. Saved tool history retains its original intent metadata without turning completed history into a live working status.

## Browser and computer use

For an idle conversation, choose **Browser use** from the composer's attachment menu for visible browser tools, or **Computer use** for session-specific native desktop capture/input. These run `/browser visible` and `/computer on`, retaining the current draft. They are unavailable while a conversation runs.

The external-link browser preference is separate from assistant browser relay/CDP configuration; see [Messages and media](messages-and-media.md#external-browser-selection).

## Screenshot annotation and text feedback

Choose **+ → Screenshot annotation** (**截图批注**) in the conversation composer to open the visual feedback editor. Import, paste, or drop a PNG, JPEG, or WebP image, take a screenshot, or submit text without an image. **Requested changes** (**修改要求**) is always shown. **Message body** (**消息正文**) appears only when an AI request supplies non-whitespace text; once shown, it remains editable for the session even if you clear it.

For the manually opened editor, **Submit feedback** adds one pending **Screenshot annotation** attachment card to the composer. It does not send or queue a message, insert JSON into the input, or change the existing message text and attachments. Open the card to review its requested changes, numbered notes, and annotated image; open the image for a zoomable preview, or remove the card like any other attachment. Only the composer's explicit send/queue action submits its body, requested changes, annotations, original image, and annotated preview.

AI can open the same editor with the Desktop host tool `request_visual_feedback`. In this tool-request flow, **Submit feedback** replies directly to the waiting tool request rather than creating a manual composer attachment:

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

The editor supports points, rectangles, arrows, freehand strokes, editable numbered notes, annotation movement, rectangle resizing, undo/redo, fit, and zoom. Replacing or removing an image clears incompatible annotations and history after confirmation. Failed submissions preserve edits in the open editor; in-progress editor drafts are not persisted across a renderer reload. Completed manual feedback cards are saved with the composer draft, including their body, requested changes, notes, and local references to both images.

Annotations use the submitted original image's pixel coordinates, with a top-left origin, independent of display scaling or zoom. AI receives coordinate metadata and separate original/annotated image content, not base64 embedded in feedback text. The preview may be scaled to a 4096-pixel longest edge; coordinates always refer to the original. Each image is limited to 8 MiB, 32 × 1024 × 1024 pixels, and 32768 pixels per side.

On macOS Desktop, **Take screenshot** uses the system's interactive region selector and temporarily hides the requesting window. Screen-recording permission is required. On Windows Desktop, it temporarily hides the requesting window and opens a frozen, full-desktop region selector. Drag in either direction to select an area, then press **Enter** or **Capture selection**; drag again to replace the selection. **Entire desktop** captures all displays, including their full physical resolution under Windows display scaling. **Esc**, right-click, or **Cancel** returns to the editor without replacing its current image or annotations. The selector shows the selected area's pixel dimensions, and its controls and shading are excluded from the captured image. Web uses the browser's screen/window/tab picker and stops sharing after capturing one frame. Unsupported or denied capture reports an error; importing or pasting a screenshot remains independent. Capture and editing are local; submitted feedback and images are sent to the selected agent and its configured AI service.

This is an original implementation inspired by [EditHere's feedback workflow](https://github.com/Inginnng/EditHere), not an installation or copy of its noncommercial source.

## Plugin management and native commands

**Host Settings → OMP plugins** browses registered marketplaces and manages native runtime plugins. Marketplace entries show **Install**, **Installed** (current), or **Upgrade** (newer catalog version). Upgrade installs the current catalog version, not a repeated install.

Installed identity is exactly `plugin-name@marketplace-name`; a same-name plugin from another marketplace does not count. Upgrades preserve that exact entry's user/project scope and enabled state.

Management operations use the selected project's cwd, native `.env` discovery, and configured provider profile/environment. Explicit leading `launch` in a provider command is omitted for management only. Omitting enable/disable scope preserves native unique-scope inference; explicit user/project scope remains exact.

Busy actions, including **Remove** while confirmation is open, preserve button dimensions and adjacent spacing; progress overlays the existing icon/text footprint. A recovered catalog retry clears its old error without dismissing feedback from an operation's own refresh.

### Native extension replies and commands

Visible replies retain persisted native entry IDs, original text, and metadata in live/history views, even without model `agent_start`. They never complete a turn: RPC acknowledgements and model lifecycle events own completion. Literal punctuation, JSON quotes, and original text are not rewritten by smart typography; ordinary assistant Markdown keeps normal typography/math. Older history keeps each custom reply separate from adjacent model/custom replies.

Registered native commands are admitted before workflow/stale-plan reset envelopes, including after session restoration. They remain commands rather than model prompts; the next ordinary prompt still receives its workflow reset. Stopping while command discovery is pending cancels that turn: delayed discovery cannot dispatch it or claim a replacement request's identity.

## Distribution compatibility

Desktop builds now use the Node SDK. The former private Windows three-plugin build depended on a patched standalone OMP executable and is no longer supported: its staging command, packaging flag, executable resources, and native qualification path have been removed. Existing private installations need their own compatible distribution; SDK Desktop does not claim to migrate those private runtimes or accounts.

Use the standard SDK plugin-management page for Node-compatible plugins. Marketplace identity, scope, enable/disable state, and native commands retain their normal semantics. Bun-only or executable-bound plugins cannot be made compatible by changing the SDK path.

Desktop reuses or terminates managed daemons only when their reported distribution identity matches. An incompatible legacy/private daemon is preserved until explicitly stopped. The bundled Desktop CLI also checks live identity before using an implicit local target; explicit `--host` and `PASEO_HOST` remain unchanged.

## Image generation with references

Desktop uses native OMP `generate_image`, with no separate service or `image_gen` alias. Enable **Host Settings → Image generation**, independently of Desktop host-tool injection.

Choose an OpenAI-compatible API with image model, Base URL, and key, or a ChatGPT subscription account already signed into OMP. Subscription generation uses the selected account without changing chat account; OpenAI chooses the hosted image model. Sources never automatically fall back to each other.

Calls describe subject, scene, style, and requested changes. `input` accepts ordered local reference paths, absolute or relative to the agent workspace. Identify differing roles by list position, such as subject/composition/style. API reference requests use image-edit; subscription requests use OMP's hosted path. With OMP device tools enabled, the same tool is exposed through `xd://generate_image`.

Settings apply on the next agent input, including existing/resumed conversations. Missing/removed image credentials disable image access without blocking chat. See [Messages and media](messages-and-media.md#images-and-previews) for previews and saving, and [Desktop pet](desktop-pet.md#create-and-import-pets) for image-based pet creation.
