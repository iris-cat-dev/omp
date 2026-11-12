import React, { memo, useCallback, useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { SPACING, type Theme } from "@/styles/theme";
import type { TurnTiming } from "@/timeline/turn-time";
import { TurnFileChangesBar } from "./turn-file-changes-bar";
import type { TurnTokenStats } from "./turn-token-stats";
import { formatTokenCount } from "./turn-token-stats";
import type { PluginTurnMetricProps } from "@omp-desktop/plugin";
import { PluginTurnMetrics } from "@/plugins/turn-metrics";
import type { StreamItem } from "@/types/stream";
import {
  collectAssistantResponseContentForStreamRenderStrategy,
  type StreamStrategy,
} from "./strategy";
import { resolveAssistantTurnForkBoundary, type AssistantTurnForkBoundary } from "./turn-boundary";
import {
  AssistantTurnFooter,
  LiveElapsed,
  ShimmerText,
  STREAM_METADATA_FONT_SIZE,
} from "@/components/message";
import type { TurnFooterHost } from "./layout";
import { SyncedLoader } from "@/components/synced-loader";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useSettings } from "@/hooks/use-settings";

const ThemedSyncedLoader = withUnistyles(SyncedLoader);
const workingIndicatorColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
export const TURN_FOOTER_BOTTOM_SPACING = SPACING[8];

export type TurnContentStrategy = StreamStrategy;
export type AssistantTurnForkHandler = (input: {
  boundary: AssistantTurnForkBoundary;
}) => Promise<void> | void;

export const TurnFooter = memo(function TurnFooter({
  isRunning,
  inFlightTurnStartedAt,
  metricProps,
  workingMessage,
  host,
  strategy,
  supportsTimelineCursor,
  turnTokenStats,
  onOpenFile,
  onRestoreFile,
  onForkAssistantTurn,
}: {
  isRunning: boolean;
  inFlightTurnStartedAt: Date | null;
  metricProps: PluginTurnMetricProps;
  workingMessage?: string;
  host: TurnFooterHost | null;
  strategy: TurnContentStrategy;
  supportsTimelineCursor: boolean;
  turnTokenStats?: TurnTokenStats | null;
  onOpenFile?: (path: string) => void;
  onRestoreFile?: (path: string) => void;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}) {
  if (isRunning) {
    return (
      <TurnFooterRow>
        <RunningTurnFooter
          inFlightTurnStartedAt={inFlightTurnStartedAt}
          metricProps={metricProps}
          workingMessage={workingMessage}
        />
      </TurnFooterRow>
    );
  }
  if (!host) {
    return null;
  }
  return (
    <CompletedTurnFooterRow
      strategy={strategy}
      items={host.items}
      rawItems={host.rawItems}
      timing={host.timing}
      startIndex={host.startIndex}
      supportsTimelineCursor={supportsTimelineCursor}
      turnTokenStats={turnTokenStats}
      metricProps={metricProps}
      onOpenFile={onOpenFile}
      onRestoreFile={onRestoreFile}
      onForkAssistantTurn={onForkAssistantTurn}
    />
  );
});

export const CompletedTurnFooterRow = memo(function CompletedTurnFooterRow({
  strategy,
  items,
  rawItems,
  timing,
  startIndex,
  supportsTimelineCursor,
  turnTokenStats,
  metricProps,
  onOpenFile,
  onRestoreFile,
  onForkAssistantTurn,
}: {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  rawItems?: StreamItem[] | null;
  timing?: TurnTiming;
  startIndex: number;
  supportsTimelineCursor: boolean;
  turnTokenStats?: TurnTokenStats | null;
  metricProps?: PluginTurnMetricProps;
  onOpenFile?: (path: string) => void;
  onRestoreFile?: (path: string) => void;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}) {
  const showTurnFileChanges = useSettings((settings) => settings.showTurnFileChanges);
  return (
    <TurnFooterRow>
      <View style={stylesheet.completedTurnFooterSlot}>
        {showTurnFileChanges ? (
          <TurnFileChangesBar
            items={items}
            rawItems={rawItems}
            startIndex={startIndex}
            onOpenFile={onOpenFile}
            onRestoreFile={onRestoreFile}
          />
        ) : null}
        <CompletedTurnFooter
          strategy={strategy}
          items={items}
          timing={timing}
          startIndex={startIndex}
          supportsTimelineCursor={supportsTimelineCursor}
          turnTokenStats={turnTokenStats}
          metricProps={metricProps}
          onForkAssistantTurn={onForkAssistantTurn}
        />
      </View>
    </TurnFooterRow>
  );
});

