import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow, Display } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenderingDiagnostics, RenderingJsonlWriter } from "./rendering-diagnostics.js";

const directories: string[] = [];
const recorders: RenderingDiagnostics[] = [];
const logger = { warn: vi.fn(), error: vi.fn() };

async function directory() {
  const result = await mkdtemp(path.join(os.tmpdir(), "omp-render-diagnostics-"));
  directories.push(result);
  return result;
}

async function records(
  root: string,
  name = "rendering.jsonl",
): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(path.join(root, name), "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

class WindowFixture extends EventEmitter {
  destroyed = false;
  readonly webContents;
  constructor(query: () => unknown) {
    super();
    this.webContents = Object.assign(new EventEmitter(), {
      id: 77,
      _getCompositorInfo: query,
      isDestroyed: () => this.destroyed,
      getOSProcessId: () => 1234,
      getZoomFactor: () => 1,
    });
  }
  getBounds() {
    return { x: 0, y: 0, width: 800, height: 600 };
  }
  getContentBounds() {
    return this.getBounds();
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return true;
  }
  isMinimized() {
    return false;
  }
  isMaximized() {
    return false;
  }
  isFullScreen() {
    return false;
  }
  isFocused() {
    return true;
  }
  close() {
    this.destroyed = true;
    this.emit("closed");
  }
}

async function recorder() {
  const root = await directory();
  const diagnostics = new RenderingDiagnostics({
    directory: root,
    runtimeDirectory: root,
    enabled: true,
    identity: { appVersion: "test" },
    logger,
    getDisplayForBounds: () =>
      ({
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        scaleFactor: 1,
      }) as Display,
    openDirectory: async () => "",
  });
  recorders.push(diagnostics);
  return { root, diagnostics };
}

// These fixtures model lifecycle events, not a native rendering implementation.
function browserWindow(fixture: WindowFixture): BrowserWindow {
  return fixture as unknown as BrowserWindow;
}

afterEach(async () => {
  await Promise.all(recorders.splice(0).map((value) => value.shutdown()));
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.clearAllMocks();
});

describe("rendering JSONL bounds", () => {
  it("keeps an exact-boundary current file and only three bounded archives", async () => {
    const root = await directory();
    const sample = { sequence: 0, payload: "x".repeat(32) };
    const lineBytes = Buffer.byteLength(`${JSON.stringify(sample)}\n`);
    const writer = new RenderingJsonlWriter({
      directory: root,
      logger,
      maxFileBytes: lineBytes * 2,
    });
    await writer.append(sample);
    await writer.append({ ...sample, sequence: 1 });
    expect(await readdir(root)).toEqual(["rendering.jsonl"]);
    expect(Buffer.byteLength(await readFile(writer.currentPath, "utf8"))).toBe(lineBytes * 2);
    for (let sequence = 2; sequence < 10; sequence += 1)
      await writer.append({ ...sample, sequence });
    await writer.close();
    expect((await readdir(root)).sort()).toEqual([
      "rendering.1.jsonl",
      "rendering.2.jsonl",
      "rendering.3.jsonl",
      "rendering.jsonl",
    ]);
    expect((await records(root)).map((record) => record.sequence)).toEqual([8, 9]);
    expect((await records(root, "rendering.3.jsonl")).map((record) => record.sequence)).toEqual([
      2, 3,
    ]);
    for (const file of await readdir(root)) {
      expect(Buffer.byteLength(await readFile(path.join(root, file), "utf8"))).toBeLessThanOrEqual(
        lineBytes * 2,
      );
    }
  });

  it("replaces oversized records without exceeding the file or blocking later records", async () => {
    const root = await directory();
    const writer = new RenderingJsonlWriter({
      directory: root,
      logger,
      maxFileBytes: 256,
      maxRecordBytes: 128,
    });
    await writer.append({ type: "oversized", payload: "x".repeat(2048) });
    await writer.append({ type: "after-oversized" });
    await writer.close();
    const entries = await records(root);
    expect(entries).toEqual([
      { type: "record-omitted", reason: "record-too-large", bytes: expect.any(Number) },
      { type: "after-oversized" },
    ]);
    expect(Buffer.byteLength(await readFile(writer.currentPath, "utf8"))).toBeLessThanOrEqual(256);
  });
});

describe("rendering metadata query lifecycle", () => {
  it("preserves window and display evidence when the runtime lacks the optional OS PID getter", async () => {
    const { root, diagnostics } = await recorder();
    const fixture = new WindowFixture(async () => ({}));
    Object.defineProperty(fixture.webContents, "getOSProcessId", { value: undefined });
    diagnostics.observeWindow(browserWindow(fixture));
    await diagnostics.recordIssue(browserWindow(fixture));
    await diagnostics.flush();
    const marker = (await records(root)).find((entry) => entry.type === "issue-marker");
    expect(marker).toMatchObject({
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      display: { id: 1, scaleFactor: 1 },
    });
    expect(marker).not.toHaveProperty("windowMetadataUnavailable");
    expect(marker).not.toHaveProperty("rendererPid");
  });

  it("does not overlap unresolved native calls after timeout, polling, or another marker", async () => {
    vi.useFakeTimers();
    const { root, diagnostics } = await recorder();
    const response = Promise.withResolvers<unknown>();
    let calls = 0;
    const fixture = new WindowFixture(() => {
      calls += 1;
      return response.promise;
    });
    const window = browserWindow(fixture);
    diagnostics.observeWindow(window);
    await diagnostics.recordIssue(window);
    vi.advanceTimersByTime(95_000);
    await diagnostics.recordIssue(window);
    await diagnostics.flush();
    expect(calls).toBe(1);
    const entries = await records(root);
    expect(entries.filter((entry) => entry.type === "native-query-timeout")).toHaveLength(1);
    expect(entries.filter((entry) => entry.type === "issue-marker")).toHaveLength(2);
    expect(entries.some((entry) => entry.nativeStatus === "timed-out-unresolved")).toBe(true);
  });

  it("discards a closed window's late reply even when a new window reuses its runtime id", async () => {
    vi.useFakeTimers();
    const { root, diagnostics } = await recorder();
    const oldResponse = Promise.withResolvers<unknown>();
    const first = new WindowFixture(() => oldResponse.promise);
    diagnostics.observeWindow(browserWindow(first));
    await diagnostics.recordIssue(browserWindow(first));
    first.close();
    const replacementResponse = Promise.withResolvers<unknown>();
    const replacement = new WindowFixture(() => replacementResponse.promise);
    diagnostics.observeWindow(browserWindow(replacement));
    await diagnostics.recordIssue(browserWindow(replacement));
    oldResponse.resolve({ diagnostics: { schemaVersion: 1 } });
    await Promise.resolve();
    await diagnostics.flush();
    const entries = await records(root);
    expect(entries.filter((entry) => entry.type === "native-snapshot")).toHaveLength(0);
    expect(
      entries.filter((entry) => entry.type === "issue-marker").map((entry) => entry.windowId),
    ).toEqual(["1", "2"]);
    expect(entries.some((entry) => entry.type === "window-closed" && entry.windowId === "1")).toBe(
      true,
    );
  });

  it("excludes page data from native replies while retaining exact resource identities", async () => {
    vi.useFakeTimers();
    const { root, diagnostics } = await recorder();
    const privateValue = "private-project-file-and-chat-text";
    const fixture = new WindowFixture(() => ({
      url: privateValue,
      diagnostics: {
        schemaVersion: 1,
        producer: {
          rendererPid: 1234,
          sourceId: "18446744073709551614",
          title: privateValue,
          lastDamage: { x: 0, y: 4, width: 12, height: 16, filename: privateValue },
          events: [{ seq: "1", type: "backing-created", sourceId: "8", token: privateValue }],
        },
        consumer: { available: true, project: privateValue },
        presenter: { layerCount: 1, text: privateValue },
      },
    }));
    diagnostics.observeWindow(browserWindow(fixture));
    await diagnostics.recordIssue(browserWindow(fixture));
    await diagnostics.flush();
    const entries = await records(root);
    expect(JSON.stringify(entries)).not.toContain(privateValue);
    const snapshot = entries.find((entry) => entry.type === "native-snapshot");
    expect(snapshot?.diagnostics).toMatchObject({
      producer: {
        sourceId: "18446744073709551614",
        lastDamage: { x: 0, y: 4, width: 12, height: 16 },
        events: [{ seq: "1", type: "backing-created", sourceId: "8" }],
      },
    });
  });

  it("persists the manual marker before starting a native query that never resolves", async () => {
    const { root, diagnostics } = await recorder();
    const response = Promise.withResolvers<unknown>();
    let persistedAtInvocation: Array<Record<string, unknown>> | undefined;
    const fixture = new WindowFixture(() => {
      persistedAtInvocation = readFileSync(path.join(root, "rendering.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      return response.promise;
    });
    const window = browserWindow(fixture);
    diagnostics.observeWindow(window);
    await diagnostics.recordIssue(window);
    expect(persistedAtInvocation?.some((entry) => entry.type === "issue-marker")).toBe(true);
    await diagnostics.shutdown();
    const entries = await records(root);
    expect(entries.filter((entry) => entry.type === "issue-marker")).toHaveLength(1);
    expect(entries.at(-1)?.type).toBe("shutdown");
  });
});
