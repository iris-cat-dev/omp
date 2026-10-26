# SSH remote hosts

The Desktop app can provision a remote daemon from **Settings → General → Add host → Connect via SSH**. It uses the system OpenSSH client, including `~/.ssh/config`, agent identities, `ProxyJump`, host-key verification, passwords, passphrases, and MFA prompts.

## Connection and security model

SSH is used only to inspect the host, upload the version-matched backend, start the daemon, and obtain its pairing offer. After pairing, SSH closes and the app connects through the configured end-to-end encrypted Relay. The remote daemon remains bound to `127.0.0.1:6770`; **do not expose that port to the Internet**.

SSH passwords, private-key passphrases, MFA responses, and pairing links are never persisted. The local management profile stores only the SSH target fields, identity-file path, remote runtime path, server ID, deployed version, and model-source choice.

See [self-hosted Web and relay deployment](deployment.md) for relay configuration, browser-facing addresses, and pairing-link precautions.

## Use models configured on this Desktop

SSH-managed hosts use **local models by default**, including saved SSH profiles created before this setting existed. Configure or sign in to models on the local host, connect the SSH host, then select a model in its remote workspace. **Host Settings → Model source** shows the connection state and links to the local model settings. The remote host's Providers page also links to those settings while local models are selected.

The execution boundary is:

- **Local machine:** model configuration, API keys, OAuth refresh/account selection, and native model inference.
- **Remote host:** the Agent loop, conversation state, files, shell commands, terminals, and tools.
- **Existing encrypted connection:** the advertised credential-free model catalog, inference context, streamed native model events, and cancellation. No provider credentials or local model endpoint URLs are copied to the server.

The local daemon starts a tool-free native OMP model worker. Both model-bridge listeners bind ephemeral loopback ports, require process-scoped bearer tokens, and expose only catalog/native inference operations; they are not public HTTP proxies. Native reasoning, tool calls, image input, and Unicode streaming do not pass through an OpenAI-format conversion. Keyless local providers (`auth: none`, such as locally configured compatible servers) remain keyless.

Keep Desktop, its local daemon, and both host connections running while using local models. Losing the source cancels forwarding and fails inference explicitly; it does not fall back to a remotely configured model or retry a disconnected source indefinitely. Remote schedules and unattended work also require the local source to remain connected. Changing sources pauses existing OMP runtimes; their conversation history is retained for resuming with the selected source.

To intentionally use a server's own credentials instead, turn off **Use models from this Desktop** in that host's settings. Manually paired hosts without an SSH management profile are unchanged. Another Desktop connection cannot take over an attached model source.

Both daemons need model-bridge support. Update an older remote daemon with **Update via SSH** when the app asks for an upgrade. The local OMP host must provide its native model-gateway APIs and the remote OMP host must support native model transport; the integration was exercised with OMP 18.11.3. The remote host still needs an OMP executable for Agent/tool execution, but needs no provider login or model API key in local-model mode.

Only enable sharing for hosts you trust: while attached, a host can submit inference to the advertised local models and consume their quota. Inference context is still sent to whichever provider you configured locally. The model gateway does not execute the remote host's tools on the local machine.

## Supported hosts and prerequisites

Supported remote targets are **glibc Linux and macOS on x64 or arm64**. Remote Windows and musl-based Linux distributions such as Alpine are not supported.

The remote account needs:

- a POSIX shell, `tar`, and either `curl` or `wget`;
- outbound HTTPS access to `nodejs.org` and the npm registry;
- write access to its home directory.

No root access is required. Managed runtime files are installed under `~/.omp-desktop/remote-runtime`, while daemon identity and state remain under `~/.omp-desktop`. OMP itself is installed separately from the paired host's settings.

## Managed releases and updates

Remote releases are staged and checksum-verified before an atomic switch. Failed starts roll back to the previous managed release.

Hosts provisioned this way update through **Host Settings → Update daemon → Update via SSH** because the workspace packages are bundled with the Desktop application rather than installed from the public npm registry. See [development](development.md#workspace-packages) for the package map and [packaging](packaging.md) for Desktop release construction.

Removing a Host from the app forgets its local SSH management profile but **does not stop or delete the remote daemon**.
