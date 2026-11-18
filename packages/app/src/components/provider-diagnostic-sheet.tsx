import { isCancelledError, useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Gauge,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RotateCw,
  Save,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react-native";
import type { TFunction } from "i18next";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
  Text,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { ModelProviderBrandIcon } from "@/components/icons/model-provider-brand-icon";
import { OmpBuiltinApiKeyForm } from "@/components/omp-builtin-api-key-form";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import { SettingsTextArea } from "@/components/settings-textarea";
import { ScrollableCodeSurface, SurfaceCard } from "@/components/ui/scrollable-code-surface";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  OMP_PROVIDER_MANAGEMENT_GC_TIME_MS,
  fetchOmpAccountQuotaManagement,
  ompProviderManagementStaleTime,
  ompProviderManagementQueryKey,
  refreshOmpAccountQuotaManagement,
} from "@/hooks/use-omp-account-quota";
import { PROVIDER_USAGE_QUERY_PREFIX } from "@/provider-usage/use-provider-usage";
import { useOmpProviderAccountNotes } from "@/hooks/use-omp-provider-account-notes";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ModelConnectionChat } from "@/screens/settings/model-connection-chat";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatTimeAgo } from "@/utils/time";
import { openExternalUrl } from "@/utils/open-external-url";
import { compareMatchScores, scoreTextFields } from "@omp-desktop/protocol/search/text-match";
import type { AgentModelDefinition } from "@omp-desktop/protocol/agent-types";
import type { OmpProviderApi, OmpProviderManagement } from "@omp-desktop/protocol/messages";
import {
  createEmptyProviderDraft,
  configureDiscoveredProviderModels,
  customProviderDraftToInput,
  OMP_PROVIDER_APIS,
  parseCustomProviderDraft,
  updateCustomProviderConfigYaml,
  type OmpProviderDraft,
  type OmpProviderModelDraft,
} from "./omp-custom-provider-config";
import { updateOmpProviderAccountNote } from "./omp-provider-account-notes";
import { formatOmpAccountIdentity, resolveOmpLoginAction } from "./omp-provider-accounts";
import {
  groupOmpDiscoveredModels,
  resolveProviderDiscoveredModels,
  type OmpDiscoveredModelGroup,
  type ProviderDiscoveredModelsCache,
} from "./provider-diagnostic-models";
import {
  buildOmpProviderDirectory,
  canStartOmpBrowserLogin,
  searchOmpProviderDirectory,
  type OmpProviderSummary,
} from "./omp-provider-directory";
import { connectionStyles } from "./omp-provider-connection-styles";

interface ProviderDiagnosticSheetProps {
  provider: string;
  visible: boolean;
  onClose?: () => void;
  serverId: string;
  inline?: boolean;
}

const NOOP = () => undefined;
const EXPANDED_STATE = { expanded: true };
const COLLAPSED_STATE = { expanded: false };

function rankModels<T>(items: T[], query: string, fields: (item: T) => string[]): T[] {
  if (!query.trim()) return items;
  const scored = items
    .map((item) => ({ item, score: scoreTextFields(query, fields(item)) }))
    .filter(
      (entry): entry is { item: T; score: NonNullable<typeof entry.score> } => entry.score !== null,
    );
  scored.sort((a, b) => compareMatchScores(a.score, b.score));
  return scored.map((entry) => entry.item);
}

function DiscoveredModelRow({
  model,
  providerId,
}: {
  model: AgentModelDefinition;
  providerId: string;
}) {
  const prefix = `${providerId}/`;
  const namePrefix = `${model.metadata?.providerName ?? providerId}/`;
  let label = model.label;
  if (label.startsWith(namePrefix)) {
    label = label.slice(namePrefix.length);
  } else if (label.startsWith(prefix)) {
    label = label.slice(prefix.length);
  }
  const modelId = model.id.startsWith(prefix) ? model.id.slice(prefix.length) : model.id;
  const description = model.description?.startsWith(prefix)
    ? model.description.slice(prefix.length)
    : model.description;
  return (
    <View style={sheetStyles.modelRow}>
      <Text style={sheetStyles.modelTitle} numberOfLines={1}>
        {label}
      </Text>
      <Text
        style={sheetStyles.monoHint}
        numberOfLines={1}
        selectable
        dataSet={CODE_SURFACE_DATASET}
      >
        {modelId}
      </Text>
      {description && description !== modelId ? (
        <Text style={sheetStyles.descriptionInline} numberOfLines={1}>
          {description}
        </Text>
      ) : null}
    </View>
  );
}

function OmpModelProviderGroup({
  group,
  forceExpanded,
}: {
  group: OmpDiscoveredModelGroup;
  forceExpanded: boolean;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(false);
  const isExpanded = forceExpanded || expanded;
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);
  const accessibilityState = useMemo(() => ({ expanded: isExpanded }), [isExpanded]);
  return (
    <View style={settingsStyles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(
          group.models.length === 1
            ? "settings.providers.omp.models.providerGroupOne"
            : "settings.providers.omp.models.providerGroupMany",
          {
            provider: group.label,
            count: group.models.length,
          },
        )}
        accessibilityState={accessibilityState}
        onPress={toggleExpanded}
        style={sheetStyles.modelGroupHeader}
        testID={`omp-model-group-${group.id}`}
      >
        <View style={sheetStyles.modelGroupTitle}>
          {isExpanded ? (
            <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          ) : (
            <ChevronRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          )}
          <Text style={settingsStyles.rowTitle}>{group.label}</Text>
        </View>
        <Text style={sheetStyles.mutedText}>
          {t(
            group.models.length === 1
              ? "settings.providers.models.one"
              : "settings.providers.models.many",
            { count: group.models.length },
          )}
        </Text>
      </Pressable>
      {isExpanded
        ? group.models.map((model) => (
            <DiscoveredModelRow key={model.id} model={model} providerId={group.id} />
          ))
        : null}
    </View>
  );
}

function SectionHeader({ title, count, hint }: { title: string; count?: number; hint?: string }) {
  return (
    <View style={sheetStyles.sectionHeader}>
      <Text style={settingsStyles.sectionHeaderTitle}>{title}</Text>
      <View style={sheetStyles.sectionHeaderMeta}>
        {count !== undefined ? (
          <Text style={settingsStyles.sectionHeaderTitle}>{count}</Text>
        ) : null}
        {count !== undefined && hint ? (
          <Text style={settingsStyles.sectionHeaderTitle}>·</Text>
        ) : null}
        {hint ? <Text style={settingsStyles.sectionHeaderTitle}>{hint}</Text> : null}
      </View>
    </View>
  );
}
function CollapsibleSectionHeader({
  title,
  count,
  expanded,
  disabled = false,
  onPress,
  testID,
}: {
  title: string;
  count?: number;
  expanded: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID: string;
}) {
  const { theme } = useUnistyles();
  const accessibilityState = useMemo(() => ({ disabled, expanded }), [disabled, expanded]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={onPress}
      style={sheetStyles.collapsibleSectionHeader}
      testID={testID}
    >
      <View style={sheetStyles.collapsibleSectionTitle}>
        {expanded ? (
          <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
        ) : (
          <ChevronRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
        )}
        <Text style={settingsStyles.sectionHeaderTitle}>{title}</Text>
      </View>
      {count !== undefined ? <Text style={connectionStyles.count}>{count}</Text> : null}
    </Pressable>
  );
}

const EMPTY_OMP_ACCOUNT_NOTES: Record<string, string> = {};

type OmpManagedProviderModel = NonNullable<
  OmpProviderManagement["providerModels"][number]["models"]
>[number];

type OmpProviderAccount = NonNullable<
  OmpProviderManagement["loginProviders"][number]["accounts"]
>[number];

