import { BrowserWindow } from "electron";
import type { Event as ElectronEvent, IpcMainEvent, IpcMainInvokeEvent, Rectangle } from "electron";
import { z } from "zod";
import {
  MONITOR_PERF_CARD_METRICS,
  type OmpMonitorPerfCardRequest,
  type OmpMonitorPerfCardSize,
  type OmpMonitorPerfCardState,
} from "./perf-card-types.js";
import {
  monitorPerfCardArea,
  placeMonitorPerfCard,
  type MonitorDisplay,
} from "./window-geometry.js";
import type { OmpMonitorViewState } from "./view-types.js";

const PERF_CARD_URL = "omp-desktop://monitor/local-perf-card";
const HIDE_MILLISECONDS = 100;
const MAX_MEASURED_HEIGHT = 32_768;
const PerfCardRequestSchema = z
  .object({
    agentId: z.string().min(1),
    anchor: z
      .object({
        x: z.number().finite().nonnegative(),
        y: z.number().finite().nonnegative(),
        width: z.number().finite().positive().max(32_768),
        height: z.number().finite().positive().max(32_768),
      })
      .strict(),
    rowTop: z.number().finite(),
    topCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    subAgents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    facts: z
      .array(z.string().max(1024))
      .max(16)
      .refine((facts) => facts.reduce((length, fact) => length + fact.length, 0) <= 4096),
  })
  .strict();
const PerfCardSizeSchema = z
  .object({
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    height: z.number().finite().positive().max(MAX_MEASURED_HEIGHT),
    compact: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  })
  .strict();

interface PerfCardOwner {
  window: BrowserWindow;
  surface: "dashboard" | "board";
  readState(): OmpMonitorViewState | null;
}
interface ActivePerfCard {
  owner: PerfCardOwner;
  source: string;
  request: OmpMonitorPerfCardRequest;
}
interface PerfCardContext {
  view: OmpMonitorViewState;
  anchor: Rectangle;
  rowTop: number;
  area: Rectangle;
}

function sourceUnavailable(view: OmpMonitorViewState): boolean {
  const source = view.ompSource;
  return (
    !!view.workerError ||
    source.changing ||
    source.status === "disabled" ||
    source.status === "missing" ||
    source.status === "error"
  );
}

/** Renderer coordinates are client DIP only; native screen origins never cross this boundary. */
function validRequest(
  value: OmpMonitorPerfCardRequest,
  owner: PerfCardOwner,
  view: OmpMonitorViewState,
): boolean {
  const snapshot = view.snapshot;
  if (
    !snapshot ||
    snapshot.status === "error" ||
    snapshot.status === "unavailable" ||
    sourceUnavailable(view) ||
    (owner.surface === "board"
      ? !view.board?.visible || !view.board.showPerformance
      : !view.preferences.showPerformance) ||
    !snapshot.agents.some((agent) => agent.id === value.agentId) ||
    value.topCount > snapshot.agents.length ||
    value.subAgents >= snapshot.agents.length ||
    (owner.surface === "dashboard" &&
      (value.topCount !== 0 || value.subAgents !== 0 || value.facts.length !== 0))
  )
    return false;
  const bounds = owner.window.getContentBounds();
  const { x, y, width, height } = value.anchor;
  // A partially clipped row can start above its panel or viewport; preserve its exact top.
  return (
    x + width <= bounds.width &&
    y + height <= bounds.height &&
    value.rowTop >= -bounds.height &&
    value.rowTop <= 2 * bounds.height
  );
}

function sourceIdentity(view: OmpMonitorViewState): string {
  return JSON.stringify([
    view.instanceId,
    view.scope.profile,
    view.scope.project,
    view.ompSource.folder,
  ]);
}

/** One lazy, private tooltip: never a normal monitor surface and never an IPC-authorized host. */
export class OmpMonitorPerfCardWindow {
  private window: BrowserWindow | null = null;
  private loaded = false;
  private ready = false;
  private disposed = false;
  private active: ActivePerfCard | null = null;
  private state: OmpMonitorPerfCardState | null = null;
  private sequence = 0;
  private measured: OmpMonitorPerfCardSize | null = null;
  private lastHeight: number | null = null;
  private hideTimer: NodeJS.Timeout | undefined;
  private readonly ownerListeners: Array<() => void> = [];
  private readonly popupListeners: Array<() => void> = [];

  constructor(
    private readonly options: {
      webPreferences: Electron.WebPreferences;
      displays(): readonly MonitorDisplay[];
      ignoreMouse(window: BrowserWindow): void;
    },
  ) {}

