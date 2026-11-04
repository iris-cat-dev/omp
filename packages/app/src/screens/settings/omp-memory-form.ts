import type {
  OmpMemoryBackend,
  OmpMemorySettings,
  OmpMemorySettingsPatch,
} from "@omp-desktop/protocol/messages";

export interface OmpMemoryDraft {
  backend: OmpMemoryBackend;
  autolearnEnabled: boolean;
  autolearnAutoContinue: boolean;
  localMinRolloutIdleHours: string;
  localMaxRolloutAgeDays: string;
  localSummaryInjectionTokenLimit: string;
  mnemopiScoping: OmpMemorySettings["mnemopi"]["scoping"];
  mnemopiAutoRecall: boolean;
  mnemopiAutoRetain: boolean;
  mnemopiRetainEveryNTurns: string;
  mnemopiRecallLimit: string;
  mnemopiRecallContextTurns: string;
  mnemopiRecallMaxQueryChars: string;
  mnemopiInjectionTokenLimit: string;
  mnemopiPolyphonicRecall: boolean;
  mnemopiEnhancedRecall: boolean;
  mnemopiProactiveLinking: boolean;
  mnemopiNoEmbeddings: boolean;
  mnemopiEmbeddingVariant: OmpMemorySettings["mnemopi"]["embeddingVariant"];
  mnemopiLlmMode: OmpMemorySettings["mnemopi"]["llmMode"];
  mnemopiDbPath: string;
  mnemopiEmbeddingModel: string;
  mnemopiEmbeddingApiUrl: string;
  mnemopiEmbeddingApiKey: string;
  mnemopiLlmBaseUrl: string;
  mnemopiLlmModel: string;
  mnemopiLlmApiKey: string;
  hindsightApiUrl: string;
  hindsightApiToken: string;
  hindsightScoping: OmpMemorySettings["hindsight"]["scoping"];
  hindsightBankId: string;
  hindsightAutoRecall: boolean;
  hindsightAutoRetain: boolean;
  hindsightRetainEveryNTurns: string;
}

export type OmpMemoryDraftErrors = Partial<Record<keyof OmpMemoryDraft, string>>;

/** Configuration compatibility only; a running session may still fail to initialize its database/service. */
export function getOmpMnemopiBlockers(
  settings: OmpMemorySettings,
  draft: OmpMemoryDraft,
): string[] {
  if (draft.backend !== "mnemopi") return [];
  const reasons: string[] = [];
  if (!settings.runtime || settings.runtime.profile === "unknown") reasons.push("profileUnknown");
  if (settings.runtime?.profile === "core") {
    if (!draft.mnemopiNoEmbeddings && !draft.mnemopiEmbeddingApiUrl.trim())
      reasons.push("coreEmbeddings");
    if (draft.mnemopiLlmMode === "smol") reasons.push("coreLlm");
    if (
      !draft.mnemopiNoEmbeddings &&
      draft.mnemopiEmbeddingApiUrl.toLowerCase().includes("openrouter.ai") &&
      !draft.mnemopiEmbeddingModel.trim().startsWith("openai/") &&
      !draft.mnemopiEmbeddingModel.trim().includes("text-embedding") &&
      !settings.environmentOverrides.includes("mnemopi.embeddingsViaApi")
    ) {
      reasons.push("coreEmbeddingModel");
    }
  }
  if (draft.mnemopiLlmMode === "remote") {
    if (!draft.mnemopiLlmBaseUrl.trim()) reasons.push("remoteUrl");
    if (!draft.mnemopiLlmModel.trim()) reasons.push("remoteModel");
  }
  return reasons;
}

export function createOmpMemoryDraft(settings: OmpMemorySettings): OmpMemoryDraft {
  return {
    backend: settings.backend,
    autolearnEnabled: settings.autolearn.enabled,
    autolearnAutoContinue: settings.autolearn.autoContinue,
    localMinRolloutIdleHours: String(settings.local.minRolloutIdleHours),
    localMaxRolloutAgeDays: String(settings.local.maxRolloutAgeDays),
    localSummaryInjectionTokenLimit: String(settings.local.summaryInjectionTokenLimit),
    mnemopiScoping: settings.mnemopi.scoping,
    mnemopiAutoRecall: settings.mnemopi.autoRecall,
    mnemopiAutoRetain: settings.mnemopi.autoRetain,
    mnemopiRetainEveryNTurns: String(settings.mnemopi.retainEveryNTurns),
    mnemopiRecallLimit: String(settings.mnemopi.recallLimit),
    mnemopiRecallContextTurns: String(settings.mnemopi.recallContextTurns),
    mnemopiRecallMaxQueryChars: String(settings.mnemopi.recallMaxQueryChars),
    mnemopiInjectionTokenLimit: String(settings.mnemopi.injectionTokenLimit),
    mnemopiPolyphonicRecall: settings.mnemopi.polyphonicRecall,
    mnemopiEnhancedRecall: settings.mnemopi.enhancedRecall,
    mnemopiProactiveLinking: settings.mnemopi.proactiveLinking,
    mnemopiNoEmbeddings: settings.mnemopi.noEmbeddings,
    mnemopiEmbeddingVariant: settings.mnemopi.embeddingVariant,
    mnemopiLlmMode: settings.mnemopi.llmMode,
    mnemopiDbPath: settings.mnemopi.dbPath ?? "",
    mnemopiEmbeddingModel: settings.mnemopi.embeddingModel ?? "",
    mnemopiEmbeddingApiUrl: settings.mnemopi.embeddingApiUrl ?? "",
    mnemopiEmbeddingApiKey: "",
    mnemopiLlmBaseUrl: settings.mnemopi.llmBaseUrl ?? "",
    mnemopiLlmModel: settings.mnemopi.llmModel ?? "",
    mnemopiLlmApiKey: "",
    hindsightApiUrl: settings.hindsight.apiUrl,
    hindsightApiToken: "",
    hindsightScoping: settings.hindsight.scoping,
    hindsightBankId: settings.hindsight.bankId ?? "",
    hindsightAutoRecall: settings.hindsight.autoRecall,
    hindsightAutoRetain: settings.hindsight.autoRetain,
    hindsightRetainEveryNTurns: String(settings.hindsight.retainEveryNTurns),
  };
}

