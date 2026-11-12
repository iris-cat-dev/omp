import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tryRunPetCreationCli } from "./creation-cli.js";
import { PetLibrary } from "./library.js";
import { parsePetManifest, validatePetSheet } from "./manifest.js";
import type { PetBubbleProfile, PetBubbleState, PetDescriptor } from "./types.js";

const electron = vi.hoisted(() => ({
  whenReady: vi.fn(async () => undefined),
  exit: vi.fn(),
  convertImage: vi.fn(),
}));


const temporaryDirectories: string[] = [];
const originalArgv = process.argv;

afterEach(async () => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const manifest = {
  version: 1,
  name: "Garden fox",
  spritesheet: "sprites.png",
  frameWidth: 32,
  frameHeight: 32,
  animations: {
    idle: { row: 0, frames: 4, fps: 2 },
    running: { row: 1, frames: 4, fps: 5 },
    needs_input: { row: 2, frames: 4, fps: 2 },
    ready: { row: 3, frames: 4, fps: 3 },
    blocked: { row: 4, frames: 4, fps: 2 },
  },
};

function bubbleProfile(message = "The garden is quiet."): PetBubbleProfile {
  const states: PetBubbleState[] = [
    "idle",
    "offline",
    "running",
    "needs_input",
    "ready",
    "blocked",
    "dragging",
    "petted",
  ];
  return {
    appearance: {
      background: "#123456E0",
      foreground: "#F0F1F2",
      border: "#ABCDEF",
      shape: "speech",
      fontSize: 13,
      fontWeight: "normal",
      padding: 10,
      borderRadius: 14,
      maxWidth: 240,
      animation: "fade",
    },
    states: Object.fromEntries(
      states.map((state) => [
        state,
        { messages: [message], delayMs: 200, durationMs: 3_000, repeatDelayMs: 0 },
      ]),
    ) as PetBubbleProfile["states"],
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "omp-pet-profile-"));
  temporaryDirectories.push(root);
  return root;
}

