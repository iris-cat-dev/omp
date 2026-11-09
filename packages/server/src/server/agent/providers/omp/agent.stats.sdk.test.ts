import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import type * as NodeOs from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { OmpAgentClient } from "./agent.js";
import { ompHistoryRuntimeSettings } from "./test-utils/history-sdk.js";

vi.mock("node:os", async (importOriginal) => {
  const native = await importOriginal<typeof NodeOs>();
  return { ...native, homedir: vi.fn(native.homedir) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(profile: "default" | "work" = "work") {
  const home = await mkdtemp(join(tmpdir(), "omp-sdk-stats-"));
  directories.push(home);
  vi.mocked(homedir).mockReturnValue(home);
  const root = profile === "default" ? join(home, ".omp") : join(home, ".omp", "profiles", profile);
  const sessions = join(root, "agent", "sessions", "--fixture--");
  await mkdir(sessions, { recursive: true });
  const env = {
    HOME: home,
    USERPROFILE: home,
    OMP_CONFIG_DIR: ".omp",
    PI_CONFIG_DIR: ".omp",
    OMP_PROFILE: profile,
    PI_PROFILE: profile,
    OMP_CODING_AGENT_DIR: profile === "default" ? "" : join(root, "agent"),
    PI_CODING_AGENT_DIR: profile === "default" ? "" : join(root, "agent"),
    XDG_DATA_HOME: "",
    XDG_STATE_HOME: "",
    XDG_CACHE_HOME: "",
    PATH: "",
  };
  const agent = new OmpAgentClient({
    logger: createTestLogger(),
    runtimeSettings: { ...ompHistoryRuntimeSettings, ompBackend: "sdk", env },
  });
  const session = join(sessions, "main.jsonl");
  await writeFile(
    session,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "stats-fixture",
      cwd: home,
      timestamp: new Date().toISOString(),
    })}\n`,
  );
  return { home, root, agent, session, env };
}

function request(id: string, parentId: string | null, totalTokens: number, timestamp = Date.now()) {
  return `${JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "PRIVATE_FIXTURE_BODY" }],
      api: "synthetic-fixture",
      provider: "fixture-provider",
      model: "fixture-model",
      timestamp,
      stopReason: "stop",
      usage: {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        totalTokens,
        cost: { input: 0, output: 1.25, cacheRead: 0, cacheWrite: 0, total: 1.25 },
      },
    },
  })}\n`;
}

describe("SDK native statistics synchronization", () => {
  it("builds a missing profile index, ingests appended requests and never double-counts refreshes", async () => {
    const { home, root, agent, session } = await fixture();
    await appendFile(session, request("first", null, 123));
    expect(existsSync(join(root, "stats.db"))).toBe(false);
    expect(await agent.getOmpStats("24h")).toMatchObject({
      status: "available",
      scope: { profile: "work" },
      overall: { totalRequests: 1, totalTokens: 123, totalCostUsd: 1.25 },
    });
    await appendFile(session, request("second", "first", 234));
    const refreshed = await agent.getOmpStats("24h");
    expect(refreshed).toMatchObject({
      status: "available",
      overall: { totalRequests: 2, totalTokens: 357, totalCostUsd: 2.5, transcriptCount: 1 },
      byProvider: [{ provider: "fixture-provider", totalRequests: 2, totalTokens: 357 }],
      byAgentType: [{ agentType: "main", totalRequests: 2 }],
    });
    const repeated = await agent.getOmpStats("all");
    expect(repeated.status).toBe("available");
    if (repeated.status !== "available" || refreshed.status !== "available")
      throw new Error("No statistics");
    expect(repeated.overall).toEqual(refreshed.overall);
    expect(existsSync(join(home, ".omp", "stats.db"))).toBe(false);
    expect(JSON.stringify(refreshed)).not.toContain("PRIVATE_FIXTURE_BODY");
  });

  it("keeps default and named profiles isolated from lower-priority dotenv agent overrides", async () => {
    const { home, root, agent, session, env } = await fixture("default");
    await appendFile(session, request("default-request", null, 123));
    const workAgent = join(root, "profiles", "work", "agent");
    const workSessions = join(workAgent, "sessions", "--fixture--");
    await mkdir(workSessions, { recursive: true });
    await writeFile(
      join(workSessions, "work.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "work-fixture",
        cwd: home,
        timestamp: new Date().toISOString(),
      })}\n${request("work-request", null, 900)}`,
    );
    await writeFile(join(home, ".env"), `PI_PROFILE=work\nPI_CODING_AGENT_DIR=${workAgent}\n`);

    expect(await agent.getOmpStats("all")).toMatchObject({
      status: "available",
      scope: { profile: "default" },
      overall: { totalRequests: 1, totalTokens: 123, totalCostUsd: 1.25 },
    });
    const work = new OmpAgentClient({
      logger: createTestLogger(),
      runtimeSettings: {
        ...ompHistoryRuntimeSettings,
        ompBackend: "sdk",
        env: { ...env, OMP_PROFILE: "work", PI_PROFILE: "work" },
      },
    });
    expect(await work.getOmpStats("all")).toMatchObject({
      status: "available",
      scope: { profile: "work" },
      overall: { totalRequests: 1, totalTokens: 900, totalCostUsd: 1.25 },
    });
    expect(await agent.getOmpStats("24h")).toMatchObject({
      status: "available",
      scope: { profile: "default" },
      overall: { totalRequests: 1, totalTokens: 123, totalCostUsd: 1.25 },
    });
  });

  it.each(["reported-error", "exit-without-done"])(
    "does not return stale totals when the SDK worker fails: %s",
    async (failure) => {
      const { home, root, agent, session, env } = await fixture();
      await appendFile(session, request("first", null, 123));
      expect(await agent.getOmpStats("all")).toMatchObject({ status: "available" });
      const sdkRoot = join(home, "failed-sdk");
      const node = join(sdkRoot, "dist", "node");
      await mkdir(node, { recursive: true });
      await writeFile(
        join(sdkRoot, "package.json"),
        JSON.stringify({
          name: "@oh-my-pi/pi-coding-agent",
          version: "19.2.3",
        }),
      );
      for (const entry of ["sdk.mjs", "rpc.mjs", "plugins.mjs", "modules.json"]) {
        await writeFile(join(node, entry), "");
      }
      await writeFile(
        join(node, "host.mjs"),
        failure === "reported-error"
          ? `process.once("message", ({id}) => process.send({type:"error", id, error:"PRIVATE_NATIVE_ERROR"}));`
          : `process.once("message", () => process.exit(0));`,
      );
      const broken = new OmpAgentClient({
        logger: createTestLogger(),
        runtimeSettings: { ompBackend: "sdk", ompSdkPath: sdkRoot, env },
      });
      const result = await broken.getOmpStats("all");
      expect(result).toMatchObject({ status: "error", reason: "index_refresh_failed" });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_NATIVE_ERROR");
      expect(existsSync(join(root, "stats.db"))).toBe(true);
      expect(await agent.getOmpStats("all")).toMatchObject({
        status: "available",
        overall: { totalRequests: 1, totalTokens: 123 },
      });
    },
  );
});
