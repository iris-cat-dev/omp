import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { ChevronRight, TextSearch } from "lucide-react-native";
import type { AgentUsage } from "@omp-desktop/protocol/agent-types";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { ProviderUsageTooltipSection } from "@/provider-usage/tooltip-section";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { useOmpProviderAccountQuota } from "@/hooks/use-omp-account-quota";
import { useShowPersistentActions } from "@/hooks/use-fine-pointer";
import {
  buildOmpAccountProviderUsage,
  createOmpAccountUsageCopy,
  mergeOmpAccountProviderUsage,
} from "@/provider-usage/omp-account";
import { selectOmpQuotaAccounts } from "@/components/omp-provider-accounts";
import {
  getContextProgressColor,
  getContextWindowReading,
  hasSessionCache,
  type ContextWindowReading,
} from "./context-window-meter.utils";
import { OmpClaudeQuotaEntry } from "./omp-claude-quota-entry";
import { ContextUsageDetails } from "./context-usage-details";

interface ContextWindowMeterProps {
  usage: AgentUsage;
  showPercentage?: boolean;
  serverId?: string;
  /** The active model's provider namespace, including configured OMP providers. */
  provider?: string | null;
  accountCredentialId?: string | null;
  accountCredentialIds?: readonly string[];
  /** Reserve the meter footprint and show a loading ring while usage is pending. */
  pending?: boolean;
  /** Optional glyph envelope for icon-toolbar alignment. */
  glyphSize?: number;
  onOpenPromptAnalysis?: () => void;
}

const SVG_SIZE = 14;
const COMPACT_SVG_SIZE = 12;
const COMPACT_CENTER = COMPACT_SVG_SIZE / 2;
const COMPACT_RADIUS = 5;
const STROKE_WIDTH = 2;
const COMPACT_STROKE_WIDTH = 1.75;
const COMPACT_CIRCUMFERENCE = 2 * Math.PI * COMPACT_RADIUS;

function getMeterGeometry(showPercentage: boolean, glyphSize?: number) {
  if (showPercentage) {
    return {
      svgSize: COMPACT_SVG_SIZE,
      center: COMPACT_CENTER,
      radius: COMPACT_RADIUS,
      strokeWidth: COMPACT_STROKE_WIDTH,
      circumference: COMPACT_CIRCUMFERENCE,
      containerStyle: styles.containerWithLabel,
    };
  }
  const resolvedSize = glyphSize ?? SVG_SIZE;
  const resolvedStrokeWidth = glyphSize ? 2 : STROKE_WIDTH;
  return {
    svgSize: resolvedSize,
    center: resolvedSize / 2,
    radius: (resolvedSize - resolvedStrokeWidth) / 2,
    strokeWidth: resolvedStrokeWidth,
    circumference: Math.PI * (resolvedSize - resolvedStrokeWidth),
    containerStyle: styles.container,
  };
}

export function ContextWindowMeter(props: ContextWindowMeterProps) {
  if (props.provider === "anthropic") return <OmpClaudeQuotaEntry {...props} />;
  const reading = getContextWindowReading(props.usage);
  if (!reading && !props.pending && !hasSessionCache(props.usage)) return null;
  return <TokenContextWindowMeter {...props} reading={reading} />;
}

