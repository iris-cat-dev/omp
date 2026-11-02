import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import {
  TreeChevron,
  TREE_INDENT_PER_LEVEL,
  workspaceTreeRowStyles,
} from "@/components/tree-primitives";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

function treeItems(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]')).filter(
    (item) => item.closest('[role="tree"]') === root,
  );
}

function focusItem(root: HTMLElement, item: HTMLElement) {
  for (const candidate of treeItems(root)) candidate.tabIndex = candidate === item ? 0 : -1;
  item.focus();
}

function handleTreeKey(event: KeyboardEvent<HTMLDivElement>) {
  const root = event.currentTarget;
  const item = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
  if (!item || item.closest('[role="tree"]') !== root) return;
  const items = treeItems(root);
  const index = items.indexOf(item);
  const level = Number(item.getAttribute("aria-level"));
  const expanded = item.getAttribute("aria-expanded");
  let destination: HTMLElement | undefined;
  switch (event.key) {
    case "ArrowDown":
      destination = items[Math.min(index + 1, items.length - 1)];
      break;
    case "ArrowUp":
      destination = items[Math.max(index - 1, 0)];
      break;
    case "Home":
      destination = items[0];
      break;
    case "End":
      destination = items.at(-1);
      break;
    case "ArrowRight":
      if (expanded === "false") item.click();
      else if (
        expanded === "true" &&
        Number(items[index + 1]?.getAttribute("aria-level")) > level
      ) {
        destination = items[index + 1];
      }
      break;
    case "ArrowLeft":
      if (expanded === "true") item.click();
      else {
        destination = items
          .slice(0, index)
          .findLast((candidate) => Number(candidate.getAttribute("aria-level")) < level);
      }
      break;
    default:
      return;
  }
  event.preventDefault();
  if (destination) focusItem(root, destination);
}

/** A flat, level-described tree with roving focus and standard disclosure navigation. */
export function Tree({ children, label }: { children: ReactNode; label: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const items = treeItems(root);
    const active = items.find((item) => item === document.activeElement);
    const tabbable = active ?? items.find((item) => item.tabIndex === 0) ?? items[0];
    for (const item of items) item.tabIndex = item === tabbable ? 0 : -1;
  }, [children]);
  const handleFocus = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const item of treeItems(root)) item.tabIndex = item === document.activeElement ? 0 : -1;
  }, []);
  return isWeb ? (
    <div
      ref={rootRef}
      role="tree"
      aria-label={label}
      onKeyDown={handleTreeKey}
      onFocusCapture={handleFocus}
    >
      {children}
    </div>
  ) : (
    <View role="tree" accessibilityLabel={label}>
      {children}
    </View>
  );
}

export const TreeItem = memo(function TreeItem({
  children,
  label,
  depth = 0,
  expanded,
  active = false,
  onToggle,
  testID,
}: {
  children: ReactNode;
  label: string;
  depth?: number;
  expanded?: boolean;
  active?: boolean;
  onToggle?: () => void;
  testID?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const showHover = useCallback(() => setHovered(true), []);
  const hideHover = useCallback(() => setHovered(false), []);
  const showFocus = useCallback(() => setFocused(true), []);
  const hideFocus = useCallback(() => setFocused(false), []);
  const indent = useMemo(
    () => inlineUnistylesStyle({ paddingLeft: 4 + depth * TREE_INDENT_PER_LEVEL }),
    [depth],
  );
  return (
    <Pressable
      role="treeitem"
      accessibilityLabel={label}
      aria-level={depth + 1}
      aria-expanded={expanded}
      tabIndex={-1}
      onPress={onToggle}
      onHoverIn={showHover}
      onHoverOut={hideHover}
      onFocus={showFocus}
      onBlur={hideFocus}
      style={[
        workspaceTreeRowStyles.row,
        styles.row,
        indent,
        active && styles.active,
        (hovered || focused) && workspaceTreeRowStyles.active,
      ]}
      testID={testID}
    >
      {expanded !== undefined && <TreeChevron expanded={expanded} />}
      <View style={styles.content}>{children}</View>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    minWidth: 0,
    minHeight: { xs: 32, md: 24 },
    alignItems: "flex-start",
    justifyContent: "flex-start",
    paddingVertical: 2,
    paddingRight: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    gap: theme.spacing[1],
  },
  active: { backgroundColor: theme.colors.surface2 },
  content: {
    minWidth: 0,
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[1],
  },
}));
