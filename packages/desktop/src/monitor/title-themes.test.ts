import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fitTitleText,
  isColorTitleEmoji,
  isCustomTitleThemeId,
  isTitleThemeId,
  normalizeTitleThemeReferences,
  OmpTitleThemesStore,
  parseTitleThemeCommand,
  readTitleThemesDocument,
  resolveSelectedTitleTheme,
  sanitizeTitleText,
  MAX_CUSTOM_TITLE_THEMES,
  TITLE_PRESET_IDS,
  TITLE_PRESET_NAMES,
  uniqueTitleThemeName,
  TITLE_THEMES_FILE_NAME,
} from "./title-themes.js";
import type {
  OmpCustomTitleTheme,
  OmpTitlePresetId,
  OmpTitlePresetText,
  OmpTitleThemeCommand,
  OmpTitleThemeReference,
  OmpTitleThemesState,
  OmpTitleThemesStoreOptions,
} from "./title-themes.js";

const firstId = "custom:11111111-1111-4111-8111-111111111111";
const secondId = "custom:22222222-2222-4222-8222-222222222222";
const presetText = Object.fromEntries(
  TITLE_PRESET_IDS.map((id) => [
    id,
    {
      name: TITLE_PRESET_NAMES[id],
      en: Array.from({ length: 14 }, (_, level) => `${id} EN ${level}`),
      zh: Array.from({ length: 14 }, (_, level) => `${id} 中 ${level}`),
    },
  ]),
) as Record<OmpTitlePresetId, OmpTitlePresetText>;
function customSet(patch: Partial<OmpCustomTitleTheme> = {}): OmpCustomTitleTheme {
  return {
    id: firstId,
    name: "My titles",
    base: "vehicles",
    idle: "",
    titles: Array<string>(13).fill(""),
    ...patch,
  };
}
function stateWith(set: OmpCustomTitleTheme): OmpTitleThemesState {
  return { version: 1, revision: 1, custom: [set], draft: null, undo: null, error: false };
}

describe("canonical custom title text rules", () => {
  it.each([
    ["  結丹  ", "結丹"],
    ["Red\tGiant", "Red Giant"],
    ["Red\r\n\r\nGiant", "Red Giant"],
    ["a\t\n\v\f\r\u0085b", "a b"],
    ["大\u3000魔\u00A0導師", "大 魔 導師"],
    ["a   b", "a b"],
    ["a\u2028b\u2029c", "abc"],
    ["\u202Eevil\u202C\u2066x\u2069", "evilx"],
    ["bell\u0007\u0000", "bell"],
    ["★ 傳奇 ✦ ∞", "★ 傳奇 ✦ ∞"],
    ["cafe\u0301", "café"],
  ])("normalizes %j to %j without treating text symbols as color emoji", (input, expected) => {
    expect(sanitizeTitleText(input)).toEqual({ text: expected, removedEmoji: false });
  });

  it.each([
    ["火箭🚀", "火箭"],
    ["🔥 狂飆 🔥", "狂飆"],
    ["❤️ love", "love"],
    ["1️⃣ first", "first"],
    ["👨‍👩‍👧 family", "family"],
    ["🇹🇼 台灣", "台灣"],
    ["👍🏽 ok", "ok"],
  ])("removes native color-emoji graphemes from %j", (input, expected) => {
    expect(sanitizeTitleText(input)).toEqual({ text: expected, removedEmoji: true });
  });

  it.each(["★", "✦", "∞", "☆", "#", "1", "©"])("retains the text symbol %s", (symbol) => {
    expect(isColorTitleEmoji(symbol)).toBe(false);
  });

  it("counts whole graphemes rather than UTF-16 units and uses a separate 32-grapheme name limit", () => {
    expect(sanitizeTitleText("e\u0301".repeat(30)).text).toBe("é".repeat(24));
    expect(sanitizeTitleText("가".repeat(30)).text).toBe("가".repeat(24));
    expect(sanitizeTitleText("name".repeat(10), 32).text).toHaveLength(32);
    expect(sanitizeTitleText("abcdef", 3).text).toBe("abc");
    expect(sanitizeTitleText("a\uD800b").text).toBe("a\uFFFDb");
  });

  it("fits the longest whole-grapheme prefix with the original 51.5-DIP budget", () => {
    const measured = (text: string) =>
      Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)).length *
      7;
    expect(fitTitleText("凡人", measured)).toEqual({ text: "凡人", cut: false });
    expect(fitTitleText("一二三四五六七八九", measured)).toEqual({
      text: "一二三四五六七",
      cut: true,
    });
    expect(fitTitleText("ab cd", measured, 21)).toEqual({ text: "ab", cut: true });
    expect(fitTitleText("e\u0301e\u0301e\u0301", measured, 14)).toEqual({
      text: "e\u0301e\u0301",
      cut: true,
    });
    expect(fitTitleText("abc", measured, 1)).toEqual({ text: "", cut: true });
    const invalidMeasurement = () => Number.NaN;
    expect(() => fitTitleText("abc", invalidMeasurement)).toThrow("Invalid title measurement");
    expect(fitTitleText("", invalidMeasurement)).toEqual({ text: "", cut: false });
  });
});

