import { useMemo } from "react";
import { useSharedValue } from "react-native-reanimated";
import { KeyboardShiftContext } from "@/hooks/keyboard-shift-context";
import type { AgentInputDraft } from "./draft/input-draft";
import { useAgentInputDraft } from "./draft/input-draft";
import { Composer } from "./index";
import type { MessagePayload } from "./types";
import type { UserComposerAttachment } from "@/attachments/types";

export const composerAcceptanceImage: Extract<UserComposerAttachment, { kind: "image" }> = {
  kind: "image",
  metadata: {
    id: "isolated-image",
    mimeType: "image/png",
    storageType: "inline-data",
    createdAt: 1,
    storageKey:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWLSa3n2HwAAAP//TNjlYQAAAAZJREFUAwAFHgKategN/gAAAABJRU5ErkJggg==",
    fileName: "pixel.png",
  },
};

export const composerAcceptanceFile: Extract<UserComposerAttachment, { kind: "file" }> = {
  kind: "file",
  attachment: {
    type: "uploaded_file",
    id: "isolated-file",
    fileName: "notes.txt",
    mimeType: "text/plain",
    size: 5,
    path: "/isolated/notes.txt",
  },
};

export const composerAcceptanceAttachments: UserComposerAttachment[] = [
  composerAcceptanceImage,
  composerAcceptanceFile,
];

interface ComposerAcceptanceFixtureProps {
  agentId: string;
  serverId: string;
  draftKey: string;
  cwd: string;
  onSubmitMessage: (payload: MessagePayload) => Promise<void>;
  onDraft: (draft: AgentInputDraft) => void;
}

/** Shared production mounting path for browser regressions and isolated browser smoke pages. */
export function ComposerAcceptanceFixture({
  agentId,
  serverId,
  draftKey,
  cwd,
  onSubmitMessage,
  onDraft,
}: ComposerAcceptanceFixtureProps) {
  const draft = useAgentInputDraft({ draftKey });
  onDraft(draft);
  const shift = useSharedValue(0);
  const bottomInset = useSharedValue(0);
  const keyboardShift = useMemo(() => ({ shift, bottomInset }), [shift, bottomInset]);
  return (
    <KeyboardShiftContext.Provider value={keyboardShift}>
      <Composer
        agentId={agentId}
        serverId={serverId}
        isPaneFocused
        value={draft.text}
        onChangeText={draft.editText}
        textReplacementKey={draft.textReplacementKey}
        attachments={draft.attachments}
        onChangeAttachments={draft.setAttachments}
        clearDraft={draft.clear}
        cwd={cwd}
        submitButtonTestID="acceptance-send"
        onSubmitMessage={onSubmitMessage}
      />
    </KeyboardShiftContext.Provider>
  );
}
