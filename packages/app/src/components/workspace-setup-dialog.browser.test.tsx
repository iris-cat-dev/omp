import React, { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSharedValue } from "react-native-reanimated";
import type * as Reanimated from "react-native-reanimated";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import type {
  AgentSnapshotPayload,
  WorkspaceDescriptorPayload,
} from "@omp-desktop/protocol/messages";
import { WorkspaceSetupDialog } from "./workspace-setup-dialog";
import type { AdaptiveModalSheetProps } from "./adaptive-modal-sheet";
import type * as ModalSheet from "./adaptive-modal-sheet";
import {
  composerAcceptanceAttachments as initialAttachments,
  composerAcceptanceFile as file,
} from "@/composer/acceptance-clear.fixture";
import { browserAfterPaintScheduler } from "@/composer/after-paint-publication";
import type { UserComposerAttachment } from "@/attachments/types";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import { resetWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { KeyboardShiftContext } from "@/hooks/keyboard-shift-context";
import { useDraftStore, flushDraftPersistStorage } from "@/stores/draft-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceSetupStore } from "@/stores/workspace-setup-store";
import { i18n } from "@/i18n/i18next";

const { storage, client, toastError, router } = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  client: {
    isConnected: true,
    directoryExists: vi.fn<DaemonClient["directoryExists"]>(),
    createWorkspace: vi.fn<DaemonClient["createWorkspace"]>(),
    createAgent: vi.fn<DaemonClient["createAgent"]>(),
  },
  toastError: vi.fn(),
  router: { navigate: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() },
}));

