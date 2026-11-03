import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { app, net } from "electron";
import { parseConnectionOfferFromUrl } from "@omp-desktop/protocol/connection-offer";
import { buildRemoteInstallScript } from "./bootstrap-script.js";
import {
  loadRemoteBackendManifest,
  selectRemoteBackendBundle,
  type RemoteBackendBundle,
  type RemoteBackendFile,
} from "./bundle.js";
import { SshPtySession, type SshPtySessionOptions } from "./pty-session.js";
import { downloadRemoteSdk } from "./sdk-download.js";
import { parseRemoteTargetInfo, type RemoteTargetInfo } from "./target.js";
import type { RemoteSshDeployResult, RemoteSshEvent, RemoteSshStartInput } from "./types.js";
const INSTALL_TIMEOUT_MS = 15 * 60_000;

export interface RemoteSshSession {
  writeInput(input: string): void;
  close(): void;
  waitForLine(marker: string, timeoutMs?: number): Promise<string>;
  finishAuthentication(): void;
  executeCommand(command: string): Promise<string>;
  writeCommand(command: string): void;
  uploadFile(remotePath: string, source: Buffer | Readable, expectedHash: string): Promise<void>;
}

export interface RemoteSshDeploymentOptions {
  bundleDirectory?: string;
  cacheDirectory?: string;
  fetch?: typeof globalThis.fetch;
  createSession?: (options: SshPtySessionOptions) => RemoteSshSession;
}

function resolveBundleDirectory(): string {
  if (process.env.PASEO_REMOTE_BACKEND_DIR?.trim()) {
    return path.resolve(process.env.PASEO_REMOTE_BACKEND_DIR.trim());
  }
  return app.isPackaged
    ? path.join(process.resourcesPath, "remote-backend")
    : path.resolve(__dirname, "..", "..", "..", "remote-backend-dist");
}

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseRemotePairingResult(
  encodedResult: string,
  expectedServerId?: string,
): { offerUrl: string; hostname: string } {
  const [encodedPair, encodedHostname] = encodedResult.trim().split("|");
  if (!encodedPair || !encodedHostname) throw new Error("Remote pairing result was incomplete");
  const pairing = JSON.parse(decodeBase64(encodedPair)) as { url?: unknown };
  if (typeof pairing.url !== "string") throw new Error("Remote pairing result has no URL");
  const offer = parseConnectionOfferFromUrl(pairing.url);
  if (!offer) throw new Error("Remote pairing URL has no offer");
  if (expectedServerId && offer.serverId !== expectedServerId) {
    throw new Error("The SSH target returned a different server ID than the managed host");
  }
  return { offerUrl: pairing.url, hostname: decodeBase64(encodedHostname) };
}


export class RemoteSshDeployment {
  private session: RemoteSshSession | null = null;
  private readonly abortController = new AbortController();

  constructor(
    private readonly input: RemoteSshStartInput,
    private readonly emit: (event: RemoteSshEvent) => void,
    private readonly options: RemoteSshDeploymentOptions = {},
  ) {}

  writeInput(input: string): void {
    this.session?.writeInput(input);
  }

  cancel(): void {
    this.abortController.abort(new Error("SSH deployment was cancelled"));
    this.session?.close();
  }

