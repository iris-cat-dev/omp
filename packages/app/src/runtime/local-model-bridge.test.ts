import { describe, expect, it, vi } from "vitest";
import type { DaemonEvent, DaemonEventHandler } from "@omp-desktop/client/internal/daemon-client";
import type { LocalModel, LocalModelInferenceRequest } from "@omp-desktop/protocol/local-models";
import { LocalModelBridgeController, type LocalModelBridgeClient } from "./local-model-bridge";

class BridgeClient implements LocalModelBridgeClient {
  listeners = new Set<DaemonEventHandler>();
  models: LocalModel[] = [{ provider: "test", id: "model", api: "openai-responses" }];
  openLocalModelSource = vi.fn(async () => ({ models: this.models }));
  closeLocalModelSource = vi.fn(async () => undefined);
  requestLocalModel = vi.fn<LocalModelBridgeClient["requestLocalModel"]>();
  cancelLocalModel = vi.fn<LocalModelBridgeClient["cancelLocalModel"]>();
  attachLocalModels = vi.fn<LocalModelBridgeClient["attachLocalModels"]>(async () => undefined);
  detachLocalModels = vi.fn(async () => undefined);
  sendLocalModelFrame = vi.fn<LocalModelBridgeClient["sendLocalModelFrame"]>();
  subscribe(handler: DaemonEventHandler) {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }
  emit(event: DaemonEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

const body: LocalModelInferenceRequest = {
  modelId: "test/model",
  context: { messages: [] },
  stream: true,
};

function managed(
  controller: LocalModelBridgeController,
  serverId: string,
  modelSource?: "local" | "remote",
) {
  controller.setProfile(serverId, {
    serverId,
    target: { host: serverId },
    runtimeRoot: "/tmp/omp",
    deployedVersion: "1.0.0",
    modelSource,
  });
}

describe("local model bridge lifecycle", () => {
  it("defaults old SSH profiles to local and namespaces same request IDs across hosts", async () => {
    const controller = new LocalModelBridgeController();
    const local = new BridgeClient();
    const first = new BridgeClient();
    const second = new BridgeClient();
    managed(controller, "first");
    managed(controller, "second");
    first.attachLocalModels.mockImplementation(async () => {
      first.emit({ type: "local_model_request", requestId: "shared", body });
    });
    controller.reconcile(
      { client: local, generation: "1" },
      new Map([
        ["first", { client: first, generation: "1" }],
        ["second", { client: second, generation: "1" }],
      ]),
    );
    await vi.waitFor(() => expect(controller.getStatus("second")?.status).toBe("ready"));
    second.emit({ type: "local_model_request", requestId: "shared", body });
    expect(local.openLocalModelSource).toHaveBeenCalledTimes(1);
    const firstId = local.requestLocalModel.mock.calls[0]![0];
    const secondId = local.requestLocalModel.mock.calls[1]![0];
    expect(firstId).not.toBe(secondId);
    local.emit({
      type: "local_model_frame",
      requestId: secondId,
      frame: { type: "chunk", data: "second only" },
    });
    expect(first.sendLocalModelFrame).not.toHaveBeenCalled();
    expect(second.sendLocalModelFrame).toHaveBeenCalledWith("shared", {
      type: "chunk",
      data: "second only",
    });
    first.emit({ type: "local_model_cancel", requestId: "shared" });
    expect(local.cancelLocalModel).toHaveBeenCalledWith(firstId);
    expect(local.cancelLocalModel).not.toHaveBeenCalledWith(secondId);
  });

  it("cancels disconnected requests, ignores stale frames, and never detaches on source loss", async () => {
    const controller = new LocalModelBridgeController();
    const local = new BridgeClient();
    const remote = new BridgeClient();
    managed(controller, "remote");
    const connections = new Map([["remote", { client: remote, generation: "1" }]]);
    controller.reconcile({ client: local, generation: "1" }, connections);
    await vi.waitFor(() => expect(controller.getStatus("remote")?.status).toBe("ready"));
    remote.emit({ type: "local_model_request", requestId: "pending", body });
    const localId = local.requestLocalModel.mock.calls[0]![0];
    controller.reconcile(null, connections);
    expect(local.cancelLocalModel).toHaveBeenCalledWith(localId);
    expect(remote.detachLocalModels).not.toHaveBeenCalled();
    expect(controller.getStatus("remote")?.status).toBe("error");
    remote.sendLocalModelFrame.mockClear();
    local.emit({
      type: "local_model_frame",
      requestId: localId,
      frame: { type: "chunk", data: "stale" },
    });
    expect(remote.sendLocalModelFrame).not.toHaveBeenCalled();
    remote.emit({ type: "local_model_request", requestId: "offline", body });
    expect(remote.sendLocalModelFrame).toHaveBeenCalledWith(
      "offline",
      expect.objectContaining({ type: "error" }),
    );
    local.models = [{ provider: "new", id: "current", api: "openai-responses" }];
    controller.reconcile({ client: local, generation: "2" }, connections);
    await vi.waitFor(() => expect(controller.getStatus("remote")?.status).toBe("ready"));
    expect(remote.attachLocalModels).toHaveBeenLastCalledWith(local.models);
  });

  it("cancels only the disconnected host and detaches only when remote source is explicit", async () => {
    const controller = new LocalModelBridgeController();
    const local = new BridgeClient();
    const first = new BridgeClient();
    const second = new BridgeClient();
    managed(controller, "first");
    managed(controller, "second");
    const source = { client: local, generation: "1" };
    const secondConnection = { client: second, generation: "1" };
    controller.reconcile(
      source,
      new Map([
        ["first", { client: first, generation: "1" }],
        ["second", secondConnection],
      ]),
    );
    await vi.waitFor(() => expect(controller.getStatus("second")?.status).toBe("ready"));
    first.emit({ type: "local_model_request", requestId: "first", body });
    second.emit({ type: "local_model_request", requestId: "second", body });
    const firstId = local.requestLocalModel.mock.calls[0]![0];
    const secondId = local.requestLocalModel.mock.calls[1]![0];
    controller.reconcile(source, new Map([["second", secondConnection]]));
    expect(local.cancelLocalModel).toHaveBeenCalledWith(firstId);
    expect(local.cancelLocalModel).not.toHaveBeenCalledWith(secondId);
    expect(local.closeLocalModelSource).not.toHaveBeenCalled();
    managed(controller, "second", "remote");
    controller.reconcile(source, new Map([["second", secondConnection]]));
    await vi.waitFor(() => expect(second.detachLocalModels).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(controller.getStatus("second")?.status).toBe("remote"));
    expect(local.closeLocalModelSource).toHaveBeenCalledTimes(1);
  });

  it("does not attach stale source-open results after switching to remote models", async () => {
    const controller = new LocalModelBridgeController();
    const local = new BridgeClient();
    const remote = new BridgeClient();
    const sourceOpen = Promise.withResolvers<{ models: LocalModel[] }>();
    local.openLocalModelSource.mockImplementation(() => sourceOpen.promise);
    managed(controller, "remote");
    const connections = new Map([["remote", { client: remote, generation: "1" }]]);
    controller.reconcile({ client: local, generation: "1" }, connections);
    await vi.waitFor(() => expect(local.openLocalModelSource).toHaveBeenCalled());
    managed(controller, "remote", "remote");
    controller.reconcile({ client: local, generation: "1" }, connections);
    sourceOpen.resolve({ models: local.models });
    await vi.waitFor(() => expect(remote.detachLocalModels).toHaveBeenCalled());
    expect(remote.attachLocalModels).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("keeps explicit remote source usable on old daemons without bridge capability", async () => {
    const controller = new LocalModelBridgeController();
    const remote = new BridgeClient();
    managed(controller, "remote", "remote");
    controller.reconcile(
      null,
      new Map([["remote", { client: remote, generation: "1", supportsLocalModels: false }]]),
    );
    await vi.waitFor(() => expect(controller.getStatus("remote")?.status).toBe("remote"));
    expect(remote.attachLocalModels).not.toHaveBeenCalled();
    expect(remote.detachLocalModels).not.toHaveBeenCalled();
  });
});
