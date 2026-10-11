import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { OmpProviderManagement } from "@omp-desktop/protocol/messages";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  refreshOmpAccountQuotaManagement,
  useOmpQuotaClock,
  useOmpQuotaReachedRefresh,
} from "@/hooks/use-omp-account-quota";
import {
  formatOmpQuotaCountdown,
  formatOmpQuotaResetTime,
  isOmpCodexResetCreditUsable,
  shouldShowOmpFiveHourQuota,
} from "./omp-provider-quota";

type Account = NonNullable<OmpProviderManagement["loginProviders"][number]["accounts"]>[number];
type Quota = NonNullable<Account["quota"]>;
type Credits = NonNullable<Quota["resetCredits"]>;
type Credit = Credits["credits"][number];
interface CreditAttempt {
  requestId: string;
  busy: boolean;
  consumed: boolean;
}
export const OmpQuotaServerContext = createContext<string | null>(null);
const attempts = new Map<string, CreditAttempt>();

export function OmpQuotaCountdown({ resetsAt }: { resetsAt?: string | null }) {
  const { t } = useTranslation();
  const now = useOmpQuotaClock(Boolean(resetsAt));
  const countdown = formatOmpQuotaCountdown(resetsAt, now, {
    day: t("settings.providers.omp.codexQuota.day"),
    hour: t("settings.providers.omp.codexQuota.hour"),
    minute: t("settings.providers.omp.codexQuota.minute"),
  });
  if (countdown === null) return null;
  return (
    <Text style={styles.muted}>
      {countdown === ""
        ? t("settings.providers.omp.codexQuota.awaitingRefresh")
        : t("settings.providers.omp.codexQuota.resetsIn", { time: countdown })}
    </Text>
  );
}

function resolveSubscriptionState(
  subscription: Quota["subscription"],
  date: string | null,
  countdown: string | null,
) {
  if (subscription?.status === "none") return "none";
  if (subscription?.status === "unavailable") {
    if (subscription.error) return "error";
    return subscription.unavailableReason === "unsupported" ? "unsupported" : "unavailable";
  }
  if (!date) return "unavailable";
  if (subscription?.status === "expired" || countdown === "") return "expired";
  return "active";
}

function OmpCodexSubscriptionDetails({
  subscription,
  now,
}: {
  subscription: Quota["subscription"];
  now: number;
}) {
  const { t, i18n } = useTranslation();
  const date = formatOmpQuotaResetTime(subscription?.expiresAt, i18n.language);
  const countdown = formatOmpQuotaCountdown(subscription?.expiresAt, now, {
    day: t("settings.providers.omp.codexQuota.day"),
    hour: t("settings.providers.omp.codexQuota.hour"),
    minute: t("settings.providers.omp.codexQuota.minute"),
  });
  const state = resolveSubscriptionState(subscription, date, countdown);
  return (
    <>
      <Text style={styles.title}>{t("settings.providers.omp.codexQuota.subscription")}</Text>
      <Text style={styles.muted}>
        {t(`settings.providers.omp.codexQuota.subscription_${state}`)}
      </Text>
      {subscription?.error && state === "error" ? (
        <Text accessibilityRole="alert" style={styles.muted}>
          {subscription.error}
        </Text>
      ) : null}
      {state === "unavailable" || state === "unsupported" || state === "error" ? (
        <Text style={styles.muted}>
          {t("settings.providers.omp.codexQuota.subscriptionUnavailableNote")}
        </Text>
      ) : null}
      {date && (state === "active" || state === "expired") ? (
        <>
          <Text style={styles.muted}>
            {t("settings.providers.omp.codexQuota.expiry", { time: date })}
          </Text>
          {state === "active" && countdown ? (
            <Text style={styles.muted}>
              {t("settings.providers.omp.codexQuota.remaining", { time: countdown })}
            </Text>
          ) : null}
          <Text style={styles.muted}>
            {t(
              subscription?.source === "account"
                ? "settings.providers.omp.codexQuota.subscriptionAccountNote"
                : "settings.providers.omp.codexQuota.subscriptionNote",
            )}
          </Text>
        </>
      ) : null}
    </>
  );
}

function isAvailableCredit(credits: Quota["resetCredits"], credit: Credit, now: number) {
  return credits?.status === "available" && isOmpCodexResetCreditUsable(credit, now);
}

function isLatestCreditUsable(account: Account, creditId: string) {
  const credits = account.quota?.resetCredits;
  const credit = credits?.credits.find((item) => item.id === creditId);
  return Boolean(credit && isAvailableCredit(credits, credit, Date.now()));
}

function startCreditAttempt(key: string) {
  const existing = attempts.get(key);
  if (existing?.busy || existing?.consumed) return null;
  const attempt = existing ?? { requestId: crypto.randomUUID(), busy: false, consumed: false };
  attempts.set(key, attempt);
  attempt.busy = true;
  return attempt;
}

