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
  const texts: Array<{ text: string; x: number; y: number; font: string; tracking: string }> = [];
  return {
    font: "10px sans-serif",
    letterSpacing: "0px",
    texts,
    restore: noOp,
    save: noOp,
    setTransform: noOp,
    clearRect: noOp,
    beginPath: noOp,
    arc: noOp,
    rect: noOp,
    roundRect: noOp,
    clip: noOp,
    fill: noOp,
    stroke: noOp,
    fillRect: noOp,
    translate: noOp,
    rotate: noOp,
    moveTo: noOp,
    lineTo: noOp,
    closePath: noOp,
    createLinearGradient: () => ({ addColorStop: noOp }),
    createRadialGradient: () => ({ addColorStop: noOp }),
    createConicGradient: () => ({ addColorStop: noOp }),
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, font: this.font, tracking: this.letterSpacing });
    },
    putImageData: noOp,
    drawImage: noOp,
    measureText(value: string) {
      const size = Number(/ ([0-9.]+)px /.exec(this.font)?.[1] || 10);
      return { width: value.length * 8, actualBoundingBoxAscent: 0.72 * size };
    },
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
    uniform2f: (name: string, x: number, y: number) => {
      this.uniforms[name + "0"] = x;
      this.uniforms[name + "1"] = y;
    },
    uniform3fv: noOp,
    uniform4f: (name: string, x: number, y: number, z: number, w: number) => {
      for (const [index, value] of [x, y, z, w].entries()) this.uniforms[name + index] = value;
    },
    uniform4fv: (name: string, values: ArrayLike<number>) => {
      for (let index = 0; index < values.length; index++)
        this.uniforms[name + index] = values[index]!;
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
    nativeFrame: false,
    instanceId: "fixture-orb",
    orbVisible: true,
    nameplatePlacement: "below",
    nameplateMaxWidth: 200,
    maxFps: 60,
    activity: { responseSequence: 0, peakSequence: 0, lastResponseAt: null, lastPeakAt: null },
    preferences: { ...DEFAULT_MONITOR_PREFERENCES, effects: "off", appearance: "dark" },
    effectiveRedline: DEFAULT_MONITOR_PREFERENCES.redline,
    effectiveTitleTheme: DEFAULT_MONITOR_PREFERENCES.titleTheme,
    orbName: "OMP",
    titleThemes: { version: 1, revision: 0, custom: [], draft: null, undo: null, error: false },
    launchAtLogin: { enabled: false, supported: false, error: false },
    effectsPreview: { active: false, sequence: 0, startedAt: null, endsAt: null },
    ompSource: {
      enabled: true,
      folder: "",
      usingDefaultFolder: true,
      status: "ready",
      sessions: 0,
      changing: false,
      canChangeFolder: false,
    },
    orbUndo: null,
    orbManagement: { canSplit: false, canMerge: false, reason: "single-omp-source" },
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
        name: "OMP",
        effectiveRedline: DEFAULT_MONITOR_PREFERENCES.redline,
        titleTheme: DEFAULT_MONITOR_PREFERENCES.titleTheme,
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
  readonly paints: Array<{
    canvas: HTMLCanvasElement;
    texts: Array<{ text: string; x: number; y: number; font: string; tracking: string }>;
  }> = [];
  readonly animations: Array<{
    node: Element;
    keyframes: Keyframe[];
    options: KeyframeAnimationOptions;
    playState: string;
  }> = [];
  readonly mediaQueries: Array<EventTarget & { media: string; matches: boolean }> = [];
  forcedColors = false;
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
    const animations = this.animations;
    Object.defineProperty(this.realm.Element.prototype, "animate", {
      configurable: true,
      value(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
        const animation = {
          node: this,
          keyframes,
          options,
          playState: "running",
          cancel() {
            this.playState = "idle";
          },
          addEventListener: noOp,
          removeEventListener: noOp,
        };
        animations.push(animation);
        return animation;
      },
    });
    Object.defineProperty(this.realm, "matchMedia", {
      configurable: true,
      value: (media: string) => {
        const query = Object.assign(new this.realm.EventTarget(), {
          media,
          matches: media.includes("forced-colors") && this.forcedColors,
        });
        this.mediaQueries.push(query);
        return query;
      },
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
        resizeDashboard: noOp,
      },
    });
    const contexts = new WeakMap<HTMLCanvasElement, { kind: string; value: unknown }>();
    const createGpuContext = (canvas: HTMLCanvasElement) => {
      const driver = new GpuDriver(canvas, this.realm, () => this.compileFailure);
      this.drivers.push(driver);
      return driver.gl;
    };
    const createPaintContext = (canvas: HTMLCanvasElement) => {
      const context = canvas2d();
      this.paints.push({ canvas, texts: context.texts });
      return context;
    };
    vi.spyOn(this.realm.HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
      this: HTMLCanvasElement,
      kind: string,
    ) {
      const current = contexts.get(this);
      if (current) return current.kind === kind ? current.value : null;
      let value: unknown;
      if (kind === "2d") value = createPaintContext(this);
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
    class StaticLayoutObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
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
      "ResizeObserver",
      "IntersectionObserver",
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
      StaticLayoutObserver,
      StaticLayoutObserver,
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
  clickNav(page: "general" | "orb") {
    this.realm.document.getElementById("nav-" + page)!.click();
  }
  async nav(page: "general" | "orb") {
    this.clickNav(page);
    await vi.waitFor(() => {
      expect(
        this.realm.document.querySelector<HTMLElement>(`.settings-page[data-page="${page}"]`)!
          .hidden,
      ).toBe(false);
    });
  }
  setHidden(hidden: boolean) {
    this.hidden = hidden;
    this.realm.document.dispatchEvent(new this.realm.Event("visibilitychange"));
  }
  setForcedColors(enabled: boolean) {
    this.forcedColors = enabled;
    for (const query of this.mediaQueries) {
      if (!query.media.includes("forced-colors")) continue;
      query.matches = enabled;
      query.dispatchEvent(new this.realm.Event("change"));
    }
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
  it("retains one pool across zero leases without hidden drawing", () => {
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
    const initialPrograms = driver.programs.slice(),
      drawsBeforeHide = driver.draws.length;
    for (const { visual } of [led, liquid, small]) visual.setVisible(false);
    expect(page.clock.size).toBe(0);
    page.clock.frame();
    page.clock.runTimers();
    expect(driver.draws).toHaveLength(drawsBeforeHide);
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
    expect(driver.programs).toEqual(initialPrograms);
    for (const { visual } of [led, liquid, small]) visual.destroy();
    expect(driver.deletedPrograms).toHaveLength(0);
    page.visuals.disposeSharedGpu();
    page.visuals.disposeSharedGpu();
    expect(driver.deletedPrograms).toEqual(driver.programs);
    expect(driver.requestLoss).toHaveBeenCalledTimes(1);
    expect(driver.operations.at(-1)).toBe("lose-context");
    driver.restore();
    page.clock.frame();
    expect(driver.programs).toEqual(initialPrograms);
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
    const initialPrograms = driver.programs.slice();
    expect(driver.lose().defaultPrevented).toBe(true);
    expect(first.host.dataset.renderError).toBe("WebGL context lost");
    expect(page.clock.size).toBe(0);
    driver.restore();
    expect(driver.programs).toEqual(initialPrograms);
    page.clock.frame();
    expect(driver.programs).toHaveLength(initialPrograms.length * 2);
    expect(page.drivers).toHaveLength(1);
    expect(first.host.dataset.renderError).toBeUndefined();
    expect(second.host.dataset.renderError).toBeUndefined();
  });

  it("keeps a lost/restored zero-lease pool idle until a preview is shown again", () => {
    const page = new TestPage(),
      preview = page.create();
    preview.visual.update(orbFrame());
    page.clock.frame();
    const driver = page.drivers[0]!;
    const initialPrograms = driver.programs.slice(),
      drawsBeforeHide = driver.draws.length;
    preview.visual.setVisible(false);
    expect(driver.lose().defaultPrevented).toBe(true);
    driver.restore();
    page.clock.frame();
    page.clock.runTimers();
    expect(driver.programs).toEqual(initialPrograms);
    expect(driver.draws).toHaveLength(drawsBeforeHide);
    expect(page.clock.size).toBe(0);
    preview.visual.setVisible(true);
    preview.visual.update(orbFrame());
    page.clock.frame();
    expect(page.drivers).toHaveLength(1);
    expect(driver.programs).toHaveLength(initialPrograms.length * 2);
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
    const initialPrograms = native.programs.slice();
    preview.visual.destroy();
    page.visuals.disposeSharedGpu();
    live.visual.update(orbFrame("led", 148));
    page.clock.now += 100;
    page.clock.frame();
    expect(shared.requestLoss).toHaveBeenCalledTimes(1);
    expect(native.requestLoss).not.toHaveBeenCalled();
    expect(native.programs).toEqual(initialPrograms);
    expect(native.deletedPrograms).toHaveLength(0);
    expect(native.lose().defaultPrevented).toBe(true);
    native.restore();
    page.clock.frame();
    expect(native.programs).toHaveLength(initialPrograms.length * 2);
  });
});