// Keep the production dialog callback, Composer, draft hook/store, text editor,
// attachment serialization and publication. Control only platform/configuration
// boundaries, modal presentation and asynchronous daemon responses.
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
// Expo Router's excluded entrypoint is CommonJS; do not import it in the browser.
vi.mock("expo-router", () => ({
  router,
  useRouter: () => router,
  usePathname: () => "/",
  useGlobalSearchParams: () => ({}),
  useLocalSearchParams: () => ({}),
  useRootNavigationState: () => ({ key: "root" }),
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
  // The hoisted mock factory runs before static imports initialize this platform boundary.
  const { View } = await import("react-native");
  return { ...actual, default: { ...actual.default, View } };
});
vi.mock("@/components/adaptive-modal-sheet", async (importOriginal) => ({
  ...(await importOriginal<typeof ModalSheet>()),
  AdaptiveModalSheet: ({ visible, children, testID }: AdaptiveModalSheetProps) =>
    visible ? <section data-testid={testID}>{children}</section> : null,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => client,
  useHostRuntimeIsConnected: () => true,
  getHostRuntimeStore: () => ({ reevaluateQueuedAgentMessages: () => {} }),
}));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: vi.fn() }));
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
  useToast: () => ({ error: toastError, show: vi.fn() }),
}));
vi.mock("@/projects/icons", () => ({
  useProjectIcon: () => ({ icon: null }),
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
vi.mock("@/composer/github/auto-attach", () => ({
  useComposerGithubAutoAttach: () => ({
    isResolving: false,
    markGithubAttachmentRemoved: () => {},
  }),
}));
vi.mock("@/composer/agent-controls", () => ({
  AgentControls: () => null,
  DraftAgentControls: () => null,
}));
vi.mock("@/components/context-window-meter", () => ({ ContextWindowMeter: () => null }));
vi.mock("@/components/attachment-lightbox", () => ({ AttachmentLightbox: () => null }));
vi.mock("@/visual-feedback/attachment-card", () => ({
  VisualFeedbackAttachmentPreview: () => null,
  VisualFeedbackAttachmentPill: () => null,
}));
vi.mock("@/hooks/use-agent-form-state", () => ({
  useAgentFormState: ({
    initialServerId,
    initialValues,
  }: {
    initialServerId: string | null;
    initialValues?: { workingDir?: string };
  }) => ({
    selectedServerId: initialServerId,
    selectedProvider: "omp",
    selectedModel: "",
    selectedMode: "",
    selectedThinkingOptionId: "",
    availableModels: [],
    modeOptions: [],
    workingDir: initialValues?.workingDir ?? "",
  }),
}));
vi.mock("@/hooks/use-draft-agent-features", () => ({
  useDraftAgentFeatures: () => ({ features: [], metadataStatus: "ready" }),
}));

const serverId = "workspace-setup-acceptance-isolated-host";
const cwd = "/isolated";
const draftKey = (directory = cwd) => `workspace-setup:${serverId}:${directory}`;
const workspace: WorkspaceDescriptorPayload = {
  id: "isolated-workspace",
  projectId: "isolated-project",
  projectDisplayName: "Isolated project",
  projectRootPath: cwd,
  workspaceDirectory: cwd,
  projectKind: "directory",
  workspaceKind: "directory",
  name: "Isolated project",
  status: "done",
  statusEnteredAt: null,
  activityAt: null,
  archivingAt: null,
  scripts: [],
};
const createdAgent: AgentSnapshotPayload = {
  id: "isolated-agent",
  provider: "omp",
  cwd,
  workspaceId: workspace.id,
  model: null,
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
  lastUserMessageAt: null,
  status: "idle",
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: false,
    supportsReasoningStream: false,
    supportsToolInvocations: true,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: "Created after retry",
  labels: {},
};

let root: Root;
let container: HTMLDivElement;
let afterPaint: Set<() => void>;
let previousLanguage: string;
let settlePendingRequests: Array<() => void>;

function Harness() {
  const shift = useSharedValue(0);
  const bottomInset = useSharedValue(0);
  const keyboardShift = useMemo(() => ({ shift, bottomInset }), [shift, bottomInset]);
  return (
    <KeyboardShiftContext.Provider value={keyboardShift}>
      <WorkspaceSetupDialog />
    </KeyboardShiftContext.Provider>
  );
}
function textarea(): HTMLTextAreaElement {
  const input = container.querySelector("textarea");
  if (!input) throw new Error("Production WorkspaceSetupDialog did not render its textarea");
  return input;
}
function seed(attachments: UserComposerAttachment[], text = "Earlier edit", directory = cwd) {
  useDraftStore.getState().saveDraftInput({
    draftKey: draftKey(directory),
    draft: { text, attachments },
  });
}
function edit(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) throw new Error("Browser textarea setter unavailable");
  const input = textarea();
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
function deferredRequest<T>(cleanupValue: T) {
  const request = Promise.withResolvers<T>();
  settlePendingRequests.push(() => request.resolve(cleanupValue));
  return request;
}
async function startSubmission(
  attachments: UserComposerAttachment[],
  publishDraft = true,
  finalText = "Final DOM edit",
) {
  const directory = deferredRequest(true);
  client.directoryExists.mockReturnValueOnce(directory.promise);
  seed(attachments);
  useWorkspaceSetupStore.getState().beginWorkspaceSetup({ serverId, sourceDirectory: cwd });
  await act(async () => root.render(<Harness />));
  expect(textarea().value).toBe("Earlier edit");
  act(() => {
    edit(finalText);
    enter();
  });
  expect(useDraftStore.getState().getDraftInput(draftKey())).toEqual({
    text: "Earlier edit",
    attachments,
  });
  if (publishDraft) {
    publishAfterPaint();
    expect(useDraftStore.getState().getDraftInput(draftKey())).toEqual({
      text: finalText,
      attachments,
    });
  }
  return directory;
}
function expectDraft(text: string, attachments: UserComposerAttachment[]) {
  expect(textarea().value).toBe(text);
  expect(useDraftStore.getState().getDraftInput(draftKey())).toEqual({ text, attachments });
  expect(container.querySelector('[data-testid="composer-image-attachment-pill"]') !== null).toBe(
    attachments.some((attachment) => attachment.kind === "image"),
  );
  expect(container.querySelector('[data-testid="composer-file-attachment-pill"]') !== null).toBe(
    attachments.some((attachment) => attachment.kind === "file"),
  );
}

beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await flushDraftPersistStorage();
  storage.clear();
  client.directoryExists.mockReset().mockResolvedValue(true);
  client.createWorkspace.mockReset().mockResolvedValue({
    workspace,
    setupTerminalId: null,
    error: null,
    requestId: "isolated-workspace-request",
  });
  client.createAgent.mockReset().mockResolvedValue(createdAgent);
  toastError.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  afterPaint = new Set();
  settlePendingRequests = [];
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
  useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
  useSessionStore.getState().initializeSession(serverId, null);
  useWorkspaceSetupStore.setState({
    pendingWorkspaceSetup: null,
    snapshots: {},
    requestedKeys: new Set(),
    surfacedFailedSetupKeys: new Set(),
  });
  resetWorkspaceAttachmentsStore();
  if (!i18n.isInitialized) await i18n.init();
  previousLanguage = i18n.language;
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  container.style.width = "800px";
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    useWorkspaceSetupStore.getState().clearWorkspaceSetup();
    for (const settle of settlePendingRequests) settle();
  });
  container.remove();
  resetWorkspaceAttachmentsStore();
  useDraftStore.setState({
    drafts: {},
    createModalDraft: null,
    attachmentFocusRequestByDraftKey: {},
  });
  useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
  await flushDraftPersistStorage();
  __setAttachmentStoreForTests(null);
  await i18n.changeLanguage(previousLanguage);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WorkspaceSetupDialog submission rejection", () => {
  it.each<{
    name: string;
    attachments: UserComposerAttachment[];
    failure: "directory" | "creation";
  }>([
    { name: "text-only", attachments: [], failure: "directory" },
    { name: "text-only", attachments: [], failure: "creation" },
    { name: "image and file", attachments: initialAttachments, failure: "directory" },
    { name: "image and file", attachments: initialAttachments, failure: "creation" },
  ])(
    "preserves $name drafts after $failure failure and allows an explicit successful retry",
    async ({ attachments, failure }) => {
      const directory = await startSubmission(attachments);
      const error = new Error(`${failure} failed`);
      if (failure === "directory") {
        await act(async () => directory.reject(error));
      } else {
        const creation = deferredRequest(createdAgent);
        client.createAgent.mockReturnValueOnce(creation.promise);
        await act(async () => directory.resolve(true));
        // Repeated Enter must not dispatch a second creation while this one is pending.
        act(() => enter());
        expect(client.createAgent).toHaveBeenCalledTimes(1);
        await act(async () => creation.reject(error));
      }
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(error.message);
      expectDraft("Final DOM edit", attachments);
      publishAfterPaint();
      expectDraft("Final DOM edit", attachments);
      expect(useWorkspaceSetupStore.getState().pendingWorkspaceSetup).toEqual({
        serverId,
        sourceDirectory: cwd,
      });
      expect(useSessionStore.getState().sessions[serverId]?.agents.size).toBe(0);

      await act(async () => {
        await userEvent.click(textarea());
        await userEvent.keyboard("{Enter}");
      });
      expect(client.createAgent).toHaveBeenCalledTimes(failure === "creation" ? 2 : 1);
      expect(client.createAgent.mock.calls.at(-1)?.[0].initialPrompt).toBe("Final DOM edit");
      expect(useWorkspaceSetupStore.getState().pendingWorkspaceSetup).toBeNull();
      expect(container.querySelector('[data-testid="workspace-setup-dialog"]')).toBeNull();
      expect(useDraftStore.getState().getDraftInput(draftKey())).toBeUndefined();
      publishAfterPaint();
      expect(useDraftStore.getState().getDraftInput(draftKey())).toBeUndefined();
    },
  );

  it("does not clear either draft when a failed creation belongs to a previous setup target", async () => {
    const directory = await startSubmission(initialAttachments);
    const creation = deferredRequest(createdAgent);
    client.createAgent.mockReturnValueOnce(creation.promise);
    await act(async () => directory.resolve(true));
    const otherCwd = "/isolated-other";
    await act(async () => {
      seed([file], "Other target draft", otherCwd);
      useWorkspaceSetupStore
        .getState()
        .beginWorkspaceSetup({ serverId, sourceDirectory: otherCwd });
    });
    act(() => edit("New edit in the other target"));
    await act(async () => creation.reject(new Error("Previous creation failed")));
    expect(textarea().value).toBe("New edit in the other target");
    publishAfterPaint();
    expect(useDraftStore.getState().getDraftInput(draftKey(otherCwd))).toEqual({
      text: "New edit in the other target",
      attachments: [file],
    });
    expect(useDraftStore.getState().getDraftInput(draftKey())).toEqual({
      text: "Final DOM edit",
      attachments: initialAttachments,
    });
    expect(useWorkspaceSetupStore.getState().pendingWorkspaceSetup).toEqual({
      serverId,
      sourceDirectory: otherCwd,
    });
  });
});

