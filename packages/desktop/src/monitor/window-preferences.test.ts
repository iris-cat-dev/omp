import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureMonitorPreferences,
  DEFAULT_MONITOR_PREFERENCES,
  readMonitorPreferences,
  writeMonitorPreferences,
} from "./window-preferences.js";
import type { MonitorOrbRecord } from "./window-preferences.js";

const directories: string[] = [];
async function fixture(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "omp-orb-preferences-"));
  directories.push(directory);
  return path.join(directory, "windows.json");
}
afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.length = 0;
});
function orb(): MonitorOrbRecord {
  return {
    id: "fixture-orb",
    scope: { profile: "work", project: null },
    preferences: { ...DEFAULT_MONITOR_PREFERENCES, style: "minimal", size: 72, clickThrough: true },
    visible: false,
    positions: { "display-A": { x: -1200, y: 160 } },
  };
}

describe("native orb preferences", () => {
  it("retains independent layout and interaction preferences across an atomic save and reload", async () => {
    const file = await fixture();
    await writeMonitorPreferences(file, [orb()], false);
    const restored = await readMonitorPreferences(file);
    expect(restored.invalid).toBe(false);
    expect(restored.orbs).toEqual([orb()]);
    expect(await readdir(path.dirname(file))).toEqual(["windows.json"]);
  });

  it("preserves corrupt settings as evidence before replacing them, rather than silently deleting the original", async () => {
    const file = await fixture();
    await writeFile(file, "broken-original-preferences", "utf8");
    expect(await readMonitorPreferences(file)).toEqual({ orbs: [], invalid: true });
    await writeMonitorPreferences(file, [orb()], true);
    const names = await readdir(path.dirname(file));
    const evidence = names.find((name) => name.startsWith("windows.json.invalid-"))!;
    expect(await readFile(path.join(path.dirname(file), evidence), "utf8")).toBe(
      "broken-original-preferences",
    );
    expect((await readMonitorPreferences(file)).orbs[0]).toEqual(orb());
  });

  it("rejects oversized or identity-ambiguous preference files without loading any orb", async () => {
    const file = await fixture();
    await writeFile(file, " ".repeat(128 * 1024 + 1), "utf8");
    expect(await readMonitorPreferences(file)).toEqual({ orbs: [], invalid: true });
    await writeFile(file, JSON.stringify({ version: 1, orbs: [orb(), orb()] }), "utf8");
    expect(await readMonitorPreferences(file)).toEqual({ orbs: [], invalid: true });
  });

  it("rejects prototype and non-finite input while clamping a minimal orb back into another style's valid range", () => {
    expect(() =>
      configureMonitorPreferences(JSON.parse('{"__proto__":{"pinned":false}}'), {
        ...DEFAULT_MONITOR_PREFERENCES,
      }),
    ).toThrow();
    expect(() =>
      configureMonitorPreferences({ size: NaN }, { ...DEFAULT_MONITOR_PREFERENCES }),
    ).toThrow();
    const minimal = configureMonitorPreferences(
      { style: "minimal", size: 72 },
      { ...DEFAULT_MONITOR_PREFERENCES },
    );
    expect(configureMonitorPreferences({ style: "needle" }, minimal).size).toBe(96);
    expect(minimal.size).toBe(72);
  });
});
