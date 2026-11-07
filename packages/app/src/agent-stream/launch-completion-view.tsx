import React, { memo, useCallback, useMemo, useState } from "react";
import { Terminal, CircleCheck } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { ExpandableBadge } from "@/components/message";
import { ToolCallDetailsContent } from "@/components/tool-call-details";
import type { ToolCallDetail } from "@omp-desktop/protocol/agent-types";
import type { LaunchCompletionItem } from "./launch-completion";

const CompletionDetailsSchema = z.object({
  daemons: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        state: z.enum([
          "starting",
          "running",
          "ready",
          "restarting",
          "stopping",
          "exited",
          "failed",
        ]),
        exitCode: z.number().int().optional(),
        exitReason: z.string().optional(),
      }),
    )
    .min(1),
});

const CompletionRow = memo(function CompletionRow({
  name,
  summary,
  text,
  failed,
  icon = Terminal,
  isLastInSequence,
}: {
  name: string;
  summary?: string;
  text: string;
  failed: boolean;
  icon?: typeof Terminal;
  isLastInSequence: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((previous) => !previous), []);
  const detail = useMemo<ToolCallDetail>(() => ({ type: "plain_text", text }), [text]);
  const renderDetails = useCallback(
    () => <ToolCallDetailsContent detail={detail} maxHeight={240} />,
    [detail],
  );

  return (
    <ExpandableBadge
      testID="launch-completion-badge"
      label={name}
      secondaryLabel={summary}
      icon={icon}
      isError={failed}
      isExpanded={expanded}
      isLastInSequence={isLastInSequence}
      onToggle={toggle}
      renderDetails={renderDetails}
    />
  );
});

export const LaunchCompletionView = memo(function LaunchCompletionView({
  item,
  isLastInSequence,
}: {
  item: LaunchCompletionItem;
  isLastInSequence: boolean;
}) {
  const { t } = useTranslation();
  const parsed = useMemo(
    () => CompletionDetailsSchema.safeParse(item.customMessage.details),
    [item.customMessage.details],
  );

  // Older or unrecognized records still expose their complete original notification.
  if (!parsed.success) {
    return (
      <CompletionRow
        name={t("backgroundProcesses.title")}
        text={item.text}
        failed={false}
        isLastInSequence={isLastInSequence}
      />
    );
  }

  return (
    <>
      {parsed.data.daemons.map((process, index) => {
        const failed =
          process.state === "failed" || (process.exitCode !== undefined && process.exitCode !== 0);
        const status = t(`backgroundProcesses.status.${failed ? "failed" : process.state}`);
        const summary =
          process.exitCode === undefined
            ? status
            : `${status} · ${t("backgroundProcesses.exitCode", { code: process.exitCode })}`;
        const text = [process.name, summary, process.exitReason].filter(Boolean).join("\n");
        return (
          <CompletionRow
            key={process.id}
            name={process.name}
            summary={summary}
            text={text}
            failed={failed}
            icon={
              !failed && process.state === "exited" && process.exitCode === 0
                ? CircleCheck
                : Terminal
            }
            isLastInSequence={isLastInSequence && index === parsed.data.daemons.length - 1}
          />
        );
      })}
    </>
  );
});
