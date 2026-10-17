import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { withUnistyles } from "react-native-unistyles";
import type { VirtualItem } from "@tanstack/react-virtual";
import type { Theme } from "@/styles/theme";
import { WallpaperCandidateCell, type WallpaperGridAppearance } from "./wallpaper-candidate-cell";
import type { WallpaperCandidate } from "@omp-desktop/protocol/desktop-wallpaper";
import { acquireWallpaperPreviews } from "@/wallpaper/desktop-client";
import {
  enqueueWallpaperThumbnail,
  type WallpaperThumbnailHandle,
  type WallpaperThumbnailResult,
} from "./wallpaper-thumbnail-queue";

interface PreviewEntry {
  handle: WallpaperThumbnailHandle | null;
  result: WallpaperThumbnailResult | null;
}

function useWindowThumbnails(ids: readonly string[], visible: ReadonlySet<string>) {
  const [state] = useState(() => ({
    entries: new Map<string, PreviewEntry>(),
    generation: 0,
    mounted: true,
    lease: null as { release: () => void } | null,
  }));
  const [results, setResults] = useState<ReadonlyMap<string, WallpaperThumbnailResult>>(
    () => new Map(),
  );
  const published = useRef(results);
  const signature = JSON.stringify(ids);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    state.mounted = true;
    return () => {
      state.mounted = false;
      state.generation++;
      state.lease?.release();
      state.lease = null;
      for (const entry of state.entries.values()) entry.handle?.release();
      state.entries.clear();
    };
  }, [state]);

  useEffect(() => {
    const windowIds = JSON.parse(signature) as string[];
    const wanted = new Set(windowIds);
    const currentGeneration = ++state.generation;
    // Resource handles stay imperative; memoized rendering needs immutable result snapshots.
    const publishResults = () => {
      const previous = published.current;
      let count = 0;
      let changed = false;
      for (const [id, entry] of state.entries) {
        if (!entry.result) continue;
        count++;
        if (previous.get(id) !== entry.result) changed = true;
      }
      if (!changed && previous.size === count) return;
      const next = new Map<string, WallpaperThumbnailResult>();
      for (const [id, entry] of state.entries) {
        if (entry.result) next.set(id, entry.result);
      }
      published.current = next;
      setResults(next);
    };
    for (const [id, entry] of state.entries) {
      if (!wanted.has(id)) {
        entry.handle?.release();
        state.entries.delete(id);
      }
    }
    for (const id of windowIds) {
      if (!state.entries.has(id)) state.entries.set(id, { handle: null, result: null });
    }
    publishResults();
    const lease = acquireWallpaperPreviews(windowIds);
    const previousLease = state.lease;
    state.lease = lease;
    previousLease?.release();
    const publishFailure = (id: string) => {
      const entry = state.entries.get(id);
      if (!entry || entry.handle || entry.result) return;
      entry.result = { url: null, failed: true };
    };
    const load = async () => {
      try {
        const { media, rejected } = await lease.result;
        if (!state.mounted || state.generation !== currentGeneration) return;
        for (const rejectedItem of rejected) publishFailure(rejectedItem.candidateId);
        for (const descriptor of media) {
          const entry = state.entries.get(descriptor.candidateId);
          if (!entry || entry.handle || entry.result) continue;
          entry.handle = enqueueWallpaperThumbnail(
            document,
            descriptor,
            visibleRef.current.has(descriptor.candidateId) ? 0 : 1,
            (result) => {
              if (!state.mounted || state.entries.get(descriptor.candidateId) !== entry) return;
              entry.result = result;
              publishResults();
            },
          );
        }
        publishResults();
      } catch {
        if (!state.mounted || state.generation !== currentGeneration) return;
        for (const id of windowIds) publishFailure(id);
        publishResults();
      }
    };
    void load();
  }, [signature, state]);

  useEffect(() => {
    for (const [id, entry] of state.entries) entry.handle?.setPriority(visible.has(id) ? 0 : 1);
  }, [visible, state]);
  return results;
}

export interface WallpaperCandidateGridHandle {
  focusNearest: (index: number) => void;
}

