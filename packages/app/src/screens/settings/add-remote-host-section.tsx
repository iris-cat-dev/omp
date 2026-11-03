import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { PairLinkModal } from "@/components/pair-link-modal";
import { RemoteSshHostModal } from "@/components/remote-ssh-host-modal";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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

export function AddRemoteHostSection() {
  const { t } = useTranslation();
  const router = useRouter();
  const { addHost } = useLocalSearchParams<{ addHost?: string }>();
  const { settings, isLoading: areSettingsLoading, updateSettings } = useAppSettings();
  const isDesktopApp = isElectronRuntime();
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
    (isDesktopApp &&
      (localDaemonState.status === "loading" || isLocalDaemonConfigLoading));
  const isDaemonUnavailable =
    isDesktopApp && (!isLocalDaemonConnected || !localRelay?.endpoint);
  const consumedIntent = useRef<string | null>(null);
  const [pairVisible, setPairVisible] = useState(false);
  const [sshVisible, setSshVisible] = useState(false);
  const [relayDraft, setRelayDraft] = useState(relayAddress);
  const [relayResetVersion, setRelayResetVersion] = useState(0);
  const [isSavingRelay, setIsSavingRelay] = useState(false);
  const [relaySaveError, setRelaySaveError] = useState("");
  const [relaySaved, setRelaySaved] = useState(false);
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
  const relayDraftDirty =
    normalizedRelayDraft !== settings.relayServerAddress || desktopRelayDirty;
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
  const handleRelaySave = useCallback(async () => {
    if (
      relayDraftInvalid ||
      !relayDraftDirty ||
      isSavingRelay ||
      isRelayLoading ||
      isDaemonUnavailable
    ) {
      return;
    }
    setIsSavingRelay(true);
    setRelaySaveError("");
    setRelaySaved(false);
    try {
      if (isDesktopApp) {
        if (!parsedRelayDraft) {
          throw new Error(t("pairing.relayAddress.invalid"));
        }
        const updated = await patchConfig({
          relay: {
            enabled: true,
            endpoint: parsedRelayDraft.endpoint,
            useTls: parsedRelayDraft.useTls,
            publicEndpoint: parsedRelayDraft.endpoint,
            publicUseTls: parsedRelayDraft.useTls,
          },
        });
        if (!updated) {
          throw new Error(t("pairing.relayAddress.desktopUnavailable"));
        }
      }
      await updateSettings({ relayServerAddress: normalizedRelayDraft });
      setRelayDraft(normalizedRelayDraft);
      setRelayResetVersion((version) => version + 1);
      setRelaySaved(true);
    } catch (error) {
      setRelaySaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingRelay(false);
    }
  }, [
    isDaemonUnavailable,
    isDesktopApp,
    isRelayLoading,
    isSavingRelay,
    normalizedRelayDraft,
    parsedRelayDraft,
    patchConfig,
    relayDraftDirty,
    relayDraftInvalid,
    t,
    updateSettings,
  ]);
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
          <AdaptiveTextInput
            initialValue={relayAddress}
            resetKey={`${relayResetVersion}:${relayAddress}`}
            onChangeText={handleRelayChange}
            editable={!isRelayLoading && !isSavingRelay && !isDaemonUnavailable}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={styles.input}
            placeholder="wss://relay.example.com"
            accessibilityLabel={t("pairing.relayAddress.label")}
            testID="settings-relay-address-input"
          />
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
                isDesktopApp
                  ? "pairing.relayAddress.desktopSaved"
                  : "pairing.relayAddress.saved",
              )}
              testID="settings-relay-address-success"
            />
          ) : null}
          <View style={styles.actions}>
            <Button
              onPress={handleRelaySubmit}
              disabled={
                isRelayLoading ||
                isDaemonUnavailable ||
                isSavingRelay ||
                relayDraftInvalid ||
                !relayDraftDirty
              }
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
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
}));
