import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as Reanimated from "react-native-reanimated";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComposerAcceptanceFixture,
  composerAcceptanceAttachments as initialAttachments,
  composerAcceptanceFile as file,
} from "./acceptance-clear.fixture";
import { browserAfterPaintScheduler } from "./after-paint-publication";
import type { AgentInputDraft } from "./draft/input-draft";
import type { MessagePayload } from "./types";
import type { UserComposerAttachment } from "@/attachments/types";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import { useDraftStore } from "@/stores/draft-store";
import { useSessionStore } from "@/stores/session-store";
import { i18n } from "@/i18n/i18next";

const { storage, reevaluateQueue } = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  reevaluateQueue: vi.fn(),
}));

// Only platform/configuration boundaries are controlled. Composer, MessageInput,
// the DOM text editor, draft hook/store, publication and acceptance logic are real.
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: async (key: string) => {
      storage.delete(key);
    },
  },
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_algorithm: string, text: string) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  },
}));
vi.mock("react-native-reanimated", async (importOriginal) => {
  const actual = await importOriginal<typeof Reanimated>();
  // The hoisted factory runs before static imports initialize this platform boundary.
  const { View } = await import("react-native");
  return { ...actual, default: { ...actual.default, View } };
});
vi.mock("@/runtime/host-runtime", () => ({
  // A parent-managed submit must work without a daemon/model connection.
  useHostRuntimeClient: () => null,
  useHostRuntimeIsConnected: () => false,
  getHostRuntimeStore: () => ({ reevaluateQueuedAgentMessages: reevaluateQueue }),
}));
vi.mock("@/hooks/use-is-local-daemon", () => ({ useIsLocalDaemon: () => false }));
vi.mock("@/hooks/use-settings", () => ({
  useAppSettings: () => ({ settings: { sendBehavior: "interrupt" } }),
}));
vi.mock("@/hooks/use-keyboard-shift-style", () => ({
  useKeyboardShiftStyle: () => ({ style: {} }),
}));
vi.mock("@/hooks/use-keyboard-action-handler", () => ({ useKeyboardActionHandler: () => {} }));
vi.mock("@/hooks/use-shortcut-keys", () => ({ useShortcutKeys: () => null }));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: vi.fn(), show: vi.fn() }),
}));
vi.mock("@/hooks/use-image-attachment-picker", () => ({
  useImageAttachmentPicker: () => ({ pickImages: async () => null }),
}));
vi.mock("@/hooks/use-file-picker", () => ({
  useFilePicker: () => ({ pickFiles: async () => null }),
}));
vi.mock("@/hooks/use-agent-autocomplete", () => ({
  useAgentAutocomplete: () => ({
    isVisible: false,
    options: [],
    selectedIndex: 0,
    isLoading: false,
    onKeyPress: () => false,
    onSelectOption: () => {},
  }),
}));
vi.mock("@/git/use-status-query", () => ({ useCheckoutStatusQuery: () => ({ status: null }) }));
vi.mock("@/git/use-pr-status-query", () => ({
  useCheckoutPrStatusQuery: () => ({ forge: "github" }),
}));
vi.mock("@/git/use-forge-search-query", () => ({
  useForgeSearchQuery: () => ({ isFetching: false }),
}));
vi.mock("./github/auto-attach", () => ({
  useComposerGithubAutoAttach: () => ({
    isResolving: false,
    markGithubAttachmentRemoved: () => {},
  }),
}));
vi.mock("./agent-controls", () => ({ AgentControls: () => null, DraftAgentControls: () => null }));
vi.mock("@/components/context-window-meter", () => ({ ContextWindowMeter: () => null }));
vi.mock("@/components/attachment-lightbox", () => ({ AttachmentLightbox: () => null }));
vi.mock("@/visual-feedback/attachment-card", () => ({
  VisualFeedbackAttachmentPreview: () => null,
  VisualFeedbackAttachmentPill: () => null,
}));
vi.mock("@/hooks/use-agent-form-state", () => ({
  useAgentFormState: () => ({
    selectedServerId: null,
    selectedProvider: "omp",
    selectedModel: "",
    selectedMode: "",
    selectedThinkingOptionId: "",
    availableModels: [],
    modeOptions: [],
    workingDir: "",
  }),
}));
vi.mock("@/hooks/use-draft-agent-features", () => ({
  useDraftAgentFeatures: () => ({ features: [], metadataStatus: "ready" }),
}));

