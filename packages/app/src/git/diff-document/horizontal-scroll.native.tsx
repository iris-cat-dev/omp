import { useLayoutEffect, useMemo, useRef } from "react";
import { View } from "react-native";
import { ScrollView, type ScrollView as ScrollViewType } from "react-native-gesture-handler";
import {
  createAnimatedComponent,
  useAnimatedScrollHandler,
  type SharedValue,
} from "react-native-reanimated";
import { horizontalOffsetForPath, type DiffHorizontalOffsets } from "./horizontal-offsets";
import type { DiffFileSection } from "./types";

const AnimatedHorizontalScrollView = createAnimatedComponent(ScrollView);

export function HorizontalScroll({
  file,
  offsets,
}: {
  file: DiffFileSection;
  offsets: SharedValue<DiffHorizontalOffsets>;
}) {
  const scrollRef = useRef<ScrollViewType>(null);
  const handler = useAnimatedScrollHandler({
    onScroll(event) {
      offsets.value = { ...offsets.value, [file.path]: event.contentOffset.x };
    },
  });
  useLayoutEffect(() => {
    const retainedOffset = horizontalOffsetForPath(offsets.value, file.path);
    scrollRef.current?.scrollTo({ x: retainedOffset, animated: false });
  }, [file.path, offsets]);
  const rootStyle = useMemo(
    () => ({
      position: "absolute" as const,
      top: 0,
      left: 0,
      right: 0,
      height: file.bodyHeight,
      backgroundColor: "transparent",
    }),
    [file.bodyHeight],
  );
  const spacerStyle = useMemo(
    () => ({
      width: file.contentWidth,
      height: file.bodyHeight,
      backgroundColor: "transparent",
    }),
    [file.bodyHeight, file.contentWidth],
  );
  return (
    <AnimatedHorizontalScrollView
      ref={scrollRef}
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator
      bounces={false}
      style={rootStyle}
      contentContainerStyle={spacerStyle}
      onScroll={handler}
      scrollEventThrottle={16}
    >
      <View style={spacerStyle} />
    </AnimatedHorizontalScrollView>
  );
}
