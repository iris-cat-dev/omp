import type { PluginBackgroundIntent, PluginClientContext, PluginStorageSnapshot } from "@omp-desktop/plugin";
import { WallpaperLibrarySchema, WallpaperMigrationStatusSchema, type WallpaperMigrationStatus, type WallpaperAddResult, type WallpaperCommand, type WallpaperCommandData,
  type WallpaperErrorCode, type WallpaperLibrary, type WallpaperMediaDescriptor, type WallpaperPreviewFailure, type WallpaperRemoveResult,
  type WallpaperResponse } from "@omp-desktop/protocol/desktop-wallpaper";
import { DEFAULT_WALLPAPER_CONFIGURATION, parseRemoteWallpaperSource, type WallpaperConfiguration } from "./source.js";
import { WallpaperConfigSchema } from "./builtin.js";

export type WallpaperLoadStatus = "idle" | "loading" | "ready" | "error";
export class WallpaperClientError extends Error {
  constructor(readonly code: WallpaperErrorCode, message: string) {
    super(message);
    this.name = "WallpaperClientError";
  }
}

export interface WallpaperSnapshot {
  configuration: WallpaperConfiguration;
  revision: number;
  library: WallpaperLibrary | null;
  loading: boolean;
  error: string | null;
  libraryError: string | null;
  migrationStatus: WallpaperMigrationStatus | null;
  migrationError: string | null;
  cleanupError: string | null;
  loadStatus: WallpaperLoadStatus;
  loadError: string | null;
  intent: PluginBackgroundIntent | null;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Renderer drafts/readiness are local. The scoped SDK storage is the only persisted authority. */
export class WallpaperController {
  private snapshot: WallpaperSnapshot = { configuration: DEFAULT_WALLPAPER_CONFIGURATION, revision: -1,
    library: null, loading: true, error: null, libraryError: null, migrationStatus: null, migrationError: null, cleanupError: null, loadStatus: "idle", loadError: null, intent: null };
  private listeners = new Set<() => void>();
  private context: Promise<{ epoch: string }> | null = null;
  private documentContext: { epoch: string } | null = null;
  private backgroundRevision = 0;
  private previewsRevision = 0;
  private migrationRevision = 0;
  private attempt = 0;
  private sourceKey: string | null = null;
  private backgroundLease: { release(): void } | null = null;
  private active: PluginClientContext | null = null;
  private selected = false;
  private selectionRevision = 0;
  private disposed = false;
  private saveTail: Promise<unknown> = Promise.resolve();
  private contexts = new Set<PluginClientContext>();
  private opacityPreview: number | null = null;

