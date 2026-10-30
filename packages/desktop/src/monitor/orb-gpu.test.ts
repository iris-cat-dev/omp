/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MONITOR_RENDERER_SCRIPT } from "./renderer.js";
import { MONITOR_SELECT_PICKER_SCRIPT } from "./select-picker.js";
import { MONITOR_UI_MARKUP } from "./ui-markup.js";
import type { OmpMonitorViewState } from "./view-types.js";
import { MONITOR_VISUALS_SCRIPT } from "./visuals.js";
import { DEFAULT_MONITOR_PREFERENCES } from "./window-preferences.js";
import { MONITOR_PERF_MARKUP } from "./performance-ui.js";
import { MONITOR_BOARD_MARKUP } from "./board-ui.js";

interface Visual {
  update(frame: Record<string, unknown>): void;
  setVisible(visible: boolean): void;
  destroy(): void;
}
interface Visuals {
  create(host: HTMLElement, options: { thumbnail?: boolean; sharedGpu?: boolean }): Visual;
  disposeSharedGpu(): void;
}

class RenderQueue {
  now = 1_000;
  private serial = 0;
  readonly frames = new Map<number, FrameRequestCallback>();
  readonly timers = new Map<number, { run: () => void; due: number }>();
  readonly requestFrame = (run: FrameRequestCallback) => {
    const id = ++this.serial;
    this.frames.set(id, run);
    return id;
  };
  readonly cancelFrame = (id: number) => {
    this.frames.delete(id);
  };
  readonly setTimer = (run: () => void, delay = 0) => {
    const id = ++this.serial;
    this.timers.set(id, { run, due: this.now + delay });
    return id;
  };
  readonly clearTimer = (id: number) => {
    this.timers.delete(id);
  };
  frame() {
    this.now += 20;
    const pending = Array.from(this.frames);
    this.frames.clear();
    for (const [, run] of pending) run(this.now);
  }
  runTimers() {
    const pending = Array.from(this.timers).filter(([, timer]) => timer.due <= this.now);
    for (const [id, timer] of pending) {
      this.timers.delete(id);
      timer.run();
    }
  }
  get size() {
    return this.frames.size + this.timers.size;
  }
}

