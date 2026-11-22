export function installWebVisualViewport(): (() => void) | undefined {
  const viewport = window.visualViewport;
  const root = document.getElementById("root");
  if (!viewport || !root) return;

  const heightProperty = "--app-visual-viewport-height";
  const topProperty = "--app-visual-viewport-top";
  const restore = () => {
    root.removeAttribute("data-visual-viewport");
    root.style.removeProperty(heightProperty);
    root.style.removeProperty(topProperty);
  };

  let frame = 0;
  const update = () => {
    frame = 0;
    // Safari can shrink and pan just the visual viewport when the keyboard opens.
    // Ignore pinch zoom so it remains possible to pan and magnify the layout normally.
    if (viewport.scale !== 1 || viewport.height >= document.documentElement.clientHeight - 1) {
      restore();
      return;
    }
    root.style.setProperty(heightProperty, `${viewport.height}px`);
    root.style.setProperty(topProperty, `${Math.max(0, viewport.offsetTop)}px`);
    root.setAttribute("data-visual-viewport", "");
  };
  const scheduleUpdate = () => {
    if (!frame) frame = window.requestAnimationFrame(update);
  };

  viewport.addEventListener("resize", scheduleUpdate);
  viewport.addEventListener("scroll", scheduleUpdate);
  window.addEventListener("resize", scheduleUpdate);
  update();

  return () => {
    viewport.removeEventListener("resize", scheduleUpdate);
    viewport.removeEventListener("scroll", scheduleUpdate);
    window.removeEventListener("resize", scheduleUpdate);
    if (frame) window.cancelAnimationFrame(frame);
    restore();
  };
}