describe("settings first-preview scheduling", () => {
  it("paints the selected page before initializing previews, reuses them on return, and disposes on pagehide", async () => {
    const page = new TestPage();
    await page.start();
    await page.nav("orb");
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
    const initialPrograms = driver.programs.slice();
    await page.nav("general");
    expect(driver.requestLoss).not.toHaveBeenCalled();
    await page.nav("orb");
    page.clock.frame();
    expect(driver.programs).toEqual(initialPrograms);
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
    expect(driver.programs).toEqual(initialPrograms);
    expect(page.clock.size).toBe(0);
  });

  it.each(["before-paint", "after-paint", "before-draw"] as const)(
    "cancels fast tab departure %s without a stale preview draw",
    async (phase) => {
      const page = new TestPage();
      await page.start();
      await page.nav("orb");
      const staleFrame = Array.from(page.clock.frames.values())[0]!;
      if (phase !== "before-paint") page.clock.frame();
      const staleTimer = Array.from(page.clock.timers.values())[0]?.run;
      if (phase === "before-draw") page.clock.runTimers();
      await page.nav("general");
      // A callback already handed to the browser must also reject its cancelled generation.
      staleFrame(page.clock.now);
      staleTimer?.();
      page.clock.frame();
      page.clock.runTimers();
      expect(page.drivers).toHaveLength(0);
      await page.nav("orb");
      page.clock.frame();
      page.clock.runTimers();
      page.clock.frame();
      expect(page.drivers).toHaveLength(1);
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
      await page.nav("orb");
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
      if (reason === "hidden") {
        page.setHidden(false);
        page.clock.frame();
        page.clock.runTimers();
        page.clock.frame();
        expect(page.drivers).toHaveLength(1);
      } else {
        page.deliver(settingsState());
        page.clickNav("orb");
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
    page.clickNav("orb");
    page.pagehide();
    resolve(settingsState());
    await Promise.resolve();
    page.clock.frame();
    page.clock.runTimers();
    expect(page.drivers).toHaveLength(0);
    expect(page.clock.size).toBe(0);
  });
});

function alphabeticBaseline(host: HTMLElement) {
  const number = host.querySelector(".as-orb-number")!;
  const transform = /translate\(([^ ]+) ([^)]+)\)/.exec(number.getAttribute("transform")!)!;
  const glyph = host.querySelector(".as-orb-value text")!;
  return (
    Number(transform[2]) +
    Number(glyph.parentElement!.getAttribute("y")) +
    Number(glyph.getAttribute("y"))
  );
}

