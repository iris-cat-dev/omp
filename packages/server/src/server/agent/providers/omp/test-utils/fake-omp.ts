import type {
  OmpRuntime,
  OmpRuntimeLaunch,
  OmpRuntimeSession,
  OmpStartSessionInput,
  OmpUserMessageOptions,
  OmpBranchMessage,
} from "../runtime.js";
import type {
  OmpAbortAndRestoreQueueResult,
  OmpApprovalMode,
  OmpExtensionUiResponse,
  OmpRpcHostToolDefinition,
  OmpRpcHostToolResult,
  OmpRpcHostToolUpdate,
  OmpAgentMessage,
  OmpFastModeResult,
  OmpFastModeSelection,
  OmpLoginProvider,
  OmpModel,
  OmpPromptAck,
  OmpRpcSlashCommand,
  OmpRuntimeEvent,
  OmpSessionState,
  OmpSessionStats,
  OmpThinkingLevel,
} from "../rpc-types.js";
import {
  OmpSubagentSnapshotSchema,
  OmpSubagentMessagesSelectorSchema,
  parseOmpSubagentMessagesResult,
  type OmpSubagentSnapshot,
  type OmpSubagentMessagesSelector,
  type OmpSubagentMessagesResult,
} from "../subagent-rpc.js";
import { buildOmpLaunch } from "../runtime.js";
import { resolveOmpApprovalMode } from "../provider-config.js";
import { ProxyPolicySchema, type ProxyPolicy } from "@omp-desktop/protocol/provider-config";

type FakeOmpSubagentSubscriptionLevel = "off" | "progress" | "events";

export interface FakeOmpLoginFlow {
  url: string;
  launchUrl?: string;
  instructions?: string;
}

function getDraftModel(input: OmpStartSessionInput): OmpModel | null {
  if (!input.noSession || !input.model) return null;
  const separator = input.model.indexOf("/");
  if (separator <= 0) return null;
  return { provider: input.model.slice(0, separator), id: input.model.slice(separator + 1) };
}

export class FakeOmp implements OmpRuntime {
  readonly recordedLaunches: OmpRuntimeLaunch[] = [];
  private readonly sessions: FakeOmpSession[] = [];
  private readonly command: [string, ...string[]];
  private readonly queuedCommands: OmpRpcSlashCommand[][] = [];
  private readonly queuedModels: OmpModel[][] = [];
  private readonly queuedLoginProviders: OmpLoginProvider[][] = [];
  private readonly queuedLoginFlows: FakeOmpLoginFlow[] = [];
  private fastModeSupported = true;
  private ultrafastSupported = false;
  private initialFastModeTier: string | null | undefined;
  private initialModel: OmpModel | null = null;
  private initialStats: OmpSessionStats | null = null;
  private initialActiveCredential: OmpSessionState["activeCredential"];
  private readonly queuedStartErrors: Error[] = [];

  constructor(command: [string, ...string[]] = ["omp"]) {
    this.command = command;
  }

  async startSession(input: OmpStartSessionInput): Promise<FakeOmpSession> {
    const startError = this.queuedStartErrors.shift();
    if (startError) throw startError;
    const launch = buildOmpLaunch({
      command: this.command,
      session: input,
    });
    this.recordedLaunches.push(launch);
    const session = new FakeOmpSession(launch);
    if (input.proxyPolicy) await session.setProxyPolicy(input.proxyPolicy);
    session.state = {
      ...session.state,
      model: this.initialModel ?? getDraftModel(input),
      activeCredential: this.initialActiveCredential,
    };
    session.nativeUltrafastSupported = this.ultrafastSupported;
    if (this.initialFastModeTier !== undefined) {
      const tier = this.initialFastModeTier;
      session.nativeOpenAITier = tier;
      session.state = {
        ...session.state,
        fastModeTier: tier,
        fastModeEnabled: tier === "priority" || tier === "ultrafast",
        fastModeActive:
          tier === "priority" ||
          (tier === "ultrafast" && this.initialModel?.serviceTiers?.includes("ultrafast") === true),
      };
    }
    session.state.ultrafastSupported =
      this.ultrafastSupported && this.initialModel?.serviceTiers?.includes("ultrafast") === true;
    if (!this.fastModeSupported) {
      session.state = { ...session.state, fastModeEnabled: undefined, fastModeActive: undefined };
    }
    if (this.initialStats) {
      session.stats = this.initialStats;
    }
    session.commands = this.queuedCommands.shift() ?? [];
    session.models = this.queuedModels.shift() ?? [];
    session.loginProviders = this.queuedLoginProviders.shift() ?? [];
    session.loginFlow = this.queuedLoginFlows.shift();
    this.sessions.push(session);
    return session;
  }