const serverId = "composer-acceptance-isolated-host";
const draftKey = (agentId: string) => `composer-acceptance:${agentId}`;
interface Submission {
  payload: MessagePayload;
  accept: () => void;
  reject: (error: Error) => void;
}
let submissions: Submission[];
let root: Root;
let container: HTMLDivElement;
let draft: AgentInputDraft;
let afterPaint: Set<() => void>;
function recordDraft(value: AgentInputDraft) {
  draft = value;
}
function submitMessage(payload: MessagePayload): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  submissions.push({ payload, accept: resolve, reject });
  return promise;
}

function Harness({ agentId }: { agentId: string }) {
  return (
    <ComposerAcceptanceFixture
      agentId={agentId}
      serverId={serverId}
      draftKey={draftKey(agentId)}
      cwd="/isolated"
      onDraft={recordDraft}
      onSubmitMessage={submitMessage}
    />
  );
}
function textarea(): HTMLTextAreaElement {
  const input = container.querySelector("textarea");
  if (!input) throw new Error("Production MessageInput did not render its textarea");
  return input;
}
function seed(agentId: string, attachments: UserComposerAttachment[], text = "Earlier edit") {
  useDraftStore
    .getState()
    .saveDraftInput({ draftKey: draftKey(agentId), draft: { text, attachments } });
}
async function show(agentId = "agent-a") {
  await act(async () => {
    root.render(<Harness agentId={agentId} />);
  });
  expect(draft.isHydrated).toBe(true);
}
function edit(text: string) {
  const input = textarea();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) throw new Error("Browser textarea setter unavailable");
  setter.call(input, text);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
}
function enter() {
  textarea().dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
}
function publishAfterPaint() {
  act(() => {
    const callbacks = [...afterPaint];
    afterPaint.clear();
    for (const callback of callbacks) callback();
  });
}
async function startSend(attachments = initialAttachments) {
  seed("agent-a", attachments);
  await show();
  act(() => {
    edit("Final DOM edit");
    enter();
  });
  expect(submissions).toHaveLength(1);
  expect(submissions[0]!.payload).toEqual({
    text: "Final DOM edit",
    attachments,
    cwd: "/isolated",
  });
  // Clearing cancels the final edit's pending publication as well as the visible input.
  expect(useDraftStore.getState().getDraftInput(draftKey("agent-a"))).toBeUndefined();
  expect(textarea().value).toBe("");
  expect(draft.attachments).toEqual([]);
  expect(container.querySelector('[data-testid="composer-file-attachment-pill"]')).toBeNull();
  expect(container.querySelector('[data-testid="composer-image-attachment-pill"]')).toBeNull();
}
async function accept() {
  await act(async () => {
    submissions[0]!.accept();
  });
}

beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  storage.clear();
  submissions = [];
  afterPaint = new Set();
  // Keep the actual AfterPaintPublication; control only when the browser paints.
  vi.spyOn(browserAfterPaintScheduler, "schedule").mockImplementation((callback) => {
    afterPaint.add(callback);
    return () => {
      afterPaint.delete(callback);
    };
  });
  __setAttachmentStoreForTests({
    storageType: "inline-data",
    save: async () => {
      throw new Error("Unexpected fixture attachment write");
    },
    encodeBase64: async ({ attachment }) => attachment.storageKey,
    resolvePreviewUrl: async ({ attachment }) =>
      `data:${attachment.mimeType};base64,${attachment.storageKey}`,
    delete: async () => {},
    garbageCollect: async () => {},
  });
  useDraftStore.setState({
    drafts: {},
    createModalDraft: null,
    attachmentFocusRequestByDraftKey: {},
  });
  useSessionStore.setState({ sessions: {} });
  if (!i18n.isInitialized) await i18n.init();
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  container.style.width = "800px";
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __setAttachmentStoreForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Composer parent acceptance and deferred draft publication", () => {
  it.each<{ name: string; attachments: UserComposerAttachment[] }>([
    { name: "images and uploaded files", attachments: initialAttachments },
    { name: "an empty attachment array", attachments: [] },
  ])(
    "clears $name and live text before acceptance without a delayed edit reviving the sent draft",
    async ({ attachments }) => {
      await startSend(attachments);
      publishAfterPaint();
      expect(useDraftStore.getState().getDraftInput(draftKey("agent-a"))).toBeUndefined();
      expect(textarea().value).toBe("");
      await accept();
      publishAfterPaint();
      expect(textarea().value).toBe("");
      expect(draft.attachments).toEqual([]);
      expect(useDraftStore.getState().getDraftInput(draftKey("agent-a"))).toBeUndefined();
      await act(async () => {
        await userEvent.click(textarea());
        await userEvent.keyboard("{Enter}");
      });
      expect(submissions).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "preserves a real new DOM edit (already published: %s)",
    async (published) => {
      await startSend();
      publishAfterPaint();
      act(() => edit("The next message"));
      expect(useDraftStore.getState().getDraftInput(draftKey("agent-a"))).toBeUndefined();
      if (published) publishAfterPaint();
      await accept();
      expect(textarea().value).toBe("The next message");
      expect(draft.attachments).toEqual([]);
      publishAfterPaint();
      expect(useDraftStore.getState().getDraftInput(draftKey("agent-a"))).toEqual({
        text: "The next message",
        attachments: [],
      });
    },
  );

  it.each(["accepted", "rejected"] as const)(
    "preserves attachment-only edits after the previous send is %s",
    async (outcome) => {
      await startSend();
      publishAfterPaint();
      const next: UserComposerAttachment[] = [{ kind: "directory", path: "/new" }];
      act(() => draft.setAttachments(next));
      vi.spyOn(console, "error").mockImplementation(() => {});
      if (outcome === "accepted") await accept();
      else {
        await act(async () => {
          submissions[0]!.reject(new Error("Parent rejected submission"));
        });
      }
      expect(textarea().value).toBe("");
      expect(draft.attachments).toEqual(next);
      expect(useDraftStore.getState().getDraftInput(draftKey("agent-a"))).toEqual({
        text: "",
        attachments: next,
      });
    },
  );

  it("does not clear either draft after the Composer changes target", async () => {
    await startSend();
    publishAfterPaint();
    seed("agent-b", [file], "Other target draft");
    await show("agent-b");
    await accept();
    expect(textarea().value).toBe("Other target draft");
    expect(draft.attachments).toEqual([file]);
    expect(useDraftStore.getState().getDraftInput(draftKey("agent-a"))).toBeUndefined();
    expect(useDraftStore.getState().getDraftInput(draftKey("agent-b"))).toEqual({
      text: "Other target draft",
      attachments: [file],
    });
  });

  it("retains text, images and files on rejection and retries only when requested", async () => {
    await startSend();
    publishAfterPaint();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      submissions[0]!.reject(new Error("Parent rejected submission"));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Parent rejected submission",
    );
    expect(errorLog).toHaveBeenCalled();
    expect(textarea().value).toBe("Final DOM edit");
    expect(draft.attachments).toEqual(initialAttachments);
    publishAfterPaint();
    expect(useDraftStore.getState().getDraftInput(draftKey("agent-a"))).toEqual({
      text: "Final DOM edit",
      attachments: initialAttachments,
    });
    expect(submissions).toHaveLength(1);
    await act(async () => {
      await userEvent.click(textarea());
      await userEvent.keyboard("{Enter}");
    });
    expect(submissions).toHaveLength(2);
    expect(submissions[1]!.payload).toEqual(submissions[0]!.payload);
    await act(async () => {
      submissions[1]!.accept();
    });
    expect(textarea().value).toBe("");
    expect(draft.attachments).toEqual([]);
  });

  it("does not restore the submitted payload over a new draft on rejection", async () => {
    await startSend();
    publishAfterPaint();
    act(() => {
      edit("New draft after send");
      draft.setAttachments([file]);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      submissions[0]!.reject(new Error("Parent rejected submission"));
    });
    expect(textarea().value).toBe("New draft after send");
    expect(draft.attachments).toEqual([file]);
    publishAfterPaint();
    expect(useDraftStore.getState().getDraftInput(draftKey("agent-a"))).toEqual({
      text: "New draft after send",
      attachments: [file],
    });
  });
});
