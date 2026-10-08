import { isCancelledError, useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RotateCw,
  Save,
  Settings2,
  Trash2,
  X,
} from "lucide-react-native";
import type { TFunction } from "i18next";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, type PressableStateCallbackType, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { SettingsTextArea } from "@/components/settings-textarea";
import { ScrollableCodeSurface, SurfaceCard } from "@/components/ui/scrollable-code-surface";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  OMP_PROVIDER_MANAGEMENT_GC_TIME_MS,
  OMP_PROVIDER_MANAGEMENT_STALE_TIME_MS,
  ompProviderManagementQueryKey,
  refreshOmpAccountQuotaManagement,
} from "@/hooks/use-omp-account-quota";
import { useOmpProviderAccountNotes } from "@/hooks/use-omp-provider-account-notes";
import { ProviderUsageBalanceBar } from "@/provider-usage/balance-bar";
import { ProviderUsageWindowBar } from "@/provider-usage/window-bar";
import { resolveLoginProviderUsages } from "@/provider-usage/login-usage";
import { ProviderUsageCard } from "@/provider-usage/card";
import type { ProviderUsage } from "@/provider-usage/types";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatTimeAgo } from "@/utils/time";
import { compareMatchScores, scoreTextFields } from "@omp-desktop/protocol/search/text-match";
import type { AgentModelDefinition } from "@omp-desktop/protocol/agent-types";
import type {
  OmpCustomProviderInput,
  OmpProviderApi,
  OmpProviderManagement,
} from "@omp-desktop/protocol/messages";
import {
  createEmptyProviderDraft,
  configureDiscoveredProviderModels,
  OMP_PROVIDER_APIS,
  parseCustomProviderDraft,
  updateCustomProviderConfigYaml,
  type OmpProviderDraft,
  type OmpProviderModelDraft,
} from "./omp-custom-provider-config";
import { updateOmpProviderAccountNote } from "./omp-provider-account-notes";
import { formatOmpAccountIdentity, resolveOmpLoginAction } from "./omp-provider-accounts";
import {
  OmpCodexQuotaDetails,
  OmpCodexQuotaServerContext,
  OmpQuotaCountdown,
} from "./omp-codex-quota-details";
import {
  formatOmpQuotaResetTime,
  resolveOmpRemainingQuotaPct,
  shouldShowOmpFiveHourQuota,
} from "./omp-provider-quota";
import {
  groupOmpDiscoveredModels,
  resolveProviderDiscoveredModels,
  type OmpDiscoveredModelGroup,
  type ProviderDiscoveredModelsCache,
} from "./provider-diagnostic-models";

interface ProviderDiagnosticSheetProps {
  provider: string;
  visible: boolean;
  onClose?: () => void;
  serverId: string;
  inline?: boolean;
}
const NOOP = () => undefined;

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
  const label = model.label.startsWith(prefix) ? model.label.slice(prefix.length) : model.label;
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
  count: number;
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
      <Text style={settingsStyles.sectionHeaderTitle}>{count}</Text>
    </Pressable>
  );
}
interface OmpProviderSummary {
  id: string;
  modelCount: number;
  models?: OmpManagedProviderModel[];
  login?: OmpProviderManagement["loginProviders"][number];
}

const EMPTY_OMP_ACCOUNT_NOTES: Record<string, string> = {};

type OmpManagedProviderModel = NonNullable<
  OmpProviderManagement["providerModels"][number]["models"]
>[number];

type OmpProviderAccount = NonNullable<
  OmpProviderManagement["loginProviders"][number]["accounts"]
>[number];

