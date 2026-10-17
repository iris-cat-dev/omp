import { randomUUID } from "node:crypto";
import {
  getWallpaperMediaType,
  type WallpaperCandidate,
  type WallpaperLibrary,
  type WallpaperMediaDescriptor,
  type WallpaperPreviewFailure,
  type WallpaperValidatedFile,
} from "@omp-desktop/protocol/desktop-wallpaper";
import {
  mapWallpaperFiles,
  validateWallpaperFile,
  wallpaperFailure,
  WallpaperError,
} from "./files.js";

type Purpose = "background" | "previews";
interface Holding {
  revision: number;
  media: Map<string, RegisteredWallpaperMedia>;
}
export interface WallpaperDocumentOwner {
  readonly epoch: string;
  readonly key: object;
  readonly background: Holding;
  readonly previews: Holding;
}
export interface RegisteredWallpaperMedia extends WallpaperMediaDescriptor {
  readonly mime: string;
}
interface MediaReference {
  readonly media: Readonly<RegisteredWallpaperMedia>;
  references: number;
}

// A validated file may be published only for the same canonical candidate identity.
function matchesCandidateFile(
  candidate: WallpaperCandidate | undefined,
  file: WallpaperValidatedFile | null,
): boolean {
  return (
    candidate !== undefined &&
    file !== null &&
    candidate.path === file.path &&
    candidate.kind === file.kind &&
    candidate.directory === file.directory
  );
}

export class WallpaperMediaRegistry {
  private readonly owners = new Map<object, WallpaperDocumentOwner>();
  private readonly byId = new Map<string, MediaReference>();
  private readonly idByPath = new Map<string, string>();
  private candidates = new Map<string, WallpaperCandidate>();

  constructor(private readonly validate = validateWallpaperFile) {}

  activateOwner(key: object): WallpaperDocumentOwner {
    const previous = this.owners.get(key);
    if (previous) this.disposeOwner(previous);
    const owner: WallpaperDocumentOwner = {
      key,
      epoch: randomUUID(),
      background: { revision: -1, media: new Map() },
      previews: { revision: -1, media: new Map() },
    };
    this.owners.set(key, owner);
    return owner;
  }

  getOwner(key: object): WallpaperDocumentOwner | null {
    return this.owners.get(key) ?? null;
  }

  isCurrent(owner: WallpaperDocumentOwner, epoch = owner.epoch): boolean {
    return this.owners.get(owner.key) === owner && owner.epoch === epoch;
  }

  disposeOwner(owner: WallpaperDocumentOwner): void {
    if (!this.isCurrent(owner)) return;
    this.owners.delete(owner.key);
    this.replace(owner.background, new Map());
    this.replace(owner.previews, new Map());
  }

  // Called synchronously at the store commit boundary, before ordinary subscribers.
  updateLibrary(library: WallpaperLibrary): void {
    this.candidates = new Map(library.items.map((item) => [item.candidateId, { ...item }]));
    for (const owner of this.owners.values()) {
      for (const purpose of ["background", "previews"] as const) {
        const holding = owner[purpose];
        for (const [candidateId, media] of holding.media) {
          const candidate = this.candidates.get(candidateId);
          if (!candidate || candidate.path !== media.path || candidate.kind !== media.kind) {
            holding.media.delete(candidateId);
            this.release(media);
          }
        }
      }
    }
  }

  // Immutable capture is the authorization point for an individual stream request.
  get(id: string): Readonly<RegisteredWallpaperMedia> | null {
    return this.byId.get(id)?.media ?? null;
  }

  async setBackground(
    owner: WallpaperDocumentOwner,
    epoch: string,
    revision: number,
    candidateId: string | null,
  ): Promise<{ media: WallpaperMediaDescriptor | null }> {
    const result = await this.set(
      owner,
      epoch,
      "background",
      revision,
      candidateId ? [candidateId] : [],
    );
    if (result.rejected.length) {
      const failure = result.rejected[0];
      throw new WallpaperError(failure.code, failure.message);
    }
    return { media: result.media[0] ?? null };
  }

