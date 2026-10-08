import { useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { useAppSettings } from "@/hooks/use-settings";
import { isElectronRuntime } from "@/desktop/host";
import { buildWallpaperMediaSrc } from "@/wallpaper/media-src";
import type { WallpaperFrame } from "@/wallpaper/types";

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".m4v", ".mov", ".ogv"]);

function isVideoPath(s: string): boolean {
  const dot = s.lastIndexOf(".");
  if (dot < 0) return false;
  return VIDEO_EXTENSIONS.has(s.slice(dot).toLowerCase());
}

const WALLPAPER_LAYER_ID = "paseo-wallpaper-layer";
const WALLPAPER_CSS_ID = "paseo-wallpaper-css";

/**
 * Convert a hex color (#RRGGBB) to an rgba() string with the given alpha.
 */
function hexToRgba(hex: string, alpha: number): string {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The CSS custom property names that Unistyles uses for surface backgrounds.
 * Unistyles classes reference these via `var(--colors-surface0)` etc.
 * Overriding them on :root.<themeClass> makes every surface-colored element
 * semi-transparent simultaneously — no need to touch individual elements.
 */
const SURFACE_VARS = [
  "--colors-surface0",
  "--colors-surface1",
  "--colors-surface2",
  "--colors-surface3",
  "--colors-surface4",
  "--colors-surface-sidebar",
  "--colors-background",
  "--colors-popover",
  "--colors-secondary",
  "--colors-muted",
  "--colors-input",
] as const;

/**
 * Read the original (unmodified) surface variable values from the DOM.
 * Temporarily removes the override <style> to read the true theme values,
 * then restores it. Returns a map of varName → hex string.
 */
function readOriginalSurfaceVars(): Map<string, string> {
  const result = new Map<string, string>();
  if (typeof document === "undefined") return result;

  const cssEl = document.getElementById(WALLPAPER_CSS_ID);
  const hadOverride = !!cssEl;
  const savedText = cssEl?.textContent ?? "";

  if (cssEl) cssEl.remove();

  const rootStyle = document.documentElement.style;
  const savedInline: Record<string, string> = {};
  for (const v of SURFACE_VARS) {
    savedInline[v] = rootStyle.getPropertyValue(v);
    rootStyle.removeProperty(v);
  }

  void document.documentElement.offsetHeight;

  const cs = window.getComputedStyle(document.documentElement);
  for (const v of SURFACE_VARS) {
    const val = cs.getPropertyValue(v).trim();
    if (val) result.set(v, val);
  }

  for (const [v, val] of Object.entries(savedInline)) {
    if (val) rootStyle.setProperty(v, val);
  }

  if (hadOverride && cssEl) {
    cssEl.textContent = savedText;
    document.head.appendChild(cssEl);
  }

  return result;
}

/**
 * Walk #root subtree and make elements whose background-color matches a
 * known surface literal semi-transparent, so the wallpaper shows through.
 * Unistyles injects literal rgb() values into CSS classes — CSS variable
 * overrides alone cannot reach them.
 *
 * Large window-filling containers follow the veil alpha (= 1 - slider);
 * smaller cards/inputs keep alpha >= 0.85 for readability.
 */
/**
 * Latest sync options + vars, kept so the MutationObserver can re-apply the
 * literal-color override whenever React remounts containers (route changes,
 * page switches) without re-running the whole effect.
 */
let latestSyncOpts: {
  dataUrl: string | null;
  videoSrc: string | null;
  opacity: number;
  visible: boolean;
} | null = null;
let latestCachedVars: Map<string, string> | null = null;

/** Non-zero while we are writing styles we ourselves own (observer mute). */
let wallpaperWriteDepth = 0;

function applyLiteralSurfaceOverride(targetColors: Set<string>, surfaceAlpha: number) {
  if (typeof document === "undefined") return;
  const root = document.getElementById("root");
  if (!root) return;

  // Clean up previously marked elements
  root.querySelectorAll<HTMLElement>("[data-wp-literal]").forEach((el) => {
    if (el.dataset.wpLiteral === "saved") {
      el.style.backgroundColor = el.dataset.wpBg || "";
    }
    el.removeAttribute("data-wp-literal");
    delete el.dataset.wpBg;
    delete el.dataset.wpLiteral;
  });

  // Suppress the MutationObserver while we write inline styles, so our own
  // attribute mutations don't re-trigger a re-apply loop.
  wallpaperWriteDepth++;
  try {
    const elements = root.querySelectorAll<HTMLElement>(
      "div, main, aside, section, header, footer, nav, article",
    );
    // Large full-window containers often appear as N stacked duplicates
    // (nested RN Web wrappers / repeated mounts). Applying the veil alpha to
    // every one of them composites to an opaque slab (1-(1-a)^N) and kills
    // the wallpaper. Only the topmost one (last in document order = painted
    // last) carries the veil; the rest go fully transparent — they were
    // occluded before the override anyway, so nothing visible changes.
    let veilEl: HTMLElement | null = null;
    for (const el of elements) {
      if (el.id === WALLPAPER_LAYER_ID) continue;
      const cs = getComputedStyle(el);
      if (!targetColors.has(cs.backgroundColor)) continue;
      const r = el.getBoundingClientRect();
      if (r.width >= 700 && r.height >= 600) {
        veilEl = el; // keep advancing; last one wins
      }
    }
    for (const el of elements) {
      if (el.id === WALLPAPER_LAYER_ID) continue;
      const cs = getComputedStyle(el);
      if (!targetColors.has(cs.backgroundColor)) continue;
      const r = el.getBoundingClientRect();
      const isLargeContainer = r.width >= 700 && r.height >= 600;
      let alpha = Math.max(surfaceAlpha, 0.85);
      if (isLargeContainer) {
        alpha = el === veilEl ? surfaceAlpha : 0;
      }
      if (alpha >= 0.999) continue;
      const m = cs.backgroundColor.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) continue;
      el.dataset.wpLiteral = "saved";
      el.dataset.wpBg = el.style.backgroundColor;
      el.style.backgroundColor = `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
    }
  } finally {
    wallpaperWriteDepth--;
  }
}

/**
 * Re-apply only the literal-color override using the last-known options.
 * Safe to call from a debounced MutationObserver tick.
 */
function reapplyLiteralOverride() {
  if (wallpaperWriteDepth > 0) return;
  const opts = latestSyncOpts;
  const vars = latestCachedVars;
  if (!opts || !vars) return;
  if (!opts.visible || (!opts.dataUrl && !opts.videoSrc)) return;
  const surfaceAlpha = Math.max(0, 1 - opts.opacity);
  const overrideColors = new Set<string>();
  const addHex = (hex: string | undefined) => {
    if (!hex) return;
    const m = hex.match(/^#([0-9a-f]{6})$/i);
    if (m) {
      const r = parseInt(m[1].slice(0, 2), 16);
      const g = parseInt(m[1].slice(2, 4), 16);
      const b = parseInt(m[1].slice(4, 6), 16);
      overrideColors.add(`rgb(${r}, ${g}, ${b})`);
    }
  };
  for (const name of [
    "--colors-surface0",
    "--colors-surface1",
    "--colors-surface2",
    "--colors-surface3",
    "--colors-surface4",
    "--colors-surface-sidebar",
    "--colors-background",
  ]) {
    addHex(vars.get(name));
  }
  overrideColors.add("rgb(242, 242, 242)");
  overrideColors.add("rgb(255, 255, 255)");
  if (overrideColors.size > 0) {
    applyLiteralSurfaceOverride(overrideColors, surfaceAlpha);
  }
}

/**
 * Inject a fixed-position wallpaper layer at z-index 0 (behind #root)
 * and make surface backgrounds semi-transparent so the wallpaper shows through.
 *
 * Architecture:
 *   z:0  wallpaper layer (image/video, opacity = user slider value)
 *   z:auto  #root (normal app UI)
 *
 * Two complementary mechanisms:
 *   1. CSS variable override for elements referencing var(--colors-surface0)
 *   2. JS subtree walk for Unistyles-injected literal rgb() values
 *
 * surface0/background alpha = 1 - opacity (veil: 0 → wallpaper visible, 1 → opaque)
 * surface1-4 keep alpha >= 0.85 for readability
 */
function syncWallpaperLayer(
  opts: {
    dataUrl: string | null;
    videoSrc: string | null;
    opacity: number;
    visible: boolean;
  },
  cachedVars: Map<string, string>,
) {
  if (Platform.OS !== "web") return;

  latestSyncOpts = { ...opts };
  latestCachedVars = cachedVars;

  const doc = document;
  let layer = doc.getElementById(WALLPAPER_LAYER_ID);
  let css = doc.getElementById(WALLPAPER_CSS_ID);

  // --- Teardown when wallpaper not visible ---
  if (!opts.visible || (!opts.dataUrl && !opts.videoSrc)) {
    latestSyncOpts = null;
    if (layer) layer.remove();
    if (css) css.remove();
    doc.body.style.backgroundColor = "";
    doc.documentElement.style.backgroundColor = "";
    const root = doc.getElementById("root");
    if (root) {
      root.style.backgroundColor = "";
      root.style.position = "";
      root.style.zIndex = "";
      // Restore any literal-colored elements we modified
      root.querySelectorAll<HTMLElement>("[data-wp-literal]").forEach((el) => {
        el.style.backgroundColor = el.dataset.wpBg || "";
        el.removeAttribute("data-wp-literal");
        delete el.dataset.wpBg;
      });
    }
    return;
  }

  // --- Create wallpaper layer at z:0 (lowest, below root) ---
  if (!layer) {
    layer = doc.createElement("div");
    layer.id = WALLPAPER_LAYER_ID;
    layer.style.cssText =
      "position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:0;pointer-events:none;background-size:cover;background-position:center;background-repeat:no-repeat;";
    doc.body.insertBefore(layer, doc.body.firstChild);
  }

  // --- Wallpaper layer always renders at full brightness; the veil below
  // (surface alpha = 1 - slider) alone controls how much wallpaper shows.
  // Layering its own opacity on top would blend with the window background
  // color behind it, polluting the wallpaper's colors. ---
  layer.style.display = "block";
  layer.style.opacity = "1";

  // --- CSS variable override ---
  const surfaceAlpha = Math.max(0, 1 - opts.opacity);
  const rootEl = doc.documentElement;
  const overrides: string[] = [];

  for (const varName of SURFACE_VARS) {
    const originalValue = cachedVars.get(varName);
    if (!originalValue) continue;
    if (varName === "--colors-surface0" || varName === "--colors-background") {
      overrides.push(`${varName}: ${hexToRgba(originalValue, surfaceAlpha)};`);
    } else {
      const tierAlpha = Math.max(surfaceAlpha, 0.85);
      overrides.push(`${varName}: ${hexToRgba(originalValue, tierAlpha)};`);
    }
  }

  const themeClass = rootEl.className.trim().split(/\s+/)[0];
  const selector = themeClass ? `:root.${themeClass}` : ":root";

  if (!css) {
    css = doc.createElement("style");
    css.id = WALLPAPER_CSS_ID;
    doc.head.appendChild(css);
  }
  css.textContent = `${selector} { ${overrides.join(" ")} }`;

  // --- Literal color override (for Unistyles-injected rgb() values) ---
  reapplyLiteralOverride();

  // --- Make body/root backgrounds transparent ---
  doc.body.style.backgroundColor = "transparent";
  doc.documentElement.style.backgroundColor = "transparent";
  const root = doc.getElementById("root");
  if (root) {
    root.style.backgroundColor = "transparent";
    root.style.position = "relative";
    root.style.zIndex = "1";
  }

  if (opts.videoSrc) {
    layer.innerHTML = `<video autoplay loop muted playsinline src="${opts.videoSrc.replace(/"/g, "&quot;")}" style="width:100%;height:100%;object-fit:cover"></video>`;
    layer.style.backgroundImage = "";
  } else if (opts.dataUrl) {
    layer.innerHTML = "";
    layer.style.backgroundImage = `url("${opts.dataUrl}")`;
  }
}