function OmpAccountQuotaWindow({
  label,
  usedPct,
  resetsAt,
  status,
  limitReached = false,
}: {
  label: string;
  usedPct: number | null | undefined;
  resetsAt: string | null | undefined;
  status: OmpProviderAccount["quota"] extends infer Quota
    ? Quota extends { status: infer Status }
      ? Status
      : undefined
    : undefined;
  limitReached?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { theme } = useUnistyles();
  const remainingPct = resolveOmpRemainingQuotaPct(usedPct);
  const reached = limitReached || remainingPct === 0;
  let toneColor = theme.colors.foregroundMuted;
  if (reached) {
    toneColor = theme.colors.destructive;
  } else if (remainingPct !== null) {
    toneColor =
      remainingPct <= 30 ? theme.colors.palette.amber[500] : theme.colors.palette.green[500];
  }
  const remainingText =
    remainingPct !== null
      ? t("settings.providers.omp.multiAccount.quotaRemaining", {
          remaining: Math.round(remainingPct),
        })
      : null;
  const statusText =
    status !== "available"
      ? t("settings.providers.omp.multiAccount.quotaUnavailable")
      : (remainingText ?? t("settings.providers.omp.multiAccount.quotaUnknown"));
  const resetTime = formatOmpQuotaResetTime(resetsAt, i18n.language);
  const accessibilityValue = useMemo(
    () => ({ min: 0, max: 100, now: Math.round(remainingPct ?? 0) }),
    [remainingPct],
  );
  return (
    <View style={sheetStyles.accountQuotaWindow}>
      <View style={sheetStyles.accountQuotaHeader}>
        <Text style={sheetStyles.accountQuotaLabel}>{label}</Text>
        <Text style={[sheetStyles.accountQuotaStatus, { color: toneColor }]}>{statusText}</Text>
      </View>
      {remainingPct !== null ? (
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={label}
          accessibilityValue={accessibilityValue}
          style={sheetStyles.accountQuotaTrack}
        >
          <View
            style={[
              sheetStyles.accountQuotaFill,
              { width: `${remainingPct}%`, backgroundColor: toneColor },
            ]}
          />
        </View>
      ) : null}
      {resetTime ? (
        <>
          <OmpQuotaCountdown resetsAt={resetsAt} />
          <Text style={sheetStyles.accountQuotaReset}>
            {t("settings.providers.omp.multiAccount.quotaResetsAt", { time: resetTime })}
          </Text>
        </>
      ) : null}
    </View>
  );
}

function OmpAccountQuotaSummary({
  credentialId,
  quota,
}: {
  credentialId: number;
  quota?: OmpProviderAccount["quota"];
}) {
  const { t } = useTranslation();
  return (
    <View style={sheetStyles.accountQuota} testID={`omp-provider-account-quota-${credentialId}`}>
      <OmpAccountQuotaWindow
        label={t("agentControls.quota.weekly")}
        usedPct={quota?.weeklyUsedPct}
        resetsAt={quota?.weeklyResetsAt}
        status={quota?.status}
      />
      {shouldShowOmpFiveHourQuota(quota) ? (
        <OmpAccountQuotaWindow
          label={t("settings.providers.omp.multiAccount.quotaFiveHour")}
          usedPct={quota?.fiveHourUsedPct}
          resetsAt={quota?.fiveHourResetsAt}
          status={quota?.status}
          limitReached={quota?.fiveHourLimitReached === true}
        />
      ) : null}
    </View>
  );
}

function OmpProviderAccountRow({
  account,
  showQuota,
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
  showQuota: boolean;
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
          <View style={sheetStyles.providerSummaryText}>
            <Text style={sheetStyles.accountTitle}>
              {identity.primary ??
                t("settings.providers.omp.multiAccount.fallback", {
                  number: account.accountNumber ?? index + 1,
                })}
            </Text>
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
            {showQuota ? (
              <>
                <OmpAccountQuotaSummary credentialId={account.credentialId} quota={account.quota} />
                <OmpCodexQuotaDetails
                  account={account}
                  accountLabel={
                    identity.primary ??
                    t("settings.providers.omp.multiAccount.fallback", {
                      number: account.accountNumber ?? index + 1,
                    })
                  }
                />
              </>
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
  usages?: ProviderUsage[];
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
  canConfigureModels,
  canEdit,
  canRemove,
  canLogout,
  onConfigureModels,
  onEdit,
  onRemove,
  onLogin,
  onLogout,
}: {
  summary: OmpProviderSummary;
  login: OmpProviderSummary["login"];
  loginAction: ReturnType<typeof resolveOmpLoginAction> | null;
  loggingInProviderId: string | null;
  loggingOutProviderId: string | null;
  loggingOutAll: boolean;
  loginFlowActive: boolean;
  removingProviderId?: string | null;
  canConfigureModels: boolean;
  canEdit: boolean;
  canRemove: boolean;
  canLogout: boolean;
  onConfigureModels: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onLogin: () => void;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  const accounts = login?.accounts ?? [];
  function renderConfigureModelsAction(): ReactElement | null {
    if (!login || !summary.models || summary.models.length === 0 || !canConfigureModels) {
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
    if (!login || !loginAction) {
      return null;
    }
    return (
      <Button
        variant="secondary"
        size="sm"
        leftIcon={loggingInProviderId === login.id ? undefined : LogIn}
        onPress={onLogin}
        disabled={Boolean(loggingInProviderId || loggingOutProviderId || loginFlowActive)}
        testID={`omp-login-provider-${login.id}`}
      >
        {loggingInProviderId === login.id
          ? t("settings.providers.omp.provider.starting")
          : t(
              loginAction === "add-account"
                ? "settings.providers.omp.multiAccount.add"
                : "settings.providers.omp.provider.signIn",
            )}
      </Button>
    );
  }

  function renderLogoutAction(): ReactElement | null {
    if (!login?.authenticated || !canLogout) {
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
    if (login || !canEdit) {
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
    if (login || !canRemove) {
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
    <View style={sheetStyles.providerSummaryActions}>
      {renderConfigureModelsAction()}
      {renderLoginAction()}
      {renderLogoutAction()}
      {renderEditAction()}
      {renderRemoveAction()}
    </View>
  );
}

function OmpProviderAccountListItem({
  account,
  showQuota,
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
  showQuota: boolean;
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
      showQuota={showQuota}
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
          showQuota={summary.id === "openai-codex"}
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

function OmpProviderSummaryIdentity({ summary }: { summary: OmpProviderSummary }) {
  const { t } = useTranslation();
  const { login } = summary;
  const accountCount = login?.accounts?.length ?? 0;
  const modelCount = t(
    summary.modelCount === 1 ? "settings.providers.models.one" : "settings.providers.models.many",
    { count: summary.modelCount },
  );
  let loginStatus = "";
  if (login) {
    loginStatus = login.authenticated
      ? ` · ${t("settings.providers.omp.provider.signedIn")}`
      : ` · ${t("settings.providers.omp.provider.notSignedIn")}`;
    if (accountCount > 0) {
      loginStatus += ` · ${t(
        accountCount === 1
          ? "settings.providers.omp.multiAccount.countOne"
          : "settings.providers.omp.multiAccount.countMany",
        { count: accountCount },
      )}`;
    }
  }
  return (
    <View style={sheetStyles.providerSummaryText}>
      <Text style={sheetStyles.modelTitle}>{login?.name ?? summary.id}</Text>
      <Text style={sheetStyles.mutedText}>
        {modelCount}
        {loginStatus}
      </Text>
    </View>
  );
}

function OmpProviderSummaryRow({
  summary,
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
  usages = [],
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
  const { login } = summary;
  const accounts = login?.accounts ?? [];
  const loginAction = login ? resolveOmpLoginAction(login) : null;
  const loggingOutAll =
    login !== undefined && loggingOutProviderId === login.id && loggingOutCredentialId === null;
  const handleLogin = useCallback(() => {
    if (login) onLogin(login.id);
  }, [login, onLogin]);
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
  return (
    <View style={sheetStyles.providerSummaryBlock}>
      <View style={sheetStyles.providerSummaryRow}>
        <OmpProviderSummaryIdentity summary={summary} />
        <OmpProviderSummaryActions
          summary={summary}
          login={login}
          loginAction={loginAction}
          loggingInProviderId={loggingInProviderId}
          loggingOutProviderId={loggingOutProviderId}
          loggingOutAll={loggingOutAll}
          loginFlowActive={loginFlowActive}
          removingProviderId={removingProviderId}
          canConfigureModels={Boolean(onConfigureModels)}
          canEdit={Boolean(onEdit)}
          canRemove={Boolean(onRemove)}
          canLogout={Boolean(onLogout)}
          onConfigureModels={handleConfigureModels}
          onEdit={handleEdit}
          onRemove={handleRemove}
          onLogin={handleLogin}
          onLogout={handleLogout}
        />
      </View>
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
      {(usages ?? []).map((usage) => (
        <View
          key={usage.providerId}
          style={sheetStyles.providerUsage}
          testID={`omp-provider-usage-${usage.providerId}`}
        >
          {usage.providerId.startsWith("zhipu-coding-plan:") ? (
            <ProviderUsageCard usage={usage} compact />
          ) : (
            <>
              {usage.windows.map((window) => (
                <ProviderUsageWindowBar key={window.id} window={window} />
              ))}
              {(usage.balances ?? []).map((balance) => (
                <ProviderUsageBalanceBar key={balance.id} balance={balance} />
              ))}
            </>
          )}
        </View>
      ))}
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
}: {
  value: OmpProviderApi;
  onChange: (api: OmpProviderApi) => void;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={sheetStyles.apiSelectTrigger}
        accessibilityRole="button"
        accessibilityLabel={t("settings.providers.omp.custom.apiFormatAccessibility", {
          format: value,
        })}
      >
        <Text style={sheetStyles.apiSelectText}>{value}</Text>
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
  onRemove,
}: {
  model: OmpProviderModelDraft;
  revision: number;
  canRemove: boolean;
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
        placeholder="gpt-5.4"
        autoCapitalize="none"
        autoCorrect={false}
        style={sheetStyles.formInput}
      />
      <Text style={sheetStyles.formLabel}>{t("settings.providers.omp.custom.displayName")}</Text>
      <AdaptiveTextInput
        initialValue={model.name}
        resetKey={`${revision}-${model.key}-name`}
        onChangeText={updateName}
        placeholder="GPT-5.4"
        style={sheetStyles.formInput}
      />
      <Text style={sheetStyles.formLabel}>{t("settings.providers.omp.custom.apiFormat")}</Text>
      <OmpApiFormatSelect value={model.api} onChange={updateApi} />
      <View style={sheetStyles.formColumns}>
        <View style={sheetStyles.formColumn}>
          <Text style={sheetStyles.formLabel}>
            {t("settings.providers.omp.custom.contextWindow")}
          </Text>
          <AdaptiveTextInput
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
          <Text style={sheetStyles.formLabel}>{t("settings.providers.omp.custom.imageInput")}</Text>
          <Text style={sheetStyles.modelInputHint}>
            {t("settings.providers.omp.custom.imageInputHint")}
          </Text>
        </View>
        <Switch
          value={model.supportsImages}
          onValueChange={updateSupportsImages}
          accessibilityLabel={t("settings.providers.omp.custom.imageInputAccessibility", {
            model: model.name.trim() || model.id.trim() || model.key,
          })}
          testID={`omp-model-image-input-${model.key}`}
        />
      </View>
    </View>
  );
}

type OmpManagementClient = NonNullable<ReturnType<typeof useHostRuntimeClient>>;

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
  const [discoveredCount, setDiscoveredCount] = useState<number | null>(null);
  const updateProviderId = useCallback(
    (providerId: string) => setDraft((current) => ({ ...current, providerId })),
    [],
  );
  const updateBaseUrl = useCallback(
    (baseUrl: string) => setDraft((current) => ({ ...current, baseUrl })),
    [],
  );
  const updateApiKey = useCallback(
    (apiKey: string) => setDraft((current) => ({ ...current, apiKey })),
    [],
  );
  const updateModel = useCallback((key: string, patch: Partial<OmpProviderModelDraft>) => {
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
          api: "openai-responses",
          contextWindow: "",
          maxTokens: "",
          supportsImages: false,
        },
      ],
    }));
  }, []);
  const handleAddModelPress = useCallback(() => addModel(), [addModel]);
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
    if (!draft.baseUrl.trim() || !draft.apiKey.trim()) return;
    setDiscovering(true);
    setDiscoveredCount(null);
    setError(null);
    try {
      const result = await client.discoverOmpProviderModels({
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim(),
      });
      setDraft((current) => ({
        ...current,
        models: configureDiscoveredProviderModels(current.models, result.models, () => {
          const key = `model-${nextModelKey.current}`;
          nextModelKey.current += 1;
          return key;
        }),
      }));
      setRevision((current) => current + 1);
      setDiscoveredCount(result.models.length);
    } catch (discoverError) {
      setError(discoverError instanceof Error ? discoverError.message : String(discoverError));
    } finally {
      setDiscovering(false);
    }
  }, [client, draft.apiKey, draft.baseUrl]);
  const handleDiscoverModelsPress = useCallback(() => void discoverModels(), [discoverModels]);
  const canDiscover = draft.baseUrl.trim().length > 0 && draft.apiKey.trim().length > 0;
  const canAdd =
    draft.providerId.trim().length > 0 &&
    draft.baseUrl.trim().length > 0 &&
    draft.apiKey.trim().length > 0 &&
    draft.models.length > 0 &&
    draft.models.every((model) => model.id.trim().length > 0);

  const addProvider = useCallback(async () => {
    if (!canAdd) return;
    setAdding(true);
    setError(null);
    try {
      const provider: OmpCustomProviderInput = {
        providerId: draft.providerId.trim().toLowerCase(),
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim(),
        api: draft.models[0]?.api ?? "openai-responses",
        models: draft.models.map((model) => ({
          id: model.id.trim(),
          api: model.api,
          ...(model.name.trim() ? { name: model.name.trim() } : {}),
          ...(model.contextWindow.trim()
            ? {
                contextWindow: parseOptionalPositiveInteger(
                  model.contextWindow,
                  t("settings.providers.omp.custom.positiveInteger", {
                    field: t("settings.providers.omp.custom.contextWindow"),
                  }),
                ),
              }
            : {}),
          ...(model.maxTokens.trim()
            ? {
                maxTokens: parseOptionalPositiveInteger(
                  model.maxTokens,
                  t("settings.providers.omp.custom.positiveInteger", {
                    field: t("settings.providers.omp.custom.maxOutputTokens"),
                  }),
                ),
              }
            : {}),
          ...(model.supportsImages ? { supportsImages: true } : {}),
          ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
          ...(model.defaultReasoningLevel
            ? { defaultReasoningLevel: model.defaultReasoningLevel }
            : {}),
          ...(model.supportedReasoningLevels
            ? { supportedReasoningLevels: model.supportedReasoningLevels }
            : {}),
        })),
      };
      const result =
        editingProviderId && configYaml !== undefined
          ? await client.saveOmpProviderConfig(
              updateCustomProviderConfigYaml(configYaml, editingProviderId, provider),
            )
          : await client.addOmpProvider(provider);
      onSaved(result);
      if (!editingProviderId) {
        const key = `model-${nextModelKey.current}`;
        nextModelKey.current += 1;
        setDraft(createEmptyProviderDraft(key));
        setRevision((current) => current + 1);
      }
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    } finally {
      setAdding(false);
    }
  }, [canAdd, client, configYaml, draft, editingProviderId, onSaved, t]);
  const handleAddPress = useCallback(() => void addProvider(), [addProvider]);
  let addProviderLabel = t("settings.providers.omp.custom.addWithCount", {
    count: draft.models.length,
  });
  if (adding) {
    addProviderLabel = t(
      editingProviderId
        ? "settings.providers.omp.custom.savingProvider"
        : "settings.providers.omp.custom.validating",
    );
  } else if (editingProviderId) {
    addProviderLabel = t("settings.providers.omp.custom.saveProvider");
  }

  return (
    <View style={sheetStyles.formGroup}>
      <Text style={sheetStyles.formLabel}>{t("settings.providers.omp.custom.providerId")}</Text>
      <AdaptiveTextInput
        initialValue={draft.providerId}
        resetKey={`${revision}-provider-id`}
        onChangeText={updateProviderId}
        placeholder="mintcat"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!editingProviderId}
        style={sheetStyles.formInput}
      />
      <Text style={sheetStyles.formLabel}>{t("settings.providers.omp.custom.endpointUrl")}</Text>
      <AdaptiveTextInput
        initialValue={draft.baseUrl}
        resetKey={`${revision}-base-url`}
        onChangeText={updateBaseUrl}
        placeholder="https://api.example.com/v1"
        autoCapitalize="none"
        autoCorrect={false}
        style={sheetStyles.formInput}
      />
      <Text style={sheetStyles.formLabel}>{t("settings.providers.omp.custom.apiKey")}</Text>
      <AdaptiveTextInput
        initialValue={draft.apiKey}
        resetKey={`${revision}-api-key`}
        onChangeText={updateApiKey}
        placeholder="sk-..."
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        style={sheetStyles.formInput}
      />
      <Button
        variant="secondary"
        size="sm"
        leftIcon={RotateCw}
        onPress={handleDiscoverModelsPress}
        disabled={!canDiscover || discovering || adding}
      >
        {t(
          discovering
            ? "settings.providers.omp.custom.fetchingModels"
            : "settings.providers.omp.custom.fetchModels",
        )}
      </Button>
      {discoveredCount !== null ? (
        <Text style={sheetStyles.descriptionInline}>
          {t("settings.providers.omp.custom.modelsConfiguredWithImageDefault", {
            count: discoveredCount,
          })}
        </Text>
      ) : null}
      {hasTextOnlyModels ? (
        <View style={sheetStyles.modelListActions}>
          <Button variant="secondary" size="sm" onPress={enableImageInputForAll}>
            {t("settings.providers.omp.custom.enableImageInputForAll")}
          </Button>
        </View>
      ) : null}
      <View style={sheetStyles.modelList}>
        {draft.models.map((model) => (
          <OmpProviderModelEditor
            key={model.key}
            model={model}
            revision={revision}
            canRemove={draft.models.length > 1}
            onChange={updateModel}
            onRemove={removeModel}
          />
        ))}
      </View>
      <Button variant="secondary" size="sm" leftIcon={Plus} onPress={handleAddModelPress}>
        {t("settings.providers.omp.custom.addAnotherModel")}
      </Button>
      {error ? <Text style={sheetStyles.errorText}>{error}</Text> : null}
      <View style={sheetStyles.formActions}>
        <Button variant="secondary" size="sm" onPress={onCancel} disabled={adding}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          leftIcon={adding ? undefined : Plus}
          onPress={handleAddPress}
          disabled={!canAdd || adding}
        >
          {addProviderLabel}
        </Button>
      </View>
    </View>
  );
}
type OmpManagementTab = "sign-in" | "custom";
interface OmpProviderLoginFlowState {
  flowId: string;
  providerId: string;
  url: string;
  launchUrl?: string;
  instructions?: string;
}

function isCustomOmpProvider(
  provider: OmpProviderManagement["providerModels"][number],
  loginProviderIds: Set<string>,
): boolean {
  return (
    provider.source === "custom" ||
    (provider.source === undefined && !loginProviderIds.has(provider.id))
  );
}

function OmpCustomProvidersTab({
  providers,
  management,
  configYaml,
  saving,
  removingProviderId,
  onOpenAddProvider,
  onRemoveProvider,
  onConfigYamlChange,
  onEditProvider,
  onSave,
}: {
  providers: OmpProviderSummary[];
  management: OmpProviderManagement;
  configYaml: string;
  saving: boolean;
  removingProviderId: string | null;
  onOpenAddProvider: () => void;
  onRemoveProvider: (providerId: string) => void;
  onConfigYamlChange: (configYaml: string) => void;
  onSave: () => void;
  onEditProvider: (providerId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={sheetStyles.tabContent}>
      <View style={sheetStyles.customProviderHeader}>
        <Text style={settingsStyles.sectionHeaderTitle}>
          {t("settings.providers.omp.tabs.custom")}
        </Text>
        <Button
          variant="default"
          size="sm"
          leftIcon={Plus}
          onPress={onOpenAddProvider}
          testID="omp-add-custom-provider"
        >
          {t("settings.providers.omp.custom.add")}
        </Button>
      </View>
      {providers.length > 0 ? (
        <View style={settingsStyles.card}>
          {providers.map((summary) => (
            <OmpProviderSummaryRow
              key={summary.id}
              summary={summary}
              loggingInProviderId={null}
              loggingOutProviderId={null}
              loggingOutCredentialId={null}
              loginFlowActive={false}
              removingProviderId={removingProviderId}
              onLogin={NOOP}
              onEdit={onEditProvider}
              onRemove={onRemoveProvider}
            />
          ))}
        </View>
      ) : (
        <SurfaceCard>
          <Text style={sheetStyles.emptyCardText}>{t("settings.providers.omp.empty.custom")}</Text>
        </SurfaceCard>
      )}
      <View style={sheetStyles.section}>
        <SectionHeader
          title={t("settings.providers.omp.yaml.title")}
          hint={management.configPath}
        />
        <SettingsTextArea
          key={`${management.configPath}:${management.configYaml}`}
          accessibilityLabel={t("settings.providers.omp.yaml.accessibility")}
          value={configYaml}
          onChangeText={onConfigYamlChange}
          testID="omp-models-yaml"
          style={sheetStyles.yamlInput}
        />
        <View style={sheetStyles.advancedActions}>
          <Text style={sheetStyles.mutedText}>{t("settings.providers.omp.yaml.hint")}</Text>
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
    </View>
  );
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
  const { view: providerUsageView } = useProviderUsage(serverId, { enabled: visible });
  const [management, setManagement] = useState<OmpProviderManagement | null>(cachedManagement);
  const [configYaml, setConfigYaml] = useState(cachedManagement?.configYaml ?? "");
  const [activeTab, setActiveTab] = useState<OmpManagementTab>("sign-in");
  const [providerSearchQuery, setProviderSearchQuery] = useState("");
  const [signedInProvidersExpanded, setSignedInProvidersExpanded] = useState(false);
  const [notSignedInProvidersExpanded, setNotSignedInProvidersExpanded] = useState(false);
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

  const showManagement = useCallback((result: OmpProviderManagement) => {
    setManagement(result);
    setConfigYaml(result.configYaml);
  }, []);
  useEffect(() => {
    if (!client) return;
    return client.on("omp.provider.login.completed", ({ payload }) => {
      if (loginStartPendingRef.current) completedLoginFlowsRef.current.add(payload.flowId);
      if (loginFlowRef.current?.flowId !== payload.flowId) return;
      loginFlowRef.current = null;
      setLoginFlow(null);
      setLoginInput("");
      setLoginProviderId(null);
      setError(null);
    });
  }, [client]);
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
      onSaved();
    },
    [onSaved, storeManagement],
  );
  const load = useCallback(
    async (force = false) => {
      if (!client || !supported) return;
      const cachedState = queryClient.getQueryState<OmpProviderManagement>(managementQueryKey);
      if (cachedState?.data) showManagement(cachedState.data);
      if (
        !force &&
        cachedState?.data &&
        Date.now() - cachedState.dataUpdatedAt < OMP_PROVIDER_MANAGEMENT_STALE_TIME_MS
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
              queryFn: () => client.getOmpProviderManagement(),
              staleTime: OMP_PROVIDER_MANAGEMENT_STALE_TIME_MS,
              gcTime: OMP_PROVIDER_MANAGEMENT_GC_TIME_MS,
            }));
      } catch (loadError) {
        if (isCancelledError(loadError)) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        setLoading(false);
      }
    },
    [client, managementQueryKey, queryClient, serverId, showManagement, supported],
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
    setActiveTab("sign-in");
    setProviderSearchQuery("");
    setAddProviderOpen(false);
    setSignedInProvidersExpanded(false);
    setNotSignedInProvidersExpanded(false);
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
        if (completedLoginFlowsRef.current.has(flow.flowId)) return;
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
        await Linking.openURL(flow.launchUrl ?? flow.url).catch((openError) => {
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
    [cancelLoginFlow, client, loginFlow, t],
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
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : String(loginError));
    } finally {
      setLoginProviderId(null);
    }
  }, [applyManagement, client, loginFlow, loginInput]);
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

  const signInProviders = useMemo<OmpProviderSummary[]>(() => {
    if (!management) return [];
    return management.loginProviders
      .map((login) => {
        const provider = management.providerModels.find((candidate) => candidate.id === login.id);
        return {
          id: login.id,
          modelCount: provider?.modelCount ?? 0,
          models: provider?.models,
          login,
        };
      })
      .sort((left, right) =>
        (left.login?.name ?? left.id).localeCompare(right.login?.name ?? right.id),
      );
  }, [management]);
  const signedInProviders = useMemo(
    () => signInProviders.filter((provider) => provider.login?.authenticated),
    [signInProviders],
  );
  const availableSignInProviders = useMemo(
    () =>
      signInProviders.filter(
        (provider) => provider.login?.available && !provider.login.authenticated,
      ),
    [signInProviders],
  );
  const providerSearch = providerSearchQuery.trim();
  const displayedNotSignedInProviders = useMemo(
    () =>
      providerSearch
        ? rankModels(availableSignInProviders, providerSearch, (provider) => [
            provider.login?.name ?? "",
            provider.id,
          ])
        : availableSignInProviders,
    [availableSignInProviders, providerSearch],
  );
  const contextProvider = useMemo(
    () => signInProviders.find((provider) => provider.id === contextProviderId) ?? null,
    [contextProviderId, signInProviders],
  );
  const customProviders = useMemo<OmpProviderSummary[]>(() => {
    if (!management) return [];
    const loginProviderIds = new Set(management.loginProviders.map((provider) => provider.id));
    return management.providerModels
      .filter((provider) => isCustomOmpProvider(provider, loginProviderIds))
      .map((provider) => ({ id: provider.id, modelCount: provider.modelCount }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }, [management]);
  const tabOptions = useMemo(
    () => [
      {
        value: "sign-in" as const,
        label: t("settings.providers.omp.tabs.signIn"),
        testID: "omp-provider-tab-sign-in",
      },
      {
        value: "custom" as const,
        label: t("settings.providers.omp.tabs.custom"),
        testID: "omp-provider-tab-custom",
      },
    ],
    [t],
  );
  const toggleSignedInProviders = useCallback(
    () => setSignedInProvidersExpanded((expanded) => !expanded),
    [],
  );
  const toggleNotSignedInProviders = useCallback(
    () => setNotSignedInProvidersExpanded((expanded) => !expanded),
    [],
  );
  const handleRefreshPress = useCallback(() => void load(true), [load]);
  const handleSavePress = useCallback(() => void save(), [save]);
  const handleFinishLoginPress = useCallback(() => void finishLogin(), [finishLogin]);
  const handleOpenAuthorizationPress = useCallback(() => {
    if (loginFlow) void Linking.openURL(loginFlow.launchUrl ?? loginFlow.url);
  }, [loginFlow]);
  const providerFormHeader = useMemo<SheetHeader>(
    () => ({
      title: t(
        editingProvider
          ? "settings.providers.omp.custom.editTitle"
          : "settings.providers.omp.custom.title",
        editingProvider ? { provider: editingProvider.id } : undefined,
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
    },
    [applyManagement],
  );
  const removeProvider = useCallback(
    async (providerId: string) => {
      if (!client || removingProviderId) return;
      const confirmed = await confirmDialog({
        title: t("settings.providers.omp.custom.removeConfirmTitle", { provider: providerId }),
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
    [applyManagement, client, removingProviderId, t],
  );
  const handleRemoveProvider = useCallback(
    (providerId: string) => void removeProvider(providerId),
    [removeProvider],
  );

  function renderSignedInProviders(): ReactElement | null {
    if (signedInProviders.length === 0) {
      return (
        <SurfaceCard>
          <Text style={sheetStyles.emptyCardText}>
            {t("settings.providers.omp.signInDirectory.noSignedIn")}
          </Text>
        </SurfaceCard>
      );
    }
    if (!signedInProvidersExpanded) {
      return null;
    }
    return (
      <View style={settingsStyles.card}>
        {signedInProviders.map((summary) => (
          <OmpProviderSummaryRow
            key={summary.id}
            summary={summary}
            usages={resolveLoginProviderUsages(providerUsageView, summary.id)}
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
    );
  }

  function renderAvailableProviders(): ReactElement | null {
    if (!notSignedInProvidersExpanded) {
      return null;
    }
    return (
      <View style={sheetStyles.providerDirectorySearch}>
        <AdaptiveTextInput
          initialValue={providerSearchQuery}
          resetKey={`${serverId}:${visible}`}
          onChangeText={setProviderSearchQuery}
          placeholder={t("settings.providers.omp.signInDirectory.searchPlaceholder")}
          accessibilityLabel={t("settings.providers.omp.signInDirectory.searchPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          testID="omp-provider-search"
          style={sheetStyles.formInput}
        />
        {displayedNotSignedInProviders.length > 0 ? (
          <View style={settingsStyles.card}>
            {displayedNotSignedInProviders.map((summary) => (
              <OmpProviderSummaryRow
                key={summary.id}
                summary={summary}
                loggingInProviderId={loginProviderId}
                loginFlowActive={loginFlow !== null}
                loggingOutProviderId={logoutProviderId}
                loggingOutCredentialId={logoutCredentialId}
                onLogin={startLogin}
              />
            ))}
          </View>
        ) : (
          <SurfaceCard>
            <Text style={sheetStyles.emptyCardText}>
              {t("settings.providers.omp.signInDirectory.noMatches")}
            </Text>
          </SurfaceCard>
        )}
      </View>
    );
  }

  function renderLoginFlow(): ReactElement | null {
    if (!loginFlow) {
      return null;
    }
    return (
      <View style={sheetStyles.section}>
        <SectionHeader
          title={t("settings.providers.omp.login.completeTitle", {
            provider: loginFlow.providerId,
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
          </View>
        </SurfaceCard>
      </View>
    );
  }

  function renderManagementTabs(): ReactElement | null {
    if (!management) {
      return null;
    }
    return (
      <>
        <SegmentedControl
          options={tabOptions}
          value={activeTab}
          onValueChange={setActiveTab}
          size="sm"
          testID="omp-provider-tabs"
          style={sheetStyles.managementTabs}
        />
        {activeTab === "sign-in" ? (
          <View style={sheetStyles.tabContent}>
            <View style={sheetStyles.providerDirectorySection}>
              <CollapsibleSectionHeader
                title={t("settings.providers.omp.signInDirectory.signedInTitle")}
                count={signedInProviders.length}
                expanded={signedInProvidersExpanded}
                disabled={signedInProviders.length === 0}
                onPress={toggleSignedInProviders}
                testID="omp-signed-in-providers-toggle"
              />
              {renderSignedInProviders()}
            </View>
            <View style={sheetStyles.providerDirectorySection}>
              <CollapsibleSectionHeader
                title={t("settings.providers.omp.signInDirectory.notSignedInTitle")}
                count={availableSignInProviders.length}
                expanded={notSignedInProvidersExpanded}
                disabled={availableSignInProviders.length === 0}
                onPress={toggleNotSignedInProviders}
                testID="omp-not-signed-in-providers-toggle"
              />
              {renderAvailableProviders()}
            </View>
            {renderLoginFlow()}
          </View>
        ) : (
          <OmpCustomProvidersTab
            providers={customProviders}
            management={management}
            configYaml={configYaml}
            saving={saving}
            removingProviderId={removingProviderId}
            onOpenAddProvider={handleOpenAddProvider}
            onEditProvider={handleOpenEditProvider}
            onRemoveProvider={handleRemoveProvider}
            onConfigYamlChange={setConfigYaml}
            onSave={handleSavePress}
          />
        )}
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
      <>
        <View style={sheetStyles.managementHeader}>
          <SectionHeader title={t("settings.providers.omp.managementTitle")} />
          <Button
            variant="secondary"
            size="sm"
            leftIcon={loading ? undefined : RotateCw}
            onPress={handleRefreshPress}
            disabled={loading}
          >
            {loading ? t("settings.providers.omp.refreshing") : t("settings.providers.omp.refresh")}
          </Button>
        </View>
        {error ? <Text style={sheetStyles.errorText}>{error}</Text> : null}
        {management?.runtimeError ? (
          <SurfaceCard>
            <Text style={sheetStyles.errorText}>{management.runtimeError}</Text>
          </SurfaceCard>
        ) : null}
        {renderManagementTabs()}
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
          visible={contextProvider !== null}
          onClose={handleCloseContextWindow}
          testID="omp-model-context-window-sheet"
          snapPoints={ADD_PROVIDER_SNAP_POINTS}
          contentStyle={sheetStyles.addProviderModalContent}
        >
          {renderContextWindowForm()}
        </AdaptiveModalSheet>
      </>
    );
  }

  return (
    <OmpCodexQuotaServerContext.Provider value={visible ? serverId : null}>
      {renderPanel()}
    </OmpCodexQuotaServerContext.Provider>
  );
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
  managementHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    marginBottom: theme.spacing[3],
  },
  managementTabs: {
    width: "100%",
  },
  tabContent: {
    gap: theme.spacing[4],
    marginTop: theme.spacing[3],
  },
  providerDirectorySection: {
    gap: theme.spacing[2],
  },
  providerDirectorySearch: {
    gap: theme.spacing[2],
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
  customProviderHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
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
  providerSummaryBlock: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  providerSummaryRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  providerSummaryActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  accountList: {
    paddingBottom: theme.spacing[2],
  },
  providerUsage: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[3],
    marginLeft: theme.spacing[4],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  accountRow: {
    flexDirection: "row",
    alignItems: "center",
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
  accountTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  accountNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  accountQuotaWindow: {
    gap: theme.spacing[1],
  },
  accountQuota: {
    gap: theme.spacing[1],
    marginTop: theme.spacing[1],
  },
  accountQuotaHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  accountQuotaLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  accountQuotaStatus: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
  },
  accountQuotaTrack: {
    height: 5,
    width: "100%",
    overflow: "hidden",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  accountQuotaFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
  },
  accountQuotaReset: {
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
  providerSummaryText: {
    flex: 1,
    gap: theme.spacing[1],
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
