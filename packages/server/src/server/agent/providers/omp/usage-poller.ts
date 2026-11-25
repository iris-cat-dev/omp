import type { AgentUsage } from "../../agent-sdk-types.js";
import type { OmpSessionStats } from "./rpc-types.js";

export interface OmpUsagePollScheduler {
  schedulePoll(callback: () => void): () => void;
}

interface OmpUsagePollerOptions {
  readStats(): Promise<OmpSessionStats>;
  onUsage(usage: AgentUsage): void;
  onPollError(error: unknown): void;
  scheduler?: OmpUsagePollScheduler;
}

function createScheduler(): OmpUsagePollScheduler {
  return {
    schedulePoll: (callback) => {
      const timer = setTimeout(callback, 3_000);
      return () => clearTimeout(timer);
    },
  };
}

function toAgentUsage(stats: OmpSessionStats): AgentUsage | undefined {
  const tokens = stats.tokens;
  const outputTokens = tokens?.output ?? 0;
  const totalCostUsd = stats.cost ?? 0;
  if (
    tokens?.input === undefined &&
    tokens?.cacheRead === undefined &&
    tokens?.cacheWrite === undefined &&
    outputTokens === 0 &&
    totalCostUsd === 0 &&
    stats.contextUsage?.contextWindow == null &&
    stats.contextUsage?.tokens == null &&
    stats.compactionCount === undefined
  ) {
    return undefined;
  }

  const usage: AgentUsage = { scope: "session", outputTokens, totalCostUsd };
  if (tokens?.input !== undefined) usage.inputTokens = tokens.input;
  if (tokens?.cacheRead !== undefined) usage.cachedInputTokens = tokens.cacheRead;
  if (tokens?.cacheWrite !== undefined) usage.cacheWriteTokens = tokens.cacheWrite;
  if (stats.contextUsage?.contextWindow != null) {
    usage.contextWindowMaxTokens = stats.contextUsage.contextWindow;
  }
  if (stats.contextUsage?.tokens != null) usage.contextWindowUsedTokens = stats.contextUsage.tokens;
  if (stats.compactionCount !== undefined) usage.compactionCount = stats.compactionCount;
  return usage;
}

function isSameUsage(left: AgentUsage, right: AgentUsage): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    left.outputTokens === right.outputTokens &&
    left.totalCostUsd === right.totalCostUsd &&
    left.contextWindowMaxTokens === right.contextWindowMaxTokens &&
    left.contextWindowUsedTokens === right.contextWindowUsedTokens &&
    left.compactionCount === right.compactionCount
  );
}

export class OmpUsagePoller {
  private readonly scheduler: OmpUsagePollScheduler;
  private active = false;
  private closed = false;
  private generation = 0;
  private cancelScheduledPoll: (() => void) | null = null;
  private lastUsage: AgentUsage | null = null;

  constructor(private readonly options: OmpUsagePollerOptions) {
    this.scheduler = options.scheduler ?? createScheduler();
  }

  startTurn(): void {
    if (this.closed || this.active) {
      return;
    }
    this.active = true;
    this.generation += 1;
    this.schedule(this.generation);
  }

  stopTurn(): void {
    this.active = false;
    this.invalidatePendingWork();
  }

  async completeTurn(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.active = false;
    const completionGeneration = this.invalidatePendingWork();
    let usage: AgentUsage | undefined;
    try {
      usage = toAgentUsage(await this.options.readStats());
    } catch {
      return;
    }
    if (this.closed || this.generation !== completionGeneration) {
      return;
    }
    this.publishUsage(usage);
  }

  async refresh(): Promise<void> {
    if (this.closed || this.active) {
      return;
    }
    const refreshGeneration = this.generation;
    let usage: AgentUsage | undefined;
    try {
      usage = toAgentUsage(await this.options.readStats());
    } catch {
      return;
    }
    if (this.closed || this.active || this.generation !== refreshGeneration) {
      return;
    }
    this.publishUsage(usage);
  }

  close(): void {
    this.closed = true;
    this.active = false;
    this.invalidatePendingWork();
  }

  private invalidatePendingWork(): number {
    this.generation += 1;
    this.cancelScheduledPoll?.();
    this.cancelScheduledPoll = null;
    return this.generation;
  }

  private schedule(generation: number): void {
    this.cancelScheduledPoll = this.scheduler.schedulePoll(() => {
      this.cancelScheduledPoll = null;
      void this.poll(generation);
    });
  }

  private async poll(generation: number): Promise<void> {
    let usage: AgentUsage | undefined;
    try {
      usage = toAgentUsage(await this.options.readStats());
    } catch (error) {
      try {
        if (this.active && !this.closed && this.generation === generation) {
          this.options.onPollError(error);
        }
      } finally {
        if (this.active && !this.closed && this.generation === generation) {
          this.schedule(generation);
        }
      }
      return;
    }
    try {
      if (this.active && !this.closed && this.generation === generation) {
        this.publishUsage(usage);
      }
    } finally {
      if (this.active && !this.closed && this.generation === generation) {
        this.schedule(generation);
      }
    }
  }

  private takeChangedUsage(usage: AgentUsage | undefined): AgentUsage | undefined {
    if (!usage || (this.lastUsage && isSameUsage(this.lastUsage, usage))) {
      return undefined;
    }
    this.lastUsage = usage;
    return usage;
  }

  private publishUsage(usage: AgentUsage | undefined): void {
    const changedUsage = this.takeChangedUsage(usage);
    if (changedUsage) {
      this.options.onUsage(changedUsage);
    }
  }
}
