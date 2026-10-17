import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Platform, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, FolderPlus, ListChecks, Trash2 } from "lucide-react-native";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { EditingTextInput as TextInput } from "@/components/ui/text-input";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { isElectronRuntime } from "@/desktop/host";
import { useAppSettings, type AppSettings } from "@/hooks/use-settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { getWallpaperSourceKey } from "@/wallpaper/source";
import { retryWallpaperLoad, useWallpaperLoadStatus } from "@/wallpaper/load-state";
import {
  addWallpaperCandidates,
  removeWallpaperCandidates,
  useWallpaperLibrary,
} from "@/wallpaper/desktop-client";
import {
  WallpaperCandidateGrid,
  type WallpaperCandidateGridHandle,
} from "./wallpaper-candidate-grid";

const WALLPAPER_SOURCES: readonly AppSettings["wallpaperSource"][] = ["none", "file", "url"];

const OPACITY_SLIDER_STYLE: CSSProperties = {
  width: "100%",
  accentColor: "var(--colors-primary, #00dbe4)",
};

const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

function dropdownTriggerStyle({ pressed }: PressableStateCallbackType) {
  return [styles.trigger, pressed ? styles.triggerPressed : null];
}

function wallpaperSourceLabel(t: TFunction, value: AppSettings["wallpaperSource"]): string {
  return t(`settings.appearance.wallpaper.source.${value}`);
}

function WallpaperSourceMenuItem({
  source,
  selected,
  onSelect,
}: {
  source: AppSettings["wallpaperSource"];
  selected: boolean;
  onSelect: (source: AppSettings["wallpaperSource"]) => void;
}) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onSelect(source), [onSelect, source]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {wallpaperSourceLabel(t, source)}
    </DropdownMenuItem>
  );
}

function OpacitySlider({
  opacity,
  onPreview,
  onCommit,
  accessibilityLabel,
}: {
  opacity: number;
  onPreview: (value: number) => void;
  onCommit: (value: number) => void;
  accessibilityLabel: string;
}) {
  const latestValue = useRef(opacity);
  useEffect(() => {
    latestValue.current = opacity;
  }, [opacity]);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.currentTarget.valueAsNumber / 100;
      latestValue.current = value;
      onPreview(value);
    },
    [onPreview],
  );
  const handleCommit = useCallback(() => onCommit(latestValue.current), [onCommit]);

  return (
    <input
      type="range"
      min={0}
      max={100}
      step={1}
      value={Math.round(opacity * 100)}
      aria-label={accessibilityLabel}
      style={OPACITY_SLIDER_STYLE}
      onChange={handleChange}
      onPointerUp={handleCommit}
      onKeyUp={handleCommit}
      onBlur={handleCommit}
    />
  );
}

interface LibraryRejection {
  path: string;
  message: string;
}

function WallpaperRejections({ failures }: { failures: readonly LibraryRejection[] }) {
  const rows = useMemo(() => {
    const byPath = new Map<string, Set<string>>();
    for (const failure of failures) {
      let messages = byPath.get(failure.path);
      if (!messages) {
        messages = new Set();
        byPath.set(failure.path, messages);
      }
      messages.add(failure.message);
    }
    return Array.from(byPath, ([path, messages]) => ({
      path,
      message: [...messages].join("; "),
    }));
  }, [failures]);
  if (!rows.length) return null;
  return (
    <ScrollView style={styles.rejectionList} nestedScrollEnabled>
      {rows.map((failure) => (
        <Text key={failure.path} style={styles.wallpaperPreviewHint}>
          {failure.path}: {failure.message}
        </Text>
      ))}
    </ScrollView>
  );
}

function WallpaperOperationError({ message }: { message: string | null }) {
  const { t } = useTranslation();
  if (!message) return null;
  return (
    <Text style={styles.wallpaperPreviewHint} accessibilityRole="alert">
      {t("settings.appearance.wallpaper.library.operationError", { message })}
    </Text>
  );
}

