import { useCallback, useEffect, useState } from "react";
import { isWeb } from "@/constants/platform";
import { useRetainedPanelActive } from "@/components/retained-panel";

/** Observe the frame, including its unloaded placeholder, so scrolling back can reload. */
export function useImageVisibility() {
  const panelActive = useRetainedPanelActive();
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [intersecting, setIntersecting] = useState(!isWeb);
  const ref = useCallback((instance: unknown) => {
    setNode(isWeb && instance instanceof HTMLElement ? instance : null);
  }, []);
  useEffect(() => {
    if (!isWeb || !node || !panelActive) return;
    if (typeof IntersectionObserver === "undefined") { setIntersecting(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      setIntersecting(entry?.isIntersecting === true);
    }, { rootMargin: "256px 0px" });
    observer.observe(node);
    return () => { observer.disconnect(); setIntersecting(false); };
  }, [node, panelActive]);
  return { ref, visible: panelActive && (!isWeb || intersecting) };
}
