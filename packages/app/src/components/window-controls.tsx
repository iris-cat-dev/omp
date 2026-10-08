import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, View, type PressableStateCallbackType } from "react-native";
import { Minus, Square, Copy, X } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { getIsElectron, getIsElectronMac } from "@/constants/platform";
import {
  closeDesktopWindow,
  minimizeDesktopWindow,
  toggleDesktopMaximize,
} from "@/desktop/electron/window";
import { useIsDesktopWindowMaximized } from "@/utils/desktop-window";
import type { Theme } from "@/styles/theme";

const BUTTON_WIDTH = 46;
const CONTROL_HEIGHT = 32;
const ICON_SIZE = 14;

const OVERLAY_DATASET = { "window-controls-overlay": "true" } as const;

// Match the tab strip's own button ink (extra-muted) so the controls stay
// legible on the transparent strip; the drop-shadow on the icon covers bright
// wallpapers that would otherwise wash the glyph out.
const extraMutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const ThemedMinus = withUnistyles(Minus, extraMutedIcon);
const ThemedSquare = withUnistyles(Square, extraMutedIcon);
const ThemedCopy = withUnistyles(Copy, extraMutedIcon);
const ThemedX = withUnistyles(X, extraMutedIcon);

type HoverableState = PressableStateCallbackType & { hovered?: boolean };

/**
 * Windows/Linux window controls drawn by the renderer instead of Electron's
 * native `titleBarOverlay`. The OS-drawn strip cannot be made transparent
 * (electron/electron#51014) and would sit opaquely on top of the wallpaper.
 *
 * macOS keeps its native traffic lights (titleBarOverlay: true) and is
 * skipped entirely.
 */
export function WindowControls() {
  const isMaximized = useIsDesktopWindowMaximized();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (getIsElectronMac()) return;
    if (!getIsElectron()) return;
    setVisible(true);
  }, []);

  const handleMinimize = useCallback(() => void minimizeDesktopWindow(), []);
  const handleToggleMaximize = useCallback(() => void toggleDesktopMaximize(), []);
  const handleClose = useCallback(() => void closeDesktopWindow(), []);
  const buttonStyle = useCallback(({ hovered }: HoverableState) => {
    return [styles.button, hovered && styles.buttonHover];
  }, []);
  const closeButtonStyle = useCallback(({ hovered }: HoverableState) => {
    return [styles.button, styles.closeButton, hovered && styles.closeButtonHover];
  }, []);

  if (!visible) return null;

  return (
    <View dataSet={OVERLAY_DATASET} style={styles.container} accessibilityLabel="Window controls">
      <Pressable
        onPress={handleMinimize}
        style={buttonStyle}
        accessibilityRole="button"
        accessibilityLabel="Minimize window"
      >
        <View style={styles.icon}>
          <ThemedMinus size={ICON_SIZE} strokeWidth={1.5} />
        </View>
      </Pressable>
      <Pressable
        onPress={handleToggleMaximize}
        style={buttonStyle}
        accessibilityRole="button"
        accessibilityLabel={isMaximized ? "Restore window" : "Maximize window"}
      >
        <View style={styles.icon}>
          {isMaximized ? (
            <ThemedCopy size={ICON_SIZE - 1} strokeWidth={1.5} />
          ) : (
            <ThemedSquare size={ICON_SIZE - 2} strokeWidth={1.5} />
          )}
        </View>
      </Pressable>
      <Pressable
        onPress={handleClose}
        style={closeButtonStyle}
        accessibilityRole="button"
        accessibilityLabel="Close window"
      >
        <View style={styles.icon}>
          <ThemedX size={ICON_SIZE} strokeWidth={1.5} />
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    right: 0,
    flexDirection: "row",
    height: CONTROL_HEIGHT,
    zIndex: 1000,
  },
  button: {
    width: BUTTON_WIDTH,
    height: CONTROL_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonHover: {
    backgroundColor: "rgba(128, 128, 128, 0.25)",
  },
  icon: {
    alignItems: "center",
    justifyContent: "center",
    // Keep controls legible on any wallpaper (the tab strip is transparent),
    // not just against the theme's assumed background.
    filter: "drop-shadow(0 0 1px rgba(0, 0, 0, 0.7)) drop-shadow(0 0 0.5px rgba(0, 0, 0, 0.5))",
  },
  closeButton: {},
  closeButtonHover: {
    backgroundColor: "#e81123",
  },
});