  constructor(private ctx: PluginClientContext) {}
  attach(ctx: PluginClientContext): () => void {
    this.contexts.add(ctx);
    this.ctx = ctx;
    const stopLibrary = ctx.native.subscribe("wallpaper:libraryChanged", raw => {
      try { this.acceptLibrary(WallpaperLibrarySchema.parse(raw)); } catch (error) { this.failLibrary(error); }
    });
    const stopConfiguration = ctx.native.subscribe("plugins:changed", () => { void this.reloadConfiguration(); });
    const stopSelection = ctx.native.subscribe("wallpaper:selectionChanged", raw => {
      if (typeof raw !== "boolean") throw new Error("Invalid wallpaper provider selection.");
      ++this.selectionRevision;
      const changed = this.selected !== raw;
      this.selected = raw;
      this.reconcile(changed);
    });
    const stopMigration = ctx.native.subscribe("wallpaper:migrationChanged", raw => {
      ++this.migrationRevision;
      try { this.publish({ migrationStatus: WallpaperMigrationStatusSchema.parse(raw), migrationError: null }); }
      catch (error) { this.publish({ migrationError: message(error) }); }
    });
    void this.reloadConfiguration();
    void this.reloadLibrary();
    void this.reloadMigrationStatus();
    return () => {
      void stopLibrary(); void stopConfiguration(); void stopSelection(); void stopMigration();
      this.contexts.delete(ctx);
      if (this.ctx === ctx) this.ctx = this.contexts.values().next().value ?? ctx;
    };
  }
  getSnapshot = (): WallpaperSnapshot => this.snapshot;
  getBackgroundSnapshot = (): PluginBackgroundIntent | null => this.snapshot.intent;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<WallpaperSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  activate(ctx: PluginClientContext): () => void {
    this.active = ctx;
    void this.reloadSelection();
    return () => {
      if (this.active !== ctx) return;
      this.active = null;
      this.cancelBackground();
      this.sourceKey = null;
      this.publish({ intent: null, loadStatus: "idle", loadError: null });
    };
  }
  private async reloadSelection(): Promise<void> {
    const active = this.active;
    if (!active) return;
    const revision = ++this.selectionRevision;
    try {
      const selected = await active.native.invoke<boolean>("wallpaper:selection");
      if (typeof selected !== "boolean") throw new Error("Invalid wallpaper provider selection.");
      if (this.active !== active || active.signal.aborted || revision !== this.selectionRevision) return;
      const changed = this.selected !== selected;
      this.selected = selected;
      this.reconcile(changed);
    } catch (error) {
      if (this.active !== active || active.signal.aborted || revision !== this.selectionRevision) return;
      this.selected = false;
      this.cancelBackground();
      this.sourceKey = null;
      this.publish({ intent: null, loadStatus: "error", loadError: message(error) });
    }
  }
  private async invoke<K extends WallpaperCommand>(command: K, input: Record<string, unknown>,
    client = this.active ?? this.ctx): Promise<WallpaperCommandData[K]> {
    if (this.disposed && !((command === "setBackground" && input.candidateId === null) ||
      (command === "setPreviews" && Array.isArray(input.candidateIds) && input.candidateIds.length === 0))) {
      throw new WallpaperClientError("unauthorized", "Wallpaper controller has been disposed.");
    }
    const response = await client.native.invoke<WallpaperResponse<K>>(`wallpaper:${command}`, input);
    if (!response.ok) throw new WallpaperClientError(response.code, response.message);
    return response.data;
  }
  private getContext(): Promise<{ epoch: string }> {
    if (!this.context) {
      const request = this.invoke("getContext", {}).then(value => {
        this.documentContext = value;
        return value;
      });
      this.context = request;
      void request.catch(() => { if (this.context === request) this.context = null; });
    }
    return this.context;
  }
  private acceptConfiguration(result: PluginStorageSnapshot<WallpaperConfiguration>): void {
    const configuration = WallpaperConfigSchema.parse(result.values);
    if (result.revision < this.snapshot.revision || this.disposed) return;
    this.publish({ configuration, revision: result.revision, loading: false, error: null });
    this.reconcile();
  }
  reloadConfiguration = async (): Promise<void> => {
    if (this.disposed) return;
    try { this.acceptConfiguration(await this.ctx.storage.get<WallpaperConfiguration>()); }
    catch (error) { this.publish({ loading: false, error: message(error) }); this.reconcile(); }
  };
  private acceptLibrary(library: WallpaperLibrary): void {
    if (this.snapshot.library && library.revision <= this.snapshot.library.revision) {
      this.publish({ libraryError: null });
    } else {
      this.publish({ library, libraryError: null });
    }
    this.reconcile();
  }
  private failLibrary(error: unknown): void { this.publish({ libraryError: message(error) }); this.reconcile(); }
  reloadLibrary = async (): Promise<void> => {
    if (this.disposed) return;
    try { const { epoch } = await this.getContext(); this.acceptLibrary(WallpaperLibrarySchema.parse(await this.invoke("getLibrary", { epoch }))); }
    catch (error) { this.failLibrary(error); }
  };
  reloadMigrationStatus = async (): Promise<void> => {
    if (this.disposed) return;
    const revision = ++this.migrationRevision;
    try {
      const status = WallpaperMigrationStatusSchema.parse(await this.ctx.native.invoke("wallpaper:migrationStatus"));
      if (revision === this.migrationRevision) this.publish({ migrationStatus: status, migrationError: null });
    } catch (error) {
      if (revision === this.migrationRevision) this.publish({ migrationError: message(error) });
    }
  };

