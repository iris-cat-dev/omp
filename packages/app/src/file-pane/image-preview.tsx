import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  PanResponder,
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import { Image, type ImageLoadEventData } from "expo-image";
import { Maximize, Minus, Plus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { recordImagePreviewDimensions } from "@/attachments/preview-resource";
import {
  getFittedImageSize,
  getZoomState,
  INITIAL_LIGHTBOX_VIEW,
  LIGHTBOX_ZOOM_STEP,
  lightboxViewReducer,
} from "@/components/attachment-lightbox-transform";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { paneContentToolbarIconButtonStyle } from "@/components/ui/pane-content-toolbar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { FilePanelBar } from "./bar";

const ThemedSpinner = withUnistyles(LoadingSpinner);
const ThemedMinus = withUnistyles(Minus);
const ThemedPlus = withUnistyles(Plus);
const ThemedMaximize = withUnistyles(Maximize);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const INITIAL_IMAGE_VIEW = { ...INITIAL_LIGHTBOX_VIEW, minFitScale: 0.25 };

export function FileImagePreview({
  uri,
  filename,
  size,
}: {
  uri: string | null;
  filename: string;
  size: number;
}) {
  const { t } = useTranslation();
  const [view, dispatch] = useReducer(lightboxViewReducer, INITIAL_IMAGE_VIEW);
  const [errored, setErrored] = useState(false);
  const zoom = getZoomState(view);
  const ready = !errored && zoom.percent !== null;
  const canPan = ready && zoom.canPan;
  const canPanRef = useRef(canPan);
  canPanRef.current = canPan;
  const viewportRef = useRef<View>(null);
  const imageSource = useMemo(() => (uri ? { uri } : null), [uri]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => canPanRef.current,
        onMoveShouldSetPanResponder: () => canPanRef.current,
        onPanResponderGrant: () => dispatch({ type: "panStart" }),
        onPanResponderMove: (_event, { dx, dy }) => dispatch({ type: "panMove", dx, dy }),
        onPanResponderRelease: () => dispatch({ type: "panEnd" }),
        onPanResponderTerminate: () => dispatch({ type: "panEnd" }),
      }),
    [],
  );

  useEffect(() => {
    if (!isWeb || !ready) return;
    const viewport = viewportRef.current as unknown;
    if (!(viewport instanceof HTMLElement)) return;
    function handleWheel(this: HTMLElement, event: WheelEvent) {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const { left, top, width, height } = this.getBoundingClientRect();
      const pixels = event.deltaMode === 0 ? event.deltaY : event.deltaY * 40;
      const factor = Math.exp(-pixels * 0.0025);
      dispatch({
        type: "zoomBy",
        factor: Math.min(LIGHTBOX_ZOOM_STEP, Math.max(1 / LIGHTBOX_ZOOM_STEP, factor)),
        focus: { x: event.clientX - left - width / 2, y: event.clientY - top - height / 2 },
      });
    }
    // Capture the primary pointer instead of letting the browser drag the <img>.
    let drag: { id: number; x: number; y: number } | null = null;
    function handlePointerDown(this: HTMLElement, event: PointerEvent) {
      if (!canPanRef.current || !event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      this.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      dispatch({ type: "panStart" });
    }
    function handlePointerMove(event: PointerEvent) {
      if (drag?.id !== event.pointerId) return;
      dispatch({ type: "panMove", dx: event.clientX - drag.x, dy: event.clientY - drag.y });
    }
    function handleLostCapture(event: PointerEvent) {
      if (drag?.id !== event.pointerId) return;
      drag = null;
      dispatch({ type: "panEnd" });
    }
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    viewport.addEventListener("pointerdown", handlePointerDown);
    viewport.addEventListener("pointermove", handlePointerMove);
    viewport.addEventListener("lostpointercapture", handleLostCapture);
    return () => {
      viewport.removeEventListener("wheel", handleWheel);
      viewport.removeEventListener("pointerdown", handlePointerDown);
      viewport.removeEventListener("pointermove", handlePointerMove);
      viewport.removeEventListener("lostpointercapture", handleLostCapture);
    };
  }, [ready]);

  const handleLoad = useCallback(
    ({ source }: ImageLoadEventData) => {
      const { width, height } = source;
      if (width > 0 && height > 0) {
        if (uri) recordImagePreviewDimensions(uri, width, height);
        dispatch({ type: "loaded", natural: { width, height } });
      }
    },
    [uri],
  );
  const handleError = useCallback(() => setErrored(true), []);
  const handleLayout = useCallback(
    ({
      nativeEvent: {
        layout: { width, height },
      },
    }: LayoutChangeEvent) => dispatch({ type: "layout", viewport: { width, height } }),
    [],
  );
  const zoomOut = useCallback(
    () => dispatch({ type: "zoomBy", factor: 1 / LIGHTBOX_ZOOM_STEP }),
    [],
  );
  const zoomIn = useCallback(() => dispatch({ type: "zoomBy", factor: LIGHTBOX_ZOOM_STEP }), []);
  const showActualSize = useCallback(() => dispatch({ type: "actualSize" }), []);
  const fit = useCallback(() => dispatch({ type: "fit" }), []);

  const { viewport, natural, transform } = view;
  const frameStyle = useMemo(() => {
    const fitted = getFittedImageSize(viewport, natural);
    const { scale, x, y } = transform;
    return {
      position: "absolute" as const,
      width: fitted.width,
      height: fitted.height,
      left: ((viewport?.width ?? 0) - fitted.width) / 2,
      top: ((viewport?.height ?? 0) - fitted.height) / 2,
      transform: [{ translateX: x }, { translateY: y }, { scale }],
    };
  }, [viewport, natural, transform]);
  const actions = ready ? (
    <View style={styles.controls}>
      <ZoomButton
        testID="file-image-zoom-out"
        label={t("message.attachments.zoomOut")}
        disabled={!zoom.canZoomOut}
        onPress={zoomOut}
      >
        <ThemedMinus size={14} uniProps={mutedColor} />
      </ZoomButton>
      <ZoomButton
        testID="file-image-actual-size"
        label={t("message.attachments.actualSize")}
        onPress={showActualSize}
      >
        <Text style={styles.percent}>{zoom.percent}%</Text>
      </ZoomButton>
      <ZoomButton
        testID="file-image-zoom-in"
        label={t("message.attachments.zoomIn")}
        disabled={!zoom.canZoomIn}
        onPress={zoomIn}
      >
        <ThemedPlus size={14} uniProps={mutedColor} />
      </ZoomButton>
      <View style={styles.divider} />
      <ZoomButton
        testID="file-image-fit"
        label={t("message.attachments.fitToWindow")}
        onPress={fit}
      >
        <ThemedMaximize size={14} uniProps={mutedColor} />
      </ZoomButton>
    </View>
  ) : null;

  return (
    <>
      <FilePanelBar size={size}>{actions}</FilePanelBar>
      <View
        ref={viewportRef}
        testID="file-image-viewport"
        onLayout={handleLayout}
        style={[
          styles.viewport,
          isWeb &&
            canPan &&
            ({ cursor: view.panOrigin ? "grabbing" : "grab", touchAction: "none" } as object),
        ]}
        {...(isWeb ? undefined : panResponder.panHandlers)}
      >
        {imageSource && !errored ? (
          <Image
            testID="file-image"
            accessibilityLabel={filename}
            source={imageSource}
            contentFit="contain"
            allowDownscaling={false}
            onLoad={handleLoad}
            onError={handleError}
            style={frameStyle}
          />
        ) : null}
        {errored ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {t("message.attachments.imageLoadFailed")}
          </Text>
        ) : null}
        {!uri ? <ThemedSpinner size="small" uniProps={mutedColor} /> : null}
      </View>
    </>
  );
}

function ZoomButton({
  children,
  testID,
  label,
  disabled,
  onPress,
}: {
  children: ReactNode;
  testID: string;
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const buttonStyle = useCallback(
    (state: PressableStateCallbackType) => [
      paneContentToolbarIconButtonStyle(state),
      styles.button,
      disabled && styles.disabled,
    ],
    [disabled],
  );
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          testID={testID}
          accessibilityRole="button"
          accessibilityLabel={label}
          disabled={disabled}
          onPress={onPress}
          style={buttonStyle}
        >
          {children}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <Text style={styles.tooltip}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  viewport: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    userSelect: "none",
  },
  controls: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
  button: { width: "auto", minWidth: 24, paddingHorizontal: theme.spacing[1] },
  disabled: { opacity: 0.4 },
  percent: {
    minWidth: 36,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
    textAlign: "center",
  },
  divider: {
    width: 1,
    height: 14,
    backgroundColor: theme.colors.border,
    marginHorizontal: theme.spacing[1],
  },
  tooltip: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  error: {
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    fontSize: theme.fontSize.base,
  },
}));