interface Props {
  items: readonly WallpaperCandidate[];
  currentId: string | null;
  managing: boolean;
  selectedIds: ReadonlySet<string>;
  disabled: boolean;
  onActivate: (candidateId: string) => void;
  onEmptyFocus: () => void;
}

interface GridRowProps extends Props {
  row: VirtualItem;
  columns: number;
  stride: number;
  textHeight: number;
  tabId: string | null | undefined;
  appearance: WallpaperGridAppearance;
  previews: ReadonlyMap<string, WallpaperThumbnailResult>;
  refFor: (id: string) => (node: HTMLButtonElement | null) => void;
  onFocus: (id: string) => void;
}

function WallpaperCandidateRow({
  row,
  columns,
  stride,
  textHeight,
  tabId,
  appearance,
  previews,
  refFor,
  onFocus,
  items,
  currentId,
  managing,
  selectedIds,
  disabled,
  onActivate,
}: GridRowProps) {
  const rowStyle = useMemo<CSSProperties>(
    () => ({
      position: "absolute",
      top: row.start,
      left: 0,
      height: stride,
      display: "grid",
      gridTemplateColumns: `repeat(${columns}, 96px)`,
      columnGap: appearance.gap,
    }),
    [row.start, stride, columns, appearance.gap],
  );
  const cells = items.slice(row.index * columns, (row.index + 1) * columns);
  return (
    <div role="row" aria-rowindex={row.index + 1} style={rowStyle}>
      {cells.map((item, column) => (
        <WallpaperCandidateCell
          key={item.candidateId}
          item={item}
          index={row.index * columns + column}
          column={column}
          preview={previews.get(item.candidateId)}
          applied={currentId === item.candidateId}
          selected={selectedIds.has(item.candidateId)}
          managing={managing}
          disabled={disabled}
          tabbable={tabId === item.candidateId}
          textHeight={textHeight}
          appearance={appearance}
          buttonRef={refFor(item.candidateId)}
          onFocus={onFocus}
          onActivate={onActivate}
        />
      ))}
    </div>
  );
}

interface ThemedGridProps extends Props {
  appearance: WallpaperGridAppearance;
  gridRef: Ref<WallpaperCandidateGridHandle>;
}

