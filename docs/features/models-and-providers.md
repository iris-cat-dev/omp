# Models and providers

Configure host-scoped providers, select models and reasoning settings, and manage the OMP runtime. Quotas, account balances, and reset actions are covered in [Usage and quotas](usage-and-quotas.md).

## Contents

- [Getting started and host scope](#getting-started-and-host-scope)
- [Custom provider names](#custom-provider-names)
- [Catalog refresh and sign-in](#catalog-refresh-and-sign-in)
- [Thinking and Fast settings](#thinking-and-fast-settings)
- [Subagent model overrides](#subagent-model-overrides)
- [Runtime updates and command shortcut](#runtime-updates-and-command-shortcut)

## Getting started and host scope

A configured OMP model provider is required to run conversations, but not to open provider settings or start sign-in. **Configure models** on the home screen opens **Host Settings → Model providers** for the local host when available, otherwise the first configured host. With no configured host it starts the add-host flow.

Fresh configurations can list built-in sign-in providers without API keys or custom providers. If OMP exits with `No models available` or `No default model selected`, Desktop retries RPC startup with an internal keyless bootstrap model while preserving existing provider settings and YAML comments. That hidden entry is excluded from provider settings, the YAML editor, and selectable catalogs; it cannot run conversations.

Providers, credentials, and model catalogs are shared by all projects and conversations on a host through its active OMP configuration/profile. New conversations and project switches reuse that catalog instead of loading an empty project-specific list. The project working directory determines execution location, not provider scope. Different hosts have separate catalogs.

On touch/compact interfaces, **Settings → Providers** for the selected host manages models, sign-in accounts, and connection state. App-level **Settings → Chat behavior** holds conversation defaults; host projects and providers remain host-scoped. Relay and pairing controls are under host connections/Connections, not provider settings; see [Remote hosts](../remote-hosts.md).

### Official account numbers

Official providers assign OAuth accounts stable, provider-local display numbers. Deleting an account releases its number; the next account takes the smallest free positive number. Other accounts retain numbers through reordering and daemon restarts. Settings, account selectors, and usage cards use these when no name or note exists.

These numbers are separate from OMP's globally increasing credential IDs. Their mapping lives in `agent.db` without renumbering credentials or changing notes, provider configuration, or session references. Disabled credential records stay disabled; a freed display number does not reactivate or reuse a credential.

## Custom provider names

**Add custom provider** asks for a display name rather than a technical provider ID. Names support Chinese and other languages, spaces, and punctuation. Desktop generates a stable internal ID automatically; **Edit** shows it as read-only information and lets you change the name at any time.

Settings, model-picker provider groups, and model search use the display name. Renaming refreshes the catalog without changing provider/model IDs, selected models, conversation references, credentials, or profile references. Different providers may share a display name; their internal IDs remain distinct.

Names are stored as `providers.<id>.name` in the host's native `models.yml`. Existing entries without a name keep their previous display fallback; opening **Edit** prefills the old ID as the name so you can replace it without recreating the provider. The editor preserves additional provider/model configuration such as custom headers and model pricing.

## Catalog refresh and sign-in

Updating OMP, saving provider configuration, or signing in/out refreshes the affected provider's global catalog. Open clients receive the refreshed result, or a terminal unavailable/error state, without reopening a picker or reloading the application.

Browser OAuth refreshes catalogs as soon as OMP confirms authorization, closes sign-in, and updates signed-in state; **Complete sign-in** need not be pressed again. Providers requesting an OAuth code or redirect URL still accept manual completion. Refresh never changes an existing conversation's selected model.

Official Codex OAuth accepts dynamic models only from the dedicated Codex catalog and requires Codex capability metadata per entry. Credentials are never sent to the generic ChatGPT model catalog as a fallback. Temporary failure, invalid JSON, or non-Codex responses preserve the last validated catalog or OMP's built-in models and reasoning options. When upgrading from affected older versions, legacy Codex cache entries whose endpoint/protocol cannot be proven are removed; credentials, other provider caches, and conversation settings are untouched.

## Thinking and Fast settings

Desktop model pickers open above or below their selector according to available space and constrain height so search and the scrollable list stay inside the window. Scroll or search for any available model, including in small windows. The list and its **Thinking**, **Fast**, and **Context window** footer retain opaque theme-matched backing over wallpaper.

Changing Thinking in an existing conversation updates OMP without restarting. It applies from the next model request, including after a tool call in the same turn, never to generation already in progress. Confirmed changes add a localized inline notice showing the level and effective timing. Failed requests and reselecting the same level add no notice. Notices retain their selected level through history replay and client reload.

Confirmed Fast changes add system notices too. Model switches show the selected model ID only after a conversation has received a user message; selecting a model for a draft adds none. These notices use centered muted text, an information icon, and separator lines, not chat bubbles. They persist in history and are not sent to the model. Failed requests, unchanged settings, and initial preferences produce no switch notices.

Hover **Fast** for its cost explanation, localized in all nine supported locales.

### Claude Fast mode

Fast supports direct Anthropic **Claude Opus 4.8, Opus 5, and Opus 5.5** using native `set_fast_mode` RPC, `speed: "fast"`, and the `fast-mode-2026-02-01` beta header. It is not approximated with prompts or thinking changes.

The switch is hidden for older Opus models, Sonnet, Haiku, third-party Claude providers (including Bedrock, Vertex, and OpenRouter), and runtimes without the RPC. Switching models rereads the runtime's per-family state before applying saved preference. New/resumed conversations use the same feature preference as the OpenAI Fast switch; without a preference, Desktop does not enable it automatically.

Fast costs more and requires Anthropic fast-mode access. Claude subscribers need usage credits; it is not included in subscription limits. The switch requests Fast, not guaranteed eligibility or speed: OMP and Anthropic manage rejection, capacity, and fallback. See [Anthropic availability and pricing](https://platform.claude.com/docs/en/build-with-claude/fast-mode) and [Claude subscription requirements](https://code.claude.com/docs/en/fast-mode#requirements).

## Subagent model overrides

In **Host Settings → OMP subagents**, enable **Override built-in subagent models** and select each built-in agent's model. Supported **Thinking** levels appear; **Fast** appears only when the host's capability probe confirms it. Unsupported controls are hidden. **OMP default** leaves native thinking/service-tier policy unchanged, and a manually configured tier is displayed rather than interpreted as explicit Fast-off. Fast may increase provider charges.

Changes are saved in OMP's user configuration and apply to newly spawned task/eval subagents, even from an already running conversation, not existing children. Thinking uses native selector suffixes such as `provider/model:high`; Fast writes `priority` or `none` to that agent's `task.agentServiceTierOverrides`.

Choosing inheritance clears the agent's model and Fast overrides. Disabling the section removes the model mapping and bundled agents' Fast overrides while preserving custom agents' tiers and unrelated settings.

## Runtime updates and command shortcut

**Host Settings → Agents** reports the version, source, and path of the exact OMP executable used for Agent sessions. Update checks/installations target that same binary. Packaged apps distinguish bundled runtimes from standalone, configured, and `PATH` installations.

Runtime update checks, checksum requests, binary downloads, and release-asset redirects use the enabled OMP `PI_PROXY`, including authenticated HTTP CONNECT proxies. An unset/disabled proxy means direct downloads; no routing or DNS changes are needed. Download timeouts, cancellation, progress, SHA-256 verification, and staged replacement still apply. The [private plugin distribution](tools-and-plugins.md#private-windows-three-plugin-distribution) has stricter update ownership and does not permit generic runtime replacement.

**Settings → General → Integrations → OMP command shortcut** installs a managed launcher for the bundled runtime and current proxy configuration. Status checks compare launcher size before reading; ownership checks read only a bounded script header instead of loading a standalone binary as text. Install/uninstall never overwrite or remove commands Desktop does not own.

Standard Apple Silicon macOS and Windows x64 packages include OMP, without requiring a system installation. Windows `no omp` installers preserve an existing bundled runtime on upgrade; fresh installations need `omp` on `PATH`. See [Packaging](../packaging.md) and [Development](../development.md).
