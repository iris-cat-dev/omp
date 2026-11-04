import { describe, expect, test } from "vitest";
import type { OmpMemorySettings } from "@omp-desktop/protocol/messages";

import {
  buildOmpMemorySettingsPatch,
  createOmpMemoryDraft,
  validateOmpMemoryDraft,
  getOmpMnemopiBlockers,
} from "./omp-memory-form";

const SETTINGS: OmpMemorySettings = {
  configPath: "/home/test/.omp/agent/config.yml",
  revision: "revision-1",
  backend: "off",
  supportedBackends: ["off", "local", "hindsight", "mnemopi", "sharpshooter"],
  autolearn: { enabled: false, autoContinue: false },
  local: {
    minRolloutIdleHours: 12,
    maxRolloutAgeDays: 30,
    summaryInjectionTokenLimit: 5000,
  },
  mnemopi: {
    scoping: "per-project",
    autoRecall: true,
    autoRetain: true,
    retainEveryNTurns: 4,
    recallLimit: 8,
    recallContextTurns: 3,
    recallMaxQueryChars: 4000,
    injectionTokenLimit: 5000,
    polyphonicRecall: false,
    enhancedRecall: false,
    proactiveLinking: false,
    noEmbeddings: false,
    embeddingVariant: "en",
    llmMode: "smol",
    dbPath: null,
    embeddingModel: null,
    embeddingApiUrl: null,
    llmBaseUrl: null,
    llmModel: null,
  },
  hindsight: {
    apiUrl: "http://localhost:8888",
    scoping: "per-project-tagged",
    bankId: null,
    autoRecall: true,
    autoRetain: true,
    retainEveryNTurns: 3,
  },
  secretState: {
    hindsightApiToken: { configured: true, source: "config" },
    mnemopiEmbeddingApiKey: { configured: false, source: "none" },
    mnemopiLlmApiKey: { configured: false, source: "none" },
  },
  environmentOverrides: [],
};

describe("OMP memory settings form", () => {
  test("builds a minimal patch and never echoes configured secrets", () => {
    const draft = createOmpMemoryDraft(SETTINGS);
    draft.backend = "mnemopi";
    draft.mnemopiScoping = "global";
    draft.mnemopiRecallLimit = "12";

    expect(buildOmpMemorySettingsPatch(SETTINGS, draft)).toEqual({
      backend: "mnemopi",
      mnemopi: { scoping: "global", recallLimit: 12 },
    });
  });

  test("retains a secret only when the user enters a replacement", () => {
    const draft = createOmpMemoryDraft(SETTINGS);
    expect(draft.hindsightApiToken).toBe("");
    expect(buildOmpMemorySettingsPatch(SETTINGS, draft)).toEqual({});

    draft.hindsightApiToken = "new-token";
    expect(buildOmpMemorySettingsPatch(SETTINGS, draft)).toEqual({
      secrets: { hindsightApiToken: "new-token" },
    });
  });

  test("validates numeric boundaries and service URLs", () => {
    const draft = createOmpMemoryDraft(SETTINGS);
    draft.mnemopiRecallLimit = "0";
    draft.mnemopiRecallContextTurns = "-1";
    draft.hindsightApiUrl = "file:///tmp/memory";
    draft.mnemopiEmbeddingApiUrl = "ftp://memory.example.com";

    expect(validateOmpMemoryDraft(draft)).toMatchObject({
      mnemopiRecallLimit: "positiveInteger",
      mnemopiRecallContextTurns: "nonNegativeInteger",
      hindsightApiUrl: "required",
      mnemopiEmbeddingApiUrl: "required",
    });
  });

  test("reports both core blockers until the user explicitly selects supported memory providers", () => {
    const settings: OmpMemorySettings = { ...SETTINGS, runtime: { profile: "core" } };
    const draft = createOmpMemoryDraft(settings);
    draft.backend = "mnemopi";
    expect(getOmpMnemopiBlockers(settings, draft)).toEqual(["coreEmbeddings", "coreLlm"]);
    draft.mnemopiNoEmbeddings = true;
    expect(getOmpMnemopiBlockers(settings, draft)).toEqual(["coreLlm"]);
    draft.mnemopiLlmMode = "none";
    expect(getOmpMnemopiBlockers(settings, draft)).toEqual([]);
    expect(buildOmpMemorySettingsPatch(settings, draft)).toEqual({
      backend: "mnemopi",
      mnemopi: { noEmbeddings: true, llmMode: "none" },
    });
  });

  test("remote memory selection requires an endpoint and model, while unknown profiles are not advertised as compatible", () => {
    const settings: OmpMemorySettings = { ...SETTINGS, runtime: { profile: "core" } };
    const draft = createOmpMemoryDraft(settings);
    draft.backend = "mnemopi";
    draft.mnemopiNoEmbeddings = true;
    draft.mnemopiLlmMode = "remote";
    expect(getOmpMnemopiBlockers(settings, draft)).toEqual(["remoteUrl", "remoteModel"]);
    draft.mnemopiLlmBaseUrl = "https://memory.example/v1";
    draft.mnemopiLlmModel = "chosen-model";
    expect(getOmpMnemopiBlockers(settings, draft)).toEqual([]);
    expect(getOmpMnemopiBlockers({ ...settings, runtime: { profile: "unknown" } }, draft)).toEqual([
      "profileUnknown",
    ]);
  });

  test("does not mistake an OpenRouter URL with a local embedding model for core-compatible API routing", () => {
    const settings: OmpMemorySettings = { ...SETTINGS, runtime: { profile: "core" } };
    const draft = createOmpMemoryDraft(settings);
    draft.backend = "mnemopi";
    draft.mnemopiLlmMode = "none";
    draft.mnemopiEmbeddingApiUrl = "https://openrouter.ai/api/v1";
    expect(getOmpMnemopiBlockers(settings, draft)).toEqual(["coreEmbeddingModel"]);
    draft.mnemopiEmbeddingModel = "openai/text-embedding-3-small";
    expect(getOmpMnemopiBlockers(settings, draft)).toEqual([]);
    draft.mnemopiEmbeddingModel = "";
    expect(
      getOmpMnemopiBlockers(
        {
          ...settings,
          environmentOverrides: ["mnemopi.embeddingsViaApi"],
        },
        draft,
      ),
    ).toEqual([]);
  });
});