  show(owner: PerfCardOwner, value: unknown): void {
    if (
      this.disposed ||
      owner.window.isDestroyed() ||
      !owner.window.isVisible() ||
      owner.window.isMinimized()
    )
      return;
    const parsed = PerfCardRequestSchema.safeParse(value);
    const view = owner.readState();
    if (!parsed.success || !view || !validRequest(parsed.data, owner, view)) return;
    clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    if (this.active?.owner.window !== owner.window) {
      this.removeOwnerListeners();
      this.attachOwner(owner.window);
    }
    const request = parsed.data;
    this.active = { owner, source: sourceIdentity(view), request };
    this.measured = null;
    const context = this.context();
    if (!context) {
      this.dismiss(owner.window, true);
      return;
    }
    this.updateState(context);
    try {
      this.ensureWindow();
      this.publish();
      if (this.window?.isVisible() && this.lastHeight !== null)
        this.position(context, this.lastHeight);
    } catch {
      this.close();
    }
  }

  readyFrom(event: IpcMainInvokeEvent): OmpMonitorPerfCardState {
    this.authorize(event);
    if (!this.state) throw new Error("Performance tooltip is unavailable");
    this.ready = true;
    return this.state;
  }

  resizeFrom(event: IpcMainInvokeEvent, value: unknown): void {
    this.authorize(event);
    const parsed = PerfCardSizeSchema.safeParse(value);
    if (!parsed.success) throw new Error("Invalid performance tooltip size");
    const size = parsed.data;
    // A late font/layout completion is harmless, including one from a dismissed row.
    if (!this.active || !this.state?.request || size.sequence !== this.state.sequence) return;
    if (size.height > this.state.maxCardHeight && size.compact !== 2)
      throw new Error("Performance tooltip must compact before reporting its height");
    this.measured = { ...size, height: Math.ceil(size.height) };
    this.lastHeight = this.measured.height;
    this.present();
  }

  refresh(ownerWindow?: BrowserWindow): void {
    if (!this.active || (ownerWindow && this.active.owner.window !== ownerWindow)) return;
    const context = this.context();
    if (!context) {
      this.dismiss(this.active.owner.window, true);
      return;
    }
    this.updateState(context);
    this.measured = null;
    try {
      this.publish();
      if (this.window?.isVisible() && this.lastHeight !== null)
        this.position(context, this.lastHeight);
    } catch {
      this.close();
    }
  }

  dismiss(ownerWindow: BrowserWindow, immediate = false): void {
    if (this.active?.owner.window !== ownerWindow) return;
    this.active = null;
    this.measured = null;
    this.removeOwnerListeners();
    clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    const sequence = ++this.sequence;
    if (this.state) this.state = { ...this.state, sequence, request: null };
    this.publish();
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    if (immediate || !window.isVisible()) {
      window.hide();
      return;
    }
    // Invalidate immediately, but leave the independent document time for its 100ms fade.
    this.hideTimer = setTimeout(() => {
      this.hideTimer = undefined;
      if (
        this.window === window &&
        !window.isDestroyed() &&
        !this.active &&
        this.sequence === sequence
      )
        window.hide();
    }, HIDE_MILLISECONDS);
  }

