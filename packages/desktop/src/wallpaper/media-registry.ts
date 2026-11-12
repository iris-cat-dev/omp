import { randomUUID } from "node:crypto";
import {
  getWallpaperMediaType,
  type WallpaperCandidate,
  type WallpaperLibrary,
  type WallpaperLeaseScope,
  type WallpaperMediaDescriptor,
  type WallpaperPreviewFailure,
  type WallpaperValidatedFile,
} from "@omp-desktop/protocol/desktop-wallpaper";
import { mapWallpaperFiles, validateWallpaperFile, wallpaperFailure, WallpaperError } from "./files.js";

type Purpose = WallpaperLeaseScope["purpose"];
export interface WallpaperInstallationBinding {
  installationId: string;
  generation: number;
}
interface Holding {
  revision: number;
  media: Map<string, RegisteredWallpaperMedia>;
}
interface InstallationLease {
  binding: WallpaperInstallationBinding;
  background: Holding;
  previews: Holding;
}
export interface NativeProtocolRequestIdentity {
  readonly contentsId: number;
  readonly frameId: string;
  readonly isMainFrame: boolean;
  readonly isDocument: boolean;
  readonly navigationToken: string;
}
export interface WallpaperDocumentOwner {
  readonly epoch: string;
  readonly key: object;
  readonly nativeIdentity: Readonly<NativeProtocolRequestIdentity> | null;
  readonly installations: Map<string, InstallationLease>;
}
export interface RegisteredWallpaperMedia extends WallpaperMediaDescriptor {
  readonly mime: string;
}

function matchesCandidateFile(candidate: WallpaperCandidate | undefined, file: WallpaperValidatedFile | null): boolean {
  return candidate !== undefined && file !== null && candidate.path === file.path &&
    candidate.kind === file.kind && candidate.directory === file.directory;
}

/** Each URL belongs to one installation generation, document and purpose. */
export class WallpaperMediaRegistry {
  private readonly owners = new Map<object, WallpaperDocumentOwner>();
  private readonly byId = new Map<string, Readonly<RegisteredWallpaperMedia>>();
  private candidates = new Map<string, WallpaperCandidate>();

  constructor(private readonly validate = validateWallpaperFile) {}

  activateOwner(key: object, nativeIdentity: NativeProtocolRequestIdentity | null = null): WallpaperDocumentOwner {
    const previous = this.owners.get(key);
    if (previous) this.disposeOwner(previous);
    const owner: WallpaperDocumentOwner = { key, epoch: randomUUID(), installations: new Map(),
      nativeIdentity: nativeIdentity ? Object.freeze({ ...nativeIdentity }) : null };
    this.owners.set(key, owner);
    return owner;
  }

  bindNativeDocument(key: object, identity: NativeProtocolRequestIdentity): WallpaperDocumentOwner {
    if (!identity.isMainFrame || !identity.isDocument) throw new Error("Only a native main document can own wallpaper media.");
    const previous = this.getOwner(key);
    const native = previous?.nativeIdentity;
    if (native && native.contentsId === identity.contentsId && native.frameId === identity.frameId &&
        native.navigationToken === identity.navigationToken) return previous!;
    return this.activateOwner(key, identity);
  }

  getOwner(key: object): WallpaperDocumentOwner | null { return this.owners.get(key) ?? null; }

  isCurrent(owner: WallpaperDocumentOwner, epoch = owner.epoch): boolean {
    return this.owners.get(owner.key) === owner && owner.epoch === epoch;
  }

  disposeOwner(owner: WallpaperDocumentOwner): void {
    if (!this.isCurrent(owner)) return;
    this.owners.delete(owner.key);
    for (const lease of owner.installations.values()) this.disposeLease(lease);
    owner.installations.clear();
  }

  revokeInstallation(installationId: string, generation: number): void {
    for (const owner of this.owners.values()) {
      const lease = owner.installations.get(installationId);
      if (lease?.binding.generation !== generation) continue;
      owner.installations.delete(installationId);
      this.disposeLease(lease);
    }
  }

  nextPluginDocumentRevision(owner: WallpaperDocumentOwner, installationId: string, generation: number,
    purpose: "background" | "previews"): number {
    if (!this.isCurrent(owner)) throw new WallpaperError("stale-document", "The document has changed.");
    if (!Number.isSafeInteger(generation) || generation < 0) throw new WallpaperError("invalid-request", "Invalid installation generation.");
    const lease = owner.installations.get(installationId);
    if (lease && lease.binding.generation !== generation) {
      throw new WallpaperError("unauthorized", "The installation generation was revoked.");
    }
    const revision = lease?.[purpose].revision ?? -1;
    if (revision >= Number.MAX_SAFE_INTEGER) throw new WallpaperError("invalid-request", "Wallpaper media revision is exhausted.");
    return revision + 1;
  }


  releasePluginDocument(owner: WallpaperDocumentOwner, installationId: string, generation: number,
    purpose: "background" | "previews"): void {
    if (!this.isCurrent(owner)) return;
    const lease = owner.installations.get(installationId);
    if (lease?.binding.generation !== generation) return;
    ++lease[purpose].revision;
    this.replace(lease[purpose], new Map());
  }

  revokeBackground(installationId: string, generation: number): void {
    for (const owner of this.owners.values()) {
      this.releasePluginDocument(owner, installationId, generation, "background");
    }
  }


