import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { createPortal } from "react-dom";
import { Modal, PanResponder, Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image as ExpoImage, type ImageLoadEventData } from "expo-image";
import { Maximize, Scan, X, ZoomIn, ZoomOut } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { recordImagePreviewDimensions } from "@/attachments/preview-resource";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { isWeb } from "@/constants/platform";
import {
  getOverlayRoot,
  OverlayLayerProvider,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";
import { WindowChromeRootRegion, WindowChromeSafeArea } from "@/utils/desktop-window";
import {
  getFittedImageSize,
  getZoomState,
  INITIAL_LIGHTBOX_VIEW,
  LIGHTBOX_ZOOM_STEP,
  lightboxViewReducer,
} from "./attachment-lightbox-transform";

interface AttachmentLightboxProps {
  metadata: AttachmentMetadata | null;
  onClose: () => void;
}

interface ImageLightboxProps {
  uri: string | null;
  alt?: string;
  onClose: () => void;
}

export function AttachmentLightbox({ metadata, onClose }: AttachmentLightboxProps) {
  const active = useRetainedPanelActive();
  const uri = useAttachmentPreviewUrl(active ? metadata : null);
  return active && metadata ? <ImageLightbox uri={uri} onClose={onClose} /> : null;
}

export function ImageLightbox({ uri, alt, onClose }: ImageLightboxProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [errored, setErrored] = useState(false);
  const [view, dispatchView] = useReducer(lightboxViewReducer, INITIAL_LIGHTBOX_VIEW);
  const zoom = getZoomState(view);
  const canPanRef = useRef(zoom.canPan);
  canPanRef.current = zoom.canPan;
  const viewportRef = useRef<View | null>(null);

  useEffect(() => {
    setErrored(false);
    dispatchView({ type: "reset" });
  }, [uri]);

  const modalLayer = useGlobalWebOverlayLayer("modal", isWeb);
  const handleWebOverlayKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      onClose();
      return true;
    },
    [onClose],
  );
  const setWebOverlayScope = useWebOverlayRegistration({
    active: isWeb,
    layer: modalLayer,
    onKeyDown: handleWebOverlayKeyDown,
  });

  const closeButtonRowStyle = useMemo(
    () => [
      styles.closeButtonRow,
      {
        top: insets.top + theme.spacing[3],
      },
    ],
    [insets.top, theme.spacing],
  );
  const closeButtonStyle = useMemo(
    () => [styles.closeButton, { marginRight: insets.right + theme.spacing[3] }],
    [insets.right, theme.spacing],
  );
  const zoomToolbarStyle = useMemo(
    () => [styles.zoomToolbar, { bottom: insets.bottom + theme.spacing[4] }],
    [insets.bottom, theme.spacing],
  );

  const handleImageError = useCallback(() => setErrored(true), []);
  const handleImageLoad = useCallback((event: ImageLoadEventData) => {
    const { width, height } = event.source;
    if (width > 0 && height > 0) {
      if (uri) recordImagePreviewDimensions(uri, width, height);
      dispatchView({ type: "loaded", natural: { width, height } });
    }
  }, [uri]);
  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    dispatchView({ type: "layout", viewport: { width, height } });
  }, []);
  const imageSource = useMemo(() => ({ uri: uri ?? "" }), [uri]);

  const zoomIn = useCallback(
    () => dispatchView({ type: "zoomBy", factor: LIGHTBOX_ZOOM_STEP }),
    [],
  );
  const zoomOut = useCallback(
    () => dispatchView({ type: "zoomBy", factor: 1 / LIGHTBOX_ZOOM_STEP }),
    [],
  );
  const fitToWindow = useCallback(() => dispatchView({ type: "fit" }), []);
  const showActualSize = useCallback(() => dispatchView({ type: "actualSize" }), []);

  // Drags pan only while the zoomed image overflows the viewport; the viewport never
  // forwards presses to the backdrop, so panning cannot dismiss the preview.
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => canPanRef.current,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => dispatchView({ type: "panStart" }),
        onPanResponderMove: (_event, gesture) => {
          if (canPanRef.current) {
            dispatchView({ type: "panMove", dx: gesture.dx, dy: gesture.dy });
          }
        },
        onPanResponderRelease: () => dispatchView({ type: "panEnd" }),
        onPanResponderTerminate: () => dispatchView({ type: "panEnd" }),
      }),
    [],
  );

  const hasError = errored || !uri;

  useEffect(() => {
    if (!isWeb || hasError) return;
    const node = viewportRef.current as unknown;
    if (!(node instanceof HTMLElement)) return;
    const viewport = node;
    function zoomWithWheel(event: WheelEvent): void {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      // Normalise line/page deltas so one wheel notch is roughly one zoom step.
      const pixels = event.deltaMode === 0 ? event.deltaY : event.deltaY * 40;
      const factor = Math.exp(-pixels * 0.0025);
      dispatchView({
        type: "zoomBy",
        factor: Math.min(LIGHTBOX_ZOOM_STEP, Math.max(1 / LIGHTBOX_ZOOM_STEP, factor)),
        focus: {
          x: event.clientX - rect.left - rect.width / 2,
          y: event.clientY - rect.top - rect.height / 2,
        },
      });
    }
    viewport.addEventListener("wheel", zoomWithWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", zoomWithWheel);
  }, [hasError]);

  const fitted = getFittedImageSize(view.viewport, view.natural);
  const imageFrameStyle = useMemo(
    () => [
      styles.imageFrame,
      {
        width: fitted.width,
        height: fitted.height,
        left: ((view.viewport?.width ?? 0) - fitted.width) / 2,
        top: ((view.viewport?.height ?? 0) - fitted.height) / 2,
        transform: [
          { translateX: view.transform.x },
          { translateY: view.transform.y },
          { scale: view.transform.scale },
        ],
      },
    ],
    [fitted.height, fitted.width, view.transform, view.viewport],
  );
  let viewportCursorStyle: object | null = null;
  if (isWeb && zoom.canPan) {
    viewportCursorStyle = { cursor: view.panOrigin ? "grabbing" : "grab" };
  }

  const content = (
    <OverlayLayerProvider layer={isWeb ? modalLayer : 0}>
      <WindowChromeRootRegion corners="both">
        <View
          ref={setWebOverlayScope}
          style={[
            styles.root,
            isWeb ? styles.rootWeb : null,
            isWeb ? { zIndex: modalLayer } : null,
          ]}
          testID="attachment-lightbox"
          role={isWeb ? "dialog" : undefined}
          aria-modal={isWeb ? true : undefined}
          tabIndex={isWeb ? -1 : undefined}
        >
          <Pressable
            testID="attachment-lightbox-backdrop"
            accessibilityRole="button"
            accessibilityLabel={t("message.attachments.dismissImage")}
            onPress={onClose}
            style={styles.backdrop}
          />
          <View style={styles.contentLayer}>
            <View style={styles.imageArea}>
              {hasError ? (
                <Text style={styles.errorText}>{t("message.attachments.imageLoadFailed")}</Text>
              ) : (
                <View
                  ref={viewportRef}
                  testID="attachment-lightbox-viewport"
                  onLayout={handleViewportLayout}
                  style={[styles.imageViewport, viewportCursorStyle]}
                  {...panResponder.panHandlers}
                >
                  <ExpoImage
                    testID="attachment-lightbox-image"
                    source={imageSource}
                    accessibilityLabel={alt}
                    contentFit="contain"
                    onLoad={handleImageLoad}
                    onError={handleImageError}
                    style={imageFrameStyle}
                  />
                </View>
              )}
            </View>
            {hasError ? null : (
              <View style={zoomToolbarStyle} testID="attachment-lightbox-zoom-controls">
                <LightboxControlButton
                  testID="attachment-lightbox-zoom-out"
                  icon={ZoomOut}
                  label={t("message.attachments.zoomOut")}
                  onPress={zoomOut}
                  disabled={!zoom.canZoomOut}
                />
                <Text style={styles.zoomPercent} testID="attachment-lightbox-zoom-level">
                  {zoom.percent === null ? "" : `${zoom.percent}%`}
                </Text>
                <LightboxControlButton
                  testID="attachment-lightbox-zoom-in"
                  icon={ZoomIn}
                  label={t("message.attachments.zoomIn")}
                  onPress={zoomIn}
                  disabled={!zoom.canZoomIn}
                />
                <View style={styles.zoomDivider} />
                <LightboxControlButton
                  testID="attachment-lightbox-fit"
                  icon={Maximize}
                  label={t("message.attachments.fitToWindow")}
                  onPress={fitToWindow}
                  disabled={zoom.isFit}
                />
                <LightboxControlButton
                  testID="attachment-lightbox-actual-size"
                  icon={Scan}
                  label={t("message.attachments.actualSize")}
                  onPress={showActualSize}
                  disabled={zoom.isActualSize !== false}
                />
              </View>
            )}
            <WindowChromeSafeArea placement="inline" style={closeButtonRowStyle}>
              <Pressable
                testID="attachment-lightbox-close"
                accessibilityRole="button"
                accessibilityLabel={t("message.attachments.closeImage")}
                hitSlop={8}
                onPress={onClose}
                style={closeButtonStyle}
              >
                <X size={16} color={theme.colors.foregroundMuted} />
              </Pressable>
            </WindowChromeSafeArea>
          </View>
        </View>
      </WindowChromeRootRegion>
    </OverlayLayerProvider>
  );

  if (isWeb && typeof document !== "undefined") {
    return createPortal(content, getOverlayRoot());
  }

  return createElement(
    Modal,
    {
      transparent: true,
      animationType: "fade",
      statusBarTranslucent: true,
      visible: true,
      onRequestClose: onClose,
    },
    content,
  );
}

