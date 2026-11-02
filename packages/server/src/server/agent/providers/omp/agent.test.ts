import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PaseoToolCatalog } from "../../tools/types.js";
import type { OmpNoTurnScheduler, OmpProviderIdleScheduler } from "./agent.js";
import type { OmpUsagePollScheduler } from "./usage-poller.js";
import { OmpHarness } from "./test-utils/omp-harness.js";
import type { OmpAgentMessage, OmpRpcSlashCommand, OmpSessionState } from "./rpc-types.js";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

  test.each(["claude-opus-4-8", "claude-opus-5", "claude-opus-5-5"])(
    "offers fast mode for direct Anthropic %s in drafts and sessions",
    async (id) => {
      const omp = new OmpHarness({
        initialModel: { provider: "anthropic", id, api: "anthropic-messages" },
      });
      const model = `anthropic/${id}`;
      const feature = expect.objectContaining({ id: "fast_mode", type: "toggle", value: false });

      expect(await omp.listFeatures({ model })).toEqual(expect.arrayContaining([feature]));
      await omp.start({ model });
      expect(omp.features()).toEqual(expect.arrayContaining([feature]));
      await omp.setFeature("fast_mode", true);
      expect(omp.features()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "fast_mode", value: true })]),
      );
    },
  );

  test.each([
    { provider: "anthropic", id: "claude-opus-4-6", api: "anthropic-messages" },
    { provider: "anthropic", id: "claude-opus-4-7", api: "anthropic-messages" },
    { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" },
    { provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic-messages" },
    { provider: "amazon-bedrock", id: "claude-opus-5-5", api: "bedrock-converse-stream" },
    { provider: "google-vertex", id: "claude-opus-5-5", api: "anthropic-messages" },
    { provider: "openrouter", id: "anthropic/claude-opus-5-5", api: "openai-completions" },
    { provider: "custom-claude", id: "claude-opus-5-5", api: "anthropic-messages" },
    { provider: "anthropic", id: "claude-opus-5-5", api: "openai-responses" },
    { provider: "anthropic", id: "not-opus", name: "Claude Opus 5.5", api: "anthropic-messages" },
  ])("does not offer Claude fast mode for $provider/$id on $api", async (initialModel) => {
    const omp = new OmpHarness({ initialModel });
    const config = {
      model: `${initialModel.provider}/${initialModel.id}`,
      featureValues: { fast_mode: true },
    };

    expect(await omp.listFeatures(config)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fast_mode" })]),
    );
    await omp.start(config);
    expect(omp.features()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fast_mode" })]),
    );
    await expect(omp.setFeature("fast_mode", true)).rejects.toThrow(
      "OMP fast mode is unavailable for the current model",
    );
  });

  test("uses the resolved Claude model rather than a stale configured model for fast mode", async () => {
    const omp = new OmpHarness({
      initialModel: {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        api: "anthropic-messages",
      },
    });
    await omp.start({ model: "anthropic/claude-opus-5-5" });

    expect(omp.features()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fast_mode" })]),
    );
  });

  test("reapplies fast mode after switching to a family with a different native tier", async () => {
    const omp = new OmpHarness();
    await omp.start({
      model: "openai-codex/gpt-5.6",
      featureValues: { fast_mode: true },
    });
    // OMP stores separate service tiers for OpenAI and Anthropic.
    omp.runtime().state.fastModeEnabled = false;
    omp.runtime().state.fastModeActive = false;

    await omp.setModel("anthropic", "claude-opus-5-5", { api: "anthropic-messages" });

    expect(omp.runtime().state.fastModeEnabled).toBe(true);
    expect(omp.features()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fast_mode", value: true })]),
    );
  });

  test("reads the selected family's native fast state when no preference was configured", async () => {
    const omp = new OmpHarness();
    await omp.start({ model: "openai-codex/gpt-5.6" });
    omp.runtime().state.fastModeEnabled = true;
    omp.runtime().state.fastModeActive = true;

    await omp.setModel("anthropic", "claude-opus-5-5", { api: "anthropic-messages" });

    expect(omp.features()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fast_mode", value: true })]),
    );
  });

  test("records a model switch only after the conversation has a user message", async () => {
    const omp = new OmpHarness({
      initialModel: { provider: "custom-openai", id: "initial" },
    });
    await omp.start({ model: "custom-openai/initial" });
    expect(omp.timeline().filter((item) => item.type === "system_notice")).toEqual([]);

    await omp.setModel("custom-openai", "draft");
    expect(omp.timeline().filter((item) => item.type === "system_notice")).toEqual([]);

    await omp.runPrompt("Hello", "Hi");
    await omp.setModel("custom-openai", "final");
    await omp.setModel("custom-openai", "final");

    expect(omp.timeline().filter((item) => item.type === "system_notice")).toEqual([
      { type: "system_notice", notice: "model_changed", modelId: "custom-openai/final" },
    ]);
  });

  test("records a model switch in a resumed conversation with prior user messages", async () => {
    const omp = new OmpHarness({
      initialModel: { provider: "custom-openai", id: "initial" },
    });
    await omp.resume(
      {
        user: { id: "user-1", text: "Earlier request" },
        assistant: { id: "assistant-1", text: "Earlier reply" },
      },
      { model: "custom-openai/initial" },
    );
    omp.runtime().messages = [{ role: "user", content: "Earlier request" }];

    await omp.setModel("custom-openai", "final");

    expect(omp.timeline().filter((item) => item.type === "system_notice")).toEqual([
      { type: "system_notice", notice: "model_changed", modelId: "custom-openai/final" },
    ]);
  });

  test("records thinking changes only after successful transitions, without duplicate notices", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.setThinkingOption("low");
    await omp.setThinkingOption("low");
    const setter = vi
      .spyOn(omp.runtime(), "setThinkingLevel")
      .mockRejectedValueOnce(new Error("Thinking update failed"));

    await expect(omp.setThinkingOption("high")).rejects.toThrow("Thinking update failed");
    expect(omp.timeline().filter((item) => item.type === "system_notice")).toEqual([
      { type: "system_notice", notice: "thinking_changed", thinkingOptionId: "low" },
    ]);
    expect(await omp.runtimeInfo()).toMatchObject({ thinkingOptionId: "low" });

    setter.mockRestore();
    await omp.setThinkingOption("high");

    expect(omp.timeline().filter((item) => item.type === "system_notice")).toEqual([
      { type: "system_notice", notice: "thinking_changed", thinkingOptionId: "low" },
      { type: "system_notice", notice: "thinking_changed", thinkingOptionId: "high" },
    ]);
    expect(await omp.runtimeInfo()).toMatchObject({ thinkingOptionId: "high" });
  });

  test.each(["openai-codex/gpt-5.6", "anthropic/claude-opus-5-5"])(
    "records only successful fast-mode transitions as system notices for %s",
    async (model) => {
      const omp = new OmpHarness();
      await omp.start({ model });

      await omp.setFeature("fast_mode", true);
      expect(omp.features()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "fast_mode", value: true })]),
      );
      await omp.setFeature("fast_mode", true);
      await expect(omp.setFeature("fast_mode", "on")).rejects.toThrow("Invalid OMP fast mode");

      await omp.setModel("custom-openai", "model");
      expect(omp.features()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "fast_mode" })]),
      );

      const [provider, id] = model.split("/");
      await omp.setModel(provider!, id!);
      expect(omp.features()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "fast_mode", value: true })]),
      );

      await omp.setFeature("fast_mode", false);
      expect(omp.features()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "fast_mode", value: false })]),
      );
      expect(omp.timeline().filter((item) => item.type === "system_notice")).toEqual([
        { type: "system_notice", notice: "fast_mode_enabled" },
        { type: "system_notice", notice: "fast_mode_disabled" },
      ]);
    },
  );

  test.each(["openai-codex/gpt-5.6", "anthropic/claude-opus-5-5"])(
    "applies a persisted fast-mode preference without adding a switch notice for %s",
    async (model) => {
      const omp = new OmpHarness();
      await omp.start({
        model,
        featureValues: { fast_mode: true },
      });

      expect(omp.timeline().filter((item) => item.type === "system_notice")).toEqual([]);
      expect(omp.features()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "fast_mode", value: true })]),
      );
    },
  );

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

  test.each(["openai-codex/gpt-5.6", "anthropic/claude-opus-5-5"])(
    "hides fast mode when the installed OMP RPC does not support it for %s",
    async (model) => {
      const omp = new OmpHarness({ fastModeSupported: false });
      await omp.start({
        model,
        featureValues: { fast_mode: true },
      });

      expect(omp.features()).toEqual([expect.objectContaining({ id: "workflow_mode" })]);
      expect(omp.fastModeRequests()).toEqual([]);
      await expect(omp.setFeature("fast_mode", true)).rejects.toThrow(
        "OMP fast mode is unavailable for the current model",
      );
    },
  );

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

  test("registers native host tools and exposes their capabilities", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "ask" }, createToolCatalog());

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

    await expect(omp.steerActiveTurn("ACK", turnId)).resolves.toEqual({
      status: "accepted",
      userMessageEcho: "provider",
    });

    expect(omp.runtime().steerRequests).toEqual([{ message: "ACK", imageCount: 0 }]);
    expect(omp.wasAborted()).toBe(false);
  });

  test("distinguishes absent and mismatched steering targets", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(omp.steerActiveTurn("too early", "missing-turn")).resolves.toEqual({
      status: "unavailable",
      reason: "no_active_turn",
    });

    const turnId = await omp.requireStartTurn("keep working");
    await expect(omp.steerActiveTurn("wrong target", `${turnId}-stale`)).resolves.toEqual({
      status: "unavailable",
      reason: "turn_mismatch",
    });
    expect(omp.runtime().steerRequests).toEqual([]);
  });

  test("keeps a parent steerable while a native subagent continues", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const turnId = await omp.requireStartTurn("delegate slow work");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.acceptPrompt("delegate slow work", "initial-message");
    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "child-1",
        agent: "task",
        status: "started",
        parentToolCallId: "task-1",
        index: 0,
      },
    });
    runtime.streamAssistantText("waiting for child", "assistant-before-yield");
    runtime.emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "waiting for child" }],
          responseId: "assistant-before-yield",
        },
      ],
      isTerminal: false,
    });
    await waitForImmediate();

    await expect(
      omp.steerActiveTurn("change direction", turnId, {
        clientMessageId: "steer-client-message",
      }),
    ).resolves.toEqual({ status: "accepted", userMessageEcho: "provider" });
    runtime.acceptPrompt("change direction", "steer-native-message");

    expect(runtime.steerRequests).toEqual([{ message: "change direction", imageCount: 0 }]);
    expect(omp.timeline()).toContainEqual({
      type: "user_message",
      text: "change direction",
      messageId: "steer-native-message",
      clientMessageId: "steer-client-message",
    });
    expect(omp.subagentUpserts()).toEqual([{ id: "child-1", status: "running" }]);
    expect(omp.completedTurnCount()).toBe(0);
    expect(omp.wasAborted()).toBe(false);
  });

  test("correlates queued steered user messages when the provider consumes them", async () => {
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
        clientMessageId: "first-steer-client-message",
      }),
    ).resolves.toEqual({ status: "accepted", userMessageEcho: "provider" });
    await expect(
      omp.steerActiveTurn("add regression coverage", turnId, {
        clientMessageId: "second-steer-client-message",
      }),
    ).resolves.toEqual({ status: "accepted", userMessageEcho: "provider" });
    runtime.acceptPrompt("change direction", "first-steer-native-message");
    runtime.acceptPrompt("add regression coverage", "second-steer-native-message");

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
        messageId: "first-steer-native-message",
        clientMessageId: "first-steer-client-message",
      },
      {
        type: "user_message",
        text: "add regression coverage",
        messageId: "second-steer-native-message",
        clientMessageId: "second-steer-client-message",
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

  test("surfaces a sanitized proxy rejection and keeps the session retryable", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const failure = await omp
      .runPromptWithTerminalAssistant("finish the task", "", {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorStatus: 407,
        errorMessage:
          "Proxy http://alice:secret@proxy.example refused to open a tunnel: 407 Auth Failed (code: ip_forbidden)",
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Provider request failed: proxy tunnel rejected (HTTP 407, ip_forbidden)",
    );
    expect((failure as Error).message).not.toContain("alice");
    expect((failure as Error).message).not.toContain("secret");

    await expect(omp.runPrompt("retry after proxy recovery", "recovered")).resolves.toBeDefined();
    expect(omp.failedTurnCount()).toBe(1);
    expect(omp.completedTurnCount()).toBe(1);
  });

  describe("enhanced model error continuation", () => {
    const sessions = new Set<OmpHarness>();

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    afterEach(async () => {
      try {
        for (const session of sessions) await session.close();
      } finally {
        sessions.clear();
        vi.useRealTimers();
      }
    });

    async function startFailedTurn(
      message: Extract<OmpAgentMessage, { role: "assistant" }>,
      workflowMode: "standard" | "enhanced" | "plan" | "goal" = "enhanced",
    ): Promise<OmpHarness> {
      const omp = new OmpHarness();
      sessions.add(omp);
      await omp.start({
        featureValues: { workflow_mode: workflowMode, workflow_locale: "zh-CN" },
      });
      await omp.requireStartTurn("finish the task");
      const runtime = omp.runtime();
      runtime.beginTurn();
      runtime.acceptPrompt("finish the task", "user-1");
      runtime.finishTurn(message);
      await waitForImmediate();
      return omp;
    }

    test("finishes a disconnected local source instead of continuing enhanced mode forever", async () => {
      const omp = await startFailedTurn({
        role: "assistant",
        provider: "desktop-local",
        model: "fixture/model",
        content: [],
        stopReason: "error",
        errorStatus: 410,
        errorMessage: "Local model source unavailable. Reconnect OMP Desktop.",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(omp.failedTurnCount()).toBe(1);
      expect(omp.completedTurnCount()).toBe(0);
      expect(omp.runtime().followUpRequests).toEqual([]);
    });

    test.each([400, 401, 403, 429, 499, 500, 503, 599])(
      "keeps HTTP %i active until a continuation recovers after five seconds",
      async (errorStatus) => {
        const omp = await startFailedTurn({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorStatus,
        });
        const runtime = omp.runtime();

        await vi.advanceTimersByTimeAsync(4_999);
        expect(runtime.followUpRequests).toEqual([]);
        expect(omp.failedTurnCount()).toBe(0);
        expect(omp.completedTurnCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(runtime.followUpRequests).toEqual([{ message: "继续", imageCount: 0 }]);

        runtime.beginTurn();
        runtime.acceptPrompt("继续", "user-2");
        runtime.streamAssistantText("recovered", "recovery");
        runtime.finishTurn({
          role: "assistant",
          content: [{ type: "text", text: "recovered" }],
          stopReason: "stop",
        });
        await waitForImmediate();
        expect(omp.failedTurnCount()).toBe(0);
        expect(omp.completedTurnCount()).toBe(1);
        expect(omp.timeline()).toContainEqual({
          type: "assistant_message",
          text: "recovered",
          messageId: "recovery",
        });
      },
    );

    test.each([
      [
        "a stream error without HTTP status",
        undefined,
        "Error Code server_error: We're sorry, the param is invalid. Please try with a valid param.",
      ],
      [
        "an exhausted OMP retry budget",
        undefined,
        "Retry budget exhausted after 10 retries: Error Code server_error: invalid param",
      ],
      ["a non-HTTP status", 600, "upstream failure"],
      ["a missing error message", undefined, undefined],
    ])("continues after %s", async (_label, errorStatus, errorMessage) => {
      const omp = await startFailedTurn({
        role: "assistant",
        content: [],
        stopReason: "error",
        ...(errorStatus === undefined ? {} : { errorStatus }),
        ...(errorMessage === undefined ? {} : { errorMessage }),
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(omp.runtime().followUpRequests).toEqual([{ message: "继续", imageCount: 0 }]);
      expect(omp.failedTurnCount()).toBe(0);
      expect(omp.completedTurnCount()).toBe(0);
    });

    test("continues repeated HTTP errors once per five-second wait without completing the turn", async () => {
      const omp = await startFailedTurn({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorStatus: 401,
      });
      const runtime = omp.runtime();

      for (const [index, errorStatus] of [401, 503, 400].entries()) {
        if (index > 0) {
          runtime.beginTurn();
          runtime.acceptPrompt("继续", `user-${index + 1}`);
          runtime.finishTurn({ role: "assistant", content: [], stopReason: "error", errorStatus });
        }
        await vi.advanceTimersByTimeAsync(4_999);
        runtime.emit({ type: "agent_end", messages: runtime.messages });
        expect(runtime.followUpRequests).toHaveLength(index);
        await vi.advanceTimersByTimeAsync(1);
        expect(runtime.followUpRequests).toHaveLength(index + 1);
        expect(omp.failedTurnCount()).toBe(0);
        expect(omp.completedTurnCount()).toBe(0);
      }
      await vi.advanceTimersByTimeAsync(20_000);
      expect(runtime.followUpRequests).toHaveLength(3);
    });

    test.each(["standard", "plan", "goal"] as const)(
      "leaves HTTP failures terminal in %s workflow",
      async (workflowMode) => {
        const omp = await startFailedTurn(
          {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorStatus: 503,
            errorMessage: "503 Service Unavailable",
          },
          workflowMode,
        );

        await vi.advanceTimersByTimeAsync(5_000);
        expect(omp.runtime().followUpRequests).toEqual([]);
        expect(omp.failedTurnCount()).toBe(1);
      },
    );

    test("does not resume an aborted HTTP response", async () => {
      const omp = await startFailedTurn({
        role: "assistant",
        content: [],
        stopReason: "aborted",
        errorStatus: 500,
        errorMessage: "500 Internal Server Error",
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(omp.runtime().followUpRequests).toEqual([]);
      expect(omp.canceledTurnCount()).toBe(1);
    });

    test("cancels a pending continuation before a new user turn starts", async () => {
      const omp = await startFailedTurn({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorStatus: 429,
      });
      await vi.advanceTimersByTimeAsync(4_999);
      await omp.interrupt();
      await omp.requireStartTurn("new task");
      const runtime = omp.runtime();
      runtime.beginTurn();

      await vi.advanceTimersByTimeAsync(5_001);
      expect(runtime.followUpRequests).toEqual([]);
      expect(omp.canceledTurnCount()).toBe(1);
      expect(omp.failedTurnCount()).toBe(0);
      runtime.finishTurn({ role: "assistant", content: [], stopReason: "stop" });
      await waitForImmediate();
      expect(omp.completedTurnCount()).toBe(1);
    });

    test("retains automatic continuation when the provider rejects a stop request", async () => {
      const omp = await startFailedTurn({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorStatus: 503,
      });
      omp.runtime().abortError = new Error("abort failed");
      await expect(omp.interrupt()).rejects.toThrow("abort failed");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(omp.runtime().followUpRequests).toEqual([{ message: "继续", imageCount: 0 }]);
      expect(omp.failedTurnCount()).toBe(0);
      expect(omp.canceledTurnCount()).toBe(0);
    });

    test("drops a delayed continuation when another provider turn recovers first", async () => {
      const omp = await startFailedTurn({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorStatus: 503,
      });
      omp.runtime().beginTurn();
      omp.runtime().finishTurn({ role: "assistant", content: [], stopReason: "stop" });
      await waitForImmediate();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(omp.runtime().followUpRequests).toEqual([]);
      expect(omp.completedTurnCount()).toBe(1);
      expect(omp.failedTurnCount()).toBe(0);
    });

    test("stops retrying when enhanced workflow is disabled", async () => {
      const omp = await startFailedTurn({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorStatus: 503,
        errorMessage: "503 Service Unavailable",
      });
      await omp.setFeature("workflow_mode", "standard");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(omp.runtime().followUpRequests).toEqual([]);
      expect(omp.failedTurnCount()).toBe(1);
    });

    test("drops a pending continuation after the provider exits", async () => {
      const omp = await startFailedTurn({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorStatus: 503,
      });
      omp.runtime().emit({ type: "process_exit", error: "provider exited" });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(omp.runtime().followUpRequests).toEqual([]);
      expect(omp.failedTurnCount()).toBe(1);
    });

    test("drops a pending continuation when the session closes", async () => {
      const omp = await startFailedTurn({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorStatus: 503,
      });
      await omp.close();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(omp.runtime().followUpRequests).toEqual([]);
      expect(omp.isClosed()).toBe(true);
    });
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
        scope: "session",
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
        scope: "session",
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

  test("does not let a deferred terminal state response settle a replacement turn", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const { promise: stateRequested, resolve: markStateRequested } = Promise.withResolvers<void>();
    const { promise: staleState, resolve: releaseStaleState } =
      Promise.withResolvers<OmpSessionState>();
    const getState = runtime.getState.bind(runtime);
    let deferNextState = true;
    runtime.getState = async () => {
      if (!deferNextState) return await getState();
      deferNextState = false;
      markStateRequested();
      return await staleState;
    };

    await omp.requireStartTurn("turn A");
    runtime.beginTurn();
    runtime.streamAssistantText("A done", "assistant-a");
    runtime.finishTurn({
      role: "assistant",
      content: [{ type: "text", text: "A done" }],
      responseId: "assistant-a",
    });
    await stateRequested;

    await omp.interrupt("replacement");
    const turnB = await omp.requireStartTurn("turn B");
    releaseStaleState({ ...runtime.state, isStreaming: false, isCompacting: false });
    await waitForImmediate();

    expect(omp.completedTurnCount()).toBe(0);
    expect(omp.canceledTurnCount()).toBe(1);
    await expect(omp.steerActiveTurn("continue B", turnB)).resolves.toEqual({
      status: "accepted",
      userMessageEcho: "provider",
    });

    runtime.beginTurn();
    runtime.streamAssistantText("B done", "assistant-b");
    runtime.finishTurn({
      role: "assistant",
      content: [{ type: "text", text: "B done" }],
      responseId: "assistant-b",
    });
    await vi.waitFor(() => expect(omp.completedTurnCount()).toBe(1));
  });

  test("invalidates an idle check when OMP continues the same Desktop turn", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const { promise: stateRequested, resolve: markStateRequested } = Promise.withResolvers<void>();
    const { promise: staleState, resolve: releaseStaleState } =
      Promise.withResolvers<OmpSessionState>();
    const getState = runtime.getState.bind(runtime);
    let deferNextState = true;
    runtime.getState = async () => {
      if (!deferNextState) return await getState();
      deferNextState = false;
      markStateRequested();
      return await staleState;
    };

    const turnId = await omp.requireStartTurn("work through both cycles");
    runtime.beginTurn();
    runtime.streamAssistantText("first cycle", "assistant-first");
    runtime.finishTurn({
      role: "assistant",
      content: [{ type: "text", text: "first cycle" }],
      responseId: "assistant-first",
    });
    await stateRequested;

    runtime.beginTurn();
    runtime.streamAssistantText("second cycle", "assistant-second");
    releaseStaleState({ ...runtime.state, isStreaming: false, isCompacting: false });
    await waitForImmediate();
    expect(omp.completedTurnCount()).toBe(0);

    runtime.finishTurn({
      role: "assistant",
      content: [{ type: "text", text: "second cycle" }],
      responseId: "assistant-second",
    });
    await vi.waitFor(() => expect(omp.completedTurnCount()).toBe(1));
    expect(
      omp
        .streamEvents()
        .filter((event) => event.type === "turn_started")
        .map((event) => event.turnId),
    ).toEqual([turnId, turnId]);
  });

  test("ignores a deferred terminal state response after close", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const { promise: stateRequested, resolve: markStateRequested } = Promise.withResolvers<void>();
    const { promise: staleState, resolve: releaseStaleState } =
      Promise.withResolvers<OmpSessionState>();
    runtime.getState = async () => {
      markStateRequested();
      return await staleState;
    };

    await omp.requireStartTurn("close while settling");
    runtime.beginTurn();
    runtime.streamAssistantText("too late");
    runtime.finishTurn();
    await stateRequested;

    await omp.close();
    releaseStaleState({ ...runtime.state, isStreaming: false, isCompacting: false });
    await waitForImmediate();

    expect(
      omp
        .streamEvents()
        .filter(
          (event) =>
            event.type === "turn_completed" ||
            event.type === "turn_canceled" ||
            event.type === "turn_failed",
        ),
    ).toEqual([]);
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

  test.each(["fresh", "resumed"] as const)(
    "retains an idle plugin original in a %s session without a model turn",
    async (phase) => {
      const omp = new OmpHarness();
      if (phase === "resumed") {
        await omp.resume({
          user: { id: "previous-user", text: "previous request" },
          assistant: { id: "previous-answer", text: "previous answer" },
        });
      } else {
        await omp.start();
      }
      const text = '{\n  "state": "stopped",\n  "upstreamEnabled": false\n}\n';
      const details = { event: "status", schemaVersion: 1 };
      omp.runtime().emit({
        type: "message_end",
        message: {
          role: "custom",
          customType: "omp-workbuddy-plugin",
          content: text,
          display: true,
          entryId: "native-idle-status",
          details,
        },
      });
      expect(omp.timeline()).toEqual([
        {
          type: "assistant_message",
          text,
          messageId: "native-idle-status",
          customMessage: { customType: "omp-workbuddy-plugin", details },
        },
      ]);
      expect(omp.recordedPrompts()).toEqual([]);
      expect(omp.completedTurnCount()).toBe(0);
    },
  );

  test("a plugin original cannot finish a foreground prompt before its native acknowledgement", async () => {
    const omp = new OmpHarness();
    await omp.start();
    await omp.requireStartTurn("unrelated foreground task");
    omp.runtime().emit({
      type: "message_end",
      message: {
        role: "custom",
        customType: "omp-workbuddy-plugin",
        content: "background service is stopped",
        display: true,
        entryId: "native-late-status",
      },
    });
    await waitForImmediate();
    expect(omp.timeline()).toContainEqual({
      type: "assistant_message",
      text: "background service is stopped",
      messageId: "native-late-status",
      customMessage: { customType: "omp-workbuddy-plugin" },
    });
    expect(omp.completedTurnCount()).toBe(0);
    await omp.interrupt();
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

  test("omits live skill prompt custom messages", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(
      omp.runPromptWithCustomMessage(
        "/skill:bric-cli inspect this link",
        {
          role: "custom",
          customType: "skill-prompt",
          content:
            '[IMPORTANT: User invoked the "bric-cli" skill; follow its instructions. Full skill below.]\n\nSECRET SKILL BODY',
        },
        "model turn completed",
      ),
    ).resolves.toMatchObject({
      finalText: expect.stringContaining("model turn completed"),
    });
    expect(omp.timeline()).toEqual([
      {
        type: "user_message",
        text: "/skill:bric-cli inspect this link",
        messageId: "user-1",
      },
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

  test("owns and steers an autonomous OMP turn with one provider identity", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();

    runtime.emit({ type: "agent_start" });
    runtime.beginTurn();
    const started = omp.streamEvents().findLast((event) => event.type === "turn_started");
    expect(started?.turnId).toEqual(expect.any(String));
    if (!started?.turnId) throw new Error("Autonomous OMP turn did not publish an identity");
    const turnId = started.turnId;

    await expect(omp.steerActiveTurn("steer autonomous work", turnId)).resolves.toEqual({
      status: "accepted",
      userMessageEcho: "provider",
    });
    runtime.acceptPrompt("steer autonomous work", "autonomous-steer");
    runtime.streamAssistantText("autonomous turn completed");
    runtime.finishTurn();
    runtime.finishTurn();
    await vi.waitFor(() => expect(omp.completedTurnCount()).toBe(1));

    expect(omp.timeline()).toContainEqual({
      type: "assistant_message",
      text: "autonomous turn completed",
      messageId: "omp-assistant-1",
    });
    expect(
      omp
        .streamEvents()
        .filter(
          (event) =>
            event.type === "turn_started" ||
            event.type === "turn_completed" ||
            (event.type === "timeline" && event.item.type === "assistant_message"),
        )
        .every((event) => event.turnId === turnId),
    ).toBe(true);
    await expect(omp.steerActiveTurn("too late", turnId)).resolves.toEqual({
      status: "unavailable",
      reason: "no_active_turn",
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

  test.each(["standard", "enhanced", "plan", "goal"])(
    "native extension status remains a command rather than a %s workflow prompt",
    async (workflow) => {
      const omp = new OmpHarness();
      omp.queueCommands([{ name: "wechat", source: "extension" }]);
      await omp.start({ featureValues: { workflow_mode: workflow } });
      await omp.runPromptWithoutTurn("/wechat status");
      expect(omp.recordedPrompts().map((prompt) => prompt.message)).toEqual(["/wechat status"]);
      expect(omp.completedTurnCount()).toBe(1);
    },
  );

  test.each(["user", "replacement"] as const)(
    "settles a %s cancellation before native command discovery returns",
    async (reason) => {
      const commands: OmpRpcSlashCommand[] = [{ name: "wechat", source: "extension" }];
      const omp = new OmpHarness();
      omp.queueCommands(commands);
      await omp.start();
      const discovery = deferred<OmpRpcSlashCommand[]>();
      const enteredDiscovery = deferred<void>();
      const getCommands = vi.spyOn(omp.runtime(), "getCommands").mockImplementationOnce(() => {
        enteredDiscovery.resolve();
        return discovery.promise;
      });
      try {
        const admission = omp.startTurn("/wechat status");
        await enteredDiscovery.promise;
        await omp.interrupt(reason);
        const { turnId } = await admission;
        expect(omp.streamEvents().filter((event) => event.type === "turn_canceled")).toEqual([
          { type: "turn_canceled", provider: "omp", reason, turnId },
        ]);
        expect(omp.completedTurnCount()).toBe(0);
        expect(omp.failedTurnCount()).toBe(0);
        expect(omp.recordedPrompts()).toEqual([]);

        discovery.resolve(commands);
        await waitForImmediate();
        expect(omp.recordedPrompts()).toEqual([]);
        await omp.runPromptWithoutTurn("/wechat status");
        expect(omp.recordedPrompts().map((prompt) => prompt.message)).toEqual(["/wechat status"]);
      } finally {
        discovery.resolve(commands);
        getCommands.mockRestore();
        await omp.close();
      }
    },
  );

  test("a canceled discovery cannot register a ChatPro request or disturb its replacement", async () => {
    const commands: OmpRpcSlashCommand[] = [{ name: "chatpro", source: "extension" }];
    const requestId = "e15ab05a-b98c-4bca-9b05-09fed58f4e8c";
    const prompt = `/chatpro ask --json ${JSON.stringify({ requestId, text: "review" })}`;
    const omp = new OmpHarness();
    await omp.start();
    const oldDiscovery = deferred<OmpRpcSlashCommand[]>();
    const newDiscovery = deferred<OmpRpcSlashCommand[]>();
    const enteredOldDiscovery = deferred<void>();
    const enteredNewDiscovery = deferred<void>();
    const getCommands = vi
      .spyOn(omp.runtime(), "getCommands")
      .mockImplementationOnce(() => {
        enteredOldDiscovery.resolve();
        return oldDiscovery.promise;
      })
      .mockImplementationOnce(() => {
        enteredNewDiscovery.resolve();
        return newDiscovery.promise;
      });
    try {
      const oldAdmission = omp.startTurn(prompt);
      await enteredOldDiscovery.promise;
      await omp.interrupt("replacement");
      const oldTurn = await oldAdmission;
      const newAdmission = omp.startTurn(prompt);
      await enteredNewDiscovery.promise;

      oldDiscovery.resolve(commands);
      await waitForImmediate();
      expect(omp.recordedPrompts()).toEqual([]);
      await expect(omp.startTurn("overlapping turn")).rejects.toThrow(
        "An OMP turn is already active",
      );

      newDiscovery.resolve(commands);
      const newTurn = await newAdmission;
      expect(newTurn.turnId).not.toBe(oldTurn.turnId);
      expect(omp.recordedPrompts()).toHaveLength(1);
      const ask = JSON.parse(
        omp.recordedPrompts()[0]!.message.slice("/chatpro ask --json ".length),
      );
      expect(ask).toMatchObject({ requestId, origin: { turnId: newTurn.turnId } });
      await omp.interrupt();
      expect(omp.cancellationReasons()).toEqual(["replacement", "user"]);
      expect(omp.failedTurnCount()).toBe(0);
      expect(omp.completedTurnCount()).toBe(0);
    } finally {
      oldDiscovery.resolve(commands);
      newDiscovery.resolve(commands);
      getCommands.mockRestore();
      await omp.close();
    }
  });

  test("rejects overlapping admission and releases command discovery failures for retry", async () => {
    const commands: OmpRpcSlashCommand[] = [{ name: "wechat", source: "extension" }];
    const omp = new OmpHarness();
    omp.queueCommands(commands);
    await omp.start();
    const discovery = deferred<OmpRpcSlashCommand[]>();
    const enteredDiscovery = deferred<void>();
    const getCommands = vi.spyOn(omp.runtime(), "getCommands").mockImplementationOnce(() => {
      enteredDiscovery.resolve();
      return discovery.promise;
    });
    try {
      const admission = omp.startTurn("/wechat status");
      await enteredDiscovery.promise;
      await expect(omp.startTurn("overlapping turn")).rejects.toThrow(
        "An OMP turn is already active",
      );
      const rejected = expect(admission).rejects.toThrow("command discovery unavailable");
      discovery.reject(new Error("command discovery unavailable"));
      await rejected;
      expect(omp.recordedPrompts()).toEqual([]);
      await omp.runPromptWithoutTurn("/wechat status");
      expect(omp.recordedPrompts().map((prompt) => prompt.message)).toEqual(["/wechat status"]);
    } finally {
      discovery.resolve(commands);
      getCommands.mockRestore();
      await omp.close();
    }
  });

  test("a restored native extension command does not consume the next ordinary prompt's stale-plan reset", async () => {
    const omp = new OmpHarness();
    omp.queueCommands([{ name: "wechat", source: "extension" }]);
    await omp.resume({
      user: { id: "old-plan", text: planTurnPrompt("draft the migration") },
      assistant: { id: "old-plan-answer", text: "migration planned" },
    });
    await omp.runPromptWithoutTurn("/wechat status");
    expect(omp.recordedPrompts().map((prompt) => prompt.message)).toEqual(["/wechat status"]);
    omp.runtime().promptAck = {};
    await omp.runPrompt("implement the migration", "implementation complete");
    expect(omp.recordedPrompts().at(-1)?.message).toBe(
      standardTurnPrompt("implement the migration"),
    );
    expect(omp.timeline().findLast((item) => item.type === "assistant_message")).toMatchObject({
      text: "implementation complete",
    });
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

  test("switching to full access resolves pending tools and approves new tools without prompting", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "ask" });
    omp.emitExtensionUiRequest({
      type: "extension_ui_request",
      id: "business-question",
      method: "select",
      title: "Which deployment region?",
      options: ["Production", "Staging"],
    });
    omp.requestToolApproval({
      id: "pending-bash",
      tool: "bash",
      detail: "echo approved",
    });

    await omp.setMode("full");
    expect((await omp.runtimeInfo()).modeId).toBe("full");
    expect(omp.pendingPermissions()).toEqual([
      expect.objectContaining({ id: "business-question", kind: "question" }),
    ]);

    omp.requestToolApproval({ id: "new-edit", tool: "edit", detail: "fixture.txt" });
    omp.emitExtensionUiRequest({
      type: "extension_ui_request",
      id: "new-write",
      method: "select",
      title: "Allow tool: write\nPath: created.txt\nContent:\nhello",
      options: ["Approve", "Deny"],
    });
    await omp.setMode("full");

    expect(omp.pendingPermissions()).toEqual([
      expect.objectContaining({ id: "business-question", kind: "question" }),
    ]);
    expect(omp.permissionEvents()).toEqual([
      expect.objectContaining({
        type: "permission_requested",
        request: expect.objectContaining({ id: "business-question" }),
      }),
      expect.objectContaining({
        type: "permission_requested",
        request: expect.objectContaining({ id: "pending-bash" }),
      }),
      expect.objectContaining({
        type: "permission_resolved",
        requestId: "pending-bash",
        resolution: { behavior: "allow" },
      }),
      expect.objectContaining({
        type: "permission_resolved",
        requestId: "new-edit",
        resolution: { behavior: "allow" },
      }),
      expect.objectContaining({
        type: "permission_resolved",
        requestId: "new-write",
        resolution: { behavior: "allow" },
      }),
    ]);
  });

  test.each([
    ["bash", "Command: echo approved"],
    ["edit", "File: fixture.txt"],
    ["write", "Path: created.txt\nContent:\nhello"],
  ])(
    "full access chooses one-time approval for %s with a session-grant option",
    async (tool, detail) => {
      const omp = new OmpHarness();
      await omp.start({ modeId: "ask" });
      omp.emitExtensionUiRequest({
        type: "extension_ui_request",
        id: "business-question",
        method: "select",
        title: "Which deployment region?",
        options: ["Production", "Staging"],
      });
      const request = {
        type: "extension_ui_request" as const,
        method: "select" as const,
        title: `Allow tool: ${tool}\n${detail}`,
        options: ["Approve", `Approve ${tool} for this session`, "Deny"],
      };
      omp.emitExtensionUiRequest({ ...request, id: "pending-tool" });

      await omp.setMode("full");
      omp.emitExtensionUiRequest({ ...request, id: "subsequent-tool" });

      expect(omp.pendingPermissions()).toEqual([
        expect.objectContaining({ id: "business-question", kind: "question" }),
      ]);
      expect(omp.extensionUiResponses()).toEqual([
        { id: "pending-tool", response: { value: "Approve" } },
        { id: "subsequent-tool", response: { value: "Approve" } },
      ]);
      expect(
        omp.permissionEvents().filter((event) => event.type === "permission_requested"),
      ).toEqual([
        expect.objectContaining({ request: expect.objectContaining({ id: "business-question" }) }),
        expect.objectContaining({
          request: expect.objectContaining({ id: "pending-tool", kind: "tool" }),
        }),
      ]);
    },
  );

  test("restoring the launch mode stops automatic approvals without claiming a stricter native mode", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "write" });
    await omp.setMode("full");
    await omp.setMode("write");
    const notice = await omp.setMode("ask");
    expect(notice?.type).toBe("warning");
    expect((await omp.runtimeInfo()).modeId).toBe("write");

    omp.requestToolApproval({ id: "manual-edit", tool: "edit", detail: "fixture.txt" });
    expect(omp.pendingPermissions()).toEqual([
      expect.objectContaining({ id: "manual-edit", kind: "tool" }),
    ]);
    expect(omp.permissionEvents()).toEqual([
      expect.objectContaining({
        type: "permission_requested",
        request: expect.objectContaining({ id: "manual-edit" }),
      }),
    ]);
  });

  test("a session launched with full access cannot pretend to enable native approvals", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "full" });
    const notice = await omp.setMode("ask");
    expect(notice?.type).toBe("warning");
    expect((await omp.runtimeInfo()).modeId).toBe("full");
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

  test("preserves replacement as the cancellation source when abort rejects the prompt RPC", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    runtime.holdNextPrompt();
    await omp.requireStartTurn("keep working");
    const acknowledgeAbort = runtime.abort.bind(runtime);
    runtime.abort = async () => {
      const abortError = new Error("Request was aborted");
      abortError.name = "AbortError";
      await runtime.failHeldPrompt(abortError);
      await acknowledgeAbort();
    };

    await omp.interrupt("replacement");
    await waitForImmediate();

    expect(omp.canceledTurnCount()).toBe(1);
    expect(omp.failedTurnCount()).toBe(0);
    expect(omp.cancellationReasons()).toEqual(["replacement"]);
  });

  test("classifies an aborted terminal received before the abort acknowledgement as cancellation", async () => {
    const omp = new OmpHarness();
    await omp.start();
    await omp.requireStartTurn("keep working");
    const runtime = omp.runtime();
    runtime.beginTurn();
    const acknowledgeAbort = runtime.abort.bind(runtime);
    runtime.abort = async () => {
      runtime.finishTurn({
        role: "assistant",
        content: [],
        stopReason: "aborted",
        errorMessage: "Interrupted by user",
      });
      await waitForImmediate();
      await acknowledgeAbort();
    };

    await omp.interrupt("replacement");
    await waitForImmediate();

    expect(omp.canceledTurnCount()).toBe(1);
    expect(omp.failedTurnCount()).toBe(0);
    expect(omp.cancellationReasons()).toEqual(["replacement"]);
  });

  test("cancels an autonomous provider-owned turn and suppresses its late terminal events", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    runtime.beginTurn();
    const started = omp.streamEvents().findLast((event) => event.type === "turn_started");
    expect(started?.turnId).toEqual(expect.any(String));

    await omp.interrupt();
    runtime.streamAssistantText("late autonomous output");
    runtime.finishTurn();
    await waitForImmediate();

    expect(omp.canceledTurnCount()).toBe(1);
    expect(omp.cancellationReasons()).toEqual(["user"]);
    expect(omp.completedTurnCount()).toBe(0);
    expect(omp.timeline()).not.toContainEqual(
      expect.objectContaining({ text: "late autonomous output" }),
    );
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

  test("admits a new prompt while a queued continuation keeps OMP streaming after abort", async () => {
    const omp = new OmpHarness();
    await omp.start();
    await omp.interruptActiveTurn("stop me");
    const runtime = omp.runtime();
    // OMP's post-abort drain resumed the run on a queued message; the session is still busy.
    runtime.state = { ...runtime.state, isStreaming: true };

    await omp.requireStartTurn("user follow-up");
    await waitForImmediate();
    expect(omp.failedTurnCount()).toBe(0);
    expect(omp.recordedPrompts().map((prompt) => prompt.message)).toContain("user follow-up");

    runtime.acceptPrompt("user follow-up", "omp-user-follow-up");
    runtime.beginTurn();
    runtime.streamAssistantText("handled follow-up");
    runtime.state = { ...runtime.state, isStreaming: false };
    runtime.finishTurn({
      role: "assistant",
      content: [{ type: "text", text: "handled follow-up" }],
    });
    await vi.waitFor(() => expect(omp.completedTurnCount()).toBe(1));
    expect(omp.failedTurnCount()).toBe(0);
    expect(omp.timeline()).toContainEqual(
      expect.objectContaining({ type: "assistant_message", text: "handled follow-up" }),
    );
  });

  test("interrupt does not claim native subagents stopped; native cancellation acknowledges exactly one", async () => {
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
    expect(omp.subagentUpserts()).toEqual([{ id: "child-1", status: "running" }]);
    runtime.cancelSubagentError = new Error("native cancellation unavailable");
    await expect(omp.cancelProviderSubagent("child-1")).rejects.toThrow(
      "native cancellation unavailable",
    );
    expect(omp.subagentUpserts()).toEqual([{ id: "child-1", status: "running" }]);
    runtime.cancelSubagentError = null;
    await expect(omp.cancelProviderSubagent("child-1")).resolves.toBe(true);
    expect(runtime.canceledSubagentIds).toEqual(["child-1", "child-1"]);
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
    expect(omp.subagentUpserts().at(-1)).toEqual({ id: "child-1", status: "canceled" });
  });

  test("runs Browser use as an out-of-band OMP command", async () => {
    const omp = new OmpHarness();
    omp.queueCommands([{ name: "browser", description: "Toggle browser mode" }]);
    await omp.start();
    omp.runtime().promptAck = { agentInvoked: false };

    const events = await omp.runOutOfBand("/browser visible");

    expect(omp.recordedPrompts()).toEqual([{ message: "/browser visible", imageCount: 0 }]);
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: { type: "assistant_message", text: "Browser mode: visible" },
      },
    ]);
  });

  test("runs structured Computer use input as an out-of-band OMP command", async () => {
    const omp = new OmpHarness();
    omp.queueCommands([{ name: "computer", description: "Toggle computer use" }]);
    await omp.start();
    omp.runtime().promptAck = { agentInvoked: false };

    const events = await omp.runOutOfBand([{ type: "text", text: "/computer on" }]);

    expect(omp.recordedPrompts()).toEqual([{ message: "/computer on", imageCount: 0 }]);
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "assistant_message",
          text: "Computer use enabled for this session.",
        },
      },
    ]);
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
        scope: "session",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        contextWindowMaxTokens: 272_000,
        contextWindowUsedTokens: 55_000,
      },
      {
        scope: "session",
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
