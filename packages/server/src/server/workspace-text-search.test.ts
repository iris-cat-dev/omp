import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { searchWorkspaceText } from "./workspace-text-search.js";

const temporaryDirectories: string[] = [];

async function createWorkspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-text-search-"));
  temporaryDirectories.push(cwd);
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(
    path.join(cwd, "src", "main.ts"),
    "render Render renderer\n😀 café and café\nhit hit\nhit\n",
  );
  await writeFile(path.join(cwd, "src", "main.test.ts"), "render\n");
  await writeFile(path.join(cwd, "README.md"), "render\n");
  return cwd;
}

function options(cwd: string) {
  return {
    cwd,
    runtimeSettings: { ompSdkPath: process.env.OMP_DESKTOP_TEST_SDK_ROOT },
    query: "render",
    caseSensitive: true,
    wholeWord: true,
    regexp: false,
    includeGlobs: ["*.ts"],
    excludeGlobs: ["*.test.ts"],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("searchWorkspaceText", () => {
  test("applies literal, case, whole-word, include, and exclude options", async () => {
    const cwd = await createWorkspace();

    const result = await searchWorkspaceText(options(cwd));

    expect(result).toMatchObject({
      matchCount: 1,
      fileCount: 1,
      complete: true,
      visibleLimitHit: false,
      cancelled: false,
      error: null,
    });
    expect(result.files).toEqual([
      {
        path: "src/main.ts",
        matches: [
          { lineNumber: 1, text: "render Render renderer", ranges: [{ start: 0, length: 6 }] },
        ],
      },
    ]);
  });

  test("preserves Unicode match positions for highlighting", async () => {
    const cwd = await createWorkspace();

    const result = await searchWorkspaceText({
      ...options(cwd),
      query: "café",
      wholeWord: false,
    });

    expect(result.files[0]?.matches[0]).toEqual({
      lineNumber: 2,
      text: "😀 café and café",
      ranges: [
        { start: 3, length: 4 },
        { start: 12, length: 4 },
      ],
    });
    expect(result.matchCount).toBe(2);
  });

  test("keeps match highlights when cropping a long preview", async () => {
    const cwd = await createWorkspace();
    await writeFile(path.join(cwd, "src", "long.ts"), `${"x".repeat(6_000)}needle needle\r\n`);

    const result = await searchWorkspaceText({
      ...options(cwd),
      query: "needle",
      wholeWord: false,
    });

    expect(result.matchCount).toBe(2);
    const match = result.files.find((file) => file.path === "src/long.ts")!.matches[0];
    expect(match.text.length).toBeLessThanOrEqual(4_000);
    expect(match.text.startsWith("…")).toBe(true);
    expect(match.ranges.map(({ start, length }) => match.text.slice(start, start + length))).toEqual([
      "needle",
      "needle",
    ]);
  });

  test("returns regex errors without treating them as empty results", async () => {
    const cwd = await createWorkspace();

    const result = await searchWorkspaceText({
      ...options(cwd),
      query: "(",
      regexp: true,
      wholeWord: false,
    });

    expect(result.complete).toBe(false);
    expect(result.error).toMatch(/unclosed|regex|parse/i);
    expect(result.files).toEqual([]);
  });

  test("keeps total counts when visible results are capped", async () => {
    const cwd = await createWorkspace();
    await writeFile(path.join(cwd, "src", "more.ts"), "hit\n");

    const result = await searchWorkspaceText({
      ...options(cwd),
      query: "hit",
      wholeWord: false,
      visibleLineLimit: 1,
    });

    expect(result).toMatchObject({
      matchCount: 4,
      fileCount: 2,
      complete: true,
      visibleLimitHit: true,
    });
    expect(result.files[0]?.matches).toHaveLength(1);
  });

  test("stops at the hard match cap and honors cancellation", async () => {
    const cwd = await createWorkspace();
    const capped = await searchWorkspaceText({
      ...options(cwd),
      query: "hit",
      wholeWord: false,
      matchLimit: 2,
    });
    expect(capped).toMatchObject({ matchCount: 2, complete: false, cancelled: false });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await searchWorkspaceText({ ...options(cwd), signal: controller.signal });
    expect(cancelled).toMatchObject({ complete: false, cancelled: true, error: null });
  });
});