function formatConsumeFailure(error: unknown, outcome: string | null, t: TFunction) {
  const message = error instanceof Error ? error.message : String(error);
  if (outcome) {
    return `${outcome} ${t("settings.providers.omp.codexQuota.refreshFailed", { error: message })}`;
  }
  return t("settings.providers.omp.codexQuota.consumeFailed", { error: message });
}

function useConsumeOmpCodexResetCredit(
  account: Account,
  accountLabel: string,
  serverId: string | null,
  supported: boolean,
) {
  const client = useHostRuntimeClient(serverId ?? "");
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const lock = useRef(false);
  const currentAccount = useRef(account);
  currentAccount.current = account;
  const currentServerId = useRef(serverId);
  currentServerId.current = serverId;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const confirmConsumption = useCallback(
    (credit: Credit) =>
      confirmDialog({
        title: t("settings.providers.omp.codexQuota.confirmTitle"),
        message: t("settings.providers.omp.codexQuota.confirmMessage", {
          account: accountLabel,
          card: credit.title || credit.id,
          id: credit.id,
          type: credit.resetType,
          effect: t(
            shouldShowOmpFiveHourQuota(account.quota)
              ? "settings.providers.omp.codexQuota.fullEffect"
              : "settings.providers.omp.codexQuota.proEffect",
          ),
        }),
        confirmLabel: t("settings.providers.omp.codexQuota.consume"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      }),
    [account.quota, accountLabel, t],
  );
  const isCurrentAccount = useCallback(
    () =>
      mounted.current &&
      currentServerId.current === serverId &&
      currentAccount.current.credentialId === account.credentialId,
    [account.credentialId, serverId],
  );
  const consume = useCallback(
    async (credit: Credit) => {
      if (
        !client ||
        !serverId ||
        !supported ||
        lock.current ||
        !isAvailableCredit(account.quota?.resetCredits, credit, Date.now())
      )
        return;
      const key = `${serverId}:${account.credentialId}:${credit.id}`;
      const attempt = startCreditAttempt(key);
      if (!attempt) return;
      lock.current = true;
      setBusy(true);
      setFeedback(null);
      let outcome: string | null = null;
      try {
        const confirmed = await confirmConsumption(credit);
        if (!confirmed || !isCurrentAccount()) return;
        if (!isLatestCreditUsable(currentAccount.current, credit.id)) {
          setFeedback(t("settings.providers.omp.codexQuota.no_credit"));
          return;
        }
        const result = await client.consumeOmpCodexResetCredit(
          account.credentialId,
          credit.id,
          attempt.requestId,
        );
        attempt.consumed = result.code === "reset" || result.code === "already_redeemed";
        if (!attempt.consumed) attempts.delete(key);
        outcome = t(`settings.providers.omp.codexQuota.${result.code}`, {
          count: result.windowsReset,
        });
        if (mounted.current) setFeedback(outcome);
        await refreshOmpAccountQuotaManagement(queryClient, client, serverId, true);
      } catch (error) {
        if (mounted.current) setFeedback(formatConsumeFailure(error, outcome, t));
        // Preserve requestId on an uncertain response so a manual retry remains idempotent.
      } finally {
        attempt.busy = false;
        lock.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [account, client, confirmConsumption, isCurrentAccount, queryClient, serverId, supported, t],
  );
  return { consume, busy, feedback };
}

function formatCreditsSummary(credits: Quota["resetCredits"], t: TFunction) {
  if (credits?.status !== "available") {
    return t(
      credits?.status === "error"
        ? "settings.providers.omp.codexQuota.cardsError"
        : "settings.providers.omp.codexQuota.cardsUnavailable",
    );
  }
  if (credits.availableCount === null) return t("settings.providers.omp.codexQuota.countUnknown");
  return t("settings.providers.omp.codexQuota.availableCount", { count: credits.availableCount });
}

function formatCreditExpiry(credit: Credit, language: string, t: TFunction) {
  if (credit.expiresAt === null) return t("settings.providers.omp.codexQuota.noExpiry");
  const expiry = formatOmpQuotaResetTime(credit.expiresAt, language);
  if (expiry) return t("settings.providers.omp.codexQuota.expiry", { time: expiry });
  return t("settings.providers.omp.codexQuota.expiryUnknown");
}

function resolveCreditStatus(credit: Credit, consumed: boolean, usable: boolean, now: number) {
  if (
    credit.status === "expired" ||
    (credit.expiresAt !== null && Date.parse(credit.expiresAt) <= now)
  )
    return "settings.providers.omp.codexQuota.cardExpired";
  if (consumed || ["used", "consumed", "redeemed"].includes(credit.status))
    return "settings.providers.omp.codexQuota.cardUsed";
  if (usable) return "settings.providers.omp.codexQuota.cardAvailable";
  return "settings.providers.omp.codexQuota.cardUnusable";
}

function OmpCodexResetCreditCard({
  credit,
  credentialId,
  serverId,
  credits,
  now,
  supported,
  busy,
  consume,
}: {
  credit: Credit;
  credentialId: Account["credentialId"];
  serverId: string | null;
  credits: Credits;
  now: number;
  supported: boolean;
  busy: boolean;
  consume: (credit: Credit) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const usable = isAvailableCredit(credits, credit, now);
  const attempt = attempts.get(`${serverId}:${credentialId}:${credit.id}`);
  const handleConsume = useCallback(() => void consume(credit), [consume, credit]);
  return (
    <View style={styles.card} testID={`omp-reset-credit-${credentialId}-${credit.id}`}>
      <Text style={styles.title}>{credit.title || credit.id}</Text>
      <Text selectable style={styles.muted}>
        {t("settings.providers.omp.codexQuota.cardMetadata", {
          id: credit.id,
          type: credit.resetType,
          status: credit.status,
        })}
      </Text>
      {credit.description ? <Text style={styles.muted}>{credit.description}</Text> : null}
      <Text style={styles.muted}>
        {t("settings.providers.omp.codexQuota.granted", {
          time:
            formatOmpQuotaResetTime(credit.grantedAt, i18n.language) ||
            t("settings.providers.omp.contextWindow.unknown"),
        })}
      </Text>
      <Text style={styles.muted}>{formatCreditExpiry(credit, i18n.language, t)}</Text>
      <Text style={styles.muted}>
        {t(resolveCreditStatus(credit, attempt?.consumed === true, usable, now))}
      </Text>
      {credit.resetType !== "codex_rate_limits" ? (
        <Text style={styles.muted}>{t("settings.providers.omp.codexQuota.unknownType")}</Text>
      ) : null}
      <Button
        size="sm"
        variant="secondary"
        disabled={!supported || !usable || busy || attempt?.busy || attempt?.consumed}
        onPress={handleConsume}
        testID={`omp-reset-credit-consume-${credentialId}-${credit.id}`}
      >
        {t(
          busy
            ? "settings.providers.omp.codexQuota.consuming"
            : "settings.providers.omp.codexQuota.consume",
        )}
      </Button>
    </View>
  );
}

function OmpCodexResetCreditsDetails({
  account,
  accountLabel,
  serverId,
  now,
}: {
  account: Account;
  accountLabel: string;
  serverId: string | null;
  now: number;
}) {
  const { t } = useTranslation();
  const supported = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.ompCodexResetCredits === true,
  );
  const { busy, feedback, consume } = useConsumeOmpCodexResetCredit(
    account,
    accountLabel,
    serverId,
    supported,
  );
  const credits = account.quota?.resetCredits;
  return (
    <>
      <Text style={styles.title}>{t("settings.providers.omp.codexQuota.cards")}</Text>
      <Text style={styles.muted}>{formatCreditsSummary(credits, t)}</Text>
      {credits?.error ? <Text style={styles.muted}>{credits.error}</Text> : null}
      {credits?.status === "available" && credits.credits.length === 0 ? (
        <Text style={styles.muted}>{t("settings.providers.omp.codexQuota.empty")}</Text>
      ) : null}
      {credits?.credits.map((credit) => (
        <OmpCodexResetCreditCard
          key={credit.id}
          credit={credit}
          credentialId={account.credentialId}
          serverId={serverId}
          credits={credits}
          now={now}
          supported={supported}
          busy={busy}
          consume={consume}
        />
      ))}
      {!supported ? (
        <Text style={styles.muted}>{t("settings.providers.omp.codexQuota.unsupported")}</Text>
      ) : null}
      {feedback ? (
        <Text
          accessibilityRole="alert"
          style={styles.muted}
          testID={`omp-reset-feedback-${account.credentialId}`}
        >
          {feedback}
        </Text>
      ) : null}
    </>
  );
}

export function OmpCodexQuotaDetails({
  account,
  accountLabel,
}: {
  account: Account;
  accountLabel: string;
}) {
  const serverId = useContext(OmpQuotaServerContext);
  const now = useOmpQuotaClock(Boolean(serverId));
  useOmpQuotaReachedRefresh(
    serverId,
    [
      account.quota?.weeklyResetsAt,
      shouldShowOmpFiveHourQuota(account.quota) ? account.quota?.fiveHourResetsAt : null,
    ],
    now,
  );
  return (
    <View style={styles.details}>
      <OmpCodexSubscriptionDetails subscription={account.quota?.subscription} now={now} />
      <OmpCodexResetCreditsDetails
        account={account}
        accountLabel={accountLabel}
        serverId={serverId}
        now={now}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  details: { gap: theme.spacing[2], marginTop: theme.spacing[3] },
  card: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
  },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, fontWeight: "600" },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
