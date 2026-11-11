import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PaseoToolCatalog } from "../../tools/types.js";
import type { OmpNoTurnScheduler, OmpProviderIdleScheduler } from "./agent.js";
import type { OmpUsagePollScheduler } from "./usage-poller.js";
import { OmpHarness } from "./test-utils/omp-harness.js";
import type { OmpAgentMessage, OmpRpcSlashCommand, OmpSessionState } from "./rpc-types.js";
import { OmpRuntimeEventSchema } from "./rpc-types.js";
import { OmpReadyTimeoutError } from "./cli-runtime.js";
import { getOmpWorkflowDisplayText } from "./workflow-prompt.js";

const GROUPED_ASK_QUESTIONS = [
  {
    id: "deployment",
    header: "Choice",
    question: "Where should we deploy?",
    options: [{ label: "East, West (Recommended)" }, { label: "Staging" }],
    recommended: 0,
  },
  {
    id: "features",
    header: "Choice",
    question: "Which features should ship?",
    options: [{ label: "Search" }, { label: "Export, CSV" }],
    multi: true,
  },
];

let profileDirectory: string;
beforeEach(async () => {
  profileDirectory = await mkdtemp(join(tmpdir(), "omp-agent-test-profile-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", profileDirectory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(profileDirectory, { recursive: true, force: true });
});

function workflowDisplayRequests(requests: Array<{ message: string; imageCount: number }>) {
  return requests.map((request) => ({
    ...request,
    message: getOmpWorkflowDisplayText(request.message),
  }));
}

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

  test("confirms draft speed without waiting for automatic account display", async () => {
    let credentialReadCount = 0;
    const omp = new OmpHarness({
      oauthAccounts: [
        { credentialId: 41, provider: "openai-codex" },
        { credentialId: 42, provider: "openai-codex" },
      ],
      sessionCredentialReader: () => {
        credentialReadCount += 1;
        return 42;
      },
    });
    const features = await omp.listFeatures({ model: "openai-codex/gpt-5.6" });
    expect(features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "fast_mode", type: "toggle", value: false }),
        expect.objectContaining({
          id: "oauth_account_credential",
          value: "automatic",
          effectiveValue: null,
        }),
      ]),
    );
    expect(credentialReadCount).toBe(0);
    expect(omp.latestRuntimeClosed()).toBe(true);
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

  test.each([true, false])(
    "confirms supported and unsupported draft speed and retires its probe (supported=%s)",
    async (fastModeSupported) => {
      const omp = new OmpHarness({ fastModeSupported });
      const features = await omp.listFeatures({
        model: "openai-codex/gpt-5.6",
        featureValues: { fast_mode: true },
      });
      expect(features.some((feature) => feature.id === "fast_mode")).toBe(fastModeSupported);
      expect(omp.latestRuntimeClosed()).toBe(true);
    },
  );

  test.each(["claude-opus-4-8", "claude-opus-5", "claude-opus-5-5"])(
    "offers fast mode for direct Anthropic %s after explicit session activation",
    async (id) => {
      const omp = new OmpHarness({
        initialModel: { provider: "anthropic", id, api: "anthropic-messages" },
      });
      const model = `anthropic/${id}`;
      const feature = expect.objectContaining({ id: "fast_mode", type: "toggle", value: false });

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

  const ultrafastModel = {
    provider: "openai-codex",
    id: "gpt-6.1-sol",
    api: "openai-codex-responses",
    serviceTiers: ["priority", "ultrafast"],
  };

  test.each([false, true])(
    "normalizes legacy Fast %s for an explicitly activated Ultrafast-capable session",
    async (enabled) => {
      const omp = new OmpHarness({ initialModel: ultrafastModel, ultrafastSupported: true });
      const config = {
        model: "openai-codex/gpt-6.1-sol",
        featureValues: { fast_mode: enabled },
      };
      const feature = expect.objectContaining({
        id: "fast_mode",
        type: "select",
        value: enabled ? "on" : "off",
        options: [
          expect.objectContaining({ id: "off" }),
          expect.objectContaining({ id: "on" }),
          expect.objectContaining({ id: "ultrafast" }),
        ],
      });
      await omp.start(config);
      expect(omp.features()).toEqual(expect.arrayContaining([feature]));
      expect(omp.fastModeRequests()).toEqual([]);
      expect(omp.runtime().setFastModeTierRequests).toEqual(enabled ? ["on"] : []);
    },
  );

  test("selects true native Ultrafast, Fast, and Standard without creating user turns", async () => {
    const omp = new OmpHarness({ initialModel: ultrafastModel, ultrafastSupported: true });
    await omp.start({ model: "openai-codex/gpt-6.1-sol" });
    for (const value of ["ultrafast", "on", "off"]) {
      await omp.setFeature("fast_mode", value);
      expect(omp.features()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "fast_mode", type: "select", value }),
        ]),
      );
    }
    expect(omp.runtime().setFastModeTierRequests).toEqual(["ultrafast", "on", "off"]);
    expect(omp.fastModeRequests()).toEqual([]);
    expect(omp.recordedPrompts()).toEqual([]);
    expect(omp.timeline().filter((item) => item.type === "system_notice")).toEqual([
      { type: "system_notice", notice: "ultrafast_mode_enabled" },
      { type: "system_notice", notice: "fast_mode_enabled" },
      { type: "system_notice", notice: "fast_mode_disabled" },
    ]);
  });

  test("does not demote a resumed native Ultrafast tier through a legacy true preference", async () => {
    const omp = new OmpHarness({
      initialModel: ultrafastModel,
      ultrafastSupported: true,
      initialFastModeTier: "ultrafast",
    });
    await omp.resume(
      {
        user: { id: "earlier-user", text: "Earlier request" },
        assistant: { id: "earlier-assistant", text: "Earlier response" },
      },
      {
        model: "openai-codex/gpt-6.1-sol",
        featureValues: { fast_mode: true },
      },
    );
    expect(omp.features()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "fast_mode", type: "select", value: "ultrafast" }),
      ]),
    );
    expect(omp.runtime().setFastModeTierRequests).toEqual([]);
    expect(omp.fastModeRequests()).toEqual([]);
  });

  test.each(["new", "resume"])(
    "applies a saved Ultrafast preference without a switch notice on %s sessions",
    async (kind) => {
      const omp = new OmpHarness({ initialModel: ultrafastModel, ultrafastSupported: true });
      const config = {
        model: "openai-codex/gpt-6.1-sol",
        featureValues: { fast_mode: "ultrafast" },
      };
      if (kind === "resume") {
        await omp.resume(
          {
            user: { id: "prior-user", text: "Prior request" },
            assistant: { id: "prior-assistant", text: "Prior answer" },
          },
          config,
        );
      } else {
        await omp.start(config);
      }
      expect(omp.runtime().setFastModeTierRequests).toEqual(["ultrafast"]);
      expect(omp.timeline().filter((item) => item.type === "system_notice")).toEqual([]);
    },
  );

  test.each([
    { model: ultrafastModel, supported: false },
    { model: { ...ultrafastModel, serviceTiers: ["priority"] }, supported: true },
  ])(
    "never aliases a saved Ultrafast preference to boolean Fast without both capabilities",
    async ({ model, supported }) => {
      const omp = new OmpHarness({ initialModel: model, ultrafastSupported: supported });
      const config = {
        model: "openai-codex/gpt-6.1-sol",
        featureValues: { fast_mode: "ultrafast" },
      };
      await omp.start(config);
      expect(omp.features()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "fast_mode" })]),
      );
      await expect(omp.setFeature("fast_mode", "ultrafast")).rejects.toThrow("unavailable");
      expect(omp.fastModeRequests()).toEqual([]);
      expect(omp.runtime().setFastModeTierRequests).toEqual([]);
    },
  );

  test("preserves Ultrafast while switching to unsupported models and back", async () => {
    const omp = new OmpHarness({ initialModel: ultrafastModel, ultrafastSupported: true });
    await omp.start({ model: "openai-codex/gpt-6.1-sol" });
    await omp.setFeature("fast_mode", "ultrafast");
    await omp.setModel("openai-codex", "older", {
      api: "openai-codex-responses",
      serviceTiers: ["priority"],
    });
    expect(omp.features()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fast_mode" })]),
    );
    expect(omp.runtime().state.fastModeTier).toBe("ultrafast");
    expect(omp.runtime().state.fastModeActive).toBe(false);
    await expect(omp.setFeature("fast_mode", true)).rejects.toThrow("unavailable");
    await omp.setModel("anthropic", "claude-opus-5-5", { api: "anthropic-messages" });
    expect(omp.features()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fast_mode" })]),
    );
    await omp.setModel(ultrafastModel.provider, ultrafastModel.id, ultrafastModel);
    expect(omp.features()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "fast_mode", type: "select", value: "ultrafast" }),
      ]),
    );
    expect(omp.runtime().setFastModeTierRequests).toEqual(["ultrafast"]);
    expect(omp.fastModeRequests()).toEqual([]);
  });

  test("keeps rejected and failed native tier selections out of values and notices", async () => {
    const omp = new OmpHarness({ initialModel: ultrafastModel, ultrafastSupported: true });
    await omp.start({ model: "openai-codex/gpt-6.1-sol" });
    const setter = vi.spyOn(omp.runtime(), "setFastModeTier");
    setter.mockRejectedValueOnce(new Error("Native tier update failed"));
    await expect(omp.setFeature("fast_mode", "ultrafast")).rejects.toThrow(
      "Native tier update failed",
    );
    setter.mockResolvedValueOnce({ enabled: true, active: true, tier: "priority" });
    await expect(omp.setFeature("fast_mode", "ultrafast")).rejects.toThrow("did not apply");
    await expect(omp.setFeature("fast_mode", "ultra")).rejects.toThrow("Invalid OMP fast mode");
    expect(omp.features()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "fast_mode", type: "select", value: "off" }),
      ]),
    );
    expect(omp.timeline().filter((item) => item.type === "system_notice")).toEqual([]);
    await omp.setModel(ultrafastModel.provider, ultrafastModel.id, ultrafastModel);
    expect(omp.runtime().setFastModeTierRequests).toEqual([]);
    setter.mockRestore();
  });

  test("reports native truth after an unknown-outcome tier update without claiming success", async () => {
    const omp = new OmpHarness({ initialModel: ultrafastModel, ultrafastSupported: true });
    await omp.start({ model: "openai-codex/gpt-6.1-sol" });
    const setter = vi.spyOn(omp.runtime(), "setFastModeTier").mockImplementationOnce(async () => {
      omp.runtime().state.fastModeTier = "ultrafast";
      omp.runtime().state.fastModeEnabled = true;
      omp.runtime().state.fastModeActive = true;
      throw new Error("Lost native response");
    });
    await expect(omp.setFeature("fast_mode", "ultrafast")).rejects.toThrow("Lost native response");
    expect(omp.features()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "fast_mode", type: "select", value: "ultrafast" }),
      ]),
    );
    expect(omp.timeline().filter((item) => item.type === "system_notice")).toEqual([]);
    setter.mockRestore();
  });

  test("does not present inherited native Flex as Standard", async () => {
    const omp = new OmpHarness({
      initialModel: ultrafastModel,
      ultrafastSupported: true,
      initialFastModeTier: "flex",
    });
    await omp.start({ model: "openai-codex/gpt-6.1-sol" });
    expect(omp.features()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fast_mode" })]),
    );
    expect(omp.runtime().state.fastModeTier).toBe("flex");
    expect(omp.runtime().setFastModeTierRequests).toEqual([]);
  });

  test.each([
    { enabled: false, active: false },
    { enabled: true, active: false },
  ])(
    "rejects a boolean Fast RPC that acknowledges an unavailable tier: $enabled/$active",
    async (result) => {
      const omp = new OmpHarness();
      await omp.start({ model: "openai-codex/gpt-5.6" });
      const setter = vi.spyOn(omp.runtime(), "setFastMode").mockResolvedValueOnce(result);
      await expect(omp.setFeature("fast_mode", true)).rejects.toThrow("did not apply");
      expect(omp.features()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "fast_mode", type: "toggle", value: false }),
        ]),
      );
      expect(omp.timeline().filter((item) => item.type === "system_notice")).toEqual([]);
      setter.mockRestore();
    },
  );

  test("serializes tier choices with model switches before checking capability", async () => {
    const omp = new OmpHarness({ initialModel: ultrafastModel, ultrafastSupported: true });
    await omp.start({ model: "openai-codex/gpt-6.1-sol" });
    const held = Promise.withResolvers<void>();
    const original = omp.runtime().setFastModeTier.bind(omp.runtime());
    const setter = vi
      .spyOn(omp.runtime(), "setFastModeTier")
      .mockImplementationOnce(async (value, model) => {
        await held.promise;
        return original(value, model);
      });
    const select = omp.setFeature("fast_mode", "ultrafast");
    const switchModel = omp.setModel("anthropic", "claude-opus-5-5", { api: "anthropic-messages" });
    await Promise.resolve();
    expect(omp.runtime().setModelRequests).toEqual([]);
    held.resolve();
    await select;
    await switchModel;
    expect(omp.features()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fast_mode" })]),
    );
    expect(omp.runtime().setFastModeTierRequests).toEqual(["ultrafast"]);
    expect(omp.fastModeRequests()).toEqual([]);
    setter.mockRestore();
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

  test("explicit Stop withdraws queued steering once and accepts a later continuation", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const turnId = await omp.requireStartTurn("keep working");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.acceptPrompt("keep working", "initial-message");
    await omp.steerActiveTurn("继续", turnId, { clientMessageId: "queued-client" });
    runtime.restoredQueue = { steering: [{ text: "继续" }], followUp: [] };

    await omp.interrupt();

    expect(runtime.abortAndRestoreQueueRequested).toBe(true);
    expect(
      omp.timeline().filter((item) => item.type === "user_message" && item.text === "继续"),
    ).toEqual([expect.objectContaining({ clientMessageId: "queued-client" })]);
    await omp.runPrompt("continue after Stop", "visible answer");
    expect(omp.timeline()).toContainEqual(
      expect.objectContaining({
        type: "assistant_message",
        text: "visible answer",
      }),
    );
  });

  test("forced runtime termination waits for actual host execution settlement and fences late events", async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const cleanup = Promise.withResolvers<void>();
    const catalog = createToolCatalog();
    catalog.executeTool = async (_name, _input, context = {}) => {
      started.resolve(context.signal!);
      await cleanup.promise;
      return { content: [{ type: "text", text: "late host result" }] };
    };
    const omp = new OmpHarness();
    await omp.start({}, catalog);
    await omp.requireStartTurn("perform host operation");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.emit({
      type: "host_tool_call",
      id: "recovery-host",
      toolCallId: "recovery-operation",
      toolName: "create_agent",
      arguments: {},
    });
    const signal = await started.promise;
    vi.useFakeTimers();
    try {
      const recovery = expect(omp.terminate()).rejects.toThrow("host tool work has not settled");
      await vi.advanceTimersByTimeAsync(2_000);
      await recovery;
      expect(runtime.closed).toBe(true);
      expect(signal.aborted).toBe(true);
      const before = omp.timeline();
      runtime.emit({
        type: "extension_error",
        extensionPath: "/home/user/plugin.ts",
        event: "session_start",
        error: "stale",
      });
      runtime.emit({ type: "agent_start" });
      runtime.streamAssistantText("stale output");
      expect(omp.timeline()).toEqual(before);
      cleanup.resolve();
      await Promise.resolve();
      await omp.terminate();
      expect(runtime.hostToolResults).toEqual([]);
      const promptCount = runtime.prompts.length;
      await expect(omp.startTurn("cannot reuse a dead runtime")).rejects.toBeInstanceOf(Error);
      expect(runtime.prompts).toHaveLength(promptCount);
    } finally {
      cleanup.resolve();
      vi.useRealTimers();
    }
  });

  test("forced termination does not claim success when the provider cannot confirm process exit", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const close = runtime.close.bind(runtime);
    runtime.close = async () => {
      throw new Error("process exit could not be confirmed");
    };
    await expect(omp.terminate()).rejects.toThrow("process exit could not be confirmed");
    const promptCount = runtime.prompts.length;
    await expect(omp.startTurn("unsafe new work")).rejects.toBeInstanceOf(Error);
    expect(runtime.prompts).toHaveLength(promptCount);
    runtime.close = close;
    await expect(omp.terminate()).resolves.toBeUndefined();
  });

  test.each(["user", "replacement"] as const)(
    "%s cancellation waits for canceled host tool execution to finish before acknowledging",
    async (reason) => {
      const started = deferred<AbortSignal>();
      const cleanup = deferred<void>();
      const catalog = createToolCatalog();
      catalog.executeTool = async (_name, _input, context = {}) => {
        started.resolve(context.signal!);
        await cleanup.promise;
        return { content: [] };
      };
      const omp = new OmpHarness();
      await omp.start({}, catalog);
      await omp.requireStartTurn("perform host operation");
      const runtime = omp.runtime();
      runtime.beginTurn();
      runtime.emit({
        type: "host_tool_call",
        id: "host-stop",
        toolCallId: "host-operation",
        toolName: "create_agent",
        arguments: {},
      });
      const signal = await started.promise;
      runtime.onAbort = () => {
        runtime.emit({
          type: "host_tool_cancel",
          id: "cancel-stop",
          targetId: "host-stop",
        });
        runtime.finishTurn({ role: "assistant", content: [], stopReason: "aborted" });
      };
      let acknowledged = false;
      const stopped = omp.interrupt(reason).then(() => {
        acknowledged = true;
        return undefined;
      });
      try {
        await waitForImmediate();
        expect(signal.aborted).toBe(true);
        expect(acknowledged).toBe(false);
        expect(omp.canceledTurnCount()).toBe(0);
        runtime.finishTurnWithEmptyAgentEnd({
          role: "assistant",
          content: [],
          stopReason: "length",
        });
        expect(runtime.followUpRequests).toEqual([]);
        cleanup.resolve();
        await stopped;
        expect(omp.canceledTurnCount()).toBe(1);
        expect(runtime.hostToolResults).toEqual([]);
        await omp.runPrompt("continue after cleanup", "continued");
        expect(omp.timeline()).toContainEqual(
          expect.objectContaining({
            type: "assistant_message",
            text: "continued",
          }),
        );
      } finally {
        cleanup.resolve();
        await stopped;
        await omp.close();
      }
    },
  );

  test("retains repeated original steering on a truncated Stop receipt without duplicating consumed input", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const turnId = await omp.requireStartTurn("keep working");
    const runtime = omp.runtime();
    runtime.beginTurn();
    await omp.steerActiveTurn("consumed", turnId, { clientMessageId: "consumed-client" });
    runtime.acceptPrompt("consumed", "consumed-native");
    await omp.steerActiveTurn("继续", turnId, { clientMessageId: "queued-one" });
    await omp.steerActiveTurn("继续", turnId, { clientMessageId: "queued-two" });
    runtime.restoredQueue = {
      steering: [{ text: "继续" }],
      followUp: [],
      truncated: true,
      imagesDropped: true,
    };

    await omp.interrupt();

    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      expect.objectContaining({ text: "consumed", clientMessageId: "consumed-client" }),
      expect.objectContaining({ text: "继续", clientMessageId: "queued-one" }),
      expect.objectContaining({ text: "继续", clientMessageId: "queued-two" }),
    ]);
  });

  test.each(["replacement", "reload", "rewind"] as const)(
    "%s interrupt preserves ordinary native abort semantics",
    async (reason) => {
      const omp = new OmpHarness();
      await omp.start();
      await omp.requireStartTurn("keep working");
      await omp.interrupt(reason);
      expect(omp.runtime().abortRequested).toBe(true);
      expect(omp.runtime().abortAndRestoreQueueRequested).toBe(false);
    },
  );

  test("does not queue a length continuation while Stop is aborting", async () => {
    const omp = new OmpHarness();
    await omp.start();
    await omp.requireStartTurn("keep working");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.onAbort = () =>
      runtime.finishTurnWithEmptyAgentEnd({
        role: "assistant",
        content: [],
        stopReason: "length",
      });

    await omp.interrupt();

    expect(runtime.followUpRequests).toEqual([]);
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
    expect(workflowDisplayRequests(runtime.followUpRequests)).toEqual([
      { message: "继续", imageCount: 0 },
    ]);
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
    expect(workflowDisplayRequests(omp.runtime().followUpRequests)).toEqual([
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

    expect(workflowDisplayRequests(omp.runtime().followUpRequests)).toEqual([
      { message: expected, imageCount: 0 },
    ]);
    expect(omp.runtime().followUpRequests[0]?.message).toContain(
      `Desktop tool intent locale: ${locale}`,
    );
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

    test.each([
      [
        "the reported unsupported image request",
        400,
        "400 invalid_request_error: uploaded unsupported image at input[510].image[0]",
      ],
      [
        "an HTTP status embedded in the provider error",
        undefined,
        "HTTP 400 invalid_request_error: input[510].image[0]: unsupported image",
      ],
      [
        "an embedded JSON validation status",
        undefined,
        '{"status_code":422,"message":"Invalid image data"}',
      ],
      ["invalid image data", 422, "Invalid image data in the request"],
      ["a rejected image input", 400, "Image input rejected: invalid image format"],
      ["an unsupported format without a status", undefined, "Unsupported image format"],
      ["an image decoding failure", 400, "Unable to decode image"],
      ["corrupted image input", 400, "Corrupted image data"],
      ["a postposed image decoding failure", 400, "Image data cannot be decoded"],
      ["an oversized image", 413, "Image size exceeds the maximum allowed size"],
      ["too many image inputs", 400, "Too many images in the request"],
    ] as const)(
      "finishes %s and accepts the next user turn without continuation",
      async (_label, errorStatus, errorMessage) => {
        const omp = await startFailedTurn({
          role: "assistant",
          content: [],
          stopReason: "error",
          ...(errorStatus === undefined ? {} : { errorStatus }),
          errorMessage,
        });

        expect(omp.failedTurnCount()).toBe(1);
        expect(omp.completedTurnCount()).toBe(0);
        expect(omp.streamEvents()).toContainEqual(
          expect.objectContaining({
            type: "turn_failed",
            error: expect.stringContaining(errorMessage),
          }),
        );
        await vi.advanceTimersByTimeAsync(20_000);
        expect(omp.runtime().followUpRequests).toEqual([]);
        expect(omp.failedTurnCount()).toBe(1);

        await expect(omp.requireStartTurn("continue without the image")).resolves.toEqual(
          expect.any(String),
        );
        const runtime = omp.runtime();
        runtime.beginTurn();
        runtime.acceptPrompt("continue without the image", "user-2");
        runtime.streamAssistantText("recovered", "recovery");
        runtime.finishTurn({
          role: "assistant",
          content: [{ type: "text", text: "recovered" }],
          stopReason: "stop",
        });
        await waitForImmediate();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(omp.runtime().followUpRequests).toEqual([]);
        expect(omp.failedTurnCount()).toBe(1);
        expect(omp.completedTurnCount()).toBe(1);
        expect(
          omp
            .timeline()
            .filter((item) => item.type === "user_message")
            .map((item) => item.text),
        ).toEqual(["finish the task", "continue without the image"]);
        expect(omp.timeline()).toContainEqual({
          type: "assistant_message",
          text: "recovered",
          messageId: "recovery",
        });
      },
    );

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
        expect(workflowDisplayRequests(runtime.followUpRequests)).toEqual([
          { message: "继续", imageCount: 0 },
        ]);

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
      ["an image service outage", 503, "Image input rejected: service unavailable"],
      ["an image rate limit", 429, "Image input rejected: rate limit exceeded"],
      ["an embedded image service outage", undefined, "HTTP 503: Image input rejected"],
      ["an image generation rejection", 400, "Image generation rejected"],
      ["a non-image input rejection", 400, "invalid_request_error: unsupported text input"],
      [
        "a status-code image outage",
        undefined,
        "Request failed with status code 503: Image input rejected",
      ],
      ["an error-prefixed image outage", undefined, "Error: 503 unsupported image input"],
      ["an error-code image outage", undefined, "Error Code: 503 unsupported image input"],
      [
        "a non-image invalid parameter mentioning an image",
        400,
        "invalid text parameter with image attachment",
      ],
      ["an image model mismatch", 400, "Unsupported image model"],
      ["an image-incapable model", 400, "Model does not support images: invalid image input"],
      ["an unsupported image endpoint", 400, "Image input is unsupported by this endpoint"],
      [
        "an image service rejection without a status",
        undefined,
        "Invalid image input: service unavailable",
      ],
      [
        "an internal image service error without a status",
        undefined,
        "Invalid image input: internal error",
      ],
      ["a rejected image without validation evidence", undefined, "Image input rejected"],
      [
        "an image authentication failure without a status",
        undefined,
        "Invalid image input: authentication failed",
      ],
      ["an image quota failure without a status", undefined, "Invalid image input: quota exceeded"],
      ["a text payload budget rejection", 413, "Request payload too large"],
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
      expect(workflowDisplayRequests(omp.runtime().followUpRequests)).toEqual([
        { message: "继续", imageCount: 0 },
      ]);
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
      expect(workflowDisplayRequests(omp.runtime().followUpRequests)).toEqual([
        { message: "继续", imageCount: 0 },
      ]);
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

  test("waits for the real local submission annotation before completion", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const { promise, resolve: release } = Promise.withResolvers<void>();
    omp.runtime().annotationBarrier = promise;
    const attachment = { type: "text" as const, mimeType: "text/plain", title: "External snapshot", text: "Full snapshot\nSurvives source removal", externalResource: { provider: "fixture/source", providerLabel: "Fixture", resourceType: "document", id: "42", identifier: "DOC-42", title: "External snapshot", url: "https://example.com/42" } };
    let completed = false;
    const completion = omp.runPromptWithoutTurn([{ type: "text", text: "/local save" }, attachment]).then((result) => { completed = true; return result; });
    await vi.waitFor(() => expect(omp.runtime().annotationCalls).toBe(1));
    expect(completed).toBe(false);
    expect(omp.completedTurnCount()).toBe(0);
    release();
    await completion;
    expect(omp.runtime().sessionAnnotations).toEqual([{ customType: "desktop-local-submission", data: { type: "user_message", text: "/local save", rewindStatus: "unavailable", attachments: [attachment] } }]);
    expect(omp.timeline()).toContainEqual({ type: "user_message", text: "/local save", rewindStatus: "unavailable", attachments: [attachment] });
    await omp.close();
  });

  test("reports local submission persistence failure without a successful completion", async () => {
    const omp = new OmpHarness();
    await omp.start();
    omp.runtime().annotationError = new Error("Local annotation write failed");
    await expect(omp.runPromptWithoutTurn("/local save")).rejects.toThrow("Local annotation write failed");
    expect(omp.completedTurnCount()).toBe(0);
    expect(omp.runtime().sessionAnnotations).toEqual([]);
    await omp.close();
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

  describe("correlated prompt results", () => {
    const diagnostic = "Trae provider failed after the upstream request was aborted";
    const terminalEvents = (omp: OmpHarness) => omp.streamEvents().filter(
      (event) => event.type === "turn_failed" || event.type === "turn_canceled" || event.type === "turn_completed",
    );

    test.each([
      ["before", "error", false],
      ["before", "error", true],
      ["after", "error", false],
      ["after", "error", true],
      ["before", "aborted", false],
      ["before", "aborted", true],
      ["after", "aborted", false],
      ["after", "aborted", true],
    ] as const)("preserves %s-ack %s with agentInvoked=%s", async (timing, status, agentInvoked) => {
      const scheduler = new ManualNoTurnScheduler();
      const omp = new OmpHarness({ noTurnScheduler: scheduler });
      await omp.start();
      try {
        const runtime = omp.runtime();
        runtime.promptAck = { requestId: "failed-prompt", ...(timing === "before" ? { agentInvoked: false } : {}) };
        runtime.holdNextPrompt();
        const promptStarted = runtime.nextPrompt();
        let settled = false;
        const completion = omp.run("hi").then(
          (result) => { settled = true; return { status: "resolved" as const, result }; },
          (error: Error) => { settled = true; return { status: "rejected" as const, error }; },
        );
        await promptStarted;
        if (timing === "after") await runtime.releaseHeldPrompt();
        runtime.emit(OmpRuntimeEventSchema.parse({
          type: "prompt_result", id: "unrelated-prompt", agentInvoked: false, status: "completed",
        }));
        runtime.emit(OmpRuntimeEventSchema.parse({
          type: "prompt_result", id: "failed-prompt", agentInvoked, status,
          ...(status === "error" ? { error: { message: diagnostic, provider: "trae", retryable: false } } : {}),
        }));
        if (timing === "before") {
          expect(settled).toBe(false);
          expect(terminalEvents(omp)).toEqual([]);
          // A duplicate with a conflicting outcome must not overwrite the first same-id result.
          runtime.emit(OmpRuntimeEventSchema.parse({
            type: "prompt_result", id: "failed-prompt", agentInvoked: false, status: "completed",
          }));
          await runtime.releaseHeldPrompt();
        }
        const outcome = await completion;
        if (status === "error") {
          expect(outcome.status).toBe("rejected");
          if (outcome.status === "rejected") expect(outcome.error.message).toBe(diagnostic);
          expect(terminalEvents(omp)).toEqual([
            expect.objectContaining({ type: "turn_failed", error: diagnostic, turnId: expect.any(String) }),
          ]);
        } else {
          expect(outcome).toMatchObject({ status: "resolved", result: { finalText: "" } });
          expect(terminalEvents(omp)).toEqual([
            expect.objectContaining({ type: "turn_canceled", reason: "provider_aborted", turnId: expect.any(String) }),
          ]);
        }
        const firstTerminal = terminalEvents(omp)[0]!;
        expect(runtime.sessionAnnotations).toEqual([]);

        // Stale frames while idle and before a different prompt's acknowledgement cannot own it.
        const stale = OmpRuntimeEventSchema.parse({
          type: "prompt_result", id: "failed-prompt", agentInvoked: false, status: "error",
          error: { message: diagnostic, retryable: false },
        });
        runtime.emit(stale);
        runtime.promptAck = { requestId: "next-prompt" };
        runtime.holdNextPrompt();
        const nextStarted = runtime.nextPrompt();
        const nextCompletion = omp.run("/local success");
        await nextStarted;
        runtime.emit(stale);
        runtime.emit(OmpRuntimeEventSchema.parse({ type: "prompt_result", agentInvoked: false, status: "aborted" }));
        await runtime.releaseHeldPrompt();
        runtime.emit(stale);
        expect(terminalEvents(omp)).toEqual([firstTerminal]);
        runtime.emit(OmpRuntimeEventSchema.parse({
          type: "prompt_result", id: "next-prompt", agentInvoked: false, status: "completed",
        }));
        scheduler.settle();
        await expect(nextCompletion).resolves.toMatchObject({ finalText: "" });
        const terminals = terminalEvents(omp);
        expect(terminals).toHaveLength(2);
        expect(terminals[0]).toEqual(firstTerminal);
        expect(terminals[1]).toMatchObject({ type: "turn_completed" });
        expect(terminals[1]!.turnId).not.toBe(firstTerminal.turnId);
      } finally {
        await omp.close();
      }
    });

    test.each(["before", "after"] as const)("completes a successful local-only result %s acknowledgement", async (timing) => {
      const scheduler = new ManualNoTurnScheduler();
      const omp = new OmpHarness({ noTurnScheduler: scheduler });
      await omp.start();
      try {
        const runtime = omp.runtime();
        runtime.promptAck = { requestId: "local-prompt" };
        runtime.holdNextPrompt();
        const promptStarted = runtime.nextPrompt();
        const completion = omp.run("/local success", { clientMessageId: "local-client" });
        await promptStarted;
        if (timing === "after") await runtime.releaseHeldPrompt();
        runtime.emit(OmpRuntimeEventSchema.parse({
          type: "prompt_result", id: "local-prompt", agentInvoked: false, status: "completed",
        }));
        if (timing === "before") await runtime.releaseHeldPrompt();
        expect(terminalEvents(omp)).toEqual([]);
        scheduler.settle();
        await expect(completion).resolves.toMatchObject({
          finalText: "", timeline: [expect.objectContaining({ type: "user_message", text: "/local success", clientMessageId: "local-client" })],
        });
        expect(terminalEvents(omp)).toEqual([expect.objectContaining({ type: "turn_completed" })]);
        expect(runtime.sessionAnnotations).toEqual([
          { customType: "desktop-local-submission", data: expect.objectContaining({ type: "user_message", text: "/local success", clientMessageId: "local-client" }) },
        ]);
      } finally {
        await omp.close();
      }
    });

    test("failure wins over a pending local-only acknowledgement persistence", async () => {
      const omp = new OmpHarness();
      await omp.start();
      const { promise, resolve } = Promise.withResolvers<void>();
      try {
        const runtime = omp.runtime();
        runtime.annotationBarrier = promise;
        runtime.promptAck = { requestId: "persisting-prompt", agentInvoked: false };
        const promptStarted = runtime.nextPrompt();
        const completion = omp.run("hi");
        const failed = expect(completion).rejects.toThrow(diagnostic);
        await promptStarted;
        await waitForImmediate();
        await waitForImmediate();
        expect(runtime.annotationCalls).toBe(1);
        runtime.emit(OmpRuntimeEventSchema.parse({
          type: "prompt_result", id: "persisting-prompt", agentInvoked: false, status: "error",
          error: { message: diagnostic, retryable: false },
        }));
        await failed;
        resolve();
        await waitForImmediate();
        expect(terminalEvents(omp)).toEqual([expect.objectContaining({ type: "turn_failed", error: diagnostic })]);
      } finally {
        resolve();
        await omp.close();
      }
    });

    test.each(["before", "after"] as const)("keeps model-error continuation ownership with a %s-ack failed result", async (timing) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const omp = new OmpHarness();
      try {
        await omp.start({ featureValues: { workflow_mode: "enhanced" } });
        const runtime = omp.runtime();
        runtime.promptAck = { requestId: "model-prompt" };
        runtime.holdNextPrompt();
        const promptStarted = runtime.nextPrompt();
        const completion = omp.run("finish the task");
        await promptStarted;
        if (timing === "after") await runtime.releaseHeldPrompt();
        runtime.beginTurn();
        runtime.acceptPrompt("finish the task", "model-user");
        runtime.finishTurn({ role: "assistant", content: [], stopReason: "error", errorMessage: diagnostic });
        const failedResult = OmpRuntimeEventSchema.parse({
          type: "prompt_result", id: "model-prompt", agentInvoked: true, status: "error",
          error: { message: diagnostic, retryable: false },
        });
        runtime.emit(failedResult);
        if (timing === "before") await runtime.releaseHeldPrompt();
        expect(terminalEvents(omp)).toEqual([]);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(runtime.followUpRequests).toHaveLength(1);
        runtime.beginTurn();
        // A late result for the original prompt cannot terminate the continuation's active run.
        runtime.emit(failedResult);
        runtime.emit(OmpRuntimeEventSchema.parse({
          type: "prompt_result", id: "model-prompt", agentInvoked: true, status: "aborted",
        }));
        expect(terminalEvents(omp)).toEqual([]);
        runtime.streamAssistantText("recovered", "recovered-assistant");
        runtime.finishTurn({ role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop" });
        await expect(completion).resolves.toMatchObject({ finalText: "recovered" });
        expect(terminalEvents(omp)).toEqual([expect.objectContaining({ type: "turn_completed" })]);
      } finally {
        await omp.close();
        vi.useRealTimers();
      }
    });
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
      await omp.start({ featureValues: { workflow_mode: workflow, workflow_locale: "zh-CN" } });
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

  test.each(["ask", "full"])(
    "keeps the whole business ask pending in %s mode and sends ordered answers",
    async (modeId) => {
      const omp = new OmpHarness();
      await omp.start({ modeId });
      omp.emitExtensionUiRequest({
        type: "extension_ui_request",
        id: "grouped-ask",
        method: "ask",
        questions: GROUPED_ASK_QUESTIONS,
      });
      expect(omp.extensionUiResponses()).toEqual([]);
      expect(omp.pendingPermissions()).toEqual([
        expect.objectContaining({
          id: "grouped-ask",
          kind: "question",
          input: {
            questions: [
              expect.objectContaining({ id: "deployment", header: "Choice", multiSelect: false }),
              expect.objectContaining({ id: "features", header: "Choice", multiSelect: true }),
            ],
          },
        }),
      ]);
      expect(
        omp.permissionEvents().filter((event) => event.type === "permission_requested"),
      ).toEqual([
        expect.objectContaining({
          request: expect.objectContaining({ id: "grouped-ask", kind: "question" }),
        }),
      ]);

      const answers = [
        { id: "deployment", selectedOptions: ["East, West (Recommended)"] },
        {
          id: "features",
          selectedOptions: ["Search", "Export, CSV"],
          customInput: "Live collaboration",
        },
      ];
      await omp.respondToPermission("grouped-ask", {
        behavior: "allow",
        updatedInput: { answers },
      });
      expect(omp.extensionUiResponses()).toEqual([{ id: "grouped-ask", response: { answers } }]);
      expect(omp.pendingPermissions()).toEqual([]);
      expect(
        omp.permissionEvents().filter((event) => event.type === "permission_resolved"),
      ).toEqual([
        expect.objectContaining({
          requestId: "grouped-ask",
          resolution: { behavior: "allow", updatedInput: { answers } },
        }),
      ]);
    },
  );

  test("leaves malformed answer groups pending and accepts a corrected complete response", async () => {
    const omp = new OmpHarness();
    await omp.start();
    omp.emitExtensionUiRequest({
      type: "extension_ui_request",
      id: "grouped-ask",
      method: "ask",
      questions: GROUPED_ASK_QUESTIONS,
    });
    const validAnswers = [
      { id: "deployment", selectedOptions: ["Staging"] },
      { id: "features", selectedOptions: ["Search"] },
    ];
    for (const answers of [
      { Choice: "Staging" },
      validAnswers.slice(0, 1),
      validAnswers.toReversed(),
      [validAnswers[0], { id: "features", selectedOptions: ["Search", "Search"] }],
      [validAnswers[0], { id: "features", selectedOptions: ["Unknown"] }],
      [{ id: "deployment", selectedOptions: [] }, validAnswers[1]],
      [{ id: "deployment", selectedOptions: ["Staging"], customInput: "Other" }, validAnswers[1]],
    ]) {
      await expect(
        omp.respondToPermission("grouped-ask", {
          behavior: "allow",
          updatedInput: { answers },
        }),
      ).rejects.toThrow();
      expect(omp.pendingPermissions()).toHaveLength(1);
      expect(omp.extensionUiResponses()).toEqual([]);
      expect(
        omp.permissionEvents().filter((event) => event.type === "permission_resolved"),
      ).toEqual([]);
    }
    await omp.respondToPermission("grouped-ask", {
      behavior: "allow",
      updatedInput: { answers: validAnswers },
    });
    expect(omp.pendingPermissions()).toEqual([]);
    expect(omp.extensionUiResponses()).toEqual([
      { id: "grouped-ask", response: { answers: validAnswers } },
    ]);
  });

  test.each(["deny", "withdraw"])("removes the entire grouped ask on %s", async (cancellation) => {
    const omp = new OmpHarness();
    await omp.start();
    omp.emitExtensionUiRequest({
      type: "extension_ui_request",
      id: "grouped-ask",
      method: "ask",
      questions: GROUPED_ASK_QUESTIONS,
    });
    if (cancellation === "deny") {
      await omp.respondToPermission("grouped-ask", { behavior: "deny" });
      expect(omp.extensionUiResponses()).toEqual([
        { id: "grouped-ask", response: { cancelled: true } },
      ]);
    } else {
      omp.emitExtensionUiRequest({
        type: "extension_ui_request",
        id: "withdraw-ask",
        method: "cancel",
        targetId: "grouped-ask",
      });
      expect(omp.extensionUiResponses()).toEqual([]);
    }
    expect(omp.pendingPermissions()).toEqual([]);
    expect(omp.permissionEvents().filter((event) => event.type === "permission_resolved")).toEqual([
      expect.objectContaining({
        requestId: "grouped-ask",
        resolution: expect.objectContaining({ behavior: "deny" }),
      }),
    ]);
    await expect(omp.respondToPermission("grouped-ask", { behavior: "allow" })).rejects.toThrow(
      "No pending permission request",
    );
  });

  test("all approval modes can change during a turn without replacing or interrupting it", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "full" });
    await omp.requireStartTurn("continue working");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.state = { ...runtime.state, isStreaming: true };
    const sessionId = runtime.state.sessionId;

    for (const modeId of ["ask", "full"]) {
      await omp.setMode(modeId);
      expect(await omp.runtimeInfo()).toMatchObject({ modeId, sessionId });
      expect(runtime.state.isStreaming).toBe(true);
    }
    expect(omp.wasAborted()).toBe(false);
    expect(runtime.closed).toBe(false);
    runtime.finishTurn();
    await omp.close();
  });

  test("native cancellation withdraws obsolete approvals without answering questions or bypassing explicit prompts", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "ask" });
    omp.emitExtensionUiRequest({
      type: "extension_ui_request",
      id: "business-question",
      method: "select",
      title: "Which deployment region?",
      options: ["Production", "Staging"],
    });
    omp.requestToolApproval({ id: "pending-bash", tool: "bash", detail: "echo approved" });

    await omp.setMode("full");
    omp.emitExtensionUiRequest({
      type: "extension_ui_request",
      id: "cancel-message",
      method: "cancel",
      targetId: "pending-bash",
    });
    omp.requestToolApproval({ id: "explicit-edit", tool: "edit", detail: "fixture.txt" });
    expect(omp.pendingPermissions()).toEqual([
      expect.objectContaining({ id: "business-question", kind: "question" }),
      expect.objectContaining({ id: "explicit-edit", kind: "tool" }),
    ]);
    expect(omp.extensionUiResponses()).toEqual([]);

    await expect(omp.respondToPermission("pending-bash", { behavior: "allow" })).rejects.toThrow(
      "No pending permission request",
    );
    await omp.respondToPermission("explicit-edit", { behavior: "deny" });
    expect(omp.pendingPermissions()).toEqual([
      expect.objectContaining({ id: "business-question", kind: "question" }),
    ]);
    expect(omp.extensionUiResponses()).toEqual([
      { id: "explicit-edit", response: { value: "Deny" } },
    ]);
    expect(omp.permissionEvents().filter((event) => event.type === "permission_resolved")).toEqual([
      expect.objectContaining({
        requestId: "pending-bash",
        resolution: { behavior: "deny", message: "Permission request withdrawn by OMP" },
      }),
      expect.objectContaining({ requestId: "explicit-edit", resolution: { behavior: "deny" } }),
    ]);
  });

  test("a failed native permission change leaves the current mode and approvals unchanged", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "ask" });
    omp.requestToolApproval({ id: "pending-bash", tool: "bash", detail: "echo approved" });
    omp.runtime().setApprovalModeError = new Error("native permission change failed");

    await expect(omp.setMode("full")).rejects.toThrow("native permission change failed");
    expect((await omp.runtimeInfo()).modeId).toBe("ask");
    expect(omp.pendingPermissions()).toEqual([
      expect.objectContaining({ id: "pending-bash", kind: "tool" }),
    ]);
    expect(omp.extensionUiResponses()).toEqual([]);
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

  test("publishes todo status/phase changes without losing the full plan on reminders", async () => {
    const omp = new OmpHarness();
    await omp.start();
    await omp.requireStartTurn("complete the plan");
    const runtime = omp.runtime();
    runtime.beginTurn();
    const publish = (status: "pending" | "in_progress", name: string) => {
      runtime.emit({
        type: "tool_execution_end",
        toolCallId: "todo-plan",
        toolName: "todo",
        result: {
          content: [],
          details: {
            phases: [
              { name, tasks: [{ content: "Shared", status }] },
              {
                name: "Tasks",
                tasks: [
                  { content: "Shared", status: "pending" },
                  { content: "Blocked", status: "blocked" },
                  { content: "Skipped", status: "abandoned" },
                  { content: "Done", status: "completed" },
                ],
              },
            ],
          },
        },
      });
    };
    publish("pending", "Tasks");
    runtime.emit({
      type: "todo_reminder",
      todos: [
        { content: "Shared", status: "in_progress" },
        { content: "Shared", status: "pending" },
      ],
      attempt: 1,
      maxAttempts: 3,
    });
    const reminded = omp.timeline().filter((item) => item.type === "todo");
    expect(reminded).toHaveLength(2);
    expect(reminded.at(-1)?.items).toEqual([
      {
        text: "Shared",
        completed: false,
        status: "in_progress",
        phase: { name: "Tasks", index: 0 },
      },
      { text: "Shared", completed: false, status: "pending", phase: { name: "Tasks", index: 1 } },
      { text: "Blocked", completed: false, status: "blocked", phase: { name: "Tasks", index: 1 } },
      {
        text: "Skipped",
        completed: false,
        status: "abandoned",
        phase: { name: "Tasks", index: 1 },
      },
      { text: "Done", completed: true, status: "completed", phase: { name: "Tasks", index: 1 } },
    ]);
    publish("in_progress", "Renamed");
    publish("pending", "Renamed");
    const changed = omp.timeline().filter((item) => item.type === "todo");
    expect(changed).toHaveLength(4);
    expect(changed.at(-1)?.items[0]).toEqual({
      text: "Shared",
      completed: false,
      status: "pending",
      phase: { name: "Renamed", index: 0 },
    });
    runtime.emit({
      type: "tool_execution_end",
      toolCallId: "todo-reset",
      toolName: "todo",
      result: { content: [], details: { phases: [] } },
    });
    expect(omp.timeline().findLast((item) => item.type === "todo")?.items).toEqual([]);
    await omp.close();
  });

  test("publishes latest streamed intent before execution without creating cards for hidden todo", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const turnId = await omp.requireStartTurn("inspect files");
    const runtime = omp.runtime();
    runtime.beginTurn();
    const message: Extract<OmpAgentMessage, { role: "assistant" }> = {
      role: "assistant",
      responseId: "intent-stream",
      content: [
        {
          type: "toolCall",
          id: "first",
          name: "read",
          arguments: { i: "Reading first file", path: "first.ts" },
        },
        {
          type: "toolCall",
          id: "second",
          name: "todo",
          arguments: { i: "  Updating task progress... ", op: "view" },
        },
        { type: "toolCall", id: "third", name: "read", arguments: { i: "...  " } },
      ],
    };
    runtime.emit({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "toolcall_delta" },
    });
    expect(omp.streamEvents().filter((event) => event.type === "working_intent")).toEqual([
      { type: "working_intent", provider: "omp", turnId, intent: "Updating task progress" },
    ]);
    expect(omp.timeline().filter((item) => item.type === "tool_call")).toEqual([]);
    runtime.beginTurn();
    runtime.emit({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "toolcall_delta" },
    });
    expect(omp.streamEvents().filter((event) => event.type === "working_intent")).toHaveLength(1);

    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "first",
      toolName: "read",
      args: { path: "first.ts", i: "fallback" },
      intent: "Reading authoritative details.",
    });
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "second",
      toolName: "todo",
      args: { op: "view", i: "Updating task progress" },
    });
    const beforeEnd = omp.streamEvents().filter((event) => event.type === "working_intent");
    expect(beforeEnd.map((event) => event.intent)).toEqual([
      "Updating task progress",
      "Reading authoritative details",
      "Updating task progress",
    ]);
    runtime.emit({
      type: "tool_execution_end",
      toolCallId: "second",
      toolName: "todo",
      result: "todos",
    });
    runtime.emit({
      type: "tool_execution_end",
      toolCallId: "first",
      toolName: "read",
      result: "source",
    });
    runtime.emit({ type: "message_end", message });
    expect(omp.streamEvents().filter((event) => event.type === "working_intent")).toEqual(
      beforeEnd,
    );
    const tools = omp.timeline().filter((item) => item.type === "tool_call");
    expect(tools.map((item) => item.callId)).toEqual(["first", "first"]);
    expect(tools.at(-1)).toMatchObject({
      status: "completed",
      detail: { type: "read", filePath: "first.ts", content: "source" },
      metadata: { intent: "Reading authoritative details" },
    });
    await omp.close();
  });

  test.each(["stop", "failure", "dispose", "terminal"] as const)(
    "ignores working intent updates after %s",
    async (ending) => {
      const omp = new OmpHarness();
      await omp.start();
      const runtime = omp.runtime();
      if (ending === "failure") runtime.holdNextPrompt();
      const turnId = await omp.requireStartTurn("generate tool args");
      runtime.beginTurn();
      const message: OmpAgentMessage = {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "pending",
            name: "read",
            arguments: { i: "Reading partial arguments" },
          },
        ],
      };
      runtime.emit({
        type: "message_update",
        message,
        assistantMessageEvent: { type: "toolcall_delta" },
      });
      expect(omp.runningToolCallIds()).toEqual([]);
      if (ending === "stop") await omp.interrupt();
      else if (ending === "failure")
        await runtime.failHeldPrompt(new Error("provider rejected prompt"));
      else if (ending === "dispose") await omp.close();
      else {
        runtime.finishTurn({ role: "assistant", content: [], stopReason: "aborted" });
        await waitForImmediate();
      }
      runtime.emit({
        type: "message_update",
        message,
        assistantMessageEvent: { type: "toolcall_delta" },
      });
      runtime.emit({
        type: "tool_execution_start",
        toolCallId: "late",
        toolName: "todo",
        args: { op: "view" },
        intent: "Late dispatch must not become working",
      });
      expect(omp.streamEvents().filter((event) => event.type === "working_intent")).toEqual([
        { type: "working_intent", provider: "omp", turnId, intent: "Reading partial arguments" },
      ]);
      if (ending !== "dispose") await omp.close();
    },
  );

  test("uses final native intent only as initial fallback and re-emits the same intent for a new Desktop turn", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const firstTurnId = await omp.requireStartTurn("first turn");
    const runtime = omp.runtime();
    runtime.beginTurn();
    const message: OmpAgentMessage = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "native",
          name: "todo",
          arguments: { op: "view" },
          intent: "Reviewing task status.",
        },
      ],
    };
    runtime.emit({ type: "message_end", message });
    expect(omp.streamEvents().filter((event) => event.type === "working_intent")).toEqual([
      {
        type: "working_intent",
        provider: "omp",
        turnId: firstTurnId,
        intent: "Reviewing task status",
      },
    ]);
    await omp.interrupt();
    const secondTurnId = await omp.requireStartTurn("second turn");
    runtime.beginTurn();
    runtime.emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "toolcall_end",
        toolCall: {
          type: "toolCall",
          id: "new",
          name: "todo",
          arguments: { i: "Reviewing task status", op: "view" },
        },
      },
    });
    expect(omp.streamEvents().findLast((event) => event.type === "working_intent")).toEqual({
      type: "working_intent",
      provider: "omp",
      turnId: secondTurnId,
      intent: "Reviewing task status",
    });
    await omp.close();
  });

  test("updates only hidden tool intent locale while preserving live and stop-restored prompt correlation", async () => {
    const omp = new OmpHarness();
    await omp.start({ featureValues: { workflow_locale: "zh-CN" } });
    const turnId = await omp.requireStartTurn("Keep this English request", {
      clientMessageId: "initial-client",
    });
    const runtime = omp.runtime();
    expect(omp.recordedPrompts()[0]?.message).toContain("Simplified Chinese");
    expect(getOmpWorkflowDisplayText(omp.recordedPrompts()[0]!.message)).toBe(
      "Keep this English request",
    );
    runtime.beginTurn();
    runtime.acceptPrompt("Keep this English request", "initial-native");
    await omp.setFeature("workflow_locale", "en");
    await omp.steerActiveTurn("继续检查", turnId, { clientMessageId: "queued-client" });
    expect(runtime.steerRequests[0]?.message).toContain("English");
    expect(getOmpWorkflowDisplayText(runtime.steerRequests[0]!.message)).toBe("继续检查");
    runtime.restoredQueue = { steering: [{ text: "继续检查" }], followUp: [], truncated: true };
    await omp.interrupt();
    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      {
        type: "user_message",
        text: "Keep this English request",
        messageId: "initial-native",
        clientMessageId: "initial-client",
      },
      {
        type: "user_message",
        text: "继续检查",
        clientMessageId: "queued-client",
        rewindStatus: "unavailable",
      },
    ]);
    await omp.close();
  });

  test.each(["/plan inspect the source", "/goal ship the change"])(
    "keeps %s native dispatch with a localized intent directive",
    async (prompt) => {
      const omp = new OmpHarness();
      await omp.start({ featureValues: { workflow_locale: "zh-CN" } });
      await omp.requireStartTurn(prompt);
      const sent = omp.recordedPrompts()[0]?.message;
      expect(sent?.startsWith(`${prompt.split(" ")[0]} `)).toBe(true);
      expect(sent).toContain("Simplified Chinese");
      expect(getOmpWorkflowDisplayText(sent!)).toBe(prompt);
      await omp.close();
    },
  );

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

  test.each([
    { aborted: false, result: { tokensBefore: 48_000 } },
    { aborted: true, errorMessage: "Cancelled" },
    { aborted: false, skipped: true, errorMessage: "Already compacted" },
  ])("manual compaction progress works before any model turn: %j", async (outcome) => {
    const omp = new OmpHarness();
    await omp.start();
    omp.runtime().emit({ type: "manual_compaction_start" });
    omp.runtime().emit({ type: "manual_compaction_end", ...outcome });
    expect(omp.streamEvents().filter((event) => event.type === "timeline")).toEqual([
      expect.objectContaining({
        item: { type: "compaction", status: "loading", trigger: "manual" },
      }),
      expect.objectContaining({
        item: {
          type: "compaction",
          status: "completed",
          trigger: "manual",
          ...("result" in outcome ? { preTokens: 48_000 } : {}),
        },
      }),
    ]);
  });

  test("manual compact does not duplicate native progress with its synthetic marker or RPC result", async () => {
    const omp = new OmpHarness();
    await omp.start();
    vi.spyOn(omp.runtime(), "compact").mockImplementation(async () => {
      omp.runtime().emit({ type: "manual_compaction_start" });
      omp.runtime().emit({
        type: "manual_compaction_end",
        aborted: false,
        result: { tokensBefore: 48_000 },
      });
    });
    expect(await omp.runOutOfBand("/compact")).toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: { type: "compaction", status: "loading", trigger: "manual" },
      },
      {
        type: "timeline",
        provider: "omp",
        item: { type: "compaction", status: "completed", trigger: "manual", preTokens: 48_000 },
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

  test("structured identity keeps transformed native prompts attached to the original display text", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const turnId = await omp.requireStartTurn("original display", {
      clientMessageId: "prompt-client",
    });
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.acceptPrompt(
      "native input hook completely rewrote the prompt",
      "prompt-native",
      "prompt-client",
    );
    await omp.steerActiveTurn("same display", turnId, { clientMessageId: "steer-one" });
    await omp.steerActiveTurn("same display", turnId, { clientMessageId: "steer-two" });
    runtime.acceptPrompt("transformed second", "native-two", "steer-two");
    runtime.acceptPrompt("transformed first", "native-one", "steer-one");
    expect(runtime.promptUserMessageOptions).toEqual([{ clientMessageId: "prompt-client" }]);
    expect(runtime.steerUserMessageOptions).toEqual([
      { clientMessageId: "steer-one" },
      { clientMessageId: "steer-two" },
    ]);
    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      {
        type: "user_message",
        text: "original display",
        clientMessageId: "prompt-client",
        messageId: "prompt-native",
      },
      {
        type: "user_message",
        text: "same display",
        clientMessageId: "steer-two",
        messageId: "native-two",
      },
      {
        type: "user_message",
        text: "same display",
        clientMessageId: "steer-one",
        messageId: "native-one",
      },
    ]);
    await omp.close();
  });

  test("a late native ID enriches the existing client row after a failed lookup and turn completion", async () => {
    const omp = new OmpHarness();
    await omp.start();
    await omp.requireStartTurn("display", { clientMessageId: "late-client" });
    const runtime = omp.runtime();
    runtime.branchMessagesError = new Error("temporary history failure");
    runtime.beginTurn();
    runtime.emit({
      type: "message_end",
      message: { role: "user", content: "rewritten", clientMessageId: "late-client" },
    });
    await waitForImmediate();
    runtime.streamAssistantText("done");
    runtime.finishTurn();
    await waitForImmediate();
    runtime.acceptPrompt("rewritten", "late-native", "late-client");
    runtime.acceptPrompt("rewritten", "late-native", "late-client");
    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      {
        type: "user_message",
        text: "display",
        clientMessageId: "late-client",
        rewindStatus: "unavailable",
      },
      {
        type: "user_message",
        text: "display",
        clientMessageId: "late-client",
        messageId: "late-native",
        rewindStatus: "ready",
      },
    ]);
    await omp.close();
  });

  test("explicit synchronization recovers structured IDs after transient failure without cross-binding identical prompts", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const turnId = await omp.requireStartTurn("same", { clientMessageId: "first-client" });
    const runtime = omp.runtime();
    runtime.branchMessagesError = new Error("temporary history failure");
    runtime.beginTurn();
    runtime.emit({
      type: "message_end",
      message: { role: "user", content: "transformed", clientMessageId: "first-client" },
    });
    await waitForImmediate();
    await expect(
      omp.resolveUserMessageId({ clientMessageId: "first-client", text: "same" }),
    ).rejects.toThrow("temporary history failure");
    await omp.steerActiveTurn("same", turnId, { clientMessageId: "second-client" });
    runtime.branchMessagesError = null;
    runtime.branchMessages = [{ entryId: "old-legacy", text: "same" }];
    await expect(
      omp.resolveUserMessageId({ clientMessageId: "first-client", text: "same" }),
    ).resolves.toBeNull();
    await expect(
      omp.resolveUserMessageId({ clientMessageId: "second-client", text: "same" }),
    ).resolves.toBeNull();
    runtime.branchMessages = [
      { entryId: "native-first", text: "transformed", clientMessageId: "first-client" },
      { entryId: "native-second", text: "transformed", clientMessageId: "second-client" },
    ];
    await expect(
      omp.resolveUserMessageId({ clientMessageId: "first-client", text: "same" }),
    ).resolves.toBe("native-first");
    await expect(
      omp.resolveUserMessageId({ clientMessageId: "second-client", text: "same" }),
    ).resolves.toBe("native-second");
    expect(runtime.branchRequests).toEqual([]);
    await omp.close();
  });

  test("legacy history lookup refuses duplicate text and recovers only an unambiguous accepted record", async () => {
    const omp = new OmpHarness();
    await omp.start();
    await omp.requireStartTurn("same", { clientMessageId: "legacy-client" });
    const runtime = omp.runtime();
    runtime.branchMessages = [
      { entryId: "old", text: "same" },
      { entryId: "new", text: "same" },
    ];
    runtime.beginTurn();
    runtime.emit({ type: "message_end", message: { role: "user", content: "same" } });
    await waitForImmediate();
    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      {
        type: "user_message",
        text: "same",
        clientMessageId: "legacy-client",
        rewindStatus: "unavailable",
      },
    ]);
    await expect(
      omp.resolveUserMessageId({ clientMessageId: "legacy-client", text: "same" }),
    ).resolves.toBeNull();
    runtime.branchMessages = [{ entryId: "only", text: "same" }];
    await expect(
      omp.resolveUserMessageId({ clientMessageId: "legacy-client", text: "same" }),
    ).resolves.toBe("only");
    runtime.branchMessages = [
      { entryId: "legacy", text: "same" },
      { entryId: "identified-other", text: "same", clientMessageId: "other-client" },
    ];
    await expect(
      omp.resolveUserMessageId({ clientMessageId: "legacy-client", text: "same" }),
    ).resolves.toBeNull();
    runtime.branchMessages = [
      { entryId: "duplicate-one", text: "same", clientMessageId: "legacy-client" },
      { entryId: "duplicate-two", text: "rewritten", clientMessageId: "legacy-client" },
    ];
    await expect(
      omp.resolveUserMessageId({ clientMessageId: "legacy-client", text: "same" }),
    ).resolves.toBeNull();
    runtime.branchMessages = [];
    await expect(
      omp.resolveUserMessageId({ clientMessageId: "legacy-client", text: "same" }),
    ).resolves.toBeNull();
    await omp.close();
  });

  test("pending, withdrawn, and local-only input cannot bind an old identical native message", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const turnId = await omp.requireStartTurn("same", { clientMessageId: "local-client" });
    const runtime = omp.runtime();
    runtime.branchMessages = [{ entryId: "old", text: "same" }];
    await expect(
      omp.resolveUserMessageId({ clientMessageId: "local-client", text: "same" }),
    ).resolves.toBeNull();
    runtime.beginTurn();
    await omp.steerActiveTurn("same", turnId, { clientMessageId: "queued-client" });
    await expect(
      omp.resolveUserMessageId({ clientMessageId: "queued-client", text: "same" }),
    ).resolves.toBeNull();
    runtime.restoredQueue = {
      steering: [{ text: "same", clientMessageId: "queued-client" }],
      followUp: [],
    };
    await omp.interrupt();
    const beforeSync = runtime.branchMessageLookups;
    await expect(
      omp.resolveUserMessageId({ clientMessageId: "queued-client", text: "same" }),
    ).resolves.toBeNull();
    expect(runtime.branchMessageLookups).toBe(beforeSync);
    expect(omp.timeline()).toContainEqual({
      type: "user_message",
      text: "same",
      clientMessageId: "queued-client",
      rewindStatus: "unavailable",
    });
    await omp.close();
  });

  test("an older failed lookup cannot downgrade a native-ID enrichment", async () => {
    const omp = new OmpHarness();
    await omp.start();
    await omp.requireStartTurn("same", { clientMessageId: "race-client" });
    const runtime = omp.runtime();
    const lookup = deferred<typeof runtime.branchMessages>();
    runtime.getBranchMessages = () => lookup.promise;
    runtime.beginTurn();
    runtime.emit({
      type: "message_end",
      message: { role: "user", content: "same", clientMessageId: "race-client" },
    });
    runtime.acceptPrompt("same", "race-native", "race-client");
    lookup.reject(new Error("late lookup failure"));
    await waitForImmediate();
    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      {
        type: "user_message",
        text: "same",
        clientMessageId: "race-client",
        messageId: "race-native",
      },
    ]);
    await omp.close();
  });

  test("legacy late-ID replay upgrades rather than suppresses an already-visible no-ID prompt", async () => {
    const omp = new OmpHarness();
    await omp.start();
    await omp.requireStartTurn("same", { clientMessageId: "legacy-late-client" });
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.emit({ type: "message_end", message: { role: "user", content: "same" } });
    await waitForImmediate();
    runtime.streamAssistantText("done");
    runtime.finishTurn();
    await waitForImmediate();
    runtime.acceptPrompt("same", "legacy-late-native");
    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      {
        type: "user_message",
        text: "same",
        clientMessageId: "legacy-late-client",
        rewindStatus: "unavailable",
      },
      {
        type: "user_message",
        text: "same",
        clientMessageId: "legacy-late-client",
        messageId: "legacy-late-native",
        rewindStatus: "ready",
      },
    ]);
    await omp.close();
  });

  test("a completed local-only command remains unavailable for native ID synchronization", async () => {
    const scheduler = new ManualNoTurnScheduler();
    const omp = new OmpHarness({ noTurnScheduler: scheduler });
    await omp.start();
    const prompt = await omp.startPromptWithFalseLocalOnlyResult("local-only", {
      clientMessageId: "local-only-client",
    });
    omp.runtime().branchMessages = [{ entryId: "old-local", text: "local-only" }];
    scheduler.settle();
    await expect(prompt.completion).resolves.toMatchObject({ finalText: "" });
    const beforeSync = omp.runtime().branchMessageLookups;
    await expect(
      omp.resolveUserMessageId({ clientMessageId: "local-only-client", text: "local-only" }),
    ).resolves.toBeNull();
    expect(omp.runtime().branchMessageLookups).toBe(beforeSync);
    expect(omp.timeline()).toContainEqual({
      type: "user_message",
      text: "local-only",
      clientMessageId: "local-only-client",
      rewindStatus: "unavailable",
    });
    await omp.close();
  });

  test("structured native identity preserves original images despite native content rewriting", async () => {
    const image = { data: "original-image-bytes", mimeType: "image/png" };
    const omp = new OmpHarness({
      initialModel: {
        provider: "anthropic",
        id: "image-model",
        name: "Image model",
        input: ["text", "image"],
      },
    });
    await omp.start();
    await omp.requireStartTurn(
      [
        { type: "text", text: "original display" },
        { type: "image", ...image },
      ],
      { clientMessageId: "image-client" },
    );
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.emit({
      type: "message_end",
      message: {
        role: "user",
        content: [
          { type: "text", text: "rewritten" },
          { type: "image", data: "normalized-image", mimeType: "image/jpeg" },
        ],
        clientMessageId: "image-client",
        entryId: "image-native",
      },
    });
    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      {
        type: "user_message",
        text: "original display",
        images: [image],
        clientMessageId: "image-client",
        messageId: "image-native",
      },
    ]);
    await omp.close();
  });
});
