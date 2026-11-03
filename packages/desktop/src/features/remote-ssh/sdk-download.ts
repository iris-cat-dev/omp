import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { RemoteSdkAsset } from "./bundle.js";

export interface RemoteSdkDownloadOptions {
  cacheDirectory: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  signal: AbortSignal;
  onProgress: (percent: number) => void;
}

async function isVerifiedCache(
  filePath: string,
  asset: RemoteSdkAsset,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size !== asset.size) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath, { signal })) hash.update(chunk);
    signal.throwIfAborted();
    return hash.digest("hex") === asset.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function downloadRemoteSdk(
  asset: RemoteSdkAsset,
  options: RemoteSdkDownloadOptions,
): Promise<string> {
  const { cacheDirectory, signal, onProgress } = options;
  signal.throwIfAborted();
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const cachePath = path.join(cacheDirectory, `${asset.sha256}.tgz`);
  if (await isVerifiedCache(cachePath, asset, signal)) {
    onProgress(100);
    return cachePath;
  }
  signal.throwIfAborted();
  await rm(cachePath, { force: true });
  const partialPath = path.join(cacheDirectory, `.${asset.sha256}.${randomUUID()}.partial`);
  let response: Response | undefined;
  let streaming = false;
  try {
    onProgress(0);
    try {
      response = await options.fetch(asset.url, { signal, redirect: "follow" });
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(`The pinned remote SDK Release asset is unavailable: ${asset.url}`, { cause: error });
    }
    if (!response.ok) {
      throw new Error(`The pinned remote SDK Release asset is unavailable (HTTP ${response.status}): ${asset.url}`);
    }
    if (!response.body) throw new Error("The remote SDK Release asset has no download body");
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) !== asset.size) {
      throw new Error(`Remote SDK download size mismatch: expected ${asset.size}, received ${length}`);
    }
    const hash = createHash("sha256");
    let size = 0;
    let lastProgress = 0;
    const verifier = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.byteLength;
        if (size > asset.size) {
          callback(new Error(`Remote SDK download size mismatch: expected ${asset.size}, received at least ${size}`));
          return;
        }
        hash.update(chunk);
        const progress = Math.min(99, Math.floor((size / asset.size) * 100));
        if (progress >= lastProgress + 5) {
          lastProgress = progress;
          onProgress(progress);
        }
        callback(null, chunk);
      },
    });
    streaming = true;
    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
      verifier,
      createWriteStream(partialPath, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    signal.throwIfAborted();
    if (size !== asset.size) {
      throw new Error(`Remote SDK download size mismatch: expected ${asset.size}, received ${size}`);
    }
    if (hash.digest("hex") !== asset.sha256) {
      throw new Error("Remote SDK download checksum mismatch");
    }
    await rename(partialPath, cachePath);
    signal.throwIfAborted();
    onProgress(100);
    return cachePath;
  } finally {
    if (!streaming && response?.body) await response.body.cancel().catch(() => undefined);
    await rm(partialPath, { force: true });
  }
}
