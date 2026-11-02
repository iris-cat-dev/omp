import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const TargetSchema = z.enum(["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]);
const SdkAssetSchema = z.object({
  url: z.url(),
  sha256: HashSchema,
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const ManifestSchema = z.object({
  schemaVersion: z.literal(2),
  backendVersion: z.string().min(1),
  nodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  sdk: z.object({
    packageName: z.literal("@oh-my-pi/pi-coding-agent"),
    version: z.string().min(1),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    releaseTag: z.string().min(1),
    buildTarget: z.enum(["desktop", "generic"]),
    profile: z.enum(["core", "full"]),
  }).strict(),
  files: z.object({
    "packages/highlight.tgz": HashSchema,
    "packages/protocol.tgz": HashSchema,
    "packages/relay.tgz": HashSchema,
    "packages/client.tgz": HashSchema,
    "packages/server.tgz": HashSchema,
    "packages/cli.tgz": HashSchema,
  }).strict(),
  targets: z.record(TargetSchema, z.object({
    bundleHash: HashSchema,
    sdk: SdkAssetSchema,
    files: z.object({
      "package.json": HashSchema,
      "package-lock.json": HashSchema,
    }).strict(),
  }).strict()),
}).strict().superRefine((manifest, context) => {
  for (const [target, entry] of Object.entries(manifest.targets)) {
    const asset = `omp-sdk-${manifest.sdk.buildTarget}-${manifest.sdk.profile}-${target}.tgz`;
    const expectedUrl = `https://github.com/${manifest.sdk.repository}/releases/download/${encodeURIComponent(manifest.sdk.releaseTag)}/${asset}`;
    if (entry.sdk.url !== expectedUrl) {
      context.addIssue({ code: "custom", path: ["targets", target, "sdk", "url"], message: "SDK URL must name the pinned Release target asset" });
    }
  }
});

export type RemoteSdkAsset = z.infer<typeof SdkAssetSchema>;
export type RemoteBackendTarget = z.infer<typeof TargetSchema>;
export type RemoteBackendManifest = z.infer<typeof ManifestSchema> & { directory: string };

export interface RemoteBackendFile {
  relativePath: string;
  source: Buffer | string;
  size: number;
  sha256: string;
}

export interface RemoteBackendBundle {
  backendVersion: string;
  nodeVersion: string;
  bundleHash: string;
  target: RemoteBackendTarget;
  sdk: RemoteSdkAsset;
  files: readonly RemoteBackendFile[];
}

export async function loadRemoteBackendManifest(directory: string): Promise<RemoteBackendManifest> {
  try {
    const manifest = ManifestSchema.parse(
      JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")),
    );
    return { ...manifest, directory: path.resolve(directory) };
  } catch (error) {
    throw new Error(
      `Remote backend bundle is unavailable. Run npm run build:remote-backend. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export async function selectRemoteBackendBundle(
  manifest: RemoteBackendManifest,
  target: string,
): Promise<RemoteBackendBundle> {
  const parsedTarget = TargetSchema.safeParse(target);
  if (!parsedTarget.success) throw new Error(`The packaged backend does not support ${target}`);
  const selected = manifest.targets[parsedTarget.data];
  const files: RemoteBackendFile[] = [];
  for (const [relativePath, expectedHash] of Object.entries({ ...manifest.files, ...selected.files })) {
    const localPath = relativePath.startsWith("packages/")
      ? relativePath
      : path.join("targets", target, relativePath);
    const contents = await readFile(path.join(manifest.directory, localPath));
    if (createHash("sha256").update(contents).digest("hex") !== expectedHash) {
      throw new Error(`Remote backend bundle checksum mismatch: ${localPath}`);
    }
    files.push({ relativePath, source: contents, size: contents.byteLength, sha256: expectedHash });
  }
  return {
    backendVersion: manifest.backendVersion,
    nodeVersion: manifest.nodeVersion,
    bundleHash: selected.bundleHash,
    target: parsedTarget.data,
    sdk: selected.sdk,
    files,
  };
}
