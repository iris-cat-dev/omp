import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  useContextMenu,
} from "@/components/ui/context-menu";
import { createControlGeometry } from "@/components/ui/control-geometry";
import type { Rect } from "@/components/ui/menu";
import { getIsElectron, isWeb } from "@/constants/platform";
import { useTranslation } from "react-i18next";
import { getQuotedSelectionText, isSameQuotedSelectionRange } from "@/components/quoted-selection";
import { QuickAskPopover } from "@/components/quick-ask-popover";
import { useShowPersistentActions } from "@/hooks/use-fine-pointer";

const TOUCH_MOVE_CANCEL_PX = 12;
const TOUCH_HIT_SLOP_PX = 12;
const TOUCH_CLICK_DEDUPE_MS = 600;

interface WebContextMenuEvent {
  nativeEvent: { pageX: number; pageY: number; pointerType?: string };
  preventDefault(): void;
  stopPropagation(): void;
}

interface CapturedSelectionAction {
  text: string;
  anchorRect: Rect | null;
}

interface SelectionActionButtonProps {
  label: string;
  onPressStart: () => void;
  onPressCancel: () => void;
  onActivate: () => void;
  testID: string;
}

function findTouchById(touches: TouchList, id: number): Touch | null {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index);
    if (touch && touch.identifier === id) {
      return touch;
    }
  }
  return null;
}

function isWithinExpandedRect(rect: DOMRect, x: number, y: number, slop: number): boolean {
  if (rect.width === 0 && rect.height === 0) {
    return true;
  }
  return (
    x >= rect.left - slop &&
    x <= rect.right + slop &&
    y >= rect.top - slop &&
    y <= rect.bottom + slop
  );
}

function isPrimaryPointerDown(event: PointerEvent): boolean {
  if (event.isPrimary === false) return false;
  return event.pointerType !== "mouse" || event.button === 0;
}

function isTouchLikePointer(pointerType: string): boolean {
  return pointerType === "touch" || pointerType === "pen";
}