class Pixels {
  readonly data: Uint8ClampedArray;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

const noOp = () => {};
class VectorPath {
  moveTo = noOp;
  lineTo = noOp;
  quadraticCurveTo = noOp;
  closePath = noOp;
}
function canvas2d() {
  return {
    restore: noOp,
    save: noOp,
    setTransform: noOp,
    clearRect: noOp,
    beginPath: noOp,
    arc: noOp,
    clip: noOp,
    fill: noOp,
    stroke: noOp,
    fillRect: noOp,
    moveTo: noOp,
    lineTo: noOp,
    closePath: noOp,
    fillText: noOp,
    putImageData: noOp,
    drawImage: noOp,
    measureText: (value: string) => ({ width: value.length * 8 }),
    getImageData: (_x: number, _y: number, width: number, height: number) =>
      new Pixels(width, height),
  };
}

// Only browser/driver boundaries are replaced. Tests execute the production visual and renderer
// scripts, including resource allocation, uniform submission, snapshot copying and cancellation.
class GpuDriver {
  lost = false;
  readonly programs: object[] = [];
  readonly shaders: object[] = [];
  readonly deletedPrograms: object[] = [];
  readonly deletedTextures: object[] = [];
  readonly textures: object[] = [];
  readonly textureUploads: Array<{ unit: number; pixels: unknown }> = [];
  private textureUnit = 0;
  readonly operations: string[] = [];
  readonly draws: Array<Record<string, number>> = [];
  private readonly uniforms: Record<string, number> = {};
  readonly requestLoss = vi.fn(() => {
    this.operations.push("lose-context");
    this.lose();
  });
  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly realm: Window & typeof globalThis,
    private readonly failsCompilation: () => boolean,
  ) {}
  lose() {
    this.lost = true;
    const event = new this.realm.Event("webglcontextlost", { cancelable: true });
    this.canvas.dispatchEvent(event);
    return event;
  }
  restore() {
    this.lost = false;
    this.canvas.dispatchEvent(new this.realm.Event("webglcontextrestored"));
  }
  readonly gl = {
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    COMPILE_STATUS: 35713,
    LINK_STATUS: 35714,
    ARRAY_BUFFER: 34962,
    STATIC_DRAW: 35044,
    FLOAT: 5126,
    TRIANGLES: 4,
    COLOR_BUFFER_BIT: 16384,
    TEXTURE_2D: 3553,
    TEXTURE_MIN_FILTER: 10241,
    TEXTURE_MAG_FILTER: 10240,
    TEXTURE_WRAP_S: 10242,
    TEXTURE_WRAP_T: 10243,
    LINEAR: 9729,
    CLAMP_TO_EDGE: 33071,
    TEXTURE0: 33984,
    TEXTURE1: 33985,
    TEXTURE2: 33986,
    TEXTURE3: 33987,
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    UNPACK_FLIP_Y_WEBGL: 37440,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 37441,
    UNPACK_COLORSPACE_CONVERSION_WEBGL: 37443,
    NONE: 0,
    isContextLost: () => this.lost,
    getExtension: (name: string) =>
      name === "WEBGL_lose_context" ? { loseContext: this.requestLoss } : null,
    createShader: () => {
      const shader = {};
      this.shaders.push(shader);
      return shader;
    },
    shaderSource: noOp,
    compileShader: noOp,
    deleteShader: noOp,
    getShaderParameter: () => !this.failsCompilation(),
    getShaderInfoLog: () => "Temporary shader compilation failure",
    createProgram: () => {
      const program = {};
      this.programs.push(program);
      return program;
    },
    attachShader: noOp,
    bindAttribLocation: noOp,
    linkProgram: noOp,
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    deleteProgram: (program: object) => {
      this.deletedPrograms.push(program);
      this.operations.push("delete-program");
    },
    getUniformLocation: (_program: object, name: string) => name,
    createBuffer: () => ({}),
    bindBuffer: noOp,
    bufferData: noOp,
    deleteBuffer: noOp,
    enableVertexAttribArray: noOp,
    vertexAttribPointer: noOp,
    useProgram: noOp,
    viewport: noOp,
    clearColor: noOp,
    clear: noOp,
    uniform1f: (name: string, value: number) => {
      this.uniforms[name] = value;
    },
    uniform1i: (name: string, value: number) => {
      this.uniforms[name] = value;
    },
    uniform2f: noOp,
    uniform3fv: noOp,
    uniform4f: noOp,
    uniform4fv: (name: string, values: ArrayLike<number>) => {
      for (let index = 0; index < 4; index++) this.uniforms[name + index] = values[index]!;
    },
    drawArrays: () => {
      this.draws.push({ ...this.uniforms });
    },
    createTexture: () => {
      const texture = {};
      this.textures.push(texture);
      return texture;
    },
    bindTexture: noOp,
    texParameteri: noOp,
    pixelStorei: noOp,
    activeTexture: (unit: number) => {
      this.textureUnit = unit;
    },
    texImage2D: (...args: unknown[]) => {
      this.textureUploads.push({ unit: this.textureUnit, pixels: args.at(-1) });
    },
    deleteTexture: (texture: object) => {
      this.deletedTextures.push(texture);
      this.operations.push("delete-texture");
    },
  };
}

function settingsState(): OmpMonitorViewState {
  return {
    language: "en",
    surface: "settings",
    instanceId: "fixture-orb",
    orbVisible: true,
    nameplatePlacement: "below",
    nameplateMaxWidth: 200,
    maxFps: 60,
    activity: { responseSequence: 0, peakSequence: 0, lastResponseAt: null, lastPeakAt: null },
    preferences: { ...DEFAULT_MONITOR_PREFERENCES, effects: "off", appearance: "dark" },
    scope: { profile: null, project: null },
    scopes: { profiles: [], projects: [] },
    snapshot: null,
    workerError: false,
    preferenceError: false,
    refreshing: false,
    windowCount: 1,
    maxWindows: 8,
    orbs: [
      {
        instanceId: "fixture-orb",
        scope: { profile: null, project: null },
        style: "led",
        size: 148,
        visible: true,
        pinned: true,
        clickThrough: false,
      },
    ],
    board: null,
    boards: [],
  };
}

