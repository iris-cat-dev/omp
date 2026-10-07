import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, posix, win32 } from "node:path";

import type { OmpInstallationStatus } from "@omp-desktop/protocol/messages";

import { findExecutable } from "../../../../executable-resolution/executable-resolution.js";
import { execCommand } from "../../../../utils/spawn.js";

const OMP_REPOSITORY = "can1357/oh-my-pi";
const LATEST_RELEASE_URL = `https://github.com/${OMP_REPOSITORY}/releases/latest`;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const UPDATE_CANCELED_MESSAGE = "OMP update canceled";
const UPDATE_BUSY_MESSAGE =
  "OMP is still running. Exit OMP Desktop and restart it to finish the staged update.";

type OmpUpdatePhase = NonNullable<OmpInstallationStatus["updatePhase"]>;

interface LatestOmpRelease {
  tag: string;
  version: string;
}

interface OmpUpdateRuntimeState {
  phase: OmpUpdatePhase;
  downloadedBytes: number;
  totalBytes?: number;
}

interface ActiveOmpInstall {
  controller: AbortController;
  installPath: string;
  promise: Promise<OmpInstallationStatus>;
  state: OmpUpdateRuntimeState;
}

export interface OmpInstallOptions {
  defer?: boolean;
}

export interface OmpBinaryFileSystem {
  access(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: boolean }): Promise<void>;
}

export interface ReplaceManagedOmpBinaryOptions {
  installPath: string;
  stagedPath: string;
  previousPath: string;
  validate(path: string): Promise<void>;
  platform?: NodeJS.Platform;
  fileSystem?: OmpBinaryFileSystem;
}

let activeInstall: ActiveOmpInstall | null = null;

function parseOmpVersion(value: string): [number, number, number] | null {
  const match = /(?:^|[^\d])(\d+)\.(\d+)\.(\d+)(?:$|[^\d])/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareOmpVersions(installedVersion: string, latestVersion: string): number | null {
  const installed = parseOmpVersion(installedVersion);
  const latest = parseOmpVersion(latestVersion);
  if (!installed || !latest) return null;
  for (let index = 0; index < installed.length; index += 1) {
    const difference = installed[index]! - latest[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function resolveManagedOmpInstallPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configuredDirectory = env.PI_INSTALL_DIR?.trim();
  if (configuredDirectory) {
    return join(configuredDirectory, platform === "win32" ? "omp.exe" : "omp");
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
    return join(localAppData, "omp", "omp.exe");
  }
  return join(home, ".local", "bin", "omp");
}

type OmpRuntimeSource = NonNullable<OmpInstallationStatus["source"]>;

interface OmpRuntimeTarget {
  executablePath: string | null;
  installPath: string;
  source: OmpRuntimeSource;
}

function sameExecutablePath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalizedLeft = pathApi.resolve(left);
  const normalizedRight = pathApi.resolve(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function resolveOmpRuntimeTarget(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
  } = {},
): Promise<OmpRuntimeTarget> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const managedInstallPath = resolveManagedOmpInstallPath(platform, env, home);
  const configuredCommand = env.OMP_COMMAND?.trim();

  if (!configuredCommand) ensureManagedOmpOnPath(platform, env);
  const executablePath = await findExecutable(configuredCommand || "omp");
  const installPath = executablePath ?? configuredCommand ?? managedInstallPath;
  let source: OmpRuntimeSource;
  if (configuredCommand && env.PASEO_DESKTOP_MANAGED === "1") {
    source = "bundled";
  } else if (sameExecutablePath(installPath, managedInstallPath, platform)) {
    source = "managed";
  } else if (configuredCommand) {
    source = "configured";
  } else {
    source = "path";
  }
  return { executablePath, installPath, source };
}

function exposeNewManagedOmpOnPath(previousStatus: OmpInstallationStatus): void {
  if (!previousStatus.installed && !process.env.OMP_COMMAND?.trim()) {
    ensureManagedOmpOnPath();
  }
}

export function resolveOmpUpdatePaths(
  installPath: string,
  platform: NodeJS.Platform = process.platform,
): { stagedPath: string; checksumPath: string; previousPath: string } {
  const base =
    platform === "win32" && installPath.toLowerCase().endsWith(".exe")
      ? installPath.slice(0, -4)
      : installPath;
  const suffix = platform === "win32" ? ".exe" : "";
  const stagedPath = `${base}.next${suffix}`;
  return {
    stagedPath,
    checksumPath: `${stagedPath}.sha256`,
    previousPath: `${base}.previous${suffix}`,
  };
}

export function ensureManagedOmpOnPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const installDirectory = dirname(resolveManagedOmpInstallPath(platform, env));
  const pathKey = Object.hasOwn(env, "Path") ? "Path" : "PATH";
  const entries = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  if (!entries.includes(installDirectory)) {
    env[pathKey] = [installDirectory, ...entries].join(delimiter);
  }
}

function supportedPlatform(platform: NodeJS.Platform, arch: string): boolean {
  if (platform === "darwin" || platform === "linux") {
    return arch === "arm64" || arch === "x64";
  }
  return platform === "win32" && (arch === "x64" || arch === "arm64");
}

async function detectLinuxMusl(): Promise<boolean> {
  if (existsSync("/etc/alpine-release")) return true;
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: unknown } }
      | undefined;
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