function parseNumber(
  raw: string,
  options: { integer: boolean; allowZero: boolean },
): number | null {
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) return null;
  if (options.integer && !Number.isInteger(value)) return null;
  if (options.allowZero ? value < 0 : value <= 0) return null;
  return value;
}
function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function validateOmpMemoryDraft(draft: OmpMemoryDraft): OmpMemoryDraftErrors {
  const errors: OmpMemoryDraftErrors = {};
  const numericFields: Array<{
    key: keyof OmpMemoryDraft;
    integer: boolean;
    allowZero: boolean;
  }> = [
    { key: "localMinRolloutIdleHours", integer: false, allowZero: true },
    { key: "localMaxRolloutAgeDays", integer: false, allowZero: false },
    { key: "localSummaryInjectionTokenLimit", integer: true, allowZero: false },
    { key: "mnemopiRetainEveryNTurns", integer: true, allowZero: false },
    { key: "mnemopiRecallLimit", integer: true, allowZero: false },
    { key: "mnemopiRecallContextTurns", integer: true, allowZero: true },
    { key: "mnemopiRecallMaxQueryChars", integer: true, allowZero: false },
    { key: "mnemopiInjectionTokenLimit", integer: true, allowZero: false },
    { key: "hindsightRetainEveryNTurns", integer: true, allowZero: false },
  ];
  for (const field of numericFields) {
    const raw = draft[field.key];
    if (typeof raw !== "string" || parseNumber(raw, field) === null) {
      errors[field.key] = field.allowZero ? "nonNegativeInteger" : "positiveInteger";
    }
  }
  if (!isHttpUrl(draft.hindsightApiUrl)) errors.hindsightApiUrl = "required";
  if (draft.mnemopiEmbeddingApiUrl && !isHttpUrl(draft.mnemopiEmbeddingApiUrl)) {
    errors.mnemopiEmbeddingApiUrl = "required";
  }
  if (draft.mnemopiLlmBaseUrl && !isHttpUrl(draft.mnemopiLlmBaseUrl)) {
    errors.mnemopiLlmBaseUrl = "required";
  }
  return errors;
}

function optionalStringPatch(current: string | null, draft: string): string | null | undefined {
  const next = draft.trim() || null;
  return next === current ? undefined : next;
}

function assignChanged<T extends object, K extends keyof T>(
  target: Partial<T>,
  key: K,
  current: T[K],
  next: T[K],
): void {
  if (current !== next) target[key] = next;
}