const pages: TestPage[] = [];
class TestPage {
  readonly iframe = document.createElement("iframe");
  readonly realm: Window & typeof globalThis;
  readonly clock = new RenderQueue();
  readonly drivers: GpuDriver[] = [];
  readonly visuals: Visuals;
  readonly instances: Visual[] = [];
  compileFailure = false;
  private hidden = false;
  private started = false;
  private readonly startMonitor: () => void;
  private stateListener: ((state: OmpMonitorViewState) => void) | null = null;
  constructor(ready: Promise<OmpMonitorViewState> = Promise.resolve(settingsState())) {
    document.body.append(this.iframe);
    this.realm = this.iframe.contentWindow as Window & typeof globalThis;
    this.realm.document.body.innerHTML =
      MONITOR_UI_MARKUP + MONITOR_PERF_MARKUP + MONITOR_BOARD_MARKUP;
    Object.defineProperty(this.realm.document, "hidden", {
      configurable: true,
      get: () => this.hidden,
    });
    Object.defineProperty(this.realm.HTMLElement.prototype, "animate", {
      configurable: true,
      value: () => ({ cancel: noOp, addEventListener: noOp }),
    });
    Object.defineProperty(this.realm, "matchMedia", {
      configurable: true,
      value: (media: string) =>
        Object.assign(new this.realm.EventTarget(), { media, matches: false }),
    });
    Object.defineProperty(this.realm, "ompMonitor", {
      value: {
        ready: () => ready,
        onState: (listener: (state: OmpMonitorViewState) => void) => {
          this.stateListener = listener;
          return noOp;
        },
        onPointer: () => noOp,
        onDragCancelled: () => noOp,
        setInteractive: noOp,
      },
    });
    const contexts = new WeakMap<HTMLCanvasElement, { kind: string; value: unknown }>();
    const createGpuContext = (canvas: HTMLCanvasElement) => {
      const driver = new GpuDriver(canvas, this.realm, () => this.compileFailure);
      this.drivers.push(driver);
      return driver.gl;
    };
    vi.spyOn(this.realm.HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
      this: HTMLCanvasElement,
      kind: string,
    ) {
      const current = contexts.get(this);
      if (current) return current.kind === kind ? current.value : null;
      let value: unknown;
      if (kind === "2d") value = canvas2d();
      else if (kind === "webgl2") value = createGpuContext(this);
      else return null;
      contexts.set(this, { kind, value });
      return value;
    } as typeof HTMLCanvasElement.prototype.getContext);
    vi.spyOn(this.realm.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const visible =
          this.id === "settings-scroller" ||
          this.id === "preview-led" ||
          this.id === "preview-liquid" ||
          this.classList.contains("orb-list-art");
        const top = visible ? 0 : 1_000,
          height = this.id === "settings-scroller" ? 680 : 96;
        return {
          x: 0,
          y: top,
          top,
          bottom: top + height,
          left: 0,
          right: 640,
          width: 640,
          height,
        } as DOMRect;
      },
    );
    const code =
      MONITOR_VISUALS_SCRIPT +
      MONITOR_SELECT_PICKER_SCRIPT +
      MONITOR_RENDERER_SCRIPT +
      "\nreturn {visuals:agentSpeedVisuals,startMonitor};";
    const runtime = new Function(
      "document",
      "window",
      "performance",
      "ImageData",
      "Path2D",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "setTimeout",
      "clearTimeout",
      "monitorAttribution",
      "monitorLicense",
      "AbortController",
      code,
    )(
      this.realm.document,
      this.realm,
      { now: () => this.clock.now },
      Pixels,
      VectorPath,
      this.clock.requestFrame,
      this.clock.cancelFrame,
      this.clock.setTimer,
      this.clock.clearTimer,
      "",
      "",
      this.realm.AbortController,
    ) as { visuals: Visuals; startMonitor(): void };
    this.visuals = runtime.visuals;
    this.startMonitor = runtime.startMonitor;
    pages.push(this);
  }
  async start() {
    this.started = true;
    this.startMonitor();
    await Promise.resolve();
  }
  deliver(state: OmpMonitorViewState) {
    this.stateListener?.(state);
  }
  nav(page: "general" | "orb") {
    this.realm.document.getElementById("nav-" + page)!.click();
  }
  setHidden(hidden: boolean) {
    this.hidden = hidden;
    this.realm.document.dispatchEvent(new this.realm.Event("visibilitychange"));
  }
  pagehide() {
    this.realm.dispatchEvent(new this.realm.Event("pagehide"));
  }
  create(options: { thumbnail?: boolean; sharedGpu?: boolean } = { sharedGpu: true }) {
    const host = this.realm.document.createElement("div");
    this.realm.document.body.append(host);
    const visual = this.visuals.create(host, options);
    this.instances.push(visual);
    return { host, visual };
  }
  cleanup() {
    if (this.started) this.pagehide();
    for (const instance of this.instances) instance.destroy();
    this.visuals.disposeSharedGpu();
    this.iframe.remove();
  }
}

