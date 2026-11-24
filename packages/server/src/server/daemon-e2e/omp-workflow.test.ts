import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { OmpAgentClient } from "../agent/providers/omp/agent.js";
import { FakeOmp } from "../agent/providers/omp/test-utils/fake-omp.js";
import { ompHistoryRuntimeSettings } from "../agent/providers/omp/test-utils/history-sdk.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const cases = [
  { mode: "chat", prompt: expect.stringContaining("Chat mode active for this turn.") },
  { mode: "plan", prompt: expect.stringContaining("Continue the conversation") },
] as const;

test.each(cases)(
  "saves $mode on an unloaded OMP conversation and uses it on the next turn",
  async ({ mode, prompt }) => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-cold-workflow-"));
    const sessionFile = join(cwd, "conversation.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", id: "cold-session", cwd })}\n`,
    );
    const logger = createTestLogger();
    const runtime = new FakeOmp([process.execPath]);
    runtime.setInitialSessionFile(sessionFile);
    const omp = new OmpAgentClient({
      logger,
      runtime,
      runtimeSettings: {
        ...ompHistoryRuntimeSettings,
        ompBackend: "cli",
        command: { mode: "replace", argv: [process.execPath] },
        env: { HOME: cwd, USERPROFILE: cwd },
      },
      oauthAccounts: [],
    });
    const harness = await createTestPaseoDaemon({
      agentClients: { omp },
      providerOverrides: { omp: { enabled: true } },
      mcpEnabled: false,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${harness.port}/ws` });
    const observer = new DaemonClient({ url: `ws://127.0.0.1:${harness.port}/ws` });
    const messages = createMessageCollector(observer);
    try {
      await Promise.all([client.connect(), observer.connect()]);
      const { id } = await client.createAgent({
        cwd,
        provider: "omp",
        featureValues: { workflow_mode: "standard" },
      });
      await harness.daemon.agentManager.closeAgent(id);
      await observer.fetchAgents({ subscribe: { subscriptionId: "workflow-observer" } });

      await expect(
        client.applyAgentConfig(id, {
          featureValues: { workflow_mode: mode, workflow_locale: "zh-CN" },
        }),
      ).resolves.toBeNull();
      await vi.waitFor(() =>
        expect(messages.messages).toContainEqual(
          expect.objectContaining({
            type: "agent_update",
            payload: expect.objectContaining({
              agent: expect.objectContaining({
                id,
                runtimeRetention: expect.objectContaining({ state: "unloaded" }),
                features: expect.arrayContaining([
                  expect.objectContaining({ id: "workflow_mode", value: mode }),
                ]),
              }),
            }),
          }),
        ),
      );
      expect(runtime.recordedLaunches.filter((launch) => launch.session === sessionFile)).toEqual(
        [],
      );
      const stored = await harness.daemon.agentStorage.get(id);
      expect(stored?.config?.featureValues).toMatchObject({
        workflow_mode: mode,
        workflow_locale: "zh-CN",
      });
      await expect(
        client.applyAgentConfig(id, {
          featureValues: { workflow_mode: "enhanced", workflow_locale: "invalid" },
        }),
      ).rejects.toThrow("Invalid OMP workflow locale");
      expect(
        (await client.fetchAgent(id))?.agent.features?.find(
          (feature) => feature.id === "workflow_mode",
        )?.value,
      ).toBe(mode);

      const send = client.sendAgentMessage(id, "Continue the conversation");
      void send.catch(() => undefined);
      await vi.waitFor(() =>
        expect(runtime.latestSession().prompts).toEqual([{ message: prompt, imageCount: 0 }]),
      );
      const native = runtime.latestSession();
      expect(native.prompts[0]?.message).toContain("Desktop tool intent locale: zh-CN");
      if (mode === "plan") expect(native.planState.enabled).toBe(true);
      else expect(native.activeToolSetRequests).toEqual([["read", "glob", "grep"]]);
      native.beginTurn();
      native.acceptPrompt("Continue the conversation", "user-message");
      await send;
      if (mode === "plan") {
        await expect(
          client.applyAgentConfig(id, { featureValues: { workflow_mode: "standard" } }),
        ).rejects.toThrow("Wait for the current turn");
        expect(native.planState.enabled).toBe(true);
      }
      native.finishTurn({
        role: "assistant",
        content: [{ type: "text", text: "Ready" }],
        responseId: "assistant-message",
      });
      await vi.waitFor(() =>
        expect(harness.daemon.agentManager.getAgent(id)?.lifecycle).toBe("idle"),
      );
      await client.applyAgentConfig(id, { featureValues: { workflow_mode: "standard" } });
      if (mode === "plan") expect(native.planState.enabled).toBe(false);
      else expect(native.activeToolSetRequests).toEqual([["read", "glob", "grep"], null]);
      expect(
        runtime.recordedLaunches.filter((launch) => launch.session === sessionFile),
      ).toHaveLength(1);
    } finally {
      messages.unsubscribe();
      await Promise.all([client.close(), observer.close()]);
      await harness.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