function TokenContextWindowMeter({
  usage,
  reading,
  showPercentage = false,
  serverId,
  provider,
  accountCredentialId,
  accountCredentialIds,
  glyphSize,
  onOpenPromptAnalysis,
}: ContextWindowMeterProps & { reading: ContextWindowReading | null }) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const viewport = useWindowDimensions();
  const tooltipWidth = Math.min(320, viewport.width - 16);
  const showPersistentActions = useShowPersistentActions();
  const quotaProviderId = provider === "openai-codex" ? provider : null;
  const { view: baseUsageView, refresh: refreshProviderUsage } = useProviderUsage(
    serverId ?? null,
    { enabled: isTooltipOpen && !quotaProviderId, providerId: provider ?? undefined },
  );
  const accountQuota = useOmpProviderAccountQuota(serverId, quotaProviderId, isTooltipOpen);
  const providerUsageView = useMemo(() => {
    if (!quotaProviderId) return baseUsageView;
    const accountUsage = buildOmpAccountProviderUsage(
      {
        ...accountQuota,
        accounts: selectOmpQuotaAccounts(
          accountQuota.accounts,
          accountCredentialId ? Number(accountCredentialId) : null,
          accountCredentialIds,
        ),
      },
      createOmpAccountUsageCopy(quotaProviderId, t),
    );
    return mergeOmpAccountProviderUsage(
      { kind: "loading" },
      accountUsage,
      accountQuota.loading,
      accountQuota.updatedAt,
    );
  }, [accountCredentialId, accountCredentialIds, accountQuota, baseUsageView, quotaProviderId, t]);
  const handleTooltipOpenChange = useCallback(
    (nextOpen: boolean) => {
      setIsTooltipOpen(nextOpen);
      if (nextOpen) {
        if (!quotaProviderId) void refreshProviderUsage().catch(() => {});
      }
    },
    [quotaProviderId, refreshProviderUsage],
  );
  const openPromptAnalysis = useCallback(() => {
    setIsTooltipOpen(false);
    onOpenPromptAnalysis?.();
  }, [onOpenPromptAnalysis]);

  const geometry = getMeterGeometry(showPercentage, glyphSize);

  // No usage yet: reserve the footprint with a track-only ring while a session is
  // active so the real ring fades in without shifting siblings. Render nothing when
  // no usage is expected.
  if (!reading && !hasSessionCache(usage)) {
    return (
      <View style={geometry.containerStyle}>
        <Svg
          width={geometry.svgSize}
          height={geometry.svgSize}
          viewBox={`0 0 ${geometry.svgSize} ${geometry.svgSize}`}
          style={styles.svg}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Circle
            cx={geometry.center}
            cy={geometry.center}
            r={geometry.radius}
            fill="none"
            stroke={theme.colors.surface3}
            strokeWidth={geometry.strokeWidth}
          />
        </Svg>
        {showPercentage ? <View style={styles.skeletonLabel} /> : null}
      </View>
    );
  }

  const roundedPercentage = reading ? Math.round(reading.percentage) : null;
  const { svgSize, center, radius, strokeWidth, circumference, containerStyle } = geometry;
  const dashOffset = reading ? circumference * (1 - Math.min(reading.percentage, 100) / 100) : 0;

  return (
    <Tooltip
      open={isTooltipOpen}
      onOpenChange={handleTooltipOpenChange}
      delayDuration={0}
      interactive
      openOnPress={showPersistentActions}
      enabledOnDesktop
      enabledOnMobile
    >
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          style={containerStyle}
          testID="context-window-meter"
          accessibilityRole="button"
          accessibilityLabel={
            roundedPercentage === null
              ? t("contextWindow.sessionUsage")
              : t("contextWindow.accessibility", { percentage: roundedPercentage })
          }
          accessibilityHint={t("contextWindow.title")}
          hitSlop={showPersistentActions ? 6 : undefined}
        >
          <Svg
            width={svgSize}
            height={svgSize}
            viewBox={`0 0 ${svgSize} ${svgSize}`}
            style={styles.svg}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={theme.colors.surface3}
              strokeWidth={strokeWidth}
            />
            {reading ? (
              <Circle
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                stroke={getContextProgressColor(reading.percentage, theme)}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
              />
            ) : null}
          </Svg>
          {showPercentage ? (
            <Text style={styles.percentageLabel}>
              {roundedPercentage === null ? "—" : `${roundedPercentage}%`}
            </Text>
          ) : null}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="center"
        offset={8}
        maxWidth={tooltipWidth}
        style={[styles.tooltipSurface, { width: tooltipWidth, maxHeight: viewport.height - 16 }]}
        testID="context-window-tooltip"
      >
        <ScrollView
          bounces={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.tooltipContent}
        >
          <ContextUsageDetails usage={usage} reading={reading} />
          <ProviderUsageTooltipSection view={providerUsageView} activeProviderId={provider} />
          {onOpenPromptAnalysis ? (
            <View style={styles.tooltipAction}>
              <Button
                size="sm"
                variant="ghost"
                style={styles.actionRow}
                textStyle={styles.actionLabel}
                leftIcon={TextSearch}
                trailing={
                  <ChevronRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
                }
                onPress={openPromptAnalysis}
                accessibilityLabel={t("promptAnalysis.title")}
                testID="context-window-prompt-analysis"
              >
                {t("promptAnalysis.title")}
              </Button>
            </View>
          ) : null}
        </ScrollView>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  containerWithLabel: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
  },
  svg: {
    transform: [{ rotate: "-90deg" }],
  },
  percentageLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  skeletonLabel: {
    width: 22,
    height: theme.fontSize.base,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  tooltipSurface: {
    paddingVertical: 0,
    paddingHorizontal: 0,
    overflow: "hidden",
  },
  tooltipContent: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
  },
  tooltipAction: {
    borderTopWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    paddingTop: theme.spacing[0.5],
  },
  actionRow: { justifyContent: "flex-start", paddingHorizontal: theme.spacing[1.5], gap: theme.spacing[3] },
  actionLabel: { flex: 1 },
}));