function orbFrame(style = "led", size = 64): Record<string, unknown> {
  return {
    style,
    size,
    value: 20,
    formattedValue: "20",
    unit: "tok/s",
    title: "Cruising",
    titleTheme: "vehicles",
    language: "en",
    redline: 200,
    appearance: "dark",
    effects: "off",
    reduceMotion: true,
    maxFps: 60,
    opacity: 1,
    hovered: false,
    activeAgents: 0,
    toolsAgents: 0,
    responsePulse: false,
    newPeak: false,
    hoverLabel: "OMP",
  };
}

afterEach(() => {
  for (const page of pages.splice(0)) page.cleanup();
  vi.restoreAllMocks();
});

describe("settings preview GPU lifetime", () => {
  it("reuses one pool across zero leases without hidden work or changing full-size preview uniforms", () => {
    const page = new TestPage();
    const led = page.create(),
      liquid = page.create(),
      small = page.create({ thumbnail: true });
    led.visual.update(orbFrame());
    liquid.visual.update(orbFrame("liquid"));
    small.visual.update(orbFrame("led", 38));
    page.clock.frame();
    expect(page.drivers).toHaveLength(1);
    const driver = page.drivers[0]!;
    expect(driver.programs).toHaveLength(2);
    expect(driver.shaders).toHaveLength(3);
    expect(driver.draws.map((draw) => [draw.uThumbnail, draw.uLogicalS])).toEqual([
      [0, 64],
      [0, 64],
      [1, 38],
    ]);
    for (const { visual } of [led, liquid, small]) visual.setVisible(false);
    expect(page.clock.size).toBe(0);
    page.clock.frame();
    page.clock.runTimers();
    expect(driver.draws).toHaveLength(3);
    expect(driver.deletedPrograms).toHaveLength(0);
    expect(driver.requestLoss).not.toHaveBeenCalled();
    for (const [entry, style, size] of [
      [led, "led", 64],
      [liquid, "liquid", 64],
      [small, "led", 38],
    ] as const) {
      entry.visual.setVisible(true);
      entry.visual.update(orbFrame(style, size));
    }
    page.clock.frame();
    expect(page.drivers).toHaveLength(1);
    expect(driver.programs).toHaveLength(2);
    expect(driver.draws).toHaveLength(6);
    for (const { visual } of [led, liquid, small]) visual.destroy();
    expect(driver.deletedPrograms).toHaveLength(0);
    page.visuals.disposeSharedGpu();
    page.visuals.disposeSharedGpu();
    expect(driver.deletedPrograms).toEqual(driver.programs);
    expect(driver.requestLoss).toHaveBeenCalledTimes(1);
    expect(driver.operations.lastIndexOf("delete-texture")).toBeLessThan(
      driver.operations.indexOf("delete-program"),
    );
    expect(driver.operations.at(-1)).toBe("lose-context");
    driver.restore();
    page.clock.frame();
    expect(driver.programs).toHaveLength(2);
    expect(page.clock.size).toBe(0);
  });

  it("restores active previews with one lazy program rebuild, not one rebuild per lease", () => {
    const page = new TestPage(),
      first = page.create(),
      second = page.create();
    first.visual.update(orbFrame());
    second.visual.update(orbFrame("liquid"));
    page.clock.frame();
    const driver = page.drivers[0]!;
    expect(driver.lose().defaultPrevented).toBe(true);
    expect(first.host.dataset.renderError).toBe("WebGL context lost");
    expect(page.clock.size).toBe(0);
    driver.restore();
    expect(driver.programs).toHaveLength(2);
    page.clock.frame();
    expect(driver.programs).toHaveLength(4);
    expect(page.drivers).toHaveLength(1);
    expect(driver.draws).toHaveLength(4);
    expect(first.host.dataset.renderError).toBeUndefined();
    expect(second.host.dataset.renderError).toBeUndefined();
  });

  it("keeps a lost/restored zero-lease pool idle until a preview is shown again", () => {
    const page = new TestPage(),
      preview = page.create();
    preview.visual.update(orbFrame());
    page.clock.frame();
    const driver = page.drivers[0]!;
    preview.visual.setVisible(false);
    expect(driver.lose().defaultPrevented).toBe(true);
    driver.restore();
    page.clock.frame();
    page.clock.runTimers();
    expect(driver.programs).toHaveLength(2);
    expect(driver.draws).toHaveLength(1);
    expect(page.clock.size).toBe(0);
    preview.visual.setVisible(true);
    preview.visual.update(orbFrame());
    page.clock.frame();
    expect(page.drivers).toHaveLength(1);
    expect(driver.programs).toHaveLength(4);
    expect(driver.draws).toHaveLength(2);
    expect(preview.host.dataset.renderError).toBeUndefined();
  });

  it("preserves visible GPU errors and allows a failed initialization to recover on reactivation", () => {
    const page = new TestPage(),
      preview = page.create();
    page.compileFailure = true;
    preview.visual.update(orbFrame());
    page.clock.frame();
    expect(preview.host.dataset.renderError).toBe("Temporary shader compilation failure");
    expect((preview.host.querySelector(".as-orb-render-error") as HTMLElement).hidden).toBe(false);
    expect(page.clock.size).toBe(0);
    preview.visual.setVisible(false);
    page.compileFailure = false;
    preview.visual.setVisible(true);
    preview.visual.update(orbFrame());
    page.clock.frame();
    expect(page.drivers).toHaveLength(1);
    expect(page.drivers[0]!.programs).toHaveLength(2);
    expect(page.drivers[0]!.draws).toHaveLength(1);
    expect(preview.host.dataset.renderError).toBeUndefined();
    expect((preview.host.querySelector(".as-orb-render-error") as HTMLElement).hidden).toBe(true);
  });

  it("does not release or rebuild the independent live-orb context when the preview pool is disposed", () => {
    const page = new TestPage(),
      preview = page.create(),
      live = page.create({});
    preview.visual.update(orbFrame());
    live.visual.update(orbFrame("led", 148));
    page.clock.frame();
    const shared = page.drivers[0]!,
      native = page.drivers[1]!;
    expect(page.drivers).toHaveLength(2);
    preview.visual.destroy();
    page.visuals.disposeSharedGpu();
    live.visual.update(orbFrame("led", 148));
    page.clock.now += 100;
    page.clock.frame();
    expect(shared.requestLoss).toHaveBeenCalledTimes(1);
    expect(native.requestLoss).not.toHaveBeenCalled();
    expect(native.programs).toHaveLength(2);
    expect(native.draws).toHaveLength(2);
    expect(native.deletedPrograms).toHaveLength(0);
    expect(native.lose().defaultPrevented).toBe(true);
    native.restore();
    page.clock.frame();
    expect(native.programs).toHaveLength(4);
    expect(native.draws).toHaveLength(3);
  });
});

