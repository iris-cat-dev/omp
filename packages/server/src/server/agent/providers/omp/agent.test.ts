import { describe, expect, test } from "vitest";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PaseoToolCatalog } from "../../tools/types.js";
import type { OmpNoTurnScheduler, OmpProviderIdleScheduler } from "./agent.js";
import type { OmpUsagePollScheduler } from "./usage-poller.js";
import { OmpHarness } from "./test-utils/omp-harness.js";
import { OmpReadyTimeoutError } from "./cli-runtime.js";

const OMP_PLAN_TURN_DIRECTIVE = `<system-directive>
Plan mode active for this turn. The working tree and system are read-only: NEVER create, edit, delete, or rename files, and NEVER run state-changing commands. You may inspect with read-only tools. Produce or refine the requested plan only.
</system-directive>`;
const OMP_STANDARD_TURN_DIRECTIVE = `<system-directive>
Plan mode is inactive for this turn. All earlier per-turn Plan mode directives have expired. Follow the current user request normally; working-tree changes are permitted subject to the active tool-approval policy.
</system-directive>`;

function planTurnPrompt(prompt: string): string {
  return `${OMP_PLAN_TURN_DIRECTIVE}\n\n${prompt}`;
}

function standardTurnPrompt(prompt: string): string {
  return `${OMP_STANDARD_TURN_DIRECTIVE}\n\n${prompt}`;
}

class ManualIdleScheduler implements OmpProviderIdleScheduler {
  private readonly retries: Array<() => void> = [];
  private readonly waiters: Array<{ count: number; resolve: () => void }> = [];
  private waitCount = 0;

  waitForRetry(): Promise<void> {
    this.waitCount += 1;
    for (const waiter of this.waiters.splice(0)) {
      if (this.waitCount >= waiter.count) waiter.resolve();
      else this.waiters.push(waiter);
    }
    return new Promise((resolve) => this.retries.push(resolve));
  }

  waitForWaits(count: number): Promise<void> {
    if (this.waitCount >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  retry(): void {
    const resolve = this.retries.shift();
    if (!resolve) throw new Error("OMP has not requested an idle-state retry");
    resolve();
  }
}

class ManualNoTurnScheduler implements OmpNoTurnScheduler {
  private settleResolve: (() => void) | null = null;
  private aborted = false;

  waitForSettle(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      this.aborted = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.settleResolve = resolve;
      signal.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          this.settleResolve = null;
          resolve();
        },
        { once: true },
      );
    });
  }

  settle(): void {
    const resolve = this.settleResolve;
    if (!resolve) throw new Error("OMP has not requested a no-turn settle wait");
    this.settleResolve = null;
    resolve();
  }

  wasAborted(): boolean {
    return this.aborted;
  }
}

class ManualUsagePollScheduler implements OmpUsagePollScheduler {
  private readonly polls: Array<{ active: boolean; callback: () => void }> = [];

  schedulePoll(callback: () => void): () => void {
    const poll = { active: true, callback };
    this.polls.push(poll);
    return () => {
      poll.active = false;
    };
  }

  poll(): void {
    const poll = this.polls.shift();
    if (!poll) throw new Error("OMP has not scheduled a context usage poll");
    if (poll.active) poll.callback();
  }

  activePollCount(): number {
    return this.polls.filter((poll) => poll.active).length;
  }
}

function createToolCatalog(): PaseoToolCatalog {
  return {
    tools: new Map([
      [
        "create_agent",
        {
          name: "create_agent",
          description: "Create a Paseo agent.",
          handler: async () => ({ content: [] }),
        },
      ],
    ]),
    getTool: () => undefined,
    executeTool: async () => ({ content: [] }),
  };
}

