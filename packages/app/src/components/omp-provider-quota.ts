export function resolveOmpRemainingQuotaPct(usedPct: number | null | undefined): number | null {
  if (typeof usedPct !== "number" || !Number.isFinite(usedPct)) {
    return null;
  }
  const normalizedUsedPct = Math.max(0, Math.min(100, usedPct));
  return 100 - normalizedUsedPct;
}

export function formatOmpQuotaResetTime(
  iso: string | null | undefined,
  locale: string,
): string | null {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toLocaleString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function shouldShowOmpFiveHourQuota(planLabel: string | null | undefined): boolean {
  return planLabel?.trim().toLowerCase() !== "pro";
}

export function formatOmpQuotaCountdown(
  iso: string | null | undefined,
  now: number,
  units: { day: string; hour: string; minute: string } = { day: "d", hour: "h", minute: "min" },
): string | null {
  const timestamp = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(timestamp)) return null;
  const minutes = Math.ceil(Math.max(0, timestamp - now) / 60_000);
  if (minutes === 0) return "";
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}${units.day}${hours % 24}${units.hour}`;
  return `${hours}${units.hour}${minutes % 60}${units.minute}`;
}

export function isOmpCodexResetCreditUsable(
  credit: { status: string; resetType: string; expiresAt: string | null },
  now: number,
): boolean {
  if (credit.status !== "available" || credit.resetType !== "codex_rate_limits") return false;
  if (credit.expiresAt === null) return true;
  const expiry = Date.parse(credit.expiresAt);
  return Number.isFinite(expiry) && expiry > now;
}
