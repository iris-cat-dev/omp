import type { DaemonClient, DaemonEvent } from "@omp-desktop/client/internal/daemon-client";
import type { LocalModel, LocalModelStreamFrame } from "@omp-desktop/protocol/local-models";
import type { DesktopRemoteSshProfile } from "@/desktop/host";

export type LocalModelBridgeClient = Pick<
  DaemonClient,
  | "subscribe"
  | "openLocalModelSource"
  | "closeLocalModelSource"
  | "requestLocalModel"
  | "cancelLocalModel"
  | "attachLocalModels"
  | "detachLocalModels"
  | "sendLocalModelFrame"
>;

export interface ModelBridgeConnection {
  client: LocalModelBridgeClient;
  generation: string;
  supportsLocalModels?: boolean;
}

export interface LocalModelBridgeStatus {
  profile: DesktopRemoteSshProfile;
  status: "remote" | "connecting" | "ready" | "error";
  error: string | null;
  modelCount: number;
}

interface Binding {
  connection: ModelBridgeConnection;
  source: ModelBridgeConnection | null;
  active: boolean;
  ready: boolean;
  unsubscribe: () => void;
  pending: Map<string, string>;
}

const SOURCE_UNAVAILABLE =
  "Local model source is disconnected. Keep OMP Desktop and its local daemon running. No remote model fallback is used.";

/** One renderer-owned source session; requests never enter a global host broadcast. */
export class LocalModelBridgeController {
  private profiles = new Map<string, DesktopRemoteSshProfile>();
  private statuses = new Map<string, LocalModelBridgeStatus>();
  private listeners = new Set<() => void>();
  private bindings = new Map<string, Binding>();
  private queues = new Map<string, Promise<void>>();
  private detaching = new Set<string>();
  private remoteSelections = new Map<string, ModelBridgeConnection>();
  private sourceCatalog: Promise<{ models: LocalModel[] }> | null = null;
  private source: ModelBridgeConnection | null = null;
  private sourceUnsubscribe: (() => void) | null = null;
  private requests = new Map<string, { binding: Binding; requestId: string }>();
  private requestSequence = 0;
  private readonly namespace = crypto.randomUUID();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getStatus(serverId: string): LocalModelBridgeStatus | null {
    return this.statuses.get(serverId) ?? null;
  }

  setProfile(serverId: string, profile: DesktopRemoteSshProfile | null): void {
    if (profile) this.profiles.set(serverId, profile);
    else this.profiles.delete(serverId);
  }

  reconcile(
    source: ModelBridgeConnection | null,
    connections: ReadonlyMap<string, ModelBridgeConnection>,
  ): void {
    const wanted = new Map(
      [...connections].filter(([serverId]) => {
        const profile = this.profiles.get(serverId);
        return profile && profile.modelSource !== "remote";
      }),
    );
    const nextSource = wanted.size ? source : null;
    this.updateSource(nextSource);

    for (const [serverId, binding] of this.bindings) {
      const connection = wanted.get(serverId);
      if (
        connection &&
        this.sameConnection(binding.connection, connection) &&
        this.sameConnection(binding.source, this.source)
      )
        continue;
      binding.active = false;
      binding.unsubscribe();
      this.cancelPending(binding, SOURCE_UNAVAILABLE);
      this.bindings.delete(serverId);
    }

    for (const [serverId, profile] of this.profiles) {
      if (profile.modelSource === "remote") {
        const connection = connections.get(serverId);
        if (connection && !this.sameConnection(this.remoteSelections.get(serverId), connection)) {
          this.remoteSelections.set(serverId, connection);
          this.detaching.add(serverId);
          this.publish(serverId, { profile, status: "connecting", error: null, modelCount: 0 });
          this.enqueue(serverId, async () => {
            if (connection.supportsLocalModels !== false) {
              // A reconnected session must acquire ownership before clearing retained local mode.
              await connection.client.attachLocalModels([]);
              await connection.client.detachLocalModels();
            }
            this.detaching.delete(serverId);
            if (this.profiles.get(serverId)?.modelSource === "remote") {
              this.publish(serverId, {
                profile: this.profiles.get(serverId) ?? profile,
                status: "remote",
                error: null,
                modelCount: 0,
              });
            }
          });
        }
        if (!this.detaching.has(serverId)) {
          this.publish(serverId, { profile, status: "remote", error: null, modelCount: 0 });
        } else if (this.statuses.get(serverId)?.status !== "error") {
          this.publish(serverId, { profile, status: "connecting", error: null, modelCount: 0 });
        }
        continue;
      }
      this.remoteSelections.delete(serverId);
      const connection = wanted.get(serverId);
      if (!connection) {
        this.publish(serverId, {
          profile,
          status: "error",
          error:
            "Remote host is disconnected. Local models are unavailable; no remote fallback is used.",
          modelCount: 0,
        });
        continue;
      }
      if (this.bindings.has(serverId)) continue;
      const binding: Binding = {
        connection,
        source: this.source,
        active: true,
        ready: false,
        unsubscribe: () => undefined,
        pending: new Map(),
      };
      this.bindings.set(serverId, binding);
      // Subscribe before attaching: the daemon may issue inference immediately after attach.
      binding.unsubscribe = connection.client.subscribe((event) =>
        this.handleRemoteEvent(serverId, binding, event),
      );
      if (!binding.source) {
        this.publish(serverId, {
          profile,
          status: "error",
          error: SOURCE_UNAVAILABLE,
          modelCount: 0,
        });
        continue;
      }
      this.publish(serverId, { profile, status: "connecting", error: null, modelCount: 0 });
      this.enqueue(serverId, async () => {
        if (!binding.active || !binding.source) return;
        try {
          this.sourceCatalog ??= binding.source.client.openLocalModelSource();
          const { models } = await this.sourceCatalog;
          if (!binding.active) return;
          binding.ready = true;
          await connection.client.attachLocalModels(models);
          if (models.length === 0)
            throw new Error(
              "No local models are configured. Open local model settings before continuing.",
            );
          if (!binding.active) return;
          this.publish(serverId, {
            profile: this.profiles.get(serverId) ?? profile,
            status: "ready",
            error: null,
            modelCount: models.length,
          });
        } catch (error) {
          if (!binding.active) return;
          binding.ready = false;
          this.publish(serverId, {
            profile,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
            modelCount: 0,
          });
        }
      });
    }
    for (const serverId of this.statuses.keys()) {
      if (!this.profiles.has(serverId)) {
        this.statuses.delete(serverId);
        this.remoteSelections.delete(serverId);
        this.detaching.delete(serverId);
        this.emit();
      }
    }
  }

