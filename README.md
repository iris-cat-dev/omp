# OMP Desktop

An Electron and Web client for [Oh My Pi](https://github.com/can1357/oh-my-pi). It runs a private daemon on your machine and talks to `omp --mode rpc-ui` through OMP's native JSONL RPC protocol. Web clients can control a remote daemon through a self-hosted, end-to-end encrypted relay.

Current source version: **0.5.1**.

## Requirements

- Node.js from `.tool-versions` and npm workspaces for development and source builds
- `omp >= 18.8.7` on `PATH` for development and standalone daemon runs
- A configured OMP model provider

Standard macOS, Linux, and Windows packages include OMP and do not require a system OMP installation.
Windows `no omp` installers preserve an existing bundled runtime during upgrades; a fresh
`no omp` installation requires `omp` on `PATH`.

**Host Settings → Agents** reports the version, source, and path of the exact OMP executable used
for Agent sessions. Update checks and installs target that same executable. Packaged applications
label their bundled runtime separately from standalone, configured, and `PATH` installations.

Select **Configure models** on the home screen to open **Host Settings → Model providers**
directly. The shortcut targets the local host when available, otherwise the first configured
host; if no host is configured, it opens the add-host flow.

Desktop windows use a full-width title bar above the sidebar and workspace tabs.
The desktop sidebar shares the title bar's background, and its toggle stays in
the title bar when collapsed. Workspace panel toggles, script controls, and the
new-tab launcher occupy the title bar's right side; only the focused workspace
contributes these controls when navigation keeps other workspaces mounted.
Workspace tabs sit directly below the title bar without a second workspace header.
Native window buttons retain their reserved space. Tabs sit edge-to-edge with
square corners and thin separators; the active tab shares the content background,
with its close button visible on selection or hover.
Desktop scroll surfaces use the terminal's compact scrollbar treatment. The left sidebar and
vertical workspace splitters use matching two-pixel accent highlights on hover, without
narrowing their invisible drag targets.

Sidebar conversations always use their conversation title, with only the last-activity time
beside it (for example, `2h` or `2d`). Rows without an activity timestamp leave that space empty.
Display preferences no longer include **Title**, **Diff stats**, or **Last activity** choices;
previous choices are removed without resetting other settings.

Hover **Fast** in model settings to see its cost explanation. The **Standard**,
**Enhanced**, **Plan**, and **Goal** workflow options also show hover descriptions.
These tips follow the interface language in all nine supported locales.

## Desktop pet

In **Settings → Appearance**, the **Desktop pet** section follows **Wallpaper**. Enable
**Show desktop pet** to display Iris, the built-in pink fluffy kitten, in a separate transparent,
always-on-top window. The feature is off by default and is only available in the Electron app.
Like wallpaper, size, library, import/refresh, and creation settings appear only while the pet
is enabled. Disabling it preserves the creation draft and model selection.

- Drag the kitten to move it; size, selection, visibility, and position are saved
  locally. Transparent space lets mouse input pass through to other applications.
- Click the kitten to pet it: a happy pose, soft squash/rebound, and floating hearts.
  Dragging does not trigger petting. Click the status bubble to restore OMP and
  open the task that needs attention, or open the app when there is no pending task.
- The status bubble stays close to the kitten's upper left and follows its size.
- Connected hosts supply real task state. Permissions take priority over errors,
  unread completions, and running work. No task or animation triggers a model call.
- On daemons with directory revisions, completed directory reads determine freshness,
  not window arrival order. Older reports cannot restore acknowledged or archived
  tasks. Tasks remain identified by host and conversation, not a shared workspace
  entry. Closing one publishing window does not discard known pending work while
  another window remains connected to that host.
- While the highest-priority task is running, Iris shows a random work caption every
  30–60 seconds for five seconds: `智商变高了！`, `不想上班...`, `大佬！`,
  `wooo！wow！`, or `Tibo什么时候重置...`. The two complaint lines use the wistful
  working face; the other three use the happy face without changing task status.
  Captions stop immediately when work ends, a higher-priority task needs attention,
  the host disconnects, or the pet is dragged/petted. Idle and non-running tasks
  never trigger captions. Custom pets are unchanged; reduced-motion mode keeps
  the selected expression static.
- Iris has six registered 24-frame, 12-fps action sequences with continuous local
  breathing/sway. Idle actions play for two seconds and rest for six seconds;
  waiting, completed, and blocked states also have quiet pauses. Outside temporary
  reactions, working and carried loops continue. Only the working face keeps its
  wistful expression; other faces are relaxed or happy. Blinks use short, tapered eyelids.
  System reduced-motion preferences keep the pose static.
- Right-click the pet to hide it or reset its position. Minimizing OMP does not hide
  the pet. Quitting detaches it only after in-flight activity publications settle,
  then follows the existing desktop/daemon shutdown settings.

**Create with OMP** opens an independent local authoring workspace and a normal OMP
conversation using the selected model, thinking level, and approval mode.
Authoring model, mode, thinking, and feature selections are local to this flow;
they do not change the defaults for ordinary conversations.
Describe the pet in settings or attach references in the conversation. The bundled
`hatch-pet` skill uses the configured image-generation tool, produces a coherent
transparent animation atlas and `pet.json`, and runs the generated install helper.
On Windows the helper uses the bundled Electron runtime, not a global Node install.
The headless converter does not run GUI quit cleanup or stop an existing daemon.
Image creation uses the user's configured image model; ordinary pet animation does not.

After a successful install, click **Refresh** and select the new pet. **Import folder**
also accepts completed packages. Imported packages contain only a validated manifest
and transparent PNG data; they do not execute scripts or HTML. Images are limited to
20 MiB and 4096 × 4096 pixels. Built-in Iris and existing custom packages are not replaced.

## Choosing OMP subagent models

In **Host Settings → OMP subagents**, enable **Override built-in subagent models** and
choose a model for each built-in subagent. Desktop model pickers open above or below
their selector according to the available window space, and constrain their height
to keep search and the scrollable model list inside the window. Scroll the list or
search to select any available model, including in a small window.

Each selected model also exposes its supported **Thinking** levels and, when the host's
OMP capability probe confirms support, a **Fast** switch. Unsupported controls are hidden.
**OMP default** leaves the native thinking or service-tier policy unchanged; a manually
configured service tier is shown rather than treated as an explicit Fast-off selection.
Fast can incur higher provider charges.

Changes are saved to OMP's user configuration and apply to newly spawned task/eval
subagents, including spawns from an already running conversation. Thinking uses the
native model selector suffix (`provider/model:high`); Fast writes `priority` or `none`
to `task.agentServiceTierOverrides` for that agent. Existing children are not reconfigured.
Choosing inheritance clears that agent's model and Fast overrides. Disabling the section
removes the model mapping and bundled agents' Fast overrides, preserving custom agents'
service tiers and unrelated OMP settings.

## Completing conversations

After OMP finishes a model turn and reports that it is no longer streaming or compacting,
Desktop completes the turn automatically; **Stop** is for interruption, not acknowledgement.
OMP's internal `developer` messages, including project-rule reminders, are accepted in
completion events and RPC history without appearing as user or assistant chat messages.
Reopening a saved conversation likewise keeps these reminders out of the visible history.

If an older Desktop build remains running after the final answer, update Desktop and restart
its daemon after saving any active work. Updating only the bundled OMP executable does not
update Desktop's RPC adapter.

Provider-request failures after an Agent runtime has started are reported in the conversation as
sanitized system errors, including the HTTP status and safe proxy error code when available. Proxy
credentials are omitted. The existing Agent and provider session remain retryable, so a transient
network or proxy failure does not require creating a new conversation.

## Enhanced workflow

Select **Enhanced**, identified by the same Sparkles icon in the workflow menu
and the current-mode control (toolbar or compact settings sheet), to keep
model-request failures running automatically. Both **Standard** and **Enhanced**
continue responses that reach the model's output-length limit.

When OMP reports a terminal model-request error, Enhanced waits **five seconds** and
sends a localized **Continue** message (`继续` in Chinese). Every terminal error is
eligible: HTTP 4xx/5xx responses, provider stream errors without an HTTP status (for
example `Error Code server_error: … the param is invalid`), and failures where OMP's
own retry budget is exhausted. Repeated errors repeat this wait with no attempt limit
or increasing backoff. Aborted responses are not resumed.

The conversation stays active until a continuation succeeds or is stopped.
**Stop**, closing the session, or leaving Enhanced prevents pending continuations.
OMP's internal request retries are unchanged; the five-second wait starts after OMP
reports the terminal error, not after each internal request attempt.

## Switching approval modes

Select **Full access** in a running conversation to approve its pending and subsequent
OMP tool requests automatically. The daemon sends the native approval response without
restarting the conversation or changing OMP's immutable launch-time approval flags.
Automatic approval does not depend on an open client. Questions and plan confirmations
still require an explicit answer.

Switching back to the approval mode used when the current OMP process launched stops
automatic approval and restores its native behavior. Other approval-mode changes still
require a new session; a process launched with **Full access** cannot enable native
approval prompts by switching to **Always ask** or **Write approval**.

## Saving images in the mobile Web client

Long-press an image in the conversation or its fullscreen preview and choose the browser's
save-image action. Desktop browsers can use the image's right-click menu. Raster image
attachments stored in the Web client's IndexedDB use self-contained data URLs instead of
blob URLs, preserving the original bytes for browsers whose image-saving menus cannot
resolve blob URLs. Non-image attachments retain revocable blob previews.

## Desktop wallpaper

In **Settings → Appearance**, enable **Wallpaper**, choose **File**, and use
**Add files** to select images and videos with the system file picker. Ctrl/Shift
multi-selection and files from different folders are supported. Candidates are saved
across restarts; the originals stay in their existing locations.

The candidate grid scrolls continuously inside Settings. It is virtualized rather
than paginated or limited to the first 48 files. Covers are static images, including
video covers. Adding candidates does not change the background: click a card to apply
it manually. There is no automatic rotation.

Use **Manage** to select and remove multiple candidates, including items scrolled out
of view. Removal only deletes candidate records, never the source files. Removing the
current candidate restores the theme background without selecting another wallpaper.
Re-adding the same file creates a new candidate and does not reactivate the old selection.
Missing or undecodable files remain in the list; restore the file and retry, or remove
its record.

Supported extensions are `jpg`, `jpeg`, `png`, `gif`, `webp`, `bmp`, `avif`, `mp4`,
`m4v`, `webm`, `mov`, and `ogv`. Actual playback depends on the media codec; the app
does not transcode files. The **URL** source still accepts HTTP(S) image/video URLs.
Media type detection uses the URL pathname, so signed video URLs with query strings
are supported.

The **Interface transparency** slider covers 0–100% and previews changes without
writing every intermediate value. Increasing it reveals the media and fades regular
panel backgrounds: 0% shows the selected theme's solid background, while 100% removes
the sidebar, titlebar, and composer veils. Dragging does not remount the settings page,
lose slider focus, or reset its scroll position.

Base workspaces become transparent only after the selected media loads, including
newly selected tabs. Floating menus, command palettes, tooltips, dialogs, and notifications
keep opaque backing for readability. Text colors still follow the selected theme;
use a matching wallpaper/theme or lower transparency when contrast is insufficient.
Loading failures show a message in Wallpaper settings and retain normal theme surfaces.
Switching sources or recovering from a failed load preserves focused inputs and pet
creation drafts. The selected media and committed transparency are saved across restarts.

Local media is streamed through app-scoped opaque identifiers rather than embedding
full files in renderer IPC. Windows/Linux native caption controls use a transparent
overlay over the HTML titlebar rather than a separate opaque patch. The top resize
strip stays within the titlebar bounds, keeping the right edge aligned when the window
is restored or maximized.
Desktop model pickers keep an opaque, theme-matched panel behind the model list and its
**Thinking**, **Fast**, and **Context window** settings, so wallpaper and conversation text
cannot show through the footer.

### Isolated Windows wallpaper trial

For a prepared `packages/desktop/release/wallpaper-trial/win-unpacked/` build, use
`packages/desktop/scripts/launch-wallpaper-trial.cmd`. Do not launch the unpacked EXE directly:
the launcher supplies an isolated OMP profile. Open **Settings → Appearance → Wallpaper**,
select **File**, and use **Add files**. No model configuration is needed for local wallpaper testing.

The launcher retains trial settings in `%LOCALAPPDATA%\OMP-Desktop-Wallpaper-Trial`,
with separate Electron storage, agent configuration and loopback daemon. It does not
copy the installed app's conversations, model credentials or provider environment.
Existing trial data is preserved; an existing non-trial directory is refused.
The native window title identifies the trial, and reopening it foregrounds the
existing window without stopping its daemon.

Windows `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA` and `LOCALAPPDATA` retain
their system values, so the native file picker can reuse your existing Quick Access
folders. Only `HOME` and the explicit OMP/Electron/daemon directories are isolated.
The launcher does not copy, reset or recreate Windows Quick Access data. Restart
the trial after launcher changes; existing wallpaper records and trial settings stay.

Application updates are disabled with `PASEO_DISABLE_APP_UPDATES=1`, including
manual installation and install-on-quit. This is a wallpaper-only trial, not a
Windows sandbox: do not enable launch-at-login or install CLI/system integrations
from the trial. Those OS-level actions are outside the trial's scope.

## Stopping conversations and subagents

The conversation's **Stop** button interrupts its current run and all running managed descendants,
including children still active if the parent turn finishes while the stop request is processed.
Detached agents are independent and are not stopped. The subagent list also has a **Stop** button
on each running child; stopping a child leaves it in the list, unlike archiving it.

OMP-native subagents require OMP **18.4.9 or newer** for individual or parent-initiated cancellation
(`cancel_subagent` RPC). With an older OMP binary, the daemon reports that the native child could
not be stopped and keeps it marked running rather than claiming success. Update OMP through Host
Settings, or run `npm run download:omp` before packaging a desktop build. The general minimum OMP
version above still applies when native-subagent stopping is not needed.

## Guiding a running conversation

The composer defaults to **Steer** while a conversation is running. A steer guides the active turn
without canceling it or its managed descendants. The parent remains steerable while an OMP-native
subagent continues in the background. The submitted message remains visibly pending until OMP
emits the canonical user-message event that confirms the model consumed it; an RPC acknowledgement
alone only confirms admission.

If the active provider cannot accept steering, Desktop reports the send failure and leaves the
current turn running. Agent-to-agent prompts and completion notifications use the same
non-destructive rule rather than falling back to replacement.

## Browser and computer use

For an idle OMP conversation, open the composer's attachment menu and choose **Browser use** to
switch OMP's browser tool to visible mode, or **Computer use** to enable native desktop capture
and input for that session. These actions run `/browser visible` and `/computer on` without
discarding the current draft. They are unavailable while the conversation is running.

## Ordering queued conversations

When several conversations on the same host have queued follow-up messages, each affected
composer shows that conversation's queue position and controls to move it earlier or later.
Automatic delivery starts one queued conversation at a time in the displayed order; moving a
conversation changes the next actual start, not only the UI. Existing active turns continue
without interruption.

Within a conversation, each queued message also has **Move queued message earlier/later**
controls when at least two messages are waiting. These controls change both the displayed
order and the subsequent automatic delivery order, preserving the message text and attachments.
Messages keep their enqueue order unless explicitly moved; already submitted or executing
messages are not sortable. Reordering does not send or interrupt a turn.
**Send queued message now** remains a separate, explicit override of the shared order.

## Answering grouped questions

When OMP asks several questions together, use the labeled question tabs to move between them in
any order. Selections and typed answers remain intact while switching. After every required
question has an answer, **Submit** sends the complete group.

## Replaying conversation history

OMP `model_usage` records, including background-memory usage, are metadata rather
than chat messages. History replay preserves the original JSONL records and usage
values without displaying an unsupported-record notice for them. Messages before
and after usage records remain visible; genuinely unknown record types still
produce diagnostic messages.

## Permanently deleting conversation history

Desktop-injected agent tools distinguish four operations: `cancel_agent` stops a run,
`archive_agent` hides a conversation while retaining history, `kill_agent` terminates a
loaded runtime while retaining its record, and `delete_agent` permanently removes the
Desktop conversation record and retained timeline.

Use `delete_agent({ agentId, confirm: true })` only after explicit user authorization.
It supports loaded, archived, and unloaded records without loading a provider session.
The result is `deleted` or `not_found`; runtime-close and storage errors are reported as
failures rather than successful deletions. The calling agent and its managed ancestors
cannot be deleted through this tool.

Connected clients refresh their directories and history/search caches after deletion.
Project files, deliverables, workspaces, Git worktrees/branches, and provider-owned session
files are not deleted. This tool removes Desktop history, not the provider's independent logs.

## Zhipu Coding Plan usage

The built-in `zhipu-coding-plan` provider reuses API keys saved through OMP sign-in.
Each enabled stored key has its own labelled usage entry; a rejected key does not
hide another key's available quota. No `models.yml` entry is required for built-in usage.
For a custom China Zhipu provider, configure its `baseUrl` (for example,
`https://open.bigmodel.cn/api/coding/paas/v4`) and `apiKey` in OMP's `models.yml`;
Desktop retains the custom provider name.
The sidebar, active model's context tooltip, and Host Settings usage page show the
quota windows reported by Zhipu: five-hour, weekly when present, and MCP/tool calls.
Both token-based `TOKENS_LIMIT` and credit-based `CREDIT_LIMIT` responses are supported.
Percentages show **used quota**; missing percentages remain unknown rather than
implying an unused quota. Reset times appear only when supplied by the service.

Desktop queries the China service's official-plugin monitor endpoint on
`https://open.bigmodel.cn` with the raw API key and does not follow redirects.
This does not add support for the separate `api.z.ai` service or arbitrary
OpenAI-compatible `/v1/usage` endpoints. Usage lookup failures do not change model
availability or interrupt inference.

## Claude official-account usage

Claude accounts signed in through OMP's built-in `anthropic` provider have individual
usage entries in **Host Settings → Model providers → Signed-in providers** and the host's
**Usage** page. Tap **Claude usage** in the conversation composer on mobile or desktop,
including before the conversation has context-token data. Reopening the sheet or pressing
**Refresh** requests fresh server usage.

When a session reports a selected credential, its usage stays isolated to that account.
When no session account is reported, the sheet explains this and lists signed-in accounts
separately with their own labels and quotas; it never guesses the active account or
combines their percentages. Account names, notes, and ordering remain unchanged.

Five-hour and overall weekly percentages show **remaining quota**. Model-specific weekly
windows appear only when Anthropic actually returns them; unknown window names retain
their reported identifier rather than being guessed as Opus or Sonnet. Reset dates include
a timezone, and compact countdowns refresh server usage at the deadline instead of
locally assuming that quota has reset. Missing percentages and dates remain unknown.

Claude's five-hour row remains visible when usage is unavailable or only a reached flag
is known. Missing percentages are shown as unknown, without a fabricated progress bar.
Authentication, network, timeout, invalid-response, and HTTP query failures are distinct.
An OAuth usage-query retry deadline is not a quota-window reset.

The daemon retains model-request restrictions for the actual enabled OAuth account across
sessions and failed usage reads. A generic model 429 remains an unknown-window restriction;
five-hour attribution requires explicit native window evidence or a fresh exhausted
five-hour observation for the same account. Older in-flight reads cannot clear newer
model restrictions. A deadline triggers a server recheck, not a local declaration of
recovery. Fresh corresponding quota data can confirm known-window recovery; an
unknown-window model throttle requires a successful model response for that account.
Desktop never sends a model request or redeems a reset automatically to test recovery.
These observations are daemon-local memory, not billing records; restarting the daemon
requires fresh server evidence.

The account and Usage views also show read-only **extra usage** status, reported spending,
and the monthly spending cap when available. The OAuth endpoint reports these amounts
in USD cents; Desktop converts them to dollars and does not treat missing amounts as zero
or missing caps as unlimited. An explicitly non-USD or unknown currency is not labeled as
USD spending. Extra usage is [billed separately from the subscription](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)
and is managed in [Claude Settings → Usage](https://claude.ai/settings/usage), not purchased
or enabled through Desktop.

Quota reads use Anthropic's undocumented OAuth `/api/oauth/usage?cedar_ember=1`
endpoint, including the reported reset inventory, and optionally `/api/oauth/profile`
for plan metadata. Requests reuse the configured OMP proxy, bound both the request and
response-body read, and never follow redirects. A profile failure does not discard
successfully retrieved usage. Authorization or service failures are shown without
exposing credentials, refreshing tokens, or changing the saved account.

Claude's official [limit resets](https://support.claude.com/en/articles/17007452-what-is-a-limit-reset)
are occasionally granted to eligible plans. They are distinct from paid extra usage and
Codex reset cards. **Host Settings → Model providers → Signed-in providers** shows each
Claude account's reported grants, remaining uses, start and expiry dates, cleared windows,
and eligibility. Held uses are separate from permission to redeem: expired, future,
paused, exhausted, cooldown-blocked, or otherwise unusable grants cannot be consumed.
Unknown inventory is not displayed as zero.

Using one reset requires an explicit irreversible confirmation showing the selected
account, grant, and affected quota windows. The daemon checks fresh inventory, binds the
request to that enabled Claude OAuth account and organization, serializes concurrent
redemptions for the same account, and issues one native
`POST /api/organizations/{organizationUuid}/reset_rate_limits` request. This OAuth
contract and its client-identification header were checked against the first-party
Claude CLI 2.1.296; the endpoints are not a stable public API.

After an attempted redemption, Desktop refreshes quota and inventory. An HTTP 200 alone
does not establish success; non-reset outcomes and uncertain results remain distinct.
There is no automatic mutation retry. A subsequent explicit retry of an uncertain request
reuses its native-valid redemption ID rather than creating a new intent. Hosts without
the `ompClaudeLimitResets` capability disable redemption and show update-host guidance.
Reset grants never enable paid extra usage or refund previous spending.

Claude accounts do not display Codex reset-card actions or subscription-expiry controls.
Desktop does not infer a subscription end date from a token expiry, subscription creation
date, grant expiry, or quota reset.

## Codex quota and reset cards

Open **Host Settings → Model providers → Signed-in providers** to view each Codex account's
five-hour and weekly quota windows. Desktop identifies windows by their reported durations;
when durations are absent it retains the legacy plan/window mapping. A five-hour window
is shown only when its usage or reset time is reported, including for Pro accounts.
Codex percentages show **remaining quota**; unknown usage is never treated as 100% remaining.
The context tooltip lists labelled accounts rather than guessing an account from the provider
namespace alone. Settings and the sidebar show live compact reset countdowns such as
`3d21h` and `2h12min`. At the deadline, Desktop refreshes server usage and shows an
awaiting-refresh state rather than assuming the quota reset.

Each account lists its banked Codex reset cards, server-reported available count, status,
and grant/expiry timestamps with a timezone. **Use reset card** asks you to confirm the selected
account, card, and applicable quota windows. Only available, unexpired `codex_rate_limits` cards
can be submitted. The daemon rechecks the card with OpenAI before consuming it and preserves the
redemption request ID; duplicate submissions do not intentionally spend another card. A confirmed
server result refreshes both cards and quota. Errors and already-redeemed/nothing-to-reset results
are displayed separately from a successful reset. Older daemons cannot consume cards.

Subscription validity is separate from quota resets. Desktop displays a timezone-qualified
`chatgpt_subscription_active_until` claim when the current OAuth credential supplies one.
Otherwise it queries the official Codex [`/backend-api/wham/accounts/check` account source](https://github.com/openai/codex/blob/a5130128697b10022a88e8f5eae6dca77393b4b0/codex-rs/backend-client/src/client.rs#L398-L407),
matching the selected account ID rather than using the default workspace. If the response
includes subscription entitlement expiry, Desktop displays that reported date and live remaining
time, with its source labeled separately from token metadata. Neither is an auto-renewal guarantee.

Current Codex OAuth responses can contain only account/plan information, with no subscription
date. Desktop explicitly reports that this sign-in does not support expiry lookup; a successful
entitlement response with no date instead reports **Subscription expiry unavailable**. HTTP,
network, malformed-response, and timeout failures report **Could not query subscription expiry**
without discarding independently available quota/reset cards. None of these states means no
subscription or an expired subscription. **No subscription** requires a reported Free plan or
an explicit inactive entitlement without an expiry; Desktop never substitutes OAuth expiration,
quota reset times, or a fabricated `0`.

ChatGPT browser billing has a separate authentication boundary. Desktop does not scrape browser
cookies or send Codex credentials to the old browser-only account endpoint; check ChatGPT billing
settings when the current sign-in does not provide a date.

## OMP built-in tools

Open **Host Settings → Agents → OMP built-in tools** to request a tool list for new or resumed sessions. The tool list starts collapsed; expand it to edit switches, request all off, or reset. Choices are saved per host. Desktop passes `--no-tools` when every tool is switched off, or `--tools <enabled names>` for a partial selection; resetting removes the extra tool flag. Known releases use their tool catalog; other versions use the combined known tool list without a version whitelist. Desktop checks native `--tools`/`--no-tools` support instead of rejecting an unfamiliar release. Checkpoint and rewind share one switch. Running sessions do not change.

This is not a strict denylist: OMP may automatically add tools excluded from `--tools` or even `--no-tools`, and child agents may use a different tool list. Builds reporting the same version may also expose different tools; for a partial selection, Desktop briefly starts an ephemeral OMP session to request only tools in that build's current active roster. OMP's own settings may disable selected tools. These controls do not change standalone OMP sessions or Desktop-injected tools and extensions, and do not replace filesystem permissions or approval rules. Custom OMP commands cannot combine this setting with their own `--tools` or `--no-tools` flags. No custom OMP build is required for supported versions.

## OMP plugins

Open **Host Settings → OMP plugins** to browse registered marketplaces and manage OMP runtime
plugins. Marketplace entries show **Install** when not installed, **Installed** when already
current, and **Upgrade** when the catalog has a newer version. Upgrade installs the catalog's
current version rather than repeating the install operation.

Installed entries are matched by their exact `plugin-name@marketplace-name` identity, so a plugin
with the same name from another marketplace does not count as installed. Upgrades target that
exact identity and preserve the existing user or project scope and enabled/disabled state.

## Image generation with references

Desktop uses OMP's native `generate_image` tool; there is no separate Desktop image-generation
service or `image_gen` alias. Enable it in **Host Settings → Image generation**. This setting
is independent of Desktop host-tool injection.

Choose an OpenAI-compatible API with its image model, Base URL, and API key, or choose a
ChatGPT subscription account already signed into OMP. Subscription image requests use the
selected account without changing the chat account, and OpenAI chooses the hosted image model.
The two sources never automatically fall back to one another.

Native calls describe the subject, scene, style, and requested changes; the `input` parameter
accepts ordered local reference paths. Paths may be absolute or relative to the agent workspace.
Identify references by list position when they have different roles, such as subject,
composition, or style. OpenAI-compatible API calls with references use the image-edit endpoint;
subscription requests use OMP's hosted image-generation path. With OMP device tools enabled,
the same native tool is available through `xd://generate_image`.

Settings changes apply to the next agent input, including existing and resumed conversations.
Missing or removed image credentials disable image access without blocking ordinary chat.

## Image previews

Images in assistant messages, including `generate_image` and `present_image` previews, show a
**View full screen** button in the image's top-right corner once loaded. In the full-window
preview, use the mouse wheel or the **Zoom in** / **Zoom out** controls, drag an enlarged image to
inspect another region, and switch between **Fit to window** and **Actual size (100%)**. Use the
close button or **Esc** to return to the conversation. Loading and failed images do not show the
full-screen button.

Image tool badges follow the selected interface language and show one action label without a
repeated status summary. When tools preview the same image in one turn, Desktop keeps the first
preview and both tool records. Standalone image tools, different images, and images shown again
in a new turn retain their previews.

Native generation and publication previews are copied to private, content-addressed image files.
History replay also understands OMP image-blob references, so previews do not depend on native
temporary files.

Workspace file tabs preview ICO (`.ico`, case-insensitive) icons as images, alongside PNG, JPEG,
GIF, WebP, and SVG files, rather than showing the binary-file placeholder.

## Official provider account numbers

Each official provider assigns its OAuth accounts stable, provider-local numbers. Deleting
an account releases its number; the next account receives the smallest free positive number.
Remaining accounts keep their numbers across reordering and daemon restarts. Settings,
account selectors, and usage cards use these numbers when an account has no name or note.

Account numbers are separate from OMP's globally increasing credential IDs. Desktop stores
the number mapping in `agent.db` without renumbering credentials or changing existing notes,
provider configuration, or session references. OMP's disabled credential records remain
disabled; releasing a display number does not reactivate or reuse an old credential.

## Model catalog refresh

Model providers, credentials, and the model catalog are shared by all projects and conversations
on the same host, using the active OMP configuration/profile. New conversations and project
switches reuse that host's catalog instead of loading an empty project-specific provider list.
The project's working directory still controls where the agent runs; it does not scope provider
configuration. Different hosts retain separate catalogs.

Updating OMP, saving its provider configuration, or logging in or out refreshes the affected
provider's global catalog. Open clients receive the refreshed result, or a terminal
unavailable/error status, without reopening the model picker or reloading the application.

Browser OAuth refreshes these catalogs as soon as OMP confirms authorization; clicking
**Complete sign-in** again is not required. The sign-in panel closes automatically and the
provider's signed-in state updates. Providers that request an OAuth code or redirect URL
still support entering it and completing sign-in manually. Catalog refresh does not switch
an existing conversation's selected model.

For official Codex OAuth, Desktop accepts dynamic models only from the dedicated Codex
catalog and requires Codex capability metadata for every entry. It never sends the OAuth
credential to the generic ChatGPT model catalog as a discovery fallback. A temporary
failure, invalid JSON, or non-Codex response keeps the last validated catalog or OMP's
built-in models, including their reasoning options. The first fixed launch removes legacy
Codex cache rows whose original endpoint and protocol cannot be proven; provider credentials,
other provider caches, and conversation settings are unchanged.

## Thinking-level changes

Changing the thinking level in an existing conversation updates OMP without restarting the
session. After a successful change, Desktop adds a conversation notice using the same inline
style as Fast mode, showing the localized level and when it takes effect.

The new level applies from the next model request, including later requests after a tool call
in the same turn. It does not alter a generation already in progress. Failed changes and
reselecting the current level do not add notices. Notices retain their selected level in
conversation history and after reloading the client.

## Claude fast mode

The model settings **Fast** switch also supports direct Anthropic Claude Opus 4.8, Opus 5,
and Opus 5.5. Desktop uses OMP's native `set_fast_mode` RPC; the runtime sends
`speed: "fast"` and the `fast-mode-2026-02-01` beta header. No prompt instructions or
thinking-level changes are used to approximate fast mode.

The switch is hidden for older Opus models, Sonnet, Haiku, third-party Claude providers
(including Bedrock, Vertex, and OpenRouter), and OMP runtimes without fast-mode RPC support.
Model switches re-read the runtime's per-family state before applying a saved preference.
New and resumed conversations use the same feature preference as the existing OpenAI
Fast switch; Desktop does not enable fast mode automatically when no preference is set.

Fast mode costs more and requires Anthropic fast-mode access. Claude subscription users
need usage credits; fast mode is not included in their subscription limits. The switch
requests fast mode, not a guarantee of account eligibility or served speed: provider
rejections, capacity limits, and fallback remain managed by OMP and Anthropic.
See [Anthropic fast-mode availability and pricing](https://platform.claude.com/docs/en/build-with-claude/fast-mode)
and [Claude subscription requirements](https://code.claude.com/docs/en/fast-mode#requirements).

## Conversation setting feedback

Changing Fast mode in an existing conversation adds a system notice after OMP confirms the
state changed. Switching models adds the same kind of notice with the selected model ID,
but only after the conversation has received a user message. Selecting a model before
the first message does not add a notice. Notices use centered, muted text with an
information icon and separator lines, not user or assistant message bubbles. They remain
in conversation history after reloading and are not sent to the model. Failed requests,
unchanged settings, and initial draft preferences do not add switch notices.

## Assistant turn statistics

Completed assistant turns show duration, completion time, total tokens, and average output
speed in the app's selected language. Completion time stays visible alongside duration;
hovering or tapping is not required. Weekdays and dates follow the selected language, while
the clock retains the system's 12/24-hour preference. Missing metadata is omitted independently,
and the footer wraps on narrow screens. Running-turn duration and output speed use the same
localized units.

## Conversation names

Double-click a sidebar conversation row to edit its title in place, without a dialog. **Enter** confirms; **Esc** cancels and restores the original title. The row's Rename menu action uses the same inline editor; tab context menus also support renaming. Renaming the workspace's primary conversation changes the workspace name; additional conversations keep their own titles. Accepted renames update the local tab title immediately, without waiting for a directory event. Saved names remain visible when switching tabs, including when a conversation is not loaded or its provider history is unavailable.

Each tab reads its title and chooses its rename target from the conversation's own workspace,
including when conversations from multiple workspaces within one project share the tab container.
Changing tabs or pane focus can change the tools' active workspace, but never a conversation's
primary-workspace identity or saved name.

Tab-width measurements do not own titles or selection state. The daemon publishes saved metadata changes for unloaded conversations, and loading a provider session preserves any rename made during initialization.

## Split conversation panes

Side-by-side conversations adapt to each pane's width rather than the desktop window's total
width. If an expanded task rail would leave less than a complete compact conversation and
composer, the rail and its toggle hide until that pane is wide enough again; its expanded state
is restored when space returns. Resizing or maximizing the window therefore keeps message text
and composer controls within each pane.

The header's bottom-panel button and **Cmd+Shift+\\** on macOS show or hide the terminal
panel. Hiding retains its tabs, selected terminal, and split sizes without stopping shell
processes. Activating it again restores the same panel and sessions, including after a client
reload; a terminal is created only when no bottom terminal panel exists. To terminate a
terminal session, use the terminal tab's **Close** action instead.

Hover a sidebar conversation to reveal **Delete**, **Archive**, and **Fork** shortcuts before
the existing three-dot menu. Project and status groupings share these interactions. Delete
still requires confirmation; Fork opens a new draft with the source conversation's history,
without changing the original conversation. Shortcut clicks do not open, drag, or rename the row.

## Pinned conversation ordering

In project view, pinned conversations stay above unpinned conversations and can be dragged to
change their priority. The drop position is previewed before release, and the manual order is
stored locally across restarts, project switches, and sidebar collapse or expansion. Reordering a
pinned conversation does not open it or change the order of unpinned conversations. Reordering is
disabled while a host or label filter hides part of the pinned list.

## Project focus and isolated panels

On macOS, **Cmd-click a project in the workspace sidebar** to focus it. A normal click
still expands or collapses the project; focusing does not change its collapse state.
The sidebar stays global, while the center tabs, right panel, bottom terminal panel,
selected tabs, and split sizes are saved separately for each project and host.

Switching projects restores their previous panels without closing conversations, terminating
terminals, or archiving workspaces. Unsent drafts and unsaved editors are retained.
Files and terminals keep their owning checkout, including when two worktrees in the same
project contain files with the same relative path. An empty project can be focused without
creating a workspace; **New conversation** creates its first conversation draft.

Existing mixed tab layouts are assigned automatically using the same ownership and checkout
context as newly opened tabs. Conversations and terminals follow their actual workspace;
files follow their recorded opener or focused checkout, with the original route workspace
as the default when no opening context was saved. No manual workspace-selection page is shown.

Migration waits for workspace, conversation, and terminal metadata when needed, and retries
after hydration, directory updates, or reconnection. Pending records stay saved without
blocking the workspace. Only references proven deleted by a complete catalog are removed;
migration never creates, unarchives, restarts, or stops backend resources.

When multiple old layouts merge into one project, tab state is retained; the first split tree
is kept and incoming tabs join its matching panes. Entity tabs follow the current identity
and deduplication rules. Migrated layouts are persisted and restored after restarting the client.

## Closing unused conversations

Closing the last empty conversation tab returns to the project page. On supported hosts, the daemon also archives the unused workspace record so it does not remain in the sidebar under its branch name. This does not delete project files or the project itself.

Cleanup preserves workspaces with agent history (including archived agents), live or pending resources, a custom title, pins, labels, or worktree ownership. Older hosts must be updated before automatic cleanup is available. An existing empty sidebar entry can be reopened and its empty tab closed to retry cleanup; entries are never bulk-removed merely because they are named `main`.

Delete an unsent **New workspace** draft from its sidebar hover button or right-click menu.
Only that draft's input and attachments are cleared; other conversations and project files
are preserved. Removing the last content tab returns to the project page.

Deleting a draft from the sidebar also retires its workspace record once no other content
tab hosts it. **Files**, **Changes**, and **Pull request** companion tools do not keep an
empty conversation alive; their tabs close only after the daemon confirms the archive.
Other open file editors and drafts are preserved. Each sidebar draft owns a distinct
workspace, so sibling drafts never keep a deleted one alive or leave a checkout-named row.
If the deleted workspace hosts the current route, navigation follows the surviving focused
conversation instead of leaving it on an unavailable workspace. Draft tabs whose workspace
record no longer exists are pruned when the project layout loads. The daemon re-verifies
the workspace is empty before archiving.

Opening a new conversation from the sidebar preserves existing tabs within the same project.
The draft retains its own workspace for execution. Opening a conversation in another project
switches to that project's layout instead of adding it to the current project's tabs.

Opening a workspace that has no conversation from the sidebar focuses its own overview tab
instead of leaving a sibling conversation visible. The overview shows the workspace name,
branch, and change summary, with **New conversation** and **View changes** actions; on
desktop split layouts, a workspace with changes also opens **Changes** in the side panel once
per overview tab. A draft in that workspace that already holds text or attachments is focused
instead, and an untouched draft is turned into the overview, so repeated clicks never stack
tabs. A titled empty workspace (for example one an agent created with `create_workspace`)
keeps its titled sidebar row; only untitled drafts appear as **New workspace** entries.

Archiving a conversation does not create another draft or relabel surviving sidebar entries.
If a different conversation is focused in the same project, it stays focused and navigation
uses its owning workspace. Only the archived conversation's tabs are closed. Workspace open
intents are scoped to the current page, so a parent route's consumed intent cannot reopen an
archived conversation in another workspace.

Conversation notifications follow the same rule: reveal or add the conversation in its owning
project, preserving that project's other tabs, order, and split panes. Notification navigation
does not change the conversation's owning workspace.

## File drag and drop

- Drop files onto the message input to add attachments without sending a message.
- Drop external UTF-8 text files onto the conversation history or other ordinary areas to open local, read-only file tabs, not a dialog. Each tab offers **Preview / Source** modes; Markdown and HTML render in Preview mode. Files are not uploaded.
  - Outside a workspace, files open on a dedicated preview page with file tabs.
  - Preview tabs and their contents are session-only. Switching tabs retains the selected mode; closing a tab releases its content, and reloading removes local preview tabs.
- Local text previews support files up to 2 MiB, including extensionless files. Directories, binary files, and larger files show an explanation instead.
- Terminal surfaces keep their existing file-path drop behavior.

## Image previews

Click an image attachment or generated image to open a full-window preview. Use the mouse wheel or
zoom buttons to change scale, drag an enlarged image to pan, or select fit-to-window / 100% size.
If Desktop asks what to do when its window closes, that choice dialog stays above the preview;
canceling returns to the open image.

Right-click a workspace file tab and choose **Reveal in Files** to open the right-side Files
panel, expand its parent directories, select the file, and scroll it into view. Hidden files
are made visible when needed. This uses the file's owning workspace on local or remote hosts;
files outside that workspace cannot be revealed in its tree.

The Files tree refreshes its root and expanded directories when a conversation in that workspace
finishes, fails, or is canceled. Background conversations refresh only their own workspace; manual
refresh remains available for filesystem changes made outside a conversation.

## Text editor shortcuts

In an editable source tab, press **Ctrl+/** to comment or uncomment the selected lines. **Cmd+/**
continues to work on macOS. The editor uses the comment syntax of the current file type.

Right-click a file tab on the local desktop host to reveal the file in **Finder** (macOS),
**Explorer** (Windows), or **Files** (Linux). The action follows the app's selected language
and is unavailable for remote-host files and web clients.

Desktop editor targets expose only their ID, label, and kind. Editor detection and opening
do not depend on bundled editor icon images.

## Git diff modes

Open the **Changes** panel's Git actions menu and choose **Diff mode**. Its submenu
shows the current comparison with a checkmark:

- **Uncommitted** (default): shows pending working-tree and staged changes. A clean checkout
  shows **No uncommitted changes**, even if the branch has committed or unpushed changes.
- **Compared with `<baseRef>`**: shows differences against the displayed comparison branch,
  such as `origin/main`. Committing does not clear differences against that branch.

You can switch modes whether the file list is empty or populated. Forge account setup
messages do not block local diff viewing or mode switching.

Git operation names, comparison labels, and action feedback follow
**Settings → General → Language** in every supported language. **Archive workspace**
and **Open Changes tab** are not part of this menu.

## Assistant message links

HTTP(S) links open externally. Text/source links open in the workspace file panel. On the local desktop host, links to existing images, documents, archives, and directories inside the workspace open with the operating system; executable files are shown in the file manager rather than launched. Web conversation headings support native `#heading` navigation.

Targets that cannot be opened are plain text rather than colored links, and clicking one shows an unsupported-link error. Failed file or URL opens also show an error. A `sandbox:` URL is not a local file path: conversation data does not contain an authoritative mapping to an attachment on this host, so those links cannot open until such a mapping is provided. Remote-host binary files likewise cannot be opened by the local desktop file manager.

On desktop, right-click an HTTP(S) conversation link to open it in the selected external browser or copy its address. Unsupported schemes do not receive an open action, and an unavailable plain **Copy** action is omitted. Read-only images offer image-specific actions without an ambiguous **Paste** action; editable targets still expose **Paste** according to their current edit capability. Native context menus follow the app's selected language.

Choose the external browser under **Settings → General → Browser**. **System default** follows the operating system; installed Chrome, Edge, Firefox, Brave, Chromium, and Safari targets appear where supported. If a selected browser is later removed, OMP Desktop reports the unavailable browser instead of silently opening a different one.

On the local desktop host, right-click a resolvable workspace file link to reveal it in the system file manager (Explorer on Windows), without opening or executing it. Relative paths, URL-encoded names, and line suffixes use the same resolution as left-click. Remote-host links do not offer local reveal; missing targets and paths outside the workspace, including symlink escapes, are rejected with an error. Left-click behavior is unchanged.

## Assistant message math

Assistant Markdown renders inline formulas delimited by `$...$`, `\(...\)`, or same-line
`\[...\]`. Display formulas use standalone `$$...$$` or `\[...\]` blocks; these blocks also work
inside Markdown quotes and lists. Explicit `\vec{v}` notation renders with both a vector arrow and
a bold symbol, while `\mathbf{v}` remains available for bold-vector notation.

Math keeps its bundled KaTeX fonts when the interface font changes. `\binom61` renders
6 above 1 inside full-height parentheses, without a fraction bar. Fraction bars follow
the formula foreground in light and dark themes, including explicit TeX colors.

## Thinking and tool calls

Collapsed activity groups show their item count in a compact, theme-aware pill with a layers icon. The count updates as activity arrives; expanding the group hides the pill and reveals the individual items. Read tool file buttons remove line-range selectors before opening the workspace file; for comma-separated ranges, the preview selects the first range.

## Background processes

Background work started by the current Agent, including Bash commands and `eval` cells, appears beside the workspace branch above the composer. While work is active, the indicator shows the active count; opening it lists live and recently completed jobs. Select a job to open its read-only terminal output in a bottom pane, or use **Stop** to cancel that job. Stop uses a neutral, borderless square icon with subtle pressed feedback. Closing the output pane does not stop the work.

All native background job types use the same list, live output, and stop controls. Jobs that move from foreground to background become visible when OMP exposes them in the current Agent's background snapshot; foreground jobs and other Agents' native jobs are not included. Stopping the current Agent response cancels that Agent's running background work and suppresses its late completion events; reconnecting restores retained job state and output.

## Independent agent conversations

Agent-scoped `create_agent` calls create a child agent in the caller's workspace by default.
Each workspace can have only one unarchived independent root conversation. To start another
independent conversation, call `create_workspace` first, then call `create_agent` with
`detached: true` and the new `workspaceId`. Normal child agents remain in their parent's
workspace.

A new workspace starts without a conversation. `create_workspace` tells the calling agent to
run work in it through `create_agent` with the returned `workspaceId`, so that work appears as
the workspace's own conversation. Built-in task subagents keep the caller's workspace: files
they edit inside another worktree show up as its changes, but the conversation stays under the
caller.

For workspaces created by older versions with multiple active roots, selecting the workspace
restores every root as a tab and focuses the one needing attention. The workspace menu lists
those conversations and lets users open or archive each one without visiting global history.
Archiving preserves conversation history. Sharing a workspace does not isolate concurrent file
edits.

`notifyOnFinish: true` can notify the creator when an independently created agent finishes,
fails, or needs permission without establishing a parent relationship. Notifications do
not revive an archived creator. Regular child agents retain parent-owned notifications,
which stop if the child is subsequently detached.

## Development

```bash
npm install
npm run dev:desktop
```

The syntax highlighter pins `@codemirror/legacy-modes` to `6.5.3`, whose Swift and
Dart stream parsers use the same CodeMirror 6 language types as the application.
Keep this pin when updating dependencies; `6.5.5` uses incompatible streamparser types.

Development uses:

- daemon: `127.0.0.1:6770`
- renderer: an available Electron Metro port
- state: `.dev/omp-desktop-home`

The packaged app uses `~/.omp-desktop`. OMP keeps its own configuration, credentials, provider subscriptions, and sessions under `~/.omp`.

## SSH remote hosts

The Electron app can provision a remote daemon from **Settings → General → Add host → Connect via SSH**. It uses the system OpenSSH client, including `~/.ssh/config`, agent identities, `ProxyJump`, host-key verification, passwords, passphrases, and MFA prompts.

SSH is used only to inspect the host, upload the version-matched backend, start the daemon, and obtain its pairing offer. After pairing, SSH closes and the app connects through the configured end-to-end encrypted Relay. The remote daemon remains bound to `127.0.0.1:6770`; do not expose that port to the Internet.

Supported remote targets are glibc Linux and macOS on x64 or arm64. The remote account needs:

- a POSIX shell, `tar`, and either `curl` or `wget`;
- outbound HTTPS access to `nodejs.org` and the npm registry;
- write access to its home directory.

No root access is required. Managed runtime files are installed under `~/.omp-desktop/remote-runtime`, while daemon identity and state remain under `~/.omp-desktop`. OMP itself is installed separately from the paired host's settings.

Remote releases are staged and checksum-verified before an atomic switch. Failed starts roll back to the previous managed release. Hosts provisioned this way update through **Host Settings → Update daemon → Update via SSH** because the workspace packages are bundled with the Desktop application rather than installed from the public npm registry. Removing a Host from the app forgets its local SSH management profile but does not stop or delete the remote daemon.

SSH passwords, private-key passphrases, MFA responses, and pairing links are never persisted. The local management profile stores only the SSH target fields, identity-file path, remote runtime path, server ID, and deployed version. Remote Windows and musl-based Linux distributions such as Alpine are not supported.

## Build

```bash
npm run build:desktop -- --dir
```

The macOS arm64 application is written to:

```text
packages/desktop/release/mac-arm64/OMP Desktop.app
```

Desktop packaging keeps build/test-only dependencies out of the production dependency graph and
excludes third-party TypeScript sources, declarations, and MCP SDK examples from the ASAR.
Standard packages retain the bundled OMP executable, runtime workers, shell integration, and
the target platform's native bindings. The early OMP catalog hook is loaded through an encoded
module URL, so installation directories containing spaces remain valid. Windows ConPTY files are
loaded from the matching node-pty prebuild, not its duplicate `third_party` directory.

The Electron language allowlists retain all nine application languages and common regional
variants. macOS also retains each selected language's grammatical-gender `.lproj` variants.
Update both platform allowlists in `packages/desktop/electron-builder.yml` when adding a language.

The frontend Babel pipeline resolves Lucide's actual named exports to individual icon modules,
including legacy aliases; public type imports remain unchanged. Electron web exports use UTF-8
instead of ASCII-escaped strings. Protocol validator generation shares repeated, non-mutating
IR containers without removing validation, defaults, transforms, or fallback schema behavior;
see `packages/protocol/codegen/README.md`.

For local installer builds, pass `--publish never` to avoid uploading release artifacts. To
exercise an unpacked application, including its renderer, daemon, bundled OMP, CLI and terminal:

```bash
node packages/desktop/e2e/packaged-app-smoke.js --app "packages/desktop/release/mac-arm64/OMP Desktop.app"
```

For a local test package, run:

```bash
npm run build:mac
```

Without notarization credentials this produces an unsigned package and prints a warning. Gatekeeper
will reject that package unless quarantine is explicitly removed on the test Mac.

macOS signing uses electron-builder's bundled entitlement template for the app and
helpers; no separate entitlement files are required in `packages/desktop/build`.

For a signed, notarized release, the build machine needs a valid `Developer ID Application`
certificate (or `CSC_LINK`) and one of electron-builder's notarization credential sets:

- `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` (recommended);
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`; or
- `APPLE_KEYCHAIN_PROFILE`, with optional `APPLE_KEYCHAIN`.

When those credentials are present, the script verifies the application's code signature, stapled
notarization ticket, and Gatekeeper assessment after packaging.

Windows installers are produced in separate electron-builder invocations. Build one architecture with:

```bash
npm run build:windows:x64
npm run build:windows:arm64
```

Run `npm run build:windows` to build both sequentially. Publish the resulting `OMP-Desktop-Setup-<version>-x64.exe` and `OMP-Desktop-Setup-<version>-arm64.exe`; no combined installer is produced.

Windows daemon and CLI process-tree cleanup launch `taskkill.exe /T /F` directly with a hidden
console, avoiding transient `cmd.exe` windows during provider refresh and process shutdown.
Interactive terminal launches are unchanged. macOS and Linux retain signal-based tree cleanup.

Desktop updates use the public
[`iris-cat-dev/omp-desktop` GitHub Releases](https://github.com/iris-cat-dev/omp-desktop/releases)
feed. The app checks its configured Stable or Beta channel at startup, downloads a newer package in
the background, verifies the SHA-512 value from electron-builder's update metadata, and installs it
when the user chooses **Install & restart** or next quits the app.

Every release must upload the updater metadata and payloads generated from the same build:

- macOS: `OMP-Desktop-<version>-<arch>.dmg`, the matching `.zip`, and the channel metadata
  (`latest-mac.yml` for Stable or `beta-mac.yml` for Beta);
- Windows: both architecture-specific `.exe` installers, their `.blockmap` files, and the merged
  channel metadata (`latest.yml` for Stable or `beta.yml` for Beta);
- Linux AppImage releases: the AppImage, its blockmap, and the matching `*-linux.yml` metadata.

`build-windows.sh` merges the x64 and arm64 metadata so `electron-updater` selects the installer
matching `process.arch`. A GitHub Release that only contains DMG or EXE files remains available for
manual download but cannot be installed by the in-app updater. Publish the generated files only
after every target for that release is complete; do not use `--publish always` during the individual
Windows architecture builds because it can publish incomplete channel metadata.

To build Windows packages without shipping a new OMP executable, run:

```bash
npm run build:windows:no-omp
npm run build:windows:no-omp:x64
npm run build:windows:no-omp:arm64
```

These artifacts use `OMP-Desktop-No-OMP-Setup-<version>-<arch>.exe` names so they do not overwrite
the standard installers. The application still includes its daemon and CLI; only `omp.exe` is
omitted.

A fresh `no omp` installation uses `omp` on `PATH`. When switching from an installation with
`resources\bin\omp.exe`, the NSIS installer backs up that existing executable before invoking
the old uninstaller, then restores the exact file into the selected installation directory.
This also preserves an independently updated bundled runtime and works when changing the
installation directory. Repeated `no omp` installations retain it; switching back to the
standard installer replaces it with that package's bundled runtime.

Preservation applies only to installing the `no omp` upgrade, including silent installation.
Explicitly uninstalling Desktop still removes its installation directory and bundled OMP.

If the existing runtime cannot be backed up, installation stops before removing the previous
version. If restoration fails, installation reports the location of the retained backup.
The `no omp` ZIP payload itself still contains no OMP executable.

Run the installation-switch regression on a clean Windows VM, with standard and `no omp`
installers for the same version and architecture:

```powershell
node packages/desktop/e2e/windows-installer-switch-smoke.js --standard "packages/desktop/release/OMP-Desktop-Setup-<version>-<arch>.exe" --no-omp "packages/desktop/release/OMP-Desktop-No-OMP-Setup-<version>-<arch>.exe"
```

The smoke refuses to run if the configured application is already registered. It checks fresh
installation, switching to `no omp`, repeated installation with a changed directory, switching
back, and explicit uninstallation. It verifies the preserved executable's SHA-256 and runs the
packaged renderer, daemon, OMP, CLI, and terminal checks after the `no omp` upgrades, including
the daemon's actual runtime path. Wine checks do not replace this real Windows installation
and startup verification.

Pass `--updated-omp "<path-to-another-omp.exe>"` to replace the initially installed runtime
before switching, proving that `no omp` preserves independently updated bytes and that the
standard installer restores its own packaged version. The replacement must differ from the
standard payload. For disposable installers built with an isolated application identity, pass
`--config "<electron-builder.cjs-or-yml>"` describing their `appId` and executable name; the
registration safety check then uses that identity instead of the production application.

Download and checksum-verify the latest supported OMP binaries:

```bash
npm run download:omp
```

Specific targets can be refreshed without downloading every architecture:

```bash
npm run download:omp -- linux-x64 linux-arm64
```

The script writes these release assets to the repository-root `bin/` directory:

- `omp-darwin-arm64`
- `omp-darwin-x64`
- `omp-linux-arm64`
- `omp-linux-x64`
- `omp-windows-arm64.exe`
- `omp-windows-x64.exe`

electron-builder selects the target architecture and installs the executable as `Resources/bin/omp` on macOS, `resources/bin/omp` on Linux, or `resources/bin/omp.exe` on Windows.

### Bundled skills

The repository-root `skills/` directory is the source catalog for bundled orchestration skills. During the server build, `packages/server/package.json` removes the previous `dist/server/skills` directory and recursively copies `../../skills` into it. This makes the same catalog available to the development server and packaged application.

The directory currently contains only `.gitkeep`, which keeps the otherwise-empty catalog under version control. Keep the `skills/` directory even when no bundled skills are present: removing it causes the recursive copy step to fail. Add future bundled skills as subdirectories containing their `SKILL.md` files.

## Self-hosted Web and relay

The default configuration enables the hosted Relay at `relay.paseo.sh:443` with TLS. Self-hosted deployments can replace that endpoint and do not otherwise depend on a hosted Paseo service.

### Build

```bash
npm install
npm run build:server
npm run build --workspace=@omp-desktop/cli
npm run build:web --workspace=@omp-desktop/app
```

The Web export is `packages/app/dist`. These commands build artifacts; they do not start the daemon.

### Cloudflare Pages

```bash
./deploy.sh
# or: npm run deploy:web
```

`deploy.sh` builds the Web export and runs `wrangler pages deploy` against project `omp-desktop` on branch `main`. Override with `CF_PAGES_PROJECT` / `CF_PAGES_BRANCH` if needed. SPA routes fall back through `packages/app/public/_redirects`. Pairing links should use the Pages origin as `app.baseUrl`.

Deploy the `paseo-relay` repository using its `deployment/self-hosted/compose.yaml`, `Caddyfile`, and `.env.example`. That deployment serves both your WSS relay and the Web export on your own domains, with automatic HTTPS and SPA route fallback. The relay machine does not need OMP or access to the daemon's private listening port.

### Configure the machine running OMP

Merge this configuration into `~/.omp-desktop/config.json`, retaining your other settings. Replace the example domains with those in the relay deployment:

```json
{
  "version": 1,
  "daemon": {
    "listen": "127.0.0.1:6770",
    "relay": {
      "enabled": true,
      "endpoint": "relay.example.com:443",
      "useTls": true
    }
  },
  "app": {
    "baseUrl": "https://omp.example.com"
  }
}
```

Start the backend, then obtain a pairing link in another terminal:

```bash
node packages/cli/bin/omp-desktop daemon start --foreground --no-web-ui
node packages/cli/bin/omp-desktop daemon pair --json
```

In the Web app, open **Settings → Connections → Relay server address**. It defaults to `wss://relay.paseo.sh:443`; replace it with `wss://relay.example.com` for a self-hosted deployment. Leave the setting empty only when the browser should use the relay address advertised by each pairing link. An already connected host can generate another link from **Settings → Host → Pair device**. Treat pairing links like passwords: anyone holding one can access that daemon. Legacy placeholder identities require re-pairing after upgrading.

The daemon initiates the outbound connection; do not expose port `6770` to the Internet. Keep `PASEO_APP_BASE_URL` / `app.baseUrl` pointed at your own Web deployment so generated links open the right client.

Environment overrides, useful when the daemon and browser reach different sides of a reverse proxy:

| Environment variable          | Config field                  | Purpose                                                         |
| ----------------------------- | ----------------------------- | --------------------------------------------------------------- |
| `PASEO_RELAY_ENABLED`         | `daemon.relay.enabled`        | Enable or disable Relay access                                  |
| `PASEO_RELAY_ENDPOINT`        | `daemon.relay.endpoint`       | Relay `host:port` dialed by the daemon                          |
| `PASEO_RELAY_USE_TLS`         | `daemon.relay.useTls`         | Outbound daemon TLS                                             |
| `PASEO_RELAY_PUBLIC_ENDPOINT` | `daemon.relay.publicEndpoint` | Browser-facing relay `host:port`; defaults to outbound endpoint |
| `PASEO_RELAY_PUBLIC_USE_TLS`  | `daemon.relay.publicUseTls`   | Browser-facing TLS; defaults to outbound TLS                    |
| `PASEO_APP_BASE_URL`          | `app.baseUrl`                 | Your Web origin in pairing links                                |

Use `true` / `false` for boolean overrides. Relay endpoints are authorities such as `relay.example.com:443`, without a scheme or `/ws` path. Public HTTPS Web deployments need WSS. Disabling TLS for a trusted local development relay does not disable E2EE.

The relay carries daemon WebSocket traffic, including workspace, agent, and terminal control. It does not tunnel arbitrary HTTP endpoints: file downloads and HTTP service previews still need their own reachable address.

## Workspace packages

- `packages/app` — Electron and Web renderer
- `packages/desktop` — Electron main process and packaging
- `packages/server` — local daemon and OMP adapter
- `packages/client` — daemon client
- `packages/protocol` — shared wire schemas
- `packages/relay` — shared E2EE relay transport
- `packages/cli` — `omp-desktop` CLI
- `packages/highlight` — code and diff highlighting

## Verification

```bash
npm run format
npm run lint
npm run typecheck
```

Run only targeted Vitest files; do not run the full test suite locally.

## License

AGPL-3.0-or-later. This project is derived from Paseo and retains its original Git history and license notices.