describe("settings first-preview scheduling", () => {
  it("paints the selected page before initializing previews, reuses them on return, and disposes on pagehide", async () => {
    const page = new TestPage();
    await page.start();
    page.nav("orb");
    expect(
      page.realm.document.querySelector<HTMLElement>('.settings-page[data-page="orb"]')!.hidden,
    ).toBe(false);
    expect(page.realm.document.querySelector("#preview-led .as-orb-gl")).toBeNull();
    expect(page.drivers).toHaveLength(0);
    page.clock.frame();
    expect(page.drivers).toHaveLength(0);
    page.clock.runTimers();
    expect(page.drivers).toHaveLength(0);
    page.clock.frame();
    expect(page.drivers).toHaveLength(1);
    const driver = page.drivers[0]!;
    expect(driver.programs).toHaveLength(2);
    expect(driver.draws).toHaveLength(3);
    page.nav("general");
    expect(page.clock.size).toBe(0);
    expect(driver.requestLoss).not.toHaveBeenCalled();
    page.nav("orb");
    page.clock.frame();
    expect(driver.programs).toHaveLength(2);
    expect(driver.draws).toHaveLength(6);
    page.pagehide();
    expect(driver.deletedPrograms).toEqual(driver.programs);
    expect(driver.requestLoss).toHaveBeenCalledTimes(1);
    expect(page.clock.size).toBe(0);
    page.deliver(settingsState());
    page.realm.dispatchEvent(new page.realm.Event("resize"));
    page.setHidden(true);
    page.setHidden(false);
    driver.restore();
    page.clock.frame();
    page.clock.runTimers();
    expect(page.drivers).toHaveLength(1);
    expect(driver.programs).toHaveLength(2);
    expect(page.clock.size).toBe(0);
  });

  it.each(["before-paint", "after-paint", "before-draw"] as const)(
    "cancels fast tab departure %s without a stale preview draw",
    async (phase) => {
      const page = new TestPage();
      await page.start();
      page.nav("orb");
      const staleFrame = Array.from(page.clock.frames.values())[0]!;
      if (phase !== "before-paint") page.clock.frame();
      const staleTimer = Array.from(page.clock.timers.values())[0]?.run;
      if (phase === "before-draw") page.clock.runTimers();
      page.nav("general");
      // A callback already handed to the browser must also reject its cancelled generation.
      staleFrame(page.clock.now);
      staleTimer?.();
      page.clock.frame();
      page.clock.runTimers();
      expect(page.drivers).toHaveLength(0);
      expect(page.clock.size).toBe(0);
      page.nav("orb");
      page.clock.frame();
      page.clock.runTimers();
      page.clock.frame();
      expect(page.drivers).toHaveLength(1);
      expect(page.drivers[0]!.programs).toHaveLength(2);
    },
  );

  it.each([
    ["hidden", false],
    ["pagehide", false],
    ["hidden", true],
    ["pagehide", true],
  ] as const)(
    "cancels on %s (preview draw queued: %s) and ignores callbacks already handed off",
    async (reason, drawQueued) => {
      const page = new TestPage();
      await page.start();
      page.nav("orb");
      page.clock.frame();
      const staleTimer = Array.from(page.clock.timers.values())[0]!.run;
      if (drawQueued) page.clock.runTimers();
      const staleDraws = Array.from(page.clock.frames.values());
      if (reason === "hidden") page.setHidden(true);
      else page.pagehide();
      staleTimer();
      for (const draw of staleDraws) draw(page.clock.now);
      page.clock.runTimers();
      page.clock.frame();
      expect(page.drivers).toHaveLength(0);
      expect(page.clock.size).toBe(0);
      if (reason === "hidden") {
        page.setHidden(false);
        page.clock.frame();
        page.clock.runTimers();
        page.clock.frame();
        expect(page.drivers).toHaveLength(1);
      } else {
        page.deliver(settingsState());
        page.nav("orb");
        page.clock.frame();
        page.clock.runTimers();
        expect(page.drivers).toHaveLength(0);
        expect(page.clock.size).toBe(0);
      }
    },
  );

  it("does not initialize anything when bridge readiness arrives after teardown", async () => {
    let resolve!: (state: OmpMonitorViewState) => void;
    const page = new TestPage(
      new Promise<OmpMonitorViewState>((done) => {
        resolve = done;
      }),
    );
    await page.start();
    page.nav("orb");
    page.pagehide();
    resolve(settingsState());
    await Promise.resolve();
    page.clock.frame();
    page.clock.runTimers();
    expect(page.drivers).toHaveLength(0);
    expect(page.clock.size).toBe(0);
  });
});