describe("bounded custom-title document and command contracts", () => {
  it("retains nine built-ins while accepting only an exact custom UUID namespace", () => {
    expect(TITLE_PRESET_IDS).toEqual([
      "vehicles",
      "animals",
      "wind",
      "space",
      "cultivation",
      "wuxia",
      "mage",
      "gameRank",
      "engineer",
    ]);
    expect(TITLE_PRESET_IDS.every(isTitleThemeId)).toBe(true);
    expect(isCustomTitleThemeId(firstId)).toBe(true);
    expect(isCustomTitleThemeId("custom:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")).toBe(true);
    expect(isCustomTitleThemeId(firstId.toUpperCase())).toBe(false);
    expect(isTitleThemeId("custom:../../windows.json")).toBe(false);
    expect(isTitleThemeId("__proto__")).toBe(false);
  });

  it("normalizes padded 13-field content, skips invalid and duplicate IDs, and whitelist-copies fields", () => {
    const document = readTitleThemesDocument({
      version: 99,
      selected: "animals",
      custom: [
        null,
        { id: "vehicles", name: "invalid preset collision" },
        {
          id: firstId,
          name: "  Name\t🚀 ",
          base: "unknown",
          idle: "\u202E wait ",
          titles: ["A", null, "cafe\u0301"],
          path: "not-exposed",
        },
        { id: firstId, name: "duplicate" },
        { id: secondId, name: "second", base: "animals", titles: Array(20).fill(" kept ") },
      ],
    });
    expect(document).toEqual({
      version: 1,
      custom: [
        {
          id: firstId,
          name: "Name",
          base: "vehicles",
          idle: "wait",
          titles: ["A", "", "café", ...Array(10).fill("")],
        },
        { id: secondId, name: "second", base: "animals", idle: "", titles: Array(13).fill("kept") },
      ],
    });
    expect(JSON.stringify(document)).not.toContain("not-exposed");
  });

  it("keeps at most eight sets and only inspects the native first 64 elements", () => {
    const entries = Array.from({ length: 9 }, (_, index) => ({
      ...customSet(),
      id: `custom:${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    }));
    expect(readTitleThemesDocument({ custom: entries }).custom.map((set) => set.id)).toEqual(
      entries.slice(0, 8).map((set) => set.id),
    );
    expect(
      readTitleThemesDocument({ custom: [...Array(64).fill(null), customSet()] }).custom,
    ).toEqual([]);
    expect(readTitleThemesDocument(null)).toEqual({ version: 1, custom: [] });
  });

  it("uses native case-sensitive unique names and shortens the stem to leave room for the suffix", () => {
    const name = "A".repeat(32);
    expect(uniqueTitleThemeName([customSet({ name })], name)).toBe("A".repeat(30) + " 2");
    expect(
      uniqueTitleThemeName(
        [customSet({ name: "Custom" }), customSet({ id: secondId, name: "Custom 2" })],
        "Custom",
      ),
    ).toBe("Custom 3");
    expect(uniqueTitleThemeName([customSet({ name: "custom" })], "Custom")).toBe("Custom");
  });

  it("accepts only known bounded commands, with no renderer-selected path or arbitrary extra key", () => {
    const boundedText = "x".repeat(4096);
    const commands: OmpTitleThemeCommand[] = [
      { type: "copy", sourceId: "vehicles", language: "zh" },
      { type: "copy", sourceId: firstId, language: "en" },
      { type: "rename", id: firstId, name: boundedText },
      { type: "setBase", id: firstId, base: "mage" },
      { type: "setField", id: firstId, level: 0, text: boundedText, language: "zh" },
      { type: "setField", id: firstId, level: 13, text: "", language: "en" },
      { type: "setDraft", id: firstId, level: 0, text: "" },
      { type: "setDraft", id: firstId, level: 13, text: boundedText },
      { type: "resetAll", id: firstId },
      { type: "delete", id: firstId },
      { type: "undo" },
      { type: "dismissUndo" },
      { type: "clearDraft" },
    ];
    for (const command of commands) {
      expect(parseTitleThemeCommand(command)).toEqual(command);
      expect(parseTitleThemeCommand({ ...command, extra: true })).toBeNull();
    }
    for (const invalid of [
      null,
      [],
      {},
      { type: "copy", sourceId: "vehicles" },
      { type: "copy", sourceId: "vehicles", language: "fr" },
      { type: "copy", sourceId: "unknown", language: "en" },
      { type: "copy", sourceId: "vehicles", language: "en", path: "elsewhere.json" },
      { type: "setField", id: firstId, level: 14, text: "x", language: "en" },
      { type: "setField", id: firstId, level: -1, text: "x", language: "en" },
      { type: "setField", id: firstId, level: 0.5, text: "x", language: "en" },
      { type: "setField", id: firstId, level: NaN, text: "x", language: "en" },
      { type: "setDraft", id: firstId, level: 0, text: "x".repeat(4097) },
      { type: "rename", id: firstId, name: "x".repeat(4097) },
      { type: "setBase", id: firstId, base: "__proto__" },
      { type: "rename", id: "vehicles", name: "cannot rename preset" },
      { type: "undo", extra: true },
      { type: "reorder", ids: [] },
      Object.create({ type: "undo" }),
      Object.assign(Object.create({ id: firstId }), { type: "delete" }),
    ])
      expect(parseTitleThemeCommand(invalid)).toBeNull();
  });

  it("keeps real null follow-General references for exact Undo while bounding and whitelisting main-owned facts", () => {
    const input = [
      { instanceId: "orb-follow", themeId: null, path: "not-exposed" },
      { instanceId: "orb-custom", themeId: firstId },
      { instanceId: "orb-preset", themeId: "animals" },
      { instanceId: "orb-follow", themeId: "vehicles" },
      { instanceId: "orb-invalid", themeId: "null" },
      { instanceId: "../foreign", themeId: null },
      { instanceId: "orb-undefined" },
      { instanceId: "orb-last", themeId: null },
      { instanceId: "orb-ninth", themeId: null },
    ];
    expect(normalizeTitleThemeReferences(input)).toEqual([
      { instanceId: "orb-follow", themeId: null },
      { instanceId: "orb-custom", themeId: firstId },
      { instanceId: "orb-preset", themeId: "animals" },
      { instanceId: "orb-last", themeId: null },
    ]);
    expect(normalizeTitleThemeReferences(null)).toEqual([]);
    expect(input[0]).toEqual({ instanceId: "orb-follow", themeId: null, path: "not-exposed" });
  });
});

describe("selected custom titles resolve consistently on every display surface", () => {
  it("inherits empty fields in the active language, keeps literals, and applies English display case only to labels", () => {
    const titles = Array<string>(13).fill("");
    titles[4] = "My five";
    const source = stateWith(customSet({ idle: "Resting", titles }));
    const english = resolveSelectedTitleTheme(source, firstId, presetText, "en");
    expect(english.base).toBe("vehicles");
    expect(english.showsVehicleArt).toBe(true);
    expect(english.texts[0]).toBe("Resting");
    expect(english.labels[0]).toBe("RESTING");
    expect(english.texts[5]).toBe("My five");
    expect(english.labels[5]).toBe("MY FIVE");
    expect(english.texts[6]).toBe("vehicles EN 6");
    const chinese = resolveSelectedTitleTheme(source, firstId, presetText, "zh");
    expect(chinese.labels[5]).toBe("My five");
    expect(chinese.texts[6]).toBe("vehicles 中 6");
  });

  it("applies only the named draft, supports clearing to the base, and never mutates persisted fields", () => {
    const source = stateWith(customSet({ base: "animals" }));
    source.draft = { id: firstId, level: 13, text: " Draft 🚀 " };
    const theme = resolveSelectedTitleTheme(source, firstId, presetText, "en");
    expect(theme.texts[13]).toBe("Draft");
    expect(theme.labels[13]).toBe("DRAFT");
    expect(theme.showsVehicleArt).toBe(false);
    expect(source.custom[0]!.titles[12]).toBe("");
    source.draft.text = "";
    expect(resolveSelectedTitleTheme(source, firstId, presetText, "zh").texts[13]).toBe(
      "animals 中 13",
    );
    expect(resolveSelectedTitleTheme(source, "wind", presetText, "en").texts[13]).toBe(
      "wind EN 13",
    );
  });

  it("falls back to Vehicles for a missing custom ID and names an unnamed persisted set as a localized custom copy", () => {
    const source = stateWith(customSet({ name: "", base: "mage" }));
    expect(resolveSelectedTitleTheme(source, firstId, presetText, "en").name).toBe(
      "Arcane Ranks (Custom)",
    );
    expect(resolveSelectedTitleTheme(source, firstId, presetText, "zh").name).toBe(
      "魔法位阶（自定义）",
    );
    const missing = resolveSelectedTitleTheme(source, secondId, presetText, "en");
    expect(missing.id).toBe("vehicles");
    expect(missing.custom).toBeNull();
    expect(missing.showsVehicleArt).toBe(true);
  });
});

describe("owned custom-title mutations", () => {
  const roots: string[] = [];
  const stores: OmpTitleThemesStore[] = [];
  afterEach(async () => {
    for (const store of stores.splice(0)) store.dispose();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });
  async function fixture(options: OmpTitleThemesStoreOptions = {}) {
    const root = await mkdtemp(path.join(tmpdir(), "omp-title-themes-"));
    roots.push(root);
    const store = new OmpTitleThemesStore(root, options);
    stores.push(store);
    return { root, store, fileName: path.join(root, TITLE_THEMES_FILE_NAME) };
  }

  it("serializes eight custom copies and rejects the ninth without changing the saved document", async () => {
    const { root, store, fileName } = await fixture();
    const results = await Promise.all(
      Array.from({ length: MAX_CUSTOM_TITLE_THEMES + 1 }, () =>
        store.execute(
          { type: "copy", sourceId: "vehicles", language: "en" },
          { selected: "vehicles" },
        ),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(MAX_CUSTOM_TITLE_THEMES);
    expect(results.filter((result) => !result.ok)).toMatchObject([{ ok: false, error: "limit" }]);
    const saved = readTitleThemesDocument(JSON.parse(await readFile(fileName, "utf8")));
    expect(saved.custom).toEqual(store.state().custom);
    expect(new Set(saved.custom.map((set) => set.id)).size).toBe(MAX_CUSTOM_TITLE_THEMES);
    expect(await readdir(root)).toEqual([TITLE_THEMES_FILE_NAME]);
  });

  it("keeps the dirty draft through invalid measurements and failed saves, then commits the native-width prefix", async () => {
    let invalidMeasurement = true;
    const measurements: string[] = [];
    const { store, fileName } = await fixture({
      measureTitle(text, language) {
        measurements.push(`${language}:${text}`);
        return invalidMeasurement ? Number.NaN : text.length * 7;
      },
    });
    const copied = await store.execute(
      { type: "copy", sourceId: "animals", language: "en" },
      { selected: "animals" },
    );
    const id = copied.state.custom[0]!.id;
    const context = { selected: id };
    const draft = { type: "setDraft", id, level: 1, text: "red giant 🚀" };
    await store.execute(draft, context);
    const command = { type: "setField", id, level: 1, text: draft.text, language: "en" };
    const invalid = await store.execute(command, context);
    expect(invalid).toMatchObject({ ok: false, error: "invalid" });
    expect(invalid.state.draft).toEqual({ id, level: 1, text: "red giant" });
    expect(invalid.state.custom[0]!.titles[0]).toBe("");
    invalidMeasurement = false;
    await rm(fileName);
    await mkdir(fileName);
    const failed = await store.execute(command, context);
    expect(failed).toMatchObject({ ok: false, error: "storage" });
    expect(failed.state.error).toBe(true);
    expect(failed.state.draft).toEqual(invalid.state.draft);
    expect(failed.state.custom).toEqual(invalid.state.custom);
    await rm(fileName, { recursive: true });
    const committed = await store.execute(command, context);
    expect(committed).toMatchObject({
      ok: true,
      commit: { text: "red gia", cut: true, removedEmoji: true },
      state: { draft: null, error: false },
    });
    expect(measurements).toContain("en:RED GIANT");
    const saved = readTitleThemesDocument(JSON.parse(await readFile(fileName, "utf8")));
    expect(saved.custom[0]!.titles[0]).toBe("red gia");
  });

  it("restores the complete delete snapshot including true nullable follow-General references", async () => {
    const { store, fileName } = await fixture();
    const copied = await store.execute(
      { type: "copy", sourceId: "animals", language: "en" },
      { selected: "animals" },
    );
    const id = copied.state.custom[0]!.id;
    const references: OmpTitleThemeReference[] = [
      { instanceId: "orb-follow", themeId: null },
      { instanceId: "orb-custom", themeId: id },
      { instanceId: "orb-preset", themeId: "wind" },
    ];
    const removed = await store.execute({ type: "delete", id }, { selected: id, references });
    expect(removed).toMatchObject({
      ok: true,
      selected: "animals",
      referenceChanges: [{ instanceId: "orb-custom", themeId: "animals" }],
      state: { custom: [], undo: { kind: "delete" } },
    });
    const restored = await store.execute(
      { type: "undo" },
      {
        selected: "animals",
        references: [
          { instanceId: "orb-follow", themeId: null },
          { instanceId: "orb-custom", themeId: "animals" },
          { instanceId: "orb-preset", themeId: "wind" },
        ],
      },
    );
    expect(restored.selected).toBe(id);
    expect(restored.referenceChanges).toEqual(references);
    expect(restored.state.custom).toEqual(copied.state.custom);
    const saved = readTitleThemesDocument(JSON.parse(await readFile(fileName, "utf8")));
    expect(saved.custom).toEqual(copied.state.custom);
  });

  it("resets only overrides, restores them without replaying references, and clears only the requested transient state", async () => {
    const { store } = await fixture();
    const copied = await store.execute(
      { type: "copy", sourceId: "vehicles", language: "en" },
      { selected: "vehicles" },
    );
    const id = copied.state.custom[0]!.id;
    const context = { selected: id, references: [{ instanceId: "orb-follow", themeId: null }] };
    await store.execute({ type: "rename", id, name: "Custom name" }, context);
    await store.execute({ type: "setBase", id, base: "mage" }, context);
    await store.execute({ type: "setField", id, level: 0, text: "Quiet", language: "zh" }, context);
    const before = store.state().custom;
    const reset = await store.execute({ type: "resetAll", id }, context);
    expect(reset.state.custom[0]).toMatchObject({
      name: "Custom name",
      base: "mage",
      idle: "",
      titles: Array<string>(13).fill(""),
    });
    const restored = await store.execute({ type: "undo" }, context);
    expect(restored.referenceChanges).toBeUndefined();
    expect(restored.state.custom).toEqual(before);
    await store.execute({ type: "resetAll", id }, context);
    await store.execute({ type: "setDraft", id, level: 13, text: "Draft" }, context);
    const dismissed = await store.execute({ type: "dismissUndo" }, context);
    expect(dismissed.state.undo).toBeNull();
    expect(dismissed.state.draft).toEqual({ id, level: 13, text: "Draft" });
    const cleared = await store.execute({ type: "clearDraft" }, context);
    expect(cleared.state.draft).toBeNull();
    expect(cleared.state.custom).toEqual(reset.state.custom);
  });

  it("leaves corrupt-file evidence untouched during load, rejected commands and transient-state changes", async () => {
    const { store, fileName } = await fixture();
    const evidence = "{corrupt-title-evidence";
    await writeFile(fileName, evidence, "utf8");
    await store.load();
    expect(store.state()).toMatchObject({ custom: [], error: true });
    const context = { selected: "vehicles" };
    expect(await store.execute({ type: "undo" }, context)).toMatchObject({
      ok: false,
      error: "expired",
    });
    await store.execute({ type: "clearDraft" }, context);
    await store.execute({ type: "dismissUndo" }, context);
    expect(await readFile(fileName, "utf8")).toBe(evidence);
  });
});