describe("native Windows instrument readout boundaries", () => {
  it.each([
    ["led", 0.24, 0.012, 0.116, 0.206],
    ["needle", 0.205, 0.035, 0.115, 0.338],
    ["liquid", 0.24, 0.012, 0.116, 0.206],
    ["reactor", 0.205, 0.03, 0.11, 0.184],
    ["minimal", 0.3, 0.07, null, 0.168],
  ] as const)(
    "keeps %s glyphs on alphabetic baselines at every native size preset",
    (style, font, valueY, unitY, titleY) => {
      const page = new TestPage();
      const { host, visual } = page.create();
      for (const size of [112, 148, 196]) {
        visual.update({ ...orbFrame(style, size), value: 52, formattedValue: "52" });
        const root = host.querySelector(".as-orb-readout")!;
        const number = host.querySelector<SVGElement>(".as-orb-number")!;
        expect(root.namespaceURI).toBe("http://www.w3.org/2000/svg");
        expect(root.getAttribute("viewBox")).toBe(`0 0 ${size} ${size}`);
        expect(alphabeticBaseline(host)).toBeCloseTo((0.5 + valueY) * size, 8);
        expect(parseFloat(number.style.fontSize)).toBe(Math.round(font * size * 4) / 4);
        const unit = host.querySelector<SVGElement>(".as-orb-unit")!;
        if (unitY === null) expect(unit.style.display).toBe("none");
        else expect(Number(unit.getAttribute("y"))).toBeCloseTo((0.5 + unitY) * size, 8);
        const title = /translate\(([^ ]+) ([^)]+)\)/.exec(
          host.querySelector(".as-orb-title-line")!.getAttribute("transform")!,
        )!;
        expect(Number(title[2])).toBeCloseTo((0.5 + titleY) * size, 8);
      }
    },
  );

  it("reserves no upper blank space without supplementary text and preserves the peak-fade stack", () => {
    const page = new TestPage();
    const { host, visual } = page.create();
    visual.update({ ...orbFrame("led", 148), value: 52, formattedValue: "52" });
    const glyph = host.querySelector(".as-orb-value text");
    const baseline = alphabeticBaseline(host);
    const reading = { visible: false, stackOffset: 12, glyphs: [{ text: "Perf", alpha: 1 }] };
    for (const detail of [reading, { ...reading, glyphs: [] }]) {
      host.dispatchEvent(new page.realm.CustomEvent("perf-readout-change", { detail }));
      expect(alphabeticBaseline(host)).toBeCloseTo(baseline, 8);
    }
    host.dispatchEvent(
      new page.realm.CustomEvent("perf-readout-change", {
        detail: { ...reading, visible: true, glyphs: [{ text: "Perf", alpha: 0 }] },
      }),
    );
    expect(alphabeticBaseline(host)).toBeCloseTo(baseline + 12, 8);
    expect(host.querySelector(".as-orb-value text")).toBe(glyph);
    host.dispatchEvent(new page.realm.CustomEvent("perf-readout-change", { detail: null }));
    expect(alphabeticBaseline(host)).toBeCloseTo(baseline, 8);
    expect(host.querySelector(".as-orb-value text")).toBe(glyph);
  });

  it.each(["led", "liquid", "minimal"])(
    "keeps the visible %s SVG supplementary stack when forced colors omits GPU masks",
    (style) => {
      const page = new TestPage();
      page.setForcedColors(true);
      const { host, visual } = page.create();
      visual.update({ ...orbFrame(style, 148), value: 52, formattedValue: "52" });
      const baseline = alphabeticBaseline(host);
      host.dispatchEvent(
        new page.realm.CustomEvent("perf-readout-change", {
          detail: {
            visible: true,
            stackOffset: 12,
            glyphs: [],
            needleLegend: false,
            description: "Perf 1,286; thinking 10 tok/s",
          },
        }),
      );
      expect(alphabeticBaseline(host)).toBeCloseTo(baseline + 12, 8);
      host.dispatchEvent(new page.realm.CustomEvent("perf-readout-change", { detail: null }));
      expect(alphabeticBaseline(host)).toBeCloseTo(baseline, 8);
    },
  );

  it("keeps the needle's real unit above the visible forced-colors supplementary legend", () => {
    const page = new TestPage();
    page.setForcedColors(true);
    const { host, visual } = page.create();
    visual.update({ ...orbFrame("needle", 148), value: 52, formattedValue: "52" });
    host.dispatchEvent(
      new page.realm.CustomEvent("perf-readout-change", {
        detail: {
          visible: true,
          stackOffset: 0,
          glyphs: [],
          needleLegend: true,
          description: "Perf 1,286; thinking 10",
        },
      }),
    );
    expect(Number(host.querySelector(".as-orb-unit")!.getAttribute("y"))).toBeCloseTo(
      (0.5 - 0.254) * 148,
      8,
    );
  });

  it("rolls only changed compact-value characters in the selected unit's real direction", () => {
    const page = new TestPage();
    const { host, visual } = page.create();
    const frame = {
      ...orbFrame("led", 148),
      effects: "soft",
      reduceMotion: false,
      formattedValue: "1.1k",
      readoutValue: 1_100,
      value: 100,
    };
    visual.update(frame);
    page.clock.frame();
    visual.update({ ...frame, formattedValue: "1.2k", readoutValue: 1_200, value: 90 });
    const rolls = page.animations.filter((animation) => animation.options.duration === 240);
    expect(rolls).toHaveLength(2);
    expect(rolls.map((animation) => animation.node.textContent)).toEqual(["1", "2"]);
    expect(rolls[0]!.keyframes[1]!.transform).toMatch(/^translateY\(-/);
    expect(rolls[1]!.keyframes[0]!.transform).not.toMatch(/^translateY\(-/);
    for (const animation of rolls) {
      const clip = animation.node.parentElement!;
      expect(clip.getAttribute("overflow")).toBe("hidden");
      expect(Number(clip.getAttribute("height"))).toBeCloseTo(
        1.12 * parseFloat(host.querySelector<SVGElement>(".as-orb-number")!.style.fontSize),
        8,
      );
    }
    visual.update({ ...frame, formattedValue: "1.2k", size: 196 });
    expect(rolls.every((animation) => animation.playState === "idle")).toBe(true);
  });

  it("keeps a partial-cost prefix small and baseline-aligned without changing token heat", () => {
    const page = new TestPage();
    const { host, visual } = page.create();
    visual.update({
      ...orbFrame("led", 148),
      formattedValue: "0.0012",
      readoutValue: 0.0012,
      unit: "US$/s",
      atLeast: true,
    });
    page.clock.frame();
    const number = host.querySelector<SVGElement>(".as-orb-number")!;
    const prefix = host.querySelector<SVGElement>(".as-orb-prefix")!;
    expect(prefix.textContent).toBe("≥");
    expect(parseFloat(prefix.style.fontSize)).toBe(
      Math.round(0.6 * parseFloat(number.style.fontSize) * 4) / 4,
    );
    expect(Number(prefix.getAttribute("y"))).toBe(0);
    expect(host.getAttribute("aria-label")).toContain("≥0.0012 US$/s");
    expect(page.drivers[0]!.draws.at(-1)!.uH).toBeCloseTo(Math.pow(20 / 200, 0.6), 8);
  });

  it("uses the native liquid typefaces and rolls only changed mask cells", () => {
    const page = new TestPage();
    const { visual } = page.create();
    const frame = {
      ...orbFrame("liquid", 148),
      effects: "soft",
      reduceMotion: false,
      value: 120,
      formattedValue: "120",
    };
    visual.update(frame);
    page.clock.frame();
    visual.update({ ...frame, value: 121, formattedValue: "121" });
    page.clock.frame();
    const draw = page.drivers[0]!.draws.at(-1)!;
    expect(draw.uReadoutCellCount).toBe(3);
    expect([draw.uReadoutCells2, draw.uReadoutCells6, draw.uReadoutCells10]).toEqual([0, 0, 1]);
    const text = page.paints.flatMap((paint) => paint.texts);
    expect(text.find((call) => call.text === "1")!.font).toContain('"Segoe UI Variable Display"');
    expect(text.find((call) => call.text === "tok/s")!.font).toContain('"Segoe UI Variable Text"');
    expect(text.find((call) => call.text === "Cruising")!.font).toContain(
      '"Segoe UI Variable Text"',
    );
    expect(text.find((call) => call.text === "1")!.y).toBeCloseTo(0.012 * 148, 8);
  });

  it("keeps a single native heat texture across preview size, appearance and visibility changes", () => {
    const page = new TestPage();
    const { visual } = page.create();
    visual.update(orbFrame("led", 148));
    page.clock.frame();
    const driver = page.drivers[0]!;
    for (const [size, appearance] of [
      [112, "light"],
      [196, "dark"],
      [148, "light"],
    ] as const) {
      visual.update({ ...orbFrame("led", size), appearance });
      page.clock.frame();
      visual.setVisible(false);
      visual.setVisible(true);
      page.clock.frame();
    }
    expect(page.drivers).toHaveLength(1);
    const paletteUploads = driver.textureUploads.filter(
      (upload) => upload.unit === driver.gl.TEXTURE0 + 4,
    );
    expect(paletteUploads).toHaveLength(1);
    expect(paletteUploads[0]!.pixels).toMatchObject({ width: 256, height: 1 });
    visual.destroy();
    expect(driver.deletedTextures).toHaveLength(0);
    page.visuals.disposeSharedGpu();
    expect(driver.deletedTextures).toEqual(driver.textures);
  });

  it("draws every high-contrast style without a shader and returns to the retained preview GPU", () => {
    const page = new TestPage();
    const { host, visual } = page.create();
    visual.update(orbFrame("led", 148));
    page.clock.frame();
    const driver = page.drivers[0]!;
    const initialPrograms = driver.programs.slice(),
      drawsBeforeContrast = driver.draws.length;
    page.setForcedColors(true);
    for (const style of ["led", "needle", "liquid", "reactor", "minimal"]) {
      visual.update(orbFrame(style, 148));
      page.clock.frame();
      expect(host.querySelector<HTMLElement>(".as-orb-gl")!.style.display).toBe("none");
      expect(host.querySelector<HTMLElement>(".as-orb-paint")!.style.visibility).toBe("visible");
    }
    expect(driver.draws).toHaveLength(drawsBeforeContrast);
    expect(driver.deletedPrograms).toHaveLength(0);
    page.setForcedColors(false);
    visual.update(orbFrame("liquid", 148));
    page.clock.frame();
    expect(page.drivers).toHaveLength(1);
    expect(driver.programs).toEqual(initialPrograms);
    const drawsBeforeDestroy = driver.draws.length;
    visual.destroy();
    page.setForcedColors(true);
    page.clock.frame();
    expect(driver.draws).toHaveLength(drawsBeforeDestroy);
    expect(page.clock.size).toBe(0);
  });

  it.each([false, true])(
    "follows real metric heat with effects off and reduceMotion=%s without running decorative motion",
    (reduceMotion) => {
      const page = new TestPage();
      const { host, visual } = page.create();
      const frame = { ...orbFrame("led", 148), reduceMotion };
      visual.update(frame);
      page.clock.frame();
      const driver = page.drivers[0]!,
        initialHeat = driver.draws.at(-1)!.uH!;
      visual.update({ ...frame, value: 100, formattedValue: "100" });
      page.clock.frame();
      page.clock.frame();
      const target = Math.pow(100 / 200, 0.6),
        following = driver.draws.at(-1)!.uH!;
      expect(following).toBeGreaterThan(initialHeat);
      expect(following).toBeLessThan(target);
      expect(host.querySelector(".as-orb-value")!.textContent).toBe("100");
      for (let i = 0; i < 180; i++) page.clock.frame();
      expect(driver.draws.at(-1)!.uH).toBeCloseTo(target, 3);
      expect(
        driver.draws.every(
          (draw) =>
            draw.uMoving === 0 && draw.uFlow === 0 && draw.uComet === 0 && draw.uSilkClock === 0,
        ),
      ).toBe(true);
      expect(page.drivers).toHaveLength(1);
      visual.setVisible(false);
      expect(page.clock.size).toBe(0);
    },
  );

  it("publishes the native hover spring to the nameplate consumer and snaps spatial hover under reduced motion", () => {
    const page = new TestPage();
    const { host, visual } = page.create();
    const frame = { ...orbFrame("led", 148), reduceMotion: false };
    const scales: number[] = [];
    host.addEventListener("orb-hover-scale", (event) =>
      scales.push((event as CustomEvent<number>).detail),
    );
    visual.update(frame);
    page.clock.frame();
    visual.update({ ...frame, hovered: true });
    for (let i = 0; i < 120; i++) page.clock.frame();
    expect(scales.some((scale) => scale > 1 && scale < 1.03)).toBe(true);
    expect(Math.max(...scales)).toBeGreaterThan(1.03);
    expect(scales.at(-1)).toBe(1.03);
    expect(
      scales.every((scale) => Math.abs(scale * 2_000 - Math.round(scale * 2_000)) < 1e-8),
    ).toBe(true);
    scales.length = 0;
    visual.update({ ...frame, reduceMotion: true, hovered: false });
    page.clock.frame();
    page.clock.frame();
    expect(scales).toEqual([1]);
    expect(page.drivers).toHaveLength(1);
    visual.setVisible(false);
    visual.destroy();
    for (let i = 0; i < 20; i++) page.clock.frame();
    expect(scales).toEqual([1]);
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
    expect(page.drivers).toHaveLength(1);
    visual.update({ ...frame, value: 30, formattedValue: "30", size: 196, perfReadout: reading });
    page.clock.now += 40;
    page.clock.frame();
    const resizedMask = driver.textureUploads.findLast(
      (upload) => upload.unit === driver.gl.TEXTURE3,
    )!;
    expect(resizedMask.pixels).toMatchObject({ width: 196, height: 196 });
    visual.setVisible(false);
    expect(driver.deletedTextures).toEqual(driver.textures);
    expect(driver.deletedPrograms).toHaveLength(0);
    host.dispatchEvent(new page.realm.CustomEvent("perf-readout-change", { detail: reading }));
    expect(page.drivers).toHaveLength(1);
    visual.destroy();
    expect(driver.deletedTextures).toEqual(driver.textures);
  });
});
