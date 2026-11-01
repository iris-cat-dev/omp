/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { createPopupMotion } from "./popup-motion";

interface ControlledAnimation extends EventTarget {
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  cancelled: number;
  cancel(): void;
}
const cleanups: Array<() => void> = [];
function fixture(initialInert = false) {
  const popup = document.createElement("div"),
    child = document.createElement("span");
  popup.hidden = true;
  popup.inert = initialInert;
  child.textContent = "Actual OMP facts";
  popup.append(child);
  document.body.append(popup);
  const animations: ControlledAnimation[] = [];
  Object.defineProperty(popup, "animate", {
    configurable: true,
    value(frames: Keyframe[], options: KeyframeAnimationOptions) {
      const animation: ControlledAnimation = Object.assign(new EventTarget(), {
        frames,
        options,
        cancelled: 0,
        cancel(this: ControlledAnimation) {
          this.cancelled++;
          this.dispatchEvent(new Event("cancel"));
        },
      });
      animations.push(animation);
      return animation;
    },
  });
  let now = 0,
    serial = 0;
  const timers = new Map<number, { at: number; callback: () => void }>(),
    visibility = { hidden: false };
  const motion = createPopupMotion({
    document: visibility,
    setTimeout(callback, milliseconds) {
      const id = ++serial;
      timers.set(id, { at: now + milliseconds, callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  function advance(milliseconds: number) {
    now += milliseconds;
    for (const [id, timer] of timers)
      if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
  }
  cleanups.push(() => {
    motion.destroy();
    popup.remove();
  });
  return { popup, child, motion, animations, timers, visibility, advance };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("original WPF popup motion lifecycle", () => {
  it("uses native 150 ms linear endpoints and retains the same real content through the closing fade", () => {
    const { popup, child, motion, animations, timers, advance } = fixture();
    motion.show(popup);
    expect(motion.isOpen(popup)).toBe(true);
    expect(animations[0]!.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(animations[0]!.options).toEqual({ duration: 150, easing: "linear", fill: "forwards" });
    advance(150);
    let closed = 0;
    motion.hide(popup, true, () => closed++);
    expect(motion.isOpen(popup)).toBe(false);
    expect(popup.hidden).toBe(false);
    expect(popup.inert).toBe(true);
    expect(popup.firstChild).toBe(child);
    expect(animations[1]!.frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    advance(149);
    expect(popup.hidden).toBe(false);
    expect(closed).toBe(0);
    advance(1);
    expect(popup.hidden).toBe(true);
    expect(popup.inert).toBe(false);
    expect(closed).toBe(1);
    expect(timers.size).toBe(0);
  });

  it.each([false, true])("coalesces closing and restores exact prior inert=%s", (prior) => {
    const { popup, motion, animations, advance } = fixture(prior);
    motion.show(popup, false);
    let closed = 0;
    motion.hide(popup, true, () => closed++);
    motion.hide(popup);
    expect(animations).toHaveLength(1);
    advance(150);
    expect(popup.inert).toBe(prior);
    expect(closed).toBe(1);
  });

  it("cancels stale close work when reopening and never clears the reopened live content", () => {
    const { popup, child, motion, animations, timers, advance } = fixture();
    motion.show(popup, false);
    let closed = 0;
    motion.hide(popup, true, () => {
      closed++;
      popup.replaceChildren();
    });
    const staleAnimation = animations[0]!,
      staleTimer = Array.from(timers.values())[0]!.callback;
    motion.show(popup);
    expect(animations[0]!.cancelled).toBe(1);
    staleAnimation.dispatchEvent(new Event("finish"));
    staleAnimation.dispatchEvent(new Event("cancel"));
    staleTimer();
    expect(motion.isOpen(popup)).toBe(true);
    expect(popup.inert).toBe(false);
    expect(popup.firstChild).toBe(child);
    advance(150);
    expect(popup.hidden).toBe(false);
    expect(closed).toBe(0);
    expect(timers.size).toBe(0);
  });

  it.each(["finish", "cancel"])(
    "settles a native %s event once, clearing the deadline without replacing other listeners",
    (event) => {
      const { popup, motion, animations, timers, advance } = fixture();
      motion.show(popup, false);
      let closed = 0,
        observed = 0;
      motion.hide(popup, true, () => closed++);
      const animation = animations[0]!;
      animation.addEventListener(event, () => observed++);
      animation.dispatchEvent(new Event(event));
      expect(popup.hidden).toBe(true);
      expect(popup.inert).toBe(false);
      expect(closed).toBe(1);
      expect(animation.cancelled).toBe(1);
      expect(timers.size).toBe(0);
      const afterSettlement = observed;
      animation.dispatchEvent(new Event(event));
      advance(150);
      expect(observed).toBe(afterSettlement + 1);
      expect(closed).toBe(1);
      expect(animation.cancelled).toBe(1);
    },
  );

  it("snaps on hidden or unsupported animation, and destroys pending exit without later callbacks", () => {
    const { popup, motion, animations, timers, visibility } = fixture();
    motion.show(popup);
    visibility.hidden = true;
    motion.hide(popup);
    expect(popup.hidden).toBe(true);
    expect(popup.inert).toBe(false);
    expect(timers.size).toBe(0);
    visibility.hidden = false;
    motion.show(popup, false);
    motion.hide(popup);
    const stale = animations.at(-1)!;
    motion.destroy();
    expect(popup.hidden).toBe(true);
    expect(timers.size).toBe(0);
    stale.dispatchEvent(new Event("finish"));
    stale.dispatchEvent(new Event("cancel"));
    motion.show(popup);
    expect(popup.hidden).toBe(true);
    expect(motion.isOpen(popup)).toBe(false);

    const fallback = fixture();
    Object.defineProperty(fallback.popup, "animate", { value: undefined });
    fallback.motion.show(fallback.popup);
    fallback.motion.hide(fallback.popup);
    expect(fallback.popup.hidden).toBe(true);
    expect(fallback.timers.size).toBe(0);
  });
});
