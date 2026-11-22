export interface LightboxSize {
  width: number;
  height: number;
}

export interface LightboxPoint {
  x: number;
  y: number;
}

/**
 * `scale` is relative to the fitted ("contain") image; `x`/`y` translate the image
 * centre in viewport pixels.
 */
export interface LightboxTransform {
  scale: number;
  x: number;
  y: number;
}

export interface LightboxViewState {
  viewport: LightboxSize | null;
  natural: LightboxSize | null;
  minFitScale: number;
  transform: LightboxTransform;
  /** Image offset when the current drag began; `null` while not dragging. */
  panOrigin: LightboxPoint | null;
}

export type LightboxViewAction =
  | { type: "reset" }
  | { type: "layout"; viewport: LightboxSize }
  | { type: "loaded"; natural: LightboxSize }
  /** `focus` is relative to the viewport centre; omitted means the centre. */
  | { type: "zoomBy"; factor: number; focus?: LightboxPoint }
  | { type: "fit" }
  | { type: "actualSize" }
  | { type: "panStart" }
  | { type: "panMove"; dx: number; dy: number }
  | { type: "panEnd" };

export interface LightboxZoomState {
  canZoomIn: boolean;
  canZoomOut: boolean;
  canPan: boolean;
  isFit: boolean;
  /** `null` until the image's natural size is known. */
  isActualSize: boolean | null;
  /** Displayed size as a percentage of the image's pixels; `null` until the natural size is known. */
  percent: number | null;
}

const FIT_TRANSFORM: LightboxTransform = { scale: 1, x: 0, y: 0 };
export const INITIAL_LIGHTBOX_VIEW: LightboxViewState = {
  viewport: null,
  natural: null,
  minFitScale: 1,
  transform: FIT_TRANSFORM,
  panOrigin: null,
};
export const LIGHTBOX_ZOOM_STEP = 1.25;
const MAX_FIT_RELATIVE_SCALE = 8;
const SCALE_EPSILON = 1e-3;

function hasArea(size: LightboxSize | null): size is LightboxSize {
  return size !== null && size.width > 0 && size.height > 0;
}

/** Size the image occupies at fit scale, matching `contentFit="contain"`. */
export function getFittedImageSize(
  viewport: LightboxSize | null,
  natural: LightboxSize | null,
): LightboxSize {
  if (!hasArea(viewport)) {
    return { width: 0, height: 0 };
  }
  if (!hasArea(natural)) {
    return viewport;
  }
  const fit = Math.min(viewport.width / natural.width, viewport.height / natural.height);
  return { width: natural.width * fit, height: natural.height * fit };
}

/** Fit-relative scale at which one image pixel occupies one viewport pixel. */
function getActualSizeScale({ viewport, natural }: LightboxViewState): number | null {
  if (!hasArea(viewport) || !hasArea(natural)) {
    return null;
  }
  return natural.width / getFittedImageSize(viewport, natural).width;
}

/** Fit and 100% are always reachable; the viewer may also allow zooming below fit. */
function getScaleBounds(
  actualSizeScale: number | null,
  minFitScale: number,
): { min: number; max: number } {
  const actual = actualSizeScale ?? 1;
  return {
    min: Math.min(minFitScale, actual),
    max: Math.max(MAX_FIT_RELATIVE_SCALE, actual),
  };
}

function clampAxis(offset: number, imageExtent: number, viewportExtent: number): number {
  const limit = Math.max(0, (imageExtent - viewportExtent) / 2);
  return Math.min(limit, Math.max(-limit, offset));
}

/** Keeps a zoomed image covering each viewport axis it overflows; smaller axes stay centred. */
function clampTransform(
  transform: LightboxTransform,
  { viewport, natural }: LightboxViewState,
): LightboxTransform {
  if (!hasArea(viewport)) {
    return { scale: transform.scale, x: 0, y: 0 };
  }
  const fitted = getFittedImageSize(viewport, natural);
  return {
    scale: transform.scale,
    x: clampAxis(transform.x, fitted.width * transform.scale, viewport.width),
    y: clampAxis(transform.y, fitted.height * transform.scale, viewport.height),
  };
}

/** Zooms so the image point under `focus` stays under it. */
function zoomAround(
  state: LightboxViewState,
  requestedScale: number,
  focus: LightboxPoint,
): LightboxViewState {
  const { min, max } = getScaleBounds(getActualSizeScale(state), state.minFitScale);
  const current = state.transform;
  const scale = Math.min(max, Math.max(min, requestedScale));
  const ratio = scale / current.scale;
  const transform = clampTransform(
    {
      scale,
      x: focus.x - (focus.x - current.x) * ratio,
      y: focus.y - (focus.y - current.y) * ratio,
    },
    state,
  );
  return { ...state, transform };
}

export function lightboxViewReducer(
  state: LightboxViewState,
  action: LightboxViewAction,
): LightboxViewState {
  switch (action.type) {
    case "reset":
      return { ...INITIAL_LIGHTBOX_VIEW, viewport: state.viewport, minFitScale: state.minFitScale };
    case "layout": {
      const next = { ...state, viewport: action.viewport };
      return { ...next, transform: clampTransform(state.transform, next) };
    }
    case "loaded": {
      const next = { ...state, natural: action.natural };
      return { ...next, transform: clampTransform(state.transform, next) };
    }
    case "zoomBy":
      return zoomAround(
        state,
        state.transform.scale * action.factor,
        action.focus ?? { x: 0, y: 0 },
      );
    case "fit":
      return { ...state, transform: FIT_TRANSFORM, panOrigin: null };
    case "actualSize": {
      const actualSizeScale = getActualSizeScale(state);
      return actualSizeScale === null ? state : zoomAround(state, actualSizeScale, { x: 0, y: 0 });
    }
    case "panStart":
      return { ...state, panOrigin: { x: state.transform.x, y: state.transform.y } };
    case "panMove": {
      if (!state.panOrigin) {
        return state;
      }
      const transform = clampTransform(
        {
          scale: state.transform.scale,
          x: state.panOrigin.x + action.dx,
          y: state.panOrigin.y + action.dy,
        },
        state,
      );
      return { ...state, transform };
    }
    case "panEnd":
      return state.panOrigin ? { ...state, panOrigin: null } : state;
  }
}

export function getZoomState(state: LightboxViewState): LightboxZoomState {
  const { viewport, natural, transform } = state;
  const actualSizeScale = getActualSizeScale(state);
  const { min, max } = getScaleBounds(actualSizeScale, state.minFitScale);
  const fitted = getFittedImageSize(viewport, natural);
  return {
    canZoomIn: transform.scale < max - SCALE_EPSILON,
    canZoomOut: transform.scale > min + SCALE_EPSILON,
    canPan:
      hasArea(viewport) &&
      (fitted.width * transform.scale > viewport.width + 0.5 ||
        fitted.height * transform.scale > viewport.height + 0.5),
    isFit:
      Math.abs(transform.scale - 1) <= SCALE_EPSILON &&
      Math.abs(transform.x) < 0.5 &&
      Math.abs(transform.y) < 0.5,
    isActualSize:
      actualSizeScale === null
        ? null
        : Math.abs(transform.scale - actualSizeScale) <= SCALE_EPSILON,
    percent:
      actualSizeScale === null ? null : Math.round((transform.scale / actualSizeScale) * 100),
  };
}
