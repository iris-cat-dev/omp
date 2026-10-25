# OMP Desktop

A [mini-electron](https://github.com/iris-cat-dev/mini-electron) and Web client for [Oh My Pi](https://github.com/can1357/oh-my-pi). It runs a private daemon on your machine and talks to `omp --mode rpc-ui` through OMP's native JSONL RPC protocol. Web clients can control a remote daemon through an end-to-end encrypted relay.

Current source version: **0.5.3**. Packaged applications are available from [GitHub Releases](https://github.com/iris-cat-dev/omp-desktop/releases).

## Features

- OMP conversations with model/provider settings, approval modes, workflows, and managed subagents.
- Project workspaces with split conversations, files, Git changes, terminals, and background processes.
- Scheduled tasks and heartbeats, provider usage and quotas, native OMP tools, and plugins.
- Desktop appearance controls, wallpaper, an optional desktop pet, and image/media previews.
- SSH-managed remote hosts and Web access through a hosted or self-hosted relay.

See the [documentation index](docs/README.md) for feature guides and operational details.

## Requirements

- Node.js from [`.tool-versions`](.tool-versions) and npm workspaces for development and source builds.
- `omp >= 18.8.7` on `PATH` for development and standalone daemon runs.
- A configured OMP model provider to run conversations; provider settings and sign-in can open without one.

Standard **Apple Silicon macOS** and **Windows x64** packages include OMP and do not require a system OMP installation. A fresh Windows `no omp` installation requires `omp` on `PATH`; upgrades preserve an existing bundled runtime. See [packaging](docs/packaging.md#windows-packages-without-bundled-omp).

## Quick start

```bash
npm install
npm run dev:desktop
```

Development uses daemon address `127.0.0.1:6770` and isolated state under `.dev/omp-desktop-home`. Packaged Desktop uses `~/.omp-desktop`; OMP keeps its own configuration, credentials, and sessions under `~/.omp`.

See [development and verification](docs/development.md) for the workspace package map, dependency notes, and targeted checks.

## Build

```bash
npm run build:package          # Select macOS or Windows on the current host
npm run build:mac              # macOS arm64: DMG + ZIP; requires macOS
npm run build:windows          # Windows x64: NSIS installer + ZIP
npm run build:package -- --help
```

Installer builds default to `--publish never` and write to `packages/desktop/release/`. Platform packaging scripts live in [`scripts/packaging/`](scripts/packaging). See the [packaging guide](docs/packaging.md) for native runtime selection, signing, Windows cross-build requirements, bundled resources, and updater metadata. A successful build does not replace native application verification.

## Documentation

| Guide                                            | Contents                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| [All feature guides](docs/README.md#user-guides) | Conversations, models, usage, workspaces, files, Git, appearance, pets, tools, plugins, and media |
| [Development](docs/development.md)               | Local setup, workspace packages, runtime notes, and verification                                  |
| [Packaging](docs/packaging.md)                   | Build entry points, mini-electron, signing, installers, updates, and bundled OMP                  |
| [SSH remote hosts](docs/remote-hosts.md)         | Provisioning, pairing, managed updates, and credential handling                                   |
| [Web and relay deployment](docs/deployment.md)   | Web exports, Cloudflare Pages, self-hosting, and relay configuration                              |

## License

[AGPL-3.0-or-later](LICENSE). This project is derived from Paseo and retains its original Git history and license notices.
