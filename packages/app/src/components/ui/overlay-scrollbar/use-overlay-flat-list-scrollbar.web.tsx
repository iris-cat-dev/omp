import { useCallback, useState, type RefObject } from "react";
import {
  FlatList,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { OverlayScrollbar, type OverlayScrollbarMetrics } from "./overlay-scrollbar";
import type { OverlayFlatListScrollbar } from "./use-overlay-flat-list-scrollbar";

export function useOverlayFlatListScrollbar<ItemT>(
  listRef: RefObject<FlatList<ItemT> | null>,
  options: { enabled: boolean },
): OverlayFlatListScrollbar {
  const [metrics, setMetrics] = useState<OverlayScrollbarMetrics>({
    offset: 0,
    viewportSize: 0,
    contentSize: 0,
  });

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offset = Math.max(0, event.nativeEvent.contentOffset.y);
    const viewportSize = Math.max(0, event.nativeEvent.layoutMeasurement.height);
    const contentSize = Math.max(0, event.nativeEvent.contentSize.height);
    setMetrics((previous) =>
      previous.offset === offset &&
      previous.viewportSize === viewportSize &&
      previous.contentSize === contentSize
        ? previous
        : { offset, viewportSize, contentSize },
    );
  }, []);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const viewportSize = Math.max(0, event.nativeEvent.layout.height);
    setMetrics((previous) =>
      previous.viewportSize === viewportSize ? previous : { ...previous, viewportSize },
    );
  }, []);
  const onContentSizeChange = useCallback((_width: number, height: number) => {
    const contentSize = Math.max(0, height);
    setMetrics((previous) =>
      previous.contentSize === contentSize ? previous : { ...previous, contentSize },
    );
  }, []);
  const scrollToOffset = useCallback(
    (offset: number) => listRef.current?.scrollToOffset({ offset, animated: false }),
    [listRef],
  );

  return {
    enabled: options.enabled,
    onContentSizeChange,
    onLayout,
    onScroll,
    overlay: options.enabled ? (
      <OverlayScrollbar metrics={metrics} onScrollToOffset={scrollToOffset} />
    ) : null,
  };
}