function WallpaperLibraryStatus({
  loading,
  libraryError,
  onReload,
}: {
  loading: boolean;
  libraryError: string | null;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {loading ? (
        <Text style={styles.wallpaperPreviewHint}>
          {t("settings.appearance.wallpaper.library.loading")}
        </Text>
      ) : null}
      {libraryError ? (
        <View>
          <Text style={styles.wallpaperPreviewHint} accessibilityRole="alert">
            {t("settings.appearance.wallpaper.library.loadError")} {libraryError}
          </Text>
          <Button size="sm" variant="outline" onPress={onReload}>
            {t("settings.appearance.wallpaper.library.retry")}
          </Button>
        </View>
      ) : null}
    </>
  );
}

function WallpaperLibraryToolbar({
  busy,
  loading,
  libraryError,
  managing,
  hasItems,
  selectedCount,
  onAdd,
  onManage,
  onRemove,
}: {
  busy: "adding" | "removing" | null;
  loading: boolean;
  libraryError: string | null;
  managing: boolean;
  hasItems: boolean;
  selectedCount: number;
  onAdd: () => void;
  onManage: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.libraryToolbar}>
      <Button
        size="sm"
        variant="outline"
        leftIcon={FolderPlus}
        onPress={onAdd}
        disabled={!!busy || loading || !!libraryError || !isElectronRuntime()}
        loading={busy === "adding"}
        testID="wallpaper-add-files"
      >
        {t(`settings.appearance.wallpaper.library.${busy === "adding" ? "adding" : "add"}`)}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        leftIcon={ListChecks}
        disabled={!!busy || (!managing && !hasItems)}
        onPress={onManage}
        testID="wallpaper-manage"
      >
        {t(`settings.appearance.wallpaper.library.${managing ? "done" : "manage"}`)}
      </Button>
      {managing ? (
        <Button
          size="sm"
          variant="destructive"
          leftIcon={Trash2}
          disabled={!!busy || !selectedCount}
          onPress={onRemove}
          testID="wallpaper-remove-selected"
        >
          {t("settings.appearance.wallpaper.library.remove", {
            count: selectedCount,
          })}
        </Button>
      ) : null}
    </View>
  );
}