  setPreviews(
    owner: WallpaperDocumentOwner,
    epoch: string,
    revision: number,
    candidateIds: readonly string[],
  ): Promise<{ media: WallpaperMediaDescriptor[]; rejected: WallpaperPreviewFailure[] }> {
    if (candidateIds.length > 48) {
      return Promise.reject(
        new WallpaperError("invalid-request", "At most 48 previews may be held."),
      );
    }
    return this.set(owner, epoch, "previews", revision, candidateIds);
  }

  private async set(
    owner: WallpaperDocumentOwner,
    epoch: string,
    purpose: Purpose,
    revision: number,
    candidateIds: readonly string[],
  ): Promise<{ media: WallpaperMediaDescriptor[]; rejected: WallpaperPreviewFailure[] }> {
    if (!this.isCurrent(owner, epoch))
      throw new WallpaperError("stale-document", "The document has changed.");
    const holding = owner[purpose];
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new WallpaperError("invalid-request", "Invalid media revision.");
    }
    if (revision <= holding.revision)
      throw new WallpaperError("superseded", "The media intent was superseded.");
    holding.revision = revision;
    const ids = [...new Set(candidateIds)];
    if (ids.length === 0) {
      this.replace(holding, new Map());
      return { media: [], rejected: [] };
    }
    const checked = await mapWallpaperFiles(ids, async (candidateId) => {
      const candidate = this.candidates.get(candidateId);
      try {
        if (!candidate)
          throw new WallpaperError("not-found", "The wallpaper candidate was removed.");
        const file = await this.validate(candidate.path);
        if (!matchesCandidateFile(candidate, file)) {
          throw new WallpaperError("invalid-file", "The wallpaper file identity has changed.");
        }
        return { candidateId, file, failure: null };
      } catch (error) {
        const failure = wallpaperFailure(error);
        return { candidateId, file: null, failure };
      }
    });
    if (!this.isCurrent(owner, epoch))
      throw new WallpaperError("stale-document", "The document has changed.");
    if (holding.revision !== revision)
      throw new WallpaperError("superseded", "The media intent was superseded.");
    const next = new Map<string, RegisteredWallpaperMedia>();
    const rejected: WallpaperPreviewFailure[] = [];
    for (const item of checked) {
      const candidate = this.candidates.get(item.candidateId);
      let failure = item.failure;
      if (!failure && !matchesCandidateFile(candidate, item.file)) {
        failure = new WallpaperError(
          "not-found",
          "The wallpaper candidate was removed or changed.",
        );
      }
      if (failure || !item.file) {
        rejected.push({
          candidateId: item.candidateId,
          code: failure?.code ?? "invalid-file",
          message: failure?.message ?? "Invalid media file.",
        });
      } else {
        next.set(item.candidateId, this.acquire(item.candidateId, item.file));
      }
    }
    // All new references are acquired before any old references are released.
    this.replace(holding, next);
    return { media: [...next.values()].map(({ mime: _mime, ...media }) => media), rejected };
  }

  private acquire(candidateId: string, file: WallpaperValidatedFile): RegisteredWallpaperMedia {
    const existingId = this.idByPath.get(file.path);
    const existing = existingId ? this.byId.get(existingId) : undefined;
    if (existing) {
      existing.references += 1;
      return existing.media;
    }
    const type = getWallpaperMediaType(file.path)!;
    const media = Object.freeze({
      id: randomUUID(),
      candidateId,
      path: file.path,
      name: file.name,
      kind: file.kind,
      mime: type.mime,
    });
    this.byId.set(media.id, { media, references: 1 });
    this.idByPath.set(file.path, media.id);
    return media;
  }

  private release(media: RegisteredWallpaperMedia): void {
    const entry = this.byId.get(media.id);
    if (!entry || --entry.references > 0) return;
    this.byId.delete(media.id);
    this.idByPath.delete(media.path);
  }

  private replace(holding: Holding, next: Map<string, RegisteredWallpaperMedia>): void {
    const previous = holding.media;
    holding.media = next;
    for (const media of previous.values()) this.release(media);
  }
}

export const wallpaperMediaRegistry = new WallpaperMediaRegistry();
