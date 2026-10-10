import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import pino from "pino";

import type {
  AgentPersistenceHandle,
  AgentPermissionResponse,
  AgentPermissionResult,
  AgentInterruptReason,
  AgentRunOptions,
  AgentSteerOptions,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../../../agent-sdk-types.js";
import type { PaseoToolCatalog } from "../../../tools/types.js";
import {
  OmpAgentClient,
  OmpAgentSession,
  type OmpNoTurnScheduler,
  type OmpProviderIdleScheduler,
  type StoredOmpOAuthAccount,
} from "../agent.js";
import type { OmpUsagePollScheduler } from "../usage-poller.js";
import type {
  OmpAgentMessage,
  OmpModel,
  OmpRpcSlashCommand,
  OmpRuntimeEvent,
  OmpSessionStats,
  OmpSessionState,
} from "../rpc-types.js";
import { FakeOmp } from "./fake-omp.js";

const CWD = "/tmp/paseo-omp-agent-test";

interface OmpHistoryMessage {
  id: string;
  text: string;
}

interface OmpResumeHistory {
  user: OmpHistoryMessage;
  assistant: OmpHistoryMessage;
}

async function writeOmpHistory(history: OmpResumeHistory): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-omp-resume-"));
  const sessionFile = join(directory, "session.jsonl");
  const entries = [
    { type: "session", id: "session-root", parentId: null, cwd: CWD },
    {
      type: "message",
      id: history.user.id,
      parentId: "session-root",
      message: { role: "user", content: history.user.text },
    },
    {
      type: "message",
      id: history.assistant.id,
      parentId: history.user.id,
      message: {
        role: "assistant",
        content: [{ type: "text", text: history.assistant.text }],
        responseId: history.assistant.id,
      },
    },
  ];
  await writeFile(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
  return sessionFile;
}

export class OmpHarness {
  private readonly omp = new FakeOmp();
  private readonly client: OmpAgentClient;
  private readonly events: AgentStreamEvent[] = [];
  private session: OmpAgentSession | null = null;

  constructor(
    options: {
      oauthAccounts?: readonly StoredOmpOAuthAccount[];
      fastModeSupported?: boolean;
      sessionCredentialReader?: (providerId: string, sessionId: string) => number | undefined;
      initialModel?: OmpModel;
      initialActiveCredential?: OmpSessionState["activeCredential"];
      providerIdleScheduler?: OmpProviderIdleScheduler;
      noTurnScheduler?: OmpNoTurnScheduler;
      usagePollScheduler?: OmpUsagePollScheduler;
      initialStats?: OmpSessionStats;
    } = {},
  ) {
    this.omp.setFastModeSupported(options.fastModeSupported ?? true);
    this.omp.setInitialModel(options.initialModel ?? null);
    this.omp.setInitialActiveCredential(options.initialActiveCredential);
    if (options.initialStats) {
      this.omp.setInitialStats(options.initialStats);
    }
    this.client = new OmpAgentClient({
      logger: pino({ level: "silent" }),
      runtime: this.omp,
      oauthAccounts: options.oauthAccounts ?? [],
      sessionCredentialReader: options.sessionCredentialReader,
      providerIdleScheduler: options.providerIdleScheduler,
      noTurnScheduler: options.noTurnScheduler,
      usagePollScheduler: options.usagePollScheduler,
    });
  }

  queueCommands(commands: OmpRpcSlashCommand[]): void {
    this.omp.queueCommands(commands);
  }

  failNextStart(error: Error): void {
    this.omp.failNextStart(error);
  }

  failEventSubscription(error: Error): void {
    this.omp.failNextSubagentSubscription("events", error);
  }

  async start(
    config: Partial<AgentSessionConfig> = {},
    paseoTools?: PaseoToolCatalog,
  ): Promise<void> {
    const session = await this.client.createSession(
      { provider: "omp", cwd: CWD, ...config },
      paseoTools ? { paseoTools } : undefined,
    );
    if (!(session instanceof OmpAgentSession)) {
      throw new Error("OMP client returned a non-OMP session");
    }
    this.session = session;
    this.session.subscribe((event) => this.events.push(event));
  }

  async resume(
    history: OmpResumeHistory,
    overrides: Partial<AgentSessionConfig> = {},
  ): Promise<void> {
    await this.resumeFile(await writeOmpHistory(history), overrides);
  }

  async resumeFile(
    sessionFile: string,
    overrides: Partial<AgentSessionConfig> = {},
  ): Promise<void> {
    const handle: AgentPersistenceHandle = {
      provider: "omp",
      sessionId: "omp-session-1",
      nativeHandle: sessionFile,
      metadata: { cwd: CWD },
    };
    const session = await this.client.resumeSession(handle, overrides);
    if (!(session instanceof OmpAgentSession)) {
      throw new Error("OMP client returned a non-OMP session");
    }
    this.session = session;
    this.session.subscribe((event) => this.events.push(event));
  }

  launchConfiguration(): {
    cwd: string;
    protocolMode?: string;
    modeId?: string;
    session?: string;
    argv: string[];
  } {
    const launch = this.omp.recordedLaunches[0];
    if (!launch) throw new Error("OMP harness has not launched");
    return {
      cwd: launch.cwd,
      protocolMode: launch.protocolMode,
      modeId: launch.modeId,
      ...(launch.session ? { session: launch.session } : {}),
      argv: launch.argv,
    };
  }
  async listFeatures(config: Partial<AgentSessionConfig> = {}) {
    return await this.client.listFeatures({ provider: "omp", cwd: CWD, ...config });
  }
  launchCount(): number {
    return this.omp.recordedLaunches.length;
  }
  latestRuntimeClosed(): boolean {
    return this.omp.latestSession().closed;
  }
  recordedPrompts(): Array<{ message: string; imageCount: number }> {
    return [...this.omp.latestSession().prompts];
  }
  handoffRequests(): Array<{ customInstructions?: string }> {
    return [...this.omp.latestSession().handoffRequests];
  }

  async currentMode(): Promise<string | null> {
    return await this.requireSession().getCurrentMode();
  }

  registeredHostTools() {
    return this.omp.latestSession().hostToolSetRequests;
  }

  capabilities() {
    return this.client.capabilities;
  }

  async runPrompt(
    input: string,
    output: string,
    providerStatesAfterEnd: Array<{ isStreaming: boolean; isCompacting: boolean }> = [],
  ): Promise<unknown> {
    const session = this.requireSession();
    const promptStarted = this.omp.latestSession().nextPrompt();
    const run = session.run(input);
    await promptStarted;
    const runtime = this.omp.latestSession();
    runtime.beginTurn();
    runtime.acceptPrompt(input, "user-1");
    runtime.streamAssistantText(output);
    runtime.queueStateReports(
      providerStatesAfterEnd.map((state) => ({ ...runtime.state, ...state })),
    );
    runtime.finishTurn({
      role: "assistant",
      content: [{ type: "text", text: output }],
      responseId: "omp-assistant-1",
    });
    return await run;
  }

  async runPromptWithTerminalAssistant(
    input: string,
    output: string,
    terminalAssistant: Extract<OmpAgentMessage, { role: "assistant" }>,
  ): Promise<unknown> {
    const session = this.requireSession();
    const promptStarted = this.omp.latestSession().nextPrompt();
    const run = session.run(input);
    await promptStarted;
    const runtime = this.omp.latestSession();
    runtime.beginTurn();
    runtime.acceptPrompt(input, "user-1");
    runtime.streamAssistantText(output, terminalAssistant.responseId);
    runtime.finishTurn(terminalAssistant);
    return await run;
  }

  async runPromptAfterLengthContinuations(
    input: string,
    interruptedOutputs: readonly string[],
    completedOutput: string,
  ): Promise<{ completedBeforeContinuation: boolean; result: unknown }> {
    const session = this.requireSession();
    const promptStarted = this.omp.latestSession().nextPrompt();
    const run = session.run(input);
    let completed = false;
    void run.finally(() => {
      completed = true;
    });
    await promptStarted;
    const runtime = this.omp.latestSession();
    for (const [index, interruptedOutput] of interruptedOutputs.entries()) {
      runtime.beginTurn();
      const submittedPrompt = index === 0 ? input : runtime.followUpRequests.at(-1)?.message;
      if (!submittedPrompt) {
        throw new Error("OMP did not request a continuation");
      }
      runtime.acceptPrompt(submittedPrompt, `user-${index + 1}`);
      runtime.streamAssistantText(interruptedOutput, `omp-assistant-${index + 1}`);
      runtime.finishTurn({
        role: "assistant",
        content: [{ type: "text", text: interruptedOutput }],
        responseId: `omp-assistant-${index + 1}`,
        stopReason: "length",
      });
      await waitForImmediate();
    }
    const completedBeforeContinuation = completed;
    const completedIndex = interruptedOutputs.length + 1;
    runtime.beginTurn();
    const continuationPrompt = runtime.followUpRequests.at(-1)?.message;
    if (!continuationPrompt) {
      throw new Error("OMP did not request a continuation");
    }
    runtime.acceptPrompt(continuationPrompt, `user-${completedIndex}`);
    runtime.streamAssistantText(completedOutput, `omp-assistant-${completedIndex}`);
    runtime.finishTurn({
      role: "assistant",
      content: [{ type: "text", text: completedOutput }],
      responseId: `omp-assistant-${completedIndex}`,
      stopReason: "stop",
    });
    return { completedBeforeContinuation, result: await run };
  }

  async runPromptWithCustomMessage(
    input: string,
    customMessage: Extract<OmpAgentMessage, { role: "custom" }>,
    output: string,
  ): Promise<unknown> {
    const session = this.requireSession();
    const promptStarted = this.omp.latestSession().nextPrompt();
    const run = session.run(input);
    await promptStarted;
    const runtime = this.omp.latestSession();
    runtime.beginTurn();
    runtime.acceptPrompt(input, "user-1");
    runtime.emit({ type: "message_end", message: customMessage });
    runtime.streamAssistantText(output);
    runtime.finishTurn();
    return await run;
  }

  async startPromptWithEmptyAgentEnd(
    input: string,
    output: string,
  ): Promise<{ completion: Promise<unknown> }> {
    const session = this.requireSession();
    const promptStarted = this.omp.latestSession().nextPrompt();
    const completion = session.run(input);
    await promptStarted;
    const runtime = this.omp.latestSession();
    runtime.beginTurn();
    runtime.acceptPrompt(input, "user-1");
    runtime.streamAssistantText(output);
    runtime.finishTurnWithEmptyAgentEnd();
    return { completion };
  }

  async runPromptAfterExtensionNotice(
    input: string,
    output: string,
    display?: boolean,
  ): Promise<unknown> {
    const session = this.requireSession();
    const promptStarted = this.omp.latestSession().nextPrompt();
    const run = session.run(input);
    await promptStarted;
    const runtime = this.omp.latestSession();
    const message = {
      role: "custom" as const,
      content: "extension inventory changed",
      ...(display === undefined ? {} : { display }),
    };
    runtime.beginTurn();
    runtime.acceptPrompt(input, "user-1");
    runtime.emit({ type: "message_end", message });
    runtime.finishTurn(message);
    runtime.beginTurn();
    runtime.streamAssistantText(output);
    runtime.finishTurn();
    return await run;
  }

  async startPromptUntilProviderIdle(
    input: string,
    output: string,
    providerState: { isStreaming: boolean; isCompacting: boolean },
  ): Promise<{ completion: Promise<unknown> }> {
    const session = this.requireSession();
    const promptStarted = this.omp.latestSession().nextPrompt();
    const run = session.run(input);
    await promptStarted;
    const runtime = this.omp.latestSession();
    runtime.beginTurn();
    runtime.acceptPrompt(input, "user-1");
    runtime.streamAssistantText(output);
    runtime.state = { ...runtime.state, ...providerState };
    runtime.finishTurn();
    return { completion: run };
  }

  waitForProviderStateChecks(count: number): Promise<void> {
    return this.omp.latestSession().waitForStateRequests(count);
  }

  reportProviderState(state: { isStreaming: boolean; isCompacting: boolean }): void {
    const runtime = this.omp.latestSession();
    runtime.state = { ...runtime.state, ...state };
  }

  failProviderStateChecks(error: Error | null): void {
    this.omp.latestSession().getStateError = error;
  }

  async runPromptAfterFalseLocalOnlyHint(input: string, output: string): Promise<unknown> {
    const session = this.requireSession();
    const runtime = this.omp.latestSession();
    runtime.promptAck = { agentInvoked: false };
    const promptStarted = runtime.nextPrompt();
    const run = session.run(input);
    await promptStarted;
    runtime.acceptPrompt(input, "user-1");
    await new Promise<void>((resolve) => setImmediate(resolve));
    runtime.beginTurn();
    runtime.streamAssistantText(output);
    runtime.finishTurn();
    return await run;
  }

  async runPromptWithoutTurn(input: string): Promise<unknown> {
    const session = this.requireSession();
    this.omp.latestSession().promptAck = { agentInvoked: false };
    return await session.run(input);
  }

  async startPromptWithFalseLocalOnlyResult(
    input: string,
  ): Promise<{ completed: () => boolean; completion: Promise<unknown> }> {
    const session = this.requireSession();
    const runtime = this.omp.latestSession();
    runtime.promptAck = { requestId: "prompt-local-only" };
    const promptStarted = runtime.nextPrompt();
    const completion = session.run(input);
    let isCompleted = false;
    void completion.then(
      () => {
        isCompleted = true;
        return undefined;
      },
      () => {
        isCompleted = true;
        return undefined;
      },
    );
    await promptStarted;
    await waitForImmediate();
    runtime.emit({
      type: "prompt_result",
      id: "prompt-local-only",
      agentInvoked: false,
    });
    return { completed: () => isCompleted, completion };
  }

  async runPromptAfterCorrelatedTrueResult(
    input: string,
    output: string,
  ): Promise<{ completedBeforeTurn: boolean; result: unknown }> {
    const session = this.requireSession();
    const runtime = this.omp.latestSession();
    runtime.promptAck = { requestId: "prompt-invoked", agentInvoked: false };
    const promptStarted = runtime.nextPrompt();
    const run = session.run(input);
    let completed = false;
    void run.then(
      () => {
        completed = true;
        return undefined;
      },
      () => {
        completed = true;
        return undefined;
      },
    );
    await promptStarted;
    runtime.emit({
      type: "prompt_result",
      id: "prompt-invoked",
      agentInvoked: true,
    });
    await waitForImmediate();
    await waitForImmediate();
    const completedBeforeTurn = completed;
    runtime.acceptPrompt(input, "user-1");
    runtime.beginTurn();
    runtime.streamAssistantText(output);
    runtime.finishTurn();
    return { completedBeforeTurn, result: await run };
  }

  async runPromptAfterDelayedFalseLocalOnlyResult(
    input: string,
    output: string,
  ): Promise<{ completedBeforeTurn: boolean; result: unknown }> {
    const session = this.requireSession();
    const runtime = this.omp.latestSession();
    runtime.promptAck = { requestId: "prompt-1" };
    const promptStarted = runtime.nextPrompt();
    const run = session.run(input);
    let completed = false;
    void run.then(
      () => {
        completed = true;
        return undefined;
      },
      () => {
        completed = true;
        return undefined;
      },
    );
    await promptStarted;
    await waitForImmediate();
    runtime.emit({
      type: "prompt_result",
      id: "prompt-1",
      agentInvoked: false,
    });
    await waitForImmediate();
    const completedBeforeTurn = completed;
    runtime.acceptPrompt(input, "user-1");
    runtime.beginTurn();
    runtime.streamAssistantText(output);
    runtime.finishTurn();
    return { completedBeforeTurn, result: await run };
  }

  async runAutonomousTurn(output: string): Promise<void> {
    const runtime = this.omp.latestSession();
    runtime.beginTurn();
    runtime.streamAssistantText(output);
    runtime.finishTurn();
    await waitForImmediate();
  }

  timeline(): AgentTimelineItem[] {
    return this.events.flatMap((event) => (event.type === "timeline" ? [event.item] : []));
  }

  async runOutOfBand(prompt: string): Promise<AgentStreamEvent[]> {
    const handler = this.requireSession().tryHandleOutOfBand(prompt);
    if (!handler) {
      throw new Error(`OMP did not recognize out-of-band command: ${prompt}`);
    }
    const events: AgentStreamEvent[] = [];
    await handler.run({ emit: (event) => events.push(event) });
    return events;
  }

  compactRequests(): Array<{ customInstructions?: string }> {
    return [...this.omp.latestSession().compactRequests];
  }

  eventTypes(): AgentStreamEvent["type"][] {
    return this.events.map((event) => event.type);
  }

  permissionEvents() {
    return this.events.filter(
      (event) => event.type === "permission_requested" || event.type === "permission_resolved",
    );
  }

  async history(): Promise<AgentTimelineItem[]> {
    const items: AgentTimelineItem[] = [];
    for await (const event of this.requireSession().streamHistory()) {
      if (event.type === "timeline") items.push(event.item);
    }
    return items;
  }

  completedTurnCount(): number {
    return this.events.filter((event) => event.type === "turn_completed").length;
  }

  usageUpdates() {
    return this.events.flatMap((event) => (event.type === "usage_updated" ? [event.usage] : []));
  }

  requestToolApproval(input: {
    id: string;
    tool: "bash" | "edit" | "write";
    detail: string;
  }): void {
    this.omp.latestSession().requestToolApproval(input);
  }

  emitExtensionUiRequest(event: Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>): void {
    this.omp.latestSession().emit(event);
  }

  pendingPermissions() {
    return this.requireSession().getPendingPermissions();
  }

  async respondToPermission(
    id: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    return await this.requireSession().respondToPermission(id, response);
  }

  extensionUiResponses() {
    return this.omp.latestSession().extensionUiResponses;
  }

  async availableModes() {
    return await this.requireSession().getAvailableModes();
  }

  async commands() {
    return await this.requireSession().listCommands();
  }

  async setMode(modeId: string) {
    return await this.requireSession().setMode(modeId);
  }

  async runtimeInfo() {
    return await this.requireSession().getRuntimeInfo();
  }

  async setModel(
    provider: string,
    modelId: string,
    metadata: Partial<OmpModel> = {},
  ): Promise<void> {
    this.omp.latestSession().setModelResult = { ...metadata, provider, id: modelId };
    await this.requireSession().setModel(`${provider}/${modelId}`);
  }

  features() {
    return this.requireSession().features;
  }
  fastModeRequests(): boolean[] {
    return [...this.omp.latestSession().setFastModeRequests];
  }

  async setFeature(featureId: string, value: unknown): Promise<void> {
    await this.requireSession().setFeature(featureId, value);
  }

  emitCredentialChanged(provider: string, credentialId: number): void {
    this.omp.latestSession().emit({ type: "credential_changed", provider, credentialId });
  }

  async updateGoalObjective(objective: string): Promise<void> {
    await this.requireSession().setGoalObjective(objective);
  }

  async controlGoal(action: "start" | "pause" | "delete"): Promise<void> {
    await this.requireSession().controlGoal(action);
  }

  async rewind(messageId: string, restoredPrompt: string): Promise<void> {
    this.omp.latestSession().branchResponse = { text: restoredPrompt };
    await this.requireSession().revertConversation({ messageId });
  }

  branchRequests(): string[] {
    return this.omp.latestSession().branchRequests;
  }

  async interruptActiveTurn(message: string): Promise<void> {
    await this.requireSession().startTurn(message);
    await this.requireSession().interrupt();
  }

  async requireStartTurn(message: string, options?: AgentRunOptions): Promise<string> {
    const promptStarted = this.omp.latestSession().nextPrompt();
    const { turnId } = await this.requireSession().startTurn(message, options);
    await promptStarted;
    return turnId;
  }

  async steerActiveTurn(
    message: string,
    expectedTurnId: string,
    options?: Omit<AgentSteerOptions, "expectedTurnId">,
  ) {
    return await this.requireSession().steerActiveTurn(message, { ...options, expectedTurnId });
  }

  async interrupt(reason?: AgentInterruptReason): Promise<void> {
    await this.requireSession().interrupt(reason);
  }

  async cancelProviderSubagent(subagentId: string): Promise<boolean> {
    return this.requireSession().cancelProviderSubagent(subagentId);
  }

  wasAborted(): boolean {
    return this.omp.latestSession().abortRequested;
  }

  runtime() {
    return this.omp.latestSession();
  }

  runningToolCallIds(): string[] {
    const statusByCall = new Map<string, string>();
    for (const item of this.timeline()) {
      if (item.type === "tool_call") {
        statusByCall.set(item.callId, item.status);
      }
    }
    return [...statusByCall.entries()]
      .filter(([, status]) => status === "running")
      .map(([callId]) => callId);
  }

  // `status` is optional on the upsert event — an upsert may report only model or usage. OMP
  // always sets one, so this stays a plain string for assertions.
  subagentUpserts(): Array<{ id: string; status: string | undefined }> {
    return this.events.flatMap((event) =>
      event.type === "provider_subagent" && event.event.type === "upsert"
        ? [{ id: event.event.id, status: event.event.status }]
        : [],
    );
  }

  canceledTurnCount(): number {
    return this.events.filter((event) => event.type === "turn_canceled").length;
  }

  failedTurnCount(): number {
    return this.events.filter((event) => event.type === "turn_failed").length;
  }

  cancellationReasons(): string[] {
    return this.events.flatMap((event) => (event.type === "turn_canceled" ? [event.reason] : []));
  }

  async close(): Promise<void> {
    await this.requireSession().close();
    await waitForImmediate();
  }

  isClosed(): boolean {
    return this.omp.latestSession().closed;
  }

  async waitForSubscriptionFallback(): Promise<string[]> {
    const runtime = this.omp.latestSession();
    await runtime.waitForSubagentSubscriptions(2);
    return runtime.subagentSubscriptionRequests;
  }

  private requireSession(): OmpAgentSession {
    if (!this.session) throw new Error("OMP harness has not started");
    return this.session;
  }
}