interface LightboxControlButtonProps {
  testID: string;
  icon: ComponentType<{ size?: number; color?: string }>;
  label: string;
  onPress: () => void;
  disabled: boolean;
}

function LightboxControlButton({
  testID,
  icon: Icon,
  label,
  onPress,
  disabled,
}: LightboxControlButtonProps) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={disabled ? styles.zoomButtonDisabled : styles.zoomButton}
    >
      {({ hovered }) => (
        <Icon
          size={16}
          color={hovered && !disabled ? theme.colors.foreground : theme.colors.foregroundMuted}
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
  },
  rootWeb: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    pointerEvents: "auto",
  },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.9)",
  },
  contentLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: "box-none",
  },
  closeButtonRow: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "flex-end",
    pointerEvents: "box-none",
  },
  imageArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    pointerEvents: "box-none",
  },
  imageViewport: {
    flex: 1,
    width: "100%",
    alignSelf: "center",
    overflow: "hidden",
  },
  imageFrame: {
    position: "absolute",
    pointerEvents: "none",
  },
  zoomToolbar: {
    position: "absolute",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  zoomButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  zoomButtonDisabled: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    opacity: 0.4,
  },
  zoomPercent: {
    minWidth: 48,
    textAlign: "center",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  zoomDivider: {
    width: theme.borderWidth[1],
    height: 16,
    marginHorizontal: theme.spacing[1],
    backgroundColor: theme.colors.border,
  },
  errorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
}));