function OmpProviderAccountRow({
  account,
  index,
  note,
  editing,
  noteDraft,
  saving,
  loggingOut,
  disabled,
  canMoveUp,
  canMoveDown,
  moving,
  onEdit,
  onChangeNote,
  onSave,
  onCancel,
  onLogout,
  onMoveUp,
  onMoveDown,
}: {
  account: OmpProviderAccount;
  index: number;
  note?: string;
  editing: boolean;
  noteDraft: string;
  saving: boolean;
  loggingOut: boolean;
  disabled: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  moving: boolean;
  onEdit: () => void;
  onChangeNote: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onLogout: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const { t } = useTranslation();
  const identity = formatOmpAccountIdentity(account.identityKey);
  const accountLabel =
    identity.primary ??
    t("settings.providers.omp.multiAccount.fallback", {
      number: account.accountNumber ?? index + 1,
    });
  return (
    <View style={sheetStyles.accountRow} testID={`omp-provider-account-${account.credentialId}`}>
      {editing ? (
        <View style={sheetStyles.accountEditForm}>
          <AdaptiveTextInput
            initialValue={noteDraft}
            resetKey={`${account.credentialId}-${editing}`}
            onChangeText={onChangeNote}
            placeholder={t("settings.providers.omp.multiAccount.notePlaceholder")}
            maxLength={200}
            autoCorrect={false}
            style={sheetStyles.accountNoteInput}
            testID={`omp-provider-account-note-input-${account.credentialId}`}
          />
          <View style={sheetStyles.accountEditActions}>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={X}
              onPress={onCancel}
              disabled={saving}
              testID={`omp-provider-account-note-cancel-${account.credentialId}`}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="default"
              size="sm"
              leftIcon={saving ? undefined : Save}
              onPress={onSave}
              disabled={saving}
              testID={`omp-provider-account-note-save-${account.credentialId}`}
            >
              {saving
                ? t("settings.providers.omp.multiAccount.savingNote")
                : t("settings.providers.omp.multiAccount.saveNote")}
            </Button>
          </View>
        </View>
      ) : (
        <>
          <View style={sheetStyles.accountIdentity}>
            <Text style={sheetStyles.accountTitle}>{accountLabel}</Text>
            {identity.secondary ? (
              <Text style={sheetStyles.mutedText} numberOfLines={1}>
                {identity.secondary}
              </Text>
            ) : null}
            {note ? (
              <Text style={sheetStyles.accountNote} numberOfLines={2}>
                {note}
              </Text>
            ) : null}
          </View>
          <View style={sheetStyles.accountActions}>
            {canMoveUp || canMoveDown ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={ChevronUp}
                  onPress={onMoveUp}
                  disabled={disabled || moving || !canMoveUp}
                  testID={`omp-provider-account-move-up-${account.credentialId}`}
                >
                  {t("settings.providers.omp.multiAccount.moveUp")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={ChevronDown}
                  onPress={onMoveDown}
                  disabled={disabled || moving || !canMoveDown}
                  testID={`omp-provider-account-move-down-${account.credentialId}`}
                >
                  {t("settings.providers.omp.multiAccount.moveDown")}
                </Button>
              </>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              leftIcon={Pencil}
              onPress={onEdit}
              disabled={disabled}
              testID={`omp-provider-account-note-edit-${account.credentialId}`}
            >
              {t(
                note
                  ? "settings.providers.omp.multiAccount.editNote"
                  : "settings.providers.omp.multiAccount.addNote",
              )}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              leftIcon={loggingOut ? undefined : LogOut}
              onPress={onLogout}
              disabled={disabled}
              testID={`omp-provider-account-logout-${account.credentialId}`}
            >
              {t(
                loggingOut
                  ? "settings.providers.omp.provider.signingOut"
                  : "settings.providers.omp.provider.signOut",
              )}
            </Button>
          </View>
        </>
      )}
    </View>
  );
}

interface OmpProviderSummaryRowProps {
  summary: OmpProviderSummary;
  serverId: string;
  onApiKey?: (summary: OmpProviderSummary) => void;
  loggingInProviderId: string | null;
  loggingOutProviderId: string | null;
  loggingOutCredentialId: number | null;
  loginFlowActive: boolean;
  removingProviderId?: string | null;
  reorderingProviderId?: string | null;
  accountNotes?: Record<string, string>;
  accountNotesLoading?: boolean;
  editingAccountId?: number | null;
  accountNoteDraft?: string;
  savingAccountNoteId?: number | null;
  onConfigureModels?: (providerId: string) => void;
  onEdit?: (providerId: string) => void;
  onLogin: (providerId: string) => void;
  onLogout?: (providerId: string) => void;
  onLogoutAccount?: (providerId: string, credentialId: number) => void;
  onReorderAccounts?: (providerId: string, credentialIds: number[]) => void;
  onRemove?: (providerId: string) => void;
  onEditAccountNote?: (credentialId: number) => void;
  onChangeAccountNote?: (value: string) => void;
  onSaveAccountNote?: () => void;
  onCancelAccountNote?: () => void;
}

function OmpProviderSummaryActions({
  summary,
  login,
  loginAction,
  loggingInProviderId,
  loggingOutProviderId,
  loggingOutAll,
  loginFlowActive,
  removingProviderId,
  onConfigureModels,
  onEdit,
  onRemove,
  onLogin,
  onLogout,
  onApiKey,
}: {
  summary: OmpProviderSummary;
  login: OmpProviderSummary["login"];
  loginAction: ReturnType<typeof resolveOmpLoginAction> | null;
  loggingInProviderId: string | null;
  loggingOutProviderId: string | null;
  loggingOutAll: boolean;
  loginFlowActive: boolean;
  removingProviderId?: string | null;
  onConfigureModels?: () => void;
  onEdit?: () => void;
  onRemove?: () => void;
  onLogin: (providerId: string) => void;
  onLogout?: () => void;
  onApiKey?: (summary: OmpProviderSummary) => void;
}) {
  const { t } = useTranslation();
  const accounts = login?.accounts ?? [];
  const [showDeviceCode, setShowDeviceCode] = useState(false);
  const browserAvailable = canStartOmpBrowserLogin(login);
  const deviceAvailable = canStartOmpBrowserLogin(summary.deviceCodeLogin);
  const loginId = login?.id;
  const deviceLoginId = summary.deviceCodeLogin?.id;
  const handleLogin = useCallback(() => {
    if (loginId !== undefined) onLogin(loginId);
  }, [loginId, onLogin]);
  const handleDeviceLogin = useCallback(() => {
    if (deviceLoginId !== undefined) onLogin(deviceLoginId);
  }, [deviceLoginId, onLogin]);
  const handleApiKey = useCallback(() => onApiKey?.(summary), [onApiKey, summary]);
  const toggleDeviceCode = useCallback(() => setShowDeviceCode((current) => !current), []);
  function renderConfigureModelsAction(): ReactElement | null {
    if (!summary.models?.length || !onConfigureModels) {
      return null;
    }
    return (
      <Button
        variant="secondary"
        size="sm"
        leftIcon={Settings2}
        onPress={onConfigureModels}
        testID={`omp-configure-models-${summary.id}`}
      >
        {t("settings.providers.omp.contextWindow.configure")}
      </Button>
    );
  }

  function renderLoginAction(): ReactElement | null {
    if (!login || !loginAction || !browserAvailable) {
      return null;
    }
    let label: string;
    if (loggingInProviderId === login.id) {
      label = t("settings.providers.omp.provider.starting");
    } else if (deviceAvailable) {
      label = t(login.authenticated
        ? "settings.providers.omp.provider.codexBrowserAddAccount"
        : "settings.providers.omp.provider.codexBrowserSignIn");
    } else {
      label = t(loginAction === "add-account"
        ? "settings.providers.omp.multiAccount.add"
        : "settings.providers.omp.provider.signIn");
    }
    return (
      <Button
        variant={!login.authenticated ? "default" : "secondary"}
        size="sm"
        leftIcon={loggingInProviderId === login.id ? undefined : LogIn}
        onPress={handleLogin}
        disabled={Boolean(loggingInProviderId || loggingOutProviderId || loginFlowActive)}
        testID={`omp-login-provider-${login.id}`}
      >
        {label}
      </Button>
    );
  }

  function renderDeviceCodeLoginAction(): ReactElement | null {
    const deviceLogin = summary.deviceCodeLogin;
    if (!deviceLogin || !deviceAvailable || !login) {
      return null;
    }
    return (
      <Button
        variant="secondary"
        size="sm"
        leftIcon={loggingInProviderId === deviceLogin.id ? undefined : LogIn}
        onPress={handleDeviceLogin}
        disabled={Boolean(loggingInProviderId || loggingOutProviderId || loginFlowActive)}
        testID={`omp-login-provider-${deviceLogin.id}`}
      >
        {loggingInProviderId === deviceLogin.id
          ? t("settings.providers.omp.provider.starting")
          : t(
              login.authenticated
                ? "settings.providers.omp.provider.codexDeviceAddAccount"
                : "settings.providers.omp.provider.codexDeviceSignIn",
            )}
      </Button>
    );
  }

  function renderLogoutAction(): ReactElement | null {
    if (!login?.authenticated || !onLogout) {
      return null;
    }
    return (
      <Button
        variant="destructive"
        size="sm"
        leftIcon={loggingOutAll ? undefined : LogOut}
        onPress={onLogout}
        disabled={Boolean(loggingInProviderId || loggingOutProviderId)}
        testID={`omp-logout-provider-${login.id}`}
      >
        {loggingOutAll
          ? t("settings.providers.omp.provider.signingOut")
          : t(
              accounts.length > 1
                ? "settings.providers.omp.multiAccount.signOutAll"
                : "settings.providers.omp.provider.signOut",
            )}
      </Button>
    );
  }

  function renderEditAction(): ReactElement | null {
    if (!onEdit) {
      return null;
    }
    return (
      <Button
        variant="secondary"
        size="sm"
        leftIcon={Pencil}
        onPress={onEdit}
        disabled={Boolean(removingProviderId)}
        testID={`omp-edit-provider-${summary.id}`}
      >
        {t("settings.providers.omp.custom.editProvider")}
      </Button>
    );
  }

  function renderRemoveAction(): ReactElement | null {
    if (!onRemove) {
      return null;
    }
    return (
      <Button
        variant="secondary"
        size="sm"
        leftIcon={removingProviderId === summary.id ? undefined : Trash2}
        onPress={onRemove}
        disabled={Boolean(removingProviderId)}
        testID={`omp-remove-provider-${summary.id}`}
      >
        {removingProviderId === summary.id
          ? t("settings.providers.omp.custom.removingProvider")
          : t("settings.providers.omp.custom.removeProvider")}
      </Button>
    );
  }

  return (
    <View style={connectionStyles.actions}>
      {renderConfigureModelsAction()}
      {renderLoginAction()}
      {deviceAvailable && browserAvailable ? (
        <Button
          variant="ghost"
          size="sm"
          leftIcon={showDeviceCode ? ChevronUp : ChevronDown}
          accessibilityState={showDeviceCode ? EXPANDED_STATE : COLLAPSED_STATE}
          onPress={toggleDeviceCode}
          testID={`omp-provider-device-fallback-${summary.id}`}
        >
          {t("settings.providers.omp.connections.deviceFallback")}
        </Button>
      ) : null}
      {!browserAvailable || showDeviceCode ? renderDeviceCodeLoginAction() : null}
      {onApiKey ? (
        <Button variant="secondary" size="sm" onPress={handleApiKey} testID={`omp-provider-api-key-${summary.id}`}>
          {t("settings.providers.omp.connections.apiKey")}
        </Button>
      ) : null}
      {login?.available && !browserAvailable && !deviceAvailable ? (
        <Text style={sheetStyles.mutedText}>{t("settings.providers.omp.connections.terminalLogin")}</Text>
      ) : null}
      {renderLogoutAction()}
      {renderEditAction()}
      {renderRemoveAction()}
    </View>
  );
}

function OmpProviderAccountListItem({
  account,
  index,
  credentialIds,
  loginId,
  note,
  editing,
  noteDraft,
  saving,
  loggingOut,
  disabled,
  moving,
  onEditAccountNote,
  onChangeAccountNote,
  onSaveAccountNote,
  onCancelAccountNote,
  onLogoutAccount,
  onReorderAccounts,
}: {
  account: OmpProviderAccount;
  index: number;
  credentialIds: number[];
  loginId?: string;
  note?: string;
  editing: boolean;
  noteDraft: string;
  saving: boolean;
  loggingOut: boolean;
  disabled: boolean;
  moving: boolean;
  onEditAccountNote?: (credentialId: number) => void;
  onChangeAccountNote?: (value: string) => void;
  onSaveAccountNote?: () => void;
  onCancelAccountNote?: () => void;
  onLogoutAccount?: (providerId: string, credentialId: number) => void;
  onReorderAccounts?: (providerId: string, credentialIds: number[]) => void;
}) {
  const handleEdit = useCallback(
    () => onEditAccountNote?.(account.credentialId),
    [account.credentialId, onEditAccountNote],
  );
  const handleChangeNote = useCallback(
    (value: string) => onChangeAccountNote?.(value),
    [onChangeAccountNote],
  );
  const handleSave = useCallback(() => onSaveAccountNote?.(), [onSaveAccountNote]);
  const handleCancel = useCallback(() => onCancelAccountNote?.(), [onCancelAccountNote]);
  const handleLogout = useCallback(() => {
    if (loginId) onLogoutAccount?.(loginId, account.credentialId);
  }, [account.credentialId, loginId, onLogoutAccount]);
  const handleMoveUp = useCallback(() => {
    if (!loginId || index === 0) return;
    const next = [...credentialIds];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    onReorderAccounts?.(loginId, next);
  }, [credentialIds, index, loginId, onReorderAccounts]);
  const handleMoveDown = useCallback(() => {
    if (!loginId || index >= credentialIds.length - 1) return;
    const next = [...credentialIds];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    onReorderAccounts?.(loginId, next);
  }, [credentialIds, index, loginId, onReorderAccounts]);
  return (
    <OmpProviderAccountRow
      account={account}
      index={index}
      note={note}
      editing={editing}
      noteDraft={noteDraft}
      saving={saving}
      loggingOut={loggingOut}
      disabled={disabled}
      canMoveUp={index > 0}
      canMoveDown={index < credentialIds.length - 1}
      moving={moving}
      onEdit={handleEdit}
      onChangeNote={handleChangeNote}
      onSave={handleSave}
      onCancel={handleCancel}
      onMoveUp={handleMoveUp}
      onMoveDown={handleMoveDown}
      onLogout={handleLogout}
    />
  );
}

function OmpProviderAccounts({
  summary,
  accounts,
  loggingInProviderId,
  loggingOutProviderId,
  loggingOutCredentialId,
  reorderingProviderId,
  accountNotesLoading,
  accountNotes,
  editingAccountId,
  accountNoteDraft,
  savingAccountNoteId,
  onEditAccountNote,
  onChangeAccountNote,
  onSaveAccountNote,
  onCancelAccountNote,
  onLogoutAccount,
  onReorderAccounts,
}: {
  summary: OmpProviderSummary;
  accounts: OmpProviderAccount[];
  loggingInProviderId: string | null;
  loggingOutProviderId: string | null;
  loggingOutCredentialId: number | null;
  reorderingProviderId?: string | null;
  accountNotesLoading?: boolean;
  accountNotes: Record<string, string>;
  editingAccountId: number | null;
  accountNoteDraft: string;
  savingAccountNoteId: number | null;
  onEditAccountNote?: (credentialId: number) => void;
  onChangeAccountNote?: (value: string) => void;
  onSaveAccountNote?: () => void;
  onCancelAccountNote?: () => void;
  onLogoutAccount?: (providerId: string, credentialId: number) => void;
  onReorderAccounts?: (providerId: string, credentialIds: number[]) => void;
}) {
  const { t } = useTranslation();
  const credentialIds = useMemo(() => accounts.map((account) => account.credentialId), [accounts]);
  if (accounts.length === 0) {
    return null;
  }
  const disabled = Boolean(
    accountNotesLoading || loggingInProviderId || loggingOutProviderId || reorderingProviderId,
  );
  return (
    <View style={sheetStyles.accountList}>
      {accounts.length > 1 ? (
        <Text style={sheetStyles.mutedText}>
          {t("settings.providers.omp.multiAccount.orderHint")}
        </Text>
      ) : null}
      {accounts.map((account, index) => (
        <OmpProviderAccountListItem
          key={account.credentialId}
          account={account}
          index={index}
          credentialIds={credentialIds}
          loginId={summary.login?.id}
          note={accountNotes[String(account.credentialId)]}
          editing={editingAccountId === account.credentialId}
          noteDraft={accountNoteDraft}
          saving={savingAccountNoteId === account.credentialId}
          loggingOut={loggingOutCredentialId === account.credentialId}
          disabled={disabled}
          moving={reorderingProviderId === summary.id}
          onEditAccountNote={onEditAccountNote}
          onChangeAccountNote={onChangeAccountNote}
          onSaveAccountNote={onSaveAccountNote}
          onCancelAccountNote={onCancelAccountNote}
          onLogoutAccount={onLogoutAccount}
          onReorderAccounts={onReorderAccounts}
        />
      ))}
    </View>
  );
}

function OmpProviderBrand({
  summary,
  caption,
}: {
  summary: OmpProviderSummary;
  caption?: string;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={connectionStyles.brandIdentity}>
      <View style={connectionStyles.brandMark}>
        <ModelProviderBrandIcon brandId={summary.brandId} size={24} color={theme.colors.foreground} />
      </View>
      <View style={connectionStyles.brandText}>
        <Text style={connectionStyles.brandName}>{summary.brand}</Text>
        {caption ? <Text style={sheetStyles.mutedText}>{caption}</Text> : null}
      </View>
    </View>
  );
}

function OmpProviderSummaryIdentity({ summary }: { summary: OmpProviderSummary }) {
  const { t } = useTranslation();
  const { login } = summary;
  const accountCount = login?.accounts?.length ?? 0;
  const modelCount = t(
    summary.modelCount === 1 ? "settings.providers.models.one" : "settings.providers.models.many",
    { count: summary.modelCount },
  );
  let status: string;
  if (login?.authenticated) {
    const keyOnly = login.supportsApiKey &&
      !canStartOmpBrowserLogin(login) &&
      !canStartOmpBrowserLogin(summary.deviceCodeLogin) &&
      accountCount === 0;
    status = t(keyOnly
      ? "settings.providers.omp.connections.keySaved"
      : "settings.providers.omp.provider.signedIn");
  } else {
    status = t(summary.custom
      ? "settings.providers.omp.connections.custom"
      : "settings.providers.omp.connections.modelsDiscovered");
  }
  const accountLabel = accountCount > 0
    ? t(
        accountCount === 1
          ? "settings.providers.omp.multiAccount.countOne"
          : "settings.providers.omp.multiAccount.countMany",
        { count: accountCount },
      )
    : null;
  return (
    <OmpProviderBrand
      summary={summary}
      caption={[summary.name !== summary.brand ? summary.name : null, status, modelCount, accountLabel]
        .filter(Boolean)
        .join(" · ")}
    />
  );
}

function OmpProviderSummaryRow({
  summary,
  serverId,
  onApiKey,
  loggingInProviderId,
  loggingOutProviderId,
  loggingOutCredentialId,
  loginFlowActive,
  removingProviderId,
  reorderingProviderId,
  accountNotes = EMPTY_OMP_ACCOUNT_NOTES,
  accountNotesLoading = false,
  editingAccountId = null,
  accountNoteDraft = "",
  savingAccountNoteId = null,
  onConfigureModels,
  onEdit,
  onLogin,
  onRemove,
  onLogout,
  onLogoutAccount,
  onEditAccountNote,
  onReorderAccounts,
  onChangeAccountNote,
  onSaveAccountNote,
  onCancelAccountNote,
}: OmpProviderSummaryRowProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { login } = summary;
  const accounts = login?.accounts ?? [];
  const loginAction = login ? resolveOmpLoginAction(login) : null;
  const loggingOutAll =
    login !== undefined && loggingOutProviderId === login.id && loggingOutCredentialId === null;
  const handleLogout = useCallback(() => {
    if (login) onLogout?.(login.id);
  }, [login, onLogout]);
  const handleEdit = useCallback(() => {
    onEdit?.(summary.id);
  }, [onEdit, summary.id]);
  const handleRemove = useCallback(() => {
    onRemove?.(summary.id);
  }, [onRemove, summary.id]);
  const handleConfigureModels = useCallback(() => {
    onConfigureModels?.(summary.id);
  }, [onConfigureModels, summary.id]);
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);
  const openUsage = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(serverId, "usage"));
  }, [serverId]);
  return (
    <View style={connectionStyles.summaryCard} testID={`omp-connected-provider-${summary.id}`}>
      <View style={connectionStyles.summaryHeader}>
        <View style={connectionStyles.summaryBrand}>
          <OmpProviderSummaryIdentity summary={summary} />
        </View>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={expanded ? ChevronUp : ChevronDown}
          accessibilityState={expanded ? EXPANDED_STATE : COLLAPSED_STATE}
          onPress={toggleExpanded}
          testID={`omp-manage-provider-${summary.id}`}
        >
          {t("settings.providers.omp.connections.manage")}
        </Button>
      </View>
      <ModelConnectionChat key={`${serverId}:${summary.id}`} serverId={serverId} providerId={summary.id} />
      {expanded ? (
        <View style={connectionStyles.details}>
          <OmpProviderSummaryActions
            summary={summary}
            login={login}
            loginAction={loginAction}
            loggingInProviderId={loggingInProviderId}
            loggingOutProviderId={loggingOutProviderId}
            loggingOutAll={loggingOutAll}
            loginFlowActive={loginFlowActive}
            removingProviderId={removingProviderId}
            onConfigureModels={onConfigureModels ? handleConfigureModels : undefined}
            onEdit={onEdit ? handleEdit : undefined}
            onRemove={onRemove ? handleRemove : undefined}
            onLogin={onLogin}
            onLogout={onLogout ? handleLogout : undefined}
            onApiKey={onApiKey}
          />
          {accounts.some((account) => account.quota) ? (
            <Button
              variant="ghost"
              size="sm"
              style={connectionStyles.browseButton}
              leftIcon={Gauge}
              onPress={openUsage}
              testID={`omp-provider-usage-${summary.id}`}
            >
              {t("settings.providers.omp.connections.quota")}
            </Button>
          ) : null}
          <OmpProviderAccounts
            summary={summary}
            accounts={accounts}
            loggingInProviderId={loggingInProviderId}
            loggingOutProviderId={loggingOutProviderId}
            loggingOutCredentialId={loggingOutCredentialId}
            reorderingProviderId={reorderingProviderId}
            accountNotesLoading={accountNotesLoading}
            accountNotes={accountNotes}
            editingAccountId={editingAccountId}
            accountNoteDraft={accountNoteDraft}
            savingAccountNoteId={savingAccountNoteId}
            onEditAccountNote={onEditAccountNote}
            onChangeAccountNote={onChangeAccountNote}
            onSaveAccountNote={onSaveAccountNote}
            onCancelAccountNote={onCancelAccountNote}
            onLogoutAccount={onLogoutAccount}
            onReorderAccounts={onReorderAccounts}
          />
        </View>
      ) : null}
    </View>
  );
}
function parseOptionalPositiveInteger(value: string, errorMessage: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(errorMessage);
  }
  return parsed;
}