function WallpaperCandidateGridBase({
  items,
  currentId,
  managing,
  selectedIds,
  disabled,
  onActivate,
  onEmptyFocus,
  appearance,
  gridRef,
}: ThemedGridProps) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(items[0]?.candidateId ?? null);
  const gap = appearance.gap;
  const [layout, setLayout] = useState({
    columns: 1,
    stride: 104,
    textHeight: 16,
  });
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const rowCount = Math.ceil(items.length / layout.columns);
  const height = Math.min(320, rowCount * layout.stride);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scroller.current,
    estimateSize: () => layout.stride,
    getItemKey: (row) => items[row * layout.columns]?.candidateId ?? row,
    overscan: 1,
    useAnimationFrameWithResizeObserver: true,
  });
  const rows = virtualizer.getVirtualItems();
  const windowIds: string[] = [];
  const visibleIds = new Set<string>();
  const scrollTop = virtualizer.scrollOffset ?? 0;
  for (const row of rows) {
    for (let column = 0; column < layout.columns; column++) {
      const item = items[row.index * layout.columns + column];
      if (!item) break;
      windowIds.push(item.candidateId);
      if (row.end > scrollTop && row.start < scrollTop + height) visibleIds.add(item.candidateId);
    }
  }
  const previews = useWindowThumbnails(windowIds, visibleIds);
  const firstVisibleId = visibleIds.values().next().value as string | undefined;
  const tabId = focusId && windowIds.includes(focusId) ? focusId : firstVisibleId;
  const windowMembers = useRef<ReadonlySet<string>>(new Set());
  windowMembers.current = new Set(windowIds);
  const nodeRefs = useRef(new Map<string, (node: HTMLButtonElement | null) => void>());
  const refFor = useCallback((id: string) => {
    let callback = nodeRefs.current.get(id);
    if (!callback) {
      callback = (node) => {
        const old = nodes.current.get(id);
        if (node) nodes.current.set(id, node);
        else {
          if (old && document.activeElement === old) {
            if (windowMembers.current.has(id)) pendingFocus.current = id;
            scroller.current?.focus({ preventScroll: true });
          }
          nodes.current.delete(id);
        }
      };
      nodeRefs.current.set(id, callback);
    }
    return callback;
  }, []);
  const windowSignature = JSON.stringify(windowIds);
  useLayoutEffect(() => {
    const wanted = new Set(JSON.parse(windowSignature) as string[]);
    for (const id of nodeRefs.current.keys()) if (!wanted.has(id)) nodeRefs.current.delete(id);
  }, [windowSignature]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      const old = layoutRef.current;
      const columns = Math.max(
        1,
        Math.min(6, Math.floor((element.clientWidth + gap) / (96 + gap))),
      );
      const textHeight = Math.ceil(probe.current?.getBoundingClientRect().height ?? 16);
      const stride = Math.max(96, 72 + appearance.nameGap + textHeight + gap);
      if (columns === old.columns && stride === old.stride && textHeight === old.textHeight) return;
      const oldRow = Math.floor(element.scrollTop / old.stride);
      const item = itemsRef.current[oldRow * old.columns];
      anchor.current = item
        ? {
            id: item.candidateId,
            offset: element.scrollTop - oldRow * old.stride,
          }
        : null;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && element.contains(focused)) {
        pendingFocus.current =
          focused.closest<HTMLButtonElement>("button[data-candidate-id]")?.dataset.candidateId ??
          null;
      }
      layoutRef.current = { columns, stride, textHeight };
      setLayout(layoutRef.current);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (probe.current) observer.observe(probe.current);
    document.fonts.addEventListener("loadingdone", measure);
    measure();
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, [gap, appearance.nameGap, appearance.fontSize, appearance.fontFamily]);

  useLayoutEffect(() => {
    virtualizer.measure();
    const element = scroller.current;
    if (!element) return;
    const saved = anchor.current;
    anchor.current = null;
    if (saved) {
      const index = items.findIndex((item) => item.candidateId === saved.id);
      if (index >= 0)
        element.scrollTop = Math.floor(index / layout.columns) * layout.stride + saved.offset;
    }
    element.scrollTop = Math.max(
      0,
      Math.min(element.scrollTop, rowCount * layout.stride - element.clientHeight),
    );
    if (pendingFocus.current) {
      const index = items.findIndex((item) => item.candidateId === pendingFocus.current);
      if (index >= 0)
        virtualizer.scrollToIndex(Math.floor(index / layout.columns), {
          align: "auto",
        });
    }
  }, [layout, items, rowCount, virtualizer]);

  const focusIndex = useCallback(
    (index: number) => {
      const boundedIndex = Math.max(0, Math.min(items.length - 1, index));
      const item = items[boundedIndex];
      if (!item) {
        onEmptyFocus();
        return;
      }
      pendingFocus.current = item.candidateId;
      setFocusId(item.candidateId);
      // Preserve a focus owner while waiting for an offscreen target to mount.
      scroller.current?.focus({ preventScroll: true });
      virtualizer.scrollToIndex(Math.floor(boundedIndex / layout.columns), {
        align: "auto",
      });
      nodes.current.get(item.candidateId)?.focus({ preventScroll: true });
    },
    [items, layout.columns, onEmptyFocus, virtualizer],
  );
  useImperativeHandle(gridRef, () => ({ focusNearest: focusIndex }), [focusIndex]);

  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const node = nodes.current.get(id);
    if (node) {
      pendingFocus.current = null;
      node.focus({ preventScroll: true });
    }
  });

  const previousItems = useRef(items);
  useLayoutEffect(() => {
    const previous = previousItems.current;
    previousItems.current = items;
    if (focusId && !items.some((item) => item.candidateId === focusId)) {
      const oldIndex = previous.findIndex((item) => item.candidateId === focusId);
      setFocusId(items[Math.min(Math.max(0, oldIndex), items.length - 1)]?.candidateId ?? null);
      if (document.activeElement === scroller.current) focusIndex(oldIndex);
    }
  }, [items, focusId, focusIndex]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      const ownedId = (event.target as HTMLElement).closest<HTMLButtonElement>(
        "button[data-candidate-id]",
      )?.dataset.candidateId;
      const index = Math.max(
        0,
        items.findIndex((item) => item.candidateId === (ownedId ?? firstVisibleId)),
      );
      let target = index;
      switch (event.key) {
        case "ArrowLeft":
          target--;
          break;
        case "ArrowRight":
          target++;
          break;
        case "ArrowUp":
          target -= layout.columns;
          break;
        case "ArrowDown":
          target += layout.columns;
          break;
        case "Home":
          target = 0;
          break;
        case "End":
          target = items.length - 1;
          break;
        case "Enter":
        case " ":
          event.preventDefault();
          if (items[index]) onActivate(items[index].candidateId);
          return;
        default:
          return;
      }
      event.preventDefault();
      focusIndex(Math.max(0, Math.min(items.length - 1, target)));
    },
    [disabled, items, firstVisibleId, layout.columns, onActivate, focusIndex],
  );
  const containerStyle = useMemo<CSSProperties>(
    () => ({
      position: "relative",
      height,
      maxHeight: 320,
      overflowY: "auto",
      overflowX: "hidden",
      scrollbarGutter: "stable",
      overscrollBehavior: "contain",
      outlineColor: appearance.primary,
      fontFamily: appearance.fontFamily,
      fontSize: appearance.fontSize,
      color: appearance.foreground,
    }),
    [height, appearance],
  );
  const probeStyle = useMemo<CSSProperties>(
    () => ({
      position: "absolute",
      visibility: "hidden",
      pointerEvents: "none",
      fontFamily: appearance.fontFamily,
      fontSize: appearance.fontSize,
      lineHeight: "1.25",
    }),
    [appearance.fontFamily, appearance.fontSize],
  );
  const totalSize = virtualizer.getTotalSize();
  const contentStyle = useMemo<CSSProperties>(
    () => ({
      position: "relative",
      height: totalSize,
      width: "100%",
    }),
    [totalSize],
  );
  return (
    <div>
      <span ref={probe} aria-hidden style={probeStyle}>
        Ag
      </span>
      <div
        ref={scroller}
        role="grid"
        aria-label={t("settings.appearance.wallpaper.library.title")}
        aria-rowcount={rowCount}
        aria-colcount={layout.columns}
        aria-multiselectable={managing || undefined}
        data-testid="wallpaper-candidate-grid"
        data-columns={layout.columns}
        data-row-stride={layout.stride}
        tabIndex={tabId ? -1 : 0}
        onKeyDown={handleKeyDown}
        style={containerStyle}
      >
        <div style={contentStyle}>
          {rows.map((row) => (
            <WallpaperCandidateRow
              key={row.key}
              row={row}
              columns={layout.columns}
              stride={layout.stride}
              textHeight={layout.textHeight}
              tabId={tabId}
              appearance={appearance}
              previews={previews}
              refFor={refFor}
              onFocus={setFocusId}
              items={items}
              currentId={currentId}
              managing={managing}
              selectedIds={selectedIds}
              disabled={disabled}
              onActivate={onActivate}
              onEmptyFocus={onEmptyFocus}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const ThemedWallpaperCandidateGrid = withUnistyles(WallpaperCandidateGridBase);
const gridAppearanceMapping = (theme: Theme) => ({
  appearance: {
    gap: theme.spacing[3],
    nameGap: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.ui,
    primary: theme.colors.primary,
    foreground: theme.colors.foreground,
    muted: theme.colors.foregroundMuted,
    border: theme.colors.border,
    surface0: theme.colors.surface0,
    surface2: theme.colors.surface2,
    radius: theme.borderRadius.md,
    smallRadius: theme.borderRadius.sm,
  },
});

export const WallpaperCandidateGrid = forwardRef<WallpaperCandidateGridHandle, Props>(
  function WallpaperCandidateGrid(props, ref) {
    return (
      <ThemedWallpaperCandidateGrid {...props} gridRef={ref} uniProps={gridAppearanceMapping} />
    );
  },
);