describe("OMP agent client and session", () => {
  test("retries conversation startup once after OMP readiness times out", async () => {
    const omp = new OmpHarness();
    omp.failNextStart(new OmpReadyTimeoutError(30_000));

    await expect(omp.start()).resolves.toBeUndefined();
    expect(omp.launchCount()).toBe(1);
  });

  test("reports an actionable error after two conversation startup timeouts", async () => {
    const omp = new OmpHarness();
    omp.failNextStart(new OmpReadyTimeoutError(30_000));
    omp.failNextStart(new OmpReadyTimeoutError(30_000));

    await expect(omp.start()).rejects.toThrow(
      "OMP could not start the conversation after two attempts. Restart OMP and try again.",
    );
    expect(omp.launchCount()).toBe(0);
  });

  test("exposes and pins a selected stored OAuth account when multiple accounts exist", async () => {
    const omp = new OmpHarness({
      oauthAccounts: [
        {
          credentialId: 5,
          provider: "anthropic",
          identityKey: "email:other@example.com",
        },
        {
          credentialId: 41,
          provider: "openai-codex",
          identityKey: "email:alice@example.com|org:personal",
        },
        {
          credentialId: 42,
          provider: "openai-codex",
          identityKey: "email:bob@example.com|org:team",
        },
      ],
    });
    await omp.start({ model: "openai-codex/gpt-5.6" });

    expect(omp.features()).toEqual([
      expect.objectContaining({ id: "workflow_mode" }),
      expect.objectContaining({
        id: "fast_mode",
        type: "toggle",
        value: false,
      }),
      expect.objectContaining({
        id: "oauth_account_credential",
        type: "select",
        value: "automatic",
        effectiveValue: null,
        options: [
          expect.objectContaining({ id: "automatic" }),
          { id: "41", label: "alice@example.com · org:personal" },
          { id: "42", label: "bob@example.com · org:team" },
        ],
      }),
    ]);
    await omp.setFeature("oauth_account_credential", "41");

    expect(omp.recordedPrompts()).toEqual([{ message: "/session pin 1", imageCount: 0 }]);
    expect(omp.features()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "oauth_account_credential",
          value: "41",
        }),
      ]),
    );
  });

  test("reports OMP automatic OAuth accounts without repinning them", async () => {
    let selectedCredentialId = 40;
    const omp = new OmpHarness({
      oauthAccounts: [
        { credentialId: 41, provider: "openai-codex" },
        { credentialId: 42, provider: "openai-codex" },
      ],
      sessionCredentialReader: (providerId, sessionId) => {
        expect(providerId).toBe("openai-codex");
        expect(sessionId).toBe("omp-session-1");
        selectedCredentialId += 1;
        return selectedCredentialId;
      },
    });

    await omp.start({ model: "openai-codex/gpt-5.6" });
    expect(omp.recordedPrompts()).toEqual([]);
    expect(omp.features()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "oauth_account_credential",
          value: "automatic",
          effectiveValue: "41",
        }),
      ]),
    );

    await omp.start({ model: "openai-codex/gpt-5.6" });
    expect(omp.recordedPrompts()).toEqual([]);
    expect(omp.features()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "automatic",
          effectiveValue: "42",
        }),
      ]),
    );
  });

  test("retries a delayed automatic OAuth account selection during session startup", async () => {
    let credentialReadCount = 0;
    const omp = new OmpHarness({
      oauthAccounts: [
        { credentialId: 41, provider: "openai-codex" },
        { credentialId: 42, provider: "openai-codex" },
      ],
      sessionCredentialReader: () => {
        credentialReadCount += 1;
        return credentialReadCount < 3 ? undefined : 42;
      },
    });

    await omp.start({ model: "openai-codex/gpt-5.6" });

    expect(credentialReadCount).toBe(3);
    expect(omp.features()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "oauth_account_credential",
          value: "automatic",
          effectiveValue: "42",
        }),
      ]),
    );
  });

  test("publishes a credential selected after an automatic turn starts", async () => {
    let credentialReadCount = 0;
    const omp = new OmpHarness({
      oauthAccounts: [
        { credentialId: 41, provider: "openai-codex" },
        { credentialId: 42, provider: "openai-codex" },
      ],
      sessionCredentialReader: () => {
        credentialReadCount += 1;
        return credentialReadCount <= 5 ? undefined : 42;
      },
    });
    await omp.start({ model: "openai-codex/gpt-5.6" });

    expect(omp.features()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "oauth_account_credential",
          value: "automatic",
          effectiveValue: null,
        }),
      ]),
    );

    await omp.runPrompt("hello", "world");
    await waitForImmediate();

    expect(credentialReadCount).toBeGreaterThan(5);
    expect(omp.features()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "oauth_account_credential",
          value: "automatic",
          effectiveValue: "42",
        }),
      ]),
    );
    expect(omp.eventTypes()).toContain("features_changed");
  });

  test("reports the OMP-selected OAuth account during the draft feature probe", async () => {
    let credentialReadCount = 0;
    const omp = new OmpHarness({
      oauthAccounts: [
        { credentialId: 41, provider: "openai-codex" },
        { credentialId: 42, provider: "openai-codex" },
      ],
      initialActiveCredential: { provider: "openai-codex", credentialId: 42 },
      sessionCredentialReader: (providerId, sessionId) => {
        expect(providerId).toBe("openai-codex");
        expect(sessionId).toBe("omp-session-1");
        credentialReadCount += 1;
        return 42;
      },
    });

    const automaticFeatures = await omp.listFeatures({
      model: "openai-codex/gpt-5.6",
    });

    expect(automaticFeatures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "oauth_account_credential",
          value: "automatic",
          effectiveValue: "42",
        }),
      ]),
    );
    expect(credentialReadCount).toBe(1);

    const pinnedFeatures = await omp.listFeatures({
      model: "openai-codex/gpt-5.6",
      featureValues: { oauth_account_credential: "41" },
    });

    expect(pinnedFeatures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "oauth_account_credential",
          value: "41",
          effectiveValue: null,
        }),
      ]),
    );
    expect(credentialReadCount).toBe(1);
  });

  test("reports the effective OAuth account selected by the runtime", async () => {
    const omp = new OmpHarness({
      oauthAccounts: [
        { credentialId: 41, provider: "openai-codex" },
        { credentialId: 42, provider: "openai-codex" },
      ],
    });
    await omp.start({ model: "openai-codex/gpt-5.6" });

    omp.emitCredentialChanged("openai-codex", 42);

    expect(omp.features()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "oauth_account_credential",
          value: "automatic",
          effectiveValue: "42",
        }),
      ]),
    );
    expect(omp.eventTypes()).toContain("features_changed");

    omp.emitCredentialChanged("openai-codex", 41);

    expect(omp.features()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "automatic",
          effectiveValue: "41",
        }),
      ]),
    );
  });

  test("refreshes OAuth account selection immediately when the model provider changes", async () => {
    const omp = new OmpHarness({
      oauthAccounts: [
        { credentialId: 41, provider: "openai-codex" },
        { credentialId: 42, provider: "openai-codex" },
      ],
    });
    await omp.start({
      model: "custom-openai/model",
      featureValues: { oauth_account_credential: "42" },
    });

    expect(omp.features()).toEqual([expect.objectContaining({ id: "workflow_mode" })]);

    await omp.setModel("openai-codex", "gpt-5.6");

    expect(omp.features()).toEqual([
      expect.objectContaining({ id: "workflow_mode" }),
      expect.objectContaining({
        id: "fast_mode",
        type: "toggle",
        value: false,
      }),
      expect.objectContaining({
        id: "oauth_account_credential",
        type: "select",
        value: "42",
        effectiveValue: "42",
        options: [
          expect.objectContaining({ id: "automatic" }),
          expect.objectContaining({ id: "41" }),
          expect.objectContaining({ id: "42" }),
        ],
      }),
    ]);
    expect(omp.recordedPrompts()).toEqual([{ message: "/session pin 2", imageCount: 0 }]);

    await omp.setModel("custom-openai", "model");

    expect(omp.features()).toEqual([expect.objectContaining({ id: "workflow_mode" })]);
  });

  test("hides OAuth account selection for a single account", async () => {
    const omp = new OmpHarness({
      oauthAccounts: [{ credentialId: 7, provider: "openai-codex" }],
    });
    await omp.start({
      model: "openai-codex/gpt-5.6",
      featureValues: { oauth_account_credential: "7" },
    });

    expect(omp.features()).toEqual([
      expect.objectContaining({ id: "workflow_mode" }),
      expect.objectContaining({
        id: "fast_mode",
        type: "toggle",
        value: false,
      }),
    ]);
    expect(omp.recordedPrompts()).toEqual([]);
  });

  test("probes fast-mode capability once for an eligible draft model", async () => {
    const omp = new OmpHarness();

    const features = await omp.listFeatures({
      model: "openai-codex/gpt-5.6",
      featureValues: { fast_mode: true },
    });

    expect(features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "fast_mode",
          type: "toggle",
          value: true,
        }),
      ]),
    );
    expect(omp.launchCount()).toBe(1);
    expect(omp.latestRuntimeClosed()).toBe(true);
  });

  test("keeps fast mode hidden when the draft capability probe reports it unsupported", async () => {
    const omp = new OmpHarness({ fastModeSupported: false });

    const features = await omp.listFeatures({ model: "openai-codex/gpt-5.6" });

    expect(features).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fast_mode" })]),
    );
    expect(omp.launchCount()).toBe(1);
    expect(omp.latestRuntimeClosed()).toBe(true);
  });

  test("toggles OMP fast mode through the live RPC feature", async () => {
    const omp = new OmpHarness();
    await omp.start({ model: "openai-codex/gpt-5.6" });

    expect(omp.features()).toEqual([
      expect.objectContaining({ id: "workflow_mode" }),
      expect.objectContaining({
        id: "fast_mode",
        type: "toggle",
        icon: "zap",
        value: false,
      }),
    ]);

    await omp.setFeature("fast_mode", true);
    expect(omp.fastModeRequests()).toEqual([true]);
    expect(omp.features()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fast_mode", value: true })]),
    );

    await omp.setModel("custom-openai", "model");
    expect(omp.features()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fast_mode" })]),
    );

    await omp.setModel("openai-codex", "gpt-5.6");
    expect(omp.fastModeRequests()).toEqual([true]);
    expect(omp.features()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fast_mode", value: true })]),
    );

    await omp.setFeature("fast_mode", false);
    expect(omp.fastModeRequests()).toEqual([true, false]);
    expect(omp.features()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fast_mode", value: false })]),
    );
  });

  test("applies a persisted fast-mode preference when the session starts", async () => {
    const omp = new OmpHarness();
    await omp.start({
      model: "openai-codex/gpt-5.6",
      featureValues: { fast_mode: true },
    });

    expect(omp.fastModeRequests()).toEqual([true]);
    expect(omp.features()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fast_mode", value: true })]),
    );
  });

  test("enables fast mode for custom GPT models on OpenAI wire APIs", async () => {
    const omp = new OmpHarness({
      initialModel: {
        provider: "mintcat-1",
        id: "gpt-5.6-sol",
        name: "GPT-5.6-Sol",
        api: "openai-responses",
      },
    });
    await omp.start({ model: "mintcat-1/gpt-5.6-sol" });

    expect(omp.features()).toEqual([
      expect.objectContaining({ id: "workflow_mode" }),
      expect.objectContaining({
        id: "fast_mode",
        type: "toggle",
        value: false,
      }),
    ]);

    await omp.setFeature("fast_mode", true);
    expect(omp.fastModeRequests()).toEqual([true]);
  });

  test("hides fast mode for non-GPT models that only reuse an OpenAI wire format", async () => {
    const omp = new OmpHarness({
      initialModel: {
        provider: "kimi",
        id: "kimi-k3",
        name: "Kimi K3",
        api: "openai-completions",
      },
    });
    await omp.start({ model: "kimi/kimi-k3" });

    expect(omp.features()).toEqual([expect.objectContaining({ id: "workflow_mode" })]);
    await expect(omp.setFeature("fast_mode", true)).rejects.toThrow(
      "OMP fast mode is unavailable for the current model",
    );
  });

  test("hides fast mode when the installed OMP RPC does not support it", async () => {
    const omp = new OmpHarness({ fastModeSupported: false });
    await omp.start({
      model: "openai-codex/gpt-5.6",
      featureValues: { fast_mode: true },
    });

    expect(omp.features()).toEqual([expect.objectContaining({ id: "workflow_mode" })]);
    expect(omp.fastModeRequests()).toEqual([]);
    await expect(omp.setFeature("fast_mode", true)).rejects.toThrow(
      "OMP fast mode is unavailable for the current model",
    );
  });

  test("hides OAuth account selection for custom providers", async () => {
    const omp = new OmpHarness({
      oauthAccounts: [
        { credentialId: 7, provider: "custom-openai" },
        { credentialId: 8, provider: "custom-openai" },
      ],
    });
    await omp.start({
      model: "custom-openai/model",
      featureValues: { oauth_account_credential: "7" },
    });

    expect(omp.features()).toEqual([expect.objectContaining({ id: "workflow_mode" })]);
    expect(omp.recordedPrompts()).toEqual([]);
  });

  test("owns launch configuration and registers native host tools", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "ask" }, createToolCatalog());

    expect(omp.launchConfiguration()).toEqual({
      cwd: "/tmp/paseo-omp-agent-test",
      protocolMode: "rpc-ui",
      modeId: "ask",
      argv: ["omp", "--mode", "rpc-ui", "--approval-mode", "always-ask"],
    });
    expect(omp.registeredHostTools()).toEqual([
      [expect.objectContaining({ name: "create_agent" })],
    ]);
    expect(omp.capabilities()).toMatchObject({
      supportsMcpServers: false,
      supportsNativePaseoTools: true,
    });
  });

  test("preserves max as the selected thinking option", async () => {
    const omp = new OmpHarness();
    await omp.start({ thinkingOptionId: "max" });

    expect(omp.launchConfiguration().argv).toEqual(expect.arrayContaining(["--thinking", "max"]));
  });

  test("launches with write approval mode", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "write" });

    expect(omp.launchConfiguration()).toEqual({
      cwd: "/tmp/paseo-omp-agent-test",
      protocolMode: "rpc-ui",
      modeId: "write",
      argv: ["omp", "--mode", "rpc-ui", "--approval-mode", "write"],
    });
  });
  test.each([
    ["plan", planTurnPrompt("design the change")],
    ["goal", "/goal design the change"],
  ] as const)(
    "starts OMP native %s workflow with the first prompt",
    async (workflow, expectedPrompt) => {
      const omp = new OmpHarness();
      await omp.start({
        modeId: "ask",
        featureValues: { workflow_mode: workflow },
      });

      expect(omp.launchConfiguration()).toEqual({
        cwd: "/tmp/paseo-omp-agent-test",
        protocolMode: "rpc-ui",
        modeId: "ask",
        argv: ["omp", "--mode", "rpc-ui", "--approval-mode", "always-ask"],
      });
      await omp.runPrompt("design the change", "ready");
      expect(omp.recordedPrompts()[0]?.message).toBe(expectedPrompt);
      await expect(omp.currentMode()).resolves.toBe("ask");
      expect(omp.features()).toEqual([
        expect.objectContaining({ id: "workflow_mode", value: workflow }),
      ]);
    },
  );

  test("starts enhanced workflow without sending a native workflow command", async () => {
    const omp = new OmpHarness();
    await omp.start({
      modeId: "ask",
      featureValues: { workflow_mode: "enhanced" },
    });

    await omp.runPrompt("implement the change", "done");

    expect(omp.recordedPrompts().map((prompt) => prompt.message)).toEqual(["implement the change"]);
    expect(omp.features()).toEqual([
      expect.objectContaining({ id: "workflow_mode", value: "enhanced" }),
    ]);
    expect(omp.runtime().followUpRequests).toEqual([]);
  });

  test("steers a running turn without aborting it", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const turnId = await omp.requireStartTurn("keep working");

    await expect(omp.steerActiveTurn("ACK", turnId)).resolves.toEqual({ status: "accepted" });

    expect(omp.runtime().steerRequests).toEqual([{ message: "ACK", imageCount: 0 }]);
    expect(omp.wasAborted()).toBe(false);
  });

  test("correlates a steered user message with its submitted client message", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const turnId = await omp.requireStartTurn("keep working", {
      clientMessageId: "initial-client-message",
    });
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.acceptPrompt("keep working", "initial-native-message");

    await expect(
      omp.steerActiveTurn("change direction", turnId, {
        clientMessageId: "steer-client-message",
      }),
    ).resolves.toEqual({ status: "accepted" });
    runtime.acceptPrompt("change direction", "steer-native-message");

    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      {
        type: "user_message",
        text: "keep working",
        messageId: "initial-native-message",
        clientMessageId: "initial-client-message",
      },
      {
        type: "user_message",
        text: "change direction",
        messageId: "steer-native-message",
        clientMessageId: "steer-client-message",
      },
    ]);
  });

  test("keeps enhanced selected when leaving plan workflow", async () => {
    const omp = new OmpHarness();
    await omp.start({ featureValues: { workflow_mode: "plan" } });
    await omp.runPrompt("draft a plan", "ready");

    await omp.setFeature("workflow_mode", "enhanced");
    await omp.runPrompt("implement it", "done");

    expect(omp.recordedPrompts().map((prompt) => prompt.message)).toEqual([
      planTurnPrompt("draft a plan"),
      standardTurnPrompt("implement it"),
    ]);
    expect(omp.features()).toEqual([
      expect.objectContaining({ id: "workflow_mode", value: "enhanced" }),
    ]);
  });

  test("continues a standard turn when DeepSeek exhausts its output on reasoning", async () => {
    const omp = new OmpHarness();
    await omp.start({ featureValues: { workflow_mode: "standard", workflow_locale: "zh-CN" } });
    await omp.requireStartTurn("finish the task");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.acceptPrompt("finish the task", "user-1");
    const message = {
      role: "assistant" as const,
      content: [{ type: "thinking" as const, thinking: "working through the task" }],
      responseId: "reasoning-only",
      stopReason: "length",
    };
    runtime.emit({ type: "message_start", message });
    runtime.emit({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "thinking_delta", delta: "working through the task" },
    });
    runtime.finishTurn(message);
    await waitForImmediate();

    expect(omp.completedTurnCount()).toBe(0);
    expect(runtime.followUpRequests).toEqual([{ message: "继续", imageCount: 0 }]);
    runtime.beginTurn();
    runtime.streamAssistantText("task completed", "answer");
    runtime.finishTurn({
      role: "assistant",
      content: [{ type: "text", text: "task completed" }],
      responseId: "answer",
      stopReason: "stop",
    });
    await waitForImmediate();
    expect(omp.completedTurnCount()).toBe(1);
    expect(omp.timeline()).toContainEqual({ type: "reasoning", text: "working through the task" });
    expect(omp.timeline()).toContainEqual({
      type: "assistant_message",
      text: "task completed",
      messageId: "answer",
    });
  });

  test("automatically continues length-limited responses in enhanced workflow", async () => {
    const omp = new OmpHarness();
    await omp.start({
      featureValues: { workflow_mode: "enhanced", workflow_locale: "zh-CN" },
    });

    const { completedBeforeContinuation, result } = await omp.runPromptAfterLengthContinuations(
      "finish the task",
      ["partial output", " more output"],
      " completed output",
    );

    expect(completedBeforeContinuation).toBe(false);
    expect(result).toMatchObject({
      finalText: "partial output more output completed output",
    });
    expect(omp.runtime().followUpRequests).toEqual([
      { message: "继续", imageCount: 0 },
      { message: "继续", imageCount: 0 },
    ]);
    expect(
      omp
        .timeline()
        .filter((item) => item.type === "user_message")
        .map((item) => item.text),
    ).toEqual(["finish the task", "继续"]);
    expect(omp.completedTurnCount()).toBe(1);
  });

  test.each([
    ["ar", "تابع"],
    ["en", "Continue"],
    ["es", "Continúa"],
    ["fr", "Continue"],
    ["ja", "続けて"],
    ["ko", "계속해"],
    ["pt-BR", "Continue"],
    ["ru", "Продолжай"],
    ["zh-CN", "继续"],
  ] as const)("uses the selected %s locale for enhanced continuation", async (locale, expected) => {
    const omp = new OmpHarness();
    await omp.start({ featureValues: { workflow_mode: "enhanced" } });
    await omp.setFeature("workflow_locale", locale);

    await omp.runPromptAfterLengthContinuations("finish the task", ["partial"], "done");

    expect(omp.runtime().followUpRequests).toEqual([{ message: expected, imageCount: 0 }]);
  });

  test("does not automatically continue failed responses in enhanced workflow", async () => {
    const omp = new OmpHarness();
    await omp.start({ featureValues: { workflow_mode: "enhanced" } });

    await expect(
      omp.runPromptWithTerminalAssistant("finish the task", "partial output", {
        role: "assistant",
        content: [{ type: "text", text: "partial output" }],
        responseId: "omp-assistant-1",
        stopReason: "error",
        errorMessage: "provider request failed",
      }),
    ).rejects.toThrow("provider request failed");
    expect(omp.runtime().followUpRequests).toEqual([]);
  });

  test("applies a selected plan workflow to every planning message", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "ask" });

    await omp.setFeature("workflow_mode", "plan");
    await omp.runPrompt("inspect first", "ready");
    await omp.runPrompt("refine the plan", "refined");

    expect(omp.recordedPrompts().map((prompt) => prompt.message)).toEqual([
      planTurnPrompt("inspect first"),
      planTurnPrompt("refine the plan"),
    ]);
    expect(
      omp
        .timeline()
        .filter((item) => item.type === "user_message")
        .map((item) => item.text),
    ).toEqual(["inspect first"]);
    await expect(omp.currentMode()).resolves.toBe("ask");
    expect(omp.features()).toEqual([
      expect.objectContaining({ id: "workflow_mode", value: "plan" }),
    ]);
  });

  test("returns to standard workflow before the next message", async () => {
    const omp = new OmpHarness();
    await omp.start({
      modeId: "ask",
      featureValues: { workflow_mode: "plan" },
    });
    await omp.runPrompt("make a plan", "ready");

    await omp.setFeature("workflow_mode", "standard");
    await omp.runPrompt("continue normally", "done");

    expect(omp.recordedPrompts().map((prompt) => prompt.message)).toEqual([
      planTurnPrompt("make a plan"),
      standardTurnPrompt("continue normally"),
    ]);
  });

  test("keeps applying plan workflow after continuing planning", async () => {
    const omp = new OmpHarness();
    await omp.start({
      modeId: "ask",
      featureValues: { workflow_mode: "plan" },
    });

    const { completion } = await omp.startPromptWithEmptyAgentEnd(
      "draft the change",
      "# Initial plan",
    );
    await completion;
    await omp.respondToPermission("omp-plan-approval", {
      behavior: "deny",
      selectedActionId: "continue-planning",
    });

    await omp.runPrompt("add rollback steps", "# Refined plan");

    expect(omp.recordedPrompts().map((prompt) => prompt.message)).toEqual([
      planTurnPrompt("draft the change"),
      planTurnPrompt("add rollback steps"),
    ]);
    expect(omp.features()).toEqual([
      expect.objectContaining({ id: "workflow_mode", value: "plan" }),
    ]);
  });

  test("publishes workflow changes inferred from legacy plan command output", async () => {
    const omp = new OmpHarness();
    await omp.start({ featureValues: { workflow_mode: "plan" } });

    omp.runtime().emit({ type: "command_output", text: "Plan mode disabled" });
    omp.runtime().emit({ type: "command_output", text: "Plan mode disabled" });

    expect(omp.features()).toEqual([
      expect.objectContaining({ id: "workflow_mode", value: "standard" }),
    ]);
    expect(omp.eventTypes().filter((type) => type === "features_changed")).toHaveLength(1);

    omp.runtime().emit({ type: "command_output", text: "Plan mode enabled" });
    expect(omp.features()).toEqual([
      expect.objectContaining({ id: "workflow_mode", value: "plan" }),
    ]);
    expect(omp.eventTypes().filter((type) => type === "features_changed")).toHaveLength(2);
  });
  test("publishes streamed plans for approval when the terminal message has no text", async () => {
    const omp = new OmpHarness();
    await omp.start({
      modeId: "ask",
      featureValues: { workflow_mode: "plan" },
    });

    const { completion } = await omp.startPromptWithEmptyAgentEnd(
      "design the change",
      "# Implementation plan\n\n1. Inspect\n2. Edit",
    );
    await completion;
    expect(omp.timeline().filter((item) => item.type === "assistant_message")).toEqual([
      expect.objectContaining({
        presentation: "plan",
      }),
    ]);
    expect(omp.pendingPermissions()).toEqual([
      expect.objectContaining({
        id: "omp-plan-approval",
        kind: "plan",
        input: { plan: "# Implementation plan\n\n1. Inspect\n2. Edit" },
        metadata: { planMessageId: expect.any(String) },
      }),
    ]);

    const result = await omp.respondToPermission("omp-plan-approval", {
      behavior: "allow",
      selectedActionId: "implement",
    });

    expect(result).toEqual({
      followUpPrompt:
        "The plan is approved. Exit planning and implement it now. Use tools and modify the working tree as required.",
    });
    expect(omp.handoffRequests()).toEqual([]);
    expect(omp.recordedPrompts().map((prompt) => prompt.message)).toEqual([
      planTurnPrompt("design the change"),
    ]);
    if (typeof result?.followUpPrompt !== "string") {
      throw new Error("Expected approved plan follow-up prompt");
    }
    await omp.runPrompt(result.followUpPrompt, "Implementation complete");
    expect(omp.recordedPrompts().map((prompt) => prompt.message)).toEqual([
      planTurnPrompt("design the change"),
      standardTurnPrompt(
        "The plan is approved. Exit planning and implement it now. Use tools and modify the working tree as required.",
      ),
    ]);
    expect(omp.pendingPermissions()).toEqual([]);
    expect(omp.features()).toEqual([
      expect.objectContaining({ id: "workflow_mode", value: "standard" }),
    ]);

    await omp.runPrompt("answer a follow-up", "Follow-up complete");
    expect(omp.recordedPrompts().at(-1)?.message).toBe("answer a follow-up");
  });

  test("deleting an empty pending goal does not send /goal drop", async () => {
    const omp = new OmpHarness();
    await omp.start({ featureValues: { workflow_mode: "goal" } });

    await omp.controlGoal("delete");
    await omp.runPrompt("continue normally", "done");

    expect(omp.recordedPrompts().map((prompt) => prompt.message)).toEqual(["continue normally"]);
    expect(omp.features()).toEqual([
      expect.objectContaining({ id: "workflow_mode", value: "standard" }),
    ]);
  });

  test("stores, starts, pauses, and deletes a goal independently", async () => {
    const omp = new OmpHarness();
    await omp.start({ featureValues: { workflow_mode: "goal" } });

    await omp.updateGoalObjective("Ship the editable goal bar");
    expect(omp.recordedPrompts()).toEqual([]);

    await omp.controlGoal("start");
    await omp.controlGoal("pause");
    await omp.controlGoal("delete");

    expect(omp.recordedPrompts().map((prompt) => prompt.message)).toEqual([
      "/goal Ship the editable goal bar",
      "/goal pause",
      "/goal drop",
    ]);
    expect(omp.features()).toEqual([
      expect.objectContaining({ id: "workflow_mode", value: "standard" }),
    ]);
  });

  test("passes --thinking when a thinking option is provided", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "ask", thinkingOptionId: "xhigh" }, createToolCatalog());

    expect(omp.launchConfiguration().argv).toEqual([
      "omp",
      "--mode",
      "rpc-ui",
      "--approval-mode",
      "always-ask",
      "--thinking",
      "xhigh",
    ]);
  });

  test("streams a prompt through completion", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(omp.runPrompt("hello OMP", "hello from OMP")).resolves.toMatchObject({
      finalText: "hello from OMP",
    });
    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "hello OMP", messageId: "user-1" },
      {
        type: "assistant_message",
        text: "hello from OMP",
        messageId: "omp-assistant-1",
      },
    ]);
    expect(omp.eventTypes().slice(0, 2)).toEqual(["turn_started", "timeline"]);
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("streams OMP advisor messages as distinct tool-call blocks", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runPromptWithCustomMessage(
      "review this",
      {
        role: "custom",
        content: '<advisory severity="concern">Exercise the failure path.</advisory>',
        customType: "advisor",
        id: "advisor-live-1",
        display: true,
        details: {
          notes: [{ note: "Exercise the failure path.", severity: "concern" }],
        },
      },
      "fixed",
    );

    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "review this", messageId: "user-1" },
      {
        type: "tool_call",
        callId: "omp-advisor:advisor-live-1",
        name: "advisor",
        status: "completed",
        detail: {
          type: "plain_text",
          label: "Advisor · 1 note",
          text: "[concern] Exercise the failure path.",
          icon: "brain",
        },
        metadata: {
          synthetic: true,
          source: "omp_advisor",
          noteCount: 1,
          blockerCount: 0,
        },
        error: null,
      },
      {
        type: "assistant_message",
        text: "fixed",
        messageId: "omp-assistant-1",
      },
    ]);
  });

  test("completes a streamed assistant turn when agent_end omits messages", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const { completion } = await omp.startPromptWithEmptyAgentEnd(
      "hello OMP",
      "empty terminal payload recovered",
    );
    await expect(completion).resolves.toMatchObject({
      finalText: "empty terminal payload recovered",
    });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("probes current context usage once when a historical session opens", async () => {
    const omp = new OmpHarness({
      initialStats: {
        contextUsage: { tokens: 48_000, contextWindow: 272_000 },
      },
    });

    await omp.resume({
      user: { id: "user-history", text: "continue the audit" },
      assistant: { id: "assistant-history", text: "audit context restored" },
    });
    await waitForImmediate();

    expect(omp.usageUpdates()).toEqual([
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        contextWindowMaxTokens: 272_000,
        contextWindowUsedTokens: 48_000,
      },
    ]);
  });

  test("starts and stops context usage polling with the active turn", async () => {
    const scheduler = new ManualUsagePollScheduler();
    const omp = new OmpHarness({ usagePollScheduler: scheduler });
    await omp.start();
    omp.runtime().stats = {
      contextUsage: { tokens: 130, contextWindow: 200_000 },
    };
    omp.runtime().state.contextUsage = { tokens: 99, contextWindow: 100_000 };
    await omp.requireStartTurn("keep working");
    expect(scheduler.activePollCount()).toBe(1);
    scheduler.poll();
    await waitForImmediate();
    expect(omp.usageUpdates()).toEqual([
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 130,
      },
    ]);
    expect(scheduler.activePollCount()).toBe(1);
    omp.runtime().abortError = new Error("abort unavailable");
    await expect(omp.interrupt()).rejects.toThrow("abort unavailable");
    expect(scheduler.activePollCount()).toBe(1);
    omp.runtime().abortError = null;
    await omp.interrupt();
    expect(scheduler.activePollCount()).toBe(0);

    await omp.runPrompt("finish normally", "done");
    expect(scheduler.activePollCount()).toBe(0);

    await omp.requireStartTurn("close the session");
    expect(scheduler.activePollCount()).toBe(1);
    await omp.close();
    expect(scheduler.activePollCount()).toBe(0);
  });

  test("does not accept a follow-up until OMP reports stable idle", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runPrompt("first", "first done", [
      { isStreaming: true, isCompacting: false },
      { isStreaming: false, isCompacting: false },
      { isStreaming: false, isCompacting: false },
    ]);
    await expect(omp.runPrompt("follow-up", "follow-up done")).resolves.toMatchObject({
      finalText: "follow-up done",
    });
  });

  test("stays active while OMP remains busy", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await omp.waitForProviderStateChecks(2);
    await scheduler.waitForWaits(1);

    expect(omp.completedTurnCount()).toBe(0);
    scheduler.retry();
    await omp.waitForProviderStateChecks(3);
    await scheduler.waitForWaits(2);
    expect(omp.completedTurnCount()).toBe(0);

    omp.reportProviderState({ isStreaming: false, isCompacting: false });
    scheduler.retry();
    await expect(completion).resolves.toMatchObject({
      finalText: "first done",
    });
  });

  test("stays active when OMP state checks fail", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();
    omp.failProviderStateChecks(new Error("state unavailable"));

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await omp.waitForProviderStateChecks(2);
    await scheduler.waitForWaits(1);
    expect(omp.completedTurnCount()).toBe(0);

    omp.failProviderStateChecks(null);
    omp.reportProviderState({ isStreaming: false, isCompacting: false });
    scheduler.retry();
    await expect(completion).resolves.toMatchObject({
      finalText: "first done",
    });
  });

  test("does not complete on OMP's extension-notice agent_end", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(
      omp.runPromptAfterExtensionNotice("hello OMP", "model turn completed"),
    ).resolves.toMatchObject({
      finalText: expect.stringContaining("model turn completed"),
    });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("omits live custom messages when display is false", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(
      omp.runPromptAfterExtensionNotice("hello OMP", "model turn completed", false),
    ).resolves.toMatchObject({
      finalText: expect.stringContaining("model turn completed"),
    });
    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "hello OMP", messageId: "user-1" },
      {
        type: "assistant_message",
        text: "model turn completed",
        messageId: "omp-assistant-1",
      },
    ]);
  });

  test("renders a live system-notice custom message as a synthetic tool call", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runPrompt("hello OMP", "done");
    omp
      .runtime()
      .acceptCustomMessage(
        [
          "<system-notice>",
          "Background job DocsSmokeTwo has completed.",
          '<task-result id="DocsSmokeTwo" agent="explore" status="completed" duration="21.6s">',
          "<output>done</output>",
          "</task-result>",
          "</system-notice>",
        ].join("\n"),
      );
    omp
      .runtime()
      .acceptCustomMessage(
        [
          "<irc>",
          "Incoming IRC message from agent DataflowRepair:",
          "All writes released for build.",
          "</irc>",
        ].join("\n"),
      );
    omp.runtime().acceptCustomMessage("plain custom status text");

    expect(omp.timeline().filter((item) => item.type === "tool_call")).toMatchObject([
      {
        callId: "omp-notice:DocsSmokeTwo",
        name: "task_notification",
        status: "completed",
      },
      {
        callId: expect.stringMatching(/^omp-irc:[0-9a-f]{12}$/),
        name: "irc_notification",
        status: "completed",
        detail: { label: "Message from DataflowRepair" },
      },
    ]);
    // Non-notice custom messages still fall through as assistant messages.
    expect(omp.timeline().filter((item) => item.type === "assistant_message")).toMatchObject([
      { text: "done" },
      { text: "plain custom status text" },
    ]);
  });

  test("does not complete a queued model turn from OMP's local-only hint", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(
      omp.runPromptAfterFalseLocalOnlyHint("hello OMP", "queued model turn completed"),
    ).resolves.toMatchObject({ finalText: "queued model turn completed" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("completes a local-only prompt when no OMP turn begins", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(omp.runPromptWithoutTurn("/model")).resolves.toMatchObject({
      finalText: "",
    });
    expect(omp.completedTurnCount()).toBe(1);
  });
  test("keeps workflow directives out of local-only timeline messages", async () => {
    const scheduler = new ManualNoTurnScheduler();
    const omp = new OmpHarness({ noTurnScheduler: scheduler });
    await omp.start({ featureValues: { workflow_mode: "plan" } });

    const planPrompt = await omp.startPromptWithFalseLocalOnlyResult("draft locally");
    scheduler.settle();
    await planPrompt.completion;

    await omp.setFeature("workflow_mode", "standard");
    const standardPrompt = await omp.startPromptWithFalseLocalOnlyResult("implement locally");
    scheduler.settle();
    await standardPrompt.completion;

    expect(omp.recordedPrompts().map((prompt) => prompt.message)).toEqual([
      planTurnPrompt("draft locally"),
      standardTurnPrompt("implement locally"),
    ]);
    expect(
      omp
        .timeline()
        .filter((item) => item.type === "user_message")
        .map((item) => item.text),
    ).toEqual(["draft locally", "implement locally"]);
  });

  test("waits for a delayed queued model turn after OMP's local-only result", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const completion = await omp.runPromptAfterDelayedFalseLocalOnlyResult(
      "hello OMP",
      "delayed queued model turn completed",
    );

    expect(completion.completedBeforeTurn).toBe(false);
    expect(completion.result).toMatchObject({
      finalText: "delayed queued model turn completed",
    });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("completes an async local-only result after the settle window", async () => {
    const scheduler = new ManualNoTurnScheduler();
    const omp = new OmpHarness({ noTurnScheduler: scheduler });
    await omp.start();
    const prompt = await omp.startPromptWithFalseLocalOnlyResult("local-only");

    expect(prompt.completed()).toBe(false);
    scheduler.settle();
    await expect(prompt.completion).resolves.toMatchObject({ finalText: "" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("cancels an async local-only settle when the OMP session closes", async () => {
    const scheduler = new ManualNoTurnScheduler();
    const omp = new OmpHarness({ noTurnScheduler: scheduler });
    await omp.start();
    const prompt = await omp.startPromptWithFalseLocalOnlyResult("local-only");

    await omp.close();

    expect(scheduler.wasAborted()).toBe(true);
    expect(prompt.completed()).toBe(false);
    expect(omp.completedTurnCount()).toBe(0);
  });

  test("preserves a correlated invoked result over a local-only prompt ack", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const completion = await omp.runPromptAfterCorrelatedTrueResult(
      "hello OMP",
      "correlated model turn completed",
    );

    expect(completion.completedBeforeTurn).toBe(false);
    expect(completion.result).toMatchObject({
      finalText: "correlated model turn completed",
    });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("completes an autonomous OMP turn without a foreground turn ID", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runAutonomousTurn("autonomous turn completed");

    expect(omp.completedTurnCount()).toBe(1);
    expect(omp.timeline()).toContainEqual({
      type: "assistant_message",
      text: "autonomous turn completed",
      messageId: "omp-assistant-1",
    });
  });

  test("rejects malformed OMP history before launching a runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-omp-malformed-resume-"));
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(sessionFile, '{"type":"title","title":"truncated"}\n', "utf8");
    const omp = new OmpHarness();

    await expect(omp.resumeFile(sessionFile)).rejects.toThrow(
      "OMP session file is missing a valid session header",
    );
    expect(omp.launchCount()).toBe(0);
  });

  test("resumes an OMP session and replays its history", async () => {
    const omp = new OmpHarness();
    await omp.resume(
      {
        user: { id: "user-history", text: "continue the audit" },
        assistant: { id: "assistant-history", text: "audit context restored" },
      },
      { cwd: "/workspace/resumed", modeId: "ask", thinkingOptionId: "high" },
    );

    expect(omp.launchConfiguration()).toEqual({
      cwd: "/workspace/resumed",
      protocolMode: "rpc-ui",
      modeId: "ask",
      session: expect.stringMatching(/[\\/]paseo-omp-resume-.*[\\/]session\.jsonl$/),
      argv: [
        "omp",
        "--mode",
        "rpc-ui",
        "--approval-mode",
        "always-ask",
        "--thinking",
        "high",
        "--session",
        expect.stringMatching(/[\\/]paseo-omp-resume-.*[\\/]session\.jsonl$/),
      ],
    });
    await expect(omp.history()).resolves.toEqual([
      {
        type: "user_message",
        text: "continue the audit",
        messageId: "user-history",
      },
      {
        type: "assistant_message",
        text: "audit context restored",
        messageId: "assistant-history",
      },
    ]);
  });

  test("expires stale plan directives when continuing a resumed standard session", async () => {
    const omp = new OmpHarness();
    await omp.resume(
      {
        user: { id: "user-stale-plan", text: planTurnPrompt("draft the migration") },
        assistant: { id: "assistant-stale-plan", text: "migration plan ready" },
      },
      { modeId: "ask" },
    );

    expect((await omp.history()).find((item) => item.type === "user_message")?.text).toBe(
      "draft the migration",
    );

    await omp.runPrompt("implement the migration now", "implementation complete");

    expect(omp.recordedPrompts().at(-1)?.message).toBe(
      standardTurnPrompt("implement the migration now"),
    );
    expect(omp.timeline().findLast((item) => item.type === "user_message")?.text).toBe(
      "implement the migration now",
    );
  });

  test("reapplies plan workflow when continuing a resumed session", async () => {
    const omp = new OmpHarness();
    await omp.resume(
      {
        user: { id: "user-plan-history", text: "draft the migration" },
        assistant: { id: "assistant-plan-history", text: "migration plan restored" },
      },
      {
        modeId: "ask",
        featureValues: { workflow_mode: "plan" },
      },
    );

    await omp.runPrompt("add rollback steps", "updated migration plan");

    expect(omp.recordedPrompts().at(-1)?.message).toBe(planTurnPrompt("add rollback steps"));
  });

  test("maps permissions and sends the selected OMP response", async () => {
    const omp = new OmpHarness();
    await omp.start();

    omp.requestToolApproval({
      id: "approval-1",
      tool: "bash",
      detail: "git status",
    });
    expect(omp.pendingPermissions()).toEqual([
      expect.objectContaining({ id: "approval-1", name: "bash", kind: "tool" }),
    ]);

    await omp.respondToPermission("approval-1", { behavior: "allow" });
    expect(omp.extensionUiResponses()).toEqual([
      { id: "approval-1", response: { value: "Approve" } },
    ]);
  });

  test("folds OMP ask custom input into the Other option", async () => {
    const omp = new OmpHarness();
    await omp.start();

    omp.emitExtensionUiRequest({
      type: "extension_ui_request",
      id: "ask-select-1",
      method: "select",
      title: "Which capability should ship first?",
      options: ["Task execution", "Blueprint editor", "Other (type your own)"],
    });
    expect(omp.pendingPermissions()).toEqual([
      expect.objectContaining({
        id: "ask-select-1",
        kind: "question",
        input: {
          questions: [
            {
              question: "Which capability should ship first?",
              header: "Response",
              options: [{ label: "Task execution" }, { label: "Blueprint editor" }],
              multiSelect: false,
              allowOther: true,
            },
          ],
        },
      }),
    ]);

    await omp.respondToPermission("ask-select-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "Live collaboration" } },
    });
    expect(omp.extensionUiResponses()).toEqual([
      { id: "ask-select-1", response: { value: "Other (type your own)" } },
    ]);

    omp.emitExtensionUiRequest({
      type: "extension_ui_request",
      id: "ask-editor-1",
      method: "editor",
      title: "Which capability should ship first?",
    });
    expect(omp.extensionUiResponses()).toEqual([
      { id: "ask-select-1", response: { value: "Other (type your own)" } },
      { id: "ask-editor-1", response: { value: "Live collaboration" } },
    ]);
    expect(omp.pendingPermissions()).toEqual([]);
  });

  test("exposes OMP modes and commands through the domain session", async () => {
    const omp = new OmpHarness();
    omp.queueCommands([{ name: "review", description: "Review changes", source: "skill" }]);
    await omp.start();

    await expect(omp.availableModes()).resolves.toEqual([
      expect.objectContaining({ id: "ask" }),
      expect.objectContaining({ id: "write" }),
      expect.objectContaining({ id: "full" }),
    ]);
    expect(omp.features()).toEqual([
      expect.objectContaining({
        id: "workflow_mode",
        type: "select",
        options: [
          { id: "standard", label: "Standard" },
          { id: "enhanced", label: "Enhanced" },
          { id: "plan", label: "Plan" },
          { id: "goal", label: "Goal" },
        ],
        value: "standard",
      }),
    ]);
    await expect(omp.commands()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "handoff" }),
        expect.objectContaining({ name: "review", kind: "skill" }),
      ]),
    );
    await expect(omp.setMode("ask")).resolves.toBeUndefined();
  });

  test("rewinds natively, interrupts, and shuts down", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.rewind("user-history", "from history");
    expect(omp.branchRequests()).toEqual(["user-history"]);

    await omp.interruptActiveTurn("stop me");
    expect(omp.wasAborted()).toBe(true);
    expect(omp.canceledTurnCount()).toBe(1);

    await omp.close();
    expect(omp.isClosed()).toBe(true);
  });
  test("does not let late autonomous events wake an interrupted conversation", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.interruptActiveTurn("stop me");
    await omp.runAutonomousTurn("late background completion");

    expect(omp.completedTurnCount()).toBe(0);
    expect(omp.timeline()).not.toContainEqual(
      expect.objectContaining({ text: "late background completion" }),
    );

    await omp.runPrompt("continue explicitly", "continued");
    expect(omp.timeline()).toContainEqual(
      expect.objectContaining({ type: "assistant_message", text: "continued" }),
    );
  });

  test("interrupt terminalizes in-flight tool calls, retry notices, and running subagents", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.requireStartTurn("run something slow");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "sleep 30" },
    });
    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "child-1",
        agent: "worker",
        status: "started",
        parentToolCallId: "tool-1",
        index: 0,
      },
    });
    runtime.emit({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 10,
      delayMs: 1_000,
      errorMessage: "rate limited",
    });
    expect(omp.runningToolCallIds()).toEqual(["tool-1", "omp-auto-retry:2"]);
    expect(omp.subagentUpserts()).toEqual([{ id: "child-1", status: "running" }]);

    await omp.interrupt();

    expect(omp.canceledTurnCount()).toBe(1);
    expect(omp.runningToolCallIds()).toEqual([]);
    expect(omp.subagentUpserts()).toEqual([
      { id: "child-1", status: "running" },
      { id: "child-1", status: "canceled" },
    ]);
    expect(omp.timeline()).toContainEqual(
      expect.objectContaining({
        type: "tool_call",
        callId: "omp-auto-retry:2",
        status: "canceled",
      }),
    );

    // Late progress after interrupt must not resurrect a running card.
    runtime.emit({
      type: "subagent_progress",
      payload: {
        id: "child-1",
        agent: "worker",
        index: 0,
        progress: { id: "child-1", status: "running" },
        parentToolCallId: "tool-1",
      },
    });
    expect(omp.runningToolCallIds()).toEqual([]);
  });

  test("manual compact completes from the RPC response without provider lifecycle events", async () => {
    const omp = new OmpHarness();
    await omp.start();
    omp.runtime().emitCompactStart = false;
    omp.runtime().emitCompactEnd = false;

    const events = await omp.runOutOfBand("/compact preserve decisions");
    expect(omp.compactRequests()).toEqual([{ customInstructions: "preserve decisions" }]);
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: { type: "compaction", status: "loading", trigger: "manual" },
      },
      {
        type: "timeline",
        provider: "omp",
        item: { type: "compaction", status: "completed", trigger: "manual" },
      },
    ]);
  });

  test("manual compact refreshes context usage after compaction", async () => {
    const scheduler = new ManualUsagePollScheduler();
    const omp = new OmpHarness({ usagePollScheduler: scheduler });
    await omp.start();
    omp.runtime().stats = {
      contextUsage: { tokens: 55_000, contextWindow: 272_000 },
    };
    await omp.requireStartTurn("prepare context");
    scheduler.poll();
    await waitForImmediate();
    await omp.interrupt();

    omp.runtime().stats = {
      contextUsage: { tokens: 8_000, contextWindow: 272_000 },
    };
    await omp.runOutOfBand("/compact");

    expect(omp.usageUpdates()).toEqual([
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        contextWindowMaxTokens: 272_000,
        contextWindowUsedTokens: 55_000,
      },
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        contextWindowMaxTokens: 272_000,
        contextWindowUsedTokens: 8_000,
      },
    ]);
  });

  test("manual compact deduplicates provider lifecycle events", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const events = await omp.runOutOfBand("/compact");
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: { type: "compaction", status: "loading", trigger: "manual" },
      },
      {
        type: "timeline",
        provider: "omp",
        item: { type: "compaction", status: "completed", trigger: "manual" },
      },
    ]);
  });

  test("a resumed session does not re-emit replayed events as live timeline items", async () => {
    const omp = new OmpHarness();
    await omp.resume({
      user: { id: "user-history", text: "continue the audit" },
      assistant: { id: "assistant-history", text: "audit context restored" },
    });

    const runtime = omp.runtime();
    // OMP replays pre-existing conversation on startup with --session.
    runtime.acceptPrompt("continue the audit", "user-history");
    runtime.streamAssistantText("audit context restored", "assistant-history");
    expect(omp.timeline()).toEqual([]);

    // The first live prompt flows normally.
    await expect(omp.runPrompt("next step", "on it")).resolves.toMatchObject({
      finalText: "on it",
    });
    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "next step", messageId: "user-1" },
      {
        type: "assistant_message",
        text: "on it",
        messageId: "omp-assistant-1",
      },
    ]);
  });

  test("re-emitted user message_end frames dedupe by native entry id", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(omp.runPrompt("hello OMP", "hello from OMP")).resolves.toMatchObject({
      finalText: "hello from OMP",
    });
    // OMP can re-send message_end for an entry it already surfaced.
    omp.runtime().acceptPrompt("hello OMP", "user-1");
    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      { type: "user_message", text: "hello OMP", messageId: "user-1" },
    ]);
  });

  test("image-only user frames retain bytes and resolve native and client identities", async () => {
    const omp = new OmpHarness();
    await omp.start();
    await omp.requireStartTurn("", { clientMessageId: "client-image-only" });
    const runtime = omp.runtime();
    const image = {
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aShoAAAAASUVORK5CYII=",
      mimeType: "image/png",
    };
    runtime.branchMessages = [{ entryId: "native-image-only", text: "" }];
    runtime.beginTurn();
    runtime.emit({
      type: "message_end",
      message: { role: "user", content: [{ type: "image", ...image }] },
    });
    await waitForImmediate();
    runtime.emit({
      type: "message_end",
      message: { role: "user", content: [{ type: "image", ...image }] },
    });
    await waitForImmediate();
    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      {
        type: "user_message",
        text: "",
        images: [image],
        messageId: "native-image-only",
        clientMessageId: "client-image-only",
      },
    ]);
    await omp.close();
  });

  test("late duplicate user frames dedupe by prompt text after a turn completes", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(omp.runPrompt("describe this image", "done")).resolves.toMatchObject({
      finalText: "done",
    });
    omp.runtime().acceptPrompt("describe this image", "duplicate-image-entry");

    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      {
        type: "user_message",
        text: "describe this image",
        messageId: "user-1",
      },
    ]);
  });

  test("late user frames retain the submitted client identity after turn completion", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.requireStartTurn("describe this image", {
      clientMessageId: "client-image-prompt",
    });
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.streamAssistantText("done");
    runtime.finishTurn();
    runtime.acceptPrompt("describe this image", "late-image-entry");

    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      {
        type: "user_message",
        text: "describe this image",
        messageId: "late-image-entry",
        clientMessageId: "client-image-prompt",
      },
    ]);
  });
});
