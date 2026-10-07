import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionOutboundMessage } from "@omp-desktop/protocol/messages";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createStub } from "../test-utils/class-mocks.js";
import type { ProviderUsageService } from "../../services/quota-fetcher/service.js";
import { ProviderCatalogSession } from "../session/provider/provider-catalog-session.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { OmpAgentClient } from "./providers/omp/agent.js";
import { FakeOmp, type FakeOmpSession } from "./providers/omp/test-utils/fake-omp.js";
import type { OmpStartSessionInput } from "./providers/omp/runtime.js";

class LoginRuntime extends FakeOmp {
  readonly authorization = Promise.withResolvers<void>();
  authenticated = false;
  loginSession: FakeOmpSession | null = null;

  override async startSession(input: OmpStartSessionInput): Promise<FakeOmpSession> {
    const session = await super.startSession(input);
    session.models = [
      { provider: "custom", id: "only", name: "Custom" },
      ...(this.authenticated
        ? [{ provider: "openai-codex", id: "subscription", name: "Codex" }]
        : []),
    ];
    session.loginProviders = [
      {
        id: "openai-codex",
        name: "Codex",
        available: true,
        authenticated: this.authenticated,
      },
    ];
    session.login = async () => {
      this.loginSession = session;
      session.emit({
        type: "extension_ui_request",
        id: "authorize",
        method: "open_url",
        url: "https://example.test/oauth",
      });
      await this.authorization.promise;
      this.authenticated = true;
    };
    return session;
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

async function createLogin() {
  const directory = await mkdtemp(join(tmpdir(), "omp-login-catalog-"));
  const runtime = new LoginRuntime();
  const logger = createTestLogger();
  const client = new OmpAgentClient({
    logger,
    runtime,
    runtimeSettings: { env: { PI_CODING_AGENT_DIR: directory } },
    quotaFetch: async () => new Response(null, { status: 401 }),
  });
  vi.spyOn(client, "isAvailable").mockResolvedValue(true);
  const manager = new ProviderSnapshotManager({ logger, extraClients: { omp: client } });
  const messages: SessionOutboundMessage[] = [];
  const session = new ProviderCatalogSession({
    logger,
    providerSnapshotManager: manager,
    providerUsageService: createStub<ProviderUsageService>({}),
    host: {
      emit: (message) => messages.push(message),
      isProviderVisibleToClient: () => true,
      supportsCustomModeIcons: () => true,
      supportsCompactProviderSnapshots: () => false,
      listProviderAvailability: async () => [],
      listDraftFeatures: async () => [],
      listActiveOmpAgentIds: () => [],
      stopOmpAgents: async () => {},
    },
  });
  session.start();
  const workspaces = [join(directory, "one"), join(directory, "two")];
  for (const cwd of workspaces) await manager.warmUpSnapshotForCwd({ cwd, providers: ["omp"] });
  await session.handleOmpProviderLoginStartRequest({
    type: "omp.provider.login.start.request",
    providerId: "openai-codex",
    requestId: "start",
  });
  const started = messages.find((message) => message.type === "omp.provider.login.start.response");
  if (started?.type !== "omp.provider.login.start.response") throw new Error("login did not start");
  cleanups.push(async () => {
    runtime.authorization.reject(new Error("test finished"));
    session.dispose();
    manager.destroy();
    await client.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  const modelIds = (cwd?: string) =>
    manager
      .getSnapshot(cwd)
      .find((entry) => entry.provider === "omp")
      ?.models?.map((model) => model.id);
  return {
    runtime,
    manager,
    session,
    messages,
    workspaces,
    modelIds,
    flowId: started.payload.flowId,
  };
}

const AUTHENTICATED_MODELS = ["custom/only", "openai-codex/subscription"];

describe("OMP login catalog lifecycle", () => {
  it("refreshes every cached workspace and pushes completion without a finish request", async () => {
    const state = await createLogin();
    expect(state.modelIds(state.workspaces[0])).toEqual(["custom/only"]);

    state.runtime.authorization.resolve();

    await vi.waitFor(() => {
      expect(state.modelIds()).toEqual(AUTHENTICATED_MODELS);
      for (const cwd of state.workspaces) expect(state.modelIds(cwd)).toEqual(AUTHENTICATED_MODELS);
    });
    expect(
      state.messages.filter((message) => message.type === "omp.provider.login.completed"),
    ).toEqual([
      {
        type: "omp.provider.login.completed",
        payload: { flowId: state.flowId, providerId: "openai-codex" },
      },
    ]);
    expect(state.runtime.loginSession?.closed).toBe(true);
    await expect(state.manager.cancelOmpProviderLogin(state.flowId)).resolves.toBe(false);

    await state.manager.finishOmpProviderLogin(state.flowId);
    expect(
      state.messages.filter((message) => message.type === "omp.provider.login.completed"),
    ).toHaveLength(1);
  });

  it("refreshes after the requesting client disconnects", async () => {
    const state = await createLogin();
    state.session.dispose();
    const messageCount = state.messages.length;

    state.runtime.authorization.resolve();

    await vi.waitFor(() =>
      expect(state.modelIds(state.workspaces[1])).toEqual(AUTHENTICATED_MODELS),
    );
    expect(state.messages).toHaveLength(messageCount);
  });

  it("keeps manual OAuth input pending until the code is supplied", async () => {
    const state = await createLogin();
    state.runtime.loginSession!.emit({
      type: "extension_ui_request",
      id: "oauth-code",
      method: "input",
      title: "OAuth code",
    });
    await expect(state.manager.finishOmpProviderLogin(state.flowId)).rejects.toThrow(
      "Paste the OAuth code",
    );
    expect(state.modelIds(state.workspaces[0])).toEqual(["custom/only"]);

    const finish = state.manager.finishOmpProviderLogin(state.flowId, "  code  ");
    expect(state.runtime.loginSession!.extensionUiResponses).toEqual([
      { id: "oauth-code", response: { value: "code" } },
    ]);
    state.runtime.authorization.resolve();
    const management = await finish;

    expect(management.loginProviders[0]?.authenticated).toBe(true);
    for (const cwd of state.workspaces) expect(state.modelIds(cwd)).toEqual(AUTHENTICATED_MODELS);
  });

  it("accepts an automatic callback after a fallback code prompt was offered", async () => {
    const state = await createLogin();
    state.runtime.loginSession!.emit({
      type: "extension_ui_request",
      id: "fallback-code",
      method: "input",
      title: "OAuth code",
    });

    state.runtime.authorization.resolve();
    await vi.waitFor(() =>
      expect(state.modelIds(state.workspaces[0])).toEqual(AUTHENTICATED_MODELS),
    );

    const management = await state.manager.finishOmpProviderLogin(state.flowId);
    expect(management.loginProviders[0]?.authenticated).toBe(true);
    expect(state.runtime.loginSession!.extensionUiResponses).toEqual([]);
  });

  it("does not publish success when cancellation is followed by a late runtime resolution", async () => {
    const state = await createLogin();
    await expect(state.manager.cancelOmpProviderLogin(state.flowId)).resolves.toBe(true);
    state.runtime.authorization.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    for (const cwd of state.workspaces) expect(state.modelIds(cwd)).toEqual(["custom/only"]);
    expect(
      state.messages.filter((message) => message.type === "omp.provider.login.completed"),
    ).toEqual([]);
    await expect(state.manager.finishOmpProviderLogin(state.flowId)).rejects.toThrow(
      "no longer active",
    );
  });

  it("keeps authentication failures visible without refreshing the catalog", async () => {
    const state = await createLogin();
    state.runtime.authorization.reject(new Error("authorization denied"));

    await expect(state.manager.finishOmpProviderLogin(state.flowId)).rejects.toThrow(
      "authorization denied",
    );
    for (const cwd of state.workspaces) expect(state.modelIds(cwd)).toEqual(["custom/only"]);
    expect(
      state.messages.filter((message) => message.type === "omp.provider.login.completed"),
    ).toEqual([]);
  });
});
