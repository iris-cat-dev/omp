import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { LocalModelBridge } from "../../../local-model-bridge.js";
import { mergeOmpDesktopRpcBootstrapIntoModelsYaml } from "./agent.js";
import type { OmpRuntimeSession } from "./runtime.js";
import { OmpSdkRuntime } from "./sdk-runtime.js";
import { ompHistoryRuntimeSettings } from "./test-utils/history-sdk.js";

const model = { provider: "trae", id: "gpt-6.1-sol@cn", api: "openai-completions" };

function answer(content: unknown[], stopReason: "stop" | "toolUse") {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason,
    timestamp: 1,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test("keeps local inference available to the parent and child after native task rebinding", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "omp-local-task-"));
  const bridge = new LocalModelBridge();
  let session: OmpRuntimeSession | undefined;
  const requests: string[] = [];
  try {
    const agentDir = path.join(root, ".omp", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "models.yml"),
      mergeOmpDesktopRpcBootstrapIntoModelsYaml(""),
    );
    const configPath = path.join(root, "scenario.yml");
    await fs.writeFile(configPath, "task:\n  speculativeLaunch: false\n");
    const agentsDir = path.join(root, ".omp", "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(
      path.join(agentsDir, "local-child.md"),
      "---\nname: local-child\ndescription: Local inference regression\nblocking: true\n---\nReturn the assigned answer.\n",
    );
    await bridge.attach("desktop", [model], (event) => {
      if (event.type !== "request") return;
      requests.push(event.body.modelId);
      const message =
        requests.length === 1
          ? answer(
              [
                {
                  type: "toolCall",
                  id: "spawn-local-child",
                  name: "task",
                  arguments: {
                    context: "Exercise the selected local model in a native child session.",
                    tasks: [
                      {
                        name: "LocalChild",
                        agent: "local-child",
                        task: "Return the child answer.",
                        solutionSpace: "One fixed answer",
                      },
                    ],
                  },
                },
              ],
              "toolUse",
            )
          : answer(
              [
                {
                  type: "text",
                  text:
                    requests.length === 2
                      ? "Child inference succeeded"
                      : "Parent inference survived",
                },
              ],
              "stop",
            );
      bridge.receive("desktop", event.requestId, {
        type: "headers",
        status: 200,
        contentType: "text/event-stream",
      });
      const events: unknown[] = [{ type: "start", partial: message }];
      if (requests.length === 1) {
        events.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        events.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: message.content[0],
          partial: message,
        });
      }
      events.push({ type: "done", reason: message.stopReason, message });
      bridge.receive("desktop", event.requestId, {
        type: "chunk",
        data: events.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
      });
      bridge.receive("desktop", event.requestId, { type: "end" });
    });
    const runtime = new OmpSdkRuntime({
      logger: pino({ level: "silent" }),
      localModelBridge: bridge,
      runtimeSettings: {
        ...ompHistoryRuntimeSettings,
        env: {
          HOME: root,
          USERPROFILE: root,
          PI_CONFIG_DIR: ".omp",
          PI_CODING_AGENT_DIR: agentDir,
          OMP_PROFILE: "",
          PI_PROFILE: "",
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_STATE_HOME: path.join(root, "state"),
          XDG_CACHE_HOME: path.join(root, "cache"),
        },
      },
    });
    session = await runtime.startSession({
      cwd: root,
      model: `desktop-local/${model.provider}/${model.id}`,
      extraArgs: [
        "--tools",
        "task",
        "--no-skills",
        "--no-rules",
        "--no-lsp",
        "--config",
        configPath,
      ],
    });
    const ended = Promise.withResolvers<void>();
    session.onEvent((event) => {
      if (event.type === "agent_end") ended.resolve();
    });
    await session.prompt("Delegate to LocalChild, then answer after it finishes.");
    await ended.promise;
    const messages = await session.getMessages();
    const taskResult = messages.find((message) => message.role === "toolResult");
    expect(taskResult).toMatchObject({
      toolName: "task",
      isError: false,
      details: { results: [{ id: "LocalChild", exitCode: 0 }] },
    });
    expect(messages.filter((message) => message.role === "assistant").at(-1)).toMatchObject({
      content: [{ type: "text", text: "Parent inference survived" }],
      stopReason: "stop",
    });
    expect(taskResult).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Child inference succeeded") }],
    });
    expect(requests).toEqual(Array(3).fill(`${model.provider}/${model.id}`));
  } finally {
    await session?.close();
    await bridge.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
