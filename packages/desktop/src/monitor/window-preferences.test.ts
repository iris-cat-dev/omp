import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureMonitorBoard,
  configureMonitorPreferences,
  cleanMonitorOrbName,
  duplicateMonitorOrbName,
  effectiveMonitorRedline,
  effectiveMonitorTitleTheme,
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

  it("keeps native metric redlines independent and validates and rounds the selected range", () => {
    const initial = { ...DEFAULT_MONITOR_PREFERENCES };
    expect(initial).toMatchObject({
      metric: "output",
      liveUnit: "tokens",
      orbUnit: "tokens",
      redline: 2000,
      redlineOutput: 2000,
      redlineTotal: 2_000_000,
      celebratePeaks: true,
      responsePulses: true,
      showOrbs: true,
    });
    const output = configureMonitorPreferences({ redline: 175 }, initial);
    expect(output.redline).toBe(200);
    const total = configureMonitorPreferences({ metric: "total" }, output);
    expect(total.redline).toBe(2_000_000);
    const edited = configureMonitorPreferences({ redline: 236_789 }, total);
    expect(edited).toMatchObject({ redline: 240_000, redlineOutput: 200, redlineTotal: 240_000 });
    expect(configureMonitorPreferences({ metric: "output" }, edited).redline).toBe(200);
    expect(initial).toEqual(DEFAULT_MONITOR_PREFERENCES);
    for (const patch of [
      { metric: "combined" },
      { metric: "total", redline: 2000 },
      { metric: "output", redline: 20_000 },
      { redlineTotal: 19_999 },
      { redlineTotal: 2_000_001 },
      { redlineOutput: Infinity },
      { liveUnit: "both" },
      { orbUnit: "money" },
      { celebratePeaks: 1 },
      { responsePulses: null },
      { showOrbs: "yes" },
    ])
      expect(() => configureMonitorPreferences(patch, initial)).toThrow();
  });

  it("normalizes global settings on reload while preserving each orb's unit, style, title and eye", async () => {
    const file = await fixture();
    const first = orb(),
      second = {
        ...orb(),
        id: "second",
        preferences: configureMonitorPreferences(
          {
            style: "needle",
            orbTitleTheme: "space",
            orbUnit: "cost",
            nameMode: "never",
            metric: "total",
          },
          { ...DEFAULT_MONITOR_PREFERENCES },
        ),
        visible: true,
      };
    first.preferences = configureMonitorPreferences(
      {
        metric: "total",
        redline: 48_500,
        liveUnit: "cost",
        showOrbs: false,
        responsePulses: false,
        celebratePeaks: false,
        nameMode: "always",
      },
      first.preferences,
    );
    await writeMonitorPreferences(file, [first, second], false, [board()]);
    const loaded = await readMonitorPreferences(file);
    expect(loaded.invalid).toBe(false);
    expect(loaded.orbs[1]!.preferences).toMatchObject({
      metric: "total",
      redline: 49_000,
      redlineTotal: 49_000,
      liveUnit: "cost",
      showOrbs: false,
      responsePulses: false,
      celebratePeaks: false,
      nameMode: "always",
      style: "needle",
      titleTheme: "vehicles",
      orbTitleTheme: "space",
      orbUnit: "cost",
    });
    expect(loaded.orbs.map((entry) => entry.visible)).toEqual([false, true]);
    expect(loaded.orbs[0]!.positions).toEqual(first.positions);
    expect(loaded.boards).toEqual([board()]);
    await writeMonitorPreferences(file, loaded.orbs, false, loaded.boards);
    expect(await readMonitorPreferences(file)).toEqual(loaded);
  });

  it("rejects an invalid per-orb metric redline before applying cross-orb global normalization", async () => {
    const file = await fixture();
    const invalid = {
      ...orb(),
      id: "second-orb",
      preferences: { ...DEFAULT_MONITOR_PREFERENCES, metric: "total" },
    };
    await writeFile(file, JSON.stringify({ version: 2, orbs: [orb(), invalid], boards: [] }));
    expect(await readMonitorPreferences(file)).toEqual({ orbs: [], boards: [], invalid: true });
  });

  it("accepts only an existing custom title ID and safely drops an unavailable saved reference without losing layout", async () => {
    const file = await fixture();
    const id = "custom:12345678-1234-4234-8234-123456789abc";
    const available = new Set([id]);
    const record = orb();
    record.preferences = configureMonitorPreferences(
      { titleTheme: id },
      record.preferences,
      available,
    );
    expect(record.preferences.titleTheme).toBe(id);
    for (const titleTheme of [id, "vehicle", "custom:../../external", "custom:not-a-uuid"])
      expect(() =>
        configureMonitorPreferences({ titleTheme }, { ...DEFAULT_MONITOR_PREFERENCES }),
      ).toThrow();
    await writeMonitorPreferences(file, [record], false, [board()]);
    const existing = await readMonitorPreferences(file, available);
    expect(existing.orbs).toEqual([record]);
    const missing = await readMonitorPreferences(file);
    expect(missing.invalid).toBe(false);
    expect(missing.orbs[0]).toEqual({
      ...record,
      preferences: { ...record.preferences, titleTheme: "vehicles" },
    });
    expect(missing.boards).toEqual([board()]);
    expect(await readFile(file, "utf8")).toContain(id);
  });

  it("reads old output redlines and leaves newly introduced global controls at visible native defaults", async () => {
    const file = await fixture();
    const old = {
      appearance: "dark",
      effects: "standard",
      language: "en",
      redline: 350,
      style: "led",
      titleTheme: "vehicles",
      size: 148,
      opacity: 1,
      pinned: true,
      clickThrough: false,
      fadeWhenIdle: false,
      nameMode: "auto",
      showPerformance: false,
      showThinking: true,
    };
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        orbs: [{ ...orb(), preferences: old }],
        boards: [],
      }),
    );
    const loaded = await readMonitorPreferences(file);
    expect(loaded.invalid).toBe(false);
    expect(loaded.orbs[0]!.preferences).toMatchObject({
      redline: 350,
      redlineOutput: 350,
      redlineTotal: 2_000_000,
      metric: "output",
      liveUnit: "tokens",
      orbUnit: "tokens",
      showOrbs: true,
      responsePulses: true,
      celebratePeaks: true,
    });
  });

  it("keeps per-orb name overrides independent of the global mode and validates the native tri-state", async () => {
    const file = await fixture();
    const first = orb();
    first.preferences = configureMonitorPreferences(
      { nameMode: "never", showName: "on" },
      first.preferences,
    );
    const second = {
      ...orb(),
      id: "second-orb",
      preferences: configureMonitorPreferences(
        { showName: "off" },
        { ...DEFAULT_MONITOR_PREFERENCES },
      ),
    };
    await writeMonitorPreferences(file, [first, second], false, []);
    const loaded = await readMonitorPreferences(file);
    expect(loaded.orbs.map((entry) => entry.preferences.nameMode)).toEqual(["never", "never"]);
    expect(loaded.orbs.map((entry) => entry.preferences.showName)).toEqual(["on", "off"]);
    const inherited = configureMonitorPreferences(
      { showName: "auto" },
      loaded.orbs[0]!.preferences,
    );
    expect(inherited).toMatchObject({ showName: "auto", nameMode: "never" });
    expect(DEFAULT_MONITOR_PREFERENCES.showName).toBe("auto");
    for (const showName of [true, false, null, "always", "never", "inherited"])
      expect(() => configureMonitorPreferences({ showName }, inherited)).toThrow();
  });

  it("normalizes native custom names and duplicates without splitting emoji graphemes", () => {
    expect(cleanMonitorOrbName("  A\tB\n C  ")).toBe("A B  C");
    expect(cleanMonitorOrbName("\u0000\t \n")).toBeNull();
    expect(cleanMonitorOrbName(null)).toBeNull();
    expect(cleanMonitorOrbName("👩‍💻".repeat(40))).toBe("👩‍💻".repeat(32));
    expect(duplicateMonitorOrbName("👩‍💻".repeat(40))).toBe("👩‍💻".repeat(30) + " 2");
    expect(duplicateMonitorOrbName(null)).toBeNull();
    expect(
      configureMonitorPreferences({ orbName: "" }, { ...DEFAULT_MONITOR_PREFERENCES }).orbName,
    ).toBeNull();
    expect(() =>
      configureMonitorPreferences({ orbName: 123 }, { ...DEFAULT_MONITOR_PREFERENCES }),
    ).toThrow();
  });

  it("rounds independent nullable orb redlines without changing General values or the inactive metric", () => {
    const customized = configureMonitorPreferences(
      {
        redline: 350,
        orbRedlineOutput: 175,
        orbRedlineTotal: 236_789,
      },
      { ...DEFAULT_MONITOR_PREFERENCES },
    );
    expect(customized).toMatchObject({
      redline: 350,
      redlineOutput: 350,
      redlineTotal: 2_000_000,
      orbRedlineOutput: 200,
      orbRedlineTotal: 240_000,
    });
    expect(effectiveMonitorRedline(customized)).toBe(200);
    const total = configureMonitorPreferences({ metric: "total", redline: 500_000 }, customized);
    expect(total.redline).toBe(500_000);
    expect(effectiveMonitorRedline(total)).toBe(240_000);
    const inherited = configureMonitorPreferences({ orbRedlineTotal: null }, total);
    expect(effectiveMonitorRedline(inherited)).toBe(500_000);
    expect(
      effectiveMonitorRedline(configureMonitorPreferences({ metric: "output" }, inherited)),
    ).toBe(200);
    for (const patch of [
      { orbRedlineOutput: 0 },
      { orbRedlineOutput: NaN },
      { orbRedlineOutput: 2001 },
      { orbRedlineTotal: 19_999 },
      { orbRedlineTotal: 2_000_001 },
      { orbRedlineTotal: "global" },
      { orbRedlineOutput: false },
    ])
      expect(() => configureMonitorPreferences(patch, customized)).toThrow();
  });

  it("persists independent names and override slots while normalizing only genuine global fields", async () => {
    const file = await fixture();
    const first = orb();
    first.preferences = configureMonitorPreferences(
      {
        orbName: " First ",
        orbRedlineOutput: 200,
        orbRedlineTotal: 240_000,
        metric: "total",
        redline: 500_000,
      },
      first.preferences,
    );
    const second = {
      ...orb(),
      id: "second-orb",
      preferences: configureMonitorPreferences(
        {
          orbName: "Second",
          orbRedlineOutput: 450,
          orbRedlineTotal: null,
        },
        { ...DEFAULT_MONITOR_PREFERENCES },
      ),
    };
    await writeMonitorPreferences(file, [first, second], false, []);
    const loaded = await readMonitorPreferences(file);
    expect(loaded.invalid).toBe(false);
    expect(loaded.orbs.map((entry) => entry.preferences.orbName)).toEqual(["First", "Second"]);
    expect(loaded.orbs.map((entry) => entry.preferences.orbRedlineOutput)).toEqual([200, 450]);
    expect(loaded.orbs.map((entry) => entry.preferences.orbRedlineTotal)).toEqual([240_000, null]);
    expect(loaded.orbs.map((entry) => entry.preferences.redline)).toEqual([500_000, 500_000]);
    expect(loaded.orbs.map((entry) => effectiveMonitorRedline(entry.preferences))).toEqual([
      240_000, 500_000,
    ]);
  });

  it("keeps General title selection global and validates nullable independent overrides", async () => {
    const file = await fixture();
    const first = orb();
    first.preferences = configureMonitorPreferences({ titleTheme: "animals" }, first.preferences);
    const second = {
      ...orb(),
      id: "second-orb",
      preferences: configureMonitorPreferences(
        { orbTitleTheme: "space" },
        { ...DEFAULT_MONITOR_PREFERENCES },
      ),
    };
    await writeMonitorPreferences(file, [first, second], false, []);
    const loaded = await readMonitorPreferences(file);
    expect(loaded.orbs.map((entry) => entry.preferences.titleTheme)).toEqual([
      "animals",
      "animals",
    ]);
    expect(loaded.orbs.map((entry) => entry.preferences.orbTitleTheme)).toEqual([null, "space"]);
    expect(loaded.orbs.map((entry) => effectiveMonitorTitleTheme(entry.preferences))).toEqual([
      "animals",
      "space",
    ]);
    const inherited = configureMonitorPreferences(
      { orbTitleTheme: null },
      loaded.orbs[1]!.preferences,
    );
    expect(effectiveMonitorTitleTheme(inherited)).toBe("animals");
    for (const orbTitleTheme of [
      "general",
      "null",
      "",
      "vehicle",
      "custom:../../file",
      "custom:12345678-1234-4234-8234-123456789abc",
    ])
      expect(() => configureMonitorPreferences({ orbTitleTheme }, inherited)).toThrow();
    expect(() => configureMonitorPreferences({ titleTheme: null }, inherited)).toThrow();
  });

  it("migrates previous independent title selections into explicit overrides without rewriting original evidence", async () => {
    const file = await fixture();
    const old = Object.fromEntries(
      Object.entries(orb().preferences).filter(([key]) => key !== "orbTitleTheme"),
    );
    const content = JSON.stringify({
      version: 2,
      boards: [],
      orbs: [
        { ...orb(), preferences: { ...old, titleTheme: "animals" } },
        { ...orb(), id: "second-orb", preferences: { ...old, titleTheme: "space" } },
      ],
    });
    await writeFile(file, content);
    const loaded = await readMonitorPreferences(file);
    expect(loaded.invalid).toBe(false);
    expect(loaded.orbs.map((entry) => entry.preferences.titleTheme)).toEqual([
      "animals",
      "animals",
    ]);
    expect(loaded.orbs.map((entry) => entry.preferences.orbTitleTheme)).toEqual([
      "animals",
      "space",
    ]);
    expect(loaded.orbs.map((entry) => effectiveMonitorTitleTheme(entry.preferences))).toEqual([
      "animals",
      "space",
    ]);
    expect(await readFile(file, "utf8")).toBe(content);
    await writeMonitorPreferences(file, loaded.orbs, false, []);
    expect((await readMonitorPreferences(file)).orbs).toEqual(loaded.orbs);
  });
});
