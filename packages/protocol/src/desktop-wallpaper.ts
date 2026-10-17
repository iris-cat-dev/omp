import { z } from "zod";

export const WALLPAPER_MEDIA_TYPES = {
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  png: { kind: "image", mime: "image/png" },
  gif: { kind: "image", mime: "image/gif" },
  webp: { kind: "image", mime: "image/webp" },
  bmp: { kind: "image", mime: "image/bmp" },
  avif: { kind: "image", mime: "image/avif" },
  mp4: { kind: "video", mime: "video/mp4" },
  m4v: { kind: "video", mime: "video/mp4" },
  webm: { kind: "video", mime: "video/webm" },
  mov: { kind: "video", mime: "video/quicktime" },
  ogv: { kind: "video", mime: "video/ogg" },
} as const;

export type WallpaperMediaKind = "image" | "video";

export function getWallpaperMediaType(filePath: string): {
  kind: WallpaperMediaKind;
  mime: string;
} | null {
  const extension = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
  return Object.hasOwn(WALLPAPER_MEDIA_TYPES, extension)
    ? WALLPAPER_MEDIA_TYPES[extension as keyof typeof WALLPAPER_MEDIA_TYPES]
    : null;
}

const CandidateIdSchema = z.uuid();
const RevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const WallpaperCandidateSchema = z.strictObject({
  candidateId: CandidateIdSchema,
  directory: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["image", "video"]),
});

export const WallpaperLibrarySchema = z
  .strictObject({
    version: z.literal(1),
    revision: RevisionSchema,
    items: z.array(WallpaperCandidateSchema),
  })
  .superRefine((library, context) => {
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const candidate of library.items) {
      if (ids.has(candidate.candidateId) || paths.has(candidate.path)) {
        context.addIssue({ code: "custom", message: "Duplicate wallpaper candidate." });
        return;
      }
      ids.add(candidate.candidateId);
      paths.add(candidate.path);
    }
  });

export type WallpaperCandidate = z.infer<typeof WallpaperCandidateSchema>;
export type WallpaperLibrary = z.infer<typeof WallpaperLibrarySchema>;
export type WallpaperValidatedFile = Omit<WallpaperCandidate, "candidateId">;

export const WallpaperMigrationSchema = z.strictObject({
  candidateId: CandidateIdSchema.nullable(),
  reason: z.string().nullable(),
});
export type WallpaperMigration = z.infer<typeof WallpaperMigrationSchema>;

export type WallpaperErrorCode =
  | "invalid-request"
  | "stale-document"
  | "superseded"
  | "not-found"
  | "not-readable"
  | "unsupported"
  | "invalid-file"
  | "storage-error"
  | "dialog-error"
  | "busy"
  | "unavailable";

export interface WallpaperFileFailure {
  path: string;
  code: WallpaperErrorCode;
  message: string;
}

export interface WallpaperPreviewFailure {
  candidateId: string;
  code: WallpaperErrorCode;
  message: string;
}

export interface WallpaperMediaDescriptor {
  id: string;
  candidateId: string;
  path: string;
  name: string;
  kind: WallpaperMediaKind;
}

export interface WallpaperAddedCandidates {
  library: WallpaperLibrary;
  added: WallpaperCandidate[];
  duplicates: WallpaperCandidate[];
}

export interface WallpaperAddResult extends WallpaperAddedCandidates {
  cancelled: boolean;
  rejected: WallpaperFileFailure[];
}

export interface WallpaperRemoveResult {
  library: WallpaperLibrary;
  removedCandidateIds: string[];
}

export interface WallpaperLegacyResult extends WallpaperMigration {
  library: WallpaperLibrary;
}

const ContextSchema = z.strictObject({ epoch: z.string().min(1) });

export const WallpaperRequestSchemas = {
  getContext: z.strictObject({}),
  getLibrary: ContextSchema,
  importLegacy: ContextSchema.extend({
    directory: z.string().nullable(),
    path: z.string().nullable(),
  }),
  addCandidates: ContextSchema.extend({
    title: z.string().min(1).max(256),
    mediaLabel: z.string().min(1).max(256),
    imageLabel: z.string().min(1).max(256),
    videoLabel: z.string().min(1).max(256),
  }),
  removeCandidates: ContextSchema.extend({ candidateIds: z.array(CandidateIdSchema) }),
  setBackground: ContextSchema.extend({
    revision: RevisionSchema,
    candidateId: CandidateIdSchema.nullable(),
  }),
  setPreviews: ContextSchema.extend({
    revision: RevisionSchema,
    candidateIds: z.array(CandidateIdSchema).max(48),
  }),
} as const;

export type WallpaperCommand = keyof typeof WallpaperRequestSchemas;
export type WallpaperRequest<K extends WallpaperCommand> = z.infer<
  (typeof WallpaperRequestSchemas)[K]
>;

export interface WallpaperCommandData {
  getContext: { epoch: string };
  getLibrary: WallpaperLibrary;
  importLegacy: WallpaperLegacyResult;
  addCandidates: WallpaperAddResult;
  removeCandidates: WallpaperRemoveResult;
  setBackground: { media: WallpaperMediaDescriptor | null };
  setPreviews: { media: WallpaperMediaDescriptor[]; rejected: WallpaperPreviewFailure[] };
}

export type WallpaperResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: WallpaperErrorCode; message: string };

export type WallpaperResponse<K extends WallpaperCommand> = WallpaperResult<
  WallpaperCommandData[K]
>;

export function isWallpaperCommand(command: string): command is WallpaperCommand {
  return Object.hasOwn(WallpaperRequestSchemas, command);
}
