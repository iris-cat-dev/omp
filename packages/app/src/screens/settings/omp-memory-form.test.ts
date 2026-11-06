import { describe, expect, test } from "vitest";
import type { OmpMemorySettings } from "@omp-desktop/protocol/messages";

import {
  applyOmpMnemopiLocalModelsDraft,
  canUseOmpMnemopiLocalModels,
  changeOmpMemoryDraftField,
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

const LOCAL_MODEL_SETTINGS: OmpMemorySettings = {
  ...SETTINGS,
  backend: "mnemopi",
  runtime: { profile: "full" },
  autolearn: { enabled: true, autoContinue: true },
  mnemopi: {
    ...SETTINGS.mnemopi,
    localModelsConfigured: false,
    noEmbeddings: true,
    llmMode: "remote",
    embeddingModel: "api-embedding-model",
    embeddingApiUrl: "https://embedding.example/v1",
    llmBaseUrl: "https://memory.example/v1",
    llmModel: "remote-memory-model",
  },
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

  test("queues a host-local preset without changing learning, recall, retention, or dormant credentials", () => {
    const original = createOmpMemoryDraft(LOCAL_MODEL_SETTINGS);
    const draft = applyOmpMnemopiLocalModelsDraft(LOCAL_MODEL_SETTINGS, original);

    expect(original.mnemopiUseLocalModels).toBe(false);
    expect(draft.mnemopiUseLocalModels).toBe(true);
    expect(buildOmpMemorySettingsPatch(LOCAL_MODEL_SETTINGS, draft)).toEqual({
      mnemopi: {
        noEmbeddings: false,
        llmMode: "smol",
        embeddingModel: null,
        embeddingApiUrl: null,
        useLocalModels: true,
      },
    });
    expect(draft.autolearnEnabled).toBe(original.autolearnEnabled);
    expect(draft.autolearnAutoContinue).toBe(original.autolearnAutoContinue);
    expect(draft.mnemopiAutoRecall).toBe(original.mnemopiAutoRecall);
    expect(draft.mnemopiAutoRetain).toBe(original.mnemopiAutoRetain);
    expect(draft.mnemopiLlmBaseUrl).toBe(original.mnemopiLlmBaseUrl);
    expect(draft.mnemopiLlmModel).toBe(original.mnemopiLlmModel);
  });

  test("the last local preset choice supersedes earlier unsaved remote routing without deleting stored endpoints", () => {
    let draft = createOmpMemoryDraft(LOCAL_MODEL_SETTINGS);
    draft = changeOmpMemoryDraftField(draft, "mnemopiLlmBaseUrl", "https://other.example/v1");
    draft = changeOmpMemoryDraftField(draft, "mnemopiLlmModel", "other-model");
    draft = changeOmpMemoryDraftField(draft, "mnemopiLlmApiKey", "replacement-key");
    draft = applyOmpMnemopiLocalModelsDraft(LOCAL_MODEL_SETTINGS, draft);

    expect(buildOmpMemorySettingsPatch(LOCAL_MODEL_SETTINGS, draft)).toEqual({
      mnemopi: {
        noEmbeddings: false,
        llmMode: "smol",
        embeddingModel: null,
        embeddingApiUrl: null,
        useLocalModels: true,
      },
      secrets: { mnemopiLlmApiKey: "replacement-key" },
    });
  });

  test("preserves dormant saved LLM values verbatim rather than normalizing them through the preset", () => {
    const settings: OmpMemorySettings = {
      ...LOCAL_MODEL_SETTINGS,
      mnemopi: {
        ...LOCAL_MODEL_SETTINGS.mnemopi,
        llmBaseUrl: " https://memory.example/v1 ",
        llmModel: " remote-memory-model ",
      },
    };
    const draft = applyOmpMnemopiLocalModelsDraft(settings, createOmpMemoryDraft(settings));

    expect(buildOmpMemorySettingsPatch(settings, draft)).toEqual({
      mnemopi: {
        noEmbeddings: false,
        llmMode: "smol",
        embeddingModel: null,
        embeddingApiUrl: null,
        useLocalModels: true,
      },
    });
  });

  test("a subsequent explicit remote route is saved instead of being overwritten by the pending preset", () => {
    let draft = applyOmpMnemopiLocalModelsDraft(
      LOCAL_MODEL_SETTINGS,
      createOmpMemoryDraft(LOCAL_MODEL_SETTINGS),
    );
    draft = changeOmpMemoryDraftField(draft, "mnemopiLlmMode", "remote");
    draft = changeOmpMemoryDraftField(draft, "mnemopiLlmBaseUrl", "https://chosen.example/v1");
    draft = changeOmpMemoryDraftField(draft, "mnemopiLlmModel", "chosen-remote-model");

    expect(buildOmpMemorySettingsPatch(LOCAL_MODEL_SETTINGS, draft)).toEqual({
      mnemopi: {
        noEmbeddings: false,
        embeddingModel: null,
        embeddingApiUrl: null,
        llmBaseUrl: "https://chosen.example/v1",
        llmModel: "chosen-remote-model",
      },
    });
  });

  test.each([
    ["mnemopiNoEmbeddings", true],
    ["mnemopiLlmMode", "remote"],
    ["mnemopiEmbeddingModel", "chosen-api-model"],
    ["mnemopiEmbeddingApiUrl", "https://chosen.example/v1"],
    ["mnemopiLlmBaseUrl", "https://chosen.example/v1"],
    ["mnemopiLlmModel", "chosen-remote-model"],
  ] as const)("a later %s edit cancels the local preset command", (field, value) => {
    const pending = applyOmpMnemopiLocalModelsDraft(
      LOCAL_MODEL_SETTINGS,
      createOmpMemoryDraft(LOCAL_MODEL_SETTINGS),
    );
    const draft = changeOmpMemoryDraftField(pending, field, value);

    expect(draft.mnemopiUseLocalModels).toBe(false);
    expect(draft[field]).toBe(value);
    expect(
      buildOmpMemorySettingsPatch(LOCAL_MODEL_SETTINGS, draft).mnemopi?.useLocalModels,
    ).toBeUndefined();
  });

  test("recall, retention, learning, and embedding-language edits preserve a pending local preset", () => {
    let draft = applyOmpMnemopiLocalModelsDraft(
      LOCAL_MODEL_SETTINGS,
      createOmpMemoryDraft(LOCAL_MODEL_SETTINGS),
    );
    draft = changeOmpMemoryDraftField(draft, "mnemopiAutoRecall", false);
    draft = changeOmpMemoryDraftField(draft, "mnemopiAutoRetain", false);
    draft = changeOmpMemoryDraftField(draft, "mnemopiRetainEveryNTurns", "8");
    draft = changeOmpMemoryDraftField(draft, "autolearnEnabled", false);
    draft = changeOmpMemoryDraftField(draft, "mnemopiEmbeddingVariant", "multilingual");

    expect(draft.mnemopiUseLocalModels).toBe(true);
    expect(buildOmpMemorySettingsPatch(LOCAL_MODEL_SETTINGS, draft)).toEqual({
      autolearn: { enabled: false },
      mnemopi: {
        autoRecall: false,
        autoRetain: false,
        retainEveryNTurns: 8,
        noEmbeddings: false,
        embeddingVariant: "multilingual",
        llmMode: "smol",
        embeddingModel: null,
        embeddingApiUrl: null,
        useLocalModels: true,
      },
    });
  });

  test.each(["off", "local", "hindsight", "sharpshooter"] as const)(
    "switching to %s and back cannot reactivate a pending local preset",
    (backend) => {
      const pending = applyOmpMnemopiLocalModelsDraft(
        LOCAL_MODEL_SETTINGS,
        createOmpMemoryDraft(LOCAL_MODEL_SETTINGS),
      );
      const switched = changeOmpMemoryDraftField(pending, "backend", backend);
      expect(switched.mnemopiUseLocalModels).toBe(false);
      expect(
        buildOmpMemorySettingsPatch(LOCAL_MODEL_SETTINGS, { ...pending, backend }).mnemopi
          ?.useLocalModels,
      ).toBeUndefined();
      const restored = changeOmpMemoryDraftField(switched, "backend", "mnemopi");
      expect(
        buildOmpMemorySettingsPatch(LOCAL_MODEL_SETTINGS, restored).mnemopi?.useLocalModels,
      ).toBeUndefined();
      expect(applyOmpMnemopiLocalModelsDraft(LOCAL_MODEL_SETTINGS, switched)).toBe(switched);
    },
  );

  test.each(["off", "local", "hindsight", "sharpshooter"] as const)(
    "cannot activate Mnemopi when the current draft backend is %s",
    (backend) => {
      const settings: OmpMemorySettings = { ...LOCAL_MODEL_SETTINGS, backend };
      const original = createOmpMemoryDraft(settings);
      const unchanged = applyOmpMnemopiLocalModelsDraft(settings, original);

      expect(unchanged).toBe(original);
      expect(buildOmpMemorySettingsPatch(settings, unchanged)).toEqual({});
      expect(
        buildOmpMemorySettingsPatch(settings, { ...unchanged, mnemopiUseLocalModels: true }),
      ).toEqual({});

      const selected = changeOmpMemoryDraftField(unchanged, "backend", "mnemopi");
      const pending = applyOmpMnemopiLocalModelsDraft(settings, selected);
      expect(buildOmpMemorySettingsPatch(settings, pending)).toEqual({
        backend: "mnemopi",
        mnemopi: {
          noEmbeddings: false,
          llmMode: "smol",
          embeddingModel: null,
          embeddingApiUrl: null,
          useLocalModels: true,
        },
      });
    },
  );

  test("cancel/reload discards a pending command and a saved preset never queues itself again", () => {
    const pending = applyOmpMnemopiLocalModelsDraft(
      LOCAL_MODEL_SETTINGS,
      createOmpMemoryDraft(LOCAL_MODEL_SETTINGS),
    );
    expect(buildOmpMemorySettingsPatch(LOCAL_MODEL_SETTINGS, pending).mnemopi?.useLocalModels).toBe(
      true,
    );

    const canceled = createOmpMemoryDraft(LOCAL_MODEL_SETTINGS);
    expect(canceled.mnemopiUseLocalModels).toBe(false);
    expect(buildOmpMemorySettingsPatch(LOCAL_MODEL_SETTINGS, canceled)).toEqual({});

    const saved: OmpMemorySettings = {
      ...LOCAL_MODEL_SETTINGS,
      revision: "revision-2",
      mnemopi: {
        ...LOCAL_MODEL_SETTINGS.mnemopi,
        localModelsConfigured: true,
        noEmbeddings: false,
        llmMode: "smol",
        embeddingModel: "BAAI/bge-base-en-v1.5",
        embeddingApiUrl: null,
      },
    };
    const reloaded = createOmpMemoryDraft(saved);
    expect(canUseOmpMnemopiLocalModels(saved)).toBe(true);
    expect(reloaded.mnemopiUseLocalModels).toBe(false);
    expect(buildOmpMemorySettingsPatch(saved, reloaded)).toEqual({});
    expect(
      buildOmpMemorySettingsPatch(
        saved,
        changeOmpMemoryDraftField(reloaded, "mnemopiRecallLimit", "10"),
      ),
    ).toEqual({ mnemopi: { recallLimit: 10 } });
  });

  test.each([
    { ...LOCAL_MODEL_SETTINGS, mnemopi: SETTINGS.mnemopi },
    { ...LOCAL_MODEL_SETTINGS, runtime: { profile: "core" as const } },
    { ...LOCAL_MODEL_SETTINGS, runtime: { profile: "unknown" as const } },
    { ...LOCAL_MODEL_SETTINGS, runtime: undefined },
  ])("old/core/unknown hosts cannot offer or emit the preset", (settings) => {
    const draft = createOmpMemoryDraft(settings);
    expect(canUseOmpMnemopiLocalModels(settings)).toBe(false);
    expect(applyOmpMnemopiLocalModelsDraft(settings, draft)).toBe(draft);
    expect(
      buildOmpMemorySettingsPatch(settings, { ...draft, mnemopiUseLocalModels: true }),
    ).toEqual({});
  });
});