  async run(): Promise<RemoteSshDeployResult> {
    const operationId = this.input.operationId;
    const token = operationId.replaceAll("-", "");
    const readyMarker = `__OMP_READY_${token}__`;
    this.emit({ operationId, type: "phase", phase: "connecting", message: "Connecting with SSH" });
    this.emit({ operationId, type: "interactive", enabled: true });

    try {
      this.assertNotCancelled();
      const bootstrapCommand = `stty -echo; umask 077; OMP_ROOT="$HOME/.omp-desktop/remote-runtime"; OMP_UPLOAD="$OMP_ROOT/uploads/${token}"; export OMP_ROOT OMP_UPLOAD; printf '\\n__OMP_READY_%s__%s|%s|%s|%s\\n' '${token}' "$(uname -s)" "$(uname -m)" "$(printf '%s' "$HOME" | base64 | tr -d '\\n')" "$(if [ "$(uname -s)" = Linux ]; then getconf GNU_LIBC_VERSION 2>/dev/null || printf unknown; else printf none; fi)"; exec /bin/sh -i`;
      const manifest = await loadRemoteBackendManifest(this.options.bundleDirectory ?? resolveBundleDirectory());
      this.assertNotCancelled();
      const createSession = this.options.createSession ?? ((options) => new SshPtySession(options));
      this.session = createSession({
        target: this.input.target,
        remoteCommand: bootstrapCommand,
        onTerminal: (data) => this.emit({ operationId, type: "terminal", data }),
      });
      const ready = this.session.waitForLine(readyMarker, 120_000);
      const target = parseRemoteTargetInfo(await ready);
      this.session.finishAuthentication();
      this.emit({ operationId, type: "interactive", enabled: false });
      this.emit({
        operationId,
        type: "phase",
        phase: "inspecting",
        message: `Remote host: ${target.platform}-${target.arch}`,
      });
      const bundle = await selectRemoteBackendBundle(manifest, `${target.platform}-${target.arch}`);
      this.assertNotCancelled();

      const reused = await this.tryReuseDeployment(bundle, target);
      if (reused) return reused;

      this.emit({ operationId, type: "phase", phase: "downloading", message: `Downloading the pinned remote SDK for ${bundle.target}` });
      const sdkPath = await downloadRemoteSdk(bundle.sdk, {
        cacheDirectory: this.options.cacheDirectory ?? path.join(app.getPath("userData"), "remote-sdk-cache"),
        fetch: this.options.fetch ?? net.fetch.bind(net),
        signal: this.abortController.signal,
        onProgress: (progress) => this.emit({ operationId, type: "phase", phase: "downloading", message: `Downloading the pinned remote SDK (${progress}%)`, progress }),
      });
      this.assertNotCancelled();

      const installScript = Buffer.from(
        buildRemoteInstallScript({
          token,
          backendVersion: bundle.backendVersion,
          nodeVersion: bundle.nodeVersion,
          bundleHash: bundle.bundleHash,
          relayAddress: this.input.relayAddress,
        }),
        "utf8",
      );
      const uploadFiles: RemoteBackendFile[] = [
        ...bundle.files,
        { relativePath: "packages/omp-sdk.tgz", source: sdkPath, size: bundle.sdk.size, sha256: bundle.sdk.sha256 },
        { relativePath: "install.sh", source: installScript, size: installScript.byteLength, sha256: createHash("sha256").update(installScript).digest("hex") },
      ];
      const totalBytes = uploadFiles.reduce((total, file) => total + file.size, 0);
      let completedBytes = 0;
      let lastProgress = -5;
      const reportProgress = (chunkBytes: number): void => {
        completedBytes += chunkBytes;
        const progress = Math.floor((completedBytes / totalBytes) * 100);
        if (progress < lastProgress + 5 && progress !== 100) return;
        lastProgress = progress;
        this.emit({
          operationId,
          type: "phase",
          phase: "uploading",
          message: `Uploading verified backend bundle (${progress}%)`,
          progress,
        });
      };
      reportProgress(0);
      const uploadRoot = path.posix.join(
        target.home,
        ".omp-desktop",
        "remote-runtime",
        "uploads",
        token,
      );
      for (const file of uploadFiles) {
        this.assertNotCancelled();
        await this.uploadFile(file, uploadRoot, reportProgress);
      }

      this.emit({
        operationId,
        type: "phase",
        phase: "preparing-runtime",
        message: `Preparing managed Node.js ${bundle.nodeVersion}`,
      });
      const installingMarker = `__OMP_PHASE_${token}__installing`;
      const startingMarker = `__OMP_PHASE_${token}__starting`;
      const pairingMarker = `__OMP_PHASE_${token}__pairing`;
      const resultMarker = `__OMP_RESULT_${token}__`;
      const errorMarker = `__OMP_ERROR_${token}__`;
      const errorResult = this.session
        .waitForLine(errorMarker, INSTALL_TIMEOUT_MS)
        .then((encoded) => {
          throw new Error(decodeBase64(encoded));
        });
      const waitForPhase = async (
        marker: string,
        phase: "installing" | "starting" | "pairing",
        message: string,
      ): Promise<void> => {
        await Promise.race([this.session!.waitForLine(marker, INSTALL_TIMEOUT_MS), errorResult]);
        this.emit({ operationId, type: "phase", phase, message });
      };
      const result = this.session.waitForLine(resultMarker, INSTALL_TIMEOUT_MS);
      this.session.writeCommand(`sh "$OMP_UPLOAD/install.sh"`);
      await waitForPhase(installingMarker, "installing", "Installing backend dependencies");
      await waitForPhase(startingMarker, "starting", "Starting the remote daemon");
      await waitForPhase(pairingMarker, "pairing", "Generating the encrypted pairing offer");
      const encodedResult = await Promise.race([result, errorResult]);
      const paired = parseRemotePairingResult(encodedResult, this.input.expectedServerId);
      this.emit({ operationId, type: "phase", phase: "complete", message: "Remote daemon ready" });
      return this.buildResult(bundle, target, paired);
    } catch (error) {
      const message = this.abortController.signal.aborted
        ? "SSH deployment was cancelled"
        : error instanceof Error ? error.message : String(error);
      this.emit({ operationId, type: "failed", message });
      throw this.abortController.signal.aborted ? new Error(message, { cause: error }) : error;
    } finally {
      this.session?.close();
      this.session = null;
    }
  }

