import type { AssistantMessageItem, StreamItem } from "@/types/stream";

export type LaunchCompletionItem = AssistantMessageItem & {
  customMessage: { customType: "launch-completion"; details?: unknown };
};

export function isLaunchCompletionItem(
  item: StreamItem | null | undefined,
): item is LaunchCompletionItem {
  return (
    item?.kind === "assistant_message" && item.customMessage?.customType === "launch-completion"
  );
}
