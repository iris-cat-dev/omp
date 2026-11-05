# Conversations and workflows

Run, steer, queue, organize, and stop conversations, manage independent agents, and schedule work. For model selection see [Models and providers](models-and-providers.md); for tabs and project ownership see [Workspaces, files, and Git](workspaces-files-git.md).

## Contents

- [Completion and failures](#completion-and-failures)
- [Context compaction](#context-compaction)
- [Turn usage and speed](#turn-usage-and-speed)
- [Workflow and approval modes](#workflow-and-approval-modes)
- [Steering and stopping](#steering-and-stopping)
- [Queued messages](#queued-messages)
- [Questions and background processes](#questions-and-background-processes)
- [Conversation organization and history](#conversation-organization-and-history)
- [Independent agents](#independent-agents)
- [Schedules](#schedules)
- [Notifications](#notifications)

## Completion and failures

Desktop completes a turn automatically after OMP finishes its model turn and reports that it is neither streaming nor compacting. **Stop** interrupts work; it is not an acknowledgement button. Internal `developer` messages, including project-rule reminders, are accepted in completion events and RPC history but do not appear as user or assistant messages, including after reopening history.

The current turn's **Fork** button stays hidden while the conversation is running and appears in its completed-turn footer after the turn ends. Fork actions on earlier completed turns remain available.

Forking a completed turn from reopened OMP history reads the same persisted timeline as the chat, without resuming the source runtime or changing its timeline epoch. The copied history stops at the selected response; genuinely stale or missing timeline positions remain errors.

Conversation rewind removes the selected prompt from the new transcript, while preserving earlier messages, images, and outline anchors. Desktop reads the new persisted active tip; the removed checkpoint is not a valid branch leaf and must not turn the retained history into an empty snapshot.

If an older Desktop build stays running after the final answer, save active work, update Desktop, and restart its daemon. Updating only the bundled OMP executable does not update Desktop's RPC adapter.

After a daemon restart, saved `running` or `initializing` snapshots without a loaded runtime appear as `closed`, not as evidence that the interrupted work completed. **Stop**, `cancel_agent`, and `kill_agent` accept an existing unloaded conversation as already stopped without launching a provider or deleting history. Unknown Agent IDs remain errors. Stopping an unloaded conversation returns its inactive snapshot and refreshes the requesting client's subscribed conversation directory.

Provider-request failures after the Agent runtime starts appear as sanitized system errors, including the HTTP status and safe proxy error code when available, never proxy credentials. The existing Agent and provider session remain retryable; a transient network or proxy failure does not require a new conversation.

## Context compaction

`/compact` shows a progress marker and explains that compaction may take a few minutes. New messages submitted during compaction wait for it to finish; they do not need to be resent. Desktop does not apply the short 30-second control-plane deadline to prompt admission, because OMP may still be compacting or preparing that input. Runtime exit and genuine submission errors remain failures.

Native manual-compaction progress updates the marker even before a model turn starts. The completion event or successful RPC result clears the loading state without duplicate markers. The waiting explanation disappears when compaction finishes.

## Turn usage and speed

The chat `tok/s` uses Agent Speed's request-based calculation, not differences between session-wide token counters. Completed turns use this agent's valid measured output divided by its summed native request time, including first-token wait and excluding time between requests spent running tools. Requests shorter than 500 ms use the original 500 ms floor; invalid or over-15-minute intervals do not contribute measured speed. Failed, aborted and untimed requests can retain their actual usage without inventing a speed from **Worked for**.

During generation, the last three seconds combine completed-request facts with an estimate from recent native references. Completion replaces the in-flight estimate rather than adding it twice; tools, cancellation and compaction stop that estimate. Copied history is not claimed as this file's own speed reference. Historical assistant messages retain safe per-turn facts for footer restoration, including Plan messages.

After reconnecting, the completed assistant's replayed facts take precedence over a retained in-flight footer sample, so a missed final live event does not leave stale totals or speed.

Native session aggregates remain separate for Usage, context and quota displays. A second 1,000-output-token, ten-second turn therefore remains **100 tok/s**, not 200 tok/s from cumulative session output. Existing chat styling and number formatting are unchanged; no approximation symbol is added.

## Workflow and approval modes

**Standard**, **Enhanced**, **Plan**, and **Goal** have hover descriptions localized in all nine supported interface languages. **Enhanced** uses the same Sparkles icon in the workflow menu and current-mode control, whether in the toolbar or compact settings sheet.

Both Standard and Enhanced continue responses that hit the model's output-length limit. Enhanced additionally waits **five seconds** after a terminal model-request error, then sends a localized **Continue** message (`继续` in Chinese). Every terminal error is eligible, including HTTP 4xx/5xx, provider-stream errors without a status (such as `Error Code server_error: … the param is invalid`), and failures after OMP exhausts its own retries. Repeated errors repeat the wait without an attempt limit or increasing backoff. Aborted responses are not resumed.

The conversation remains active until continuation succeeds or is stopped. **Stop**, closing the session, or leaving Enhanced cancels pending continuations. OMP's internal retries are unchanged: the five-second wait begins after its terminal error, not after each internal attempt.

### Approval changes during a session

Desktop offers **Always ask** and **Auto approval**. New conversations default to Auto approval (`yolo` in the SDK); an explicitly selected or saved Always ask preference is retained. The former Full access selection keeps its `full` ID and now displays as Auto approval. Retired Write approval preferences and stored conversations migrate to Always ask, without granting execution permission; imported native `write` settings also select Always ask.

Both modes can be changed in either direction while an OMP turn is running, including sessions launched with Auto approval. Desktop uses OMP's native `set_approval_mode` command; it does not restart the session, interrupt the turn, or synthesize approval responses. Desktop updates its runtime mode only after OMP accepts the update. A failed update leaves the current mode unchanged.

OMP withdraws pending tool approvals and re-evaluates the waiting calls under the new mode. Desktop removes the withdrawn requests: newly allowed calls continue, while calls that still require approval receive a fresh request. Answers to withdrawn requests are rejected. Questions and plan confirmations still need an explicit answer.

Explicit per-tool `prompt` and `deny` policies remain effective with Auto approval. Switching modes does not grant a persistent per-tool approval exemption.

## Steering and stopping

While a conversation runs, the composer defaults to **Steer**. Steering guides the active turn without canceling it or managed descendants; a parent stays steerable while an OMP-native subagent runs in the background. A submitted steer stays visibly pending until OMP's canonical user-message event confirms consumption. An RPC acknowledgement confirms only admission.

If the provider cannot accept steering, Desktop reports a send failure and leaves the current turn running. Agent-to-agent prompts and completion notifications follow this same non-destructive rule, rather than replacing the turn.

Prompt admission is serialized per target until its provider accepts the turn, not until the task finishes. Concurrent messages and completion notifications then steer that turn instead of replacing a still-starting request. Queued admissions retain their submission-time Stop epochs, including managed ancestors: Stop withdraws them rather than letting a late admission response restart work. Deliberate messages submitted after Stop can start normally. Other conversations remain independent; out-of-band controls bypass admission waits.

Sending immediately clears the submitted text and image/file attachments from the composer and cancels any deferred publication of that draft. The conversation displays one local message while loading or sending; the host's canonical echo reconciles by client message ID. On rejection, the submitted text and attachments return only if the current composer is still empty. New text or attachment edits, and drafts in a newly selected conversation, are never cleared or overwritten by an earlier submission.

Workspace setup retains its submitted text and image/file attachments until creation is accepted. Directory-validation and agent-creation failures are rejected submissions, not acceptance. Successful creation clears only its unchanged originating snapshot before closing or navigating, cancels unpublished text, and preserves attachment edits or a replacement workspace draft.

Closing and reopening setup for the same directory starts a replacement setup. A creation accepted by the earlier setup cannot close the replacement or clear its text and attachments, including text still awaiting after-paint publication.

When starting a conversation in a new workspace, directory-check, workspace-creation, and agent-creation failures are reported as rejected submissions. The text and image/file attachments remain available for an explicit retry; displaying a creation error does not count as accepting the message.

Autonomous OMP continuations remain steerable after a foreground turn finishes: the provider and Desktop share one active turn identity. Delayed idle checks from an older turn or an earlier continuation cannot clear the current turn. Rejections distinguish unsupported steering, a provider with no active turn, and a mismatched turn identity; identity failures never trigger automatic cancellation or replacement.

The conversation's **Stop** interrupts its current run and all running managed descendants, including children still active when the parent finishes during the stop request. Detached agents are independent and are not stopped. The subagent list also offers **Stop** on each running child; stopped children remain listed, unlike archived children.

Interrupt-and-send and Stop share a 15-second cleanup budget for the selected agent and its managed descendants. The composer shows cleanup progress, prevents duplicate sends or recovery, and remains editable. A refusal does not start the replacement or pretend that the old run stopped. The message and attachments remain available; **Recover runtime** appears inline with the existing dangerous-operation confirmation. Recovery preserves history, does not undo completed side effects, and never automatically resends input. Switching conversations does not redirect delayed feedback or recovery to another agent.

Individual and parent-initiated OMP-native child cancellation uses `cancel_subagent` RPC, included in Desktop's pinned SDK. Standalone CLI hosts require OMP **18.4.9+** for that operation; older binaries report failure and leave the child marked running rather than claiming it stopped. Update packaged SDKs through Desktop updates. The general standalone CLI minimum remains **OMP 18.8.7**.

## Queued messages

### Independent conversations

Queued messages belong to their own conversation, not a shared host-wide execution queue. A running or initializing conversation does not block ready follow-ups in another conversation on the same host. Waiting for one conversation's submission acknowledgement or completion also leaves other conversations free to continue.

Each composer shows only its conversation's pending messages. There is no cross-conversation order board. Sorting pending messages does not change another conversation's execution or interrupt any running turn. **Send queued message now** remains a separate explicit action.

### Order within a conversation

Hold and drag a queued message's handle; the highlighted row and moving gap preview the committed delivery order. On native clients, briefly press and hold before dragging. For keyboard sorting, focus the handle, press **Space**, use **Up/Down**, and press **Space** again; **Escape** cancels.

Edits and additions during a drag retain their latest contents and order. A drop moves only the chosen message relative to a current queue neighbor; if either has been sent or removed, the drop is ignored and cannot restore it. Text, attachments, identity, and enqueue order are preserved unless explicitly moved. Submitted or executing messages are not sortable, and reordering does not send or interrupt a turn.

After normal completion, the next queued message starts automatically, even if completion precedes the previous submission acknowledgement. Each message is submitted once in queue order. Failed submission retains its original text and attachments for retry. A cancellation-refused item pauses automatic dispatch at its position, including after runtime recovery; use its existing send arrow or edit action to retry. The arrow's tooltip names the selected steering, interrupt-and-send, or ordinary-send action. Automatic dispatch also waits for cancellation and pending submission acknowledgements to settle.

## Questions and background processes

Grouped OMP questions use labeled tabs that can be visited in any order. Selections and typed answers survive switching. **Submit** sends the whole group once every required question is answered.

Background work started by the current Agent, including Bash commands and `eval` cells, appears beside the workspace branch above the composer. The active indicator shows a count; opening it lists live and recently completed jobs. Select a job for read-only terminal output in a bottom pane, or **Stop** that job with the neutral borderless square control. Closing output does not stop work.

All native background job types share this list, live output, and cancellation. Foreground-to-background jobs appear when OMP exposes them in the current Agent's snapshot; foreground jobs and other Agents' native jobs are excluded. Stopping the Agent response cancels its running background work and suppresses late completion events. Reconnection restores retained job state and output.

The indicator stays hidden when no process content exists, including fetch failures and disconnections. Errors remain visible if retained process entries are available.

Background ownership is stable as `desktop:<agentId>` across rewind: changing the native transcript ID does not orphan or transfer jobs or retained eval variables.

### Runtime retention and safe unload

After five idle minutes Desktop considers unloading the runtime and rechecks retained conversations every 30 seconds. It keeps history and the conversation record. Running or admitted work, queued or unconfirmed input, pending permissions, background dependencies, and retained variables/resources prevent unload; idle does not mean disposable. The Agent tab menu's **Runtime resources** entry uses a CPU icon and opens the resource inventory and retention reasons. The conversation footer no longer shows runtime-retention status or an expandable retention panel; automatic unload behavior is unchanged.

Explicit resource release permanently discards that resource's variables. Busy or shared resources and resources required by background work cannot be released. Safe unload inventories resources, drains pending persistence, inventories again, then synchronously fences final admission before invoking disposal. The runtime is detached only after provider closure succeeds; an unconfirmed close remains visible and blocks new work and safe unload.

Automatic idle retirement and `agent unload` never cancel or force work. Ordinary `kill_agent` requests acknowledged cancellation first, then applies the same data and variable gates. Explicit `kill_agent({ force: true })` performs controlled recovery of only the target provider runtime, requiring confirmed process exit and host-tool settlement. It discards that runtime's variables, preserves conversation records/history, and does not roll back side effects.

## Conversation organization and history

Sidebar rows always use the conversation title and last-activity time (for example `2h` or `2d`); missing timestamps leave the space blank. The former **Title**, **Diff stats**, and **Last activity** display choices are removed without resetting other settings.

Automatically generated conversation/workspace titles use the interface language resolved when the creation request is sent, including **System** language selection. This requirement overrides the language of the prompt, attachments, and project `metadataGeneration.title.instructions`; technical identifiers such as file paths, commands, package names, and PR/issue numbers keep their original form. Git branch naming is unchanged. Changing the interface language does not rewrite existing titles or user-set names.

Only online hosts contribute project and chat rows. Disconnecting hides cached rows but preserves host profiles, project order, and host filters; reconnecting restores them. See [Remote hosts](../remote-hosts.md) for connection management.

Resuming a reopened conversation displays live output and late-arriving approvals without a wheel-scroll refresh. When already at the bottom, changes to live rows or loaded-message presentation keep the latest content visible. Scrolling upward disengages output following and preserves the reading position.

The chat's left outline excludes prompts sent by another agent through **send_agent_prompt**, while keeping them visible in the transcript. Direct user input, top-level tool input, and self-sent prompts remain eligible. Source metadata survives native-history reloads. Older messages without recorded source metadata remain indexed; Desktop does not guess provenance from their text.

In project grouping, pinned chats stay above unpinned chats. Within each section, task-state order is running, needs input, failed, attention, then done; equal-state chats retain saved order and keyboard shortcuts follow displayed order. Drag pinned conversations to set their saved priority, previewed before release. Manual order persists locally across restarts, project switches, and sidebar collapse/expansion. Reordering does not open the chat or reorder unpinned chats, and is disabled when host or label filters hide part of the pinned list.

Hover a sidebar conversation for **Delete** and **Archive** before its three-dot menu, in both project and status groupings. Delete still asks for confirmation. **Fork** remains in the conversation menu and opens a draft with the source history without changing the source. The right-click and three-dot menus also offer **Copy Agent ID**, which copies that conversation's primary Agent ID, not its workspace ID or the currently selected conversation's ID. It prefers an active primary Agent and can resolve an archived conversation from history. Shortcut clicks do not open, drag, or rename the row. See [Conversation names and navigation](workspaces-files-git.md#conversation-names-and-navigation) for rename behavior.

### Replay and permanent deletion

OMP `model_usage` records, including background-memory usage, are metadata rather than chat messages. Replay preserves their original JSONL and usage values without an unsupported-record notice; surrounding messages remain visible. Truly unknown record types still produce diagnostics.

Desktop-injected tools distinguish:

| Tool            | Effect                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `cancel_agent`  | Stops a run.                                                                                                                    |
| `archive_agent` | Hides the conversation, retaining history.                                                                                      |
| `kill_agent`    | Requests acknowledged cancellation, then safely unloads an eligible runtime; explicit `force` recovers only its target runtime. |
| `delete_agent`  | Permanently removes the Desktop conversation record and retained timeline.                                                      |

Native `archive_agent` updates connected sidebars without a refresh. A workspace whose conversations are all archived is hidden from the project and status lists, including their keyboard shortcuts, but its workspace record, files, and history remain intact. New empty workspaces and workspaces with another unarchived conversation remain visible. Reopening an archived conversation restores its sidebar entry.

Use `delete_agent({ agentId, confirm: true })` only after explicit user authorization. It supports loaded, archived, and unloaded records without loading a provider session. Results are `deleted` or `not_found`; runtime-close/storage errors are failures, not successful deletions. The caller and its managed ancestors cannot be deleted through this tool.

Connected clients refresh directories and history/search caches after deletion. Project files, deliverables, workspaces, Git worktrees/branches, and provider-owned session files are not deleted: this removes Desktop history, not providers' independent logs.

## Independent agents

Agent-scoped `create_agent` creates a child in the caller's workspace by default. Each workspace can have only one unarchived independent root conversation. For another independent conversation, call `create_workspace`, then `create_agent` with `detached: true` and its returned `workspaceId`. Assigning a child to another worktree keeps its parent relationship and execution workspace; it does not make it an independent conversation.

A new workspace starts without a conversation. `create_workspace` instructs the caller to use `create_agent` with that ID so work appears as the workspace's own conversation. Built-in task subagents retain the caller's workspace: editing another worktree changes its files, but does not relocate the conversation.

Managed children remain in their parent's subagent track, including children in another worktree. Child-only workspaces do not add sidebar conversation rows or automatically open tabs. Opening a child in the same project keeps it with the parent pane while preserving its own working directory and workspace; children in another project open in that project's layout. Detaching restores independent conversation visibility; empty workspaces and workspaces with an active independent root remain visible.

Older workspaces with multiple active roots restore each root as a tab and focus the one needing attention. Their workspace menu can open or archive each root without global history. Archiving retains history. A shared workspace does not isolate concurrent file edits.

`notifyOnFinish: true` can notify the creator when an independent agent finishes, fails, or needs permission without creating a parent relationship. It does not revive an archived creator. Ordinary child agents retain parent-owned notifications, which cease if the child is detached.

Repeated finish subscriptions for the same target, caller, and ownership policy share one notification. Agent-scoped `send_agent_prompt` defaults to no finish notification when reporting to a parent or another managed ancestor, so a parent's completion does not restart finished reporters. Child tasks and independent collaborators still default to notifications; explicit `notifyOnFinish: true` opts in for ancestor reports.

### OMP-native task subagents

Native `task` workers appear in the parent's subagent track as soon as OMP reports them, without waiting for the parent tool result. They are provider children, not independent Desktop conversations. Opening a child shows a read-only transcript with live text, reasoning, tool arguments, and tool output; nested children retain their dotted native IDs.

The child's native progress owns its displayed model selector, including thinking level and fallback changes. Assistant-message metadata is used only until progress reports a model for that run; streaming text cannot toggle the model label between selector and response-model forms. Missing description fields preserve an existing task label rather than replacing it with the full assignment.

An idle child can resume under the same ID. A new native `started` event begins that run; delayed progress or metadata cannot reopen a completed or canceled run. The existing transcript remains available across continuation and reconnection.

Native snapshots and JSONL history restore child transcripts independently of the parent's conversation history. Retained child lists and paged transcripts can also be read while the parent runtime is unloaded. Ordinary reads preserve the timeline epoch; explicit history replacement, such as a session reload or rewind, can replace it and requires a fresh client snapshot.

Reading cold history, focus, attention, or model metadata does not start an SDK host or provider session. Retained snapshots are used when available; dynamic information without a snapshot is explicitly unavailable. Tool-body changes arrive incrementally through `contentVersion` and `revisedEntries`/`revisedRows`, even behind the sequence cursor. An older page cannot roll back a newer revision, and an ordinary tool revision does not reset an `after` history window.

`get_agent_activity` uses the same cold-history reader for unloaded OMP conversations, including archived conversations. It preserves complete projected activities and summary limits without restoring a runtime or appending lifecycle records. Missing or unsupported history reports that inspection is unavailable; reading history never implicitly resumes a conversation. The reported mode comes from retained metadata when no runtime is loaded.

## Schedules

On **Schedules**, use a task's **⋮ → Pause / Resume**, including heartbeats prompting an existing Agent. Paused tasks display **Paused** and retain cadence, prompt, target, and limits. Pausing prevents future triggers without interrupting started executions. Resume computes the next trigger from the original cadence without replaying missed runs.

Agent tools `list_schedules`, `pause_schedule`, and `resume_schedule` manage only new-Agent schedules. Existing-Agent heartbeats are managed on the Schedules page; absence from those tools does not imply a different task ID.

## Notifications

Desktop **Settings → Notifications** provides localized permission controls, sound preferences, and a test. Native support is not proof of OS authorization: **Notification settings** opens macOS or Windows preferences where notifications must be allowed.

Tests wait for native `show`/`failed` acknowledgement. OS rejection, closure before acknowledgement, or no acknowledgement within ten seconds reports undelivered. An accepted notification can still have its banner suppressed by system Focus or presentation settings.

Notification navigation reveals or adds a conversation in its owning project, preserving that project's other tabs, order, and splits without changing workspace ownership. See [Workspaces, files, and Git](workspaces-files-git.md).