export function buildOmpMemorySettingsPatch(
  settings: OmpMemorySettings,
  draft: OmpMemoryDraft,
): OmpMemorySettingsPatch {
  const patch: OmpMemorySettingsPatch = {};
  if (settings.backend !== draft.backend) patch.backend = draft.backend;

  const autolearn: NonNullable<OmpMemorySettingsPatch["autolearn"]> = {};
  assignChanged(autolearn, "enabled", settings.autolearn.enabled, draft.autolearnEnabled);
  assignChanged(
    autolearn,
    "autoContinue",
    settings.autolearn.autoContinue,
    draft.autolearnAutoContinue,
  );
  if (Object.keys(autolearn).length > 0) patch.autolearn = autolearn;

  const local: NonNullable<OmpMemorySettingsPatch["local"]> = {};
  assignChanged(
    local,
    "minRolloutIdleHours",
    settings.local.minRolloutIdleHours,
    Number(draft.localMinRolloutIdleHours),
  );
  assignChanged(
    local,
    "maxRolloutAgeDays",
    settings.local.maxRolloutAgeDays,
    Number(draft.localMaxRolloutAgeDays),
  );
  assignChanged(
    local,
    "summaryInjectionTokenLimit",
    settings.local.summaryInjectionTokenLimit,
    Number(draft.localSummaryInjectionTokenLimit),
  );
  if (Object.keys(local).length > 0) patch.local = local;

  const mnemopi: NonNullable<OmpMemorySettingsPatch["mnemopi"]> = {};
  assignChanged(mnemopi, "scoping", settings.mnemopi.scoping, draft.mnemopiScoping);
  assignChanged(mnemopi, "autoRecall", settings.mnemopi.autoRecall, draft.mnemopiAutoRecall);
  assignChanged(mnemopi, "autoRetain", settings.mnemopi.autoRetain, draft.mnemopiAutoRetain);
  assignChanged(
    mnemopi,
    "retainEveryNTurns",
    settings.mnemopi.retainEveryNTurns,
    Number(draft.mnemopiRetainEveryNTurns),
  );
  assignChanged(
    mnemopi,
    "recallLimit",
    settings.mnemopi.recallLimit,
    Number(draft.mnemopiRecallLimit),
  );
  assignChanged(
    mnemopi,
    "recallContextTurns",
    settings.mnemopi.recallContextTurns,
    Number(draft.mnemopiRecallContextTurns),
  );
  assignChanged(
    mnemopi,
    "recallMaxQueryChars",
    settings.mnemopi.recallMaxQueryChars,
    Number(draft.mnemopiRecallMaxQueryChars),
  );
  assignChanged(
    mnemopi,
    "injectionTokenLimit",
    settings.mnemopi.injectionTokenLimit,
    Number(draft.mnemopiInjectionTokenLimit),
  );
  assignChanged(
    mnemopi,
    "polyphonicRecall",
    settings.mnemopi.polyphonicRecall,
    draft.mnemopiPolyphonicRecall,
  );
  assignChanged(
    mnemopi,
    "enhancedRecall",
    settings.mnemopi.enhancedRecall,
    draft.mnemopiEnhancedRecall,
  );
  assignChanged(
    mnemopi,
    "proactiveLinking",
    settings.mnemopi.proactiveLinking,
    draft.mnemopiProactiveLinking,
  );
  assignChanged(mnemopi, "noEmbeddings", settings.mnemopi.noEmbeddings, draft.mnemopiNoEmbeddings);
  assignChanged(
    mnemopi,
    "embeddingVariant",
    settings.mnemopi.embeddingVariant,
    draft.mnemopiEmbeddingVariant,
  );
  assignChanged(mnemopi, "llmMode", settings.mnemopi.llmMode, draft.mnemopiLlmMode);
  for (const [key, current, next] of [
    ["dbPath", settings.mnemopi.dbPath, draft.mnemopiDbPath],
    ["embeddingModel", settings.mnemopi.embeddingModel, draft.mnemopiEmbeddingModel],
    ["embeddingApiUrl", settings.mnemopi.embeddingApiUrl, draft.mnemopiEmbeddingApiUrl],
    ["llmBaseUrl", settings.mnemopi.llmBaseUrl, draft.mnemopiLlmBaseUrl],
    ["llmModel", settings.mnemopi.llmModel, draft.mnemopiLlmModel],
  ] as const) {
    const value = optionalStringPatch(current, next);
    if (value !== undefined) mnemopi[key] = value;
  }
  if (Object.keys(mnemopi).length > 0) patch.mnemopi = mnemopi;

  const hindsight: NonNullable<OmpMemorySettingsPatch["hindsight"]> = {};
  assignChanged(hindsight, "apiUrl", settings.hindsight.apiUrl, draft.hindsightApiUrl.trim());
  assignChanged(hindsight, "scoping", settings.hindsight.scoping, draft.hindsightScoping);
  assignChanged(hindsight, "autoRecall", settings.hindsight.autoRecall, draft.hindsightAutoRecall);
  assignChanged(hindsight, "autoRetain", settings.hindsight.autoRetain, draft.hindsightAutoRetain);
  assignChanged(
    hindsight,
    "retainEveryNTurns",
    settings.hindsight.retainEveryNTurns,
    Number(draft.hindsightRetainEveryNTurns),
  );
  const bankId = optionalStringPatch(settings.hindsight.bankId, draft.hindsightBankId);
  if (bankId !== undefined) hindsight.bankId = bankId;
  if (Object.keys(hindsight).length > 0) patch.hindsight = hindsight;

  const secrets: NonNullable<OmpMemorySettingsPatch["secrets"]> = {};
  if (draft.hindsightApiToken.trim()) secrets.hindsightApiToken = draft.hindsightApiToken.trim();
  if (draft.mnemopiEmbeddingApiKey.trim()) {
    secrets.mnemopiEmbeddingApiKey = draft.mnemopiEmbeddingApiKey.trim();
  }
  if (draft.mnemopiLlmApiKey.trim()) secrets.mnemopiLlmApiKey = draft.mnemopiLlmApiKey.trim();
  if (Object.keys(secrets).length > 0) patch.secrets = secrets;
  return patch;
}
