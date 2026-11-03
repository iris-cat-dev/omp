import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, type PointerEvent as RNPointerEvent } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { startResizeHandleDrag, type ResizeHandleDrag } from "@/components/resize-handle-drag";
import { isWeb } from "@/constants/platform";

const RESIZE_HANDLE_DATASET = isWeb ? { windowChromeInteractive: "true" } : undefined;

export interface ResizeHandleProps {
  testID?: string;
  direction: "horizontal" | "vertical";
  groupId: string;
  index: number;
  sizes: number[];
  visibleSizeTotal: number;
  onPreviewResizeSplit: (groupId: string, sizes: number[]) => void;
  onResizeSplit: (groupId: string, sizes: number[]) => void;
}

interface PointerState {
  containerSize: number;
  pointerStart: number;
  drag: ResizeHandleDrag;
  finish: () => void;
  awaitingFocus: boolean;
}

function resetWindowHorizontalScroll() {
  // Clamp any browser scroll introduced while dragging past the viewport edge.
  if (window.scrollX === 0) {
    return;
  }
  window.scrollTo(0, window.scrollY);
}

export function ResizeHandle({
  testID,
  direction,
  groupId,
  index,
  sizes,
  visibleSizeTotal,
  onPreviewResizeSplit,
  onResizeSplit,
}: ResizeHandleProps) {
  const { theme } = useUnistyles();
  const pointerStatesRef = useRef(new Map<number, PointerState>());
  const cursorBeforeDragRef = useRef<string | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [active, setActive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const highlighted = active || dragging;

  const handlePointerEnter = useCallback(() => {
    clearTimeout(hoverTimerRef.current ?? undefined);
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      setActive(true);
    }, 150);
  }, []);

  const handlePointerLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setActive(false);
  }, []);
  const handlePointerDown = useCallback(
    (event: RNPointerEvent) => {
      const hitAreaElement = event.currentTarget as unknown as HTMLElement | null;
      if (!hitAreaElement) {
        return;
      }

      const containerElement = hitAreaElement.parentElement?.parentElement ?? null;
      if (!containerElement) {
        return;
      }

      const rect = containerElement.getBoundingClientRect();
      const containerSize = direction === "horizontal" ? rect.width : rect.height;
      if (containerSize <= 0) {
        return;
      }

      const pointerId = event.nativeEvent.pointerId;
      if (pointerStatesRef.current.has(pointerId)) {
        return;
      }

      setDragging(true);

      pointerStatesRef.current.set(pointerId, {
        containerSize,
        pointerStart:
          direction === "horizontal" ? event.nativeEvent.clientX : event.nativeEvent.clientY,
        drag: startResizeHandleDrag({
          sizes,
          index,
          preview: (nextSizes) => onPreviewResizeSplit(groupId, nextSizes),
          commit: (nextSizes) => onResizeSplit(groupId, nextSizes),
        }),
        finish: finishDrag,
        awaitingFocus: !document.hasFocus(),
      });

      if (pointerStatesRef.current.size === 1) {
        cursorBeforeDragRef.current = document.body.style.cursor;
      }
      const nextCursor = direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.cursor = nextCursor;
      event.preventDefault();
      event.stopPropagation();
      const pointerCaptureElement = hitAreaElement;
      pointerCaptureElement.setPointerCapture?.(pointerId);
      resetWindowHorizontalScroll();

      function cleanup() {
        if (!pointerStatesRef.current.has(pointerId)) return;
        pointerStatesRef.current.delete(pointerId);
        setDragging(pointerStatesRef.current.size > 0);
        if (pointerStatesRef.current.size === 0) {
          document.body.style.cursor = cursorBeforeDragRef.current ?? "";
          cursorBeforeDragRef.current = null;
        }
        if (pointerCaptureElement.hasPointerCapture?.(pointerId)) {
          pointerCaptureElement.releasePointerCapture(pointerId);
        }
        resetWindowHorizontalScroll();
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerCancel);
        pointerCaptureElement.removeEventListener("lostpointercapture", handlePointerCancel);
      }

      function finishDrag() {
        const pointerState = pointerStatesRef.current.get(pointerId);
        if (!pointerState) return;
        cleanup();
        pointerState.drag.finish();
      }

      function handlePointerMove(moveEvent: PointerEvent) {
        if (moveEvent.pointerId !== pointerId) {
          return;
        }

        const pointerState = pointerStatesRef.current.get(pointerId);
        if (!pointerState) {
          return;
        }
        pointerState.awaitingFocus = false;
        if (moveEvent.pointerType === "mouse" && moveEvent.buttons === 0) {
          handlePointerLeave();
          finishDrag();
          return;
        }

        moveEvent.preventDefault();
        resetWindowHorizontalScroll();
        const pointerCurrent = direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY;
        // Stored weights retain hidden panes; visible weights are normalized by the layout.
        const deltaRatio =
          ((pointerCurrent - pointerState.pointerStart) / pointerState.containerSize) *
          visibleSizeTotal;

        pointerState.drag.move(deltaRatio);
      }

      function handlePointerUp(upEvent: PointerEvent) {
        if (upEvent.pointerId !== pointerId) {
          return;
        }

        finishDrag();
      }

      function handlePointerCancel(cancelEvent: PointerEvent) {
        if (cancelEvent.pointerId !== pointerId) return;
        handlePointerLeave();
        finishDrag();
      }

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerCancel);
      pointerCaptureElement.addEventListener("lostpointercapture", handlePointerCancel);
    },
    [
      direction,
      groupId,
      index,
      onPreviewResizeSplit,
      onResizeSplit,
      sizes,
      visibleSizeTotal,
      handlePointerLeave,
    ],
  );
  useEffect(() => {
    if (!isWeb) return;
    function resetInteraction(event?: Event) {
      let preserveHover = false;
      for (const pointerState of pointerStatesRef.current.values()) {
        // A new click may activate the window after pointerdown has started its drag.
        if (event?.type === "focus" && pointerState.awaitingFocus) {
          pointerState.awaitingFocus = false;
          preserveHover = true;
        } else {
          pointerState.finish();
        }
      }
      if (!preserveHover) handlePointerLeave();
    }
    function handleVisibilityChange() {
      if (document.hidden) resetInteraction();
    }
    window.addEventListener("blur", resetInteraction);
    window.addEventListener("focus", resetInteraction);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", resetInteraction);
      window.removeEventListener("focus", resetInteraction);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      resetInteraction();
    };
  }, [handlePointerLeave]);

  const handleStyle = useMemo(
    () => [
      styles.handle,
      direction === "horizontal" ? styles.handleHorizontal : styles.handleVertical,
      { backgroundColor: theme.colors.border },
    ],
    [direction, theme.colors.border],
  );
  const highlightStyle = useMemo(
    () => [
      styles.highlight,
      direction === "horizontal" ? styles.highlightHorizontal : styles.highlightVertical,
      { backgroundColor: theme.colors.accent },
    ],
    [direction, theme.colors.accent],
  );
  const hitAreaStyle = useMemo(
    () => [
      styles.hitArea,
      direction === "horizontal" ? styles.hitAreaHorizontal : styles.hitAreaVertical,
      {
        cursor: direction === "horizontal" ? "col-resize" : "row-resize",
        touchAction: "none",
      } as object,
    ],
    [direction],
  );

  return (
    <View style={handleStyle} testID={testID}>
      {highlighted && (
        <View
          pointerEvents="none"
          style={highlightStyle}
          testID={testID ? `${testID}-highlight` : undefined}
        />
      )}
      <View
        role="separator"
        dataSet={RESIZE_HANDLE_DATASET}
        aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
        style={hitAreaStyle}
        onPointerDown={handlePointerDown}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      />
    </View>
  );
}

const styles = StyleSheet.create((_theme) => ({
  handle: {
    position: "relative",
    flexShrink: 0,
    // Keep the overhanging hit target and highlight above both adjacent panes.
    zIndex: 1,
  },
  handleHorizontal: {
    width: 1,
    alignSelf: "stretch",
  },
  handleVertical: {
    height: 1,
    width: "100%",
  },
  highlight: {
    position: "absolute",
    zIndex: 5,
  },
  highlightHorizontal: {
    top: 0,
    bottom: 0,
    width: 2,
    left: -1,
  },
  highlightVertical: {
    left: 0,
    right: 0,
    height: 3,
    top: -1,
  },
  hitArea: {
    position: "absolute",
    zIndex: 10,
  },
  hitAreaHorizontal: {
    left: -5,
    top: 0,
    bottom: 0,
    width: 10,
  },
  hitAreaVertical: {
    top: -5,
    left: 0,
    right: 0,
    height: 10,
  },
}));