  // Synchronous commit callback prevents removed candidate identities acquiring new reads.
  updateLibrary(library: WallpaperLibrary): void {
    this.candidates = new Map(library.items.map((item) => [item.candidateId, { ...item }]));
    for (const owner of this.owners.values()) {
      for (const lease of owner.installations.values()) {
        for (const purpose of ["background", "previews"] as const) {
          for (const [candidateId, media] of lease[purpose].media) {
            const candidate = this.candidates.get(candidateId);
            if (!candidate || candidate.path !== media.path || candidate.kind !== media.kind) {
              lease[purpose].media.delete(candidateId);
              this.byId.delete(media.id);
            }
          }
        }
      }
    }
  }

  // The immutable result is captured before file I/O; revocation cannot truncate accepted streams.
  get(id: string, scope: WallpaperLeaseScope): Readonly<RegisteredWallpaperMedia> | null {
    const media = this.byId.get(id);
    return media && media.scope.installationId === scope.installationId &&
      media.scope.generation === scope.generation && media.scope.epoch === scope.epoch &&
      media.scope.purpose === scope.purpose ? media : null;
  }

  async setBackground(owner: WallpaperDocumentOwner, epoch: string, revision: number,
    candidateId: string | null, binding: WallpaperInstallationBinding): Promise<{ media: WallpaperMediaDescriptor | null }> {
    const result = await this.set(owner, epoch, "background", revision, candidateId ? [candidateId] : [], binding);
    if (result.rejected.length) {
      const failure = result.rejected[0];
      throw new WallpaperError(failure.code, failure.message);
    }
    return { media: result.media[0] ?? null };
  }

  setPreviews(owner: WallpaperDocumentOwner, epoch: string, revision: number,
    candidateIds: readonly string[], binding: WallpaperInstallationBinding): Promise<{ media: WallpaperMediaDescriptor[]; rejected: WallpaperPreviewFailure[] }> {
    if (candidateIds.length > 48) return Promise.reject(new WallpaperError("invalid-request", "At most 48 previews may be held."));
    return this.set(owner, epoch, "previews", revision, candidateIds, binding);
  }

  private async set(owner: WallpaperDocumentOwner, epoch: string, purpose: Purpose, revision: number,
    candidateIds: readonly string[], binding: WallpaperInstallationBinding): Promise<{ media: WallpaperMediaDescriptor[]; rejected: WallpaperPreviewFailure[] }> {
    if (!this.isCurrent(owner, epoch)) throw new WallpaperError("stale-document", "The document has changed.");
    if (!Number.isSafeInteger(revision) || revision < 0) throw new WallpaperError("invalid-request", "Invalid media revision.");
    let lease = owner.installations.get(binding.installationId);
    if (lease && lease.binding.generation !== binding.generation) {
      throw new WallpaperError("unauthorized", "The installation generation was revoked.");
    }
    if (!lease) {
      lease = { binding: { ...binding }, background: { revision: -1, media: new Map() }, previews: { revision: -1, media: new Map() } };
      owner.installations.set(binding.installationId, lease);
    }
    const holding = lease[purpose];
    if (revision <= holding.revision) throw new WallpaperError("superseded", "The media intent was superseded.");
    holding.revision = revision;
    // Revoke the previous intent immediately, including when the next load fails.
    this.replace(holding, new Map());
    const ids = [...new Set(candidateIds)];
    if (ids.length === 0) return { media: [], rejected: [] };
    const checked = await mapWallpaperFiles(ids, async (candidateId) => {
      const candidate = this.candidates.get(candidateId);
      try {
        if (!candidate) throw new WallpaperError("not-found", "The wallpaper candidate was removed.");
        const file = await this.validate(candidate.path);
        if (!matchesCandidateFile(candidate, file)) throw new WallpaperError("invalid-file", "The wallpaper file identity has changed.");
        return { candidateId, file, failure: null };
      } catch (error) {
        return { candidateId, file: null, failure: wallpaperFailure(error) };
      }
    });
    if (!this.isCurrent(owner, epoch)) throw new WallpaperError("stale-document", "The document has changed.");
    if (owner.installations.get(binding.installationId) !== lease) throw new WallpaperError("unauthorized", "The installation generation was revoked.");
    if (holding.revision !== revision) throw new WallpaperError("superseded", "The media intent was superseded.");
    const next = new Map<string, RegisteredWallpaperMedia>();
    const rejected: WallpaperPreviewFailure[] = [];
    for (const item of checked) {
      let failure = item.failure;
      if (!failure && !matchesCandidateFile(this.candidates.get(item.candidateId), item.file)) {
        failure = new WallpaperError("not-found", "The wallpaper candidate was removed or changed.");
      }
      if (failure || !item.file) {
        rejected.push({ candidateId: item.candidateId, code: failure?.code ?? "invalid-file", message: failure?.message ?? "Invalid media file." });
      } else {
        const id = randomUUID();
        const scope = Object.freeze({ ...binding, epoch, purpose });
        const query = new URLSearchParams({ id, installationId: binding.installationId,
          generation: String(binding.generation), epoch, purpose });
        const media = Object.freeze({ id, candidateId: item.candidateId, path: item.file.path,
          name: item.file.name, kind: item.file.kind, mime: getWallpaperMediaType(item.file.path)!.mime,
          scope, uri: `omp-desktop://app/wallpaper-media?${query}` });
        next.set(item.candidateId, media);
        this.byId.set(media.id, media);
      }
    }
    this.replace(holding, next);
    return { media: [...next.values()].map(({ mime: _mime, ...media }) => media), rejected };
  }

  private disposeLease(lease: InstallationLease): void {
    this.replace(lease.background, new Map());
    this.replace(lease.previews, new Map());
  }

  private replace(holding: Holding, next: Map<string, RegisteredWallpaperMedia>): void {
    for (const media of holding.media.values()) this.byId.delete(media.id);
    holding.media = next;
  }
}

export const wallpaperMediaRegistry = new WallpaperMediaRegistry();
