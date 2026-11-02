# OMP Desktop

A [mini-electron](https://github.com/iris-cat-dev/mini-electron) and Web client for [Oh My Pi](https://github.com/can1357/oh-my-pi). It runs a private daemon on your machine and talks to `omp --mode rpc-ui` through OMP's native JSONL RPC protocol. Web clients can control a remote daemon through an end-to-end encrypted relay.

Current source version: **0.5.3**. Packaged applications are available from [GitHub Releases](https://github.com/iris-cat-dev/omp-desktop/releases).

## Features

- OMP conversations with model/provider settings, approval modes, workflows, and managed subagents.
- Project workspaces with split conversations, files, Git changes, terminals, and background processes.
- Scheduled tasks and heartbeats, provider usage and quotas, native OMP tools, and plugins.
- Desktop appearance controls, wallpaper, an optional desktop pet, and image/media previews.
- SSH-managed remote hosts that can use locally configured models without copying credentials, plus Web access through a hosted or self-hosted relay.

See the [documentation index](docs/README.md) for feature guides and operational details.

## Requirements

- Node.js 24+ from [`.tool-versions`](.tool-versions), npm, Bun, Rustup, and a native compiler toolchain for source builds.
- The pinned `omp-sdk/` submodule, initialized recursively. Development and packages use its Node SDK, not a system OMP executable.
- A configured OMP model provider to run conversations; provider settings and sign-in can open without one.

Standard **Apple Silicon macOS** and **Windows x64** packages include the SDK and embedded Node. No external Node, Bun, or OMP installation is required at runtime. See [packaging](docs/packaging.md#bundled-omp-sdk).

## Quick start

```bash
git submodule update --init --recursive
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

Installer builds default to `--publish never` and write to `packages/desktop/release/`. Platform scripts live in [`scripts/packaging/`](scripts/packaging). SDK compilation remains target-native. **Package release** builds the Windows SDK on Windows, then packages Windows installers on Mac; local Mac builds use its extracted `OMP-SDK-win32-x64` artifact via `OMP_DESKTOP_SDK_ARTIFACT`. See [packaging](docs/packaging.md#mac-to-windows-packaging) for the download/build commands, runtime selection, signing, and updater metadata. A successful build does not replace native application verification.

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