function isButtonActivationKey(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

interface SelectionActionDomBindings {
  node: HTMLElement;
  setPressed: (pressed: boolean) => void;
  callbacksRef: RefObject<{
    onPressStart: () => void;
    onPressCancel: () => void;
    onActivate: () => void;
  }>;
}

/**
 * Direct DOM touch/pointer/click/keyboard bindings for transcript selection action buttons.
 *
 * Bypasses react-native-web's PressResponder, whose ResponderSystem terminates presses whenever
 * `document` emits `selectionchange` and then swallows the trailing `click` event on mobile.
 */
function attachSelectionActionListeners({
  node,
  setPressed,
  callbacksRef,
}: SelectionActionDomBindings): () => void {
  let activeTouchId: number | null = null;
  let activePointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let moved = false;
  let touchHandled = false;
  let lastTouchActivatedAt = 0;
  let cancelTimer: ReturnType<typeof setTimeout> | null = null;

  const clearCancelTimer = () => {
    if (cancelTimer !== null) {
      clearTimeout(cancelTimer);
      cancelTimer = null;
    }
  };

  const resetInteraction = (notifyCancel: boolean) => {
    clearCancelTimer();
    activeTouchId = null;
    activePointerId = null;
    moved = false;
    touchHandled = false;
    setPressed(false);
    if (notifyCancel) {
      callbacksRef.current.onPressCancel();
    }
  };

  const schedulePressCancel = () => {
    clearCancelTimer();
    cancelTimer = setTimeout(() => {
      cancelTimer = null;
      callbacksRef.current.onPressCancel();
    }, 0);
  };

  const activateFromTouch = (x: number, y: number) => {
    const inside = isWithinExpandedRect(node.getBoundingClientRect(), x, y, TOUCH_HIT_SLOP_PX);
    const shouldActivate = !moved && inside;
    activeTouchId = null;
    activePointerId = null;
    moved = false;
    touchHandled = false;
    setPressed(false);
    if (shouldActivate) {
      lastTouchActivatedAt = Date.now();
      callbacksRef.current.onActivate();
      return;
    }
    callbacksRef.current.onPressCancel();
  };

  const handleTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) return;
    const touch = event.changedTouches.item(0) ?? event.touches.item(0);
    if (!touch) return;
    clearCancelTimer();
    // Prevent iOS Safari / WKWebView and Android Chrome from collapsing the active selection.
    event.preventDefault();
    event.stopPropagation();
    touchHandled = true;
    activeTouchId = touch.identifier;
    startX = touch.clientX;
    startY = touch.clientY;
    moved = false;
    setPressed(true);
    callbacksRef.current.onPressStart();
  };

  const handleTouchMove = (event: TouchEvent) => {
    if (activeTouchId === null) return;
    const touch =
      findTouchById(event.changedTouches, activeTouchId) ??
      findTouchById(event.touches, activeTouchId);
    if (!touch) return;
    if (Math.hypot(touch.clientX - startX, touch.clientY - startY) > TOUCH_MOVE_CANCEL_PX) {
      moved = true;
      setPressed(false);
    }
  };

  const handleTouchEnd = (event: TouchEvent) => {
    if (activeTouchId === null) return;
    const touch = findTouchById(event.changedTouches, activeTouchId);
    if (!touch) return;
    event.preventDefault();
    event.stopPropagation();
    activateFromTouch(touch.clientX, touch.clientY);
  };

  const handleTouchCancel = () => {
    if (activeTouchId !== null) {
      resetInteraction(true);
    }
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (!isPrimaryPointerDown(event)) return;
    clearCancelTimer();
    event.preventDefault();
    event.stopPropagation();
    activePointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    moved = false;
    setPressed(true);
    callbacksRef.current.onPressStart();
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > TOUCH_MOVE_CANCEL_PX) {
      moved = true;
      setPressed(false);
    }
  };

  const handlePointerUp = (event: PointerEvent) => {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    if (isTouchLikePointer(event.pointerType)) {
      if (!touchHandled) {
        activateFromTouch(event.clientX, event.clientY);
        return;
      }
      activePointerId = null;
      return;
    }
    activePointerId = null;
    setPressed(false);
    schedulePressCancel();
  };

  const handlePointerCancel = (event: PointerEvent) => {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    if (!touchHandled) {
      resetInteraction(true);
      return;
    }
    activePointerId = null;
  };

  const handleClick = (event: MouseEvent) => {
    event.stopPropagation();
    clearCancelTimer();
    if (Date.now() - lastTouchActivatedAt < TOUCH_CLICK_DEDUPE_MS) {
      event.preventDefault();
      return;
    }
    callbacksRef.current.onActivate();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!isButtonActivationKey(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    callbacksRef.current.onActivate();
  };

  const handleWindowBlur = () => {
    if (activeTouchId !== null || activePointerId !== null) {
      resetInteraction(true);
    }
  };

  node.addEventListener("touchstart", handleTouchStart, { passive: false });
  node.addEventListener("touchmove", handleTouchMove, { passive: true });
  node.addEventListener("touchend", handleTouchEnd, { passive: false });
  node.addEventListener("touchcancel", handleTouchCancel);
  node.addEventListener("pointerdown", handlePointerDown);
  node.addEventListener("click", handleClick);
  node.addEventListener("keydown", handleKeyDown);
  window.addEventListener("pointermove", handlePointerMove, { passive: true });
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerCancel);
  window.addEventListener("blur", handleWindowBlur);

  return () => {
    clearCancelTimer();
    node.removeEventListener("touchstart", handleTouchStart);
    node.removeEventListener("touchmove", handleTouchMove);
    node.removeEventListener("touchend", handleTouchEnd);
    node.removeEventListener("touchcancel", handleTouchCancel);
    node.removeEventListener("pointerdown", handlePointerDown);
    node.removeEventListener("click", handleClick);
    node.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerCancel);
    window.removeEventListener("blur", handleWindowBlur);
  };
}