  queueCommands(commands: OmpRpcSlashCommand[]): void {
    this.queuedCommands.push(commands);
  }
  queueModels(models: OmpModel[]): void {
    this.queuedModels.push(models);
  }

  queueLoginProviders(providers: OmpLoginProvider[]): void {
    this.queuedLoginProviders.push(providers);
  }
  setFastModeSupported(supported: boolean): void {
    this.fastModeSupported = supported;
  }
  setUltrafastSupported(supported: boolean): void {
    this.ultrafastSupported = supported;
  }
  setInitialFastModeTier(tier: string | null | undefined): void {
    this.initialFastModeTier = tier;
  }
  setInitialModel(model: OmpModel | null): void {
    this.initialModel = model;
  }
  setInitialActiveCredential(activeCredential: OmpSessionState["activeCredential"]): void {
    this.initialActiveCredential = activeCredential;
  }
  setInitialStats(stats: OmpSessionStats): void {
    this.initialStats = stats;
  }
  queueLoginFlow(flow: FakeOmpLoginFlow): void {
    this.queuedLoginFlows.push(flow);
  }

  failNextStart(error: Error): void {
    this.queuedStartErrors.push(error);
  }

  latestSession(): FakeOmpSession {
    const session = this.sessions.at(-1);
    if (!session) {
      throw new Error("FakeOmp has no sessions");
    }
    return session;
  }
}

export class FakeOmpSession implements OmpRuntimeSession {
  readonly prompts: Array<{ message: string; imageCount: number }> = [];
  readonly promptUserMessageOptions: OmpUserMessageOptions[] = [];
  readonly steerUserMessageOptions: OmpUserMessageOptions[] = [];
  readonly followUpUserMessageOptions: OmpUserMessageOptions[] = [];
  readonly compactRequests: Array<{ customInstructions?: string }> = [];
  readonly setAutoCompactionRequests: boolean[] = [];
  readonly subagentMessageRequests: OmpSubagentMessagesSelector[] = [];
  readonly setModelRequests: Array<{ provider: string; modelId: string }> = [];
  readonly setThinkingLevelRequests: OmpThinkingLevel[] = [];
  readonly setFastModeRequests: boolean[] = [];
  proxyPolicy: ProxyPolicy = { enabled: false };
  readonly setFastModeTierRequests: OmpFastModeSelection[] = [];
  nativeUltrafastSupported = false;
  nativeOpenAITier: string | null | undefined;
  readonly handoffRequests: Array<{ customInstructions?: string }> = [];
  readonly steerRequests: Array<{ message: string; imageCount: number }> = [];
  readonly followUpRequests: Array<{ message: string; imageCount: number }> = [];
  readonly hostToolSetRequests: OmpRpcHostToolDefinition[][] = [];
  readonly hostToolResults: OmpRpcHostToolResult[] = [];
  readonly hostToolUpdates: OmpRpcHostToolUpdate[] = [];
  getStateRequestCount = 0;
  abortRequested = false;
  abortError: Error | null = null;
  abortAndRestoreQueueRequested = false;
  restoredQueue: OmpAbortAndRestoreQueueResult = { steering: [], followUp: [] };
  onAbort: (() => void) | null = null;
  readonly canceledSubagentIds: string[] = [];
  cancelSubagentError: Error | null = null;
  cancelSubagentResult = true;
  readonly canceledExtensionUiRequests: string[] = [];
  readonly extensionUiResponses: Array<{
    id: string;
    response: OmpExtensionUiResponse;
  }> = [];
  setModelResult: OmpModel | null = null;
  models: OmpModel[] = [];
  loginProviders: OmpLoginProvider[] = [];
  loginFlow: FakeOmpLoginFlow | undefined;
  readonly loginRequests: string[] = [];
  messages: OmpAgentMessage[] = [];
  stats: OmpSessionStats = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
  commands: OmpRpcSlashCommand[] = [];
  subagents: OmpSubagentSnapshot[] = [];
  compactError: Error | null = null;
  emitCompactStart = true;
  emitCompactEnd = true;
  getStateError: Error | null = null;
  setApprovalModeError: Error | null = null;
  promptAck: OmpPromptAck = {};
  branchResponse: { text?: string; cancelled?: boolean } = { text: "" };
  branchMessages: OmpBranchMessage[] = [];
  branchMessagesError: Error | null = null;
  branchMessageLookups = 0;
  readonly branchRequests: string[] = [];
  activeBranchEntryId?: string;
  closed = false;
  state: OmpSessionState;

