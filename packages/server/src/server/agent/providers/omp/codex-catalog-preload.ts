import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import {
  createCodexCatalogFetch,
  migrateCodexCatalogCache,
  type CodexCatalogCacheDatabase,
  type CodexCatalogCacheStatement,
} from "./codex-catalog-policy.js";

interface NativeDatabase extends CodexCatalogCacheDatabase {
  filename: string;
  query(sql: string): CodexCatalogCacheStatement;
  prepare(sql: string, params?: unknown): CodexCatalogCacheStatement;
}

// Install before the SDK or CLI captures fetch or reads its model cache.
globalThis.fetch = createCodexCatalogFetch(globalThis.fetch);
const load = createRequire(import.meta.url);
let driver: string;
if (process.versions.bun) {
  driver = "bun:sqlite";
} else {
  const root = process.env.OMP_DESKTOP_SDK_ROOT;
  if (!root) throw new Error("Node catalog policy requires an explicit OMP SDK root");
  const sdkRequire = createRequire(join(root, "package.json"));
  driver = join(
    dirname(sdkRequire.resolve("@oh-my-pi/pi-utils/package.json")),
    "dist",
    "node",
    "sqlite-driver.mjs",
  );
}
const { Database }: { Database: { prototype: NativeDatabase } } = load(driver);
const migratedConnections = new WeakSet<NativeDatabase>();
function migrateBeforeCacheStatement(database: NativeDatabase, sql: string): void {
  if (
    !sql.includes("model_cache") ||
    basename(database.filename) !== "models.db" ||
    migratedConnections.has(database)
  ) {
    return;
  }
  // Use the kernel's actual connection, after its profile/XDG selection, before any cache read.
  // Mark first to avoid recursion through Bun's prepare/query aliases during migration.
  migratedConnections.add(database);
  try {
    migrateCodexCatalogCache(database);
  } catch (error) {
    migratedConnections.delete(database);
    throw error;
  }
}
const nativeQuery = Database.prototype.query;
Database.prototype.query = function (sql) {
  migrateBeforeCacheStatement(this, sql);
  return nativeQuery.call(this, sql);
};
const nativePrepare = Database.prototype.prepare;
Database.prototype.prepare = function (sql, params) {
  migrateBeforeCacheStatement(this, sql);
  return nativePrepare.call(this, sql, params);
};
