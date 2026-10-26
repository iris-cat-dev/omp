import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { parseConnectionOfferFromUrl } from "@omp-desktop/protocol/connection-offer";
import {
  getDesktopHost,
  type DesktopRemoteSshEvent,
  type DesktopRemoteSshProfile,
} from "@/desktop/host";
import { useAppSettings } from "@/hooks/use-settings";
import { PairHostError, pairHostFromOffer } from "@/pairing/pair-host-from-offer";
import { useHostMutations } from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";
import { reloadLocalModelBridgeProfile } from "@/runtime/local-model-bridge-runtime";
import { AdaptiveModalSheet, AdaptiveTextInput, type SheetHeader } from "./adaptive-modal-sheet";
import { Button } from "./ui/button";

interface RemoteSshHostModalProps {
  visible: boolean;
  onClose: () => void;
  onSaved?: (profile: HostProfile) => void;
  managedProfile?: DesktopRemoteSshProfile | null;
}

type DeploymentState =
  | { status: "form" }
  | { status: "running"; phase: string }
  | { status: "failed"; message: string };

// Terminal output can contain ANSI escape and OSC sequences by design.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1B\\))/gu;
const MAX_TERMINAL_CHARS = 20_000;

export function RemoteSshHostModal({
  visible,
  onClose,
  onSaved,
  managedProfile,
}: RemoteSshHostModalProps) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const { upsertConnectionFromOffer } = useHostMutations();
  const operationId = useRef<string | null>(null);
  const [host, setHost] = useState(managedProfile?.target.host ?? "");
  const [username, setUsername] = useState(managedProfile?.target.username ?? "");
  const [port, setPort] = useState(managedProfile?.target.port?.toString() ?? "");
  const [identityFile, setIdentityFile] = useState(managedProfile?.target.identityFile ?? "");
  const [state, setState] = useState<DeploymentState>({ status: "form" });
  const [terminal, setTerminal] = useState("");
  const [interactive, setInteractive] = useState(false);
  const [authInput, setAuthInput] = useState("");
  const [authResetVersion, setAuthResetVersion] = useState(0);
  const header = useMemo<SheetHeader>(() => ({ title: t("pairing.ssh.title") }), [t]);

  const handleEvent = useCallback(
    (payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const event = payload as DesktopRemoteSshEvent;
      if (event.operationId !== operationId.current) return;
      if (event.type === "terminal") {
        setTerminal((current) =>
          `${current}${event.data.replace(ANSI_PATTERN, "")}`.slice(-MAX_TERMINAL_CHARS),
        );
      } else if (event.type === "interactive") {
        setInteractive(event.enabled);
      } else if (event.type === "phase") {
        const phase =
          event.phase === "uploading" && event.progress !== undefined
            ? t("pairing.ssh.phases.uploadingProgress", { percent: event.progress })
            : t(`pairing.ssh.phases.${event.phase}`);
        setState({ status: "running", phase });
      } else if (event.type === "failed") {
        setState({ status: "failed", message: event.message });
      }
    },
    [t],
  );

  // The deployment callback owns one linear lifecycle: validate, deploy, pair, persist, and clean up.
  // eslint-disable-next-line complexity
  const handleDeploy = useCallback(async () => {
    const desktop = getDesktopHost();
    const bridge = desktop?.remoteSsh;
    if (!desktop || !bridge?.start || !desktop.events?.on) {
      setState({ status: "failed", message: t("pairing.ssh.errors.desktopOnly") });
      return;
    }
    const trimmedHost = host.trim();
    if (!trimmedHost) {
      setState({ status: "failed", message: t("pairing.ssh.errors.hostRequired") });
      return;
    }
    const parsedPort = port.trim() ? Number(port.trim()) : undefined;
    if (
      parsedPort !== undefined &&
      (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)
    ) {
      setState({ status: "failed", message: t("pairing.ssh.errors.invalidPort") });
      return;
    }

    const nextOperationId = crypto.randomUUID();
    operationId.current = nextOperationId;
    setTerminal("");
    setInteractive(true);
    setState({ status: "running", phase: t("pairing.ssh.phases.connecting") });
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = await desktop.events.on("remote-ssh", handleEvent);
      const result = await bridge.start({
        operationId: nextOperationId,
        target: {
          host: trimmedHost,
          ...(username.trim() ? { username: username.trim() } : {}),
          ...(parsedPort !== undefined ? { port: parsedPort } : {}),
          ...(identityFile.trim() ? { identityFile: identityFile.trim() } : {}),
        },
        ...(settings.relayServerAddress ? { relayAddress: settings.relayServerAddress } : {}),
        ...(managedProfile ? { expectedServerId: managedProfile.serverId } : {}),
      });
      const offer = parseConnectionOfferFromUrl(result.offerUrl);
      if (!offer) throw new Error(t("pairing.link.errors.invalid"));
      const profile = await pairHostFromOffer({
        offer,
        configuredRelayAddress: settings.relayServerAddress,
        upsertConnectionFromOffer,
      });
      await bridge.saveProfile?.({
        serverId: profile.serverId,
        target: result.target,
        runtimeRoot: result.runtimeRoot,
        deployedVersion: result.deployedVersion,
        modelSource: managedProfile?.modelSource ?? "local",
      });
      await reloadLocalModelBridgeProfile(profile.serverId);
      onSaved?.(profile);
      onClose();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setState({
        status: "failed",
        message:
          error instanceof PairHostError
            ? t("pairing.link.errors.relayConnectionFailed", {
                ...error.relayContext,
                detail,
              })
            : detail,
      });
    } finally {
      operationId.current = null;
      setInteractive(false);
      unsubscribe?.();
    }
  }, [
    handleEvent,
    host,
    identityFile,
    managedProfile,
    onClose,
    onSaved,
    port,
    settings.relayServerAddress,
    t,
    upsertConnectionFromOffer,
    username,
  ]);

  const handleClose = useCallback(() => {
    const activeOperationId = operationId.current;
    if (activeOperationId) {
      void getDesktopHost()?.remoteSsh?.cancel?.({ operationId: activeOperationId });
    }
    operationId.current = null;
    onClose();
  }, [onClose]);

  const handleChooseIdentity = useCallback(async () => {
    const selected = await getDesktopHost()?.dialog?.open?.({
      title: t("pairing.ssh.identityFile"),
    });
    if (typeof selected === "string") setIdentityFile(selected);
  }, [t]);

  const handleSendInput = useCallback(() => {
    const activeOperationId = operationId.current;
    if (!activeOperationId || !authInput) return;
    void getDesktopHost()?.remoteSsh?.writeInput?.({
      operationId: activeOperationId,
      input: `${authInput}\r`,
    });
    setAuthInput("");
    setAuthResetVersion((version) => version + 1);
  }, [authInput]);

  const isRunning = state.status === "running";
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      testID="remote-ssh-host-modal"
    >
      <Text style={styles.helper}>{t("pairing.ssh.helper")}</Text>
      <Text style={styles.label}>{t("pairing.ssh.host")}</Text>
      <AdaptiveTextInput
        initialValue={host}
        onChangeText={setHost}
        editable={!isRunning}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        placeholder="server.example.com"
        testID="remote-ssh-host-input"
      />
      <Text style={styles.label}>{t("pairing.ssh.username")}</Text>
      <AdaptiveTextInput
        initialValue={username}
        onChangeText={setUsername}
        editable={!isRunning}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        testID="remote-ssh-username-input"
      />
      <Text style={styles.label}>{t("pairing.ssh.port")}</Text>
      <AdaptiveTextInput
        initialValue={port}
        onChangeText={setPort}
        editable={!isRunning}
        keyboardType="number-pad"
        style={styles.input}
        placeholder="22"
        testID="remote-ssh-port-input"
      />
      <Text style={styles.label}>{t("pairing.ssh.identityFile")}</Text>
      <View style={styles.inlineActions}>
        <Text style={styles.path} numberOfLines={1}>
          {identityFile || t("pairing.ssh.identityFileDefault")}
        </Text>
        <Button variant="outline" size="sm" onPress={handleChooseIdentity} disabled={isRunning}>
          {t("pairing.ssh.choose")}
        </Button>
      </View>
      {state.status === "running" ? <Text style={styles.phase}>{state.phase}</Text> : null}
      {terminal ? (
        <Text style={styles.terminal} selectable testID="remote-ssh-terminal">
          {terminal}
        </Text>
      ) : null}
      {interactive && isRunning ? (
        <View style={styles.authRow}>
          <AdaptiveTextInput
            initialValue=""
            resetKey={authResetVersion}
            onChangeText={setAuthInput}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, styles.authInput]}
            placeholder={t("pairing.ssh.authenticationInput")}
            testID="remote-ssh-auth-input"
          />
          <Button onPress={handleSendInput} disabled={!authInput} testID="remote-ssh-auth-send">
            {t("pairing.ssh.send")}
          </Button>
        </View>
      ) : null}
      {state.status === "failed" ? (
        <Text style={styles.error} testID="remote-ssh-error">
          {state.message}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button variant="secondary" onPress={handleClose}>
          {t("common.actions.cancel")}
        </Button>
        {!isRunning ? (
          <Button onPress={handleDeploy} testID="remote-ssh-deploy">
            {managedProfile ? t("pairing.ssh.update") : t("pairing.ssh.connectAndDeploy")}
          </Button>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  helper: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  inlineActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  path: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  phase: { color: theme.colors.accent, fontSize: theme.fontSize.base },
  terminal: {
    maxHeight: 220,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontFamily: "monospace",
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  authRow: { flexDirection: "row", gap: theme.spacing[2], alignItems: "center" },
  authInput: { flex: 1 },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
  actions: { flexDirection: "row", gap: theme.spacing[3], marginTop: theme.spacing[2] },
}));
