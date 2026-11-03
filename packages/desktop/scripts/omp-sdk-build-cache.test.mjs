import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  fingerprintPaths,
  cachedOutputMatches,
  cacheOutput,
} from "../../../omp-sdk/scripts/sdk-build-cache.mjs";

async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omp-sdk-cache-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("does not reuse an SDK built before a same-size source edit with preserved timestamps", async () => {
  await fixture(async (directory) => {
    const source = path.join(directory, "workspace.ts");
    const output = path.join(directory, "sdk.mjs");
    const cache = path.join(directory, "cache.json");
    await writeFile(source, "first");
    const original = await stat(source);
    const firstKey = await fingerprintPaths([source]);
    await writeFile(output, (await readFile(source, "utf8")).toUpperCase());
    await cacheOutput(cache, firstKey, [output]);
    expect(await cachedOutputMatches(cache, firstKey, [output])).toBe(true);

    await writeFile(source, "later");
    await utimes(source, original.atime, original.mtime);
    const updatedKey = await fingerprintPaths([source]);
    expect(await cachedOutputMatches(cache, updatedKey, [output])).toBe(false);
    await writeFile(output, (await readFile(source, "utf8")).toUpperCase());
    await cacheOutput(cache, updatedKey, [output]);
    expect(await readFile(output, "utf8")).toBe("LATER");
    expect(await cachedOutputMatches(cache, firstKey, [output])).toBe(false);
  });
});

test.each(["edit", "delete"])(
  "rejects a cached runtime after a nested dependency %s",
  async (change) => {
    await fixture(async (directory) => {
      const output = path.join(directory, "stage");
      const dependency = path.join(
        output,
        "node_modules/@oh-my-pi/pi-coding-agent/node_modules/native/runtime.node",
      );
      const cache = path.join(directory, "cache.json");
      await mkdir(path.dirname(dependency), { recursive: true });
      await writeFile(dependency, "validated native bytes");
      await cacheOutput(cache, "unchanged inputs", [output]);
      if (change === "edit") await writeFile(dependency, "unexpected native bytes");
      else await rm(dependency);
      expect(await cachedOutputMatches(cache, "unchanged inputs", [output])).toBe(false);
    });
  },
);

test("invalidates directory inputs when resources are added or removed", async () => {
  await fixture(async (directory) => {
    const inputs = path.join(directory, "package");
    const output = path.join(directory, "sdk.mjs");
    const cache = path.join(directory, "cache.json");
    await mkdir(inputs);
    await writeFile(
      path.join(inputs, "package.json"),
      '{"name":"local-package","version":"1.0.0"}',
    );
    await writeFile(output, "runtime");
    const before = await fingerprintPaths([inputs]);
    await cacheOutput(cache, before, [output]);
    const resource = path.join(inputs, "worker.js");
    await writeFile(resource, "export const result = 42;");
    const added = await fingerprintPaths([inputs]);
    expect(await cachedOutputMatches(cache, added, [output])).toBe(false);
    await cacheOutput(cache, added, [output]);
    await rm(resource);
    expect(await cachedOutputMatches(cache, await fingerprintPaths([inputs]), [output])).toBe(
      false,
    );
  });
});

test("tracks actual contents of a linked local workspace rather than its unchanged version", async () => {
  await fixture(async (directory) => {
    const workspace = path.join(directory, "workspace");
    const link = path.join(directory, "node_modules/linked-workspace");
    const output = path.join(directory, "sdk.mjs");
    const cache = path.join(directory, "cache.json");
    await mkdir(workspace);
    await mkdir(path.dirname(link));
    await writeFile(
      path.join(workspace, "package.json"),
      '{"name":"linked-workspace","version":"1.0.0"}',
    );
    await writeFile(path.join(workspace, "index.js"), "export const value = 1;");
    await symlink(workspace, link, process.platform === "win32" ? "junction" : "dir");
    const first = await fingerprintPaths([link]);
    await writeFile(output, "bundled value: 1");
    await cacheOutput(cache, first, [output]);
    await writeFile(path.join(workspace, "index.js"), "export const value = 2;");
    expect(await cachedOutputMatches(cache, await fingerprintPaths([link]), [output])).toBe(false);
  });
});

test("rebuilds when cache metadata or required output is missing instead of trusting the input key", async () => {
  await fixture(async (directory) => {
    const output = path.join(directory, "sdk.mjs");
    const cache = path.join(directory, "cache.json");
    await writeFile(output, "complete SDK");
    await cacheOutput(cache, "inputs", [output]);
    await writeFile(cache, "{incomplete cache");
    expect(await cachedOutputMatches(cache, "inputs", [output])).toBe(false);
    await cacheOutput(cache, "inputs", [output]);
    await rm(output);
    expect(await cachedOutputMatches(cache, "inputs", [output])).toBe(false);
    await expect(cacheOutput(cache, "inputs", [output])).rejects.toThrow("required outputs");
  });
});