async function writePackage(directory: string, value: unknown): Promise<string> {
  await mkdir(directory, { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path.join(directory, "pet.json"), content);
  await writeFile(path.join(directory, "sprites.png"), pngHeader(128, 160));
  return content;
}

function petLibrary(root: string): PetLibrary {
  return new PetLibrary({
    builtInDirectory: path.join(root, "built-in"),
    userDataPath: path.join(root, "user-data"),
    skillPath: path.join(root, "skill"),
    executablePath: process.execPath,
    appPath: root,
    packaged: false,
    decodeImage: (data) => ({ width: data.readUInt32BE(16), height: data.readUInt32BE(20), bitmap: Buffer.from([0, 0, 0, 255, 0, 0, 0, 0]), preview: data }),
  });
}

function pngHeader(width: number, height: number): Buffer {
  const data = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

describe("custom pet package boundaries", () => {
  it.each(["../private.png", "/private.png", "subdir/sprites.png", "sprite.svg", "sprite.html"])(
    "rejects traversal and executable spritesheet names: %s",
    (spritesheet) => {
      expect(() => parsePetManifest({ ...manifest, spritesheet })).toThrow("Invalid pet.json");
    },
  );

  it("rejects packages without a needs-input animation rather than inventing one", () => {
    const { needs_input: _unused, ...animations } = manifest.animations;
    expect(() => parsePetManifest({ ...manifest, animations })).toThrow("needs_input");
  });

  it("rejects scripts and unsupported package versions", () => {
    expect(() => parsePetManifest({ ...manifest, script: "run.js" })).toThrow("Invalid pet.json");
    expect(() => parsePetManifest({ ...manifest, version: 2 })).toThrow("version");
  });

  it("rejects a row beyond the actual atlas instead of showing another frame", () => {
    expect(() => validatePetSheet(pngHeader(128, 128), parsePetManifest(manifest))).toThrow(
      "blocked",
    );
  });

  it("rejects frames beyond the atlas width and partial frame tiles", () => {
    expect(() => validatePetSheet(pngHeader(96, 160), parsePetManifest(manifest))).toThrow("idle");
    expect(() => validatePetSheet(pngHeader(127, 160), parsePetManifest(manifest))).toThrow(
      "whole frames",
    );
  });

  it("rejects decompression-sized dimensions before image decoding", () => {
    expect(() => validatePetSheet(pngHeader(65536, 160), parsePetManifest(manifest))).toThrow(
      "4096",
    );
    expect(() => validatePetSheet(Buffer.from("not a PNG"), parsePetManifest(manifest))).toThrow(
      "PNG",
    );
  });
});

describe("pet-owned bubble profiles", () => {
  it("keeps independent complete profiles and trims plain-text messages", () => {
    const garden = bubbleProfile("  The garden is quiet.  ");
    garden.states.running.repeatDelayMs = 1_000;
    const comet = bubbleProfile("Let's reach the next star!");
    comet.appearance = {
      background: "#000020",
      foreground: "#FFEEDDFF",
      border: "#DDBB88",
      shape: "thought",
      fontSize: 20,
      fontWeight: "bold",
      padding: 16,
      borderRadius: 28,
      maxWidth: 320,
      animation: "pop",
    };
    comet.states.idle.delayMs = 60_000;
    comet.states.running.durationMs = 60_000;
    comet.states.running.repeatDelayMs = 3_600_000;
    const parsedGarden = parsePetManifest({ ...manifest, bubble: garden });
    const parsedComet = parsePetManifest({ ...manifest, name: "Comet", bubble: comet });
    expect(parsedGarden.bubble?.states.idle.messages).toEqual(["The garden is quiet."]);
    expect(parsedGarden.bubble?.states.running.repeatDelayMs).toBe(1_000);
    expect(parsedComet.bubble).toEqual(comet);
    expect(parsedComet.bubble?.appearance).not.toEqual(parsedGarden.bubble?.appearance);
    expect(garden.states.idle.messages).toEqual(["  The garden is quiet.  "]);
  });

  it("preserves an explicitly silent state and persistent one-shot messages", () => {
    const bubble = bubbleProfile();
    bubble.states.blocked = { messages: [], delayMs: 0, durationMs: 0, repeatDelayMs: 0 };
    bubble.states.petted = {
      messages: ["That was kind."],
      delayMs: 0,
      durationMs: 0,
      repeatDelayMs: 0,
    };
    const parsed = parsePetManifest({ ...manifest, bubble });
    expect(parsed.bubble?.states.blocked).toEqual(bubble.states.blocked);
    expect(parsed.bubble?.states.petted).toEqual(bubble.states.petted);
  });

  it.each([
    "red",
    "#abc",
    "#1234567",
    "#GG1122",
    "#123456\n",
    " #123456",
    "url(https://example.com/image)",
    "#123456;position:fixed",
    "var(--background)",
    { value: "#123456" },
  ])("rejects non-hex CSS or structured color payloads: %j", (color) => {
    for (const field of ["background", "foreground", "border"]) {
      const bubble = bubbleProfile();
      expect(() =>
        parsePetManifest({
          ...manifest,
          bubble: { ...bubble, appearance: { ...bubble.appearance, [field]: color } },
        }),
      ).toThrow(TypeError);
    }
  });

  it.each([
    ["fontSize", 9],
    ["fontSize", 21],
    ["fontSize", 12.5],
    ["fontWeight", "700"],
    ["padding", 5],
    ["padding", 17],
    ["borderRadius", -1],
    ["borderRadius", 29],
    ["maxWidth", 119],
    ["maxWidth", 321],
    ["shape", "url(sprite.svg)"],
    ["animation", "spin"],
  ])("rejects invalid appearance %s=%j", (field, value) => {
    const bubble = bubbleProfile();
    expect(() =>
      parsePetManifest({
        ...manifest,
        bubble: { ...bubble, appearance: { ...bubble.appearance, [field]: value } },
      }),
    ).toThrow(TypeError);
  });

  it("rejects incomplete profiles instead of inheriting another pet's style or state", () => {
    const bubble = bubbleProfile();
    const { background: _background, ...appearance } = bubble.appearance;
    const { offline: _offline, ...states } = bubble.states;
    const { durationMs: _durationMs, ...idle } = bubble.states.idle;
    for (const incomplete of [
      {},
      { appearance: bubble.appearance },
      { states: bubble.states },
      { ...bubble, appearance },
      { ...bubble, states },
      { ...bubble, states: { ...bubble.states, idle } },
    ]) {
      expect(() => parsePetManifest({ ...manifest, bubble: incomplete })).toThrow(TypeError);
    }
  });

  it("rejects executable or unknown fields at every nested profile boundary", () => {
    const bubble = bubbleProfile();
    for (const payload of [
      { ...bubble, script: "run.js" },
      { ...bubble, appearance: { ...bubble.appearance, css: "body { display:none }" } },
      { ...bubble, states: { ...bubble.states, custom: bubble.states.idle } },
      {
        ...bubble,
        states: { ...bubble.states, idle: { ...bubble.states.idle, command: "run.js" } },
      },
    ]) {
      expect(() => parsePetManifest({ ...manifest, bubble: payload })).toThrow(TypeError);
    }
  });

  it.each([
    { messages: [""] },
    { messages: ["   "] },
    { messages: ["x".repeat(181)] },
    { messages: Array.from({ length: 25 }, () => "Too many lines") },
    { messages: [{ html: "<img src=x onerror=alert(1)>" }] },
    { messages: [null] },
    { messages: "Not an array" },
  ])("rejects invalid message payloads: %j", ({ messages }) => {
    const bubble = bubbleProfile();
    expect(() =>
      parsePetManifest({
        ...manifest,
        bubble: {
          ...bubble,
          states: { ...bubble.states, idle: { ...bubble.states.idle, messages } },
        },
      }),
    ).toThrow(TypeError);
  });

  it.each([
    { delayMs: -1 },
    { delayMs: 60_001 },
    { delayMs: 0.5 },
    { durationMs: -1 },
    { durationMs: 60_001 },
    { durationMs: 1.5 },
    { repeatDelayMs: -1 },
    { repeatDelayMs: 999 },
    { repeatDelayMs: 1_000.5 },
    { repeatDelayMs: 3_600_001 },
    { durationMs: 0, repeatDelayMs: 1_000 },
  ])("rejects invalid state timing: %j", (timing) => {
    const bubble = bubbleProfile();
    expect(() =>
      parsePetManifest({
        ...manifest,
        bubble: {
          ...bubble,
          states: { ...bubble.states, running: { ...bubble.states.running, ...timing } },
        },
      }),
    ).toThrow(TypeError);
  });

  it("rejects repeats for the one-shot petted event even with a positive duration", () => {
    const bubble = bubbleProfile();
    bubble.states.petted.repeatDelayMs = 1_000;
    expect(() => parsePetManifest({ ...manifest, bubble })).toThrow(TypeError);
  });
});

describe("pet profile package compatibility", () => {
  it("loads built-in and existing legacy packages without adding profiles or rewriting files", async () => {
    const root = await temporaryRoot();
    const builtIn = path.join(root, "built-in", "iris");
    const installed = path.join(root, "user-data", "pets", "legacy-fox");
    const builtInContent = await writePackage(builtIn, { ...manifest, name: "Iris" });
    const installedContent = await writePackage(installed, manifest);
    const library = petLibrary(root);
    const pets = await library.list();
    expect(pets.map((pet) => [pet.id, pet.builtIn, pet.bubble])).toEqual([
      ["iris", true, undefined],
      ["legacy-fox", false, undefined],
    ]);
    expect((await library.getSelected("legacy-fox")).bubble).toBeUndefined();
    expect(await readFile(path.join(builtIn, "pet.json"), "utf8")).toBe(builtInContent);
    expect(await readFile(path.join(installed, "pet.json"), "utf8")).toBe(installedContent);
  });

  it("imports legacy packages without requiring or inventing a profile", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "legacy-source");
    const content = await writePackage(source, manifest);
    const imported = await petLibrary(root).importDirectory(source);
    expect(imported.bubble).toBeUndefined();
    const installed = JSON.parse(
      await readFile(path.join(root, "user-data", "pets", imported.id, "pet.json"), "utf8"),
    );
    expect(installed).not.toHaveProperty("bubble");
    expect(await readFile(path.join(source, "pet.json"), "utf8")).toBe(content);
  });

  it("carries independent profiles through import, descriptors and a fresh library load", async () => {
    const root = await temporaryRoot();
    await writePackage(path.join(root, "built-in", "iris"), { ...manifest, name: "Iris" });
    const garden = bubbleProfile("The garden is quiet.");
    const comet = bubbleProfile("Onward, stargazer!");
    comet.appearance.background = "#112233";
    comet.appearance.shape = "rounded";
    comet.states.idle.messages = [];
    const library = petLibrary(root);
    const imported: PetDescriptor[] = [];
    for (const [index, bubble] of [garden, comet].entries()) {
      const source = path.join(root, `source-${index}`);
      const content = await writePackage(source, { ...manifest, bubble });
      const pet = await library.importDirectory(source);
      imported.push(pet);
      expect(pet.bubble).toEqual(bubble);
      expect(await readFile(path.join(source, "pet.json"), "utf8")).toBe(content);
      expect(await readFile(path.join(source, "sprites.png"))).toEqual(pngHeader(128, 160));
      const installed = JSON.parse(
        await readFile(path.join(root, "user-data", "pets", pet.id, "pet.json"), "utf8"),
      );
      expect(installed.bubble).toEqual(bubble);
    }
    const reloaded = petLibrary(root);
    const pets = await reloaded.list();
    for (const pet of imported) {
      expect(pets.find((entry) => entry.id === pet.id)?.bubble).toEqual(pet.bubble);
      expect((await reloaded.getSelected(pet.id)).bubble).toEqual(pet.bubble);
    }
    expect(imported[0].bubble).not.toEqual(imported[1].bubble);
  });

  it.each(["missing", "incomplete"])(
    "rejects %s new-authoring profiles before Electron readiness or image conversion",
    async (kind) => {
      const root = await temporaryRoot();
      const value =
        kind === "missing"
          ? manifest
          : { ...manifest, bubble: { appearance: bubbleProfile().appearance } };
      const content = await writePackage(root, value);
      const sprite = await readFile(path.join(root, "sprites.png"));
      process.argv = [
        process.execPath,
        "--desktop-pet-install",
        path.join(root, "pet.json"),
        "--input-image",
        path.join(root, "generated.webp"),
      ];
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(await tryRunPetCreationCli({ argv: process.argv, ready: electron.whenReady, exit: electron.exit, convertImage: electron.convertImage, library: petLibrary(root) })).toBe(true);
      expect(electron.exit).toHaveBeenCalledWith(1);
      expect(electron.whenReady).not.toHaveBeenCalled();
      expect(electron.convertImage).not.toHaveBeenCalled();
      expect(await readFile(path.join(root, "pet.json"), "utf8")).toBe(content);
      expect(await readFile(path.join(root, "sprites.png"))).toEqual(sprite);
    },
  );
});