describe("WorkspaceSetupDialog accepted draft snapshots", () => {
  it("clears accepted unpublished text before closing and cancels its delayed publication", async () => {
    const creation = deferredRequest(createdAgent);
    client.createAgent.mockReturnValueOnce(creation.promise);
    const directory = await startSubmission(initialAttachments, false);
    await act(async () => directory.resolve(true));
    expect(client.createAgent).toHaveBeenCalledTimes(1);
    expect(useDraftStore.getState().getDraftInput(draftKey())?.text).toBe("Earlier edit");
    await act(async () => creation.resolve(createdAgent));
    expect(client.createAgent.mock.calls[0]?.[0].initialPrompt).toBe("Final DOM edit");
    expect(useWorkspaceSetupStore.getState().pendingWorkspaceSetup).toBeNull();
    expect(useDraftStore.getState().getDraftInput(draftKey())).toBeUndefined();
    publishAfterPaint();
    expect(useDraftStore.getState().getDraftInput(draftKey())).toBeUndefined();
  });

  it.each(["text", "attachment order", "image metadata", "file payload"] as const)(
    "preserves a same-workspace replacement's changed %s when earlier creation succeeds",
    async (change) => {
      const creation = deferredRequest(createdAgent);
      client.createAgent.mockReturnValueOnce(creation.promise);
      const directory = await startSubmission(initialAttachments);
      await act(async () => directory.resolve(true));
      const replacement = {
        text: change === "text" ? "Replacement draft" : "Final DOM edit",
        attachments: structuredClone(initialAttachments),
      };
      if (change === "attachment order") replacement.attachments.reverse();
      if (change === "image metadata") {
        const image = replacement.attachments.find((attachment) => attachment.kind === "image");
        if (!image || image.kind !== "image") throw new Error("Fixture image missing");
        image.metadata.fileName = "replacement-pixel.png";
      }
      if (change === "file payload") {
        const attachment = replacement.attachments.find((value) => value.kind === "file");
        if (!attachment || attachment.kind !== "file") throw new Error("Fixture file missing");
        attachment.attachment = { ...attachment.attachment, fileName: "replacement-notes.txt" };
      }
      act(() => {
        useDraftStore.getState().saveDraftInput({ draftKey: draftKey(), draft: replacement });
      });
      await act(async () => creation.resolve(createdAgent));
      expect(client.createAgent).toHaveBeenCalledTimes(1);
      expect(useDraftStore.getState().getDraftInput(draftKey())).toEqual(replacement);
      publishAfterPaint();
      expect(useDraftStore.getState().getDraftInput(draftKey())).toEqual(replacement);
    },
  );

  it("preserves attachment edits made while creation and text publication are pending", async () => {
    const creation = deferredRequest(createdAgent);
    client.createAgent.mockReturnValueOnce(creation.promise);
    const directory = await startSubmission(initialAttachments, false);
    await act(async () => directory.resolve(true));
    expect(textarea().readOnly).toBe(true);
    for (const label of ["Remove image attachment", "Remove file attachment"]) {
      act(() => {
        const remove = container.querySelector(`[aria-label="${label}"]`);
        if (!(remove instanceof HTMLElement)) throw new Error(`Missing ${label} button`);
        remove.click();
      });
    }
    expect(useDraftStore.getState().getDraftInput(draftKey())).toEqual({
      text: "Earlier edit",
      attachments: [],
    });
    await act(async () => creation.resolve(createdAgent));
    expect(client.createAgent).toHaveBeenCalledTimes(1);
    expect(client.createAgent.mock.calls[0]?.[0].initialPrompt).toBe("Final DOM edit");
    expect(client.createAgent.mock.calls[0]?.[0].images).toHaveLength(1);
    expect(client.createAgent.mock.calls[0]?.[0].attachments).toHaveLength(1);
    expect(useDraftStore.getState().getDraftInput(draftKey())).toEqual({
      text: "Final DOM edit",
      attachments: [],
    });
    publishAfterPaint();
    expect(useDraftStore.getState().getDraftInput(draftKey())).toEqual({
      text: "Final DOM edit",
      attachments: [],
    });
  });

  it.each([false, true])(
    "preserves a reopened same-workspace draft when earlier creation succeeds (published: %s)",
    async (publishReplacement) => {
      const creation = deferredRequest(createdAgent);
      client.createAgent.mockReturnValueOnce(creation.promise);
      const directory = await startSubmission(initialAttachments, false);
      await act(async () => directory.resolve(true));
      await act(async () => useWorkspaceSetupStore.getState().clearWorkspaceSetup());
      await act(async () => {
        useWorkspaceSetupStore.getState().beginWorkspaceSetup({ serverId, sourceDirectory: cwd });
      });
      const replacementSetup = useWorkspaceSetupStore.getState().pendingWorkspaceSetup;
      const replacementText = "New unsent message";
      expect(textarea().readOnly).toBe(false);
      act(() => edit(replacementText));
      if (publishReplacement) publishAfterPaint();

      await act(async () => creation.resolve(createdAgent));
      expect(useWorkspaceSetupStore.getState().pendingWorkspaceSetup).toBe(replacementSetup);
      expect(textarea().value).toBe(replacementText);
      publishAfterPaint();
      expectDraft(replacementText, initialAttachments);
    },
  );

  it("preserves the replacement workspace when an inactive creation succeeds", async () => {
    const directory = await startSubmission(initialAttachments);
    const creation = deferredRequest(createdAgent);
    client.createAgent.mockReturnValueOnce(creation.promise);
    await act(async () => directory.resolve(true));
    const otherCwd = "/isolated-other";
    await act(async () => {
      seed([file], "Other target draft", otherCwd);
      useWorkspaceSetupStore
        .getState()
        .beginWorkspaceSetup({ serverId, sourceDirectory: otherCwd });
    });
    await act(async () => creation.resolve(createdAgent));
    expect(textarea().value).toBe("Other target draft");
    publishAfterPaint();
    expect(useDraftStore.getState().getDraftInput(draftKey(otherCwd))).toEqual({
      text: "Other target draft",
      attachments: [file],
    });
    expect(useSessionStore.getState().sessions[serverId]?.agents.has(createdAgent.id)).toBe(false);
    expect(useWorkspaceSetupStore.getState().pendingWorkspaceSetup).toEqual({
      serverId,
      sourceDirectory: otherCwd,
    });
  });

  it("clears raw whitespace after trimmed submission and deferred publication", async () => {
    const creation = deferredRequest(createdAgent);
    client.createAgent.mockReturnValueOnce(creation.promise);
    const rawText = "  Final DOM edit  \n";
    const directory = await startSubmission(initialAttachments, true, rawText);
    await act(async () => directory.resolve(true));
    expect(client.createAgent.mock.calls[0]?.[0].initialPrompt).toBe(rawText.trim());
    await act(async () => creation.resolve(createdAgent));
    expect(useWorkspaceSetupStore.getState().pendingWorkspaceSetup).toBeNull();
    expect(useDraftStore.getState().getDraftInput(draftKey())).toBeUndefined();
    publishAfterPaint();
    expect(useDraftStore.getState().getDraftInput(draftKey())).toBeUndefined();
  });
});
