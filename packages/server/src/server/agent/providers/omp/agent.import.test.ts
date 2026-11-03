import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSession, AgentSessionConfig } from "../../agent-sdk-types.js";
import { OmpAgentClient } from "./agent.js";
import { FakeOmp } from "./test-utils/fake-omp.js";

const tempDirs: string[] = [];
const sessions: AgentSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(args?: string[]) {
  const cwd = await mkdtemp(join(tmpdir(), "omp-import-mode-"));
  tempDirs.push(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  const providerHandleId = join(cwd, "session.jsonl");
  await writeFile(
    providerHandleId,
    JSON.stringify({
      type: "session",
      version: 3,
      id: "import-mode",
      cwd,
      timestamp: "2026-09-01T00:00:00.000Z",
    }) + "\n",
  );
  const runtime = new FakeOmp();
  const client = new OmpAgentClient({
    logger: createTestLogger(),
    runtime,
    oauthAccounts: [],
    runtimeSettings: {
      command: args ? { mode: "append", args } : undefined,
      env: { OMP_PROFILE: "default", PI_CODING_AGENT_DIR: agentDir, PI_CONFIG_FILES: "" },
    },
  });
  const importSession = async (
    options: {
      modeId?: string;
      storedModeId?: string;
      env?: Record<string, string>;
    } = {},
  ) => {
    const config: AgentSessionConfig = { provider: "omp", cwd, modeId: options.modeId };
    const imported = await client.importSession(
      { providerHandleId, cwd },
      {
        config,
        storedConfig: { ...config, modeId: options.storedModeId ?? options.modeId },
        launchContext: options.env ? { env: options.env } : undefined,
      },
    );
    sessions.push(imported.session);
    return imported;
  };
  return { cwd, agentDir, client, runtime, importSession };
}

describe("OMP imported approval mode", () => {
  test.each([
    ["always-ask", "ask"],
    ["write", "ask"],
    ["yolo", "full"],
  ])("restores native %s without granting additional capabilities", async (nativeMode, modeId) => {
    const { agentDir, runtime, importSession } = await fixture();
    await writeFile(join(agentDir, "config.yaml"), `tools:\n  approvalMode: ${nativeMode}\n`);
    const imported = await importSession();
    expect(await imported.session.getCurrentMode()).toBe(modeId);
    expect(imported.config.modeId).toBe(modeId);
    expect(imported.persistence.metadata?.modeId).toBe(modeId);
    expect(runtime.recordedLaunches[0]?.argv).toContain(
      nativeMode === "write" ? "always-ask" : nativeMode,
    );
  });

  test("keeps restrictive project settings ahead of the global default", async () => {
    const { cwd, agentDir, importSession } = await fixture();
    await writeFile(join(agentDir, "config.yml"), "tools:\n  approvalMode: yolo\n");
    await mkdir(join(cwd, ".omp"));
    await writeFile(
      join(cwd, ".omp", "settings.json"),
      JSON.stringify({ tools: { approvalMode: "write" } }),
    );
    await writeFile(join(cwd, ".omp", "config.yml"), "tools:\n  approvalMode: always-ask\n");
    const imported = await importSession();
    expect(await imported.session.getCurrentMode()).toBe("ask");
    expect(imported.config.modeId).toBe("ask");
  });

  test("applies launch-context config overlays after native configuration", async () => {
    const { cwd, agentDir, importSession } = await fixture();
    await writeFile(join(agentDir, "config.yml"), "tools:\n  approvalMode: yolo\n");
    const overlay = join(cwd, "overlay.yml");
    await writeFile(overlay, "tools:\n  approvalMode: write\n");
    const imported = await importSession({ env: { PI_CONFIG_FILES: overlay } });
    expect(await imported.session.getCurrentMode()).toBe("ask");
    expect(imported.config.modeId).toBe("ask");
  });

  test("preserves explicit current choices without reading native defaults", async () => {
    const { agentDir, importSession } = await fixture();
    await writeFile(join(agentDir, "config.yml"), "tools:\n  approvalMode: invalid\n");
    const current = await importSession({ modeId: "ask", storedModeId: "full" });
    expect(await current.session.getCurrentMode()).toBe("ask");
    expect(current.config.modeId).toBe("ask");
  });

  test("does not infer imported permissions from the native schema default", async () => {
    const { importSession } = await fixture();
    const imported = await importSession();
    expect(await imported.session.getCurrentMode()).toBe("ask");
  });

  test("does not infer a permissive default when custom CLI settings may override it", async () => {
    const { agentDir, importSession } = await fixture(["--config=custom.yml"]);
    await writeFile(join(agentDir, "config.yml"), "tools:\n  approvalMode: yolo\n");
    const imported = await importSession();
    expect(await imported.session.getCurrentMode()).toBe("ask");
  });

  test("rejects invalid project approval settings instead of granting the global mode", async () => {
    const { cwd, agentDir, importSession } = await fixture();
    await writeFile(join(agentDir, "config.yml"), "tools:\n  approvalMode: yolo\n");
    await mkdir(join(cwd, ".omp"));
    await writeFile(join(cwd, ".omp", "config.yml"), "tools:\n  approvalMode: unknown\n");
    await expect(importSession()).rejects.toThrow("Invalid OMP tools.approvalMode");
  });
});
