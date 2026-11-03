import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentProvider } from "@omp-desktop/protocol/agent-types";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Combobox, type ComboboxOption, type ComboboxProps } from "@/components/ui/combobox";
import { ModelBrowser, useModelBrowser } from "@/components/model-browser";
import { isNative, isWeb } from "@/constants/platform";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { resolveModelBrowserProviderId } from "@/composer/agent-controls/model-sheet-flow";

const EMPTY_COMBOBOX_OPTIONS: ComboboxOption[] = [];
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const foregroundMutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

function noop() {}

interface CombinedModelSelectorProps {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  selectionDetail?: string;
  onSelect: (provider: AgentProvider, modelId: string) => void | Promise<void>;
  isLoading: boolean;
  renderTrigger?: (input: {
    selectedModelLabel: string;
    onPress: () => void;
    disabled: boolean;
    isOpen: boolean;
    hovered: boolean;
    pressed: boolean;
  }) => React.ReactNode;
  onOpen?: () => void;
  onClose?: () => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider?: boolean;
  disabled?: boolean;
  /** Open the active provider's models directly; provider switching is owned by another surface. */
  browseProviders?: boolean;
  desktopPlacement?: ComboboxProps["desktopPlacement"];
  desktopMinWidth?: number;
  /**
   * Render the custom trigger as a full-width form field: the outer Pressable
   * becomes a transparent passthrough that stretches its child edge-to-edge and
   * stops painting its own hover/pressed background and rounded corners. The
   * trigger itself owns the field visuals and reads hovered/pressed to show its
   * active state. Without this the trigger stays a content-width toolbar chip
   * (the composer's layout).
   */
  triggerFill?: boolean;
  toolbar?: {
    showCaret: boolean;
  };
  footer?: ReactNode;
  triggerAccessory?: ReactNode;
  dismissOnSelect?: boolean;
  open?: boolean;
}

