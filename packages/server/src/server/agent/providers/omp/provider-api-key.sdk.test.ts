import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { OmpSdkRuntime } from "./sdk-runtime.js";
import { ompHistoryRuntimeSettings } from "./test-utils/history-sdk.js";

test("saves an SDK profile key and refreshes the native catalog without a models.yml", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-provider-key-"));
  const agentDir = join(root, ".omp", "profiles", "work", "agent");
  const runtime = new OmpSdkRuntime({
    logger: createTestLogger(),
    runtimeSettings: {
      ...ompHistoryRuntimeSettings,
      env: {
        HOME: root,
        USERPROFILE: root,
        OMP_CONFIG_DIR: ".omp",
        PI_CONFIG_DIR: ".omp",
        OMP_PROFILE: "work",
        PI_PROFILE: "work",
        OMP_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_DIR: agentDir,
        OMP_AUTH_BROKER_URL: "",
        OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: "",
        MISTRAL_API_KEY: "",
        XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_CACHE_HOME: join(root, "cache"),
      },
    },
  });
  const launch = { cwd: root, noSession: true, providerApiKeyManagement: true } as const;
  const fakeKey = "not-a-real-mistral-key";
  try {
    const session = await runtime.startSession(launch);
    try {
      await expect(session.manageProviderApiKeys!({
        operation: "save", providerId: "openai-codex", apiKey: fakeKey,
      })).resolves.toEqual({ ok: false });
      await expect(session.getAvailableModels()).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ provider: "mistral" })]),
      );
      const result = await session.manageProviderApiKeys!({
        operation: "save", providerId: "mistral", apiKey: fakeKey,
      });
      expect(result).toMatchObject({ ok: true, providers: expect.arrayContaining([
        { id: "mistral", name: "Mistral", authenticated: true },
      ]) });
      expect(JSON.stringify(result)).not.toContain(fakeKey);
      expect(await session.getAvailableModels()).toEqual(
        expect.arrayContaining([expect.objectContaining({ provider: "mistral", id: "mistral-large-4" })]),
      );
    } finally {
      await session.close();
    }
    const reopened = await runtime.startSession(launch);
    try {
      await expect(reopened.manageProviderApiKeys!({ operation: "list" })).resolves.toMatchObject({
        ok: true, providers: expect.arrayContaining([{ id: "mistral", name: "Mistral", authenticated: true }]),
      });
    } finally {
      await reopened.close();
    }
    await expect(readFile(join(agentDir, "models.yml"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
