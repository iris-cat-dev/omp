import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { PairLinkModal } from "@/components/pair-link-modal";
import { RemoteSshHostModal } from "@/components/remote-ssh-host-modal";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { isElectronRuntime } from "@/desktop/host";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useLocalDaemonServerIdState } from "@/hooks/use-is-local-daemon";
import { useAppSettings } from "@/hooks/use-settings";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import type { HostProfile } from "@/types/host-connection";
import {
  formatRelayServerAddress,
  parseRelayServerAddress,
  shouldUseTlsForDefaultHostedRelay,
} from "@/utils/daemon-endpoints";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";

const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function RelayHistoryMenuItem({
  address,
  selected,
  onSelect,
}: {
  address: string;
  selected: boolean;
  onSelect: (address: string) => void;
}) {
  const handleSelect = useCallback(() => onSelect(address), [address, onSelect]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {address}
    </DropdownMenuItem>
  );
}

export function AddRemoteHostSection() {
  const { t } = useTranslation();
  const router = useRouter();
  const { addHost } = useLocalSearchParams<{ addHost?: string }>();
  const { settings, isLoading: areSettingsLoading, updateSettings } = useAppSettings();
  const isDesktopApp = isElectronRuntime();
  const { width: viewportWidth } = useWindowDimensions();
  const localDaemonState = useLocalDaemonServerIdState();
  const localDaemonServerId =
    localDaemonState.status === "resolved" ? localDaemonState.serverId : null;
  const isLocalDaemonConnected = useHostRuntimeIsConnected(localDaemonServerId ?? "");
  const {
    config: localDaemonConfig,
    isLoading: isLocalDaemonConfigLoading,
    patchConfig,
  } = useDaemonConfig(localDaemonServerId);
  const localRelay = localDaemonConfig?.relay;
  const relayAddress =
    isDesktopApp && localRelay?.endpoint
      ? formatRelayServerAddress({
          endpoint: localRelay.endpoint,
          useTls: localRelay.useTls ?? shouldUseTlsForDefaultHostedRelay(localRelay.endpoint),
        })
      : settings.relayServerAddress;
  const isRelayLoading =
    areSettingsLoading ||
    (isDesktopApp && (localDaemonState.status === "loading" || isLocalDaemonConfigLoading));
  const isDaemonUnavailable = isDesktopApp && (!isLocalDaemonConnected || !localRelay?.endpoint);
  const consumedIntent = useRef<string | null>(null);
  const [pairVisible, setPairVisible] = useState(false);
  const [sshVisible, setSshVisible] = useState(false);
  const [relayDraft, setRelayDraft] = useState(relayAddress);
  const [relayResetVersion, setRelayResetVersion] = useState(0);
  const [isSavingRelay, setIsSavingRelay] = useState(false);
  const isRelayUnavailable = isRelayLoading || isSavingRelay || isDaemonUnavailable;
  const [relaySaveError, setRelaySaveError] = useState("");
  const [relaySaved, setRelaySaved] = useState(false);
  const relaySaveInFlight = useRef(false);
  const relayHistory = useMemo(
    () => [...new Set([relayAddress, ...settings.relayServerHistory].filter(Boolean))],
    [relayAddress, settings.relayServerHistory],
  );
  const trimmedRelayDraft = relayDraft.trim();
  const parsedRelayDraft = useMemo(() => {
    if (!trimmedRelayDraft) return null;
    try {
      return parseRelayServerAddress(trimmedRelayDraft);
    } catch {
      return null;
    }
  }, [trimmedRelayDraft]);
  const normalizedRelayDraft = parsedRelayDraft ? formatRelayServerAddress(parsedRelayDraft) : "";
  const relayDraftInvalid =
    (isDesktopApp && !trimmedRelayDraft) ||
    (Boolean(trimmedRelayDraft) && parsedRelayDraft === null);
  const desktopRelayDirty =
    isDesktopApp &&
    parsedRelayDraft !== null &&
    (localRelay?.enabled !== true ||
      localRelay.endpoint !== parsedRelayDraft.endpoint ||
      localRelay.useTls !== parsedRelayDraft.useTls ||
      localRelay.publicEndpoint !== parsedRelayDraft.endpoint ||
      localRelay.publicUseTls !== parsedRelayDraft.useTls);
  const relayDraftDirty = normalizedRelayDraft !== settings.relayServerAddress || desktopRelayDirty;
  useEffect(() => {
    setRelayDraft(relayAddress);
    setRelayResetVersion((version) => version + 1);
  }, [relayAddress]);
  useEffect(() => {
    if (typeof addHost === "string" && addHost && consumedIntent.current !== addHost) {
      consumedIntent.current = addHost;
      setPairVisible(true);
    }
  }, [addHost]);
  const handleOpenPair = useCallback(() => setPairVisible(true), []);
  const handleClosePair = useCallback(() => setPairVisible(false), []);
  const handleOpenSsh = useCallback(() => setSshVisible(true), []);
  const handleCloseSsh = useCallback(() => setSshVisible(false), []);
  const handleRelayChange = useCallback((value: string) => {
    setRelayDraft(value);
    setRelaySaved(false);
    setRelaySaveError("");
  }, []);
  const handleRelayReset = useCallback(() => {
    setRelayDraft(relayAddress);
    setRelayResetVersion((version) => version + 1);
    setRelaySaved(false);
    setRelaySaveError("");
  }, [relayAddress]);
  const applyRelayAddress = useCallback(
    async (address: string) => {
      if (relaySaveInFlight.current || isRelayLoading || isDaemonUnavailable) return;
      relaySaveInFlight.current = true;
      setIsSavingRelay(true);
      setRelaySaveError("");
      setRelaySaved(false);
      setRelayDraft(address);
      setRelayResetVersion((version) => version + 1);
      try {
        const parsed = address.trim() ? parseRelayServerAddress(address) : null;
        const normalized = parsed ? formatRelayServerAddress(parsed) : "";
        if (isDesktopApp) {
          if (!parsed) throw new Error(t("pairing.relayAddress.invalid"));
          const updated = await patchConfig({
            relay: {
              enabled: true,
              endpoint: parsed.endpoint,
              useTls: parsed.useTls,
              publicEndpoint: parsed.endpoint,
              publicUseTls: parsed.useTls,
            },
          });
          if (!updated) throw new Error(t("pairing.relayAddress.desktopUnavailable"));
        }
        await updateSettings({
          relayServerAddress: normalized,
          relayServerHistory: relayHistory,
        });
        setRelayDraft(normalized);
        setRelayResetVersion((version) => version + 1);
        setRelaySaved(true);
      } catch (error) {
        setRelaySaveError(error instanceof Error ? error.message : String(error));
      } finally {
        relaySaveInFlight.current = false;
        setIsSavingRelay(false);
      }
    },
    [
      isDaemonUnavailable,
      isDesktopApp,
      isRelayLoading,
      patchConfig,
      relayHistory,
      t,
      updateSettings,
    ],
  );
  const handleRelaySave = useCallback(() => {
    if (relayDraftInvalid || !relayDraftDirty) return;
    return applyRelayAddress(relayDraft);
  }, [applyRelayAddress, relayDraft, relayDraftDirty, relayDraftInvalid]);
  const handleRelaySelect = useCallback(
    (address: string) => {
      void applyRelayAddress(address);
    },
    [applyRelayAddress],
  );
  const handleRelaySubmit = useCallback(() => {
    void handleRelaySave();
  }, [handleRelaySave]);
  const handleSaved = useCallback(
    (profile: HostProfile) => {
      router.replace(buildSettingsHostSectionRoute(profile.serverId, "host"));
    },
    [router],
  );

  return (
    <>
      <SettingsSection title={t("pairing.relayAddress.label")}>
        <View style={styles.relayContent} testID="settings-relay-address">
          <Text style={styles.description}>
            {t(
              isDesktopApp
                ? "pairing.relayAddress.desktopDescription"
                : "pairing.relayAddress.description",
            )}
          </Text>
          <View style={styles.addressField}>
            <AdaptiveTextInput
              initialValue={relayDraft}
              resetKey={relayResetVersion}
              onChangeText={handleRelayChange}
              editable={!isRelayUnavailable}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={styles.input}
              placeholder="wss://relay.example.com"
              accessibilityLabel={t("pairing.relayAddress.label")}
              testID="settings-relay-address-input"
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                style={styles.historyTrigger}
                disabled={isRelayUnavailable || !relayHistory.length}
                accessibilityRole="button"
                accessibilityLabel={t("pairing.relayAddress.history")}
                testID="settings-relay-address-history"
              >
                <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="bottom"
                align="end"
                width={Math.min(420, viewportWidth - 16)}
              >
                <DropdownMenuLabel>{t("pairing.relayAddress.history")}</DropdownMenuLabel>
                {relayHistory.map((address) => (
                  <RelayHistoryMenuItem
                    key={address}
                    address={address}
                    selected={address === relayAddress}
                    onSelect={handleRelaySelect}
                  />
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </View>
          {relayDraftInvalid ? (
            <Alert
              variant="error"
              description={t("pairing.relayAddress.invalid")}
              testID="settings-relay-address-invalid"
            />
          ) : null}
          {isDaemonUnavailable && !isRelayLoading ? (
            <Alert
              variant="error"
              description={t("pairing.relayAddress.desktopUnavailable")}
              testID="settings-relay-daemon-unavailable"
            />
          ) : null}
          {relaySaveError ? (
            <Alert
              variant="error"
              description={relaySaveError}
              testID="settings-relay-address-error"
            />
          ) : null}
          {relaySaved ? (
            <Alert
              variant="success"
              description={t(
                isDesktopApp ? "pairing.relayAddress.desktopSaved" : "pairing.relayAddress.saved",
              )}
              testID="settings-relay-address-success"
            />
          ) : null}
          <View style={styles.actions}>
            <Button
              onPress={handleRelaySubmit}
              disabled={isRelayUnavailable || relayDraftInvalid || !relayDraftDirty}
              testID="settings-relay-address-save"
            >
              {t(isSavingRelay ? "pairing.relayAddress.saving" : "pairing.relayAddress.save")}
            </Button>
            {relayDraft !== relayAddress ? (
              <Button
                variant="outline"
                onPress={handleRelayReset}
                disabled={isSavingRelay}
                testID="settings-relay-address-reset"
              >
                {t("common.actions.cancel")}
              </Button>
            ) : null}
          </View>
        </View>
      </SettingsSection>
      <SettingsSection title={t("settings.addHost")}>
        <View style={styles.actions}>
          {isElectronRuntime() ? (
            <Button
              onPress={handleOpenSsh}
              disabled={areSettingsLoading}
              testID="settings-add-host-ssh"
            >
              {t("pairing.ssh.entry")}
            </Button>
          ) : null}
          <Button
            variant={isElectronRuntime() ? "outline" : "default"}
            onPress={handleOpenPair}
            disabled={areSettingsLoading}
            testID="settings-add-host"
          >
            {t("pairing.connectionMethods.pasteLink.title")}
          </Button>
        </View>
        {pairVisible ? (
          <PairLinkModal visible onClose={handleClosePair} onSaved={handleSaved} />
        ) : null}
        {sshVisible ? (
          <RemoteSshHostModal visible onClose={handleCloseSsh} onSaved={handleSaved} />
        ) : null}
      </SettingsSection>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  relayContent: { gap: theme.spacing[3] },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  addressField: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  historyTrigger: {
    padding: theme.spacing[3],
  },
  input: {
    flex: 1,
    minWidth: 0,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    color: theme.colors.foreground,
  },
}));
