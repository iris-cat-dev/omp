/** WPF Popup/PopupRoot: 150 ms linear opacity, retained through close, with explicit 0/1 endpoints. */
export function createPopupMotion(environment: {
  document: { readonly hidden: boolean };
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(timer: number): void;
}) {
  interface Transition {
    closing: boolean;
    previousInert: boolean;
    animation: Animation | null;
    timer: number | null;
    closed: (() => void) | null;
    settle(): void;
  }
  const transitions = new Map<HTMLElement, Transition>();
  let destroyed = false;
  function finish(popup: HTMLElement, state: Transition, complete: boolean) {
    if (transitions.get(popup) !== state) return;
    transitions.delete(popup);
    if (state.timer !== null) environment.clearTimeout(state.timer);
    if (state.animation) {
      state.animation.removeEventListener("finish", state.settle);
      state.animation.removeEventListener("cancel", state.settle);
      state.animation.cancel();
    }
    popup.inert = state.previousInert;
    if (complete && state.closing) {
      popup.hidden = true;
      state.closed?.();
    }
  }
  function animate(popup: HTMLElement, closing: boolean, closed: (() => void) | null) {
    const state: Transition = {
      closing,
      previousInert: popup.inert,
      animation: null,
      timer: null,
      closed,
      settle: () => finish(popup, state, true),
    };
    transitions.set(popup, state);
    if (closing) popup.inert = true;
    const animation = popup.animate([{ opacity: closing ? 1 : 0 }, { opacity: closing ? 0 : 1 }], {
      duration: 150,
      easing: "linear",
      fill: "forwards",
    });
    state.animation = animation;
    animation.addEventListener("finish", state.settle);
    animation.addEventListener("cancel", state.settle);
    state.timer = environment.setTimeout(state.settle, 150);
  }
  function show(popup: HTMLElement, fade = true) {
    if (destroyed) return;
    const pending = transitions.get(popup);
    if (pending) finish(popup, pending, false);
    popup.hidden = false;
    if (fade && !environment.document.hidden && typeof popup.animate === "function")
      animate(popup, false, null);
  }
  function hide(popup: HTMLElement, fade = true, closed: (() => void) | null = null) {
    const pending = transitions.get(popup);
    if (pending?.closing) {
      if (!fade || environment.document.hidden || destroyed) finish(popup, pending, true);
      return;
    }
    if (pending) finish(popup, pending, false);
    if (popup.hidden) return;
    if (!fade || environment.document.hidden || destroyed || typeof popup.animate !== "function") {
      popup.hidden = true;
      closed?.();
      return;
    }
    animate(popup, true, closed);
  }
  return {
    show,
    hide,
    isOpen(popup: HTMLElement) {
      return !destroyed && !popup.hidden && !transitions.get(popup)?.closing;
    },
    destroy() {
      destroyed = true;
      for (const [popup, state] of transitions) {
        finish(popup, state, true);
        popup.hidden = true;
      }
    },
  };
}

export const MONITOR_POPUP_MOTION_SCRIPT = `const monitorPopupMotion = (${createPopupMotion.toString()})(window);\n`;
