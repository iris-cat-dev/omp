import {
  useCallback,
  useEffect,
  useRef,
  type ComponentProps,
  type PropsWithChildren,
  type ReactElement,
  type Ref,
} from "react";
import {
  Platform,
  StatusBar,
  View,
  type GestureResponderEvent,
  type PressableProps,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { isNative, isWeb } from "@/constants/platform";
import { isTouchLikePointerEvent } from "@/utils/device-input";
import {
  MenuHint,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSeparator,
  MenuSurface,
  useMenuContext,
  type MenuSurfaceProps,
  type MenuTriggerState,
} from "@/components/ui/menu";
import { PressHighlight } from "@/components/ui/press-highlight";

const DEFAULT_TOUCH_LONG_PRESS_DELAY_MS = 400;
const TOUCH_LONG_PRESS_MOVE_SLOP_PX = 8;
const NESTED_CONTROL_SELECTOR =
  '[data-sidebar-nested-control="true"],input,textarea,a,[role="link"]';

/**
 * A menu opened by a long press or a right click, anchored to the point of the gesture rather
 * than to a trigger box.
 *
 * Everything below the trigger is the shared menu engine — see `@/components/ui/menu` and
 * docs/menus.md. Only the way it opens is different from `dropdown-menu.tsx`.
 */

export { MenuItem as ContextMenuItem };
export { MenuLabel as ContextMenuLabel };
export { MenuSeparator as ContextMenuSeparator };
export { MenuHint as ContextMenuHint };
export type { ActionStatus } from "@/components/ui/menu";

/**
 * Context menus use the mobile menu convention by default: long press opens a bottom sheet on a
 * compact layout, while right click opens an anchored popover on a wide layout.
 */
export function ContextMenu({
  compactMode = "sheet",
  ...props
}: ComponentProps<typeof MenuRoot>): ReactElement {
  return <MenuRoot {...props} compactMode={compactMode} />;
}

export function ContextMenuContent(props: MenuSurfaceProps): ReactElement | null {
  return <MenuSurface {...props} />;
}

export function useContextMenu() {
  return useMenuContext("useContextMenu");
}

function isCallable(fn: unknown): fn is (...args: unknown[]) => void {
  return typeof fn === "function";
}

function coerceEventPoint(event: unknown): { pageX: number; pageY: number } | null {
  if (typeof event !== "object" || event === null) return null;

  const nativeEvent = Reflect.get(event, "nativeEvent");
  const source = typeof nativeEvent === "object" && nativeEvent !== null ? nativeEvent : event;
  const pageX = Reflect.get(source, "pageX");
  const pageY = Reflect.get(source, "pageY");
  if (typeof pageX === "number" && typeof pageY === "number") {
    return { pageX, pageY };
  }

  const clientX = Reflect.get(source, "clientX");
  const clientY = Reflect.get(source, "clientY");
  if (typeof clientX === "number" && typeof clientY === "number") {
    return { pageX: clientX, pageY: clientY };
  }
  return null;
}

function isInsideNestedInteractiveControl(event: unknown): boolean {
  if (!isWeb || typeof event !== "object" || event === null) return false;
  const nativeEvent = Reflect.get(event, "nativeEvent");
  const target =
    (typeof nativeEvent === "object" && nativeEvent !== null
      ? Reflect.get(nativeEvent, "target")
      : null) ?? Reflect.get(event, "target");
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return Boolean(target.closest(NESTED_CONTROL_SELECTOR));
}

function assignRef<T>(ref: Ref<T> | undefined, value: T): void {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  (ref as { current: T }).current = value;
}

type TriggerStyleProp = StyleProp<ViewStyle> | ((state: MenuTriggerState) => StyleProp<ViewStyle>);

export function ContextMenuTrigger({
  children,
  disabled,
  highlightStyle,
  style,
  enabled = true,
  enabledOnMobile = true,
  enabledOnWeb = true,
  enableTouchLongPress = false,
  longPressDelayMs,
  onContextMenu,
  triggerRef,
  ...props
}: PropsWithChildren<
  Omit<PressableProps, "style"> & {
    highlightStyle?: StyleProp<ViewStyle>;
    style?: TriggerStyleProp;
    enabled?: boolean;
    enabledOnMobile?: boolean;
    enabledOnWeb?: boolean;
    /** Enables touch long-press opening on web (and configures default delay on mobile). */
    enableTouchLongPress?: boolean;
    longPressDelayMs?: number;
    onContextMenu?: (event: unknown) => void;
    triggerRef?: Ref<View | null>;
  }
>): ReactElement {
  const ctx = useMenuContext("ContextMenuTrigger");

  const shouldEnableOnThisPlatform = enabled && (isWeb ? enabledOnWeb : enabledOnMobile);
  const resolvedLongPressDelayMs =
    longPressDelayMs ?? (enableTouchLongPress ? DEFAULT_TOUCH_LONG_PRESS_DELAY_MS : undefined);

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggeredRef = useRef(false);
  const suppressNativeContextMenuUntilRef = useRef(0);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressOriginRef.current = null;
  }, []);

  useEffect(() => clearLongPressTimer, [clearLongPressTimer]);

  const openAtEvent = useCallback(
    (event: unknown) => {
      if (!shouldEnableOnThisPlatform || disabled) return;
      const point = coerceEventPoint(event);
      if (!point) return;

      const statusBarHeight = Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;
      ctx.setAnchorRect({
        x: point.pageX,
        y: point.pageY + statusBarHeight,
        width: 0,
        height: 0,
      });
      ctx.setOpen(true);
    },
    [ctx, disabled, shouldEnableOnThisPlatform],
  );

  const handleRef = useCallback(
    (node: View | null) => {
      assignRef(ctx.triggerRef, node);
      assignRef(triggerRef, node);
    },
    [ctx.triggerRef, triggerRef],
  );

  const propsOnLongPress = props.onLongPress;
  const propsOnPress = props.onPress;
  const propsOnPointerDown = props.onPointerDown;
  const propsOnPointerMove = props.onPointerMove;
  const propsOnPointerUp = props.onPointerUp;
  const propsOnPointerCancel = props.onPointerCancel;
  const propsOnPointerLeave = props.onPointerLeave;

  const handleLongPress = useCallback(
    (event: GestureResponderEvent) => {
      if (isWeb) {
        propsOnLongPress?.(event);
        return;
      }
      openAtEvent(event);
      propsOnLongPress?.(event);
    },
    [propsOnLongPress, openAtEvent],
  );

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      if (longPressTriggeredRef.current) {
        longPressTriggeredRef.current = false;
        return;
      }
      propsOnPress?.(event);
    },
    [propsOnPress],
  );

  const handlePointerDown = useCallback(
    (
      event: NonNullable<PressableProps["onPointerDown"]> extends (e: infer E) => void ? E : never,
    ) => {
      propsOnPointerDown?.(event);
      if (!isWeb || !enableTouchLongPress || !shouldEnableOnThisPlatform || disabled) return;
      if (!isTouchLikePointerEvent(event)) return;
      if (Reflect.get(event as object, "defaultPrevented")) return;
      if (isInsideNestedInteractiveControl(event)) return;
      const point = coerceEventPoint(event);
      if (!point) return;

      clearLongPressTimer();
      longPressTriggeredRef.current = false;
      longPressOriginRef.current = { x: point.pageX, y: point.pageY };
      const delay = resolvedLongPressDelayMs ?? DEFAULT_TOUCH_LONG_PRESS_DELAY_MS;
      longPressTimerRef.current = setTimeout(() => {
        const origin = longPressOriginRef.current;
        longPressTimerRef.current = null;
        longPressOriginRef.current = null;
        if (!origin) return;
        longPressTriggeredRef.current = true;
        suppressNativeContextMenuUntilRef.current = Date.now() + 600;
        openAtEvent({ pageX: origin.x, pageY: origin.y });
      }, delay);
    },
    [
      clearLongPressTimer,
      disabled,
      enableTouchLongPress,
      openAtEvent,
      propsOnPointerDown,
      resolvedLongPressDelayMs,
      shouldEnableOnThisPlatform,
    ],
  );

  const handlePointerMove = useCallback(
    (
      event: NonNullable<PressableProps["onPointerMove"]> extends (e: infer E) => void ? E : never,
    ) => {
      propsOnPointerMove?.(event);
      const origin = longPressOriginRef.current;
      if (!origin || longPressTimerRef.current === null) return;
      const point = coerceEventPoint(event);
      if (!point) return;
      const dx = point.pageX - origin.x;
      const dy = point.pageY - origin.y;
      if (Math.hypot(dx, dy) > TOUCH_LONG_PRESS_MOVE_SLOP_PX) {
        clearLongPressTimer();
      }
    },
    [clearLongPressTimer, propsOnPointerMove],
  );

  const handlePointerUp = useCallback(
    (
      event: NonNullable<PressableProps["onPointerUp"]> extends (e: infer E) => void ? E : never,
    ) => {
      clearLongPressTimer();
      propsOnPointerUp?.(event);
    },
    [clearLongPressTimer, propsOnPointerUp],
  );

  const handlePointerCancel = useCallback(
    (
      event: NonNullable<PressableProps["onPointerCancel"]> extends (e: infer E) => void
        ? E
        : never,
    ) => {
      clearLongPressTimer();
      longPressTriggeredRef.current = false;
      propsOnPointerCancel?.(event);
    },
    [clearLongPressTimer, propsOnPointerCancel],
  );

  const handlePointerLeave = useCallback(
    (
      event: NonNullable<PressableProps["onPointerLeave"]> extends (e: infer E) => void ? E : never,
    ) => {
      clearLongPressTimer();
      propsOnPointerLeave?.(event);
    },
    [clearLongPressTimer, propsOnPointerLeave],
  );

  const handleContextMenu = useCallback(
    (event: unknown) => {
      if (isNative) return;
      onContextMenu?.(event);
      if (typeof event === "object" && event !== null && Reflect.get(event, "defaultPrevented")) {
        return;
      }
      if (typeof event === "object" && event !== null) {
        const preventDefault = Reflect.get(event, "preventDefault");
        const stopPropagation = Reflect.get(event, "stopPropagation");
        if (isCallable(preventDefault)) preventDefault.call(event);
        if (isCallable(stopPropagation)) stopPropagation.call(event);
      }
      if (Date.now() < suppressNativeContextMenuUntilRef.current) {
        return;
      }
      openAtEvent(event);
    },
    [onContextMenu, openAtEvent],
  );

  const resolveDynamicStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => {
      if (typeof style === "function") {
        return style({ pressed, hovered, open: ctx.open });
      }
      return style;
    },
    [style, ctx.open],
  );

  const webTouchHandlers =
    isWeb && enableTouchLongPress
      ? {
          onPointerDown: handlePointerDown,
          onPointerMove: handlePointerMove,
          onPointerUp: handlePointerUp,
          onPointerCancel: handlePointerCancel,
          onPointerLeave: handlePointerLeave,
        }
      : undefined;

  return (
    <PressHighlight
      {...props}
      {...webTouchHandlers}
      ref={handleRef}
      collapsable={false}
      disabled={disabled}
      delayLongPress={resolvedLongPressDelayMs}
      onPress={propsOnPress ? handlePress : undefined}
      onLongPress={handleLongPress}
      // @ts-ignore - onContextMenu is web-only and not in RN types.
      onContextMenu={handleContextMenu}
      style={typeof style === "function" ? resolveDynamicStyle : style}
      highlightStyle={highlightStyle}
    >
      {children}
    </PressHighlight>
  );
}
