# Conversations and workflows

Run, steer, queue, organize, and stop conversations, manage independent agents, and schedule work. For model selection see [Models and providers](models-and-providers.md); for tabs and project ownership see [Workspaces, files, and Git](workspaces-files-git.md).

## Contents

- [Completion and failures](#completion-and-failures)
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

If an older Desktop build stays running after the final answer, save active work, update Desktop, and restart its daemon. Updating only the bundled OMP executable does not update Desktop's RPC adapter.

Provider-request failures after the Agent runtime starts appear as sanitized system errors, including the HTTP status and safe proxy error code when available, never proxy credentials. The existing Agent and provider session remain retryable; a transient network or proxy failure does not require a new conversation.

## Workflow and approval modes

**Standard**, **Enhanced**, **Plan**, and **Goal** have hover descriptions localized in all nine supported interface languages. **Enhanced** uses the same Sparkles icon in the workflow menu and current-mode control, whether in the toolbar or compact settings sheet.

Both Standard and Enhanced continue responses that hit the model's output-length limit. Enhanced additionally waits **five seconds** after a terminal model-request error, then sends a localized **Continue** message (`继续` in Chinese). Every terminal error is eligible, including HTTP 4xx/5xx, provider-stream errors without a status (such as `Error Code server_error: … the param is invalid`), and failures after OMP exhausts its own retries. Repeated errors repeat the wait without an attempt limit or increasing backoff. Aborted responses are not resumed.

The conversation remains active until continuation succeeds or is stopped. **Stop**, closing the session, or leaving Enhanced cancels pending continuations. OMP's internal retries are unchanged: the five-second wait begins after its terminal error, not after each internal attempt.

### Approval changes during a session

Select **Full access** in a running conversation to automatically approve pending and subsequent OMP tool requests. The daemon sends native approval responses without restarting the conversation or changing immutable launch-time approval flags. Automatic approval does not require an open client. Questions and plan confirmations still need an explicit answer.

For native prompts that also offer **Approve \<tool\> for this session**, automatic
approval selects the default **Approve** action for that request only. It does not
grant a persistent per-tool exemption that would bypass approvals after switching back.

Switching back to the mode used when the current OMP process launched stops automatic approval and restores native behavior. Other approval-mode changes require a new session. A process launched with Full access cannot gain native prompts by switching to **Always ask** or **Write approval**.

## Steering and stopping

While a conversation runs, the composer defaults to **Steer**. Steering guides the active turn without canceling it or managed descendants; a parent stays steerable while an OMP-native subagent runs in the background. A submitted steer stays visibly pending until OMP's canonical user-message event confirms consumption. An RPC acknowledgement confirms only admission.

If the provider cannot accept steering, Desktop reports a send failure and leaves the current turn running. Agent-to-agent prompts and completion notifications follow this same non-destructive rule, rather than replacing the turn.

Autonomous OMP continuations remain steerable after a foreground turn finishes: the provider and Desktop share one active turn identity. Delayed idle checks from an older turn or an earlier continuation cannot clear the current turn. Rejections distinguish unsupported steering, a provider with no active turn, and a mismatched turn identity; identity failures never trigger automatic cancellation or replacement.

The conversation's **Stop** interrupts its current run and all running managed descendants, including children still active when the parent finishes during the stop request. Detached agents are independent and are not stopped. The subagent list also offers **Stop** on each running child; stopped children remain listed, unlike archived children.

Individual and parent-initiated OMP-native child cancellation requires OMP **18.4.9+** (`cancel_subagent` RPC). Older binaries report that the child could not be stopped and leave it marked running instead of claiming success. Update OMP in Host Settings, or run `npm run download:omp` before [packaging](../packaging.md). The repository's general minimum remains **OMP 18.8.7**, even when native child cancellation is not needed.

## Queued messages

### Independent conversations

Queued messages belong to their own conversation, not a shared host-wide execution queue. A running or initializing conversation does not block ready follow-ups in another conversation on the same host. Waiting for one conversation's submission acknowledgement or completion also leaves other conversations free to continue.

Each composer shows only its conversation's pending messages. There is no cross-conversation order board. Sorting pending messages does not change another conversation's execution or interrupt any running turn. **Send queued message now** remains a separate explicit action.

### Order within a conversation

Hold and drag a queued message's handle; the highlighted row and moving gap preview the committed delivery order. On native clients, briefly press and hold before dragging. For keyboard sorting, focus the handle, press **Space**, use **Up/Down**, and press **Space** again; **Escape** cancels.

Edits and additions during a drag retain their latest contents and order. A drop moves only the chosen message relative to a current queue neighbor; if either has been sent or removed, the drop is ignored and cannot restore it. Text, attachments, identity, and enqueue order are preserved unless explicitly moved. Submitted or executing messages are not sortable, and reordering does not send or interrupt a turn.

After normal completion, the next queued message starts automatically, even if completion precedes the previous submission acknowledgement. Each message is submitted once in queue order. Failed submission retains its original text and attachments for retry.

## Questions and background processes

Grouped OMP questions use labeled tabs that can be visited in any order. Selections and typed answers survive switching. **Submit** sends the whole group once every required question is answered.

Background work started by the current Agent, including Bash commands and `eval` cells, appears beside the workspace branch above the composer. The active indicator shows a count; opening it lists live and recently completed jobs. Select a job for read-only terminal output in a bottom pane, or **Stop** that job with the neutral borderless square control. Closing output does not stop work.

All native background job types share this list, live output, and cancellation. Foreground-to-background jobs appear when OMP exposes them in the current Agent's snapshot; foreground jobs and other Agents' native jobs are excluded. Stopping the Agent response cancels its running background work and suppresses late completion events. Reconnection restores retained job state and output.

The indicator stays hidden when no process content exists, including fetch failures and disconnections. Errors remain visible if retained process entries are available.

## Conversation organization and history

Sidebar rows always use the conversation title and last-activity time (for example `2h` or `2d`); missing timestamps leave the space blank. The former **Title**, **Diff stats**, and **Last activity** display choices are removed without resetting other settings.

Only online hosts contribute project and chat rows. Disconnecting hides cached rows but preserves host profiles, project order, and host filters; reconnecting restores them. See [Remote hosts](../remote-hosts.md) for connection management.

In project grouping, pinned chats stay above unpinned chats. Within each section, task-state order is running, needs input, failed, attention, then done; equal-state chats retain saved order and keyboard shortcuts follow displayed order. Drag pinned conversations to set their saved priority, previewed before release. Manual order persists locally across restarts, project switches, and sidebar collapse/expansion. Reordering does not open the chat or reorder unpinned chats, and is disabled when host or label filters hide part of the pinned list.

Hover a sidebar conversation for **Delete** and **Archive** before its three-dot menu, in both project and status groupings. Delete still asks for confirmation. **Fork** remains in the conversation menu and opens a draft with the source history without changing the source. The right-click and three-dot menus also offer **Copy Agent ID**, which copies that conversation's primary Agent ID, not its workspace ID or the currently selected conversation's ID. It prefers an active primary Agent and can resolve an archived conversation from history. Shortcut clicks do not open, drag, or rename the row. See [Conversation names and navigation](workspaces-files-git.md#conversation-names-and-navigation) for rename behavior.

### Replay and permanent deletion

OMP `model_usage` records, including background-memory usage, are metadata rather than chat messages. Replay preserves their original JSONL and usage values without an unsupported-record notice; surrounding messages remain visible. Truly unknown record types still produce diagnostics.

Desktop-injected tools distinguish:

| Tool            | Effect                                                                     |
| --------------- | -------------------------------------------------------------------------- |
| `cancel_agent`  | Stops a run.                                                               |
| `archive_agent` | Hides the conversation, retaining history.                                 |
| `kill_agent`    | Terminates a loaded runtime, retaining its record.                         |
| `delete_agent`  | Permanently removes the Desktop conversation record and retained timeline. |

Native `archive_agent` updates connected sidebars without a refresh. A workspace whose conversations are all archived is hidden from the project and status lists, including their keyboard shortcuts, but its workspace record, files, and history remain intact. New empty workspaces and workspaces with another unarchived conversation remain visible. Reopening an archived conversation restores its sidebar entry.

Use `delete_agent({ agentId, confirm: true })` only after explicit user authorization. It supports loaded, archived, and unloaded records without loading a provider session. Results are `deleted` or `not_found`; runtime-close/storage errors are failures, not successful deletions. The caller and its managed ancestors cannot be deleted through this tool.

Connected clients refresh directories and history/search caches after deletion. Project files, deliverables, workspaces, Git worktrees/branches, and provider-owned session files are not deleted: this removes Desktop history, not providers' independent logs.

## Independent agents

Agent-scoped `create_agent` creates a child in the caller's workspace by default. Each workspace can have only one unarchived independent root conversation. For another independent conversation, call `create_workspace`, then `create_agent` with `detached: true` and its returned `workspaceId`. Normal children stay in their parent's workspace.

A new workspace starts without a conversation. `create_workspace` instructs the caller to use `create_agent` with that ID so work appears as the workspace's own conversation. Built-in task subagents retain the caller's workspace: editing another worktree changes its files, but does not relocate the conversation.

Older workspaces with multiple active roots restore each root as a tab and focus the one needing attention. Their workspace menu can open or archive each root without global history. Archiving retains history. A shared workspace does not isolate concurrent file edits.

`notifyOnFinish: true` can notify the creator when an independent agent finishes, fails, or needs permission without creating a parent relationship. It does not revive an archived creator. Ordinary child agents retain parent-owned notifications, which cease if the child is detached.

## Schedules

On **Schedules**, use a task's **⋮ → Pause / Resume**, including heartbeats prompting an existing Agent. Paused tasks display **Paused** and retain cadence, prompt, target, and limits. Pausing prevents future triggers without interrupting started executions. Resume computes the next trigger from the original cadence without replaying missed runs.

Agent tools `list_schedules`, `pause_schedule`, and `resume_schedule` manage only new-Agent schedules. Existing-Agent heartbeats are managed on the Schedules page; absence from those tools does not imply a different task ID.

## Notifications

Desktop **Settings → Notifications** provides localized permission controls, sound preferences, and a test. Native support is not proof of OS authorization: **Notification settings** opens macOS or Windows preferences where notifications must be allowed.

Tests wait for native `show`/`failed` acknowledgement. OS rejection, closure before acknowledgement, or no acknowledgement within ten seconds reports undelivered. An accepted notification can still have its banner suppressed by system Focus or presentation settings.

Notification navigation reveals or adds a conversation in its owning project, preserving that project's other tabs, order, and splits without changing workspace ownership. See [Workspaces, files, and Git](workspaces-files-git.md).