const WorkingIndicator = memo(function WorkingIndicator({
  inFlightTurnStartedAt = null,
  metricProps,
  workingMessage,
}: {
  inFlightTurnStartedAt?: Date | null;
  metricProps: PluginTurnMetricProps;
  workingMessage?: string;
}) {
  const active = useRetainedPanelActive();
  return (
    <View style={stylesheet.turnFooterContent}>
      <View style={stylesheet.workingLoader}>
        <ThemedSyncedLoader size={14} uniProps={workingIndicatorColorMapping} />
      </View>
      {workingMessage ? (
        <ShimmerText
          label={workingMessage}
          style={stylesheet.workingMessage}
          testID="turn-working-message"
        />
      ) : null}
      {inFlightTurnStartedAt ? (
        <LiveElapsed
          startedAt={inFlightTurnStartedAt}
          active={active}
          style={stylesheet.workingElapsed}
          testID="turn-working-elapsed"
        />
      ) : null}
      <PluginTurnMetrics {...metricProps} />
    </View>
  );
});

function RunningTurnFooter({
  inFlightTurnStartedAt,
  metricProps,
  workingMessage,
}: {
  inFlightTurnStartedAt: Date | null;
  metricProps: PluginTurnMetricProps;
  workingMessage?: string;
}) {
  return (
    <View style={stylesheet.turnFooterSlot} testID="turn-working-indicator">
      <WorkingIndicator
        inFlightTurnStartedAt={inFlightTurnStartedAt}
        metricProps={metricProps}
        workingMessage={workingMessage}
      />
    </View>
  );
}

function CompletedTurnFooter({
  strategy,
  items,
  timing,
  startIndex,
  supportsTimelineCursor,
  turnTokenStats,
  metricProps,
  onForkAssistantTurn,
}: {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  timing?: TurnTiming;
  startIndex: number;
  supportsTimelineCursor: boolean;
  turnTokenStats?: TurnTokenStats | null;
  metricProps?: PluginTurnMetricProps;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}) {
  const getContent = useCallback(
    () =>
      collectAssistantResponseContentForStreamRenderStrategy({
        strategy,
        items,
        startIndex,
      }),
    [strategy, items, startIndex],
  );
  const boundary = resolveAssistantTurnForkBoundary({
    items,
    startIndex,
    supportsTimelineCursor,
  });
  const handleFork = useCallback(() => {
    if (!boundary) {
      return;
    }
    return onForkAssistantTurn?.({ boundary });
  }, [boundary, onForkAssistantTurn]);
  return (
    <View style={stylesheet.turnFooterSlot}>
      <AssistantTurnFooter
        getContent={getContent}
        completedAt={timing?.completedAt}
        durationMs={timing?.durationMs}
        tokenTotalLabel={turnTokenStats ? formatTokenCount(turnTokenStats.totalTokens) : null}
        metrics={metricProps ? <PluginTurnMetrics {...metricProps} /> : null}
        onFork={boundary && onForkAssistantTurn ? handleFork : undefined}
      />
    </View>
  );
}

function TurnFooterRow({ children }: { children: ReactNode }) {
  const rowStyle = useMemo(() => [stylesheet.streamItemWrapper, stylesheet.turnFooterRow], []);
  return <View style={rowStyle}>{children}</View>;
}

const stylesheet = StyleSheet.create((theme) => ({
  streamItemWrapper: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
  turnFooterRow: {
    marginTop: theme.spacing[2] + 5,
  },
  completedTurnFooterSlot: {
    width: "100%",
  },
  turnFooterSlot: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    maxWidth: "100%",
    minWidth: 0,
    flexShrink: 1,
    minHeight: 24,
    paddingBottom: TURN_FOOTER_BOTTOM_SPACING,
  },
  turnFooterContent: {
    height: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: theme.spacing[3],
    maxWidth: "100%",
    minWidth: 0,
    flexShrink: 1,
  },
  workingElapsed: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  },
  workingLoader: {
    marginStart: -2,
    flexShrink: 0,
  },
  workingMessage: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
    textAlign: "auto",
    minWidth: 0,
    flexShrink: 1,
  },
}));
