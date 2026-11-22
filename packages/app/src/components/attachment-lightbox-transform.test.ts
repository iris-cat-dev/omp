import { describe, expect, it } from "vitest";
import {
  getZoomState,
  INITIAL_LIGHTBOX_VIEW,
  lightboxViewReducer,
  type LightboxViewAction,
  type LightboxViewState,
} from "./attachment-lightbox-transform";

function run(...actions: LightboxViewAction[]): LightboxViewState {
  return actions.reduce(lightboxViewReducer, INITIAL_LIGHTBOX_VIEW);
}

// A 2000x1000 screenshot fitted into an 800x800 viewport renders at 800x400 (40%).
const layout: LightboxViewAction = { type: "layout", viewport: { width: 800, height: 800 } };
const loaded: LightboxViewAction = { type: "loaded", natural: { width: 2000, height: 1000 } };

describe("lightboxViewReducer", () => {
  it("opens fitted and reports the fitted percentage of the original pixels", () => {
    const state = run(layout, loaded);

    expect(state.transform).toEqual({ scale: 1, x: 0, y: 0 });
    expect(getZoomState(state)).toMatchObject({
      isFit: true,
      isActualSize: false,
      canPan: false,
      canZoomIn: true,
      canZoomOut: false,
      percent: 40,
    });
  });

  it("switches between 100% original size and fit to window", () => {
    const actual = run(layout, loaded, { type: "actualSize" });

    expect(actual.transform.scale).toBeCloseTo(2.5);
    expect(getZoomState(actual)).toMatchObject({ isActualSize: true, isFit: false, percent: 100 });

    const fitted = lightboxViewReducer(actual, { type: "fit" });
    expect(fitted.transform).toEqual({ scale: 1, x: 0, y: 0 });
    expect(getZoomState(fitted).isFit).toBe(true);
  });

  it("keeps the image point under the cursor fixed while zooming", () => {
    // Focus 100px right of centre: image point at offset 100 / scale must stay at 100.
    const state = run(layout, loaded, { type: "zoomBy", factor: 2, focus: { x: 100, y: 0 } });

    expect(state.transform.scale).toBe(2);
    expect(state.transform.x).toBe(-100);
    expect(state.transform.y).toBe(0);
  });

  it("stops zooming at fit and at the maximum scale", () => {
    const zoomedOut = run(layout, loaded, { type: "zoomBy", factor: 0.5 });
    expect(zoomedOut.transform.scale).toBe(1);
    expect(getZoomState(zoomedOut).canZoomOut).toBe(false);

    const zoomedIn = run(layout, loaded, { type: "zoomBy", factor: 100 });
    expect(zoomedIn.transform.scale).toBe(8);
    expect(getZoomState(zoomedIn).canZoomIn).toBe(false);
  });

  it("lets the file viewer zoom below fit without losing the fit reset", () => {
    const fitted = [layout, loaded].reduce(lightboxViewReducer, {
      ...INITIAL_LIGHTBOX_VIEW,
      minFitScale: 0.25,
    });
    const smaller = lightboxViewReducer(fitted, { type: "zoomBy", factor: 0.1 });
    expect(getZoomState(smaller)).toMatchObject({ percent: 10, canZoomOut: false });
    expect(getZoomState(lightboxViewReducer(smaller, { type: "fit" }))).toMatchObject({
      percent: 40,
      isFit: true,
      canZoomOut: true,
    });
  });

  it("lets images smaller than the window zoom down to 100% and back up to fit", () => {
    // A 400x200 icon fits at 800x400 (200%); 100% is a zoom-out from fit.
    const small = run(layout, { type: "loaded", natural: { width: 400, height: 200 } });
    expect(getZoomState(small)).toMatchObject({ percent: 200, canZoomOut: true });

    const actual = lightboxViewReducer(small, { type: "actualSize" });
    expect(actual.transform.scale).toBeCloseTo(0.5);
    expect(getZoomState(actual)).toMatchObject({ percent: 100, canZoomOut: false });
  });

  it("pans a zoomed image only until its edges reach the viewport", () => {
    // At 4x the image is 3200x1600 in an 800x800 viewport: x within ±1200, y within ±400.
    const zoomed = run(layout, loaded, { type: "zoomBy", factor: 4 });
    expect(getZoomState(zoomed).canPan).toBe(true);

    const dragged = [
      { type: "panStart" },
      { type: "panMove", dx: 300, dy: -150 },
      { type: "panMove", dx: 5000, dy: -5000 },
    ] satisfies LightboxViewAction[];
    const panned = dragged.reduce(lightboxViewReducer, zoomed);
    expect(panned.transform).toEqual({ scale: 4, x: 1200, y: -400 });

    const released = lightboxViewReducer(panned, { type: "panEnd" });
    expect(released.panOrigin).toBeNull();
    expect(lightboxViewReducer(released, { type: "panMove", dx: -50, dy: 0 })).toBe(released);
  });

  it("keeps a fitted image centred when dragged", () => {
    const state = run(
      layout,
      loaded,
      { type: "panStart" },
      { type: "panMove", dx: 200, dy: 200 },
      { type: "panEnd" },
    );

    expect(state.transform).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("re-clamps the pan offset when the window shrinks the overflow", () => {
    const zoomed = run(
      layout,
      loaded,
      { type: "zoomBy", factor: 2 },
      { type: "panStart" },
      { type: "panMove", dx: 400, dy: 0 },
    );
    expect(zoomed.transform.x).toBe(400);

    // A 1600px-wide viewport fits the image at 1600x800; at 2x it overflows by 800 -> ±800.
    const widened = lightboxViewReducer(zoomed, {
      type: "layout",
      viewport: { width: 1600, height: 800 },
    });
    expect(widened.transform.x).toBe(400);

    const narrowed = lightboxViewReducer(zoomed, {
      type: "layout",
      viewport: { width: 400, height: 800 },
    });
    expect(narrowed.transform.x).toBe(200);
  });

  it("disables 100% until the original size is known", () => {
    const state = run(layout);

    expect(getZoomState(state)).toMatchObject({ isActualSize: null, percent: null });
    expect(lightboxViewReducer(state, { type: "actualSize" })).toBe(state);
  });

  it("resets zoom for a new image while keeping the measured viewport", () => {
    const state = run(layout, loaded, { type: "zoomBy", factor: 3 }, { type: "reset" });

    expect(state).toEqual({ ...INITIAL_LIGHTBOX_VIEW, viewport: { width: 800, height: 800 } });
  });
});
