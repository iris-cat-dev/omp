# Documentation

[Project overview and quick start](../README.md)

## User guides

| Guide                                                          | Topics                                                                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Conversations and automation](features/conversations.md) | Conversation lifecycle, workflows, approvals, steering, subagents, queues, and background work |
| [Models and providers](features/models-and-providers.md)       | Provider setup, model catalogs, account management, thinking levels, and Fast mode                        |
| [Usage and quotas](features/usage-and-quotas.md)               | Native OMP statistics, provider subscriptions, quota windows, resets, and credits                         |
| [Workspaces, files, and Git](features/workspaces-files-git.md) | Projects, tabs, split panes, file operations, editor shortcuts, and Git changes                           |
| [Appearance and input](features/appearance.md) | Language, themes, window layout, display preferences, and touch/hybrid input |
| [Tools and plugins](features/tools-and-plugins.md)             | OMP tools, browser/computer use, image generation, plugins, and SDK distribution compatibility            |
| [Messages and media](features/messages-and-media.md)           | Markdown, links, math, tool activity, image previews, saving images, and touch input                      |

## Plugin guides

Plugin-specific usage, configuration, business rules, resources, troubleshooting, and qualification belong to the [plugin repository](https://github.com/iris-cat-dev/omp-plugins), under each package directory. Host guides retain shared SDK interfaces, installation/trust, lifecycle, and packaging/deployment contracts.

- [QQ connection](https://github.com/iris-cat-dev/omp-plugins/blob/main/qqbot/README.md)
- [Schedules](https://github.com/iris-cat-dev/omp-plugins/blob/main/schedules/README.md)
- [Desktop pet](https://github.com/iris-cat-dev/omp-plugins/blob/main/desktop-pet/README.md)
- [Wallpaper](https://github.com/iris-cat-dev/omp-plugins/blob/main/wallpaper/README.md)
- [Agent Speed](https://github.com/iris-cat-dev/omp-plugins/blob/main/agent-speed/README.md)
- [Infinite Canvas](https://github.com/iris-cat-dev/omp-plugins/blob/main/blueprint-canvas/README.md)
- [Ask notifier](https://github.com/iris-cat-dev/omp-plugins/blob/main/ask-notifier/README.md)

## Development and operations

| Guide                                                                   | Topics                                                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [Development](development.md)                                           | Local setup, development state, workspace packages, runtime notes, and verification                                                   |
| [Packaging](packaging.md)                                               | Build commands, packaging scripts, mini-electron runtimes, signing, installers, updates, and bundled resources                        |
| [SSH remote hosts](remote-hosts.md)                                     | Provisioning, pairing, managed updates, supported targets, and credential handling                                                    |
| [Web and relay deployment](deployment.md)                               | Web exports, Cloudflare Pages, self-hosted relay configuration, and network boundaries                                                |
| [Agent and harness benchmarks](agent-harness-benchmarks.md)             | Benchmark selection, OMP integration, controlled comparisons, and the next evaluation run                                             |
| [Unified Desktop plugin system design](desktop-plugin-system-design.md) | Shared manager, trust, lifecycle, SDK/native compatibility, distribution boundaries, and historical host verification |
| [Upstream sync and migration](upstream/README.md)                       | Upstream `can1357/oh-my-pi` analyses, selectively ported commits, and preserved fork contracts                                        |

Commands in these guides run from the repository root unless a section says otherwise.
Keep detailed host feature and operational notes in the relevant guide; keep plugin business documentation in its package. The root README is the project entry point.