  close(): void {
    ++this.sequence;
    this.active = null;
    this.state = null;
    this.measured = null;
    this.lastHeight = null;
    this.loaded = false;
    this.ready = false;
    clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    this.removeOwnerListeners();
    for (const remove of this.popupListeners.splice(0)) remove();
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  dispose(): void {
    this.disposed = true;
    this.close();
  }

  private authorize(event: IpcMainInvokeEvent | IpcMainEvent): void {
    const window = this.window;
    if (
      this.disposed ||
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("Unauthorized performance tooltip sender");
  }

  private context(): PerfCardContext | null {
    const active = this.active;
    if (!active || this.disposed) return null;
    const { owner, request } = active;
    const window = owner.window;
    if (
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      !window.isVisible() ||
      window.isMinimized()
    )
      return null;
    const view = owner.readState();
    if (!view || sourceIdentity(view) !== active.source || !validRequest(request, owner, view))
      return null;
    const content = window.getContentBounds();
    const anchor = {
      ...request.anchor,
      x: content.x + request.anchor.x,
      y: content.y + request.anchor.y,
    };
    return {
      view,
      anchor,
      rowTop: content.y + request.rowTop,
      area: monitorPerfCardArea(anchor, this.options.displays()),
    };
  }

  private updateState(context: PerfCardContext): void {
    const active = this.active!;
    const spot = placeMonitorPerfCard(
      context.anchor,
      context.rowTop,
      this.lastHeight ?? 0,
      context.area,
    );
    this.state = {
      sequence: ++this.sequence,
      request: active.request,
      view: context.view,
      maxCardHeight: Math.max(0, context.area.height - 2 * MONITOR_PERF_CARD_METRICS.inset),
      slideFrom: spot.slideFrom,
    };
  }

  private publish(): void {
    if (
      !this.ready ||
      !this.state ||
      !this.window ||
      this.window.isDestroyed() ||
      this.window.webContents.isDestroyed()
    )
      return;
    try {
      this.window.webContents.send("paseo:monitor:perf-card-state", this.state);
    } catch {
      this.close();
    }
  }

  private present(): void {
    const window = this.window;
    const measured = this.measured;
    if (
      !window ||
      window.isDestroyed() ||
      !this.loaded ||
      !this.ready ||
      !this.state?.request ||
      measured?.sequence !== this.state.sequence
    )
      return;
    const context = this.context();
    if (!context) {
      if (this.active) this.dismiss(this.active.owner.window, true);
      return;
    }
    try {
      this.position(context, measured.height);
      if (!window.isVisible()) window.showInactive();
    } catch {
      this.close();
    }
  }

  private position(context: PerfCardContext, height: number): void {
    if (!this.window || !this.active) return;
    const spot = placeMonitorPerfCard(context.anchor, context.rowTop, height, context.area);
    const { width, shadow } = MONITOR_PERF_CARD_METRICS;
    this.window.setBounds({
      x: Math.round(spot.x - shadow.left),
      y: Math.round(spot.y - shadow.top),
      width: width + shadow.left + shadow.right,
      height: Math.ceil(height) + shadow.top + shadow.bottom,
    });
  }

  private attachOwner(window: BrowserWindow): void {
    const events: NodeJS.EventEmitter = window;
    const dismiss = () => this.dismiss(window, true);
    const reposition = () => this.refresh(window);
    for (const event of ["hide", "close", "closed", "blur", "minimize", "unresponsive"]) {
      events.on(event, dismiss);
      this.ownerListeners.push(() => events.removeListener(event, dismiss));
    }
    for (const event of ["move", "moved", "resize"]) {
      events.on(event, reposition);
      this.ownerListeners.push(() => events.removeListener(event, reposition));
    }
    window.webContents.on("render-process-gone", dismiss);
    this.ownerListeners.push(() =>
      window.webContents.removeListener("render-process-gone", dismiss),
    );
  }

  private removeOwnerListeners(): void {
    for (const remove of this.ownerListeners.splice(0)) remove();
  }

  private ensureWindow(): void {
    if (this.window && !this.window.isDestroyed()) return;
    const { width, shadow } = MONITOR_PERF_CARD_METRICS;
    const window = new BrowserWindow({
      x: 0,
      y: 0,
      width: width + shadow.left + shadow.right,
      height: 1 + shadow.top + shadow.bottom,
      minWidth: 1,
      minHeight: 1,
      // The pinned runtime otherwise defaults maximums to the primary screen size.
      maxWidth: width + shadow.left + shadow.right,
      maxHeight: MAX_MEASURED_HEIGHT + shadow.top + shadow.bottom,
      show: false,
      transparent: true,
      frame: false,
      backgroundColor: "#00000000",
      hasShadow: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      webPreferences: this.options.webPreferences,
    });
    this.window = window;
    const events: NodeJS.EventEmitter = window;
    const contentsEvents: NodeJS.EventEmitter = window.webContents;
    // mini-electron 0.1.28's setIgnoreMouseEvents only discards internally. The shared
    // adapter also binds this exact HWND/PID and applies native LAYERED + TRANSPARENT.
    this.options.ignoreMouse(window);
    const lost = () => {
      if (this.window === window) this.close();
    };
    const prevent = (event: ElectronEvent) => event.preventDefault();
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    for (const event of [
      "will-navigate",
      "will-frame-navigate",
      "will-redirect",
      "will-attach-webview",
    ]) {
      contentsEvents.on(event, prevent);
      this.popupListeners.push(() => contentsEvents.removeListener(event, prevent));
    }
    for (const event of ["closed", "unresponsive"]) {
      events.on(event, lost);
      this.popupListeners.push(() => events.removeListener(event, lost));
    }
    for (const event of ["render-process-gone", "destroyed"]) {
      contentsEvents.on(event, lost);
      this.popupListeners.push(() => contentsEvents.removeListener(event, lost));
    }
    void window
      .loadURL(PERF_CARD_URL)
      .then(() => {
        if (this.window !== window || window.isDestroyed()) return undefined;
        this.loaded = true;
        this.present();
        return undefined;
      })
      .catch(lost);
  }
}