describe("performance readout GPU consumer", () => {
  it("keeps the output odometer, cached masks, four-texture lifetime and shared context independent of performance changes", () => {
    const page = new TestPage();
    const { host, visual } = page.create();
    const reading = {
      visible: true,
      key: "winner:12840:provisional",
      stackOffset: 4,
      needleLegend: false,
      contrast: false,
      glyphs: [
        {
          text: "12.8k",
          role: 0,
          weight: 600,
          size: 12,
          x: -20,
          y: 31,
          alpha: 1,
          provisional: true,
        },
        {
          text: "Perf",
          role: 1,
          weight: 500,
          size: 9,
          x: -36,
          y: 31,
          alpha: 1,
          provisional: false,
        },
      ],
    };
    const frame = { ...orbFrame("liquid", 148), effects: "soft", reduceMotion: false };
    visual.update(frame);
    page.clock.frame();
    const driver = page.drivers[0]!;
    page.clock.now += 100;
    visual.update({ ...frame, value: 30, formattedValue: "30" });
    page.clock.frame();
    const firstRoll = driver.draws.at(-1)!["uReadoutRoll2"]!;
    const previousOutputUploads = driver.textureUploads.filter(
      (upload) => upload.unit === driver.gl.TEXTURE1,
    ).length;
    host.dispatchEvent(new page.realm.CustomEvent("perf-readout-change", { detail: reading }));
    page.clock.now += 40;
    page.clock.frame();
    const afterPerformance = driver.draws.at(-1)!;
    expect(afterPerformance.uPerfReadoutOn).toBe(1);
    expect(afterPerformance.uPerfReadout).toBe(3);
    expect(afterPerformance["uReadoutRoll2"]).toBeGreaterThan(firstRoll);
    expect(afterPerformance["uReadoutRoll2"]).toBeLessThan(1);
    expect(
      driver.textureUploads.filter((upload) => upload.unit === driver.gl.TEXTURE1),
    ).toHaveLength(previousOutputUploads);
    expect(driver.textures).toHaveLength(4);
    const maskUploads = driver.textureUploads.filter(
      (upload) => upload.unit === driver.gl.TEXTURE3,
    ).length;
    host.dispatchEvent(new page.realm.CustomEvent("perf-readout-change", { detail: reading }));
    page.clock.now += 40;
    page.clock.frame();
    expect(
      driver.textureUploads.filter((upload) => upload.unit === driver.gl.TEXTURE3),
    ).toHaveLength(maskUploads);
    const rollBeforeHide = driver.draws.at(-1)!["uReadoutRoll2"]!;
    host.dispatchEvent(new page.realm.CustomEvent("perf-readout-change", { detail: null }));
    page.clock.now += 20;
    page.clock.frame();
    expect(driver.draws.at(-1)!.uPerfReadoutOn).toBe(0);
    expect(driver.draws.at(-1)!["uReadoutRoll2"]).toBeGreaterThan(rollBeforeHide);
    expect(driver.draws.at(-1)!["uReadoutRoll2"]).toBeLessThan(1);
    expect(
      driver.textureUploads.filter((upload) => upload.unit === driver.gl.TEXTURE1),
    ).toHaveLength(previousOutputUploads);
    host.dispatchEvent(
      new page.realm.CustomEvent("perf-readout-change", {
        detail: {
          ...reading,
          key: "winner:1540:resting",
          glyphs: [{ ...reading.glyphs[0]!, text: "1,540" }],
        },
      }),
    );
    page.clock.now += 40;
    page.clock.frame();
    expect(
      driver.textureUploads.filter((upload) => upload.unit === driver.gl.TEXTURE3),
    ).toHaveLength(maskUploads + 1);
    expect(driver.programs).toHaveLength(2);
    expect(page.drivers).toHaveLength(1);
    visual.update({ ...frame, value: 30, formattedValue: "30", size: 196, perfReadout: reading });
    page.clock.now += 40;
    page.clock.frame();
    const resizedMask = driver.textureUploads.findLast(
      (upload) => upload.unit === driver.gl.TEXTURE3,
    )!;
    expect(resizedMask.pixels).toMatchObject({ width: 196, height: 196 });
    expect(driver.programs).toHaveLength(2);
    visual.setVisible(false);
    expect(driver.deletedTextures).toEqual(driver.textures);
    expect(driver.deletedPrograms).toHaveLength(0);
    host.dispatchEvent(new page.realm.CustomEvent("perf-readout-change", { detail: reading }));
    expect(page.drivers).toHaveLength(1);
    visual.destroy();
    expect(driver.deletedTextures).toEqual(driver.textures);
  });
});
