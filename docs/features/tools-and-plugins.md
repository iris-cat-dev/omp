# Tools, plugins, and image generation

Configure native OMP tool requests, manage runtime plugins, and enable image generation. These controls do not replace filesystem permissions or [approval rules](conversations.md#approval-changes-during-a-session).

## Contents

- [OMP built-in tools](#omp-built-in-tools)
- [Desktop host tools](#desktop-host-tools)
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

## Desktop host tools

Desktop keeps capability entry points directly callable and exposes object-management tools on demand through OMP's `xd://` transport. With `tools.xdev` enabled and `tools.xdevDocs` set to `catalog`, the model sees a short catalog instead of every management tool's full schema.

The always-visible entry points, when their Desktop capability is enabled, are:

| Capability                | Entry points                                                  |
| ------------------------- | ------------------------------------------------------------- |
| Agents                    | `create_agent`, `list_agents`                                 |
| Workspaces                | `create_workspace`, `list_workspaces`                         |
| Terminals and scripts     | `create_terminal`, `list_terminals`, `list_workspace_scripts` |
| Scheduling                | `create_schedule`, `list_schedules`, `create_heartbeat`       |
| Providers and permissions | `list_providers`, `list_models`, `list_pending_permissions`   |
| Visual interaction        | `present_image`, `request_visual_feedback`                    |

Other host tools remain enabled but discoverable, including sending prompts, inspecting status, updating, canceling, archiving, unloading, and deleting objects. Successful entry-point results preserve their IDs and existing guidance, then add references to available follow-up tools. Failed results do not add follow-up guidance. Automatically delivered agent results still do not require polling.

For example, after `create_schedule` returns an ID, read `xd://pause_schedule` for its parameters and write `{"id":"<returned ID>"}` to that URI when the task calls for pausing it. The existing Eval tool bridge also reaches enabled discoverable tools. These paths use the same host handlers, input validation, cancellation, and permission boundaries as direct calls; discovery does not grant extra access. Tools disabled by Desktop capability settings are neither registered nor recommended.

Turning off OMP's `tools.xdev` keeps enabled tools directly exposed. Inlining all device documentation also gives up the catalog-only savings. The policy applies when Desktop next registers host tools for a new or resumed SDK session; it does not replace tools in an already-running conversation by itself.

An isolated measurement on 2026-11-06 used the current Desktop serializer, the installed SDK, `trae/gpt-6.1-sol@i18n-tt`, and `O200kBase`: the same 41 host tools changed from 55 total direct tools and 13,974 startup tokens to 29 direct tools and 11,714 tokens. The 26 discoverable host tools saved 2,260 tokens (16.2%), including catalog overhead. A real create → read documentation → pause → inspect flow through the RPC host bridge and temporary schedule storage succeeded; its result guidance cost 44 tokens and the pause documentation cost 40. These are local context estimates before user messages, history, or GPT with Taste turn hooks, not provider usage or a measurement of model tool-selection accuracy.

## OMP working status

During an OMP run, the conversation footer shows the latest tool intent next to the loading indicator, token speed, and elapsed time. The label can update while a tool call is being generated, before execution starts; it does not depend on a visible tool card. Missing or empty intent leaves the existing loading indicator unchanged.

Intent text uses the same looping shimmer as running tool-call labels, without changing its font size, single-line truncation, token speed, or elapsed-time layout. The shimmer pauses while the conversation pane is inactive and resumes when it becomes visible again.

New tool intent labels follow **App Settings → General → Language**, including the resolved system language. Desktop supplies an intent-only language instruction before ordinary messages and steering; it does not change assistant response language, commands, code, paths, or other tool arguments. Existing labels are retained as generated, not translated when the interface language changes.

The label belongs to the active run, survives reconnect, and clears when the run completes, fails, or stops. Late events from another or closed run cannot replace it. Saved tool history retains its original intent metadata without turning completed history into a live working status.

## Browser and computer use

For an idle conversation, choose **Browser use** from the composer's attachment menu for visible browser tools, or **Computer use** for session-specific native desktop capture/input. These run `/browser visible` and `/computer on`, retaining the current draft. They are unavailable while a conversation runs.

Foreground computer control is task-scoped: finishing or interrupting a turn revokes its grant. **Stop** and `computer.close()` release the native worker without disabling Computer use for the conversation; a later desktop call waits for shutdown and starts a fresh worker, with new foreground authorization required. Screenshot frames, AX references, and worker variables must be reacquired after that restart. A physical Escape stop still blocks computer calls until your next message; closing and reopening the worker does not bypass it. The menu enables the capability, not the foreground-control grant.

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

**Settings → Plugins** manages Desktop-local folder installations, daemon plugins and native OMP plugins. Packages ship only the generic host, with no specific preinstalled plugins. Installed/discovery views show each installation's owner, source, scope, version and runtime state; configuration, permissions and logs belong to that exact installation.

Select a host for daemon and native operations. Desktop-owned controls stay local: changing hosts or losing a remote connection does not move their configuration or resources to that daemon. Two installation IDs using the same source directory remain independent. Disabling/removing an installation keeps its data unless you explicitly choose **Clear data**; disabled installations can still be configured. Pausing source plugins preserves their individual enabled selections.

To install from a folder, open **Discover**, select the Desktop or daemon target, enter the folder path, and choose **Inspect and install**. Inspecting metadata does not execute the plugin. Review its declared capabilities and confirm trust; then enable the installation. Desktop installations start disabled. Daemon execution also requires **Allow host plugins to run**. For a disabled daemon CLI installation, use `omp-desktop plugin install <folder> --trust --disabled`, then `omp-desktop plugin allow` and `omp-desktop plugin enable <id>`.

Historical Desktop `builtin` and daemon `bundled: true` records remain saved but are not listed, loaded or started by the new host. Reinstall from a folder with the same ID to use new code while retaining installation data. The renderer also hides these records from old hosts; it does not stop an already-running old daemon.

After installing a daemon-side fix, restart the built-in daemon from the new App when no tasks are running. Closing the App alone can leave the detached daemon running old code; the plugin's **Restart/reload** action does not reload the daemon implementation.

After installing the **QQ connection** plugin from its folder, select its daemon installation, grant its declared capabilities under **Permissions**, then open **Configure**. The account page provides **QQ AppID**, **QQ AppSecret**, **Save/replace account** (`保存／替换账号`) and **Scan to bind** (`扫码绑定`). Configuration remains available while execution is paused or the installation is disabled.

Choose **Scan to bind** to request a QR code; opening the settings page alone does not generate one. The selected daemon needs internet access to obtain a Tencent binding URL, which it converts to the displayed QR image. You do not need to enter AppID/AppSecret first. Binding failures appear on the account page; **Refresh QR code** requests a replacement after expiry.

QQ agents always use the **QQ sandbox path** (`QQ 沙箱路径`) shown in Configure. Edit an absolute path (or `~/...`) and choose **Save configuration**; blank uses a private directory dedicated to this installation. Existing `cwd` settings migrate to `sandboxPath`. The path field, **JavaScript**, **Public requests** and **Host image generation** (`主机生图`) switches share the JSON draft. All three capabilities default to off; enable the required grants with `sandboxCapabilities: { javascript: true, network: true, imageGeneration: true }`. JavaScript adds isolated computation and sandbox file APIs; public requests permit data submission to arbitrary public HTTP/HTTPS addresses, so authorized QQ users can send sandbox data off-host. Account credentials, access lists, and saved model preferences remain separate. A root or capability change stops the old agent and creates a new sandboxed conversation with the exact saved grant; its Desktop history and user files remain available.

The sandbox restricts model capabilities, not the daemon's operating system. QQ models cannot run shell/host eval/browser tools, obtain system identity, load ambient skills/MCP/extensions, or access files outside their sandbox. Opt-in JavaScript runs in a fresh QuickJS WASM guest without Node globals or host imports. Opt-in networking rejects private/localhost/metadata destinations and uses no host proxy, Cookies or credentials. Presets retain model/thinking/prompt preferences but cannot override the sandbox or `ask` approval mode. `qqbot_send_file` is unavailable; optional automatic presented-file delivery requires `sendFile.sendPresentedFiles: true` and accepts only sandbox-contained regular files. `sendFile.extraRoots` never grants outside access. Old agents without the complete confirmed sandbox policy are stopped and replaced before QQ routing resumes.

Enabled model-provider plugins run in a separate, tool-free host inference gateway. QQ's sandbox session keeps the original provider/model selection at creation, resume and model changes; provider-plugin tools, ambient prompts and hooks do not enter that session. Model requests expose `sandbox_read`, `sandbox_write` and `sandbox_list` by default; explicit grants add `sandbox_js`, `sandbox_fetch` and/or controlled `generate_image`. JavaScript/public requests require Node RPC sandbox profile 2; host image generation requires profile 3. Older profiles retain their existing file-only or JavaScript/network support. An unavailable selected model fails startup. Inference failures remain failed turns, and QQ receives a failure notice instead of a silently successful empty turn.

Tool-call failures stay in the agent/Desktop timeline and are not posted to QQ. With `showToolResults: true`, QQ receives successful completion notices only; normal assistant replies and whole-turn failure notices keep their existing delivery behavior.

`sandbox_fetch` returns locally rendered Markdown for HTML, with browser request headers and a bounded 5 MiB response / 100,000-character preview. Use `raw: true` for source text; guest JavaScript `fetch()` keeps its complete 1 MiB raw-response contract. Captcha and JavaScript-only pages still require an accessible source.

To let QQ generate and send images, enable **主机生图** and choose **Save configuration**. The host's image-generation settings must also be enabled with a usable model and credentials. `generate_image` uses that existing native image pipeline; image editing accepts sandbox-relative input paths only, and generated files are saved under `.qqbot-media/generated/`. Successful images are uploaded to the current authorized QQ conversation, independently of **Public requests** and `sendFile.sendPresentedFiles`. Cancelled or failed turns do not send queued generated images; images without a known current-turn origin are not replayed into another conversation. `media.ttlHours` also cleans expired generated UUID images.

At startup or reset, QQ checks whether the saved Agent ID still exists, including archived agents and every directory page. A missing ID creates a fresh sandboxed agent and replaces only that peer mapping; AppID, credentials, access lists, model/thinking choices, and literal prompts stay intact. Lookup and stop failures remain errors rather than being treated as missing agents. A sandbox configuration change invalidates an in-flight lookup or model acknowledgement. Revoked capabilities stop before opening the replacement directory; an inaccessible replacement still stops the old turn. Sender access is checked again after attachment preparation, immediately before submitting the turn.

Private chats and groups have separate peer mappings and independent root conversations. New conversations, including `/new` and `/reset`, receive a fresh workspace record backed by the same configured sandbox directory; they never reuse another peer's workspace. Existing mapped agents keep their IDs at startup, and reset preserves the previous Desktop history. Sandbox stop/reset does not require host background-job extensions; retained daemons remain scoped to their recorded owner.

QQ's service requires the declared `agents.prompt` capability to send messages, stop legacy peers, change models, and cancel timed-out turns. This permission belongs to the trusted plugin service; it does not add model tools or relax the model's sandbox. Grant it under **Permissions** if the installation reports a missing capability.

For an isolated integration check, use `plugins/qqbot/tests/sandbox-smoke-inputs.json` with a fresh test daemon/HOME/PASEO_HOME and a real model; leave the user's existing daemon and App untouched. Prepare the listed inside canary, sibling outside canary, symlink and hardlink, then send the exact prompts through QQ. In the UI, confirm path and capability edits update JSON, JSON edits update the controls, invalid JSON is preserved, and blank selects the installation-private default. Verify an in-flight root or capability change retires the old route without changing AppID, access lists, credentials or the selected model.

To use the **QQ connection** sidebar entry, enable both **Allow host plugins to run** and the QQ installation's own switch. It appears below **Scheduled tasks** in the main sidebar. The shared QQ page in **Configure**, the sidebar surface, and workspace panels shows **Connection status** (`连接状态`) separately from error details. In active mode, **Restart QQ connection** (`重启 QQ 连接`) appears on that page, scoped to the selected host and installation; there is no sidebar puzzle menu or QQ application-menu action. An enabled connection waiting for account credentials keeps its sidebar entry and settings actions available. Pausing host execution hides execution entries and actions but retains the QQ switch selection and account configuration.

QQ retries transient network failures with backoff, including temporary token-service failures, without an eight-attempt cutoff.

Idle connections remain open while gateway heartbeats are acknowledged; incoming chat messages are not required. Each heartbeat ACK has a deadline of one heartbeat interval or 15 seconds, whichever is shorter. A missing ACK retires the half-open socket and immediately attempts to resume the QQ session. If sleep delays a heartbeat tick by more than two heartbeat intervals (with a 30-second minimum), the first tick after wake also reconnects immediately. These recoveries preserve existing Desktop agents and peer mappings.

A successful session resume restores **Connected** and clears the disconnect reason. Rejected credentials and Tencent account/permission bans remain failures requiring correction and an explicit restart; disabling the installation cancels pending retries and heartbeat deadlines.

`Selected daemon host is not connected` refers to the plugin worker's daemon API connection, not QQ authentication. This trusted local IPC follows the worker channel's lifetime and is exempt from network-socket heartbeat leases, so system sleep cannot expire that lease. Closing the actual IPC channel still releases its daemon session immediately, without waiting for the worker process to exit.

When the worker process exits, pending plugin RPCs fail immediately and the installation stops appearing as running. This follows the process exit rather than waiting for its output streams to close.

To ask about a QQ image, attach it to the message and @ the bot in a group. With `media.enabled` and `vision.enabled`, the service downloads supported images into `.qqbot-media` inside the configured sandbox and includes their image content in the model input.

Supported HTTPS media origins include the exact `multimedia.nt.qq.com.cn` host shown in [Tencent's group-message attachment example](https://bot.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html). Downloads remain size-limited and reject redirects, lookalike hostnames and unrelated `qq.com.cn` subdomains. This trusted service operation does not require enabling sandbox JavaScript or public-network access.

Native marketplace entries show **Install**, **Installed** (current), or **Upgrade** (newer catalog version). Upgrade installs the current catalog version, not a repeated install.

Native installed identity is exactly `plugin-name@marketplace-name`; a same-name plugin from another marketplace does not count. Upgrades preserve that exact entry's user/project scope and enabled state.

Management operations use the selected project's cwd, native `.env` discovery, and configured provider profile/environment. Explicit leading `launch` in a provider command is omitted for management only. Omitting enable/disable scope preserves native unique-scope inference; explicit user/project scope remains exact.

Native configuration uses the selected installation's schema without executing its factory. **Configure** edits non-secret values and optional features, including while disabled. Default features (`null`) and an explicit empty selection (`[]`) remain distinct; project overrides retain precedence. Changes apply to new or resumed sessions, without restarting running conversations. Secret values are never displayed or accepted here; the page shows configured markers and directs sensitive input to the selected OMP CLI.

The matching native CLI operation is:

```sh
omp plugin manage plugin-name@marketplace-name --scope project --json
omp plugin manage plugin-name@marketplace-name --scope project \
  --set '{"enabledFeatures":[],"settings":{"count":4}}'
```

Setting names and values must match that plugin's schema. `deleteSettings` removes specified non-secret overrides; omitted keys remain unchanged. Linked installations expose their actual source and cannot be upgraded from a catalog.

Busy actions, including **Remove** while confirmation is open, preserve button dimensions and adjacent spacing; progress overlays the existing icon/text footprint. A recovered catalog retry clears its old error without dismissing feedback from an operation's own refresh.

SDK sessions check plugins for their own project when starting or resuming. A broken plugin is disabled in its runtime scope before the session starts; unused projects are not scanned during Desktop startup. Fix the plugin and re-enable it here to check it again on the next session startup.

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
