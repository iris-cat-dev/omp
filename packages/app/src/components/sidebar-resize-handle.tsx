import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { GestureDetector, type GestureType } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import {
  resolveSidebarResizeHandleGeometry,
  type SidebarResizeEdge,
} from "@/components/sidebar-resize-handle-layout";
import { isWeb } from "@/constants/platform";
import { useHasFinePointer } from "@/hooks/use-fine-pointer";

interface SidebarResizeHandleProps {
  edge: SidebarResizeEdge;
  gesture: GestureType;
  pressed: boolean;
  testID: string;
}

const HIGHLIGHT_DELAY_MS = 150;
const RESIZE_HANDLE_DATASET = isWeb ? { windowChromeInteractive: "true" } : undefined;

const webResizeCursorStyle = isWeb
  ? ({
      cursor: "col-resize",
    } as object)
  : null;

function edgeOffsetStyle(edge: SidebarResizeEdge, edgeOffset: number) {
  return edge === "left" ? { left: edgeOffset } : { right: edgeOffset };
}

export function SidebarResizeHandle({ edge, gesture, pressed, testID }: SidebarResizeHandleProps) {
  const finePointer = useHasFinePointer();

  if (finePointer) {
    return <PointerResizeHandle edge={edge} gesture={gesture} pressed={pressed} testID={testID} />;
  }
  return <TouchResizeHandle edge={edge} gesture={gesture} pressed={pressed} testID={testID} />;
}

function PointerResizeHandle({ edge, gesture, testID }: SidebarResizeHandleProps) {
  const [highlighted, setHighlighted] = useState(false);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hitAreaRef = useRef<View | null>(null);
  const geometry = resolveSidebarResizeHandleGeometry(true);
  const hitAreaStyle = [
    styles.hitArea,
    { width: geometry.width },
    edgeOffsetStyle(edge, geometry.edgeOffset),
    webResizeCursorStyle,
  ];

  const cancelHighlightTimer = useCallback(() => {
    if (highlightTimerRef.current === null) return;
    clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = null;
  }, []);

  const handleHoverIn = useCallback(() => {
    cancelHighlightTimer();
    highlightTimerRef.current = setTimeout(() => {
      highlightTimerRef.current = null;
      setHighlighted(true);
    }, HIGHLIGHT_DELAY_MS);
  }, [cancelHighlightTimer]);

  const handleHoverOut = useCallback(() => {
    cancelHighlightTimer();
    setHighlighted(false);
  }, [cancelHighlightTimer]);

  useEffect(() => cancelHighlightTimer, [cancelHighlightTimer]);

  useEffect(() => {
    if (!isWeb) return;
    const element = hitAreaRef.current as unknown as HTMLElement | null;
    const view = element?.ownerDocument.defaultView;
    if (!element || !view) return;
    const document = element.ownerDocument;
    const pointers = new Map<number, { target: HTMLElement; awaitingFocus: boolean }>();

    function trackPointer(event: PointerEvent) {
      pointers.set(event.pointerId, {
        target: event.target as HTMLElement,
        awaitingFocus: !document.hasFocus(),
      });
    }
    function forgetPointer(event: PointerEvent) {
      pointers.delete(event.pointerId);
    }
    function handlePointerMove(event: PointerEvent) {
      const pointer = pointers.get(event.pointerId);
      if (pointer) pointer.awaitingFocus = false;
    }
    function resetInteraction(event?: Event) {
      let preserveHover = false;
      // Switching windows need not deliver pointerup or pointerleave. Releasing
      // capture lets GestureDetector cancel its pan on lostpointercapture.
      for (const [pointerId, pointer] of pointers) {
        // Clicking an inactive window can deliver pointerdown before focus.
        if (event?.type === "focus" && pointer.awaitingFocus) {
          pointer.awaitingFocus = false;
          preserveHover = true;
          continue;
        }
        if (pointer.target.hasPointerCapture(pointerId)) {
          pointer.target.releasePointerCapture(pointerId);
        }
        pointers.delete(pointerId);
      }
      if (!preserveHover) handleHoverOut();
    }
    function handleVisibilityChange() {
      if (document.hidden) resetInteraction();
    }

    element.addEventListener("pointerdown", trackPointer);
    element.addEventListener("pointermove", handlePointerMove);
    element.addEventListener("pointerup", forgetPointer);
    element.addEventListener("pointercancel", forgetPointer);
    element.addEventListener("lostpointercapture", forgetPointer);
    view.addEventListener("blur", resetInteraction);
    view.addEventListener("focus", resetInteraction);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      element.removeEventListener("pointerdown", trackPointer);
      element.removeEventListener("pointermove", handlePointerMove);
      element.removeEventListener("pointerup", forgetPointer);
      element.removeEventListener("pointercancel", forgetPointer);
      element.removeEventListener("lostpointercapture", forgetPointer);
      view.removeEventListener("blur", resetInteraction);
      view.removeEventListener("focus", resetInteraction);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      resetInteraction();
    };
  }, [handleHoverOut]);

  return (
    <GestureDetector gesture={gesture}>
      <Pressable
        ref={hitAreaRef}
        testID={testID}
        dataSet={RESIZE_HANDLE_DATASET}
        style={hitAreaStyle}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
      >
        {highlighted ? (
          <View pointerEvents="none" testID={`${testID}-highlight`} style={styles.highlight} />
        ) : null}
      </Pressable>
    </GestureDetector>
  );
}

function TouchResizeHandle({ edge, gesture, pressed, testID }: SidebarResizeHandleProps) {
  const geometry = resolveSidebarResizeHandleGeometry(false);
  // `box-none` keeps the full-height column out of hit-testing so only the
  // grab target steals taps from the rows behind it.
  const layerStyle = [
    styles.touchLayer,
    { width: geometry.width },
    edgeOffsetStyle(edge, geometry.edgeOffset),
  ];
  const targetStyle = [
    styles.touchTarget,
    { width: geometry.width, height: geometry.height ?? undefined },
  ];
  const gripStyle = [
    styles.grip,
    edge === "left" ? styles.leftEdgeGrip : styles.rightEdgeGrip,
    pressed ? styles.visibleGrip : styles.hiddenGrip,
  ];

  return (
    <View pointerEvents="box-none" style={layerStyle}>
      <GestureDetector gesture={gesture}>
        <View
          testID={testID}
          role="separator"
          aria-orientation="vertical"
          collapsable={false}
          style={targetStyle}
        >
          <View pointerEvents="none" testID={`${testID}-grip`} style={gripStyle} />
        </View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  hitArea: {
    position: "absolute",
    top: 0,
    bottom: 0,
    zIndex: 10,
  },
  highlight: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 4,
    width: 3,
    backgroundColor: theme.colors.accent,
  },
  touchLayer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  touchTarget: {
    alignItems: "center",
    justifyContent: "center",
  },
  grip: {
    width: 4,
    height: 36,
    borderRadius: 2,
    backgroundColor: theme.colors.foreground,
  },
  hiddenGrip: {
    opacity: 0,
  },
  visibleGrip: {
    opacity: 0.3,
  },
  leftEdgeGrip: {
    alignSelf: "flex-start",
    marginLeft: theme.spacing[0.5],
  },
  rightEdgeGrip: {
    alignSelf: "flex-end",
    marginRight: theme.spacing[0.5],
  },
}));
