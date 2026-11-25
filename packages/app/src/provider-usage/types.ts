import type {
  OmpProviderAccountQuota,
  ProviderUsage as ProtocolProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
  ProviderUsageListResponseMessage,
  ProviderUsageStatus,
  ProviderUsageTone,
  ProviderUsageWindow as ProtocolProviderUsageWindow,
} from "@omp-desktop/protocol/messages";

export type { ProviderUsageBalance, ProviderUsageDetail, ProviderUsageStatus, ProviderUsageTone };

export type ProviderUsageWindow = ProtocolProviderUsageWindow & {
  percentageDisplay?: "used" | "remaining";
  limitReached?: boolean;
};

export type ProviderUsage = Omit<ProtocolProviderUsage, "windows"> & {
  accountLabel?: string;
  windows: ProviderUsageWindow[];
  extraUsage?: OmpProviderAccountQuota["extraUsage"];
  accountQuota?: OmpProviderAccountQuota;
};

export type ProviderUsageBalanceUnit = ProviderUsageBalance["unit"];
export type ProviderUsageListPayload = Omit<
  ProviderUsageListResponseMessage["payload"],
  "providers" | "requestId"
> & {
  providers: ProviderUsage[];
};

export type ProviderUsageView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; payload: ProviderUsageListPayload; isRefreshing: boolean };