  private async tryReuseDeployment(
    bundle: RemoteBackendBundle,
    target: RemoteTargetInfo,
  ): Promise<RemoteSshDeployResult | null> {
    const session = this.session;
    if (!session) throw new Error("SSH session is unavailable");
    const runtimeRoot = path.posix.join(target.home, ".omp-desktop", "remote-runtime");
    const paseoHome = path.posix.join(target.home, ".omp-desktop");
    const relayArguments = this.input.relayAddress
      ? `--relay-address ${shellQuote(this.input.relayAddress)}`
      : "";
    const metadataCheck =
      "const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.exit(x.bundleHash===process.argv[2]&&x.nodeVersion===process.argv[3]?0:1)";
    const compactPairing =
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);process.stdout.write(JSON.stringify({url:x.url}))})";
    const command = `RUNTIME_ROOT=${shellQuote(runtimeRoot)}; CURRENT="$RUNTIME_ROOT/current"; MANAGED="$RUNTIME_ROOT/managed.json"; NODE="$RUNTIME_ROOT/node/v${bundle.nodeVersion}/bin/node"; CLI="$CURRENT/node_modules/@omp-desktop/cli/bin/omp-desktop"; [ -f "$MANAGED" ] && [ -x "$NODE" ] && [ -f "$CLI" ] || exit 20; "$NODE" -e ${shellQuote(metadataCheck)} "$MANAGED" ${shellQuote(bundle.bundleHash)} ${shellQuote(bundle.nodeVersion)} || exit 21; running_pid=$("$NODE" -e "try{const x=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));if(Number.isInteger(x.pid))process.stdout.write(String(x.pid))}catch{}" ${shellQuote(path.posix.join(paseoHome, "omp-desktop.pid"))}); [ -n "$running_pid" ] && kill -0 "$running_pid" 2>/dev/null || exit 22; pair_json=$(PATH="$RUNTIME_ROOT/node/v${bundle.nodeVersion}/bin:$PATH" "$NODE" "$CLI" daemon pair --home ${shellQuote(paseoHome)} --relay ${relayArguments} --json 2>/dev/null) || exit 23; pair_json=$(printf '%s' "$pair_json" | "$NODE" -e ${shellQuote(compactPairing)}) || exit 24; encoded_pair=$(printf '%s' "$pair_json" | base64 | tr -d '\\n'); hostname_value=$(hostname 2>/dev/null || uname -n); encoded_hostname=$(printf '%s' "$hostname_value" | base64 | tr -d '\\n'); printf '%s|%s\\n' "$encoded_pair" "$encoded_hostname"`;
    try {
      const encodedResult = await session.executeCommand(command);
      const paired = parseRemotePairingResult(encodedResult, this.input.expectedServerId);
      this.emit({
        operationId: this.input.operationId,
        type: "phase",
        phase: "pairing",
        message: "Reusing the matching remote backend",
      });
      this.emit({
        operationId: this.input.operationId,
        type: "phase",
        phase: "complete",
        message: "Remote daemon ready",
      });
      return this.buildResult(bundle, target, paired);
    } catch {
      this.assertNotCancelled();
      return null;
    }
  }

  private buildResult(
    bundle: RemoteBackendBundle,
    target: RemoteTargetInfo,
    paired: { offerUrl: string; hostname: string },
  ): RemoteSshDeployResult {
    return {
      operationId: this.input.operationId,
      offerUrl: paired.offerUrl,
      hostname: paired.hostname,
      platform: target.platform,
      arch: target.arch,
      runtimeRoot: path.posix.join(target.home, ".omp-desktop", "remote-runtime"),
      deployedVersion: bundle.backendVersion,
      target: this.input.target,
    };
  }

  private assertNotCancelled(): void {
    this.abortController.signal.throwIfAborted();
  }

  private async uploadFile(
    file: RemoteBackendFile,
    uploadRoot: string,
    onProgress: (chunkBytes: number) => void,
  ): Promise<void> {
    const session = this.session;
    if (!session) throw new Error("SSH session is unavailable");
    const relativePath = file.relativePath.replaceAll("\\", "/");
    if (relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
      throw new Error(`Unsafe deployment path: ${relativePath}`);
    }
    const remotePath = path.posix.join(uploadRoot, relativePath);
    const source = typeof file.source === "string"
      ? createReadStream(file.source, { signal: this.abortController.signal })
      : file.source;
    await session.uploadFile(remotePath, source, file.sha256);
    onProgress(file.size);
  }
}