function SelectionActionButton({
  label,
  onPressStart,
  onPressCancel,
  onActivate,
  testID,
}: SelectionActionButtonProps) {
  const buttonRef = useRef<View | null>(null);
  const [pressed, setPressed] = useState(false);
  const callbacksRef = useRef({ onPressStart, onPressCancel, onActivate });
  callbacksRef.current = { onPressStart, onPressCancel, onActivate };

  useEffect(() => {
    if (!isWeb) return;
    const node = buttonRef.current as unknown as HTMLElement | null;
    if (!node || typeof node.addEventListener !== "function") return;
    return attachSelectionActionListeners({ node, setPressed, callbacksRef });
  }, []);

  return (
    <View
      ref={buttonRef}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      tabIndex={isWeb ? 0 : undefined}
      style={[styles.selectionActionButton, pressed && styles.selectionActionButtonPressed]}
      testID={testID}
    >
      <Text selectable={false} style={styles.selectionActionLabel}>
        {label}
      </Text>
    </View>
  );
}

interface SelectionContextTargetProps {
  children: ReactNode;
  rootRef: RefObject<View | null>;
  pressingActionRef: RefObject<boolean>;
  syncSelectionRef: RefObject<(() => void) | null>;
  onSelection: (text: string | null, anchorRect: Rect | null, range: Range | null) => void;
  showSelectionActions: boolean;
  onActionPressStart: () => void;
  onActionPressCancel: () => void;
  onQuote: () => void;
  onAsk: () => void;
  onSelectionKeyDown: (event: { key: string }) => void;
  quoteLabel: string;
  askLabel: string;
}

function SelectionContextTarget({
  children,
  rootRef,
  pressingActionRef,
  syncSelectionRef,
  onSelection,
  showSelectionActions,
  onActionPressStart,
  onActionPressCancel,
  onQuote,
  onAsk,
  onSelectionKeyDown,
  quoteLabel,
  askLabel,
}: SelectionContextTargetProps) {
  const contextMenu = useContextMenu();
  const updateSelection = useCallback(() => {
    if (!isWeb || !rootRef.current) return null;
    // Keep the captured selection alive while a toolbar button press or context-menu item is active.
    if (
      pressingActionRef.current ||
      (contextMenu.open &&
        document.activeElement?.closest('[data-testid="quoted-selection-context-menu"]'))
    ) {
      return null;
    }
    const selection = window.getSelection();
    const text = getQuotedSelectionText(
      rootRef.current as unknown as HTMLElement,
      selection,
      document.activeElement,
    );
    const range = text && selection?.rangeCount ? selection.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    onSelection(
      text,
      rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      range?.cloneRange() ?? null,
    );
    return text;
  }, [contextMenu.open, onSelection, pressingActionRef, rootRef]);

  useEffect(() => {
    syncSelectionRef.current = () => {
      updateSelection();
    };
    return () => {
      syncSelectionRef.current = null;
    };
  }, [syncSelectionRef, updateSelection]);

  useEffect(() => {
    if (!isWeb) return;
    const clearSelection = () => onSelection(null, null, null);
    document.addEventListener("selectionchange", updateSelection);
    document.addEventListener("focusin", updateSelection);
    window.addEventListener("blur", clearSelection);
    return () => {
      document.removeEventListener("selectionchange", updateSelection);
      document.removeEventListener("focusin", updateSelection);
      window.removeEventListener("blur", clearSelection);
    };
  }, [onSelection, updateSelection]);

  const handleContextMenu = useCallback(
    (event: WebContextMenuEvent) => {
      // Keep the browser's touch selection handles and native Copy menu intact.
      if (event.nativeEvent.pointerType === "touch" || !updateSelection()) return;
      event.preventDefault();
      event.stopPropagation();
      contextMenu.setAnchorRect({
        x: event.nativeEvent.pageX,
        y: event.nativeEvent.pageY,
        width: 0,
        height: 0,
      });
      contextMenu.setOpen(true);
    },
    [contextMenu, updateSelection],
  );

  return (
    <View
      ref={rootRef}
      // @ts-expect-error onContextMenu is available on React Native Web.
      onContextMenu={handleContextMenu}
      style={styles.target}
      testID="quoted-selection-context-target"
    >
      {children}
      {showSelectionActions ? (
        <View
          style={styles.selectionActions}
          // @ts-expect-error onKeyDown is available on React Native Web.
          onKeyDown={onSelectionKeyDown}
          testID="quoted-selection-actions"
        >
          <SelectionActionButton
            label={quoteLabel}
            onPressStart={onActionPressStart}
            onPressCancel={onActionPressCancel}
            onActivate={onQuote}
            testID="quoted-selection-action-quote"
          />
          <SelectionActionButton
            label={askLabel}
            onPressStart={onActionPressStart}
            onPressCancel={onActionPressCancel}
            onActivate={onAsk}
            testID="quoted-selection-action-ask"
          />
        </View>
      ) : null}
    </View>
  );
}

