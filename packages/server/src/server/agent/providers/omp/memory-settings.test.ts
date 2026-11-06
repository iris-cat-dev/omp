import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
  OmpMemorySettingsPatchSchema,
  type OmpMemorySettingsPatch,
} from "@omp-desktop/protocol/messages";
import { parse, parseDocument } from "yaml";

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
      updateOmpMemorySettings(initial.revision, { mnemopi: { useLocalModels: true } }, env),
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

  test("applies local routing atomically without changing the backend, learning choices, data or credentials", async () => {
    const { env, agentDir, configPath } = await createAgentDir(
      "# Host choices stay here\nmodelRoles:\n  default: openai/chat\n  memory: openai/memory\n" +
        "retry:\n  enabled: false\n  fallbackChains:\n    default: [openai/backup]\n    memory: [openai/memory-backup]\n" +
        "memory:\n  backend: hindsight\nautolearn:\n  enabled: true\n  autoContinue: false\n" +
        "mnemopi:\n  autoRecall: false\n  autoRetain: false\n  retainEveryNTurns: 9\n  recallLimit: 13\n" +
        "  enhancedRecall: true\n  dbPath: custom.db\n  embeddingVariant: en\n" +
        "  embeddingApiUrl: https://embeddings.example/v1\n  embeddingApiKey: embedding-secret\n" +
        "  llmMode: remote\n  llmBaseUrl: https://llm.example/v1\n  llmModel: dormant-model\n  llmApiKey: llm-secret\n" +
        "hindsight:\n  apiToken: hindsight-secret\n",
    );
    const dataPath = join(agentDir, "custom.db");
    await writeFile(dataPath, "existing memory data");
    const initial = await readOmpMemorySettings(env);
    const updated = await updateOmpMemorySettings(
      initial.revision,
      {
        mnemopi: {
          useLocalModels: true,
          embeddingVariant: "multilingual",
          embeddingModel: null,
          embeddingApiUrl: null,
          noEmbeddings: false,
          llmMode: "smol",
        },
      },
      env,
    );
    const written = await readFile(configPath, "utf8");
    const native = parse(written);
    expect(updated).toMatchObject({
      backend: "hindsight",
      autolearn: initial.autolearn,
      mnemopi: {
        localModelsConfigured: true,
        autoRecall: false,
        autoRetain: false,
        retainEveryNTurns: 9,
        recallLimit: 13,
        enhancedRecall: true,
        noEmbeddings: false,
        llmMode: "smol",
        embeddingVariant: "multilingual",
        embeddingApiUrl: null,
        llmModel: "dormant-model",
        llmBaseUrl: "https://llm.example/v1",
      },
      secretState: initial.secretState,
    });
    expect(native.modelRoles.default).toBe("openai/chat");
    expect(native.modelRoles.memory).toMatch(/^local\//);
    expect(native.retry).toEqual({
      enabled: false,
      fallbackChains: { default: ["openai/backup"], memory: [] },
    });
    expect(native.mnemopi.embeddingModel).toMatch(/multilingual/);
    expect(native.mnemopi.embeddingApiUrl).toBeUndefined();
    expect(native.mnemopi.embeddingApiKey).toBe("embedding-secret");
    expect(native.mnemopi.llmApiKey).toBe("llm-secret");
    expect(native.hindsight.apiToken).toBe("hindsight-secret");
    expect(written).toContain("# Host choices stay here");
    expect(written).not.toMatch(/useLocalModels|localModelsConfigured/);
    expect(JSON.stringify(updated)).not.toMatch(/embedding-secret|llm-secret|hindsight-secret/);
    await expect(readFile(dataPath, "utf8")).resolves.toBe("existing memory data");
    expect(updated.revision).not.toBe(initial.revision);
    expect((await readOmpMemorySettings(env)).mnemopi.localModelsConfigured).toBe(true);
  });

  test("explicit local choices shadow dormant environment models and remain local across ordinary edits", async () => {
    const { env } = await createAgentDir();
    const effectiveEnv = {
      ...env,
      MNEMOPI_EMBEDDING_MODEL: "openai/text-embedding-remote",
      MNEMOPI_LLM_MODEL: "remote-memory-model",
      MNEMOPI_LLM_BASE_URL: "https://llm.example/v1",
      MNEMOPI_EMBEDDING_API_KEY: "dormant-secret",
      OPENROUTER_BASE_URL: "https://OPENROUTER.AI/api/v1",
      MNEMOPI_EMBEDDINGS_VIA_API: "True",
    };
    const initial = await readOmpMemorySettings(effectiveEnv);
    expect(initial.mnemopi.localModelsConfigured).toBe(false);
    const local = await updateOmpMemorySettings(
      initial.revision,
      {
        mnemopi: { useLocalModels: true },
      },
      effectiveEnv,
    );
    expect(local.mnemopi.localModelsConfigured).toBe(true);
    expect(local.mnemopi.embeddingModel).not.toMatch(/openai|text-embedding/);
    const edited = await updateOmpMemorySettings(
      local.revision,
      {
        mnemopi: { recallLimit: 17, autoRetain: false },
      },
      effectiveEnv,
    );
    expect(edited.mnemopi).toMatchObject({
      localModelsConfigured: true,
      recallLimit: 17,
      autoRetain: false,
    });
    const remote = await updateOmpMemorySettings(
      edited.revision,
      {
        mnemopi: { llmMode: "remote" },
      },
      effectiveEnv,
    );
    expect(remote.mnemopi.localModelsConfigured).toBe(false);
  });

  test.each([
    ["modelRoles", "memory", "openai/memory"],
    ["retry", "fallbackChains", { memory: ["openai/backup"] }],
    ["retry", "fallbackChains", {}],
    ["mnemopi", "noEmbeddings", true],
    ["mnemopi", "llmMode", "none"],
    ["mnemopi", "embeddingModel", "openai/text-embedding-small"],
    ["mnemopi", "embeddingApiUrl", "https://embedding.example/v1"],
  ])("does not report the preset after routing changes at %s.%s", async (section, key, value) => {
    const { env, configPath } = await createAgentDir();
    const initial = await readOmpMemorySettings(env);
    await updateOmpMemorySettings(initial.revision, { mnemopi: { useLocalModels: true } }, env);
    const document = parseDocument(await readFile(configPath, "utf8"));
    document.setIn([section, key], value);
    await writeFile(configPath, document.toString());
    expect((await readOmpMemorySettings(env)).mnemopi.localModelsConfigured).toBe(false);
  });

  test.each([
    ["MNEMOPI_EMBEDDING_API_URL", "https://embedding.example/v1"],
    ["MNEMOPI_EMBEDDING_API_URL", "https://openrouter.ai/api/v1"],
    ["MNEMOPI_EMBEDDINGS_VIA_API", "1"],
    ["MNEMOPI_EMBEDDINGS_VIA_API", "YES"],
    ["OPENROUTER_BASE_URL", "https://embedding.example/v1"],
  ])("refuses remote embedding environment %s without writing", async (name, value) => {
    const raw = "memory:\n  backend: off\n";
    const { env, configPath } = await createAgentDir(raw);
    const initial = await readOmpMemorySettings(env);
    const effectiveEnv = { ...env, [name]: value };
    await expect(
      updateOmpMemorySettings(
        initial.revision,
        {
          backend: "mnemopi",
          mnemopi: { useLocalModels: true },
        },
        effectiveEnv,
      ),
    ).rejects.toThrow(name);
    await expect(readFile(configPath, "utf8")).resolves.toBe(raw);
    expect((await readOmpMemorySettings(env)).revision).toBe(initial.revision);
    const local = await updateOmpMemorySettings(
      initial.revision,
      {
        mnemopi: { useLocalModels: true },
      },
      env,
    );
    expect(local.mnemopi.localModelsConfigured).toBe(true);
    expect((await readOmpMemorySettings(effectiveEnv)).mnemopi.localModelsConfigured).toBe(false);
  });

  test.each([
    "modelRoles: invalid\n",
    "modelRoles: []\n",
    "modelRoles: null\n",
    "retry: null\n",
    "retry: []\n",
    "retry:\n  fallbackChains: null\n",
    "retry:\n  fallbackChains: invalid\n",
    "retry:\n  fallbackChains: []\n",
  ])("refuses malformed role-routing mappings without writing: %s", async (raw) => {
    const { env, configPath } = await createAgentDir(raw);
    const initial = await readOmpMemorySettings(env);
    await expect(
      updateOmpMemorySettings(
        initial.revision,
        {
          mnemopi: { useLocalModels: true },
        },
        env,
      ),
    ).rejects.toThrow("must be a mapping");
    await expect(readFile(configPath, "utf8")).resolves.toBe(raw);
    expect((await readOmpMemorySettings(env)).revision).toBe(initial.revision);
    const ordinary = await updateOmpMemorySettings(
      initial.revision,
      {
        mnemopi: { recallLimit: 11 },
      },
      env,
    );
    expect(ordinary.mnemopi.recallLimit).toBe(11);
  });

  test.each<OmpMemorySettingsPatch["mnemopi"]>([
    { noEmbeddings: true },
    { llmMode: "remote" },
    { llmMode: "none" },
    { embeddingModel: "openai/text-embedding-small" },
    { embeddingApiUrl: "https://embedding.example/v1" },
    { llmBaseUrl: "https://llm.example/v1" },
    { llmModel: "explicit-memory-model" },
    { llmBaseUrl: null },
    { llmModel: null },
  ])("rejects contradictory routing edits without writing: %j", async (routing) => {
    const raw = "memory:\n  backend: off\n";
    const { env, configPath } = await createAgentDir(raw);
    const initial = await readOmpMemorySettings(env);
    await expect(
      updateOmpMemorySettings(
        initial.revision,
        {
          mnemopi: { useLocalModels: true, ...routing },
        },
        env,
      ),
    ).rejects.toThrow("conflict");
    await expect(readFile(configPath, "utf8")).resolves.toBe(raw);
    expect((await readOmpMemorySettings(env)).revision).toBe(initial.revision);
  });

  test("rejects readonly status and false command values at the patch boundary", () => {
    expect(
      OmpMemorySettingsPatchSchema.safeParse({
        mnemopi: { localModelsConfigured: true },
      }).success,
    ).toBe(false);
    expect(
      OmpMemorySettingsPatchSchema.safeParse({
        mnemopi: { useLocalModels: false },
      }).success,
    ).toBe(false);
  });

  test("serializes a preset with other saves and rejects the competing stale revision", async () => {
    const { env, configPath } = await createAgentDir("memory:\n  backend: mnemopi\n");
    const initial = await readOmpMemorySettings(env);
    const results = await Promise.allSettled([
      updateOmpMemorySettings(initial.revision, { mnemopi: { useLocalModels: true } }, env),
      updateOmpMemorySettings(initial.revision, { mnemopi: { llmMode: "remote" } }, env),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: expect.any(OmpMemorySettingsConflictError),
    });
    expect((await readOmpMemorySettings(env)).mnemopi.localModelsConfigured).toBe(true);
    expect(parse(await readFile(configPath, "utf8")).retry.fallbackChains.memory).toEqual([]);
  });

  test.each(["True", " true", "true ", "0", "off"])(
    "does not mistake native false embedding API flag %j for an override",
    async (value) => {
      const { env } = await createAgentDir();
      const effectiveEnv = {
        ...env,
        MNEMOPI_EMBEDDINGS_VIA_API: value,
        OPENROUTER_BASE_URL: "https://proxy.example/OPENROUTER.AI/api/v1",
      };
      const initial = await readOmpMemorySettings(effectiveEnv);
      const saved = await updateOmpMemorySettings(
        initial.revision,
        {
          mnemopi: { useLocalModels: true },
        },
        effectiveEnv,
      );
      expect(saved.mnemopi.localModelsConfigured).toBe(true);
      expect(saved.environmentOverrides).not.toContain("mnemopi.embeddingsViaApi");
    },
  );

  test("validates the entire candidate before committing a preset to an invalid existing config", async () => {
    const raw = "memory:\n  backend: off\nmnemopi:\n  recallLimit: 0\n";
    const { env, configPath } = await createAgentDir(raw);
    const revision = createHash("sha256").update(raw).digest("hex");
    await expect(
      updateOmpMemorySettings(
        revision,
        {
          backend: "mnemopi",
          mnemopi: { useLocalModels: true },
        },
        env,
      ),
    ).rejects.toThrow("mnemopi.recallLimit");
    await expect(readFile(configPath, "utf8")).resolves.toBe(raw);

    const repaired = await updateOmpMemorySettings(
      revision,
      {
        mnemopi: { useLocalModels: true, recallLimit: 12 },
      },
      env,
    );
    expect(repaired).toMatchObject({
      backend: "off",
      mnemopi: { localModelsConfigured: true, recallLimit: 12 },
    });
  });
});