export function WallpaperBackground() {
  const { settings } = useAppSettings();
  const [frame, setFrame] = useState<WallpaperFrame | null>(null);
  const [error, setError] = useState(false);
  const desktop = typeof window !== "undefined" ? (window.paseoDesktop ?? null) : null;

  const [htmlClass, setHtmlClass] = useState<string>(
    typeof document !== "undefined" ? document.documentElement.className : "",
  );

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const observer = new MutationObserver(() => {
      setHtmlClass(document.documentElement.className);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  // Cache original surface vars, re-read when theme changes
  const cachedVarsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (Platform.OS !== "web") return;
    cachedVarsRef.current = readOriginalSurfaceVars();
  }, [htmlClass]);

  const isVideo = useMemo(() => {
    if (!settings.wallpaperEnabled) return false;
    if (settings.wallpaperSource === "file" && settings.wallpaperPath) {
      return isVideoPath(settings.wallpaperPath);
    }
    if (settings.wallpaperSource === "url" && settings.wallpaperUrl) {
      return isVideoPath(settings.wallpaperUrl);
    }
    return false;
  }, [
    settings.wallpaperEnabled,
    settings.wallpaperSource,
    settings.wallpaperPath,
    settings.wallpaperUrl,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (!settings.wallpaperEnabled) {
      setFrame(null);
      setError(false);
      return;
    }

    if (isVideo) {
      setFrame(null);
      setError(false);
      return;
    }

    if (!isElectronRuntime()) {
      setFrame(null);
      return;
    }

    const fetchFrame = async () => {
      const source = settings.wallpaperSource;
      const path = settings.wallpaperPath;
      const url = settings.wallpaperUrl;
      if (!desktop || typeof desktop.invoke !== "function") {
        if (!cancelled) setFrame(null);
        return;
      }
      const invoke = desktop.invoke;

      try {
        if (source === "file" && path) {
          const result = await invoke("paseo:wallpaper:getFrame", { path });
          if (!cancelled) setFrame((result ?? null) as WallpaperFrame | null);
        } else if (source === "url" && url) {
          const result = await invoke("paseo:wallpaper:getFrame", { url });
          if (!cancelled) setFrame((result ?? null) as WallpaperFrame | null);
        } else {
          if (!cancelled) setFrame(null);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    };

    fetchFrame().catch(() => {
      if (!cancelled) setError(true);
    });

    return () => {
      cancelled = true;
    };
  }, [
    settings.wallpaperEnabled,
    settings.wallpaperSource,
    settings.wallpaperPath,
    settings.wallpaperUrl,
    settings.wallpaperOpacity,
    desktop,
    isVideo,
  ]);

  const wallpaperActive =
    settings.wallpaperEnabled && !error && settings.wallpaperSource !== "none";

  let videoSrc: string | null = null;
  if (isVideo && Platform.OS === "web") {
    if (settings.wallpaperSource === "file") {
      videoSrc = buildWallpaperMediaSrc(settings.wallpaperPath ?? "");
    } else if (settings.wallpaperSource === "url") {
      videoSrc = settings.wallpaperUrl;
    }
  }

  const opacity = settings.wallpaperOpacity ?? 0.85;

  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!wallpaperActive) return;

    // Re-apply the literal-color override whenever React remounts containers
    // (route/page switches mount fresh nodes that never got marked). Debounced
    // to coalesce mutation bursts; our own writes are muted via
    // wallpaperWriteDepth inside applyLiteralSurfaceOverride.
    let timer: number | undefined;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        reapplyLiteralOverride();
      }, 80);
    });

    const start = () => {
      const root = document.getElementById("root");
      if (root) {
        observer.observe(root, { childList: true, subtree: true });
      }
    };
    start();

    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [wallpaperActive]);

  useEffect(() => {
    if (Platform.OS !== "web") return;

    if (cachedVarsRef.current.size === 0) {
      cachedVarsRef.current = readOriginalSurfaceVars();
    }

    syncWallpaperLayer(
      {
        dataUrl: frame?.dataUrl ?? null,
        videoSrc,
        opacity,
        visible: wallpaperActive && (!!frame?.dataUrl || !!videoSrc),
      },
      cachedVarsRef.current,
    );
  }, [frame, videoSrc, opacity, wallpaperActive, htmlClass]);

  useEffect(() => {
    return () => {
      document.getElementById(WALLPAPER_LAYER_ID)?.remove();
      document.getElementById(WALLPAPER_CSS_ID)?.remove();
    };
  }, []);

  return null;
}
