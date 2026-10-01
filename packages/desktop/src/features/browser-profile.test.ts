import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { clearRetiredBrowserProfiles } from "./browser-profile.js";

class FakeSession {
  public clears: string[] = [];

  public constructor(private readonly storagePath: string) {}

  public getStoragePath(): string {
    return this.storagePath;
  }

  public async clearStorageData(): Promise<void> {
    this.clears.push("storage");
  }

  public async clearCache(): Promise<void> {
    this.clears.push("cache");
  }

  public async clearAuthCache(): Promise<void> {
    this.clears.push("auth");
  }
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("retired browser profiles", () => {
  test("clears only the dedicated shared and verified legacy partitions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omp-retired-profiles-"));
    tempDirs.push(root);
    const parent = path.join(root, "Partitions");
    const sharedPath = path.join(parent, "omp-desktop-browser");
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const legacyPath = `${sharedPath}-${id}`;
    const unrelatedPath = path.join(parent, "main-window");
    const invalidPath = `${sharedPath}-unexpected`;
    await Promise.all(
      [sharedPath, legacyPath, unrelatedPath, invalidPath].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );
    const profiles: Record<string, FakeSession> = {
      "persist:omp-desktop-browser": new FakeSession(sharedPath),
      [`persist:omp-desktop-browser-${id}`]: new FakeSession(legacyPath),
      "": new FakeSession(unrelatedPath),
    };
    const requested: string[] = [];
    const errors: unknown[] = [];

    await clearRetiredBrowserProfiles(
      {
        fromPartition(partition) {
          requested.push(partition);
          const profile = profiles[partition];
          if (!profile) throw new Error(`Unexpected partition: ${partition}`);
          return profile;
        },
      },
      (_partition, error) => errors.push(error),
    );

    expect(requested).toEqual(["persist:omp-desktop-browser", `persist:omp-desktop-browser-${id}`]);
    expect(profiles["persist:omp-desktop-browser"].clears).toEqual(["storage", "cache", "auth"]);
    expect(profiles[`persist:omp-desktop-browser-${id}`].clears).toEqual([
      "storage",
      "cache",
      "auth",
    ]);
    expect(profiles[""].clears).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("does not clear a legacy profile when Electron resolves a different storage location", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omp-retired-profiles-"));
    tempDirs.push(root);
    const sharedPath = path.join(root, "Partitions", "omp-desktop-browser");
    const id = "1700000000000-abcd";
    await mkdir(`${sharedPath}-${id}`, { recursive: true });
    const shared = new FakeSession(sharedPath);
    const mismatched = new FakeSession(path.join(root, "different-profile"));

    await clearRetiredBrowserProfiles(
      {
        fromPartition: (partition) =>
          partition === "persist:omp-desktop-browser" ? shared : mismatched,
      },
      () => {},
    );

    expect(shared.clears).toEqual(["storage", "cache", "auth"]);
    expect(mismatched.clears).toEqual([]);
  });
});