  patch = (fields: Partial<WallpaperConfiguration>): Promise<void> => {
    const input = { ...fields };
    const save = this.saveTail.catch(() => undefined).then(async () => {
      if (this.disposed) throw new WallpaperClientError("unauthorized", "Wallpaper controller has been disposed.");
      try {
        const result = await this.ctx.storage.patch<WallpaperConfiguration>(input, this.snapshot.revision);
        this.acceptConfiguration(result);
        if (Object.hasOwn(input, "opacity")) this.previewOpacity(null);
      } catch (error) {
        await this.reloadConfiguration();
        this.publish({ error: message(error) });
        throw error;
      }
    });
    this.saveTail = save;
    return save;
  };
  previewOpacity = (opacity: number | null): void => {
    this.opacityPreview = opacity;
    const intent = this.snapshot.intent;
    if (intent) this.publish({ intent: { ...intent, opacity: opacity ?? this.snapshot.configuration.opacity } });
  };
  retry = (): void => { this.reconcile(true); void this.reloadSelection(); };
  private cancelBackground(): void { ++this.attempt; this.backgroundLease?.release(); this.backgroundLease = null; }
  private reconcile(force = false): void {
    if (this.disposed) return;
    const config = this.snapshot.configuration;
    const remote = config.source === "url" ? parseRemoteWallpaperSource(config.url) : null;
    const candidate = config.source === "file" && !this.snapshot.libraryError
      ? this.snapshot.library?.items.find(item => item.candidateId === config.candidateId) : null;
    const key = !this.active || !this.selected || this.snapshot.loading || this.snapshot.error ? null : remote?.key ?? (candidate ? `file:${candidate.candidateId}` : null);
    if (!force && key === this.sourceKey) {
      if (this.snapshot.intent) this.publish({ intent: { ...this.snapshot.intent, opacity: this.opacityPreview ?? config.opacity } });
      return;
    }
    this.cancelBackground();
    this.sourceKey = key;
    const token = this.attempt;
    this.publish({ intent: null, loadStatus: key ? "loading" : "idle", loadError: null });
    if (!key || !this.active) return;
    const active = this.active;
    const publishSource = (source: { uri: string; kind: "image" | "video" }) => {
      if (this.disposed || this.attempt !== token || this.active !== active || active.signal.aborted) return;
      const requestKey = `${active.installation.id}:${active.installation.generation}:${token}:${key}`;
      this.publish({ intent: { requestKey, source, opacity: this.opacityPreview ?? this.snapshot.configuration.opacity,
        onReady: () => { if (this.attempt === token && this.active === active && !active.signal.aborted) this.publish({ loadStatus: "ready" }); },
        onError: () => {
          if (this.attempt !== token || this.active !== active || active.signal.aborted) return;
          this.cancelBackground();
          this.publish({ intent: null, loadStatus: "error", loadError: null });
        } } });
    };
    if (remote) { publishSource(remote); return; }
    const lease = this.acquireBackground(candidate!.candidateId);
    this.backgroundLease = lease;
    void lease.result.then(media => {
      if (this.attempt !== token || this.active !== active || active.signal.aborted) return;
      if (!media || media.candidateId !== candidate!.candidateId) throw new Error("Wallpaper media identity changed.");
      publishSource(media);
    }).catch(error => {
      if (this.attempt !== token || this.active !== active || active.signal.aborted) return;
      lease.release(); this.backgroundLease = null;
      this.publish({ intent: null, loadStatus: "error", loadError: message(error) });
    });
  }
  private acquireBackground(candidateId: string) {
    return this.acquire("setBackground", { candidateId }, "backgroundRevision", { candidateId: null });
  }
  acquirePreviews = (candidateIds: readonly string[], client = this.ctx) => this.acquire("setPreviews", { candidateIds: [...candidateIds] }, "previewsRevision", { candidateIds: [] }, client);
  private acquire<K extends "setBackground" | "setPreviews">(command: K, input: Record<string, unknown>, counter: "backgroundRevision" | "previewsRevision", clear: Record<string, unknown>, client = this.active ?? this.ctx) {
    const revision = ++this[counter];
    const contextRequest = this.getContext();
    let acquisitionStarted = false;
    const result = (async () => {
      const { epoch } = await contextRequest;
      if (this.disposed || revision !== this[counter]) throw new Error("Wallpaper lease was superseded.");
      acquisitionStarted = true;
      const value = await this.invoke(command, { ...input, epoch, revision }, client);
      if (this.disposed || revision !== this[counter]) throw new Error("Wallpaper lease was superseded.");
      return value;
    })();
    return { result: result.then(value => command === "setBackground" ? (value as WallpaperCommandData["setBackground"]).media : value) as
      K extends "setBackground" ? Promise<WallpaperMediaDescriptor | null> : Promise<{ media: WallpaperMediaDescriptor[]; rejected: WallpaperPreviewFailure[] }>,
      release: () => {
        if (revision !== this[counter]) return;
        const clearRevision = ++this[counter];
        // Reuse the epoch request captured before acquisition; cleanup never opens a new context.
        void contextRequest.then(({ epoch }) => {
          if (clearRevision !== this[counter]) return;
          return this.invoke(command, { ...clear, epoch, revision: clearRevision }, client);
        }).catch(error => {
          // A failed context request dispatched no acquire; the acquisition result owns that error.
          if (!acquisitionStarted && this.documentContext === null) return;
          if (error instanceof WallpaperClientError && (error.code === "stale-document" || error.code === "superseded")) return;
          if (error instanceof Error) {
            const detail = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
            if (detail === "Plugin client activation has been released." || detail === "Plugin media intent was superseded.") return;
            if (client.signal.aborted && (error.name === "AbortError" || detail === "Plugin generation is no longer current." ||
              detail === "Plugin document was replaced." || detail === "The installation generation was revoked.")) return;
          }
          const failure = message(error);
          this.publish({ cleanupError: failure });
          console.error(`[Wallpaper] Failed to release ${command} for ${client.installation.id}:${client.installation.generation}`, error);
        });
      } };
  }
  add = async (labels: { title: string; mediaLabel: string; imageLabel: string; videoLabel: string }): Promise<WallpaperAddResult> => {
    try { const { epoch } = await this.getContext(); const result = await this.invoke("addCandidates", { epoch, ...labels }); this.acceptLibrary(result.library); return result; }
    catch (error) { await this.reloadLibrary(); throw error; }
  };
  remove = async (candidateIds: readonly string[]): Promise<WallpaperRemoveResult> => {
    try { const { epoch } = await this.getContext(); const result = await this.invoke("removeCandidates", { epoch, candidateIds: [...candidateIds] }); this.acceptLibrary(result.library); return result; }
    catch (error) { await this.reloadLibrary(); throw error; }
  };
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = null;
    this.selected = false;
    this.sourceKey = null;
    this.cancelBackground();
    this.snapshot = { ...this.snapshot, intent: null, loadStatus: "idle", loadError: null };
    this.listeners.clear();
  }
}
