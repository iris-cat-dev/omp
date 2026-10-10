import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalInputModeState } from "@omp-desktop/protocol/terminal-input-mode";
import type { IWindowsPty } from "@xterm/xterm";
import type { TerminalState } from "@omp-desktop/protocol/messages";
import { encodeTerminalOutput, TerminalEmulatorRuntime } from "./terminal-emulator-runtime";

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class WebglAddon {
    activate(): void {}
    dispose(): void {}
    onContextLoss(): void {}
  },
}));

interface TerminalSize {
  rows: number;
  cols: number;
  shouldClaim: boolean;
  forceClaim?: boolean;
}

interface TerminalKeyRecord {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

type BrowserTerminal = TerminalSize & {
  input: (data: string, wasUserInput?: boolean) => void;
  refresh: (start: number, end: number) => void;
  resize: (cols: number, rows: number) => void;
  reset: () => void;
  buffer: {
    active: {
      baseY: number;
      length: number;
      getLine: (index: number) => { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
};

interface MountedTerminal {
  host: HTMLDivElement;
  root: HTMLDivElement;
  runtime: TerminalEmulatorRuntime;
  inputs: string[];
  sizes: TerminalSize[];
  terminalKeys: TerminalKeyRecord[];
  inputModeChanges: TerminalInputModeState[];
}

const mountedTerminals: MountedTerminal[] = [];

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

function terminalOutput(text: string): Uint8Array {
  return encodeTerminalOutput(text);
}

function createSnapshotGrid(prompt: string): TerminalState["grid"] {
  return Array.from({ length: 5 }, (_rowValue, row) =>
    Array.from({ length: 80 }, (_columnValue, col) => ({
      char: row === 0 ? (prompt[col] ?? " ") : " ",
    })),
  );
}

async function waitFor(input: { predicate: () => boolean; timeoutMs?: number }): Promise<void> {
  const startedAt = performance.now();
  const timeoutMs = input.timeoutMs ?? 2_000;

  while (!input.predicate()) {
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for terminal browser condition");
    }
    await nextFrame();
  }
}

function settleMountRefits(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2_600));
}

function createTerminalHost(input: {
  width: number;
  height: number;
  scrollback?: number;
  windowsPty?: IWindowsPty;
}): MountedTerminal {
  const root = document.createElement("div");
  root.style.width = `${input.width}px`;
  root.style.height = `${input.height}px`;
  root.style.position = "fixed";
  root.style.left = "0";
  root.style.top = "0";
  root.style.overflow = "hidden";

  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  root.appendChild(host);
  document.body.appendChild(root);

  const sizes: TerminalSize[] = [];
  const inputs: string[] = [];
  const terminalKeys: TerminalKeyRecord[] = [];
  const inputModeChanges: TerminalInputModeState[] = [];
  const runtime = new TerminalEmulatorRuntime();
  runtime.setCallbacks({
    callbacks: {
      onInput: (data) => {
        inputs.push(data);
      },
      onResize: (size) => {
        sizes.push(size);
      },
      onTerminalKey: (key) => {
        terminalKeys.push(key);
      },
      onInputModeChange: (state) => {
        inputModeChanges.push(state);
      },
    },
  });
  runtime.mount({
    root,
    host,
    initialSnapshot: null,
    scrollback: input.scrollback ?? 10_000,
    theme: {
      background: "#0b0b0b",
      foreground: "#e6e6e6",
      cursor: "#e6e6e6",
    },
    windowsPty: input.windowsPty,
  });

  const mounted = { host, root, runtime, inputs, sizes, terminalKeys, inputModeChanges };
  mountedTerminals.push(mounted);
  return mounted;
}

function latestSize(sizes: TerminalSize[]): TerminalSize {
  const size = sizes.at(-1);
  if (!size) {
    throw new Error("Terminal did not report a size");
  }
  return size;
}

function expectNoForcedSameSizeClaim(input: {
  sizes: TerminalSize[];
  startIndex: number;
  baseline: TerminalSize;
}): void {
  const forcedSameSizeClaims = input.sizes
    .slice(input.startIndex)
    .filter(
      (size) =>
        size.rows === input.baseline.rows &&
        size.cols === input.baseline.cols &&
        size.shouldClaim &&
        size.forceClaim,
    );
  expect(forcedSameSizeClaims).toEqual([]);
}

function getBrowserTerminal(): BrowserTerminal {
  const terminal = window.__paseoTerminal as BrowserTerminal | undefined;
  if (!terminal) {
    throw new Error("Expected xterm to be exposed for browser test inspection");
  }
  return terminal;
}

function dispatchTerminalKey(input: {
  host: HTMLElement;
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}): boolean {
  const textarea = input.host.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea) {
    throw new Error("Expected xterm textarea to be mounted");
  }
  textarea.focus();
  return textarea.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: input.key,
      shiftKey: input.shiftKey ?? false,
      ctrlKey: input.ctrlKey ?? false,
      altKey: input.altKey ?? false,
      metaKey: input.metaKey ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

afterEach(() => {
  for (const mounted of mountedTerminals.splice(0)) {
    mounted.runtime.unmount();
    mounted.root.remove();
  }
});

describe("terminal emulator runtime in a real browser", () => {
  it("passes configured scrollback to xterm", async () => {
    await page.viewport(900, 600);
    createTerminalHost({ width: 720, height: 360, scrollback: 42_000 });

    await waitFor({
      predicate: () => window.__paseoTerminal !== undefined,
    });

    expect(window.__paseoTerminal?.options.scrollback).toBe(42_000);
  });

  it("updates scrollback on the mounted xterm", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360, scrollback: 10_000 });

    await waitFor({
      predicate: () => window.__paseoTerminal !== undefined,
    });
    const terminal = window.__paseoTerminal;

    mounted.runtime.setScrollback({ lines: 42_000 });

    expect(window.__paseoTerminal).toBe(terminal);
    expect(window.__paseoTerminal?.options.scrollback).toBe(42_000);
  });

  it("renders Cursor-style prompt dots in the terminal gutter", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    mounted.runtime.write({
      data: terminalOutput("\x1b]633;A\x07user@host project % "),
    });
    await waitFor({
      predicate: () =>
        mounted.host.querySelector('[data-terminal-prompt-decoration="idle"]') !== null,
    });

    const terminalElement = mounted.host.querySelector<HTMLElement>(".xterm");
    const idleDecoration = mounted.host.querySelector<HTMLElement>(
      '[data-terminal-prompt-decoration="idle"]',
    );
    expect(terminalElement?.style.paddingLeft).toBe("14px");
    expect(idleDecoration?.style.transform).toBe("translateX(-14px)");
    expect(idleDecoration?.firstElementChild).toBeInstanceOf(HTMLSpanElement);

    mounted.runtime.write({ data: terminalOutput("\x1b]633;B\x07") });
    await waitFor({
      predicate: () =>
        mounted.host.querySelector('[data-terminal-prompt-decoration="executed"]') !== null,
    });

    const executedDot = mounted.host.querySelector<HTMLElement>(
      '[data-terminal-prompt-decoration="executed"] > span',
    );
    expect(executedDot?.style.backgroundColor).toBe("rgb(55, 148, 255)");
  });

  it("creates the first prompt dot when prompt-start output was missed", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    mounted.runtime.write({
      data: terminalOutput("user@host project % \x1b]633;B\x07"),
    });
    await waitFor({
      predicate: () =>
        mounted.host.querySelector('[data-terminal-prompt-decoration="executed"]') !== null,
    });

    expect(
      mounted.host.querySelectorAll('[data-terminal-prompt-decoration="executed"]'),
    ).toHaveLength(1);
  });

  it("infers the first prompt dot from delayed live shell output", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    mounted.runtime.write({ data: terminalOutput("user@host project % ") });
    await waitFor({
      predicate: () =>
        mounted.host.querySelector('[data-terminal-prompt-decoration="idle"]') !== null,
    });

    expect(mounted.host.querySelectorAll('[data-terminal-prompt-decoration="idle"]')).toHaveLength(
      1,
    );
  });

  it("infers the first prompt dot from a restored shell prompt", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await new Promise<void>((resolve) => {
      mounted.runtime.restoreOutput({
        data: terminalOutput("user@host project % "),
        onCommitted: resolve,
      });
    });
    await waitFor({
      predicate: () =>
        mounted.host.querySelector('[data-terminal-prompt-decoration="idle"]') !== null,
    });

    expect(mounted.host.querySelectorAll('[data-terminal-prompt-decoration="idle"]')).toHaveLength(
      1,
    );
  });

  it("restores the first prompt dot from a terminal snapshot", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });
    const prompt = "user@host project % ";
    const state: TerminalState = {
      rows: 5,
      cols: 80,
      grid: createSnapshotGrid(prompt),
      scrollback: [],
      cursor: { row: 0, col: prompt.length },
      promptMarkers: [{ row: 0, executed: false }],
    };

    await new Promise<void>((resolve) => {
      mounted.runtime.renderSnapshot({ state, onCommitted: resolve });
    });
    await waitFor({
      predicate: () =>
        mounted.host.querySelector('[data-terminal-prompt-decoration="idle"]') !== null,
    });

    mounted.runtime.write({ data: terminalOutput("\x1b]633;B\x07") });
    await waitFor({
      predicate: () =>
        mounted.host.querySelector('[data-terminal-prompt-decoration="executed"]') !== null,
    });

    expect(
      mounted.host.querySelectorAll('[data-terminal-prompt-decoration="executed"]'),
    ).toHaveLength(1);
  });

  it("does not claim PTY ownership from passive mount refits", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await settleMountRefits();

    expect(mounted.sizes.length).toBeGreaterThan(1);
    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([]);

    const settledSize = latestSize(mounted.sizes);
    mounted.runtime.resize({ forceClaim: true, shouldClaim: true });

    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([
      { ...settledSize, shouldClaim: true, forceClaim: true },
    ]);
  });

  it("reports a larger PTY size when the terminal container grows", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 360, height: 180 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    const initialSize = latestSize(mounted.sizes);

    mounted.root.style.width = "720px";
    mounted.root.style.height = "360px";
    await nextFrame();
    mounted.runtime.resize({ forceRefresh: true, shouldClaim: true });

    await waitFor({
      predicate: () => {
        const size = latestSize(mounted.sizes);
        return size.cols > initialSize.cols && size.rows > initialSize.rows;
      },
    });

    const grownSize = latestSize(mounted.sizes);
    expect(grownSize.cols).toBeGreaterThan(initialSize.cols);
    expect(grownSize.rows).toBeGreaterThan(initialSize.rows);
    expect(grownSize.shouldClaim).toBe(true);
  });

  it("preserves scrollback when ConPTY redraws after a vertical resize", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({
      width: 720,
      height: 360,
      windowsPty: { backend: "conpty", buildNumber: 26_200 },
    });
    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await settleMountRefits();

    const terminal = getBrowserTerminal();
    terminal.resize(80, 6);
    mounted.runtime.write({
      data: terminalOutput("one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nC:\\project> npm run dev"),
    });
    await waitFor({
      predicate: () =>
        terminal.buffer.active.getLine(5)?.translateToString(true).includes("npm run dev") === true,
    });

    terminal.resize(80, 2);
    terminal.resize(80, 6);
    expect(terminal.buffer.active.baseY).toBe(4);

    mounted.runtime.write({
      data: terminalOutput("\u001b[H\u001b[2Jfive\r\nC:\\project> npm run dev"),
    });
    await waitFor({
      predicate: () =>
        Array.from({ length: terminal.buffer.active.length }, (_, index) =>
          terminal.buffer.active.getLine(index)?.translateToString(true),
        )
          .join("\n")
          .includes("npm run dev"),
    });

    const retainedText = Array.from({ length: terminal.buffer.active.length }, (_, index) =>
      terminal.buffer.active.getLine(index)?.translateToString(true),
    ).join("\n");
    expect(retainedText).toContain("one\ntwo\nthree\nfour");
  });

  it("keeps passive container measurements local after another client can claim", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 360, height: 180 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await settleMountRefits();
    const initialSize = latestSize(mounted.sizes);
    mounted.sizes.length = 0;

    mounted.root.style.width = "720px";
    mounted.root.style.height = "360px";

    await waitFor({
      predicate: () =>
        mounted.sizes.some((size) => size.cols > initialSize.cols && size.rows > initialSize.rows),
    });

    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([]);
  });

  it("keeps visual viewport keyboard refits passive", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 360, height: 180 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await settleMountRefits();
    mounted.sizes.length = 0;

    mounted.root.style.width = "720px";
    mounted.root.style.height = "360px";
    expect(window.visualViewport).not.toBeNull();
    window.visualViewport?.dispatchEvent(new Event("resize"));

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([]);
  });

  it("keeps browser window refits passive", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 360, height: 180 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await settleMountRefits();
    mounted.sizes.length = 0;

    mounted.root.style.width = "720px";
    mounted.root.style.height = "360px";
    window.dispatchEvent(new Event("resize"));

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([]);
  });

  it("does not force-claim a same-size resize while forwarding ordinary terminal input", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    const sizeCount = mounted.sizes.length;
    const sizeBeforeInput = latestSize(mounted.sizes);
    const terminal = getBrowserTerminal();

    terminal.input("a", true);

    await waitFor({ predicate: () => mounted.inputs.length > 0 });

    expect(mounted.inputs.at(-1)).toBe("a");
    expectNoForcedSameSizeClaim({
      sizes: mounted.sizes,
      startIndex: sizeCount,
      baseline: sizeBeforeInput,
    });
  });

  it("pastes through xterm's input producer", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    mounted.runtime.paste("legacy renderer paste");

    await waitFor({ predicate: () => mounted.inputs.length > 0 });
    expect(mounted.inputs).toEqual(["legacy renderer paste"]);
  });

  it("clears visible output and scrollback from the live terminal", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 180 });
    const terminal = getBrowserTerminal();
    const output = Array.from({ length: 40 }, (_, index) => `clear-target-${index}\r\n`).join("");

    mounted.runtime.write({ data: terminalOutput(output) });
    await waitFor({ predicate: () => terminal.buffer.active.baseY > 0 });

    mounted.runtime.clearDisplay();
    await waitFor({ predicate: () => terminal.buffer.active.baseY === 0 });

    const remainingText = Array.from({ length: terminal.buffer.active.length }, (_, index) =>
      terminal.buffer.active.getLine(index)?.translateToString(true),
    ).join("\n");
    expect(remainingText).not.toContain("clear-target-");
  });

  it("refreshes visible rows on a forced same-size resize", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    const terminal = getBrowserTerminal();
    const refreshCalls: Array<[number, number]> = [];
    const originalRefresh = terminal.refresh.bind(terminal);
    terminal.refresh = (start, end) => {
      refreshCalls.push([start, end]);
      originalRefresh(start, end);
    };

    mounted.runtime.resize({ forceRefresh: true, shouldClaim: false });

    await waitFor({ predicate: () => refreshCalls.length > 0 });
    expect(refreshCalls.at(-1)).toEqual([0, terminal.rows - 1]);
  });

  it("intercepts Shift+Enter only after enhanced terminal input mode is active", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    dispatchTerminalKey({
      host: mounted.host,
      key: "Enter",
      shiftKey: true,
    });
    await nextFrame();

    expect(mounted.terminalKeys).toEqual([]);

    mounted.runtime.write({ data: terminalOutput("\x1b[>7u") });
    await waitFor({
      predicate: () =>
        mounted.inputModeChanges.some(
          (state) => state.kittyKeyboardFlags === 7 && !state.win32InputMode,
        ),
    });

    dispatchTerminalKey({
      host: mounted.host,
      key: "Enter",
      shiftKey: true,
    });
    await nextFrame();

    expect(mounted.terminalKeys).toEqual([
      {
        key: "Enter",
        ctrl: false,
        shift: true,
        alt: false,
        meta: false,
      },
    ]);

    mounted.terminalKeys.length = 0;
    mounted.runtime.write({ data: terminalOutput("\x1b[=0;0u\x1b[?9001h") });
    await waitFor({
      predicate: () =>
        mounted.inputModeChanges.some(
          (state) => state.kittyKeyboardFlags === 0 && state.win32InputMode,
        ),
    });

    dispatchTerminalKey({
      host: mounted.host,
      key: "Enter",
      shiftKey: true,
    });
    await nextFrame();

    expect(mounted.terminalKeys).toEqual([
      {
        key: "Enter",
        ctrl: false,
        shift: true,
        alt: false,
        meta: false,
      },
    ]);

    const sizeCount = mounted.sizes.length;
    const sizeBeforeKey = latestSize(mounted.sizes);
    mounted.terminalKeys.length = 0;

    dispatchTerminalKey({
      host: mounted.host,
      key: "Enter",
      shiftKey: true,
    });
    await nextFrame();

    expect(mounted.terminalKeys).toEqual([
      {
        key: "Enter",
        ctrl: false,
        shift: true,
        alt: false,
        meta: false,
      },
    ]);
    expectNoForcedSameSizeClaim({
      sizes: mounted.sizes,
      startIndex: sizeCount,
      baseline: sizeBeforeKey,
    });
  });

  it.each([
    { name: "DA1", bytes: "\x1b[c" },
    { name: "DA1-zero", bytes: "\x1b[0c" },
    { name: "DA2", bytes: "\x1b[>c" },
    { name: "DA3", bytes: "\x1b[=c" },
    { name: "DSR-5", bytes: "\x1b[5n" },
    { name: "DSR-6", bytes: "\x1b[6n" },
    { name: "DSR-?6", bytes: "\x1b[?6n" },
    { name: "DECRQM", bytes: "\x1b[1$p" },
    { name: "DECRQM-?", bytes: "\x1b[?1$p" },
    { name: "OSC-10-foreground-color", bytes: "\x1b]10;?\x07" },
    { name: "OSC-11-background-color", bytes: "\x1b]11;?\x07" },
    { name: "OSC-12-cursor-color", bytes: "\x1b]12;?\x07" },
  ])("does not emit a PTY input reply for $name", async ({ bytes }) => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    mounted.runtime.write({ data: terminalOutput(bytes) });
    await nextFrame();
    await nextFrame();

    expect(mounted.inputs).toEqual([]);
  });

  it("replays snapshots without synchronously resetting the visible terminal", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    const terminal = getBrowserTerminal();
    const originalReset = terminal.reset.bind(terminal);
    const reset = vi.fn(originalReset);
    terminal.reset = reset;

    mounted.runtime.renderSnapshot({
      state: {
        rows: terminal.rows,
        cols: terminal.cols,
        scrollback: [],
        grid: [
          [
            { char: "p" },
            { char: "r" },
            { char: "o" },
            { char: "m" },
            { char: "p" },
            { char: "t" },
          ],
        ],
        cursor: {
          row: 0,
          col: 6,
        },
      },
    });
    await nextFrame();

    expect(reset).not.toHaveBeenCalled();
  });
});