async function resolveReleaseAssetName(platform: NodeJS.Platform, arch: string): Promise<string> {
  if (platform === "win32") return `omp-windows-${arch}.exe`;
  let target = platform === "darwin" ? "darwin" : "linux";
  if (platform === "linux" && (await detectLinuxMusl())) target = "linux-musl";
  return `omp-${target}-${arch}`;
}

async function readVersion(executablePath: string): Promise<string> {
  const result = await execCommand(executablePath, ["--version"], {
    envMode: "internal",
    timeout: 15_000,
  });
  return result.stdout.trim() || result.stderr.trim();
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchLatestOmpRelease(signal?: AbortSignal): Promise<LatestOmpRelease> {
  const response = await fetch(LATEST_RELEASE_URL, {
    method: "HEAD",
    redirect: "follow",
    headers: { "User-Agent": "OMP-Desktop" },
    signal: requestSignal(signal, 60_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to resolve the latest OMP release: HTTP ${response.status}`);
  }

  const releaseUrl = new URL(response.url);
  const tagPathPrefix = `/${OMP_REPOSITORY}/releases/tag/`;
  if (
    releaseUrl.origin !== "https://github.com" ||
    !releaseUrl.pathname.startsWith(tagPathPrefix)
  ) {
    throw new Error(`Latest OMP release resolved to an unexpected URL: ${response.url}`);
  }
  const tag = decodeURIComponent(releaseUrl.pathname.slice(tagPathPrefix.length));
  const parsedVersion = parseOmpVersion(tag);
  if (!parsedVersion) {
    throw new Error(`Latest OMP release has an invalid version tag: ${tag}`);
  }
  return { tag, version: parsedVersion.join(".") };
}

async function fetchReleaseChecksum(
  release: LatestOmpRelease,
  assetName: string,
  signal: AbortSignal,
): Promise<string> {
  const checksumUrl = `https://github.com/${OMP_REPOSITORY}/releases/download/${release.tag}/SHA256SUMS.txt`;
  const response = await fetch(checksumUrl, { signal: requestSignal(signal, 60_000) });
  if (!response.ok) {
    throw new Error(`Failed to download OMP checksums: HTTP ${response.status}`);
  }
  for (const line of (await response.text()).split(/\r?\n/)) {
    const [checksum, filename] = line.trim().split(/\s+/, 2);
    if (filename?.replace(/^\*/, "") === assetName && /^[a-f\d]{64}$/i.test(checksum ?? "")) {
      return checksum!.toLowerCase();
    }
  }
  throw new Error(`OMP checksums did not include ${assetName}`);
}

async function writeResponseToFile(
  response: Response,
  destination: string,
  state: OmpUpdateRuntimeState,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) throw new Error("OMP download returned an empty response body");
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(contentLength) && contentLength > 0) state.totalBytes = contentLength;

  const reader = response.body.getReader();
  const file = await fs.open(destination, "wx");
  const hash = createHash("sha256");
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(value, offset, value.byteLength - offset, null);
        if (bytesWritten === 0) throw new Error("OMP download stopped writing before completion");
        offset += bytesWritten;
      }
      state.downloadedBytes += value.byteLength;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    await file.close();
  }
  if (state.totalBytes !== undefined && state.downloadedBytes !== state.totalBytes) {
    throw new Error(
      `OMP download was incomplete: received ${state.downloadedBytes} of ${state.totalBytes} bytes`,
    );
  }
  return hash.digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function pathExists(path: string, fileSystem: OmpBinaryFileSystem): Promise<boolean> {
  try {
    await fileSystem.access(path);
    return true;
  } catch {
    return false;
  }
}

export function isOmpExecutableBusyError(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

export class OmpExecutableBusyError extends Error {
  constructor(options?: ErrorOptions) {
    super(UPDATE_BUSY_MESSAGE, options);
    this.name = "OmpExecutableBusyError";
  }
}

export async function replaceManagedOmpBinary(
  options: ReplaceManagedOmpBinaryOptions,
): Promise<void> {
  const fileSystem = options.fileSystem ?? fs;
  const platform = options.platform ?? process.platform;
  const hadCurrent = await pathExists(options.installPath, fileSystem);
  if (hadCurrent) await fileSystem.rm(options.previousPath, { force: true });
  const hadBackup = !hadCurrent && (await pathExists(options.previousPath, fileSystem));
  let currentMoved = false;
  let stagedMoved = false;
  try {
    if (hadCurrent) {
      await fileSystem.rename(options.installPath, options.previousPath);
      currentMoved = true;
    }
    await fileSystem.rename(options.stagedPath, options.installPath);
    stagedMoved = true;
    await options.validate(options.installPath);
  } catch (error) {
    try {
      if (stagedMoved) await fileSystem.rm(options.installPath, { force: true });
      if ((currentMoved || hadBackup) && !(await pathExists(options.installPath, fileSystem))) {
        await fileSystem.rename(options.previousPath, options.installPath);
      }
    } catch (rollbackError) {
      const aggregateError = new AggregateError(
        [error, rollbackError],
        "OMP update failed and the previous binary could not be restored",
        { cause: rollbackError },
      );
      throw aggregateError;
    }
    if (isOmpExecutableBusyError(error, platform)) {
      throw new OmpExecutableBusyError({ cause: error });
    }
    throw error;
  }
  if (currentMoved || hadBackup) {
    await fileSystem.rm(options.previousPath, { force: true }).catch(() => undefined);
  }
}

function runtimeUpdateFields(
  installPath: string,
): Pick<
  OmpInstallationStatus,
  "updatePhase" | "updateProgress" | "downloadedBytes" | "totalBytes" | "pendingUpdate"
> {
  const { stagedPath } = resolveOmpUpdatePaths(installPath);
  const state = activeInstall?.installPath === installPath ? activeInstall.state : null;
  const totalBytes = state?.totalBytes;
  return {
    ...(state
      ? {
          updatePhase: state.phase,
          updateProgress: totalBytes
            ? Math.min(100, Math.floor((state.downloadedBytes / totalBytes) * 100))
            : 0,
          downloadedBytes: state.downloadedBytes,
          ...(totalBytes ? { totalBytes } : {}),
        }
      : {}),
    ...(existsSync(stagedPath)
      ? { pendingUpdate: true, ...(state ? {} : { updatePhase: "pending-restart" as const }) }
      : {}),
  };
}

async function detectOmpInstallationStatus(
  options: { checkForUpdates?: boolean } = {},
): Promise<OmpInstallationStatus> {
  const platform = process.platform;
  const arch = process.arch;
  const target = await resolveOmpRuntimeTarget();
  const { executablePath, installPath, source } = target;
  const supported = supportedPlatform(platform, arch);
  if (!supported) {
    return {
      platform,
      arch,
      supported: false,
      installed: false,
      source,
      installPath,
      message: `OMP has no managed binary for ${platform}/${arch}`,
    };
  }
  if (!executablePath) {
    return { platform, arch, supported: true, installed: false, installPath, source };
  }
  try {
    const version = await readVersion(executablePath);
    const status: OmpInstallationStatus = {
      platform,
      arch,
      supported: true,
      installed: true,
      version,
      installPath: executablePath,
      source,
    };
    if (!options.checkForUpdates) return status;

    try {
      const latestRelease = await fetchLatestOmpRelease();
      const comparison = compareOmpVersions(version, latestRelease.version);
      if (comparison === null) {
        throw new Error(
          `Unable to compare installed OMP version "${version}" with latest version "${latestRelease.version}"`,
        );
      }
      return {
        ...status,
        latestVersion: latestRelease.version,
        updateAvailable: comparison < 0,
      };
    } catch (error) {
      return {
        ...status,
        message: `Failed to check for OMP updates: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  } catch (error) {
    if (options.checkForUpdates) throw error;
    return {
      platform,
      arch,
      supported: true,
      installed: false,
      installPath: executablePath,
      source,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getOmpInstallationStatus(
  options: { checkForUpdates?: boolean } = {},
): Promise<OmpInstallationStatus> {
  const status = await detectOmpInstallationStatus(options);
  return { ...status, ...runtimeUpdateFields(status.installPath) };
}

async function verifyStagedBinary(
  stagedPath: string,
  checksumPath: string,
  expectedVersion?: string,
): Promise<string> {
  const expectedChecksum = (await fs.readFile(checksumPath, "utf8")).trim().toLowerCase();
  if (!/^[a-f\d]{64}$/.test(expectedChecksum)) {
    throw new Error("Staged OMP checksum is invalid");
  }
  const actualChecksum = await sha256File(stagedPath);
  if (actualChecksum !== expectedChecksum) {
    throw new Error("Staged OMP binary failed SHA-256 verification");
  }
  const version = await readVersion(stagedPath);
  if (expectedVersion && compareOmpVersions(version, expectedVersion) !== 0) {
    throw new Error(`Downloaded OMP version "${version}" did not match "${expectedVersion}"`);
  }
  return version;
}

export async function applyPendingOmpUpdate(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
  } = {},
): Promise<{
  applied: boolean;
  pending: boolean;
  message?: string;
}> {
  const platform = options.platform ?? process.platform;
  const target = await resolveOmpRuntimeTarget(options);
  const installPath = target.installPath;
  const { stagedPath, checksumPath, previousPath } = resolveOmpUpdatePaths(installPath, platform);
  if (!existsSync(stagedPath)) return { applied: false, pending: false };
  try {
    await verifyStagedBinary(stagedPath, checksumPath);
    await replaceManagedOmpBinary({
      installPath,
      stagedPath,
      previousPath,
      validate: async (path) => {
        await readVersion(path);
      },
      platform,
    });
    await fs.rm(checksumPath, { force: true }).catch(() => undefined);
    return { applied: true, pending: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { applied: false, pending: existsSync(stagedPath), message };
  }
}

async function runOmpInstall(
  options: OmpInstallOptions,
  controller: AbortController,
  state: OmpUpdateRuntimeState,
): Promise<OmpInstallationStatus> {
  const status = await detectOmpInstallationStatus();
  if (activeInstall?.state === state) activeInstall.installPath = status.installPath;
  if (!status.supported) return status;

  const installPath = status.installPath;
  const { stagedPath, checksumPath, previousPath } = resolveOmpUpdatePaths(installPath);
  const release = await fetchLatestOmpRelease(controller.signal);
  const assetName = await resolveReleaseAssetName(process.platform, process.arch);
  const downloadUrl = `https://github.com/${OMP_REPOSITORY}/releases/download/${release.tag}/${assetName}`;
  const temporaryPath = `${stagedPath}.${process.pid}.${randomUUID()}.download${process.platform === "win32" ? ".exe" : ""}`;
  await fs.mkdir(dirname(installPath), { recursive: true });

  try {
    state.phase = "downloading";
    const expectedChecksum = await fetchReleaseChecksum(release, assetName, controller.signal);
    const response = await fetch(downloadUrl, {
      signal: requestSignal(controller.signal, DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Failed to download ${assetName}: HTTP ${response.status}`);
    }
    const actualChecksum = await writeResponseToFile(
      response,
      temporaryPath,
      state,
      controller.signal,
    );
    if (actualChecksum !== expectedChecksum) {
      throw new Error(`Downloaded ${assetName} failed SHA-256 verification`);
    }
    controller.signal.throwIfAborted();

    state.phase = "verifying";
    if (process.platform !== "win32") await fs.chmod(temporaryPath, 0o755);
    const downloadedVersion = await readVersion(temporaryPath);
    controller.signal.throwIfAborted();
    if (compareOmpVersions(downloadedVersion, release.version) !== 0) {
      throw new Error(
        `Downloaded OMP version "${downloadedVersion}" did not match "${release.version}"`,
      );
    }
    await fs.rm(stagedPath, { force: true });
    await fs.rm(checksumPath, { force: true });
    await fs.rename(temporaryPath, stagedPath);
    await fs.writeFile(checksumPath, `${expectedChecksum}\n`, { mode: 0o600 });

    if (options.defer) {
      return {
        ...status,
        latestVersion: release.version,
        updateAvailable: true,
        updatePhase: "pending-restart",
        updateProgress: 100,
        downloadedBytes: state.downloadedBytes,
        ...(state.totalBytes ? { totalBytes: state.totalBytes } : {}),
        pendingUpdate: true,
      };
    }

    state.phase = "installing";
    try {
      await replaceManagedOmpBinary({
        installPath,
        stagedPath,
        previousPath,
        validate: async (path) => {
          const installedVersion = await readVersion(path);
          if (compareOmpVersions(installedVersion, release.version) !== 0) {
            throw new Error(
              `Installed OMP version "${installedVersion}" did not match "${release.version}"`,
            );
          }
        },
      });
    } catch (error) {
      if (error instanceof OmpExecutableBusyError) {
        return {
          ...status,
          latestVersion: release.version,
          updateAvailable: true,
          updatePhase: "waiting-for-agents",
          updateProgress: 100,
          pendingUpdate: true,
          message: error.message,
        };
      }
      throw error;
    }
    await fs.rm(checksumPath, { force: true }).catch(() => undefined);

    exposeNewManagedOmpOnPath(status);
    const installed = await detectOmpInstallationStatus();
    if (!installed.installed) {
      throw new Error(
        installed.message ?? "OMP installation completed but the binary is unavailable",
      );
    }
    return {
      ...installed,
      latestVersion: release.version,
      updateAvailable: false,
      updatePhase: "complete",
      updateProgress: 100,
      pendingUpdate: false,
    };
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    if (controller.signal.aborted) {
      return {
        ...status,
        latestVersion: release.version,
        updatePhase: "canceled",
        message: UPDATE_CANCELED_MESSAGE,
      };
    }
    if (isOmpExecutableBusyError(error)) {
      throw new OmpExecutableBusyError({ cause: error });
    }
    throw error;
  }
}

export function installOmp(options: OmpInstallOptions = {}): Promise<OmpInstallationStatus> {
  if (activeInstall) return activeInstall.promise;

  const controller = new AbortController();
  const state: OmpUpdateRuntimeState = { phase: "downloading", downloadedBytes: 0 };
  const installPath = process.env.OMP_COMMAND?.trim() || resolveManagedOmpInstallPath();
  const operation = {} as ActiveOmpInstall;
  const promise = Promise.resolve()
    .then(() => runOmpInstall(options, controller, state))
    .catch(async (error: unknown) => {
      if (!controller.signal.aborted) throw error;
      return {
        ...(await detectOmpInstallationStatus()),
        updatePhase: "canceled" as const,
        message: UPDATE_CANCELED_MESSAGE,
      };
    })
    .finally(() => {
      if (activeInstall === operation) activeInstall = null;
    });
  Object.assign(operation, { controller, installPath, promise, state });
  activeInstall = operation;
  return promise;
}

export async function cancelOmpInstall(): Promise<OmpInstallationStatus> {
  const operation = activeInstall;
  if (!operation) {
    return {
      ...(await detectOmpInstallationStatus()),
      message: "No OMP update is in progress",
    };
  }
  operation.controller.abort(new Error(UPDATE_CANCELED_MESSAGE));
  return await operation.promise;
}
