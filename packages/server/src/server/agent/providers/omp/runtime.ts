import type {
  BackgroundProcess,
  BackgroundProcessOutput,
} from "@omp-desktop/protocol/background-processes";
import type {
  OmpAgentMessage,
  OmpFastModeResult,
  OmpModel,
  OmpLoginProvider,
  OmpPromptAck,
  OmpRpcHostToolDefinition,
  OmpRpcHostToolResult,
  OmpRpcHostToolUpdate,
  OmpRpcSlashCommand,
  OmpRuntimeEvent,
  OmpSessionState,
  OmpSessionStats,
  OmpSubagentSubscriptionLevel,
  OmpThinkingLevel,
} from "./rpc-types.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";

export interface OmpRuntimeLaunch {
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
  protocolMode?: "rpc" | "rpc-ui";
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  session?: string;
  noSession?: boolean;
  systemPrompt?: string;
  extraArgs?: string[];
}

export interface OmpStartSessionInput {
  cwd: string;
  signal?: AbortSignal;
  env?: Record<string, string>;
  protocolMode?: "rpc" | "rpc-ui";
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  session?: string;
  noSession?: boolean;
  systemPrompt?: string;
  extraArgs?: string[];
}

export interface OmpRuntimeSession {
  onEvent(callback: (event: OmpRuntimeEvent) => void): () => void;
  prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<OmpPromptAck>;
  compact(customInstructions?: string): Promise<void>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  abort(): Promise<void>;
  cancelSubagent?(subagentId: string): Promise<boolean>;
  getState(): Promise<OmpSessionState>;
  listBackgroundJobs?(): Promise<BackgroundProcess[]>;
  getBackgroundJobOutput?(processId: string, cursor?: number): Promise<BackgroundProcessOutput>;
  stopBackgroundJob?(processId: string): Promise<boolean>;
  stopAllBackgroundJobs?(): Promise<number>;
  setFastMode(enabled: boolean): Promise<OmpFastModeResult>;
  getMessages(): Promise<OmpAgentMessage[]>;
  getAvailableModels(timeoutMs?: number | null): Promise<OmpModel[]>;
  getLoginProviders(): Promise<OmpLoginProvider[]>;
  login(providerId: string): Promise<void>;
  setModel(provider: string, modelId: string): Promise<OmpModel>;
  setThinkingLevel(level: OmpThinkingLevel): Promise<void>;
  getSessionStats(): Promise<OmpSessionStats>;
  getCommands(): Promise<OmpRpcSlashCommand[]>;
  setSubagentSubscription(level: OmpSubagentSubscriptionLevel): Promise<void>;
  setHostTools(tools: OmpRpcHostToolDefinition[]): Promise<string[]>;
  sendHostToolResult(result: OmpRpcHostToolResult): void;
  sendHostToolUpdate(update: OmpRpcHostToolUpdate): void;
  branch(entryId: string): Promise<{ text: string }>;
  getBranchMessages(): Promise<Array<{ entryId: string; text: string }>>;
  activeBranchEntryId?: string;
  steer(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void>;
  followUp(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): void;
  handoff(customInstructions?: string): Promise<void>;
  respondToExtensionUiRequest(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void;
  cancelExtensionUiRequest(id: string): void;
  close(): Promise<void>;
}

export interface OmpRuntime {
  startSession(input: OmpStartSessionInput): Promise<OmpRuntimeSession>;
}

export function buildOmpLaunch(input: {
  command: [string, ...string[]];
  runtimeSettings?: ProviderRuntimeSettings;
  session: OmpStartSessionInput;
}): OmpRuntimeLaunch {
  const configuredCommand = input.runtimeSettings?.command;
  let command: readonly string[] = input.command;
  if (configuredCommand?.mode === "replace" && configuredCommand.argv[0]) {
    command = configuredCommand.argv;
  } else if (configuredCommand?.mode === "append") {
    command = [...input.command, ...(configuredCommand.args ?? [])];
  }
  const argv = [...command];

  const protocolMode = input.session.protocolMode ?? "rpc";
  const systemPrompt = input.session.systemPrompt?.trim();
  appendOmpLaunchArgs(argv, input.session, protocolMode, systemPrompt);

  return {
    cwd: input.session.cwd,
    argv,
    env:
      input.runtimeSettings?.env || input.session.env
        ? {
            ...input.runtimeSettings?.env,
            ...input.session.env,
          }
        : undefined,
    model: input.session.model,
    thinkingOptionId: input.session.thinkingOptionId,
    protocolMode,
    modeId: input.session.modeId,
    session: input.session.session,
    noSession: input.session.noSession,
    systemPrompt,
    extraArgs: input.session.extraArgs,
  };
}

function appendOmpLaunchArgs(
  argv: string[],
  session: OmpStartSessionInput,
  protocolMode: "rpc" | "rpc-ui",
  systemPrompt: string | undefined,
): void {
  if (!hasModeFlag(argv)) {
    argv.push("--mode", protocolMode);
  }
  if (session.extraArgs?.length) {
    argv.push(...session.extraArgs);
  }
  if (session.model) {
    argv.push("--model", session.model);
  }
  if (session.thinkingOptionId) {
    argv.push("--thinking", session.thinkingOptionId);
  }
  if (session.noSession) {
    argv.push("--no-session");
  } else if (session.session) {
    argv.push("--session", session.session);
  }
  if (systemPrompt) {
    argv.push("--append-system-prompt", systemPrompt);
  }
}

function hasModeFlag(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--mode") {
      return true;
    }
    if (argv[i]?.startsWith("--mode=")) {
      return true;
    }
  }
  return false;
}
