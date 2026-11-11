import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { OmpPluginCliService, type OmpPluginRunner } from "./omp-plugin-cli-service.js";
import { OmpPluginSession } from "./omp-plugin-session.js";

const LIST_JSON = JSON.stringify({
  npm: [{ name: "pi-memory", version: "0.4.2", enabled: true, path: "C:/p" }],
  marketplace: [],
});

function makeSession(runner: OmpPluginRunner) {
  const emitted: unknown[] = [];
  const service = new OmpPluginCliService({
    logger: createTestLogger(),
    runner,
    resolveOmpCommand: async () => "omp",
  });
  const session = new OmpPluginSession({
    service,
    emit: (msg) => emitted.push(msg),
    logger: createTestLogger(),
  });
  return { session, emitted, service };
}

describe("OmpPluginSession", () => {
  it("answers list requests with an ompPlugins.list.response", async () => {
    const { session, emitted } = makeSession(async () => ({ stdout: LIST_JSON, stderr: "" }));

    await session.handleInboundMessage({
      type: "ompPlugins.list.request",
      requestId: "r-1",
    } as never);

    expect(emitted[0]).toMatchObject({
      type: "ompPlugins.list.response",
      payload: { requestId: "r-1", plugins: [{ name: "pi-memory" }] },
    });
  });

  it("answers CLI failures immediately with correlated diagnostic output", async () => {
    const { session, emitted } = makeSession(async () => {
      throw new Error("cli exploded");
    });

    await session.handleInboundMessage({
      type: "ompPlugins.doctor.request",
      requestId: "r-2",
    } as never);

    expect(emitted[0]).toMatchObject({
      type: "ompPlugins.doctor.response",
      payload: { requestId: "r-2", checks: [], rawOutput: "cli exploded" },
    });
  });

  it("correlates invalid project context with a failed mutation response", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const { session, emitted } = makeSession(runner);
    await session.handleInboundMessage({
      type: "ompPlugins.install.request",
      requestId: "invalid-project",
      spec: "probe@catalog",
      scope: "project",
    });
    expect(emitted).toEqual([
      {
        type: "ompPlugins.install.response",
        payload: {
          requestId: "invalid-project",
          ok: false,
          plugin: null,
          output: expect.stringContaining("explicit project cwd"),
        },
      },
    ]);
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects correlated calls immediately when an unexpected service error escapes", async () => {
    const { session, emitted, service } = makeSession(async () => ({ stdout: "", stderr: "" }));
    vi.spyOn(service, "marketplaceList").mockRejectedValue(new Error("catalog read failed"));
    await session.handleInboundMessage({
      type: "ompPlugins.marketplace.list.request",
      requestId: "catalog-error",
    });
    expect(emitted).toEqual([
      {
        type: "rpc_error",
        payload: {
          requestId: "catalog-error",
          requestType: "ompPlugins.marketplace.list.request",
          error: "catalog read failed",
        },
      },
    ]);
  });

  it("returns correlated native refresh diagnostics instead of a generic status", async () => {
    const { session, emitted } = makeSession(async () => {
      throw new Error("marketplace not found");
    });
    await session.handleInboundMessage({
      type: "ompPlugins.marketplace.update.request",
      requestId: "refresh-error",
      name: "missing",
    });
    expect(emitted).toEqual([
      {
        type: "ompPlugins.marketplace.update.response",
        payload: { requestId: "refresh-error", ok: false, output: "marketplace not found" },
      },
    ]);
  });

  it("returns undefined for unrelated message types", () => {
    const { session } = makeSession(async () => ({ stdout: "", stderr: "" }));

    const result = session.handleInboundMessage({
      type: "status",
      payload: { status: "ok" },
    } as never);

    expect(result).toBeUndefined();
  });

  it("carries name and enabled in setEnabled responses", async () => {
    const { session, emitted } = makeSession(async () => ({
      stdout: JSON.stringify({
        npm: [{ name: "p1", version: "1", enabled: true, path: "x" }],
        marketplace: [],
      }),
      stderr: "",
    }));

    await session.handleInboundMessage({
      type: "ompPlugins.setEnabled.request",
      requestId: "r-3",
      name: "p1",
      enabled: true,
    } as never);

    expect(emitted[0]).toMatchObject({
      type: "ompPlugins.setEnabled.response",
      payload: { requestId: "r-3", name: "p1", enabled: true, ok: true },
    });
  });

  it("routes marketplace.list.request to a marketplace.list.response", async () => {
    const registryDir = await mkdtemp(join(tmpdir(), "omp-mkt-session-"));
    try {
      await writeFile(
        join(registryDir, "marketplaces.json"),
        JSON.stringify({
          version: 1,
          marketplaces: [
            {
              name: "probe-mkt",
              sourceUri: "D:/mp",
              catalogPath: join(registryDir, "catalog.json"),
            },
          ],
        }),
        "utf8",
      );
      await writeFile(
        join(registryDir, "catalog.json"),
        JSON.stringify({ plugins: [{ name: "probe-plugin", description: "d" }] }),
        "utf8",
      );
      const emitted: unknown[] = [];
      const service = new OmpPluginCliService({
        logger: createTestLogger(),
        runner: async () => ({ stdout: "", stderr: "" }),
        resolveOmpCommand: async () => "omp",
        marketplacesRegistryPath: join(registryDir, "marketplaces.json"),
      });
      const session = new OmpPluginSession({
        service,
        emit: (msg) => emitted.push(msg),
        logger: createTestLogger(),
      });

      await session.handleInboundMessage({
        type: "ompPlugins.marketplace.list.request",
        requestId: "m-1",
      } as never);

      expect(emitted[0]).toMatchObject({
        type: "ompPlugins.marketplace.list.response",
        payload: {
          requestId: "m-1",
          marketplaces: [{ name: "probe-mkt", plugins: [{ name: "probe-plugin" }] }],
        },
      });
    } finally {
      await rm(registryDir, { recursive: true, force: true });
    }
  });

  it("routes marketplace.add and remove requests through the CLI service", async () => {
    const registryPath = join(
      await mkdtemp(join(tmpdir(), "omp-mkt-session-")),
      "marketplaces.json",
    );
    const calls: string[][] = [];
    const emitted: unknown[] = [];
    const service = new OmpPluginCliService({
      logger: createTestLogger(),
      runner: async (_command, args) => {
        calls.push(args);
        return { stdout: "ok", stderr: "" };
      },
      resolveOmpCommand: async () => "omp",
      marketplacesRegistryPath: registryPath,
    });
    const session = new OmpPluginSession({
      service,
      emit: (msg) => emitted.push(msg),
      logger: createTestLogger(),
    });

    await session.handleInboundMessage({
      type: "ompPlugins.marketplace.add.request",
      requestId: "m-2",
      source: "owner/repo",
    } as never);
    await session.handleInboundMessage({
      type: "ompPlugins.marketplace.remove.request",
      requestId: "m-3",
      name: "probe-mkt",
    } as never);

    expect(calls[0]).toEqual(["plugin", "marketplace", "add", "owner/repo", "--json"]);
    expect(emitted[0]).toMatchObject({
      type: "ompPlugins.marketplace.add.response",
      payload: { requestId: "m-2", ok: true },
    });
    expect(calls[1]).toEqual(["plugin", "marketplace", "remove", "probe-mkt", "--json"]);
    expect(emitted[1]).toMatchObject({
      type: "ompPlugins.marketplace.remove.response",
      payload: { requestId: "m-3", ok: true },
    });
    await rm(dirname(registryPath), { recursive: true, force: true });
  });
  it("correlates unsupported config management without leaking CLI secrets", async () => {
    const { session, emitted } = makeSession(async () => ({ stdout: '{"token":"private-token"}', stderr: "private-token" }));
    await session.handleInboundMessage({ type: "ompPlugins.management.get.request", requestId: "safe-config", name: "fixture" });
    expect(emitted).toEqual([{ type: "rpc_error", payload: { requestId: "safe-config", requestType: "ompPlugins.management.get.request", error: "The selected OMP runtime does not support safe Desktop configuration management." } }]);
    expect(JSON.stringify(emitted)).not.toContain("private-token");
  });
});