  private readonly subscribers = new Set<(event: OmpRuntimeEvent) => void>();
  private readonly stateReports: OmpSessionState[] = [];
  private readonly stateRequestWaiters: Array<{ count: number; resolve: () => void }> = [];
  private readonly hostToolResultWaiters: Array<(result: OmpRpcHostToolResult) => void> = [];
  private readonly promptWaiters: Array<() => void> = [];
  private readonly subagentMessageResults = new Map<string, OmpSubagentMessagesResult[]>();
  private nextHeldPrompt: { promise: Promise<void>; reject: (error: Error) => void } | null = null;
  private activeHeldPrompt: { promise: Promise<void>; reject: (error: Error) => void } | null =
    null;
  private releaseLogin: (() => void) | null = null;

  constructor(launch: OmpRuntimeLaunch) {
    this.state = {
      model: null,
      thinkingLevel: "medium",
      approvalMode: resolveOmpApprovalMode(launch.modeId ?? "full"),
      isStreaming: false,
      isCompacting: false,
      autoCompactionEnabled: true,
      fastModeEnabled: false,
      fastModeActive: false,
      sessionFile: launch.session ?? "/tmp/omp-session",
      sessionId: "omp-session-1",
      messageCount: 0,
      queuedMessageCount: 0,
    };
  }

