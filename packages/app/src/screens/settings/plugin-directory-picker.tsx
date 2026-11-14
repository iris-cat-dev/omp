import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ArrowUp, ChevronRight, Folder } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type {
  DaemonClient,
  FileExplorerDirectoryPayload,
} from "@omp-desktop/client/internal/daemon-client";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { getDesktopHost } from "@/desktop/host";
import { pickDirectory } from "@/desktop/pick-directory";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { isAbsolutePath } from "@/utils/path";

export interface PluginDirectoryPickerProps {
  serverId: string;
  value: string;
  onSelect: (directory: string) => void;
  label: string;
  disabled?: boolean;
  local?: boolean;
  testID?: string;
}

type PickerScope = {
  serverId: string;
  client: DaemonClient | null;
  connected: boolean;
  value: string;
  local: boolean;
  disabled: boolean;
};
type BrowseResult = {
  scope: PickerScope;
  requestedPath: string;
  loading: boolean;
  directory: FileExplorerDirectoryPayload | null;
  error: string | null;
};

function normalizeAbsoluteDirectory(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const root = normalized.match(/^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+(?:\/|$)|\/)/)?.[0];
  if (!root) throw new Error("Expected an absolute host directory path.");
  const segments: string[] = [];
  for (const segment of normalized.slice(root.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `${root.replace(/\/$/, "")}/${segments.join("/")}`;
}

export function PluginDirectoryPicker({
  serverId,
  value,
  onSelect,
  label,
  disabled = false,
  local = false,
  testID = "plugin-directory",
}: PluginDirectoryPickerProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const [open, setOpen] = useState(false);
  const [navigation, setNavigation] = useState({ serverId, path: value || "~" });
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualDraft, setManualDraft] = useState(value);
  const [nativePending, setNativePending] = useState<PickerScope | null>(null);
  const [nativeError, setNativeError] = useState<{ scope: PickerScope; message: string } | null>(
    null,
  );
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(false);
  const requestEpoch = useRef(0);
  const nativeEpoch = useRef(0);
  const nativeLock = useRef(false);
  const hostHome = useRef<{ serverId: string; client: DaemonClient; path: string } | null>(null);
  const scope = useRef<PickerScope>({ serverId, client, connected, value, local, disabled });
  if (
    scope.current.serverId !== serverId ||
    scope.current.client !== client ||
    scope.current.connected !== connected ||
    scope.current.value !== value ||
    scope.current.local !== local ||
    scope.current.disabled !== disabled
  ) {
    scope.current = { serverId, client, connected, value, local, disabled };
  }
  const currentScope = scope.current;
  const browsePath = navigation.serverId === serverId ? navigation.path : value || "~";
  const currentResult =
    result?.scope === currentScope && result.requestedPath === browsePath ? result : null;
  const directory = currentResult?.directory ?? null;
  const loading = open && (!currentResult || currentResult.loading);
  const nativeBusy = nativePending !== null;
  const error = currentResult?.error ?? null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestEpoch.current++;
      nativeEpoch.current++;
    };
  }, []);

  useEffect(() => {
    setManualDraft(value);
    setManualOpen(false);
  }, [serverId, value, local]);

  const close = useCallback(() => {
    requestEpoch.current++;
    setOpen(false);
  }, []);

  const resolveDirectoryPath = useCallback(
    async (path: string) => {
      if (isAbsolutePath(path)) return normalizeAbsoluteDirectory(path);
      if (!client || !connected)
        throw new Error(
          t("plugins.folder.offline", { defaultValue: "Connect to this host to browse folders." }),
        );
      let homePath =
        hostHome.current?.serverId === serverId && hostHome.current.client === client
          ? hostHome.current.path
          : null;
      if (!homePath) {
        const home = await client.getDirectorySuggestions({
          query: "~/.",
          matchMode: "suffix",
          includeDirectories: true,
          includeFiles: false,
          limit: 1,
        });
        if (home.error) throw new Error(home.error);
        const entry = home.entries.find(
          (candidate) => candidate.kind === "directory" && isAbsolutePath(candidate.path),
        );
        if (!entry)
          throw new Error(
            t("plugins.folder.resolveHome", {
              defaultValue: "Could not resolve this host's home folder.",
            }),
          );
        homePath = normalizeAbsoluteDirectory(entry.path);
        if (
          mounted.current &&
          scope.current.serverId === serverId &&
          scope.current.client === client
        )
          hostHome.current = { serverId, client, path: homePath };
      }
      const relative = path === "~" ? "" : path.startsWith("~/") ? path.slice(2) : path;
      return normalizeAbsoluteDirectory(`${homePath}/${relative}`);
    },
    [client, connected, serverId, t],
  );

  useEffect(() => {
    if (disabled) {
      setOpen(false);
      return;
    }
    if (!open) return;
    const epoch = ++requestEpoch.current;
    setResult({
      scope: currentScope,
      requestedPath: browsePath,
      loading: true,
      directory: null,
      error: null,
    });
    const isCurrent = () =>
      mounted.current && requestEpoch.current === epoch && scope.current === currentScope;
    void (async () => {
      try {
        if (!currentScope.client || !currentScope.connected)
          throw new Error(
            t("plugins.folder.offline", {
              defaultValue: "Connect to this host to browse folders.",
            }),
          );
        const absolutePath = await resolveDirectoryPath(browsePath);
        if (!isCurrent()) return;
        const listing = await currentScope.client.listDirectory(absolutePath, ".");
        const canonical = {
          ...listing,
          path: normalizeAbsoluteDirectory(`${absolutePath}/${listing.path}`),
          entries: listing.entries
            .filter((entry) => entry.kind === "directory")
            .map((entry) => ({
              ...entry,
              path: normalizeAbsoluteDirectory(`${absolutePath}/${entry.path}`),
            })),
        };
        if (isCurrent())
          setResult({
            scope: currentScope,
            requestedPath: browsePath,
            loading: false,
            directory: canonical,
            error: null,
          });
      } catch (failure) {
        if (isCurrent())
          setResult({
            scope: currentScope,
            requestedPath: browsePath,
            loading: false,
            directory: null,
            error: failure instanceof Error ? failure.message : String(failure),
          });
      }
    })();
    return () => {
      requestEpoch.current++;
    };
  }, [open, disabled, currentScope, browsePath, refresh, resolveDirectoryPath, t]);

  const browse = async () => {
    if (disabled || nativeLock.current) return;
    setNativeError(null);
    if (local && getDesktopHost()?.dialog) {
      const epoch = ++nativeEpoch.current;
      nativeLock.current = true;
      setNativePending(currentScope);
      try {
        const selected = await pickDirectory();
        if (
          selected !== null &&
          mounted.current &&
          nativeEpoch.current === epoch &&
          scope.current === currentScope
        )
          onSelect(selected);
      } catch (failure) {
        if (mounted.current && nativeEpoch.current === epoch && scope.current === currentScope)
          setNativeError({
            scope: currentScope,
            message: failure instanceof Error ? failure.message : String(failure),
          });
      } finally {
        nativeLock.current = false;
        if (mounted.current && nativeEpoch.current === epoch) setNativePending(null);
      }
      return;
    }
    requestEpoch.current++;
    setResult(null);
    setNavigation({ serverId, path: value || "~" });
    setOpen(true);
  };

  const navigate = (path: string) => {
    requestEpoch.current++;
    setResult(null);
    setNavigation({ serverId, path });
  };
  const selectCurrent = () => {
    if (disabled || loading || error || !directory) return;
    const selected = directory.path;
    close();
    onSelect(selected);
  };
  const parentPath = directory ? normalizeAbsoluteDirectory(`${directory.path}/..`) : null;
  const folders = directory
    ? [...directory.entries].sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return (
    <View style={styles.body} testID={testID}>
      <Field label={label}>
        <View style={styles.selection}>
          <Button
            variant="outline"
            leftIcon={Folder}
            disabled={disabled || nativeBusy}
            loading={nativeBusy}
            onPress={() => void browse()}
            testID={`${testID}-browse`}
          >
            {t("plugins.folder.browse", { defaultValue: "Choose folder" })}
          </Button>
          <Text style={styles.path} numberOfLines={2} selectable testID={`${testID}-value`}>
            {value || t("plugins.folder.notSelected", { defaultValue: "No folder selected" })}
          </Text>
        </View>
      </Field>
      {nativeError?.scope === currentScope ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {nativeError.message}
        </Text>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        style={styles.manualToggle}
        disabled={disabled || nativeBusy}
        onPress={() => {
          setManualDraft(value);
          setManualOpen((visible) => !visible);
        }}
        testID={`${testID}-enter-path`}
      >
        {t("plugins.folder.enterPath", { defaultValue: "Enter path" })}
      </Button>
      {manualOpen ? (
        <Field label={t("plugins.folder.path", { defaultValue: "Folder path (optional)" })}>
          <View style={styles.manualRow}>
            <View style={styles.input}>
              <FormTextInput
                initialValue={manualDraft}
                resetKey={`${serverId}:${value}`}
                editable={!disabled && !nativeBusy}
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setManualDraft}
                testID={`${testID}-path`}
              />
            </View>
            <Button
              variant="outline"
              disabled={disabled || nativeBusy || !manualDraft.trim()}
              onPress={() => {
                const path = manualDraft.trim();
                if (isAbsolutePath(path)) onSelect(normalizeAbsoluteDirectory(path));
                else {
                  setNavigation({ serverId, path });
                  setResult(null);
                  setOpen(true);
                }
                setManualOpen(false);
              }}
              testID={`${testID}-use-path`}
            >
              {t("plugins.folder.usePath", { defaultValue: "Use path" })}
            </Button>
          </View>
        </Field>
      ) : null}
      <AdaptiveModalSheet
        header={{ title: t("plugins.folder.title", { defaultValue: "Choose a folder" }) }}
        visible={open && !disabled}
        onClose={close}
        testID={`${testID}-sheet`}
        density="compact"
        footer={
          <View style={styles.actions}>
            <Button variant="secondary" onPress={close} testID={`${testID}-cancel`}>
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="default"
              disabled={disabled || loading || !!error || !directory}
              onPress={selectCurrent}
              testID={`${testID}-select`}
            >
              {t("plugins.folder.select", { defaultValue: "Select this folder" })}
            </Button>
          </View>
        }
      >
        <View style={styles.body}>
          <Text style={styles.currentPath} selectable testID={`${testID}-current-path`}>
            {directory?.path ?? browsePath}
          </Text>
          <View style={styles.selection}>
            <Button
              variant="outline"
              size="sm"
              leftIcon={ArrowUp}
              style={styles.parentButton}
              disabled={loading || !parentPath || parentPath === directory?.path}
              onPress={() => {
                if (parentPath) navigate(parentPath);
              }}
              testID={`${testID}-parent`}
            >
              {t("plugins.folder.parent", { defaultValue: "Parent folder" })}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={loading || (!error && directory?.path === hostHome.current?.path)}
              onPress={() => navigate("~")}
              testID={`${testID}-home`}
            >
              {t("plugins.folder.home", { defaultValue: "Home" })}
            </Button>
          </View>
          {loading ? <Text style={styles.path}>{t("common.loading")}</Text> : null}
          {error ? (
            <View style={styles.body}>
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
              <Button
                variant="outline"
                onPress={() => setRefresh((revision) => revision + 1)}
                testID={`${testID}-retry`}
              >
                {t("plugins.folder.retry", { defaultValue: "Try again" })}
              </Button>
            </View>
          ) : null}
          {!loading && !error && directory && !folders.length ? (
            <Text style={styles.path}>
              {t("plugins.folder.empty", { defaultValue: "No folders here" })}
            </Text>
          ) : null}
          {folders.map((folder) => (
            <Button
              key={folder.path}
              variant="ghost"
              leftIcon={Folder}
              trailing={<ChevronRight size={16} color={theme.colors.foregroundMuted} />}
              style={styles.folder}
              onPress={() => navigate(folder.path)}
              testID={`${testID}-folder-${folder.path}`}
            >
              {folder.name}
            </Button>
          ))}
        </View>
      </AdaptiveModalSheet>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[2] },
  selection: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  path: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
  currentPath: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  manualToggle: { alignSelf: "flex-start" },
  manualRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  input: { flex: 1, minWidth: 0 },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  parentButton: { alignSelf: "flex-start" },
  folder: { justifyContent: "flex-start" },
}));
