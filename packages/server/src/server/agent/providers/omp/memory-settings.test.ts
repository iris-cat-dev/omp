import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";

import {
  OmpMemorySettingsConflictError,
  readOmpMemorySettings,
  updateOmpMemorySettings,
} from "./memory-settings.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createAgentDir(config?: string): Promise<{
  agentDir: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
}> {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-memory-settings-"));
  tempDirs.push(agentDir);
  const configPath = join(agentDir, "config.yml");
  if (config !== undefined) await writeFile(configPath, config, "utf8");
  return { agentDir, configPath, env: { PI_CODING_AGENT_DIR: agentDir } };
}

describe("OMP memory settings", () => {
  test("reading absent memory settings does not create a config file", async () => {
    const { env, configPath } = await createAgentDir();

    await readOmpMemorySettings(env);
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("patches only memory fields while preserving comments and unrelated settings", async () => {
    const { env, configPath } = await createAgentDir(
      "# Keep this comment\nmodelRoles:\n  default: openai/gpt-5\nmemory:\n  backend: local\n",
    );
    const initial = await readOmpMemorySettings(env);

    const updated = await updateOmpMemorySettings(
      initial.revision,
      {
        backend: "mnemopi",
        autolearn: { enabled: true },
        mnemopi: { scoping: "per-project", recallLimit: 12 },
      },
      env,
    );

    expect(updated).toMatchObject({
      backend: "mnemopi",
      autolearn: { enabled: true },
      mnemopi: { scoping: "per-project", recallLimit: 12 },
    });
    const written = await readFile(configPath, "utf8");
    expect(written).toContain("# Keep this comment");
    expect(written).toContain("default: openai/gpt-5");
    expect(written).toContain("backend: mnemopi");
  });

  test("keeps configured secrets out of responses and honors Hindsight environment overrides", async () => {
    const { env } = await createAgentDir(
      "memory:\n  backend: hindsight\nhindsight:\n  apiToken: config-secret\n  apiUrl: http://configured:8888\n",
    );
    const settings = await readOmpMemorySettings({
      ...env,
      HINDSIGHT_API_TOKEN: "environment-secret",
      HINDSIGHT_API_URL: "https://memory.example.com",
      HINDSIGHT_SCOPING: "global",
    });

    expect(settings.hindsight).toMatchObject({
      apiUrl: "https://memory.example.com",
      scoping: "global",
    });
    expect(settings.secretState.hindsightApiToken).toEqual({
      configured: true,
      source: "environment",
    });
    expect(JSON.stringify(settings)).not.toContain("config-secret");
    expect(JSON.stringify(settings)).not.toContain("environment-secret");
    expect(settings.environmentOverrides).toContain("hindsight.apiToken");
  });

  test("reports only effective Hindsight environment overrides", async () => {
    const { env } = await createAgentDir(
      "hindsight:\n  apiUrl: https://configured.example.com\n  autoRecall: true\n  autoRetain: true\n",
    );
    const settings = await readOmpMemorySettings({
      ...env,
      HINDSIGHT_API_URL: " ",
      HINDSIGHT_AUTO_RECALL: "false",
      HINDSIGHT_AUTO_RETAIN: "invalid",
      HINDSIGHT_SCOPING: "invalid",
    });

    expect(settings.hindsight).toMatchObject({
      apiUrl: "https://configured.example.com",
      autoRecall: false,
      autoRetain: true,
    });
    expect(settings.environmentOverrides).toEqual(["hindsight.autoRecall"]);
  });

  test("uses Mnemopi environment fallbacks without leaking secrets or persisting service choices", async () => {
    const raw =
      "memory:\n  backend: mnemopi\nmnemopi:\n  embeddingModel: explicit-model\n  llmApiKey: config-key\n";
    const { env, configPath } = await createAgentDir(raw);
    const effectiveEnv = {
      ...env,
      MNEMOPI_EMBEDDING_API_URL: "https://embedding.example/v1",
      MNEMOPI_EMBEDDING_MODEL: "environment-model",
      MNEMOPI_EMBEDDING_API_KEY: "environment-key",
      MNEMOPI_LLM_BASE_URL: "https://llm.example/v1",
      MNEMOPI_LLM_MODEL: "memory-model",
      MNEMOPI_LLM_API_KEY: "ignored-key",
    };
    const initial = await readOmpMemorySettings(effectiveEnv);
    expect(initial.mnemopi).toMatchObject({
      embeddingModel: "explicit-model",
      embeddingApiUrl: "https://embedding.example/v1",
      llmBaseUrl: "https://llm.example/v1",
      llmModel: "memory-model",
    });
    expect(initial.secretState.mnemopiEmbeddingApiKey).toEqual({
      configured: true,
      source: "environment",
    });
    expect(initial.secretState.mnemopiLlmApiKey).toEqual({ configured: true, source: "config" });
    expect(initial.environmentOverrides).not.toContain("mnemopi.embeddingModel");
    expect(initial.environmentOverrides).not.toContain("mnemopi.llmApiKey");
    expect(JSON.stringify(initial)).not.toMatch(/environment-key|config-key|ignored-key/);
    const updated = await updateOmpMemorySettings(
      initial.revision,
      { mnemopi: { noEmbeddings: true, llmMode: "none" } },
      effectiveEnv,
    );
    expect(updated.mnemopi).toMatchObject({ noEmbeddings: true, llmMode: "none" });
    const persisted = await readFile(configPath, "utf8");
    expect(persisted).not.toMatch(/embedding\.example|llm\.example|environment-key|memory-model/);
    expect(persisted).toContain("explicit-model");
    expect(persisted).toContain("config-key");
  });

  test("rejects stale revisions without changing the file", async () => {
    const { env, configPath } = await createAgentDir("memory:\n  backend: local\n");
    const initial = await readOmpMemorySettings(env);
    await writeFile(configPath, "memory:\n  backend: off\n", "utf8");

    await expect(
      updateOmpMemorySettings(initial.revision, { backend: "mnemopi" }, env),
    ).rejects.toBeInstanceOf(OmpMemorySettingsConflictError);
    await expect(readFile(configPath, "utf8")).resolves.toBe("memory:\n  backend: off\n");
  });

  test("rejects malformed managed mappings without changing the file", async () => {
    const raw = "memory: disabled\n";
    const { env, configPath } = await createAgentDir(raw);

    await expect(readOmpMemorySettings(env)).rejects.toThrow("memory must be a mapping");
    await expect(readFile(configPath, "utf8")).resolves.toBe(raw);
  });

  test("removes a configured secret only when explicitly requested", async () => {
    const { env, configPath } = await createAgentDir(
      "hindsight:\n  apiToken: config-secret\n  bankId: project-bank\n",
    );
    const initial = await readOmpMemorySettings(env);

    const updated = await updateOmpMemorySettings(
      initial.revision,
      { secrets: { hindsightApiToken: null } },
      env,
    );

    expect(updated.secretState.hindsightApiToken).toEqual({ configured: false, source: "none" });
    const written = await readFile(configPath, "utf8");
    expect(written).not.toContain("apiToken");
    expect(written).toContain("bankId: project-bank");
  });

  test("updates one secret without changing other configured secrets", async () => {
    const { env, configPath } = await createAgentDir(
      "hindsight:\n  apiToken: old-hindsight\nmnemopi:\n  embeddingApiKey: old-embedding\n",
    );
    const initial = await readOmpMemorySettings(env);

    const updated = await updateOmpMemorySettings(
      initial.revision,
      { secrets: { hindsightApiToken: "new-hindsight" } },
      env,
    );

    const written = await readFile(configPath, "utf8");
    expect(written).toContain("apiToken: new-hindsight");
    expect(written).toContain("embeddingApiKey: old-embedding");
    expect(JSON.stringify(updated)).not.toContain("new-hindsight");
    expect(JSON.stringify(updated)).not.toContain("old-embedding");
  });
});
