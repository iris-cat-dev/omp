import React, { memo, useCallback, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { SPACING, type Theme } from "@/styles/theme";
import type { TurnTiming } from "@/timeline/turn-time";
import { TurnFileChangesBar } from "./turn-file-changes-bar";
import type { TurnTokenStats } from "./turn-token-stats";
import { formatTokenCount } from "./turn-token-stats";
import { formatOutputTokenSpeed } from "./token-output-speed";
import type { StreamItem } from "@/types/stream";
import {
  collectAssistantResponseContentForStreamRenderStrategy,
  type StreamStrategy,
} from "./strategy";
import { resolveAssistantTurnForkBoundary, type AssistantTurnForkBoundary } from "./turn-boundary";
import { AssistantTurnFooter, LiveElapsed, STREAM_METADATA_FONT_SIZE } from "@/components/message";
import type { TurnFooterHost } from "./layout";
import { AssistantForkButton } from "@/components/assistant-fork-button";
import { SyncedLoader } from "@/components/synced-loader";
import { useRetainedPanelActive } from "@/components/retained-panel";

const ThemedSyncedLoader = withUnistyles(SyncedLoader);
const workingIndicatorColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
export const TURN_FOOTER_BOTTOM_SPACING = SPACING[8];

export type TurnContentStrategy = StreamStrategy;
export type AssistantTurnForkHandler = (input: {
  boundary: AssistantTurnForkBoundary;
}) => Promise<void> | void;
/**
 * Fork handler for the turn that is still streaming. It deliberately takes no
 * boundary: `selectForkContextRows` projects the entire timeline when neither
 * boundary field is given, which is what captures the partially streamed text
 * the user is watching. Pinning a boundary here would silently drop the live
 * response — the opposite of what a fork button next to the loader promises.
 *
 * Kept separate from `AssistantTurnForkHandler` (whose `boundary` stays
 * required) so the compiler keeps enforcing that completed turns always pin one.
 */
export type InFlightTurnForkHandler = () => Promise<void> | void;

export const TurnFooter = memo(function TurnFooter({
  isRunning,
  inFlightTurnStartedAt,
  outputTokenSpeed,
  host,
  strategy,
  supportsTimelineCursor,
  turnTokenStats,
  onOpenFile,
  onRestoreFile,
  onForkAssistantTurn,
  onForkInFlightTurn,
}: {
  isRunning: boolean;
  inFlightTurnStartedAt: Date | null;
  outputTokenSpeed: number | null;
  host: TurnFooterHost | null;
  strategy: TurnContentStrategy;
  supportsTimelineCursor: boolean;
  turnTokenStats?: TurnTokenStats | null;
  onOpenFile?: (path: string) => void;
  onRestoreFile?: (path: string) => void;
  onForkAssistantTurn?: AssistantTurnForkHandler;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  if (isRunning) {
    return (
      <TurnFooterRow>
        <RunningTurnFooter
          inFlightTurnStartedAt={inFlightTurnStartedAt}
          outputTokenSpeed={outputTokenSpeed}
          onForkInFlightTurn={onForkInFlightTurn}
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
  onOpenFile?: (path: string) => void;
  onRestoreFile?: (path: string) => void;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}) {
  return (
    <TurnFooterRow>
      <View style={stylesheet.completedTurnFooterSlot}>
        <TurnFileChangesBar
          items={items}
          rawItems={rawItems}
          startIndex={startIndex}
          onOpenFile={onOpenFile}
          onRestoreFile={onRestoreFile}
        />
        <CompletedTurnFooter
          strategy={strategy}
          items={items}
          timing={timing}
          startIndex={startIndex}
          supportsTimelineCursor={supportsTimelineCursor}
          turnTokenStats={turnTokenStats}
          onForkAssistantTurn={onForkAssistantTurn}
        />
      </View>
    </TurnFooterRow>
  );
});

const WorkingIndicator = memo(function WorkingIndicator({
  inFlightTurnStartedAt = null,
  outputTokenSpeed,
  onForkInFlightTurn,
}: {
  inFlightTurnStartedAt?: Date | null;
  outputTokenSpeed: number | null;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  const { t } = useTranslation();
  const active = useRetainedPanelActive();
  return (
    <View style={stylesheet.turnFooterContent}>
      <View style={stylesheet.workingLoader}>
        <ThemedSyncedLoader size={14} uniProps={workingIndicatorColorMapping} />
      </View>
      {outputTokenSpeed !== null ? (
        <View style={stylesheet.tokenOutputSpeed} testID="turn-token-output-speed">
          <Text style={stylesheet.tokenOutputSpeedText}>
            {t("agentStream.turnMetadata.tokensPerSecond", {
              speed: formatOutputTokenSpeed(outputTokenSpeed),
            })}
          </Text>
        </View>
      ) : null}
      {/* Match the completed-turn footer: actions precede timing metadata. */}
      {onForkInFlightTurn ? <AssistantForkButton onFork={onForkInFlightTurn} /> : null}
      {inFlightTurnStartedAt ? (
        <LiveElapsed
          startedAt={inFlightTurnStartedAt}
          active={active}
          style={stylesheet.workingElapsed}
          testID="turn-working-elapsed"
        />
      ) : null}
    </View>
  );
});

function RunningTurnFooter({
  inFlightTurnStartedAt,
  outputTokenSpeed,
  onForkInFlightTurn,
}: {
  inFlightTurnStartedAt: Date | null;
  onForkInFlightTurn?: InFlightTurnForkHandler;
  outputTokenSpeed: number | null;
}) {
  return (
    <View style={stylesheet.turnFooterSlot} testID="turn-working-indicator">
      <WorkingIndicator
        inFlightTurnStartedAt={inFlightTurnStartedAt}
        outputTokenSpeed={outputTokenSpeed}
        onForkInFlightTurn={onForkInFlightTurn}
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
  onForkAssistantTurn,
}: {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  timing?: TurnTiming;
  startIndex: number;
  supportsTimelineCursor: boolean;
  turnTokenStats?: TurnTokenStats | null;
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
        avgSpeedLabel={
          turnTokenStats?.avgTokensPerSecond != null
            ? formatOutputTokenSpeed(turnTokenStats.avgTokensPerSecond)
            : null
        }
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
    minHeight: 24,
    paddingBottom: TURN_FOOTER_BOTTOM_SPACING,
  },
  turnFooterContent: {
    height: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: theme.spacing[3],
  },
  workingElapsed: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
    fontVariant: ["tabular-nums"],
  },
  workingLoader: {
    marginLeft: -2,
  },
  tokenOutputSpeed: {
    height: 24,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
  },
  tokenOutputSpeedText: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
    fontVariant: ["tabular-nums"],
  },
}));
