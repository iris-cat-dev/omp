import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import {
  createCodexCatalogFetch,
  isCodexModelCatalog,
  migrateCodexCatalogCache,
  type CodexCatalogCacheDatabase,
} from "./codex-catalog-policy.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => CodexCatalogCacheDatabase & { close(): void };
};
const nativeEntry = {
  slug: "future-codex-model",
  visibility: "list",
  default_reasoning_level: "medium",
  supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
};

describe("Codex catalog protocol", () => {
  test("accepts capability-bearing future models without a model-name allowlist", () => {
    expect(isCodexModelCatalog({ models: [nativeEntry] }, true)).toBe(true);
    expect(
      isCodexModelCatalog(
        {
          models: [
            { ...nativeEntry, default_reasoning_level: null, supported_reasoning_levels: [] },
          ],
        },
        true,
      ),
    ).toBe(true);
  });

  test.each([
    { models: [{ slug: "auto" }, { slug: "research" }] },
    { data: [{ id: "future-codex-model" }] },
    { status: "temporary failure" },
    { models: [nativeEntry, { slug: "other" }] },
    { models: [{ ...nativeEntry, supported_reasoning_levels: [{ level: "high" }] }] },
    { models: [{ ...nativeEntry, default_reasoning_level: undefined }] },
  ])("rejects a non-Codex or partial catalog: %j", (payload) => {
    expect(isCodexModelCatalog(payload, true)).toBe(false);
    expect(isCodexModelCatalog(payload, false)).toBe(false);
  });

  test("distinguishes the official protocol from a capability-bearing gateway data envelope", () => {
    expect(isCodexModelCatalog({ data: [nativeEntry] }, true)).toBe(false);
    expect(isCodexModelCatalog({ data: [nativeEntry] }, false)).toBe(true);
    expect(isCodexModelCatalog({ models: [] }, true)).toBe(true);
    expect(isCodexModelCatalog({ models: [] }, false)).toBe(false);
  });

  test("preserves a valid dedicated response for the native parser", async () => {
    const guarded = createCodexCatalogFetch(async () =>
      Response.json({ models: [nativeEntry] }, { headers: { etag: '"catalog-v1"' } }),
    );
    const response = await guarded(
      "https://chatgpt.com/backend-api/codex/models?client_version=0.159.0",
    );
    await expect(response.json()).resolves.toEqual({ models: [nativeEntry] });
    expect(response.headers.get("etag")).toBe('"catalog-v1"');
  });

  test("refuses the official generic fallback before sending an OAuth request", async () => {
    let requests = 0;
    const guarded = createCodexCatalogFetch(async () => {
      requests += 1;
      return Response.json({ models: [nativeEntry] });
    });
    await expect(
      guarded("https://chatgpt.com/backend-api/models?client_version=0.159.0", {
        headers: { Authorization: "Bearer synthetic" },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(requests).toBe(0);
  });

  test.each([
    () => Response.json({ status: "temporary failure" }),
    () => Response.json({ models: [nativeEntry, { slug: "auto" }] }),
    () => new Response("<html>not a catalog</html>", { status: 200 }),
  ])(
    "makes invalid successful discovery a failure rather than an empty authority",
    async (response) => {
      const guarded = createCodexCatalogFetch(async () => response());
      await expect(guarded("https://chatgpt.com/backend-api/codex/models")).rejects.toBeInstanceOf(
        Error,
      );
    },
  );

  test("does not admit an id-only compatible-gateway fallback", async () => {
    const guarded = createCodexCatalogFetch(async () => Response.json({ data: [{ id: "auto" }] }));
    await expect(
      guarded("https://gateway.example/backend-api/models?client_version=0.159.0", {
        headers: { originator: "omp", "OpenAI-Beta": "responses=experimental" },
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  test("returns the same wrapper when applied more than once", () => {
    const base: typeof fetch = async () => Response.json({ models: [nativeEntry] });
    const once = createCodexCatalogFetch(base);
    expect(createCodexCatalogFetch(once)).toBe(once);
  });
});

describe("Codex cache migration", () => {
  test("invalidates legacy authority and fallback rows without changing other providers or credentials", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE model_cache (provider_id TEXT PRIMARY KEY, authoritative INTEGER, models TEXT);
        CREATE TABLE model_cache_refresh (provider_id TEXT PRIMARY KEY, authoritative INTEGER);
        CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, data TEXT);
        INSERT INTO model_cache VALUES
          ('openai-codex:0.159.0', 1, '["auto","research"]'),
          ('openai-codex:0.159.0:gateway', 0, '["unverified"]'),
          ('openai-codex', 0, '["legacy"]'),
          ('anthropic', 1, '["claude"]');
        INSERT INTO model_cache_refresh VALUES ('openai-codex:0.159.0', 1), ('anthropic', 1);
        INSERT INTO auth_credentials VALUES (1, '{"access":"synthetic"}');
      `);
      migrateCodexCatalogCache(database);
      expect(
        database
          .prepare("SELECT * FROM model_cache WHERE provider_id = ?")
          .get("openai-codex:0.159.0"),
      ).toBeUndefined();
      expect(
        database
          .prepare("SELECT * FROM model_cache WHERE provider_id = ?")
          .get("openai-codex:0.159.0:gateway"),
      ).toBeUndefined();
      expect(
        database.prepare("SELECT * FROM model_cache WHERE provider_id = ?").get("openai-codex"),
      ).toBeUndefined();
      expect(
        database
          .prepare("SELECT * FROM model_cache_refresh WHERE provider_id = ?")
          .get("openai-codex:0.159.0"),
      ).toBeUndefined();
      expect(
        database.prepare("SELECT * FROM model_cache WHERE provider_id = ?").get("anthropic"),
      ).toEqual({ provider_id: "anthropic", authoritative: 1, models: '["claude"]' });
      expect(
        database
          .prepare("SELECT * FROM model_cache_refresh WHERE provider_id = ?")
          .get("anthropic"),
      ).toEqual({ provider_id: "anthropic", authoritative: 1 });
      expect(database.prepare("SELECT * FROM auth_credentials").get()).toEqual({
        id: 1,
        data: '{"access":"synthetic"}',
      });
    } finally {
      database.close();
    }
  });

  test("invalidates poisoned Codex caches written under the prior v1 migration", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE omp_desktop_catalog_migrations (id TEXT PRIMARY KEY);
        CREATE TABLE model_cache (provider_id TEXT PRIMARY KEY, authoritative INTEGER, models TEXT);
        CREATE TABLE model_cache_refresh (provider_id TEXT PRIMARY KEY, authoritative INTEGER);
        INSERT INTO omp_desktop_catalog_migrations VALUES ('codex-discovery-protocol-v1');
        INSERT INTO model_cache VALUES
          ('openai-codex:0.169.1', 1, '[{"id":"research"},{"id":"gpt-6.2-astra-wm"}]'),
          ('anthropic', 1, '["claude"]');
        INSERT INTO model_cache_refresh VALUES ('openai-codex:0.169.1', 1), ('anthropic', 1);
      `);
      migrateCodexCatalogCache(database);
      expect(
        database
          .prepare("SELECT * FROM model_cache WHERE provider_id = ?")
          .get("openai-codex:0.169.1"),
      ).toBeUndefined();
      expect(
        database
          .prepare("SELECT * FROM model_cache_refresh WHERE provider_id = ?")
          .get("openai-codex:0.169.1"),
      ).toBeUndefined();
      expect(
        database.prepare("SELECT * FROM model_cache WHERE provider_id = ?").get("anthropic"),
      ).toEqual({ provider_id: "anthropic", authoritative: 1, models: '["claude"]' });
    } finally {
      database.close();
    }
  });

  test("preserves a post-migration trusted catalog on subsequent launches", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("CREATE TABLE model_cache (provider_id TEXT PRIMARY KEY, models TEXT)");
      migrateCodexCatalogCache(database);
      database.exec(
        "INSERT INTO model_cache VALUES ('openai-codex:0.159.0', '[\"future-codex-model\"]')",
      );
      migrateCodexCatalogCache(database);
      expect(
        database
          .prepare("SELECT models FROM model_cache WHERE provider_id = ?")
          .get("openai-codex:0.159.0"),
      ).toEqual({ models: '["future-codex-model"]' });
    } finally {
      database.close();
    }
  });
});
