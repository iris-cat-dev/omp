import { createElement, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Modal, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image as ExpoImage } from "expo-image";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { isWeb } from "@/constants/platform";
import {
  getOverlayRoot,
  OverlayLayerProvider,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";
import { WindowChromeRootRegion, WindowChromeSafeArea } from "@/utils/desktop-window";

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
  const uri = useAttachmentPreviewUrl(metadata);
  return metadata ? <ImageLightbox uri={uri} onClose={onClose} /> : null;
}

export function ImageLightbox({ uri, alt, onClose }: ImageLightboxProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setErrored(false);
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

  const handleImageError = useCallback(() => setErrored(true), []);
  const imageSource = useMemo(() => ({ uri: uri ?? "" }), [uri]);

  const hasError = errored || !uri;
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
                <View style={styles.imageContainer}>
                  <ExpoImage
                    testID="attachment-lightbox-image"
                    source={imageSource}
                    accessibilityLabel={alt}
                    contentFit="contain"
                    onError={handleImageError}
                    style={imageFillStyle}
                  />
                </View>
              )}
            </View>
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

const imageFillStyle = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

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
  imageContainer: {
    flex: 1,
    width: "100%",
    alignSelf: "center",
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
