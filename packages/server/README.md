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