function OmpModelContextWindowEditor({
  providerId,
  model,
  draft,
  onChange,
}: {
  providerId: string;
  model: OmpManagedProviderModel;
  draft: string;
  onChange: (modelId: string, value: string) => void;
}) {
  const { t } = useTranslation();
  const currentContext =
    model.contextWindow !== undefined
      ? new Intl.NumberFormat().format(model.contextWindow)
      : t("settings.providers.omp.contextWindow.unknown");
  const handleChange = useCallback(
    (value: string) => onChange(model.id, value),
    [model.id, onChange],
  );
  return (
    <View style={sheetStyles.modelEditor}>
      <View style={sheetStyles.modelInputRow}>
        <View style={sheetStyles.modelInputMeta}>
          <Text style={sheetStyles.modelEditorTitle}>{model.name}</Text>
          <Text style={sheetStyles.modelInputHint}>{model.id}</Text>
          <Text style={sheetStyles.modelInputHint}>
            {t(
              model.contextWindowOverride !== undefined
                ? "settings.providers.omp.contextWindow.currentOverride"
                : "settings.providers.omp.contextWindow.currentDefault",
              { count: currentContext },
            )}
          </Text>
        </View>
        <AdaptiveTextInput
          initialValue={draft}
          resetKey={`${providerId}:${model.id}:${model.contextWindowOverride ?? "default"}`}
          onChangeText={handleChange}
          placeholder={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
          inputMode="numeric"
          accessibilityLabel={t("settings.providers.omp.contextWindow.inputAccessibility", {
            model: model.name,
          })}
          style={[sheetStyles.formInput, sheetStyles.contextWindowInput]}
        />
      </View>
    </View>
  );
}

function OmpModelContextWindowForm({
  providerId,
  models,
  saving,
  onSave,
  onCancel,
}: {
  providerId: string;
  models: OmpManagedProviderModel[];
  saving: boolean;
  onSave: (providerId: string, overrides: Readonly<Record<string, number | null>>) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      models.map((model) => [
        model.id,
        model.contextWindowOverride !== undefined ? String(model.contextWindowOverride) : "",
      ]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const updateDraft = useCallback((modelId: string, value: string) => {
    setDrafts((current) => ({ ...current, [modelId]: value }));
  }, []);
  const handleSave = useCallback(async () => {
    try {
      const overrides = Object.fromEntries(
        models.map((model) => [
          model.id,
          parseOptionalPositiveInteger(
            drafts[model.id] ?? "",
            t("settings.providers.omp.contextWindow.positiveInteger"),
          ) ?? null,
        ]),
      );
      setError(null);
      await onSave(providerId, overrides);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  }, [drafts, models, onSave, providerId, t]);
  return (
    <View style={sheetStyles.formGroup}>
      <Text style={sheetStyles.mutedText}>
        {t("settings.providers.omp.contextWindow.description")}
      </Text>
      <View style={sheetStyles.modelList}>
        {models.map((model) => (
          <OmpModelContextWindowEditor
            key={model.id}
            providerId={providerId}
            model={model}
            draft={drafts[model.id] ?? ""}
            onChange={updateDraft}
          />
        ))}
      </View>
      {error ? <Text style={sheetStyles.errorText}>{error}</Text> : null}
      <View style={sheetStyles.formActions}>
        <Button variant="secondary" size="sm" onPress={onCancel} disabled={saving}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          leftIcon={saving ? undefined : Save}
          onPress={handleSave}
          disabled={saving}
        >
          {saving
            ? t("settings.providers.omp.contextWindow.saving")
            : t("settings.providers.omp.contextWindow.save")}
        </Button>
      </View>
    </View>
  );
}

function OmpApiMenuItem({
  api,
  selected,
  onSelect,
}: {
  api: OmpProviderApi;
  selected: boolean;
  onSelect: (api: OmpProviderApi) => void;
}) {
  const handleSelect = useCallback(() => onSelect(api), [api, onSelect]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {api}
    </DropdownMenuItem>
  );
}

function OmpApiFormatSelect({
  value,
  onChange,
  disabled,
}: {
  value?: OmpProviderApi;
  onChange: (api: OmpProviderApi) => void;
  disabled: boolean;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const label = value ?? t("settings.providers.omp.gatewayForm.chooseFormat");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={sheetStyles.apiSelectTrigger}
        accessibilityRole="button"
        disabled={disabled}
        accessibilityLabel={t("settings.providers.omp.custom.apiFormatAccessibility", {
          format: label,
        })}
      >
        <Text style={sheetStyles.apiSelectText}>{label}</Text>
        <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" width={280}>
        {OMP_PROVIDER_APIS.map((api) => (
          <OmpApiMenuItem key={api} api={api} selected={api === value} onSelect={onChange} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OmpProviderModelEditor({
  model,
  revision,
  canRemove,
  onChange,
  advanced,
  disabled,
  onRemove,
}: {
  model: OmpProviderModelDraft;
  revision: number;
  canRemove: boolean;
  advanced: boolean;
  disabled: boolean;
  onChange: (key: string, patch: Partial<OmpProviderModelDraft>) => void;
  onRemove: (key: string) => void;
}) {
  const { t } = useTranslation();
  const updateId = useCallback((id: string) => onChange(model.key, { id }), [model.key, onChange]);
  const updateName = useCallback(
    (name: string) => onChange(model.key, { name }),
    [model.key, onChange],
  );
  const updateApi = useCallback(
    (api: OmpProviderApi) => onChange(model.key, { api }),
    [model.key, onChange],
  );
  const updateContextWindow = useCallback(
    (contextWindow: string) => onChange(model.key, { contextWindow }),
    [model.key, onChange],
  );
  const updateMaxTokens = useCallback(
    (maxTokens: string) => onChange(model.key, { maxTokens }),
    [model.key, onChange],
  );
  const updateSupportsImages = useCallback(
    (supportsImages: boolean) => onChange(model.key, { supportsImages }),
    [model.key, onChange],
  );
  const handleRemove = useCallback(() => onRemove(model.key), [model.key, onRemove]);
  return (
    <View style={sheetStyles.modelEditor}>
      <View style={sheetStyles.modelEditorHeader}>
        <Text style={sheetStyles.modelEditorTitle}>{t("settings.providers.omp.custom.model")}</Text>
        {canRemove ? (
          <Button
            variant="secondary"
            size="sm"
            leftIcon={Trash2}
            disabled={disabled}
            onPress={handleRemove}
            accessibilityLabel={t("settings.providers.omp.custom.removeModel", {
              model: model.id || model.key,
            })}
          >
            {t("settings.providers.omp.custom.remove")}
          </Button>
        ) : null}
      </View>
      <Text style={sheetStyles.formLabel}>{t("settings.providers.omp.custom.modelId")}</Text>
      <AdaptiveTextInput
        initialValue={model.id}
        resetKey={`${revision}-${model.key}-id`}
        onChangeText={updateId}
        accessibilityLabel={t("settings.providers.omp.custom.modelId")}
        editable={!disabled}
        testID={`omp-gateway-model-id-${model.key}`}
        placeholder="gpt-5.4"
        autoCapitalize="none"
        autoCorrect={false}
        style={sheetStyles.formInput}
      />
      <Text style={sheetStyles.formLabel}>{t("settings.providers.omp.custom.apiFormat")}</Text>
      <OmpApiFormatSelect value={model.api} onChange={updateApi} disabled={disabled} />
      {advanced ? (
        <>
          <Text style={sheetStyles.formLabel}>{t("settings.providers.omp.custom.displayName")}</Text>
          <AdaptiveTextInput
            accessibilityLabel={t("settings.providers.omp.custom.displayName")}
            editable={!disabled}
            initialValue={model.name}
            resetKey={`${revision}-${model.key}-name`}
            onChangeText={updateName}
            placeholder="GPT-5.4"
            style={sheetStyles.formInput}
          />
          <View style={sheetStyles.formColumns}>
            <View style={sheetStyles.formColumn}>
              <Text style={sheetStyles.formLabel}>
                {t("settings.providers.omp.custom.contextWindow")}
              </Text>
              <AdaptiveTextInput
                accessibilityLabel={t("settings.providers.omp.custom.contextWindow")}
                editable={!disabled}
                initialValue={model.contextWindow}
                resetKey={`${revision}-${model.key}-context`}
                onChangeText={updateContextWindow}
                placeholder="128000"
                inputMode="numeric"
                style={sheetStyles.formInput}
              />
            </View>
            <View style={sheetStyles.formColumn}>
              <Text style={sheetStyles.formLabel}>
                {t("settings.providers.omp.custom.maxOutputTokens")}
              </Text>
              <AdaptiveTextInput
                accessibilityLabel={t("settings.providers.omp.custom.maxOutputTokens")}
                editable={!disabled}
                initialValue={model.maxTokens}
                resetKey={`${revision}-${model.key}-max`}
                onChangeText={updateMaxTokens}
                placeholder="16384"
                inputMode="numeric"
                style={sheetStyles.formInput}
              />
            </View>
          </View>
          <View style={sheetStyles.modelInputRow}>
            <View style={sheetStyles.modelInputMeta}>
              <Text style={sheetStyles.formLabel}>
                {t("settings.providers.omp.custom.imageInput")}
              </Text>
              <Text style={sheetStyles.modelInputHint}>
                {t("settings.providers.omp.custom.imageInputHint")}
              </Text>
            </View>
            <Switch
              disabled={disabled}
              value={model.supportsImages}
              onValueChange={updateSupportsImages}
              accessibilityLabel={t("settings.providers.omp.custom.imageInputAccessibility", {
                model: model.name.trim() || model.id.trim() || model.key,
              })}
              testID={`omp-model-image-input-${model.key}`}
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

type OmpManagementClient = NonNullable<ReturnType<typeof useHostRuntimeClient>>;

function parseGatewayUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function OmpProviderForm({
  client,
  initialDraft,
  editingProviderId,
  configYaml,
  onSaved,
  onCancel,
}: {
  client: OmpManagementClient;
  initialDraft?: OmpProviderDraft;
  editingProviderId?: string;
  configYaml?: string;
  onSaved: (management: OmpProviderManagement) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const nextModelKey = useRef(initialDraft?.models.length ?? 1);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<OmpProviderDraft>(() =>
    initialDraft
      ? { ...initialDraft, models: initialDraft.models.map((model) => ({ ...model })) }
      : createEmptyProviderDraft("model-0"),
  );
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryFailed, setDiscoveryFailed] = useState(false);
  const [manual, setManual] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [endpointTouched, setEndpointTouched] = useState(false);
  const [undetectedApis, setUndetectedApis] = useState<ReadonlySet<string> | null>(null);
  const endpoint = parseGatewayUrl(draft.baseUrl);
  const canDiscover = endpoint !== null && draft.apiKey.trim().length > 0;
  const busy = discovering || adding;
  const modelCount = draft.models.filter((model) => model.id.trim()).length;
  const needsFormat = draft.models.some((model) => undetectedApis?.has(model.key));
  const canAdd =
    canDiscover && modelCount > 0 && modelCount === draft.models.length && !needsFormat;
  const touchEndpoint = useCallback(() => setEndpointTouched(true), []);
  const toggleManual = useCallback(() => setManual((current) => !current), []);
  const toggleAdvanced = useCallback(() => setAdvanced((current) => !current), []);
  const updateUndetectedApi = useCallback(
    (api: OmpProviderApi) => {
      if (!undetectedApis) return;
      setDraft((current) => ({
        ...current,
        models: current.models.map((model) =>
          undetectedApis.has(model.key) ? { ...model, api } : model,
        ),
      }));
      setUndetectedApis(null);
    },
    [undetectedApis],
  );
  const updateName = useCallback(
    (name: string) => setDraft((current) => ({ ...current, name })),
    [],
  );
  const updateBaseUrl = useCallback((baseUrl: string) => {
    setDiscoveryFailed(false);
    setDraft((current) => ({ ...current, baseUrl }));
  }, []);
  const updateApiKey = useCallback((apiKey: string) => {
    setDiscoveryFailed(false);
    setDraft((current) => ({ ...current, apiKey }));
  }, []);
  const updateModel = useCallback((key: string, patch: Partial<OmpProviderModelDraft>) => {
    if (patch.api) {
      setUndetectedApis((current) =>
        current?.has(key) ? new Set([...current].filter((modelKey) => modelKey !== key)) : current,
      );
    }
    setDraft((current) => ({
      ...current,
      models: current.models.map((model) => (model.key === key ? { ...model, ...patch } : model)),
    }));
  }, []);
  const removeModel = useCallback((key: string) => {
    setDraft((current) => ({
      ...current,
      models: current.models.filter((model) => model.key !== key),
    }));
  }, []);
  const addModel = useCallback(() => {
    const key = `model-${nextModelKey.current}`;
    nextModelKey.current += 1;
    setDraft((current) => ({
      ...current,
      models: [
        ...current.models,
        {
          key,
          id: "",
          name: "",
          api: current.models[0]?.api ?? "openai-responses",
          contextWindow: "",
          maxTokens: "",
          supportsImages: false,
        },
      ],
    }));
  }, []);
  const enableImageInputForAll = useCallback(() => {
    setDraft((current) => ({
      ...current,
      models: current.models.map((model) => ({ ...model, supportsImages: true })),
    }));
  }, []);
  const hasTextOnlyModels = draft.models.some(
    (model) => model.id.trim().length > 0 && !model.supportsImages,
  );
  const discoverModels = useCallback(async () => {
    if (!canDiscover || busy) return;
    setDiscovering(true);
    setDiscoveryFailed(false);
    setError(null);
    try {
      const { models } = await client.discoverOmpProviderModels({
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim(),
      });
      if (models.length === 0) {
        setDiscoveryFailed(true);
        setManual(true);
        return;
      }
      const configured = configureDiscoveredProviderModels(draft.models, models, () => {
        const key = `model-${nextModelKey.current}`;
        nextModelKey.current += 1;
        return key;
      });
      // A gateway's list can be filtered by key. Keep existing, explicitly configured IDs on edit.
      const discoveredIds = new Set(configured.map((model) => model.id));
      const retained = editingProviderId
        ? draft.models.filter((model) => model.id.trim() && !discoveredIds.has(model.id.trim()))
        : [];
      const existingKeys = new Set(draft.models.map((model) => model.key));
      const modelKeys = new Set(
        configured.flatMap((model, index) =>
          (!existingKeys.has(model.key) || undetectedApis?.has(model.key)) &&
          !models[index]?.supportedApis?.length
            ? [model.key]
            : [],
        ),
      );
      setUndetectedApis(modelKeys.size > 0 ? modelKeys : null);
      setDraft((current) => ({ ...current, models: [...configured, ...retained] }));
      setRevision((current) => current + 1);
      setManual(false);
    } catch {
      setDiscoveryFailed(true);
      setManual(true);
    } finally {
      setDiscovering(false);
    }
  }, [
    busy,
    canDiscover,
    client,
    draft.apiKey,
    draft.baseUrl,
    draft.models,
    editingProviderId,
    undetectedApis,
  ]);
  const handleDiscoverModelsPress = useCallback(() => void discoverModels(), [discoverModels]);

  const addProvider = useCallback(async () => {
    if (!canAdd || busy || endpoint === null) return;
    setAdding(true);
    setError(null);
    try {
      const provider = customProviderDraftToInput(
        {
          ...draft,
          name: draft.name.trim() || endpoint.hostname,
          providerId: editingProviderId ?? draft.providerId,
        },
        (value, field) =>
          parseOptionalPositiveInteger(
            value,
            t("settings.providers.omp.custom.positiveInteger", {
              field: t(
                field === "contextWindow"
                  ? "settings.providers.omp.custom.contextWindow"
                  : "settings.providers.omp.custom.maxOutputTokens",
              ),
            }),
          ),
      );
      try {
        const result =
          editingProviderId && configYaml !== undefined
            ? await client.saveOmpProviderConfig(
                updateCustomProviderConfigYaml(configYaml, editingProviderId, provider),
              )
            : await client.addOmpProvider(provider);
        onSaved(result);
      } catch {
        setError(t("settings.providers.omp.gatewayForm.saveFailed"));
      }
    } catch (validationError) {
      setAdvanced(true);
      setError(validationError instanceof Error ? validationError.message : String(validationError));
    } finally {
      setAdding(false);
    }
  }, [busy, canAdd, client, configYaml, draft, editingProviderId, endpoint, onSaved, t]);
  const handleAddPress = useCallback(() => void addProvider(), [addProvider]);
  function getSaveLabel() {
    if (adding) {
      return t(
        editingProviderId
          ? "settings.providers.omp.custom.savingProvider"
          : "settings.providers.omp.custom.validating",
      );
    }
    if (editingProviderId) return t("settings.providers.omp.custom.saveProvider");
    return t("settings.providers.omp.custom.addWithCount", { count: modelCount });
  }

  const manualAccessibilityState = useMemo(() => ({ expanded: manual }), [manual]);
  const advancedAccessibilityState = useMemo(() => ({ expanded: advanced }), [advanced]);

  function renderDiscoveryStatus() {
    if (discoveryFailed) {
      return (
        <Text accessibilityRole="alert" style={sheetStyles.errorText}>
          {t("settings.providers.omp.gatewayForm.discoveryFailed")}
        </Text>
      );
    }
    if (modelCount > 0) {
      return (
        <Text accessibilityLiveRegion="polite" style={sheetStyles.mutedText}>
          {t("settings.providers.omp.gatewayForm.modelsReady", { count: modelCount })}
        </Text>
      );
    }
    if (manual || advanced) return null;
    return (
      <Text style={sheetStyles.mutedText}>
        {t("settings.providers.omp.gatewayForm.discoverHint")}
      </Text>
    );
  }

  function renderModelSetup() {
    return (
      <View style={sheetStyles.modelList}>
        <Text style={sheetStyles.formLabel}>{t("settings.providers.omp.gatewayForm.modelSetup")}</Text>
        {renderDiscoveryStatus()}
        <View style={sheetStyles.modelListActions}>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={discovering ? undefined : RotateCw}
            onPress={handleDiscoverModelsPress}
            disabled={!canDiscover || busy}
            testID="omp-gateway-fetch-models"
          >
            {t(
              discovering
                ? "settings.providers.omp.custom.fetchingModels"
                : "settings.providers.omp.custom.fetchModels",
            )}
          </Button>
          {!advanced ? (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={manual ? ChevronDown : ChevronRight}
              onPress={toggleManual}
              disabled={busy}
              accessibilityState={manualAccessibilityState}
              testID="omp-gateway-manual"
            >
              {t(
                modelCount === 0
                  ? "settings.providers.omp.gatewayForm.manual"
                  : "settings.providers.omp.gatewayForm.editModels",
              )}
            </Button>
          ) : null}
        </View>
        {needsFormat ? (
          <>
            <Text style={sheetStyles.formLabel}>{t("settings.providers.omp.custom.apiFormat")}</Text>
            <Text style={sheetStyles.mutedText}>
              {t("settings.providers.omp.gatewayForm.undetectedFormat")}
            </Text>
            <OmpApiFormatSelect disabled={busy} onChange={updateUndetectedApi} />
          </>
        ) : null}
        <View style={sheetStyles.modelListActions}>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={advanced ? ChevronDown : ChevronRight}
            onPress={toggleAdvanced}
            disabled={busy}
            accessibilityState={advancedAccessibilityState}
            testID="omp-gateway-advanced"
          >
            {t("settings.providers.omp.gatewayForm.advanced")}
          </Button>
        </View>
        {manual || advanced ? (
          <>
            {modelCount === 0 && !discoveryFailed ? (
              <Text style={sheetStyles.mutedText}>
                {t("settings.providers.omp.gatewayForm.manualHint")}
              </Text>
            ) : null}
            <Text style={sheetStyles.mutedText}>
              {t("settings.providers.omp.gatewayForm.apiFormatHint")}
            </Text>
            {advanced && hasTextOnlyModels ? (
              <View style={sheetStyles.modelListActions}>
                <Button variant="secondary" size="sm" onPress={enableImageInputForAll} disabled={busy}>
                  {t("settings.providers.omp.custom.enableImageInputForAll")}
                </Button>
              </View>
            ) : null}
            {draft.models.map((model) => (
              <OmpProviderModelEditor
                key={model.key}
                model={model}
                revision={revision}
                canRemove={draft.models.length > 1}
                advanced={advanced}
                disabled={busy}
                onChange={updateModel}
                onRemove={removeModel}
              />
            ))}
            <View style={sheetStyles.modelListActions}>
              <Button variant="secondary" size="sm" leftIcon={Plus} onPress={addModel} disabled={busy}>
                {t("settings.providers.omp.custom.addAnotherModel")}
              </Button>
            </View>
          </>
        ) : null}
      </View>
    );
  }

  return (
    <View style={sheetStyles.formGroup}>
      {editingProviderId || advanced ? (
        <View style={sheetStyles.modelList}>
          <Text style={sheetStyles.formLabel}>
            {t("settings.providers.omp.custom.providerName")}
          </Text>
          <AdaptiveTextInput
            initialValue={draft.name}
            onChangeText={updateName}
            placeholder={endpoint?.hostname || t("settings.providers.omp.custom.providerNamePlaceholder")}
            accessibilityLabel={t("settings.providers.omp.custom.providerName")}
            testID="omp-provider-name"
            editable={!busy}
            autoCorrect={false}
            style={sheetStyles.formInput}
          />
          {editingProviderId && advanced ? (
            <Text selectable style={sheetStyles.mutedText} testID="omp-provider-stable-id">
              {t("settings.providers.omp.custom.stableId", { id: editingProviderId })}
            </Text>
          ) : null}
        </View>
      ) : null}
      <View style={sheetStyles.modelList}>
        <Text style={sheetStyles.formLabel}>{t("settings.providers.omp.custom.endpointUrl")}</Text>
        <AdaptiveTextInput
          accessibilityLabel={t("settings.providers.omp.custom.endpointUrl")}
          initialValue={draft.baseUrl}
          onBlur={touchEndpoint}
          onChangeText={updateBaseUrl}
          placeholder="https://api.example.com/v1"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          inputMode="url"
          style={sheetStyles.formInput}
          testID="omp-gateway-endpoint"
        />
        {endpointTouched && draft.baseUrl.trim() && !endpoint ? (
          <Text accessibilityRole="alert" style={sheetStyles.errorText}>
            {t("settings.providers.omp.gatewayForm.invalidEndpoint")}
          </Text>
        ) : (
          <Text style={sheetStyles.mutedText}>
            {t("settings.providers.omp.gatewayForm.endpointHint")}
          </Text>
        )}
      </View>
      <View style={sheetStyles.modelList}>
        <Text style={sheetStyles.formLabel}>{t("settings.providers.omp.custom.apiKey")}</Text>
        <AdaptiveTextInput
          accessibilityLabel={t("settings.providers.omp.custom.apiKey")}
          initialValue={draft.apiKey}
          onChangeText={updateApiKey}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          editable={!busy}
          secureTextEntry
          spellCheck={false}
          style={sheetStyles.formInput}
          testID="omp-gateway-api-key"
        />
      </View>
      {renderModelSetup()}
      {error ? <Text accessibilityRole="alert" style={sheetStyles.errorText}>{error}</Text> : null}
      <View style={sheetStyles.formActions}>
        <Button variant="secondary" size="sm" onPress={onCancel} disabled={adding}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          leftIcon={adding ? undefined : Plus}
          onPress={handleAddPress}
          disabled={!canAdd || busy}
        >
          {getSaveLabel()}
        </Button>
      </View>
    </View>
  );
}
interface OmpProviderLoginFlowState {
  flowId: string;
  providerId: string;
  url: string;
  launchUrl?: string;
  instructions?: string;
}

function OmpAdvancedYaml({
  management,
  configYaml,
  saving,
  onConfigYamlChange,
  onSave,
}: {
  management: OmpProviderManagement;
  configYaml: string;
  saving: boolean;
  onConfigYamlChange: (configYaml: string) => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);
  return (
    <View style={connectionStyles.section}>
      <CollapsibleSectionHeader
        title={t("settings.providers.omp.yaml.title")}
        expanded={expanded}
        onPress={toggleExpanded}
        testID="omp-models-yaml-toggle"
      />
      {expanded ? (
        <View style={connectionStyles.section}>
          <Text style={sheetStyles.mutedText} selectable>{management.configPath}</Text>
          <SettingsTextArea
            key={`${management.configPath}:${management.configYaml}`}
            accessibilityLabel={t("settings.providers.omp.yaml.accessibility")}
            value={configYaml}
            onChangeText={onConfigYamlChange}
            testID="omp-models-yaml"
            style={sheetStyles.yamlInput}
          />
          <View style={sheetStyles.advancedActions}>
            <Text style={sheetStyles.descriptionInline}>{t("settings.providers.omp.yaml.hint")}</Text>
            <Button
              variant="default"
              size="sm"
              leftIcon={saving ? undefined : Save}
              onPress={onSave}
              disabled={saving || configYaml === management.configYaml}
            >
              {saving
                ? t("settings.providers.omp.yaml.saving")
                : t("settings.providers.omp.yaml.save")}
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function OmpDirectoryBrandTrigger({
  summary,
  expanded,
  onToggle,
}: {
  summary: OmpProviderSummary;
  expanded: boolean;
  onToggle: (brandId: string) => void;
}) {
  const { theme } = useUnistyles();
  const brandId = summary.brandId;
  const toggle = useCallback(() => onToggle(brandId), [brandId, onToggle]);
  const Chevron = expanded ? ChevronUp : ChevronRight;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={expanded ? EXPANDED_STATE : COLLAPSED_STATE}
      onPress={toggle}
      style={connectionStyles.directoryTrigger}
      testID={`omp-directory-brand-${brandId}`}
    >
      <View style={connectionStyles.directoryIdentity}>
        <OmpProviderBrand summary={summary} caption={summary.product} />
      </View>
      <Chevron size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

function gatewayEntryStyle({ hovered, pressed }: PressableStateCallbackType) {
  return [connectionStyles.gateway, (hovered || pressed) && connectionStyles.gatewayActive];
}

function OmpManagementPanel({
  serverId,
  visible,
  onSaved,
}: {
  serverId: string;
  visible: boolean;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const managementQueryKey = useMemo(() => ompProviderManagementQueryKey(serverId), [serverId]);
  const cachedManagement =
    queryClient.getQueryData<OmpProviderManagement>(managementQueryKey) ?? null;
  const {
    notes: accountNotes,
    save: saveAccountNotes,
    migrationError: accountNotesMigrationError,
    loading: accountNotesLoading,
  } = useOmpProviderAccountNotes(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.ompProviderManagement === true,
  );
  const [management, setManagement] = useState<OmpProviderManagement | null>(cachedManagement);
  const [configYaml, setConfigYaml] = useState(cachedManagement?.configYaml ?? "");
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [showAllProviders, setShowAllProviders] = useState(false);
  const [selectedBrandId, setSelectedBrandId] = useState<string | null>(null);
  const [providerSearchQuery, setProviderSearchQuery] = useState("");
  const [signedInProvidersExpanded, setSignedInProvidersExpanded] = useState(true);
  const [compactColumns, setCompactColumns] = useState(true);
  const [apiKeyProvider, setApiKeyProvider] = useState<OmpProviderSummary | null>(null);
  const apiKeySupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.ompProviderApiKey === true,
  );
  const [editingProvider, setEditingProvider] = useState<{
    id: string;
    draft: OmpProviderDraft;
  } | null>(null);
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const [contextProviderId, setContextProviderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loginProviderId, setLoginProviderId] = useState<string | null>(null);
  const [removingProviderId, setRemovingProviderId] = useState<string | null>(null);
  const [reorderingProviderId, setReorderingProviderId] = useState<string | null>(null);
  const [logoutProviderId, setLogoutProviderId] = useState<string | null>(null);
  const [logoutCredentialId, setLogoutCredentialId] = useState<number | null>(null);
  const [loginFlow, setLoginFlow] = useState<OmpProviderLoginFlowState | null>(null);
  const [loginInput, setLoginInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editingAccountId, setEditingAccountId] = useState<number | null>(null);
  const [accountNoteDraft, setAccountNoteDraft] = useState("");
  const [savingAccountNoteId, setSavingAccountNoteId] = useState<number | null>(null);
  const visibleRef = useRef(visible);
  const loginStartPendingRef = useRef(false);
  const completedLoginFlowsRef = useRef(new Set<string>());
  const cancellingLoginFlowIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const clientRef = useRef(client);
  const loginFlowRef = useRef(loginFlow);
  clientRef.current = client;
  loginFlowRef.current = loginFlow;
  visibleRef.current = visible;

  const closeDirectory = useCallback(() => {
    setDirectoryOpen(false);
    setShowAllProviders(false);
    setSelectedBrandId(null);
    setProviderSearchQuery("");
  }, []);

  const showManagement = useCallback((result: OmpProviderManagement) => {
    setManagement(result);
    setConfigYaml(result.configYaml);
  }, []);
  useEffect(() => {
    if (!client) return;
    return client.on("omp.provider.login.completed", ({ payload }) => {
      void queryClient.invalidateQueries({ queryKey: [PROVIDER_USAGE_QUERY_PREFIX, serverId] });
      if (loginStartPendingRef.current) completedLoginFlowsRef.current.add(payload.flowId);
      if (loginFlowRef.current?.flowId !== payload.flowId) return;
      loginFlowRef.current = null;
      setLoginFlow(null);
      setLoginInput("");
      setLoginProviderId(null);
      setError(null);
      closeDirectory();
      onSaved();
    });
  }, [client, closeDirectory, onSaved, queryClient, serverId]);
  useEffect(() => {
    if (!visible) return;
    return queryClient.getQueryCache().subscribe((event) => {
      if (
        event.query.queryKey[0] !== "ompProviderManagement" ||
        event.query.queryKey[1] !== serverId
      )
        return;
      const data = event.query.state.data as OmpProviderManagement | undefined;
      if (data && event.type === "updated" && event.action.type === "success") showManagement(data);
    });
  }, [queryClient, serverId, showManagement, visible]);
  const storeManagement = useCallback(
    (result: OmpProviderManagement) => {
      queryClient.setQueryData(managementQueryKey, result);
      showManagement(result);
    },
    [managementQueryKey, queryClient, showManagement],
  );
  const applyManagement = useCallback(
    (result: OmpProviderManagement) => {
      storeManagement(result);
      void queryClient.invalidateQueries({ queryKey: [PROVIDER_USAGE_QUERY_PREFIX, serverId] });
      onSaved();
    },
    [onSaved, queryClient, serverId, storeManagement],
  );
  const load = useCallback(
    async (force = false) => {
      if (!client || !supported) return;
      const cachedState = queryClient.getQueryState<OmpProviderManagement>(managementQueryKey);
      if (cachedState?.data) showManagement(cachedState.data);
      if (
        !force &&
        cachedState?.data &&
        Date.now() - cachedState.dataUpdatedAt < ompProviderManagementStaleTime(cachedState.data)
      ) {
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        await (force
          ? refreshOmpAccountQuotaManagement(queryClient, client, serverId)
          : queryClient.fetchQuery({
              queryKey: managementQueryKey,
              queryFn: () => fetchOmpAccountQuotaManagement(client),
              staleTime: ompProviderManagementStaleTime(cachedState?.data),
              gcTime: OMP_PROVIDER_MANAGEMENT_GC_TIME_MS,
            }));
        if (force) onSaved();
      } catch (loadError) {
        if (isCancelledError(loadError)) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        setLoading(false);
      }
    },
    [client, managementQueryKey, onSaved, queryClient, serverId, showManagement, supported],
  );
  const cancelLoginFlow = useCallback(
    async (flow: OmpProviderLoginFlowState) => {
      if (!client || cancellingLoginFlowIdRef.current === flow.flowId) return;
      cancellingLoginFlowIdRef.current = flow.flowId;
      if (mountedRef.current) setLoginProviderId(flow.providerId);
      try {
        await client.cancelOmpProviderLogin(flow.flowId);
        if (loginFlowRef.current?.flowId === flow.flowId) loginFlowRef.current = null;
        if (mountedRef.current) {
          setLoginFlow((current) => (current?.flowId === flow.flowId ? null : current));
          setLoginInput("");
        }
      } catch (cancelError) {
        if (mountedRef.current) {
          setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
        }
      } finally {
        if (cancellingLoginFlowIdRef.current === flow.flowId) {
          cancellingLoginFlowIdRef.current = null;
          if (mountedRef.current) {
            setLoginProviderId((current) => (current === flow.providerId ? null : current));
          }
        }
      }
    },
    [client],
  );
  useEffect(
    () => () => {
      mountedRef.current = false;
      visibleRef.current = false;
      const flow = loginFlowRef.current;
      const runtimeClient = clientRef.current;
      if (!flow || !runtimeClient || cancellingLoginFlowIdRef.current === flow.flowId) return;
      cancellingLoginFlowIdRef.current = flow.flowId;
      void runtimeClient.cancelOmpProviderLogin(flow.flowId).catch(() => undefined);
    },
    [],
  );
  useEffect(() => {
    if (visible) void load();
  }, [load, visible]);
  useEffect(() => {
    if (visible) return;
    if (loginFlow) void cancelLoginFlow(loginFlow);
    setManagement(null);
    setDirectoryOpen(false);
    setShowAllProviders(false);
    setSelectedBrandId(null);
    setApiKeyProvider(null);
    setProviderSearchQuery("");
    setAddProviderOpen(false);
    setSignedInProvidersExpanded(true);
    setContextProviderId(null);
    setEditingProvider(null);
    setError(null);
  }, [cancelLoginFlow, loginFlow, visible]);
  useEffect(() => {
    if (visible && accountNotesMigrationError) {
      setError(accountNotesMigrationError.message);
    }
  }, [accountNotesMigrationError, visible]);
  const save = useCallback(async () => {
    if (!client) return;
    setSaving(true);
    setError(null);
    try {
      applyManagement(await client.saveOmpProviderConfig(configYaml));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }, [applyManagement, client, configYaml]);
  const saveContextWindowConfig = useCallback(
    async (providerId: string, overrides: Readonly<Record<string, number | null>>) => {
      if (!client) return;
      setSaving(true);
      setError(null);
      try {
        applyManagement(await client.updateOmpModelContextWindowOverrides(providerId, overrides));
        setContextProviderId(null);
      } catch (saveError) {
        const message = saveError instanceof Error ? saveError.message : String(saveError);
        setError(message);
        throw saveError;
      } finally {
        setSaving(false);
      }
    },
    [applyManagement, client],
  );
  const startLogin = useCallback(
    async (providerId: string) => {
      if (!client || loginFlow || loginStartPendingRef.current) return;
      loginStartPendingRef.current = true;
      setLoginProviderId(providerId);
      setError(null);
      try {
        const flow = await client.startOmpProviderLogin(providerId);
        if (completedLoginFlowsRef.current.has(flow.flowId)) {
          if (visibleRef.current) {
            closeDirectory();
            onSaved();
          }
          return;
        }
        const nextFlow: OmpProviderLoginFlowState = {
          flowId: flow.flowId,
          providerId: flow.providerId,
          url: flow.url,
          ...(flow.launchUrl ? { launchUrl: flow.launchUrl } : {}),
          ...(flow.instructions ? { instructions: flow.instructions } : {}),
        };
        loginFlowRef.current = nextFlow;
        if (!visibleRef.current) {
          if (mountedRef.current) setLoginFlow(nextFlow);
          await cancelLoginFlow(nextFlow);
          return;
        }
        setLoginFlow(nextFlow);
        await openExternalUrl(flow.launchUrl ?? flow.url).catch((openError) => {
          setError(
            t("settings.providers.omp.login.openFailed", {
              error: openError instanceof Error ? openError.message : String(openError),
            }),
          );
        });
      } catch (loginError) {
        setError(loginError instanceof Error ? loginError.message : String(loginError));
      } finally {
        loginStartPendingRef.current = false;
        completedLoginFlowsRef.current.clear();
        setLoginProviderId(null);
      }
    },
    [cancelLoginFlow, client, closeDirectory, loginFlow, onSaved, t],
  );
  const finishLogin = useCallback(async () => {
    if (!client || !loginFlow) return;
    setLoginProviderId(loginFlow.providerId);
    setError(null);
    try {
      applyManagement(await client.finishOmpProviderLogin(loginFlow.flowId, loginInput));
      loginFlowRef.current = null;
      setLoginFlow(null);
      setLoginInput("");
      closeDirectory();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : String(loginError));
    } finally {
      setLoginProviderId(null);
    }
  }, [applyManagement, client, closeDirectory, loginFlow, loginInput]);
  const logout = useCallback(
    async (providerId: string, credentialId?: number) => {
      if (!client) return;
      setLogoutProviderId(providerId);
      setLogoutCredentialId(credentialId ?? null);
      setError(null);
      try {
        applyManagement(
          await client.logoutOmpProvider(
            providerId,
            credentialId === undefined ? undefined : { credentialId },
          ),
        );
      } catch (logoutError) {
        setError(logoutError instanceof Error ? logoutError.message : String(logoutError));
      } finally {
        setLogoutProviderId(null);
        setLogoutCredentialId(null);
      }
    },
    [applyManagement, client],
  );
  const handleLogout = useCallback((providerId: string) => void logout(providerId), [logout]);
  const handleAccountLogout = useCallback(
    (providerId: string, credentialId: number) => void logout(providerId, credentialId),
    [logout],
  );
  const reorderAccounts = useCallback(
    async (providerId: string, credentialIds: number[]) => {
      if (!client) return;
      setReorderingProviderId(providerId);
      setError(null);
      try {
        const result = await client.reorderOmpProviderAccounts(providerId, credentialIds);
        await queryClient.cancelQueries({ queryKey: managementQueryKey, exact: true });
        storeManagement(result);
      } catch (reorderError) {
        setError(reorderError instanceof Error ? reorderError.message : String(reorderError));
      } finally {
        setReorderingProviderId(null);
      }
    },
    [client, managementQueryKey, queryClient, storeManagement],
  );
  const editAccountNote = useCallback(
    (credentialId: number) => {
      setEditingAccountId(credentialId);
      setAccountNoteDraft(accountNotes[String(credentialId)] ?? "");
      setError(null);
    },
    [accountNotes],
  );
  const cancelAccountNote = useCallback(() => {
    setEditingAccountId(null);
    setAccountNoteDraft("");
  }, []);
  const saveAccountNote = useCallback(async () => {
    if (editingAccountId === null) return;
    const nextNotes = updateOmpProviderAccountNote(
      accountNotes,
      editingAccountId,
      accountNoteDraft,
    );
    setSavingAccountNoteId(editingAccountId);
    setError(null);
    try {
      await saveAccountNotes(nextNotes);
      setEditingAccountId(null);
      setAccountNoteDraft("");
    } catch (noteError) {
      setError(noteError instanceof Error ? noteError.message : String(noteError));
    } finally {
      setSavingAccountNoteId(null);
    }
  }, [accountNoteDraft, accountNotes, editingAccountId, saveAccountNotes]);

  const { connected, available, featured } = useMemo(
    () => buildOmpProviderDirectory(management),
    [management],
  );
  const providerSearch = providerSearchQuery.trim();
  const searchResults = useMemo(
    () => providerSearch ? searchOmpProviderDirectory([...available, ...connected], providerSearch) : null,
    [available, connected, providerSearch],
  );
  const displayedDirectory = searchResults?.map(({ provider }) => provider) ??
    (showAllProviders ? available : featured);
  const contextProvider = connected.find((provider) => provider.id === contextProviderId);
  const handleDirectoryLayout = useCallback((event: LayoutChangeEvent) => {
    setCompactColumns(event.nativeEvent.layout.width < 600);
  }, []);
  const closeApiKeyForm = useCallback(() => setApiKeyProvider(null), []);
  const saveBuiltinApiKey = useCallback(async (providerId: string, apiKey: string) => {
    if (!client) throw new Error("Host unavailable");
    applyManagement(await client.setOmpProviderApiKey(providerId, apiKey));
    setApiKeyProvider(null);
    closeDirectory();
  }, [applyManagement, client, closeDirectory]);
  const toggleSignedInProviders = useCallback(
    () => setSignedInProvidersExpanded((expanded) => !expanded),
    [],
  );
  const handleRefreshPress = useCallback(() => void load(true), [load]);
  const handleSavePress = useCallback(() => void save(), [save]);
  const handleFinishLoginPress = useCallback(() => void finishLogin(), [finishLogin]);
  const handleOpenAuthorizationPress = useCallback(() => {
    if (loginFlow) void openExternalUrl(loginFlow.launchUrl ?? loginFlow.url);
  }, [loginFlow]);
  const handleCancelLoginPress = useCallback(() => {
    if (loginFlow) void cancelLoginFlow(loginFlow);
  }, [cancelLoginFlow, loginFlow]);
  const openDirectory = useCallback(() => setDirectoryOpen(true), []);
  const showConnections = useCallback(() => {
    setSignedInProvidersExpanded(true);
    closeDirectory();
  }, [closeDirectory]);
  const toggleBrand = useCallback((brandId: string) => {
    setSelectedBrandId((selected) => (selected === brandId ? null : brandId));
  }, []);
  const handleProviderSearch = useCallback((value: string) => {
    setProviderSearchQuery(value);
    setSelectedBrandId(null);
  }, []);
  const toggleShowAllProviders = useCallback(() => {
    setShowAllProviders((showAll) => !showAll);
    setSelectedBrandId(null);
  }, []);
  const apiKeyProviderName = apiKeyProvider?.name ?? "";
  const apiKeyFormHeader = useMemo<SheetHeader>(
    () => ({
      title: t("settings.providers.omp.connections.apiKeyTitle", { provider: apiKeyProviderName }),
    }),
    [apiKeyProviderName, t],
  );
  const providerFormHeader = useMemo<SheetHeader>(
    () => ({
      title: t(
        editingProvider
          ? "settings.providers.omp.custom.editTitle"
          : "settings.providers.omp.connections.gateway",
        editingProvider ? { provider: editingProvider.draft.name } : undefined,
      ),
    }),
    [editingProvider, t],
  );
  const contextWindowFormHeader = useMemo<SheetHeader>(
    () => ({
      title: t("settings.providers.omp.contextWindow.title", {
        provider: contextProvider?.login?.name ?? contextProvider?.id ?? "",
      }),
    }),
    [contextProvider, t],
  );
  const handleOpenContextWindow = useCallback((providerId: string) => {
    setContextProviderId(providerId);
    setError(null);
  }, []);
  const handleCloseContextWindow = useCallback(() => {
    if (!saving) setContextProviderId(null);
  }, [saving]);
  const handleOpenAddProvider = useCallback(() => {
    setEditingProvider(null);
    setAddProviderOpen(true);
  }, []);
  const handleOpenEditProvider = useCallback(
    (providerId: string) => {
      const draft = parseCustomProviderDraft(configYaml, providerId);
      if (!draft) {
        setError(t("settings.providers.omp.custom.editLoadFailed", { provider: providerId }));
        return;
      }
      setError(null);
      setAddProviderOpen(false);
      setEditingProvider({ id: providerId, draft });
    },
    [configYaml, t],
  );
  const handleCloseProviderForm = useCallback(() => {
    setAddProviderOpen(false);
    setEditingProvider(null);
  }, []);
  const handleProviderSaved = useCallback(
    (result: OmpProviderManagement) => {
      applyManagement(result);
      setAddProviderOpen(false);
      setEditingProvider(null);
      closeDirectory();
    },
    [applyManagement, closeDirectory],
  );
  const removeProvider = useCallback(
    async (providerId: string) => {
      if (!client || removingProviderId) return;
      const confirmed = await confirmDialog({
        title: t("settings.providers.omp.custom.removeConfirmTitle", {
          provider:
            connected.find((provider) => provider.id === providerId)?.name ?? providerId,
        }),
        message: t("settings.providers.omp.custom.removeConfirmMessage"),
        confirmLabel: t("settings.providers.omp.custom.removeProvider"),
        destructive: true,
      });
      if (!confirmed) return;

      setRemovingProviderId(providerId);
      setError(null);
      try {
        applyManagement(await client.removeOmpProvider(providerId));
      } catch (removeError) {
        setError(removeError instanceof Error ? removeError.message : String(removeError));
      } finally {
        setRemovingProviderId(null);
      }
    },
    [applyManagement, client, connected, removingProviderId, t],
  );
  const handleRemoveProvider = useCallback(
    (providerId: string) => void removeProvider(providerId),
    [removeProvider],
  );

  function renderConnections(): ReactElement {
    return (
      <View style={connectionStyles.section}>
        <CollapsibleSectionHeader
          title={t("settings.providers.omp.connections.mine")}
          count={connected.length}
          expanded={signedInProvidersExpanded}
          onPress={toggleSignedInProviders}
          testID="omp-signed-in-providers-toggle"
        />
        {signedInProvidersExpanded ? (
          <View style={connectionStyles.stack}>
        {connected.map((summary) => (
          <OmpProviderSummaryRow
            key={summary.id}
            summary={summary}
            serverId={serverId}
            removingProviderId={removingProviderId}
            onEdit={summary.custom ? handleOpenEditProvider : undefined}
            onRemove={summary.custom ? handleRemoveProvider : undefined}
            onApiKey={apiKeySupported && summary.login?.supportsApiKey ? setApiKeyProvider : undefined}
            loggingInProviderId={loginProviderId}
            loginFlowActive={loginFlow !== null}
            loggingOutProviderId={logoutProviderId}
            loggingOutCredentialId={logoutCredentialId}
            accountNotes={accountNotes}
            accountNotesLoading={accountNotesLoading}
            editingAccountId={editingAccountId}
            accountNoteDraft={accountNoteDraft}
            savingAccountNoteId={savingAccountNoteId}
            onConfigureModels={handleOpenContextWindow}
            onEditAccountNote={editAccountNote}
            reorderingProviderId={reorderingProviderId}
            onChangeAccountNote={setAccountNoteDraft}
            onSaveAccountNote={saveAccountNote}
            onCancelAccountNote={cancelAccountNote}
            onLogin={startLogin}
            onLogout={handleLogout}
            onLogoutAccount={handleAccountLogout}
            onReorderAccounts={reorderAccounts}
          />
        ))}
          </View>
        ) : null}
      </View>
    );
  }

  function renderProviderGrid(providers: OmpProviderSummary[]): ReactElement {
    const brands = new Map<string, OmpProviderSummary[]>();
    for (const summary of providers) {
      const entries = brands.get(summary.brandId);
      if (entries) entries.push(summary);
      else brands.set(summary.brandId, [summary]);
    }
    const cards = [...brands.values()];
    const rows = compactColumns ? cards.map((card) => [card]) : cards.reduce<OmpProviderSummary[][][]>(
      (result, card, index) => {
        if (index % 2 === 0) result.push([card]);
        else result[result.length - 1]?.push(card);
        return result;
      }, []);
    const matchingModelsByProvider = new Map(
      searchResults?.map(({ provider, modelNames }) => [provider.id, modelNames] as const),
    );
    return (
      <View style={connectionStyles.stack}>
        {rows.map((row) => (
          <View key={row[0]?.[0]?.brandId} style={connectionStyles.directoryRow}>
            {row.map((entries) => {
              const first = entries[0]!;
              return (
                <View key={first.brandId} style={connectionStyles.directoryCard}>
                  <OmpDirectoryBrandTrigger
                    summary={first}
                    expanded={selectedBrandId === first.brandId}
                    onToggle={toggleBrand}
                  />
                  {selectedBrandId === first.brandId ? entries.map((summary) => {
                    const isConnected = connected.includes(summary);
                    const matchingModels = matchingModelsByProvider.get(summary.id);
                    const showName = entries.length > 1 || summary.name !== summary.brand;
                    return (
                      <View key={summary.id} style={connectionStyles.directoryEntry}>
                        {showName ? <Text style={sheetStyles.modelTitle}>{summary.name}</Text> : null}
                        {matchingModels?.length ? (
                          <Text style={sheetStyles.mutedText}>{matchingModels.join(" · ")}</Text>
                        ) : null}
                        {isConnected ? (
                          <Button variant="secondary" size="sm" onPress={showConnections}>
                            {t("settings.providers.omp.connections.viewConnections")}
                          </Button>
                        ) : (
                          <OmpProviderSummaryActions
                            summary={summary}
                            login={summary.login}
                            loginAction={summary.login ? resolveOmpLoginAction(summary.login) : null}
                            loggingInProviderId={loginProviderId}
                            loggingOutProviderId={logoutProviderId}
                            loggingOutAll={false}
                            loginFlowActive={loginFlow !== null}
                            onLogin={startLogin}
                            onApiKey={apiKeySupported && summary.login?.supportsApiKey ? setApiKeyProvider : undefined}
                          />
                        )}
                        {!isConnected && !apiKeySupported && summary.login?.supportsApiKey &&
                        !canStartOmpBrowserLogin(summary.login) &&
                        !canStartOmpBrowserLogin(summary.deviceCodeLogin) ? (
                          <Text style={sheetStyles.mutedText}>{t("settings.providers.omp.connections.updateForApiKey")}</Text>
                        ) : null}
                      </View>
                    );
                  }) : null}
                </View>
              );
            })}
            {!compactColumns && row.length === 1 ? <View style={connectionStyles.directorySpacer} /> : null}
          </View>
        ))}
      </View>
    );
  }

  function renderDirectory(): ReactElement {
    return (
      <View style={connectionStyles.section}>
        <View style={connectionStyles.searchBar}>
          <Search color={theme.colors.foregroundMuted} size={theme.iconSize.md} />
          <AdaptiveTextInput
            initialValue={providerSearchQuery}
            resetKey={`${serverId}:${directoryOpen}`}
            onChangeText={handleProviderSearch}
            placeholder={t("settings.providers.omp.connections.search")}
            accessibilityLabel={t("settings.providers.omp.connections.search")}
            autoCapitalize="none"
            autoCorrect={false}
            testID="omp-provider-search"
            style={connectionStyles.searchInput}
          />
        </View>
        {!providerSearch && !showAllProviders && featured.length > 0 ? (
          <Text style={connectionStyles.sectionTitle}>{t("settings.providers.omp.connections.featured")}</Text>
        ) : null}
        {displayedDirectory.length > 0 ? (
          renderProviderGrid(displayedDirectory)
        ) : (
          <SurfaceCard>
            <Text style={sheetStyles.emptyCardText}>
              {t(providerSearch ? "settings.providers.omp.connections.noMatches" : "settings.providers.omp.connections.noMoreProviders")}
            </Text>
          </SurfaceCard>
        )}
        {!providerSearch && available.some((summary) => !featured.includes(summary)) ? (
          <Button
            variant="secondary"
            size="sm"
            style={connectionStyles.browseButton}
            leftIcon={showAllProviders ? ChevronUp : ChevronDown}
            onPress={toggleShowAllProviders}
            testID="omp-show-all-providers"
          >
            {t(showAllProviders ? "settings.providers.omp.connections.showFeatured" : "settings.providers.omp.connections.browse")}
          </Button>
        ) : null}
      </View>
    );
  }

  function renderLoginFlow(): ReactElement | null {
    if (!loginFlow) {
      return null;
    }
    const loginProvider = management?.loginProviders.find((provider) => provider.id === loginFlow.providerId);
    return (
      <View style={sheetStyles.section}>
        <SectionHeader
          title={t("settings.providers.omp.login.completeTitle", {
            provider: loginProvider?.name ?? loginFlow.providerId,
          })}
        />
        <SurfaceCard>
          <View style={sheetStyles.formGroup}>
            {loginFlow.instructions ? (
              <Text style={sheetStyles.mutedText}>{loginFlow.instructions}</Text>
            ) : null}
            <Text style={sheetStyles.monoHint} selectable>
              {loginFlow.url}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={ExternalLink}
              onPress={handleOpenAuthorizationPress}
            >
              {t("settings.providers.omp.login.openAuthorization")}
            </Button>
            <AdaptiveTextInput
              initialValue={loginInput}
              resetKey={loginFlow.flowId}
              onChangeText={setLoginInput}
              placeholder={t("settings.providers.omp.login.inputPlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              style={sheetStyles.formInput}
            />
            <Button
              variant="default"
              size="sm"
              leftIcon={ExternalLink}
              onPress={handleFinishLoginPress}
              disabled={Boolean(loginProviderId)}
            >
              {loginProviderId
                ? t("settings.providers.omp.login.completing")
                : t("settings.providers.omp.login.complete")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onPress={handleCancelLoginPress}
              disabled={Boolean(loginProviderId)}
              testID="omp-cancel-provider-login"
            >
              {t("common.cancel")}
            </Button>
          </View>
        </SurfaceCard>
      </View>
    );
  }

  function renderGateway(): ReactElement {
    return (
      <Pressable
        accessibilityRole="button"
        testID="omp-add-custom-provider"
        onPress={handleOpenAddProvider}
        style={gatewayEntryStyle}
      >
        <View style={connectionStyles.gatewayMark}>
          <Building2 size={theme.iconSize.lg} color={theme.colors.accent} />
        </View>
        <View style={connectionStyles.brandText}>
          <Text style={connectionStyles.brandName}>{t("settings.providers.omp.connections.gateway")}</Text>
          <Text style={sheetStyles.mutedText}>{t("settings.providers.omp.connections.gatewayHint")}</Text>
        </View>
        <ChevronRight size={theme.iconSize.md} color={theme.colors.accent} />
      </Pressable>
    );
  }

  function renderHome(): ReactElement | null {
    if (!management) return null;
    const showDirectory = directoryOpen || connected.length === 0;
    return (
      <>
        {showDirectory ? renderDirectory() : renderConnections()}
        {showDirectory ? renderGateway() : null}
        {!directoryOpen ? (
          <OmpAdvancedYaml
            management={management}
            configYaml={configYaml}
            saving={saving}
            onConfigYamlChange={setConfigYaml}
            onSave={handleSavePress}
          />
        ) : null}
      </>
    );
  }

  function renderProviderForm(): ReactElement | null {
    if (!client || (!addProviderOpen && !editingProvider)) {
      return null;
    }
    return (
      <OmpProviderForm
        key={editingProvider?.id ?? "add"}
        client={client}
        initialDraft={editingProvider?.draft}
        editingProviderId={editingProvider?.id}
        configYaml={editingProvider ? configYaml : undefined}
        onSaved={handleProviderSaved}
        onCancel={handleCloseProviderForm}
      />
    );
  }

  function renderContextWindowForm(): ReactElement | null {
    if (!contextProvider?.models) {
      return null;
    }
    return (
      <OmpModelContextWindowForm
        key={`${contextProvider.id}:${management?.configYaml ?? ""}`}
        providerId={contextProvider.id}
        models={contextProvider.models}
        saving={saving}
        onSave={saveContextWindowConfig}
        onCancel={handleCloseContextWindow}
      />
    );
  }

  function renderPanelHeader(): ReactElement {
    let title: string;
    let hint: string;
    if (directoryOpen) {
      title = t("settings.providers.omp.connections.directory");
      hint = t("settings.providers.omp.connections.directoryHint");
    } else if (management && connected.length === 0) {
      title = t("settings.providers.omp.connections.firstTitle");
      hint = t("settings.providers.omp.connections.firstHint");
    } else {
      title = t("settings.providers.omp.connections.title");
      hint = t("settings.providers.omp.connections.hint");
    }
    return (
      <>
        {directoryOpen ? (
          <View style={connectionStyles.back}>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={ArrowLeft}
              onPress={closeDirectory}
              testID="omp-provider-directory-back"
            >
              {t("settings.providers.omp.connections.back")}
            </Button>
          </View>
        ) : null}
        <View style={connectionStyles.header}>
          <View style={connectionStyles.heading}>
            <Text accessibilityRole="header" style={connectionStyles.title}>{title}</Text>
            <Text style={sheetStyles.mutedText}>{hint}</Text>
          </View>
          <View style={connectionStyles.headerActions}>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={loading ? undefined : RotateCw}
              onPress={handleRefreshPress}
              disabled={loading}
              testID="omp-refresh-providers"
            >
              {loading ? t("settings.providers.omp.refreshing") : t("settings.providers.omp.refresh")}
            </Button>
            {!directoryOpen && connected.length > 0 ? (
              <Button
                variant="default"
                size="sm"
                leftIcon={Plus}
                onPress={openDirectory}
                testID="omp-browse-providers"
              >
                {t("settings.providers.omp.connections.add")}
              </Button>
            ) : null}
          </View>
        </View>
      </>
    );
  }

  function renderPanel(): ReactElement {
    if (!supported) {
      return (
        <SurfaceCard>
          <Text style={sheetStyles.mutedText}>{t("settings.providers.omp.updateHost")}</Text>
        </SurfaceCard>
      );
    }
    if (loading && !management) {
      return (
        <View style={sheetStyles.emptyState}>
          <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />
          <Text style={sheetStyles.mutedText}>{t("settings.providers.omp.loading")}</Text>
        </View>
      );
    }
    return (
      <View style={connectionStyles.home} onLayout={handleDirectoryLayout}>
        {renderPanelHeader()}
        {error ? <Text style={sheetStyles.errorText}>{error}</Text> : null}
        {management?.runtimeError ? (
          <SurfaceCard>
            <Text style={sheetStyles.errorText}>{management.runtimeError}</Text>
          </SurfaceCard>
        ) : null}
        {renderLoginFlow()}
        {renderHome()}
        <AdaptiveModalSheet
          header={apiKeyFormHeader}
          visible={apiKeySupported && apiKeyProvider !== null}
          onClose={closeApiKeyForm}
          testID="omp-builtin-api-key-sheet"
          snapPoints={ADD_PROVIDER_SNAP_POINTS}
          dismissOnBackdropPress={false}
        >
          {apiKeySupported && apiKeyProvider ? (
            <OmpBuiltinApiKeyForm
              key={apiKeyProvider.id}
              providerId={apiKeyProvider.id}
              providerName={apiKeyProvider.name}
              onSave={saveBuiltinApiKey}
              onCancel={closeApiKeyForm}
            />
          ) : null}
        </AdaptiveModalSheet>
        <AdaptiveModalSheet
          header={providerFormHeader}
          visible={addProviderOpen || editingProvider !== null}
          onClose={handleCloseProviderForm}
          testID="omp-add-provider-sheet"
          snapPoints={ADD_PROVIDER_SNAP_POINTS}
          contentStyle={sheetStyles.addProviderModalContent}
          dismissOnBackdropPress={false}
        >
          {renderProviderForm()}
        </AdaptiveModalSheet>
        <AdaptiveModalSheet
          header={contextWindowFormHeader}
          visible={contextProvider !== undefined}
          onClose={handleCloseContextWindow}
          testID="omp-model-context-window-sheet"
          snapPoints={ADD_PROVIDER_SNAP_POINTS}
          contentStyle={sheetStyles.addProviderModalContent}
        >
          {renderContextWindowForm()}
        </AdaptiveModalSheet>
      </View>
    );
  }

  return renderPanel();
}
export function OmpProviderConfigurationPanel({ serverId }: { serverId: string }) {
  const { refresh } = useProvidersSnapshot(serverId, { enabled: false });
  const handleSaved = useCallback(() => {
    void refresh(["omp"]);
  }, [refresh]);

  return <OmpManagementPanel serverId={serverId} visible onSaved={handleSaved} />;
}

function DiagnosticSubSheet({
  provider,
  serverId,
  visible,
  onClose,
}: {
  provider: string;
  serverId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchDiagnostic = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const result = await client.getProviderDiagnostic(provider);
      setDiagnostic(result.diagnostic);
    } catch (err) {
      setDiagnostic(
        err instanceof Error ? err.message : t("settings.providers.diagnostic.failedToFetch"),
      );
    } finally {
      setLoading(false);
    }
  }, [client, provider, t]);

  useEffect(() => {
    if (visible) {
      void fetchDiagnostic();
    } else {
      setDiagnostic(null);
    }
  }, [visible, fetchDiagnostic]);

  const refreshButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sheetStyles.iconButton,
      (Boolean(hovered) || pressed) && sheetStyles.iconButtonHovered,
      loading ? sheetStyles.disabled : null,
    ],
    [loading],
  );

  const handleRefreshPress = useCallback(() => {
    void fetchDiagnostic();
  }, [fetchDiagnostic]);

  const copyButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sheetStyles.iconButton,
      (Boolean(hovered) || pressed) && Boolean(diagnostic) && sheetStyles.iconButtonHovered,
      diagnostic ? null : sheetStyles.disabled,
    ],
    [diagnostic],
  );

  const handleCopyPress = useCallback(() => {
    if (!diagnostic) return;
    void Clipboard.setStringAsync(diagnostic)
      .then(() => toast.copied(t("settings.providers.diagnostic.copyLabel")))
      .catch(() => toast.error(t("settings.providers.diagnostic.copyFailed")));
  }, [diagnostic, t, toast]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("settings.providers.diagnostic.title"),
      actions: (
        <View style={sheetStyles.headerActions}>
          <Pressable
            onPress={handleCopyPress}
            disabled={!diagnostic}
            hitSlop={8}
            style={copyButtonStyle}
            accessibilityRole="button"
            accessibilityLabel={t("settings.providers.diagnostic.copyAccessibility")}
          >
            <Copy size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          </Pressable>
          <Pressable
            onPress={handleRefreshPress}
            disabled={loading}
            hitSlop={8}
            style={refreshButtonStyle}
            accessibilityRole="button"
            accessibilityLabel={
              loading
                ? t("settings.providers.diagnostic.refreshingAccessibility")
                : t("settings.providers.diagnostic.refreshAccessibility")
            }
          >
            {loading ? (
              <LoadingSpinner size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            ) : (
              <RotateCw size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            )}
          </Pressable>
        </View>
      ),
    }),
    [
      copyButtonStyle,
      diagnostic,
      handleCopyPress,
      handleRefreshPress,
      loading,
      refreshButtonStyle,
      t,
      theme.colors.foregroundMuted,
      theme.iconSize.sm,
    ],
  );

  let body: React.ReactNode;
  if (loading && !diagnostic) {
    body = (
      <SurfaceCard key={visible ? "visible" : "hidden"}>
        <View style={sheetStyles.codeBlockLoading}>
          <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />
          <Text style={sheetStyles.mutedText}>{t("settings.providers.diagnostic.running")}</Text>
        </View>
      </SurfaceCard>
    );
  } else if (diagnostic) {
    body = (
      <ScrollableCodeSurface key={visible ? "visible" : "hidden"} maxHeight={480}>
        {diagnostic}
      </ScrollableCodeSurface>
    );
  } else {
    body = (
      <SurfaceCard key={visible ? "visible" : "hidden"}>
        <View style={sheetStyles.codeBlockLoading}>
          <Text style={sheetStyles.mutedText}>{t("settings.providers.diagnostic.none")}</Text>
        </View>
      </SurfaceCard>
    );
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      snapPoints={DIAGNOSTIC_SNAP_POINTS}
      scrollable={false}
      testID="provider-diagnostic-sheet"
    >
      {body}
    </AdaptiveModalSheet>
  );
}

interface ProviderModalBodyProps {
  discoveredCount: number;
  providerSnapshotRefreshing: boolean;
  providerErrorMessage: string | null;
  modelsRefreshing: boolean;
  searchActive: boolean;
  filteredDiscovered: AgentModelDefinition[];
  onRefresh: () => void;
  theme: { iconSize: { md: number }; colors: { foregroundMuted: string } };
}

interface ProviderSheetFooterInput {
  fetchedAtLabel: string | null;
  isCompact: boolean;
  modelsRefreshing: boolean;
  t: TFunction;
  onOpenDiagSheet: () => void;
  onRefreshModels: () => void;
}

function renderProviderSheetFooter({
  fetchedAtLabel,
  isCompact,
  modelsRefreshing,
  t,
  onOpenDiagSheet,
  onRefreshModels,
}: ProviderSheetFooterInput) {
  const contentStyle = isCompact ? sheetStyles.compactFooterContent : sheetStyles.footerContent;
  const actionsStyle = isCompact ? sheetStyles.compactFooterActions : sheetStyles.footerActions;
  const buttonStyle = isCompact ? sheetStyles.compactFooterButton : null;
  const metaStyle = isCompact
    ? [sheetStyles.footerMeta, sheetStyles.compactFooterMeta]
    : sheetStyles.footerMeta;

  return (
    <View style={contentStyle}>
      {fetchedAtLabel || !isCompact ? (
        <Text style={metaStyle} numberOfLines={1}>
          {fetchedAtLabel ? t("settings.providers.models.updated", { time: fetchedAtLabel }) : ""}
        </Text>
      ) : null}
      <View style={actionsStyle}>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={FileText}
          onPress={onOpenDiagSheet}
          style={buttonStyle}
        >
          {t("settings.providers.diagnostic.button")}
        </Button>
        <Button
          variant="default"
          size="sm"
          leftIcon={modelsRefreshing ? undefined : RotateCw}
          onPress={onRefreshModels}
          disabled={modelsRefreshing}
          style={buttonStyle}
        >
          {modelsRefreshing
            ? t("settings.providers.diagnostic.refreshing")
            : t("settings.providers.diagnostic.refresh")}
        </Button>
      </View>
    </View>
  );
}

function ProviderModalBody(props: ProviderModalBodyProps) {
  const { t } = useTranslation();
  const {
    discoveredCount,
    providerSnapshotRefreshing,
    providerErrorMessage,
    modelsRefreshing,
    searchActive,
    filteredDiscovered,
    onRefresh,
    theme,
  } = props;
  const modelGroups = useMemo(
    () => groupOmpDiscoveredModels(filteredDiscovered),
    [filteredDiscovered],
  );

  if (discoveredCount === 0 && providerSnapshotRefreshing) {
    return (
      <View style={sheetStyles.emptyState}>
        <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />
        <Text style={sheetStyles.mutedText}>{t("settings.providers.models.loading")}</Text>
      </View>
    );
  }
  if (discoveredCount === 0 && providerErrorMessage) {
    return (
      <View style={sheetStyles.emptyState}>
        <AlertTriangle size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
        <Text style={sheetStyles.mutedText}>{providerErrorMessage}</Text>
        <Button variant="default" size="sm" onPress={onRefresh} disabled={modelsRefreshing}>
          {modelsRefreshing
            ? t("settings.providers.models.retrying")
            : t("settings.providers.models.retry")}
        </Button>
      </View>
    );
  }
  if (filteredDiscovered.length === 0 && searchActive) {
    return (
      <View style={sheetStyles.emptyState}>
        <Text style={sheetStyles.mutedText}>{t("settings.providers.models.noSearchMatches")}</Text>
      </View>
    );
  }
  if (discoveredCount === 0) {
    return (
      <View style={sheetStyles.emptyState}>
        <Text style={sheetStyles.mutedText}>{t("settings.providers.models.noneDetected")}</Text>
      </View>
    );
  }
  return (
    <View style={sheetStyles.section}>
      <SectionHeader
        title={t("settings.providers.models.discovered")}
        count={filteredDiscovered.length}
      />
      <View style={sheetStyles.modelGroups}>
        {modelGroups.map((group) => (
          <OmpModelProviderGroup key={group.id} group={group} forceExpanded={searchActive} />
        ))}
      </View>
    </View>
  );
}

export function ProviderDiagnosticSheet({
  provider,
  visible,
  onClose,
  serverId,
  inline = false,
}: ProviderDiagnosticSheetProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const isCompact = useIsCompactFormFactor();
  const { entries: snapshotEntries, refresh, isRefreshing } = useProvidersSnapshot(serverId);
  const [query, setQuery] = useState("");
  const [diagSheetOpen, setDiagSheetOpen] = useState(false);

  const providerLabel = resolveProviderLabel(provider, snapshotEntries);
  const providerEntry = useMemo(
    () => snapshotEntries?.find((entry) => entry.provider === provider),
    [snapshotEntries, provider],
  );
  const providerSnapshotRefreshing = providerEntry?.status === "loading";
  const providerErrorMessage =
    providerEntry?.status === "error"
      ? (providerEntry.error ?? t("settings.providers.diagnostic.unknownError"))
      : null;
  const modelsRefreshing = isRefreshing || providerSnapshotRefreshing;

  const stableDiscoveredRef = useRef<ProviderDiscoveredModelsCache | null>(null);
  const currentModels = providerEntry?.models;
  const { models: discoveredModels, cache: nextDiscoveredCache } = resolveProviderDiscoveredModels({
    serverId,
    provider,
    currentModels,
    providerSnapshotRefreshing,
    previousCache: stableDiscoveredRef.current,
  });
  stableDiscoveredRef.current = nextDiscoveredCache;

  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setClockTick((tick) => tick + 1), 10_000);
    return () => clearInterval(id);
  }, [visible]);
  const fetchedAtLabel = useMemo(() => {
    if (!providerEntry?.fetchedAt) return null;
    void clockTick;
    return formatTimeAgo(new Date(providerEntry.fetchedAt));
  }, [providerEntry?.fetchedAt, clockTick]);

  useEffect(() => {
    if (!visible) {
      setQuery("");
      setDiagSheetOpen(false);
    }
  }, [visible]);

  const q = query.trim();
  const filteredDiscovered = useMemo(
    () => rankModels(discoveredModels, q, (m) => [m.label, m.id, m.description ?? ""]),
    [discoveredModels, q],
  );

  const handleRefreshModels = useCallback(() => {
    void refresh([provider]);
  }, [provider, refresh]);

  const handleOpenDiagSheet = useCallback(() => setDiagSheetOpen(true), []);
  const handleCloseDiagSheet = useCallback(() => setDiagSheetOpen(false), []);

  const sheetHeader = useMemo<SheetHeader>(
    () => ({
      title: providerLabel,
      search: {
        onChange: setQuery,
        placeholder: t("settings.providers.models.searchPlaceholder"),
        testID: "provider-settings-search",
      },
    }),
    [providerLabel, t],
  );
  const content = (
    <>
      <ProviderModalBody
        discoveredCount={discoveredModels.length}
        providerSnapshotRefreshing={providerSnapshotRefreshing}
        providerErrorMessage={providerErrorMessage}
        modelsRefreshing={modelsRefreshing}
        searchActive={Boolean(q)}
        filteredDiscovered={filteredDiscovered}
        onRefresh={handleRefreshModels}
        theme={theme}
      />
      <OmpManagementPanel serverId={serverId} visible={visible} onSaved={handleRefreshModels} />
    </>
  );
  const footer = renderProviderSheetFooter({
    fetchedAtLabel,
    isCompact,
    modelsRefreshing,
    t,
    onOpenDiagSheet: handleOpenDiagSheet,
    onRefreshModels: handleRefreshModels,
  });
  const diagnostic = (
    <DiagnosticSubSheet
      provider={provider}
      serverId={serverId}
      visible={diagSheetOpen}
      onClose={handleCloseDiagSheet}
    />
  );
  if (inline) {
    return (
      <>
        <View style={sheetStyles.inlineContainer} testID="omp-provider-settings-inline">
          <AdaptiveTextInput
            initialValue={query}
            resetKey="omp-provider-inline-search"
            onChangeText={setQuery}
            placeholder={t("settings.providers.models.searchPlaceholder")}
            accessibilityLabel={t("settings.providers.models.searchPlaceholder")}
            style={sheetStyles.formInput}
          />
          {content}
          <View style={sheetStyles.inlineFooter}>{footer}</View>
        </View>
        {diagnostic}
      </>
    );
  }

  return (
    <>
      <AdaptiveModalSheet
        header={sheetHeader}
        visible={visible}
        onClose={onClose ?? NOOP}
        testID="provider-settings-sheet"
        footer={footer}
        snapPoints={MAIN_SNAP_POINTS}
      >
        {content}
      </AdaptiveModalSheet>
      {diagnostic}
    </>
  );
}

const sheetStyles = StyleSheet.create((theme) => ({
  inlineContainer: {
    gap: theme.spacing[4],
  },
  inlineFooter: {
    marginTop: theme.spacing[2],
  },
  mutedText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  monoHint: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  descriptionInline: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
  formInput: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  contextWindowInput: {
    width: 180,
    minHeight: 44,
  },
  apiSelectTrigger: {
    minHeight: 44,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  apiSelectText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontFamily: theme.fontFamily.mono,
  },
  modelList: {
    gap: theme.spacing[3],
  },
  modelGroups: {
    gap: theme.spacing[2],
  },
  modelGroupHeader: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  modelGroupTitle: {
    minWidth: 0,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  modelEditor: {
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
  },
  modelEditorHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  modelEditorTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  modelInputRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingTop: theme.spacing[1],
  },
  modelInputMeta: {
    flex: 1,
    gap: theme.spacing[1],
  },
  modelInputHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  disabled: {
    opacity: 0.5,
  },
  section: {
    marginBottom: theme.spacing[4],
  },
  collapsibleSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    minHeight: 32,
    paddingHorizontal: theme.spacing[1],
  },
  collapsibleSectionTitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  addProviderModalContent: {
    gap: theme.spacing[3],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[2],
    marginLeft: theme.spacing[1],
  },
  sectionHeaderMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  modelTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    flexShrink: 0,
  },
  modelRowFiller: {
    flex: 1,
  },
  accountList: {
    paddingBottom: theme.spacing[2],
  },
  accountRow: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    marginLeft: theme.spacing[4],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  accountActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  accountIdentity: {
    flex: 1,
    gap: theme.spacing[1],
  },
  accountTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  accountNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  accountEditForm: {
    flex: 1,
    gap: theme.spacing[2],
  },
  accountNoteInput: {
    minHeight: 36,
  },
  accountEditActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  yamlInput: {
    minHeight: 260,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  emptyState: {
    paddingVertical: theme.spacing[8],
    alignItems: "center",
    gap: theme.spacing[3],
  },
  emptyCardText: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  footerContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  compactFooterContent: {
    flex: 1,
    gap: theme.spacing[2],
  },
  footerMeta: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  compactFooterMeta: {
    flex: 0,
  },
  footerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  compactFooterActions: {
    gap: theme.spacing[2],
  },
  compactFooterButton: {
    alignSelf: "stretch",
  },
  formGroup: {
    gap: theme.spacing[3],
  },
  formColumns: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  formColumn: {
    flex: 1,
    gap: theme.spacing[2],
  },
  advancedActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
  formLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  modelListActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  formActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  codeBlockLoading: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));

const MAIN_SNAP_POINTS = ["65%", "92%"];
const DIAGNOSTIC_SNAP_POINTS = ["50%", "85%"];
const ADD_PROVIDER_SNAP_POINTS = ["82%", "95%"];
