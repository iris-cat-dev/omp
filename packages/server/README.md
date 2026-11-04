# Paseo Server

Local daemon for coding-agent orchestration, workspaces, terminals, and the Paseo web app.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env and add any provider API keys you need

# Run development servers
npm run dev

# Open browser to http://localhost:5173
```

## Architecture

- **Express Server** (port 3000) - Serves API and built UI in production
- **Vite Dev Server** (port 5173) - Hot-reload React UI in development
- **WebSocket** (`/ws`) - Real-time bidirectional communication
- **Agent** - Coding-agent orchestration with terminal control
- **Daemon** - tmux-based terminal management (in-process)

## Development

```bash
# Run both servers (recommended)
npm run dev

# Or run separately:
npm run dev:server  # Express on port 3000
npm run dev:ui      # Vite on port 5173

# Type checking
npm run typecheck

# Build for production
npm run build

# Start production server
npm start
```

## Project Status

**✅ Completed** (Phases 1-2):

- Package setup and configuration
- Express server with WebSocket
- React UI with Vite
- WebSocket client with ping/pong testing

**⏳ In Progress** (Phase 3):

- Terminal control (tmux integration)

**📋 Planned** (Phases 4-9):

- LLM integration (OpenAI GPT-4)
- Agent orchestrator
- UI polish

See [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) for complete details.

## Environment Variables

```bash
OPENAI_API_KEY=your-openai-key-here
PASEO_HOME=~/.paseo        # Runtime state directory (agents/, etc.)
PASEO_LISTEN=127.0.0.1:6767  # Listen address (host:port or /path/to/socket)
```

`PASEO_HOME` defaults to `~/.paseo` and isolates runtime artifacts like `agents/`. `PASEO_LISTEN` controls the daemon listen address. For blue/green testing you can run a parallel server without touching production state:

```bash
PASEO_HOME=~/.paseo-blue PASEO_LISTEN=127.0.0.1:7777 npm run dev
```

## OMP SDK plugin management

With `agents.providers.omp.ompBackend: "sdk"`, the existing plugin settings
requests run through a dedicated Node SDK child using `dist/node/plugins.mjs`.
The selected `ompSdkPath`, provider environment, proxy settings, cwd and scope
apply to management as well as sessions. No OMP executable is resolved, and an
invalid SDK fails instead of falling back to CLI. The `cli` backend retains the
existing command path.

Stage the complete SDK, including `plugins.mjs`. Local plugin linking, listing,
enable/disable and read-only diagnostics do not require Bun or npm. Network
package installation still requires a package manager; embedded Node is not an
npm installation. Management uses OMP's existing stores. Selecting the SDK
backend does not provision or enable plugins; explicit install/link/enable
commands retain their existing CLI behavior.

## Timeline memory retention

Tool progress is materialized per call/turn instead of appending every growing
argument, patch or task-card snapshot. Tool rows keep their sequence number and
increase their revision. Durable writes coalesce pending revisions and serialize
the initial insert before later updates. The application accepts newer revisions
at existing sequence numbers and rejects stale live/fetched snapshots.
`contentVersion` acknowledges edits independently of sequence position;
`revisedEntries`/`revisedRows` deliver changed earlier rows incrementally. Ordinary
tool-body changes do not reset `after` windows. Older same-sequence pages cannot
roll back newer revisions.

Old history retains its sequence numbers but shares superseded tool payloads.
Fork-visible summaries and task logs use detached text-edit checkpoints at
canonical row boundaries, preserving earlier fork context without retaining each
full historical log. Ordinary timeline fetches omit these internal checkpoints.
Oversized shell/plain-text content is copied after truncation so a short V8
sliced string cannot retain the full original output.
Complete `File` bodies are persisted without the generic 500,000-character
tool-text truncation; image externalization and private-field stripping remain.

Cold history uses the selected SDK's `dist/node/modules.json` export
`@oh-my-pi/pi-coding-agent/session/indexed-session-journal`, not a second scanner
or an SDK host. First-scan index/catalog work is separate from warm small-page
I/O. SDK file-backed history uses bounded lazy entry facades with an 8 MiB hot
body budget and an 8 MiB body LRU, rereading evicted bodies from source.

Standalone CLI execution remains optional, but cold history still requires a
real built Node SDK containing that module manifest/export. Missing packages or
artifacts report a cold-history prerequisite error, with no scanner fallback or
host startup.

`readActiveOmpSubagentMessages(sessionFile, provider, activeEntryId?, runtimeSettings?)`
reads compact task-discovery messages from the selected indexed journal;
`streamOmpSubagentHistory` uses this read-only path instead of loading the full
parent chain. The `desktop-timeline-v3` catalog stores compact `subagentMessages`;
older catalogs missing that field upgrade with sparse journal reads, not a full
catalog rebuild. The `desktop-subagent-discovery-v1` fallback validates generation,
source size, branch IDs and checksums. Its cache retains only task-call identity,
name and agent selection, task result/progress/async discovery fields or legacy
session paths, and async-result ownership/status—not parent text, prompts, full
arguments or images. `getOmpColdHistoryStats()` separates `discoveryBytesRead` and
`discoveryEntriesParsed` from other history I/O; initial scan/catalog costs must
not be reported as warm discovery-page costs.
Child replay uses the journal session header's normalized timestamp for its
initial upsert and sticky creation-time/list ordering; only a missing header
timestamp falls back to the first branch entry. The header is separate from
branch entries, so compact discovery does not replace creation time with a later
message timestamp.

For targeted verification from the repository root (not a claim of execution):

```sh
OMP_DESKTOP_TEST_SDK_ROOT="$PWD/packages/desktop/sdk-dist/node_modules/@oh-my-pi/pi-coding-agent" node_modules/.bin/vitest run --config packages/server/vitest.config.ts packages/server/src/server/agent/providers/omp/history-subagents.test.ts packages/server/src/server/agent/providers/omp/history-mapper.test.ts
```

For native cold-history qualification, compare same-process `coldHistoryStats`
after the first small page/discovery and again after warm fetch/recovery while
the SDK session remains unloaded. A seeded catalog should need no discovery
parsing; warm deltas should show no catalog/discovery reads and journal entry
bytes matching page bytes. Keep initial indexing separate and report observed
results rather than treating these expectations as a passed native check.

Cold history, focus, attention, model metadata and resource inventory do not wake
sessions; dynamic state without a retained snapshot is explicitly unavailable.
Runtime APIs are `getAgentRuntimeResources`, `releaseAgentRuntimeResource`, and
`unloadAgentRuntime`, backed by SDK RPC `get_runtime_resources` and
`release_runtime_resource(resourceId)`. Inventory reports resource identity,
kind, ownership, optional PID, state, retention reasons, live handles and whether
release is allowed. Busy/shared resources and background dependencies reject
release; eligible explicit release permanently discards variables.

Idle unload starts considering sessions after five minutes, rechecking every
30 seconds. `agent unload` uses safe unload: inventory, persistence drain,
inventory again, then a synchronous final admission guard before disposal.
Active/admitted work, unconfirmed input, permissions, background dependencies and
retained variables/resources prevent unload. The background owner stays
`desktop:<agentId>` across rewind. `releaseRetainedEntries` is a terminal release
only after disposal, never a way to unload a still-usable session.

Ordinary `kill_agent` requests acknowledged cancellation and then applies the
same unload gates. Explicit `force:true` uses controlled target-runtime recovery:
confirmed provider-process exit and host-tool settlement are required; runtime
variables are discarded, records/history remain, and side effects are not rolled
back. Failed closure retains the visible runtime and its admission fence until
confirmed closure or recovery. Persisted handles keep the conversation's working
directory so native resume and unarchive still resolve the original storage.

The daemon and application must be deployed together for revision-aware tool
updates. Renderer budgets separately account conservative UTF-16 history bodies
(visible 24 MiB, background 32 MiB), encoded images (12 MiB), and decoded image
estimates (24 MiB); active pins can exceed them and diagnostics report that fact.
Accounting bytes, live JavaScript heap, macOS `phys_footprint`, and Windows process
commit are distinct measurements. These budgets do not enlarge mini-electron's
4 GiB compressed V8 heap cage or establish native-platform memory qualification.

## Tech Stack

- **Server**: Express, TypeScript, ws (WebSocket)
- **Client**: React 18, Vite, TypeScript
- **Terminal**: tmux (via child_process)
- **AI**: Configurable coding-agent providers

## Testing

Currently manual testing via:

1. Start servers: `npm run dev`
2. Open http://localhost:5173
3. Test WebSocket connection (green status indicator)
4. Click "Send Ping" button to test communication

More testing guidance as features are implemented.

## License

MIT
