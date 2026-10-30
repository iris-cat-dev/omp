import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureMonitorBoard,
  configureMonitorPreferences,
  DEFAULT_MONITOR_PREFERENCES,
  readMonitorPreferences,
  writeMonitorPreferences,
} from "./window-preferences.js";
import type { MonitorOrbRecord } from "./window-preferences.js";
import { DEFAULT_BOARD_PREFERENCES } from "./board-types.js";
import type { OmpMonitorBoardRecord } from "./board-types.js";

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
function board(): OmpMonitorBoardRecord {
  return {
    ...DEFAULT_BOARD_PREFERENCES,
    id: "fixture-board",
    orbId: "fixture-orb",
    style: "timing",
    showCost: false,
    pinned: false,
    visible: true,
    positions: { "display-A": { x: -900, y: 200 } },
  };
}

describe("native orb preferences", () => {
  it("retains independent layout and interaction preferences across an atomic save and reload", async () => {
    const file = await fixture();
    await writeMonitorPreferences(file, [orb()], false, [board()]);
    const restored = await readMonitorPreferences(file);
    expect(restored.invalid).toBe(false);
    expect(restored.orbs).toEqual([orb()]);
    expect(restored.boards).toEqual([board()]);
    expect(await readdir(path.dirname(file))).toEqual(["windows.json"]);
  });

  it("preserves corrupt settings as evidence before replacing them, rather than silently deleting the original", async () => {
    const file = await fixture();
    await writeFile(file, "broken-original-preferences", "utf8");
    expect(await readMonitorPreferences(file)).toEqual({ orbs: [], boards: [], invalid: true });
    await writeMonitorPreferences(file, [orb()], true, []);
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
    expect(await readMonitorPreferences(file)).toEqual({ orbs: [], boards: [], invalid: true });
    await writeFile(file, JSON.stringify({ version: 1, orbs: [orb(), orb()] }), "utf8");
    expect(await readMonitorPreferences(file)).toEqual({ orbs: [], boards: [], invalid: true });
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

  it("migrates old orb settings with independent score/thinking defaults and no invented board", async () => {
    const file = await fixture();
    const preferences = Object.fromEntries(
      Object.entries(orb().preferences).filter(
        ([key]) => key !== "showPerformance" && key !== "showThinking",
      ),
    );
    await writeFile(
      file,
      JSON.stringify({ version: 1, orbs: [{ ...orb(), preferences }] }),
      "utf8",
    );
    expect(await readMonitorPreferences(file)).toEqual({
      orbs: [orb()],
      boards: [],
      invalid: false,
    });
  });

  it("reads legacy score switches without rewriting the evidence file and saves only performance keys", async () => {
    const file = await fixture();
    const preferences = Object.fromEntries(
      Object.entries(orb().preferences).filter(([key]) => key !== "showPerformance"),
    );
    const legacyBoard = Object.fromEntries(
      Object.entries(board()).filter(([key]) => key !== "showPerformance"),
    );
    const source = JSON.stringify({
      version: 2,
      orbs: [{ ...orb(), preferences: { ...preferences, showTaskScore: true } }],
      boards: [{ ...legacyBoard, showTaskScore: false }],
    });
    await writeFile(file, source, "utf8");
    const restored = await readMonitorPreferences(file);
    expect(restored.invalid).toBe(false);
    expect(restored.orbs[0]!.preferences.showPerformance).toBe(true);
    expect(restored.boards[0]!.showPerformance).toBe(false);
    expect(restored.orbs[0]!.preferences).not.toHaveProperty("showTaskScore");
    expect(restored.boards[0]).not.toHaveProperty("showTaskScore");
    expect(await readFile(file, "utf8")).toBe(source);
    await writeMonitorPreferences(file, restored.orbs, false, restored.boards);
    const saved = await readFile(file, "utf8");
    expect(saved).toContain('"showPerformance"');
    expect(saved).not.toContain('"showTaskScore"');
  });

  it("honors a saved performance key over the retired switch and rejects the retired key in live edits", async () => {
    const file = await fixture();
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        orbs: [
          {
            ...orb(),
            preferences: { ...orb().preferences, showPerformance: false, showTaskScore: true },
          },
        ],
        boards: [{ ...board(), showPerformance: true, showTaskScore: false }],
      }),
      "utf8",
    );
    const restored = await readMonitorPreferences(file);
    expect(restored.orbs[0]!.preferences.showPerformance).toBe(false);
    expect(restored.boards[0]!.showPerformance).toBe(true);
    expect(() =>
      configureMonitorPreferences({ showTaskScore: true }, { ...DEFAULT_MONITOR_PREFERENCES }),
    ).toThrow();
    expect(() =>
      configureMonitorBoard({ showTaskScore: false }, DEFAULT_BOARD_PREFERENCES),
    ).toThrow();
  });

  it("restores four independent boards but rejects excess, duplicate and orphaned boards", async () => {
    const file = await fixture();
    const boards = Array.from({ length: 4 }, (_, index) => ({ ...board(), id: `board-${index}` }));
    await writeMonitorPreferences(file, [orb()], false, boards);
    expect((await readMonitorPreferences(file)).boards).toEqual(boards);
    for (const invalid of [
      [...boards, { ...board(), id: "board-4" }],
      [board(), board()],
      [{ ...board(), orbId: "removed-orb" }],
    ]) {
      await writeFile(file, JSON.stringify({ version: 2, orbs: [orb()], boards: invalid }), "utf8");
      expect(await readMonitorPreferences(file)).toEqual({ orbs: [], boards: [], invalid: true });
    }
  });

  it("validates board edits without changing unrelated orb preferences", () => {
    const current = { ...DEFAULT_BOARD_PREFERENCES };
    expect(
      configureMonitorBoard({ style: "neon", showPerformance: false, clickThrough: true }, current),
    ).toEqual({
      ...current,
      style: "neon",
      showPerformance: false,
      clickThrough: true,
    });
    expect(current).toEqual(DEFAULT_BOARD_PREFERENCES);
    for (const patch of [
      { size: "giant" },
      { pinned: 1 },
      { showThinking: null },
      { visible: false },
      JSON.parse('{"__proto__":{"pinned":false}}'),
    ]) {
      expect(() => configureMonitorBoard(patch, current)).toThrow();
    }
  });
});