  onEvent(callback: (event: OmpRuntimeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
    options?: OmpUserMessageOptions,
  ): Promise<OmpPromptAck> {
    // The CLI runtime always sends streamingBehavior "steer": a busy OMP session admits
    // the prompt into its live run instead of throwing AgentBusyError.
    this.prompts.push({ message, imageCount: images?.length ?? 0 });
    this.promptUserMessageOptions.push(options ?? {});
    this.promptWaiters.shift()?.();
    const heldPrompt = this.nextHeldPrompt;
    if (heldPrompt) {
      this.nextHeldPrompt = null;
      this.activeHeldPrompt = heldPrompt;
      try {
        await heldPrompt.promise;
      } finally {
        if (this.activeHeldPrompt === heldPrompt) {
          this.activeHeldPrompt = null;
        }
      }
    }
    return this.promptAck;
  }

  nextPrompt(): Promise<void> {
    return new Promise((resolve) => this.promptWaiters.push(resolve));
  }

  holdNextPrompt(): void {
    if (this.nextHeldPrompt || this.activeHeldPrompt) {
      throw new Error("FakeOmp already has a held prompt");
    }
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    this.nextHeldPrompt = { promise, reject };
  }

  async failHeldPrompt(error: Error): Promise<void> {
    const heldPrompt = this.activeHeldPrompt ?? this.nextHeldPrompt;
    if (!heldPrompt) {
      throw new Error("FakeOmp has no held prompt");
    }
    heldPrompt.reject(error);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async compact(customInstructions?: string): Promise<void> {
    this.compactRequests.push(customInstructions === undefined ? {} : { customInstructions });
    if (this.emitCompactStart) {
      this.emit({ type: "compaction_start", reason: "manual" });
    }
    if (this.emitCompactEnd) {
      this.emit({ type: "compaction_end", reason: "manual" });
    }
    if (this.compactError) {
      throw this.compactError;
    }
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    this.setAutoCompactionRequests.push(enabled);
    this.state = {
      ...this.state,
      autoCompactionEnabled: enabled,
    };
  }

  async abort(): Promise<void> {
    if (this.abortError) {
      throw this.abortError;
    }
    this.abortRequested = true;
    this.onAbort?.();
  }

  async abortAndRestoreQueue(): Promise<OmpAbortAndRestoreQueueResult> {
    this.abortAndRestoreQueueRequested = true;
    const restored = this.restoredQueue;
    this.restoredQueue = { steering: [], followUp: [] };
    await this.abort();
    return restored;
  }

  async cancelSubagent(subagentId: string): Promise<boolean> {
    this.canceledSubagentIds.push(subagentId);
    if (this.cancelSubagentError) throw this.cancelSubagentError;
    return this.cancelSubagentResult;
  }

  async getState(): Promise<OmpSessionState> {
    this.getStateRequestCount += 1;
    for (const waiter of this.stateRequestWaiters.splice(0)) {
      if (this.getStateRequestCount >= waiter.count) waiter.resolve();
      else this.stateRequestWaiters.push(waiter);
    }
    if (this.getStateError) {
      throw this.getStateError;
    }
    const report = this.stateReports.shift();
    if (report) {
      this.state = report;
    }
    return this.state;
  }

  queueStateReports(states: OmpSessionState[]): void {
    this.stateReports.push(...states);
  }

  waitForStateRequests(count: number): Promise<void> {
    if (this.getStateRequestCount >= count) return Promise.resolve();
    return new Promise((resolve) => this.stateRequestWaiters.push({ count, resolve }));
  }

  async getMessages(): Promise<OmpAgentMessage[]> {
    return this.messages;
  }

  async getAvailableModels(_timeoutMs?: number | null): Promise<OmpModel[]> {
    return this.models;
  }
  async getServiceTierCapabilities() {
    return {
      fastMode: typeof this.state.fastModeEnabled === "boolean",
      ultrafast: this.nativeUltrafastSupported,
    };
  }
  async getLoginProviders(): Promise<OmpLoginProvider[]> {
    return this.loginProviders;
  }

  async login(providerId: string): Promise<void> {
    this.loginRequests.push(providerId);
    if (!this.loginFlow) return;
    this.emit({
      type: "extension_ui_request",
      id: `login-${providerId}`,
      method: "open_url",
      ...this.loginFlow,
    });
    await new Promise<void>((resolve) => {
      this.releaseLogin = resolve;
    });
  }

  async setApprovalMode(mode: OmpApprovalMode): Promise<OmpApprovalMode> {
    if (this.setApprovalModeError) throw this.setApprovalModeError;
    this.state = { ...this.state, approvalMode: mode };
    return mode;
  }

  async setModel(provider: string, modelId: string): Promise<OmpModel> {
    this.setModelRequests.push({ provider, modelId });
    if (!this.setModelResult) {
      throw new Error("FakeOmp setModel requires setModelResult to be scripted");
    }
    const model = this.setModelResult;
    const openaiFamily = model.provider === "openai" || model.provider === "openai-codex";
    const tier = openaiFamily ? this.nativeOpenAITier : undefined;
    this.state = {
      ...this.state,
      model,
      ultrafastSupported:
        this.nativeUltrafastSupported && model.serviceTiers?.includes("ultrafast") === true,
      fastModeTier: tier,
      ...(this.nativeOpenAITier !== undefined
        ? {
            fastModeEnabled: openaiFamily && (tier === "priority" || tier === "ultrafast"),
            fastModeActive:
              openaiFamily &&
              (tier === "priority" ||
                (tier === "ultrafast" && model.serviceTiers?.includes("ultrafast") === true)),
          }
        : {}),
    };
    return this.setModelResult;
  }

  async setFastMode(enabled: boolean): Promise<OmpFastModeResult> {
    if (this.state.fastModeEnabled === undefined) {
      throw new Error("FakeOmp set_fast_mode is unsupported");
    }
    this.setFastModeRequests.push(enabled);
    let tier: OmpFastModeResult["tier"];
    if (this.state.fastModeTier !== undefined) tier = enabled ? "priority" : null;
    if (tier !== undefined) this.nativeOpenAITier = tier;
    this.state = {
      ...this.state,
      fastModeEnabled: enabled,
      fastModeActive: enabled,
      fastModeTier: tier,
    };
    return { enabled, active: enabled, ...(tier !== undefined ? { tier } : {}) };
  }

  async setFastModeTier(
    value: OmpFastModeSelection,
    model: { provider: string; id: string },
  ): Promise<OmpFastModeResult> {
    if (
      !this.state.ultrafastSupported ||
      this.state.model?.provider !== model.provider ||
      this.state.model.id !== model.id
    )
      throw new Error("OMP Ultrafast is unavailable for the current model");
    if (value === "on" && !this.state.model.serviceTiers?.includes("priority")) {
      throw new Error("OMP Fast is unavailable for the current model");
    }
    this.setFastModeTierRequests.push(value);
    const selectedTier = value === "on" ? "priority" : value;
    const tier = selectedTier === "off" ? null : selectedTier;
    this.nativeOpenAITier = tier;
    this.state = {
      ...this.state,
      fastModeTier: tier,
      fastModeEnabled: value !== "off",
      fastModeActive: value !== "off",
    };
    return { enabled: value !== "off", active: value !== "off", tier };
  }

  async setProxyPolicy(policy: ProxyPolicy): Promise<void> {
    this.proxyPolicy = ProxyPolicySchema.parse(policy);
  }

  async setThinkingLevel(level: OmpThinkingLevel): Promise<void> {
    this.setThinkingLevelRequests.push(level);
  }

  async getSessionStats(): Promise<OmpSessionStats> {
    return this.stats;
  }

  async setSubagentSubscription(_level: FakeOmpSubagentSubscriptionLevel): Promise<void> {}

  async setHostTools(tools: OmpRpcHostToolDefinition[]): Promise<string[]> {
    this.hostToolSetRequests.push(tools);
    return tools.map((tool) => tool.name);
  }

  async branch(entryId: string): Promise<{ text: string }> {
    this.branchRequests.push(entryId);
    if (this.branchResponse.cancelled === true) {
      throw new Error("OMP branch was cancelled");
    }
    if (typeof this.branchResponse.text !== "string") {
      throw new Error("FakeOmp branch response requires text");
    }
    this.activeBranchEntryId = undefined;
    return { text: this.branchResponse.text };
  }

  async getBranchMessages(): Promise<OmpBranchMessage[]> {
    this.branchMessageLookups += 1;
    if (this.branchMessagesError) throw this.branchMessagesError;
    return this.branchMessages;
  }

  async steer(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
    options?: OmpUserMessageOptions,
  ): Promise<void> {
    this.steerRequests.push({ message, imageCount: images?.length ?? 0 });
    this.steerUserMessageOptions.push(options ?? {});
  }

  followUp(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
    options?: OmpUserMessageOptions,
  ): void {
    this.followUpRequests.push({ message, imageCount: images?.length ?? 0 });
    this.followUpUserMessageOptions.push(options ?? {});
  }

  sendHostToolResult(result: OmpRpcHostToolResult): void {
    this.hostToolResults.push(result);
    this.hostToolResultWaiters.shift()?.(result);
  }

  sendHostToolUpdate(update: OmpRpcHostToolUpdate): void {
    this.hostToolUpdates.push(update);
  }

  nextHostToolResult(): Promise<OmpRpcHostToolResult> {
    return new Promise((resolve) => this.hostToolResultWaiters.push(resolve));
  }

  async getSubagents(): Promise<OmpSubagentSnapshot[]> {
    return this.subagents.map((snapshot) => OmpSubagentSnapshotSchema.parse(snapshot));
  }

  async getSubagentMessages(
    selector: OmpSubagentMessagesSelector,
  ): Promise<OmpSubagentMessagesResult> {
    const validated = OmpSubagentMessagesSelectorSchema.parse(selector);
    this.subagentMessageRequests.push(validated);
    const snapshot = this.subagents.find((child) => child.id === validated.subagentId);
    const key = validated.subagentId
      ? (snapshot?.sessionFile ?? validated.subagentId)
      : validated.sessionFile!;
    const results = this.subagentMessageResults.get(key);
    const result = results?.shift();
    if (!result) {
      throw new Error(`FakeOmp has no subagent messages queued for ${key}`);
    }
    return parseOmpSubagentMessagesResult(validated, result);
  }

  queueSubagentMessages(result: OmpSubagentMessagesResult): void {
    const results = this.subagentMessageResults.get(result.sessionFile) ?? [];
    results.push(result);
    this.subagentMessageResults.set(result.sessionFile, results);
  }

  async getCommands(): Promise<OmpRpcSlashCommand[]> {
    return this.commands;
  }

  async handoff(customInstructions?: string): Promise<void> {
    this.handoffRequests.push(customInstructions ? { customInstructions } : {});
  }

  respondToExtensionUiRequest(id: string, response: OmpExtensionUiResponse): void {
    this.extensionUiResponses.push({ id, response });
  }

  cancelExtensionUiRequest(id: string): void {
    this.canceledExtensionUiRequests.push(id);
    this.respondToExtensionUiRequest(id, { cancelled: true });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.releaseLogin?.();
    this.releaseLogin = null;
  }

  emit(event: OmpRuntimeEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  finishTurn(message: OmpAgentMessage = { role: "assistant", content: [] }): void {
    this.messages = [...this.messages, message];
    this.emit({ type: "agent_end", messages: this.messages });
  }

  finishTurnWithEmptyAgentEnd(message: OmpAgentMessage = { role: "assistant", content: [] }): void {
    this.messages = [...this.messages, message];
    this.emit({ type: "message_end", message });
    this.emit({ type: "agent_end", messages: [] });
  }

  beginTurn(): void {
    this.emit({ type: "turn_start" });
  }

  acceptPrompt(text: string, entryId = "omp-user-1", clientMessageId?: string): void {
    this.emit({
      type: "message_end",
      message: {
        role: "user",
        content: text,
        entryId,
        ...(clientMessageId ? { clientMessageId } : {}),
      } as OmpAgentMessage,
    });
  }

  acceptCustomMessage(content: string): void {
    this.emit({
      type: "message_end",
      message: { role: "custom", content },
    });
  }

  streamAssistantText(text: string, responseId = "omp-assistant-1"): void {
    const message: OmpAgentMessage = {
      role: "assistant",
      content: [],
      responseId,
    };
    this.emit({ type: "message_start", message });
    this.emit({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", delta: text },
    });
  }

  requestToolApproval(input: {
    id: string;
    tool: "bash" | "edit" | "write";
    detail: string;
  }): void {
    let detailLabel = "Path";
    if (input.tool === "bash") {
      detailLabel = "Command";
    } else if (input.tool === "edit") {
      detailLabel = "File";
    }
    this.emit({
      type: "extension_ui_request",
      id: input.id,
      method: "select",
      title: `Allow tool: ${input.tool}\n${detailLabel}: ${input.detail}`,
      options: ["Approve", "Deny"],
    });
  }
}
