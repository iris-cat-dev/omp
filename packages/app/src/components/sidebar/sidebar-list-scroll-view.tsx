import { useCallback, useRef } from "react";
import { ScrollView, StyleSheet, View, type ScrollViewProps } from "react-native";
import { POINTER_HANDLE_WIDTH } from "@/components/sidebar-resize-handle-layout";
import { DomOverlayScrollbar } from "@/components/ui/overlay-scrollbar/dom-overlay-scrollbar";
import { useIsCompactFormFactor } from "@/constants/layout";

const OVERLAY_SCROLLBAR_DATASET = { overlayScrollbar: "true" };

type SidebarListScrollViewProps = Pick<
  ScrollViewProps,
  "children" | "style" | "contentContainerStyle" | "testID"
>;

export function SidebarListScrollView(props: SidebarListScrollViewProps) {
  const overlayEnabled = !useIsCompactFormFactor();
  const scrollContainerRef = useRef<HTMLElement>(null);
  const setScrollView = useCallback((scrollView: ScrollView | null) => {
    scrollContainerRef.current = scrollView?.getScrollableNode() ?? null;
  }, []);

  return (
    <>
      <ScrollView
        {...props}
        ref={setScrollView}
        dataSet={overlayEnabled ? OVERLAY_SCROLLBAR_DATASET : undefined}
        showsVerticalScrollIndicator={!overlayEnabled}
      />
      {overlayEnabled ? (
        <View style={styles.scrollbarLayer} pointerEvents="box-none">
          <DomOverlayScrollbar scrollContainerRef={scrollContainerRef} />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  scrollbarLayer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    // Keep the entire visible thumb clear of the resize target straddling the sidebar edge.
    right: POINTER_HANDLE_WIDTH / 2,
  },
});