export function CombinedModelSelector({
  providers,
  selectedProvider,
  selectedModel,
  selectionDetail,
  onSelect,
  isLoading,
  renderTrigger,
  onOpen,
  onClose,
  onRetryProvider,
  isRetryingProvider = false,
  disabled = false,
  browseProviders = true,
  desktopPlacement,
  desktopMinWidth,
  triggerFill = false,
  toolbar,
  footer,
  triggerAccessory,
  dismissOnSelect = true,
  open,
}: CombinedModelSelectorProps) {
  const { t } = useTranslation();
  const anchorRef = useRef<View>(null);
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const selectionPendingRef = useRef(false);
  const [isContentReady, setIsContentReady] = useState(isWeb);
  const browserSelectedProvider = resolveModelBrowserProviderId(
    selectedProvider,
    selectedModel,
    providers,
  );
  const browser = useModelBrowser({
    providers,
    selectedProvider: browserSelectedProvider,
    selectedModel,
    isLoading,
    browseProviders,
  });
  const { prepareToOpen, reset, showAll } = browser;
  const footerBaseHeightRef = useRef<number | null>(null);
  const [footerHeightDelta, setFooterHeightDelta] = useState(0);
  const desktopFixedHeight = useMemo(
    () =>
      browser.desktopFixedHeight == null
        ? undefined
        : browser.desktopFixedHeight + footerHeightDelta,
    [browser.desktopFixedHeight, footerHeightDelta],
  );

  const handleFooterLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    const baseHeight = footerBaseHeightRef.current;
    if (baseHeight === null || height < baseHeight) {
      footerBaseHeightRef.current = height;
      setFooterHeightDelta(0);
      return;
    }
    setFooterHeightDelta((current) => {
      const next = height - baseHeight;
      return current === next ? current : next;
    });
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && !dismissOnSelect && selectionPendingRef.current) return;
      if (open === undefined) setInternalOpen(nextOpen);
      if (nextOpen) {
        if (browseProviders) {
          showAll();
        } else {
          prepareToOpen();
        }
        onOpen?.();
        return;
      }
      reset();
      onClose?.();
    },
    [browseProviders, dismissOnSelect, onClose, onOpen, open, prepareToOpen, reset, showAll],
  );

  const handleSelect = useCallback(
    (provider: string, modelId: string) => {
      if (!dismissOnSelect) selectionPendingRef.current = true;
      const selection = onSelect(provider, modelId);
      if (dismissOnSelect) {
        handleOpenChange(false);
        return;
      }
      void Promise.resolve(selection).finally(() => {
        selectionPendingRef.current = false;
      });
    },
    [dismissOnSelect, handleOpenChange, onSelect],
  );

  useEffect(() => {
    if (isWeb) return () => {};
    if (!isOpen) {
      setIsContentReady(false);
      return () => {};
    }
    const frame = requestAnimationFrame(() => {
      setIsContentReady(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  const handleTriggerPress = useCallback(() => {
    handleOpenChange(!isOpen);
  }, [handleOpenChange, isOpen]);

  const triggerStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => {
      if (triggerFill) {
        return [
          styles.trigger,
          styles.customTriggerWrapper,
          styles.triggerFill,
          disabled && styles.triggerDisabled,
        ];
      }
      return [
        styles.trigger,
        Boolean(hovered) && styles.triggerHovered,
        (pressed || isOpen) && styles.triggerPressed,
        disabled && styles.triggerDisabled,
        renderTrigger ? styles.customTriggerWrapper : null,
      ];
    },
    [disabled, isOpen, renderTrigger, triggerFill],
  );

  const browserBody = isContentReady ? (
    <ModelBrowser
      state={browser}
      onSelect={handleSelect}
      onRetryProvider={onRetryProvider}
      isRetryingProvider={isRetryingProvider}
      scrolling={isWeb ? "independent" : "sheet"}
    />
  ) : (
    <View style={styles.sheetLoadingState}>
      <ThemedLoadingSpinner size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
      <Text style={styles.sheetLoadingText}>{t("modelSelector.loadingSelector")}</Text>
    </View>
  );
  const selectorBody = footer ? (
    <View style={styles.selectorContent}>
      <View style={styles.selectorBrowser}>{browserBody}</View>
      <View onLayout={handleFooterLayout}>{footer}</View>
    </View>
  ) : (
    browserBody
  );

  return (
    <>
      {renderTrigger ? (
        <Pressable
          ref={anchorRef}
          collapsable={false}
          disabled={disabled}
          onPress={handleTriggerPress}
          style={triggerStyle}
          accessibilityRole="button"
          accessibilityLabel={t("modelSelector.selectedModel", {
            model: [browser.selectedModelLabel, selectionDetail].filter(Boolean).join(" · "),
          })}
          testID="combined-model-selector"
        >
          {({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) =>
            renderTrigger({
              selectedModelLabel: browser.triggerLabel,
              onPress: handleTriggerPress,
              disabled,
              isOpen,
              hovered: Boolean(hovered),
              pressed,
            })
          }
        </Pressable>
      ) : (
        <ComboboxTrigger
          ref={anchorRef}
          collapsable={false}
          disabled={disabled}
          onPress={handleTriggerPress}
          style={triggerStyle}
          accessibilityRole="button"
          accessibilityLabel={t("modelSelector.selectedModel", {
            model: [browser.selectedModelLabel, selectionDetail].filter(Boolean).join(" · "),
          })}
          testID="combined-model-selector"
          chevron={toolbar?.showCaret === false ? null : undefined}
        >
          <Text style={styles.triggerText} numberOfLines={1} ellipsizeMode="tail">
            {browser.triggerLabel}
          </Text>
          {triggerAccessory ? (
            <View style={styles.triggerAccessory}>{triggerAccessory}</View>
          ) : null}
        </ComboboxTrigger>
      )}
      <Combobox
        options={EMPTY_COMBOBOX_OPTIONS}
        value=""
        onSelect={noop}
        open={isOpen}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
        desktopPlacement={desktopPlacement}
        desktopMinWidth={desktopMinWidth}
        desktopLockWidth
        desktopFixedHeight={desktopFixedHeight}
        desktopChildrenScrollEnabled={false}
        header={browser.header}
        mobileChildrenScrollEnabled={!browser.isProviderView || !isNative}
        mobileChildrenContentContainerStyle={styles.mobileBrowserContent}
      >
        {selectorBody}
      </Combobox>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  mobileBrowserContent: {
    paddingHorizontal: 0,
  },
  trigger: {
    height: 28,
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "transparent",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface0,
  },
  triggerDisabled: {
    opacity: 0.5,
  },
  triggerText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  triggerAccessory: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  selectorContent: {
    flex: 1,
    minHeight: 0,
  },
  selectorBrowser: {
    flex: 1,
    minHeight: 0,
  },
  customTriggerWrapper: {
    paddingHorizontal: 0,
    paddingVertical: 0,
    height: "auto",
  },
  triggerFill: {
    alignSelf: "stretch",
    flexShrink: 0,
    flexDirection: "column",
    alignItems: "stretch",
    backgroundColor: "transparent",
    borderRadius: 0,
  },
  sheetLoadingState: {
    minHeight: 160,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  sheetLoadingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
