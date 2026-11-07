# Remote hosts

The Desktop app can provision a remote daemon from **Settings → General → Add host → Connect via SSH**. It uses the system OpenSSH client, including `~/.ssh/config`, agent identities, `ProxyJump`, host-key verification, passwords, passphrases, and MFA prompts.

## Connection and security model

SSH is used only to inspect the host, upload the version-matched backend, start the daemon, and obtain its pairing offer. After pairing, SSH closes and the app connects through the configured end-to-end encrypted Relay. The remote daemon remains bound to `127.0.0.1:6770`; **do not expose that port to the Internet**.

SSH passwords, private-key passphrases, MFA responses, and pairing links are never persisted. The local management profile stores only the SSH target fields, identity-file path, remote runtime path, server ID, and deployed version. Model-source choices are stored separately in the Desktop host registry.

See [self-hosted Web and relay deployment](deployment.md) for relay configuration, browser-facing addresses, and pairing-link precautions.

## Low-bandwidth connections

Updated Desktop/Web clients and daemons automatically negotiate lossless gzip
compression for large JSON messages, including history and local-model bridge
traffic. Messages are compressed before end-to-end encryption and only when
the result is smaller. Terminal and file-download binary traffic keeps its
existing format; no relay or reverse-proxy setting is required.

Update both the client and the remote daemon, then reconnect to enable
compression. Older clients, older daemons and browsers without compression
support remain usable with uncompressed messages. See the
[wire protocol](../packages/protocol/README.md#compressed-json-messages).

On a constrained connection, models configured on the remote host avoid
forwarding full inference contexts to this Desktop. Compression reduces the
transfer size when local models are needed; it does not remove the requirement
to keep this Desktop connected.

## Use models configured on this Desktop

Each connected remote host can independently use models configured on **this computer** or on **the remote host**, whether connected through SSH provisioning, manual pairing, or direct TCP. Choose the source in **Host Settings → Model source** or **Host Settings → Providers → Model source**. The choice persists across reconnections and Desktop restarts. Configure or sign in to local models on the local host; while local models are selected, the remote Providers page links to those settings.

New SSH-managed hosts use local models by default. Existing SSH choices are migrated without overriding a choice already saved in the host registry; older SSH profiles with no choice keep the local default. Manually paired and TCP hosts with no saved choice continue using remote models and do not take over another Desktop's attached source.

The execution boundary is:

- **Local machine:** model configuration, API keys, OAuth refresh/account selection, and native model inference.
- **Remote host:** the Agent loop, conversation state, files, shell commands, terminals, and tools.
- **Existing encrypted connection:** the advertised credential-free model catalog, inference context, streamed native model events, and cancellation. No provider credentials or local model endpoint URLs are copied to the server.

The local daemon starts an inference-only native OMP model worker with built-in tools disabled. It loads enabled local provider extensions, including their model catalogs, authentication, and native streaming implementations; disabled plugins remain excluded. Both model-bridge listeners bind ephemeral loopback ports, require process-scoped bearer tokens, and expose only catalog/native inference operations; they are not public HTTP proxies. Native reasoning, tool calls, image input, and Unicode streaming do not pass through an OpenAI-format conversion. Keyless local providers (`auth: none`, such as locally configured compatible servers) remain keyless.

Plugin models discovered asynchronously become usable as soon as they appear in the shared model catalog.

Keep Desktop, its local daemon, and both host connections running while using local models. Losing the source cancels forwarding and fails inference explicitly; it does not fall back to a remotely configured model or retry a disconnected source indefinitely. Remote schedules and unattended work also require the local source to remain connected. Changing sources pauses existing OMP runtimes; their conversation history is retained for resuming with the selected source.

To use the server's own models and credentials, turn off **Use models configured on this computer** in that host's settings. Another Desktop connection cannot take over an attached model source.

Both daemons need model-bridge support, and the local Desktop SDK must include the native model gateway. Update older daemons before enabling local models; SSH-managed hosts can use **Update via SSH**. SDK hosts execute the Agent loop and tools directly and require neither an OMP executable nor provider credentials in local-model mode.

Only enable sharing for hosts you trust: while attached, a host can submit inference to the advertised local models and consume their quota. Inference context is still sent to whichever provider you configured locally. The model gateway does not execute the remote host's tools on the local machine.

## Files and Changes in restored projects

Saved **Files** and **Changes** panels recover automatically after the host's workspace list finishes loading if their old workspace was removed. Recovery stays within the same host and project, preferring the focused checkout, then the project root checkout, then another available checkout. Valid bindings and panel state are retained; specific file views, path-focused diffs, commit diffs, and terminals keep their original workspace.

An empty Changes panel displaying **No uncommitted changes** means the selected checkout is clean. A missing-directory message means the panel could not resolve its workspace.

## Supported hosts and prerequisites

SSH provisioning supports macOS x64/arm64 and glibc Linux x64/arm64, independently of the Desktop machine's platform. The app selects the remote host's native SDK from the pinned public [OMP SDK Release](https://github.com/iris-cat-dev/omp-sdk/releases), verifies its SHA-256 and size, then uploads it over SSH. Remote Windows and musl-based Linux distributions such as Alpine remain unsupported.

The Desktop machine needs HTTPS access to GitHub for the first download of each pinned SDK. Downloads are cached by checksum and reverified before reuse; interrupted or corrupt downloads are not installed. A running managed backend with the same bundle hash is reused without downloading or reinstalling. The app never selects `latest` or falls back to another platform's SDK.

The SSH dialog shows SDK download progress. **Cancel** stops an active download and removes partial files.

The remote account needs:

- a POSIX shell, `tar`, and either `curl` or `wget`;
- outbound HTTPS access to `nodejs.org` and the npm registry;
- write access to its home directory.

No root access is required. Managed runtime files, including the SDK and Node 24.14.0, are installed under `~/.omp-desktop/remote-runtime`; daemon identity and state remain under `~/.omp-desktop`. No separate OMP installation is required.

## Managed releases and updates

Remote releases are staged and checksum-verified before an atomic switch. The installer runs `npm ci` for Desktop backend dependencies, then extracts the verified SDK archive with its bundled dependencies into the same staging directory. Both steps finish before stopping the current daemon or switching releases. Failed starts roll back to the previous managed release.

Hosts provisioned this way update through **Host Settings → Update daemon → Update via SSH** because the workspace packages are bundled with the Desktop application rather than installed from the public npm registry. See [development](development.md#workspace-packages) for the package map and [packaging](packaging.md) for Desktop release construction.

Removing a Host from the app forgets its local SSH management profile but **does not stop or delete the remote daemon**.