function WallpaperRemoveConfirmation({
  count,
  busy,
  message,
  onClose,
  onRemove,
}: {
  count: number;
  busy: "adding" | "removing" | null;
  message: string | null;
  onClose: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const header = useMemo(
    () => ({
      title: t("settings.appearance.wallpaper.library.removeTitle", { count }),
    }),
    [t, count],
  );
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={onClose}
      testID="wallpaper-remove-confirm-modal"
    >
      <View style={styles.confirmation}>
        <Text style={styles.wallpaperPreviewHint}>
          {t("settings.appearance.wallpaper.library.removeMessage")}
        </Text>
        <WallpaperOperationError message={message} />
        <View style={styles.confirmationActions}>
          <Button size="sm" variant="secondary" disabled={!!busy} onPress={onClose}>
            {t("settings.appearance.wallpaper.library.cancel")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={!!busy || !count}
            loading={busy === "removing"}
            onPress={onRemove}
            testID="wallpaper-confirm-remove"
          >
            {t("settings.appearance.wallpaper.library.confirmRemove")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function WallpaperLibraryPanel({
  currentId,
  onApply,
  operationError,
}: {
  currentId: string | null;
  onApply: (candidateId: string) => Promise<void>;
  operationError: string | null;
}) {
  const { t } = useTranslation();
  const { library, loading, error: libraryError, reload } = useWallpaperLibrary();
  const [managing, setManaging] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<"adding" | "removing" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [rejections, setRejections] = useState<LibraryRejection[]>([]);
  const [focusRequest, setFocusRequest] = useState<number | null>(null);
  const grid = useRef<WallpaperCandidateGridHandle>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const focusAdd = useCallback(() => {
    if (Platform.OS === "web") {
      document.querySelector<HTMLElement>('[data-testid="wallpaper-add-files"]')?.focus();
    }
  }, []);
  const previousItemCount = useRef(library?.items.length ?? 0);
  useLayoutEffect(() => {
    const count = library?.items.length ?? 0;
    if (previousItemCount.current > 0 && count === 0) {
      setConfirming(false);
      setFocusRequest(0);
    }
    previousItemCount.current = count;
  }, [library]);

  useEffect(() => {
    if (!library) return;
    const members = new Set(library.items.map((item) => item.candidateId));
    setSelectedIds((previous) => {
      const next = new Set([...previous].filter((id) => members.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [library]);
  useEffect(() => {
    if (focusRequest === null || confirming || busy !== null) return;
    const frame = requestAnimationFrame(() => {
      if (library?.items.length) grid.current?.focusNearest(focusRequest);
      else focusAdd();
      setFocusRequest(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [library, focusRequest, confirming, busy, focusAdd]);

  const fail = useCallback((cause: unknown) => {
    if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const handleAdd = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy("adding");
    setError(null);
    setResult(null);
    setRejections([]);
    try {
      const response = await addWallpaperCandidates({
        title: t("settings.appearance.wallpaper.library.pickerTitle"),
        mediaLabel: t("settings.appearance.wallpaper.library.mediaFilter"),
        imageLabel: t("settings.appearance.wallpaper.library.imageFilter"),
        videoLabel: t("settings.appearance.wallpaper.library.videoFilter"),
      });
      if (!mounted.current || response.cancelled) return;
      setResult(
        t("settings.appearance.wallpaper.library.addResult", {
          added: response.added.length,
          duplicates: response.duplicates.length,
          failed: response.rejected.length,
        }),
      );
      setRejections(response.rejected);
    } catch (cause) {
      fail(cause);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  }, [fail, t]);
  const handleActivate = useCallback(
    (id: string) => {
      if (busyRef.current) return;
      if (managing) {
        setSelectedIds((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      } else {
        void onApply(id);
      }
    },
    [managing, onApply],
  );
  const handleRemove = useCallback(async () => {
    if (busyRef.current || !selectedIds.size) return;
    const ids = [...selectedIds];
    const nearestIndex = library?.items.findIndex((item) => selectedIds.has(item.candidateId)) ?? 0;
    busyRef.current = true;
    setBusy("removing");
    setError(null);
    try {
      const response = await removeWallpaperCandidates(ids);
      if (!mounted.current) return;
      const removed = new Set(response.removedCandidateIds);
      const remaining = new Set(response.library.items.map((item) => item.candidateId));
      setSelectedIds((previous) => {
        const next = new Set<string>();
        for (const id of previous) {
          if (!removed.has(id) && remaining.has(id)) next.add(id);
        }
        return next;
      });
      setResult(
        t("settings.appearance.wallpaper.library.removed", {
          count: response.removedCandidateIds.length,
        }),
      );
      setRejections([]);
      setConfirming(false);
      setFocusRequest(Math.max(0, nearestIndex));
    } catch (cause) {
      fail(cause);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  }, [selectedIds, library, fail, t]);
  const handleManage = useCallback(() => {
    setManaging((value) => !value);
    setSelectedIds(new Set());
  }, []);
  const handleConfirm = useCallback(() => {
    setError(null);
    setConfirming(true);
  }, []);
  const handleClose = useCallback(() => {
    if (!busyRef.current) setConfirming(false);
  }, []);
  const handleReload = useCallback(() => {
    void reload().catch(fail);
  }, [reload, fail]);
  const current = library?.items.find((item) => item.candidateId === currentId);
  const message = error ?? operationError;
  const empty = library?.items.length === 0;
  return (
    <View style={styles.wallpaperPreviewContainer} testID="wallpaper-library">
      <Text style={settingsStyles.rowTitle}>
        {t("settings.appearance.wallpaper.library.title")}
      </Text>
      <Text style={styles.wallpaperPreviewHint} testID="wallpaper-current-summary">
        {t("settings.appearance.wallpaper.library.current", {
          name: current
            ? `${current.name} — ${current.path}`
            : t("settings.appearance.wallpaper.library.theme"),
        })}
      </Text>
      <WallpaperLibraryToolbar
        busy={busy}
        loading={loading}
        libraryError={libraryError}
        managing={managing}
        hasItems={!!library?.items.length}
        selectedCount={selectedIds.size}
        onAdd={handleAdd}
        onManage={handleManage}
        onRemove={handleConfirm}
      />
      <WallpaperLibraryStatus
        loading={loading}
        libraryError={libraryError}
        onReload={handleReload}
      />
      {!confirming ? <WallpaperOperationError message={message} /> : null}
      {result ? (
        <Text
          style={styles.wallpaperPreviewHint}
          accessibilityLiveRegion="polite"
          testID="wallpaper-batch-result"
        >
          {result}
        </Text>
      ) : null}
      <WallpaperRejections failures={rejections} />
      {!loading && !libraryError && empty ? (
        <Text style={styles.wallpaperPreviewHint} testID="wallpaper-library-empty">
          {t("settings.appearance.wallpaper.library.empty")}
        </Text>
      ) : null}
      {Platform.OS === "web" && library?.items.length ? (
        <WallpaperCandidateGrid
          ref={grid}
          items={library.items}
          currentId={currentId}
          managing={managing}
          selectedIds={selectedIds}
          disabled={!!busy}
          onActivate={handleActivate}
          onEmptyFocus={focusAdd}
        />
      ) : null}
      {confirming ? (
        <WallpaperRemoveConfirmation
          count={selectedIds.size}
          busy={busy}
          message={message}
          onClose={handleClose}
          onRemove={handleRemove}
        />
      ) : null}
    </View>
  );
}

function WallpaperSourceControl({
  source,
  onChange,
}: {
  source: AppSettings["wallpaperSource"];
  onChange: (source: AppSettings["wallpaperSource"]) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.appearance.wallpaper.source.label")}
        </Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={dropdownTriggerStyle}
          accessibilityLabel={t("settings.appearance.wallpaper.source.label")}
          testID="wallpaper-source-trigger"
        >
          <Text style={styles.triggerText}>{wallpaperSourceLabel(t, source)}</Text>
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={160}>
          {WALLPAPER_SOURCES.map((value) => (
            <WallpaperSourceMenuItem
              key={value}
              source={value}
              selected={source === value}
              onSelect={onChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function WallpaperUrlControl({
  url,
  onChange,
}: {
  url: string | null;
  onChange: (url: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.appearance.wallpaper.url.label")}</Text>
        <Text style={settingsStyles.rowHint}>{t("settings.appearance.wallpaper.url.hint")}</Text>
      </View>
      <TextInput
        initialValue={url ?? ""}
        onChangeText={onChange}
        placeholder={t("settings.appearance.wallpaper.url.hint")}
        accessibilityLabel={t("settings.appearance.wallpaper.url.accessibilityLabel")}
        style={styles.wallpaperInput}
        testID="wallpaper-url-input"
      />
    </View>
  );
}

function WallpaperOpacityControl({
  opacity,
  onPreview,
  onCommit,
}: {
  opacity: number;
  onPreview: (value: number) => void;
  onCommit: (value: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.appearance.wallpaper.opacity.label")}
        </Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.appearance.wallpaper.opacity.hint")}
        </Text>
      </View>
      <View style={styles.opacitySliderRow}>
        <View style={styles.opacitySliderContainer}>
          {Platform.OS === "web" ? (
            <OpacitySlider
              opacity={opacity}
              onPreview={onPreview}
              onCommit={onCommit}
              accessibilityLabel={t("settings.appearance.wallpaper.opacity.accessibilityLabel")}
            />
          ) : null}
        </View>
        <Text style={styles.opacityValue}>{Math.round(opacity * 100)}%</Text>
      </View>
    </View>
  );
}

export function WallpaperSection() {
  const { t } = useTranslation();
  const { settings, updateSettings, previewSettings } = useAppSettings();
  const [operationError, setOperationError] = useState<string | null>(null);
  const wallpaperLoadStatus = useWallpaperLoadStatus(getWallpaperSourceKey(settings));

  const handleToggle = useCallback(
    (wallpaperEnabled: boolean) => void updateSettings({ wallpaperEnabled }),
    [updateSettings],
  );
  const handleSourceChange = useCallback(
    (wallpaperSource: AppSettings["wallpaperSource"]) => void updateSettings({ wallpaperSource }),
    [updateSettings],
  );
  const handleUrlChange = useCallback(
    (wallpaperUrl: string) => void updateSettings({ wallpaperUrl: wallpaperUrl || null }),
    [updateSettings],
  );
  const handleSelectWallpaper = useCallback(
    async (candidateId: string) => {
      try {
        setOperationError(null);
        const retryCurrent =
          settings.wallpaperSource === "file" && settings.wallpaperCandidateId === candidateId;
        await updateSettings({
          wallpaperSource: "file",
          wallpaperCandidateId: candidateId,
        });
        if (retryCurrent) retryWallpaperLoad();
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : String(error));
      }
    },
    [updateSettings, settings.wallpaperSource, settings.wallpaperCandidateId],
  );

  const handleOpacityPreview = useCallback(
    (wallpaperOpacity: number) => previewSettings({ wallpaperOpacity }),
    [previewSettings],
  );
  const handleOpacityCommit = useCallback(
    (wallpaperOpacity: number) => void updateSettings({ wallpaperOpacity }),
    [updateSettings],
  );
  const opacity = settings.wallpaperOpacity ?? 0.85;

  return (
    <SettingsSection title={t("settings.appearance.wallpaper.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.appearance.wallpaper.enabled")}
            </Text>
          </View>
          <Switch
            value={settings.wallpaperEnabled}
            onValueChange={handleToggle}
            accessibilityLabel={t("settings.appearance.wallpaper.enabled")}
            testID="wallpaper-enabled-switch"
          />
        </View>
        {settings.wallpaperEnabled ? (
          <>
            <WallpaperSourceControl
              source={settings.wallpaperSource}
              onChange={handleSourceChange}
            />

            {settings.wallpaperSource === "file" ? (
              <WallpaperLibraryPanel
                currentId={settings.wallpaperCandidateId}
                onApply={handleSelectWallpaper}
                operationError={operationError}
              />
            ) : null}

            {settings.wallpaperSource === "url" ? (
              <WallpaperUrlControl url={settings.wallpaperUrl} onChange={handleUrlChange} />
            ) : null}

            {wallpaperLoadStatus === "error" ? (
              <View style={styles.libraryStatus}>
                <Text style={styles.wallpaperPreviewHint} accessibilityRole="alert">
                  {t("settings.appearance.wallpaper.library.backgroundError")}
                </Text>
                <Button
                  size="sm"
                  variant="outline"
                  onPress={retryWallpaperLoad}
                  testID="wallpaper-background-retry"
                >
                  {t("settings.appearance.wallpaper.library.retry")}
                </Button>
              </View>
            ) : null}

            <WallpaperOpacityControl
              opacity={opacity}
              onPreview={handleOpacityPreview}
              onCommit={handleOpacityCommit}
            />
          </>
        ) : null}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  triggerPressed: { opacity: 0.85 },
  triggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  wallpaperInput: {
    flexGrow: 1,
    flexShrink: 1,
    maxWidth: 280,
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "left",
  },
  opacityValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    minWidth: 48,
  },
  opacitySliderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 200,
  },
  opacitySliderContainer: { flex: 1, maxWidth: 200 },
  wallpaperPreviewContainer: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  wallpaperPreviewHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
  },
  libraryToolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    marginVertical: theme.spacing[2],
  },
  libraryStatus: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  rejectionList: { maxHeight: 160 },
  confirmation: { padding: theme.spacing[4], gap: theme.spacing[3] },
  confirmationActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
