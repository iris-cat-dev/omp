import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createPluginClientTrustStore } from "./client-trust-store.js";

let profile: string;
beforeEach(async () => { profile = await mkdtemp(path.join(tmpdir(), "omp-client-trust-")); });
afterEach(async () => { await rm(profile, { recursive: true, force: true }); });

const qq = {
  hostId: "host",
  installationId: "qqbot",
  packageId: "qqbot",
  sourcePath: "/plugins/qqbot",
  capabilities: ["agents.create"],
};
const oldSource = { ...qq, sourcePath: "/old/qqbot" };
const other = { ...qq, installationId: "other" };
const initial = {
  [JSON.stringify([qq.hostId, qq.installationId, qq.packageId, qq.sourcePath])]: { capabilities: qq.capabilities },
  [JSON.stringify([oldSource.hostId, oldSource.installationId, oldSource.packageId, oldSource.sourcePath])]: { capabilities: qq.capabilities },
};

it("imports old approvals once and preserves revocation across concurrent windows and restart", async () => {
  const access = createPluginClientTrustStore(profile);
  const check = { action: "check" as const, ...qq };
  await expect(access({ operation: check })).resolves.toBeNull();
  await expect(access({ operation: check, initial })).resolves.toBe(true);
  await expect(access({ operation: { ...check, capabilities: [...qq.capabilities, "secrets.scoped"] } })).resolves.toBe(false);

  await Promise.all([
    access({ operation: { action: "revoke", hostId: qq.hostId, installationId: qq.installationId } }),
    access({ operation: { action: "approve", ...other }, initial }),
  ]);

  const reopened = createPluginClientTrustStore(profile);
  await expect(reopened({ operation: check, initial })).resolves.toBe(false);
  await expect(reopened({ operation: { ...check, ...oldSource } })).resolves.toBe(false);
  await expect(reopened({ operation: { ...check, ...other } })).resolves.toBe(true);
});
