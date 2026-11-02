import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "../../../test-utils/remote-backend.js";
import { downloadRemoteSdk } from "./sdk-download.js";

let directory: string;
let server: Server;
let origin: string;
let requests: number;
const bytes = randomBytes(256 * 1024);

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "omp-sdk-download-"));
  requests = 0;
  server = createServer((request, response) => {
    requests += 1;
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/asset" }).end();
    } else if (request.url === "/missing") {
      response.writeHead(404).end("Not found");
    } else if (request.url === "/corrupt") {
      response.writeHead(200, { "content-length": bytes.length }).end(Buffer.alloc(bytes.length));
    } else if (request.url === "/short") {
      response.writeHead(200).end(bytes.subarray(0, 1024));
    } else if (request.url === "/wrong-length") {
      response.writeHead(200, { "content-length": 1024 }).end(bytes.subarray(0, 1024));
    } else if (request.url === "/slow") {
      response.writeHead(200, { "content-length": bytes.length });
      // Leave the response open until cancellation closes the actual TCP connection.
      response.write(bytes.subarray(0, 16 * 1024));
    } else {
      response.writeHead(200, { "content-length": bytes.length }).end(bytes);
    }
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind a port");
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((error) => error ? reject(error) : resolve());
  await promise;
  await rm(directory, { recursive: true, force: true });
});

function asset(route: string) {
  return { url: `${origin}/${route}`, sha256: sha256(bytes), size: bytes.length };
}

function options(controller = new AbortController(), onProgress = (_percent: number) => {}) {
  return { cacheDirectory: directory, fetch: globalThis.fetch, signal: controller.signal, onProgress };
}

describe("downloadRemoteSdk", () => {
  it("follows Release redirects, streams verified bytes, and revalidates cached assets before reuse", async () => {
    const progress: number[] = [];
    const sdkPath = await downloadRemoteSdk(asset("redirect"), options(undefined, (value) => progress.push(value)));
    expect(await readFile(sdkPath)).toEqual(bytes);
    expect(path.basename(sdkPath)).toBe(`${sha256(bytes)}.tgz`);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(100);
    expect(progress).toEqual([...progress].sort((left, right) => left - right));
    expect(requests).toBe(2);
    expect(await downloadRemoteSdk(asset("missing"), options())).toBe(sdkPath);
    expect(requests).toBe(2);

    // Same-length corruption must not be accepted merely because the cache file exists.
    await writeFile(sdkPath, Buffer.alloc(bytes.length));
    await downloadRemoteSdk(asset("asset"), options());
    expect(requests).toBe(3);
    expect(await readFile(sdkPath)).toEqual(bytes);
    expect(await readdir(directory)).toEqual([path.basename(sdkPath)]);
  });

  it.each([
    ["corrupt", "checksum mismatch"],
    ["short", "size mismatch"],
    ["wrong-length", "size mismatch"],
    ["missing", "unavailable (HTTP 404)"],
  ])("rejects %s without promoting or leaving partial bytes", async (route, error) => {
    const progress: number[] = [];
    await expect(downloadRemoteSdk(asset(route), options(undefined, (value) => progress.push(value)))).rejects.toThrow(error);
    expect(await readdir(directory)).toEqual([]);
    expect(progress).not.toContain(100);
  });

  it("aborts an active HTTP stream and removes its partial file before rejecting", async () => {
    const controller = new AbortController();
    const progress: number[] = [];
    await expect(downloadRemoteSdk(asset("slow"), options(controller, (percent) => {
      progress.push(percent);
      if (percent > 0) controller.abort();
    }))).rejects.toMatchObject({ name: "AbortError" });
    expect(progress.some((value) => value > 0)).toBe(true);
    expect(progress).not.toContain(100);
    expect(requests).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("does not start a request or mutate the cache when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(downloadRemoteSdk(asset("asset"), options(controller))).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toBe(0);
    expect(await readdir(directory)).toEqual([]);
  });
});