export function QuotedSelectionContextMenu({
  children,
  onQuote,
  onAsk,
}: {
  children: ReactNode;
  onQuote: (text: string) => void;
  onAsk: (selectedText: string, question: string, includeContext: boolean) => Promise<string>;
}) {
  const { t } = useTranslation();
  const showPersistentActions = useShowPersistentActions();
  const rootRef = useRef<View | null>(null);
  const selectionRangeRef = useRef<Range | null>(null);
  const pressingActionRef = useRef(false);
  const pendingActionRef = useRef<CapturedSelectionAction | null>(null);
  const syncSelectionRef = useRef<(() => void) | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [selectionAnchorRect, setSelectionAnchorRect] = useState<Rect | null>(null);
  const [askText, setAskText] = useState<string | null>(null);
  const [askAnchorRect, setAskAnchorRect] = useState<Rect | null>(null);
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setSelectedText(null);
    }
  }, []);
  const handleSelection = useCallback(
    (text: string | null, anchorRect: Rect | null, range: Range | null) => {
      setSelectedText(text);
      setSelectionAnchorRect(anchorRect);
      selectionRangeRef.current = range;
    },
    [],
  );
  const clearBrowserSelection = useCallback(() => {
    pressingActionRef.current = false;
    pendingActionRef.current = null;
    if (isWeb) window.getSelection()?.removeAllRanges();
    selectionRangeRef.current = null;
    setSelectedText(null);
  }, []);
  const readLiveSelection = useCallback((): CapturedSelectionAction | null => {
    if (!isWeb || !rootRef.current) return null;
    const selection = window.getSelection();
    const text = getQuotedSelectionText(
      rootRef.current as unknown as HTMLElement,
      selection,
      document.activeElement,
    );
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (text !== selectedText || !isSameQuotedSelectionRange(selectionRangeRef.current, range)) {
      return null;
    }
    return text ? { text, anchorRect: selectionAnchorRect } : null;
  }, [selectedText, selectionAnchorRect]);
  const handleActionPressStart = useCallback(() => {
    pressingActionRef.current = true;
    if (pendingActionRef.current === null) {
      pendingActionRef.current = readLiveSelection();
    }
  }, [readLiveSelection]);
  const handleActionPressCancel = useCallback(() => {
    pressingActionRef.current = false;
    pendingActionRef.current = null;
    syncSelectionRef.current?.();
  }, []);
  const resolveActionSelection = useCallback((): CapturedSelectionAction | null => {
    const captured = pendingActionRef.current;
    pressingActionRef.current = false;
    pendingActionRef.current = null;
    if (captured) {
      return captured;
    }
    const live = readLiveSelection();
    if (live) {
      return live;
    }
    if (!isWeb || !rootRef.current) return null;
    const selection = window.getSelection();
    // Browser focus can collapse a text range while a context-menu item is activated.
    if (
      selectedText &&
      selectionRangeRef.current &&
      !selection?.toString().trim() &&
      document.activeElement?.closest('[data-testid="quoted-selection-context-menu"]')
    ) {
      return { text: selectedText, anchorRect: selectionAnchorRect };
    }
    setSelectedText(null);
    selectionRangeRef.current = null;
    return null;
  }, [readLiveSelection, selectedText, selectionAnchorRect]);
  const handleQuote = useCallback(() => {
    const action = resolveActionSelection();
    if (!action) return;
    onQuote(action.text);
    clearBrowserSelection();
  }, [clearBrowserSelection, onQuote, resolveActionSelection]);
  const handleAsk = useCallback(() => {
    const action = resolveActionSelection();
    if (!action) return;
    setAskText(action.text);
    setAskAnchorRect(action.anchorRect);
    clearBrowserSelection();
  }, [clearBrowserSelection, resolveActionSelection]);
  const handleCloseAsk = useCallback(() => {
    setAskText(null);
    setAskAnchorRect(null);
  }, []);
  const submitAsk = useCallback(
    (question: string, includeContext: boolean) => {
      if (!askText) return Promise.reject(new Error(t("quickAsk.noSelection")));
      return onAsk(askText, question, includeContext);
    },
    [askText, onAsk, t],
  );
  const handleCopy = useCallback(() => {
    const action = resolveActionSelection();
    if (action) void Clipboard.setStringAsync(action.text);
  }, [resolveActionSelection]);
  // Do not collapse the native selection before a pointer activates a context-menu item.
  const preserveSelection = useCallback(
    (event: { preventDefault(): void }) => event.preventDefault(),
    [],
  );
  const handleSelectionKeyDown = useCallback(
    (event: { key: string }) => {
      if (event.key === "Escape") clearBrowserSelection();
    },
    [clearBrowserSelection],
  );

  return (
    <>
      <ContextMenu onOpenChange={handleOpenChange}>
        <SelectionContextTarget
          rootRef={rootRef}
          pressingActionRef={pressingActionRef}
          syncSelectionRef={syncSelectionRef}
          onSelection={handleSelection}
          showSelectionActions={
            isWeb && !getIsElectron() && showPersistentActions && Boolean(selectedText)
          }
          onActionPressStart={handleActionPressStart}
          onActionPressCancel={handleActionPressCancel}
          onQuote={handleQuote}
          onAsk={handleAsk}
          onSelectionKeyDown={handleSelectionKeyDown}
          quoteLabel={t("composer.attachments.quoteSelection")}
          askLabel={t("quickAsk.menuLabel")}
        >
          {children}
        </SelectionContextTarget>
        <ContextMenuContent align="start" width={200} testID="quoted-selection-context-menu">
          <View onPointerDown={preserveSelection}>
            <ContextMenuItem onSelect={handleQuote} testID="quoted-selection-context-menu-quote">
              {t("composer.attachments.quoteSelection")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={handleAsk} testID="quoted-selection-context-menu-ask">
              {t("quickAsk.menuLabel")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={handleCopy}>{t("common.actions.copy")}</ContextMenuItem>
          </View>
        </ContextMenuContent>
      </ContextMenu>
      <QuickAskPopover
        visible={askText !== null}
        anchorRect={askAnchorRect}
        selectedText={askText ?? ""}
        onClose={handleCloseAsk}
        onAsk={submitAsk}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);
  return {
    target: {
      flex: 1,
      minHeight: 0,
      position: "relative",
    },
    selectionActions: {
      position: "absolute",
      bottom: theme.spacing[3],
      right: theme.spacing[3],
      left: theme.spacing[3],
      zIndex: 20,
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "flex-end",
      gap: theme.spacing[2],
      pointerEvents: "box-none",
    },
    selectionActionButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      ...geometry.buttonSm,
      minHeight: 36,
      borderWidth: 1,
      backgroundColor: theme.colors.surface3,
      borderColor: theme.colors.surface3,
      ...theme.shadow.sm,
      ...(isWeb
        ? {
            cursor: "pointer" as const,
            touchAction: "manipulation" as const,
            userSelect: "none" as const,
          }
        : {}),
    },
    selectionActionButtonPressed: {
      opacity: 0.85,
    },
    selectionActionLabel: {
      color: theme.colors.foreground,
      ...geometry.buttonText,
      fontWeight: theme.fontWeight.normal,
      ...(isWeb ? { userSelect: "none" as const } : {}),
    },
  };
});
