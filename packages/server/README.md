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

Old history retains its sequence numbers but shares superseded tool payloads.
Fork-visible summaries and task logs use detached text-edit checkpoints at
canonical row boundaries, preserving earlier fork context without retaining each
full historical log. Ordinary timeline fetches omit these internal checkpoints.
Oversized shell/plain-text content is copied after truncation so a short V8
sliced string cannot retain the full original output.

The daemon and application must be deployed together for revision-aware tool
updates. These changes do not enlarge mini-electron's compressed V8 heap cage;
larger Node-only heaps require a separate engine architecture decision.

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