  private updateSource(nextSource: ModelBridgeConnection | null): void {
    if (this.sameConnection(this.source, nextSource)) return;
    const previousSource = this.source;
    this.sourceUnsubscribe?.();
    this.sourceUnsubscribe = null;
    const closePrevious = previousSource
      ? previousSource.client.closeLocalModelSource().catch(() => undefined)
      : Promise.resolve();
    this.sourceCatalog = nextSource
      ? closePrevious.then(() => nextSource.client.openLocalModelSource())
      : null;
    for (const binding of this.bindings.values()) this.cancelPending(binding, SOURCE_UNAVAILABLE);
    this.source = nextSource;
    if (nextSource) {
      this.sourceUnsubscribe = nextSource.client.subscribe((event) => {
        if (event.type !== "local_model_frame" || this.source !== nextSource) return;
        const request = this.requests.get(event.requestId);
        if (!request?.binding.active || request.binding.source !== nextSource) return;
        this.sendFrame(request.binding, request.requestId, event.frame);
        if (event.frame.type === "end" || event.frame.type === "error") {
          this.requests.delete(event.requestId);
          request.binding.pending.delete(request.requestId);
        }
      });
    }
  }

  private sameConnection(
    left: ModelBridgeConnection | null | undefined,
    right: ModelBridgeConnection | null | undefined,
  ): boolean {
    return left?.client === right?.client && left?.generation === right?.generation;
  }

  private handleRemoteEvent(serverId: string, binding: Binding, event: DaemonEvent): void {
    if (!binding.active) return;
    if (event.type === "local_model_cancel") {
      const localId = binding.pending.get(event.requestId);
      if (!localId) return;
      binding.pending.delete(event.requestId);
      this.requests.delete(localId);
      try {
        binding.source?.client.cancelLocalModel(localId);
      } catch {
        /* Source session closed. */
      }
    } else if (event.type === "local_model_request") {
      if (!binding.source || !binding.ready) {
        this.sendFrame(binding, event.requestId, {
          type: "error",
          message: this.statuses.get(serverId)?.error ?? SOURCE_UNAVAILABLE,
        });
        return;
      }
      const localId = `${this.namespace}:${++this.requestSequence}`;
      binding.pending.set(event.requestId, localId);
      this.requests.set(localId, { binding, requestId: event.requestId });
      try {
        binding.source.client.requestLocalModel(localId, event.body);
      } catch (error) {
        binding.pending.delete(event.requestId);
        this.requests.delete(localId);
        this.sendFrame(binding, event.requestId, {
          type: "error",
          message: error instanceof Error ? error.message : SOURCE_UNAVAILABLE,
        });
      }
    }
  }

  private sendFrame(binding: Binding, requestId: string, frame: LocalModelStreamFrame): void {
    try {
      binding.connection.client.sendLocalModelFrame(requestId, frame);
    } catch {
      /* A disconnected remote session already cancels its requests. */
    }
  }

  private cancelPending(binding: Binding, message: string): void {
    for (const [requestId, localId] of binding.pending) {
      this.requests.delete(localId);
      try {
        binding.source?.client.cancelLocalModel(localId);
      } catch {
        /* Source session closed. */
      }
      this.sendFrame(binding, requestId, { type: "error", message });
    }
    binding.pending.clear();
    binding.ready = false;
  }

  private enqueue(serverId: string, operation: () => Promise<void>): void {
    const next = (this.queues.get(serverId) ?? Promise.resolve())
      .then(operation)
      .catch((error: unknown) => {
        const status = this.statuses.get(serverId);
        if (status)
          this.publish(serverId, {
            ...status,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
      });
    this.queues.set(serverId, next);
    void next.then(() => {
      if (this.queues.get(serverId) === next) this.queues.delete(serverId);
      return undefined;
    });
  }

  private publish(serverId: string, status: LocalModelBridgeStatus): void {
    const previous = this.statuses.get(serverId);
    if (
      previous?.profile === status.profile &&
      previous.status === status.status &&
      previous.error === status.error &&
      previous.modelCount === status.modelCount
    )
      return;
    this.statuses.set(serverId, status);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
