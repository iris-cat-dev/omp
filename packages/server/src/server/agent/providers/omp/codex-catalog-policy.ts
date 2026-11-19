import { z } from "zod";

const CODEX_CACHE_MIGRATION = "codex-discovery-protocol-v2";
const GUARDED_FETCHES = new WeakSet<typeof fetch>();
const CodexModelEntrySchema = z
  .object({
    slug: z.string().trim().min(1).optional(),
    id: z.string().trim().min(1).optional(),
    visibility: z.enum(["list", "hide", "hidden"]),
    default_reasoning_level: z.string().trim().min(1).nullable(),
    supported_reasoning_levels: z.array(z.object({ effort: z.string().trim().min(1) })),
  })
  .refine((entry) => entry.slug !== undefined || entry.id !== undefined);
const CodexModelCatalogSchema = z.object({
  models: z.array(CodexModelEntrySchema).optional(),
  data: z.array(CodexModelEntrySchema).optional(),
});

/** Require Codex protocol metadata, not a model-name allowlist or a generic id/slug roster. */
export function isCodexModelCatalog(payload: unknown, official: boolean): boolean {
  const parsed = CodexModelCatalogSchema.safeParse(payload);
  if (!parsed.success) return false;
  const entries = parsed.data.models ?? (official ? undefined : parsed.data.data);
  // Only the dedicated official endpoint can authorize an explicitly empty roster.
  return entries !== undefined && (entries.length > 0 || official);
}

type CodexCatalogRequestKind = "other" | "reject-generic" | "official" | "gateway";

function isCodexGatewayCatalogRequest(url: URL, headers: Headers): boolean {
  return (
    url.searchParams.has("client_version") &&
    headers.get("originator") === "omp" &&
    headers.get("openai-beta") === "responses=experimental"
  );
}

function classifyCodexCatalogRequest(
  input: string | URL | Request,
  init?: RequestInit,
): CodexCatalogRequestKind {
  const request = input instanceof Request ? input : undefined;
  const rawUrl = request?.url ?? String(input);
  if (!rawUrl.includes("/models")) return "other";
  const method = init?.method ?? request?.method ?? "GET";
  if (method.toUpperCase() !== "GET") return "other";
  const url = new URL(rawUrl);
  const pathname = url.pathname.replace(/\/+$/, "");
  const official = url.origin === "https://chatgpt.com";
  if (official && pathname === "/backend-api/codex/models") return "official";
  if (official && pathname === "/backend-api/models") return "reject-generic";
  if (official || !pathname.endsWith("/models")) return "other";
  return isCodexGatewayCatalogRequest(url, new Headers(init?.headers ?? request?.headers))
    ? "gateway"
    : "other";
}

/** Installed before OMP captures fetch; native discovery keeps its own failure/fallback handling. */
export function createCodexCatalogFetch(fetchFn: typeof fetch): typeof fetch {
  if (GUARDED_FETCHES.has(fetchFn)) return fetchFn;
  const guarded: typeof fetch = async (input, init) => {
    const kind = classifyCodexCatalogRequest(input, init);
    if (kind === "other") return fetchFn(input, init);
    if (kind === "reject-generic") {
      // Never send the Codex OAuth credential to the generic ChatGPT catalog as a fallback.
      throw new Error("The generic ChatGPT model catalog is not a Codex discovery endpoint");
    }
    const response = await fetchFn(input, init);
    if (!response.ok) return response;
    // Inspect a clone: the native parser still receives the original body, headers and status.
    const payload: unknown = await response.clone().json();
    if (!isCodexModelCatalog(payload, kind === "official")) {
      // A successful empty substitute would prune the bundled catalog. Throw to retain fallback.
      throw new Error("Codex discovery returned a non-Codex model catalog");
    }
    return response;
  };
  // Bun fetch exposes preconnect; keep native fetch properties available to OMP's proxy wrapper.
  Object.defineProperties(guarded, Object.getOwnPropertyDescriptors(fetchFn));
  GUARDED_FETCHES.add(guarded);
  return guarded;
}

export interface CodexCatalogCacheStatement {
  get(...params: string[]): Record<string, unknown> | null | undefined;
  run(...params: string[]): unknown;
}

export interface CodexCatalogCacheDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): CodexCatalogCacheStatement;
}

/** Legacy normalized rows do not retain endpoint/protocol provenance, so none can be trusted. */
export function migrateCodexCatalogCache(database: CodexCatalogCacheDatabase): void {
  database.exec("CREATE TABLE IF NOT EXISTS omp_desktop_catalog_migrations (id TEXT PRIMARY KEY)");
  const migrated = database.prepare("SELECT id FROM omp_desktop_catalog_migrations WHERE id = ?");
  if (migrated.get(CODEX_CACHE_MIGRATION)) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!migrated.get(CODEX_CACHE_MIGRATION)) {
      const tableExists = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      );
      for (const table of ["model_cache", "model_cache_refresh"]) {
        if (tableExists.get(table)) {
          database.exec(
            `DELETE FROM ${table} WHERE provider_id = 'openai-codex' OR provider_id LIKE 'openai-codex:%'`,
          );
        }
      }
      database
        .prepare("INSERT INTO omp_desktop_catalog_migrations (id) VALUES (?)")
        .run(CODEX_CACHE_MIGRATION);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
