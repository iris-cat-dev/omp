import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { isElectronRuntime } from "@/desktop/host";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatVersionWithPrefix } from "./desktop-updates";

interface AppUpdateCheckResult {
  hasUpdate: boolean;
  readyToInstall: boolean;
  currentVersion: string;
  latestVersion: string;
  body: string | null;
  date: string | null;
  errorMessage: string | null;
}

interface AppUpdateInstallResult {
  installed: boolean;
  version: string | null;
  message: string;
}

export type DesktopUpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "ready"
  | "installing"
  | "error";

export interface DesktopUpdateState {
  status: DesktopUpdateStatus;
  latestVersion: string | null;
  releaseNotes: string | null;
  errorMessage: string | null;
  lastCheckedAt: Date | null;
}

interface DesktopUpdateContextValue extends DesktopUpdateState {
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
}

const INITIAL_STATE: DesktopUpdateState = {
  status: "idle",
  latestVersion: null,
  releaseNotes: null,
  errorMessage: null,
  lastCheckedAt: null,
};

const DesktopUpdateContext = createContext<DesktopUpdateContextValue | null>(null);

export function DesktopUpdateProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const callouts = useSidebarCallouts();
  const { settings, isLoading } = useDesktopSettings();
  const [state, setState] = useState<DesktopUpdateState>(INITIAL_STATE);
  const automaticChannelRef = useRef<string | null>(null);

  const runCheck = useCallback(
    async (intent: "automatic" | "manual") => {
      setState((current) => ({ ...current, status: "checking", errorMessage: null }));
      try {
        const result = await invokeDesktopCommand<AppUpdateCheckResult>("check_app_update", {
          intent,
          releaseChannel: settings.releaseChannel,
        });
        const lastCheckedAt = new Date();
        if (result.errorMessage) {
          if (intent === "automatic") {
            setState((current) => ({ ...current, status: "idle", lastCheckedAt }));
            return;
          }
          setState((current) => ({
            ...current,
            status: "error",
            errorMessage: t("desktop.updates.status.failed"),
          }));
          return;
        }
        if (result.hasUpdate && result.readyToInstall) {
          setState({
            status: "ready",
            latestVersion: result.latestVersion,
            releaseNotes: result.body,
            errorMessage: null,
            lastCheckedAt,
          });
          return;
        }
        setState({
          status: "up-to-date",
          latestVersion: null,
          releaseNotes: null,
          errorMessage: null,
          lastCheckedAt,
        });
      } catch {
        if (intent === "automatic") {
          setState((current) => ({ ...current, status: "idle" }));
          return;
        }
        setState((current) => ({
          ...current,
          status: "error",
          errorMessage: t("desktop.updates.status.failed"),
        }));
      }
    },
    [settings.releaseChannel, t],
  );

  const checkForUpdates = useCallback(async () => {
    await runCheck("manual");
  }, [runCheck]);

  const installUpdate = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("settings.about.updates.installTitle"),
      message: t("settings.about.updates.installMessage"),
      confirmLabel: t("settings.about.updates.installConfirm"),
    });
    if (!confirmed) return;

    setState((current) => ({ ...current, status: "installing", errorMessage: null }));
    try {
      const result = await invokeDesktopCommand<AppUpdateInstallResult>("install_app_update", {
        releaseChannel: settings.releaseChannel,
      });
      if (!result.installed) {
        setState((current) => ({
          ...current,
          status: "error",
          errorMessage: result.message || t("desktop.updates.installError"),
        }));
      }
    } catch (error) {
      setState((current) => ({
        ...current,
        status: "error",
        errorMessage: error instanceof Error ? error.message : t("desktop.updates.installError"),
      }));
    }
  }, [settings.releaseChannel, t]);

  useEffect(() => {
    if (!isElectronRuntime() || isLoading) return;
    if (automaticChannelRef.current === settings.releaseChannel) return;
    automaticChannelRef.current = settings.releaseChannel;
    void runCheck("automatic");
  }, [isLoading, runCheck, settings.releaseChannel]);

  useEffect(() => {
    if (state.status !== "ready") return;
    const version = state.latestVersion;
    return callouts.show({
      id: "desktop-app-update",
      dismissalKey: version ? `desktop-app-update:${version}` : undefined,
      priority: 200,
      title: t("desktop.updates.callout.availableTitle"),
      description: version
        ? t("desktop.updates.callout.versionReady", {
            version: formatVersionWithPrefix(version),
          })
        : t("desktop.updates.callout.newVersionReady"),
      actions: [
        {
          label: t("desktop.updates.callout.installAndRestart"),
          onPress: () => void installUpdate(),
          variant: "primary",
          testID: "desktop-update-install",
        },
      ],
      testID: "desktop-update-callout",
    });
  }, [callouts, installUpdate, state.latestVersion, state.status, t]);

  const value = useMemo<DesktopUpdateContextValue>(
    () => ({ ...state, checkForUpdates, installUpdate }),
    [checkForUpdates, installUpdate, state],
  );

  return <DesktopUpdateContext.Provider value={value}>{children}</DesktopUpdateContext.Provider>;
}

export function useDesktopUpdate(): DesktopUpdateContextValue {
  const context = useContext(DesktopUpdateContext);
  if (!context) {
    throw new Error("useDesktopUpdate must be used within DesktopUpdateProvider");
  }
  return context;
}
