import { describe, expect, it, vi } from "vitest";
import {
  assertWorkspaceDirectoryExists,
  submitAgentInput,
  type AgentInputSubmitActionInput,
} from "./submit";

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

describe("assertWorkspaceDirectoryExists", () => {
  it("allows an existing project directory", async () => {
    const directoryExists = vi.fn(async () => true);

    await expect(
      assertWorkspaceDirectoryExists({
        cwd: "/repo/project",
        directoryExists,
        missingDirectoryMessage: "Workspace directory not found.",
      }),
    ).resolves.toBeUndefined();
    expect(directoryExists).toHaveBeenCalledWith("/repo/project");
  });

  it("rejects a missing project directory with the user-facing reminder", async () => {
    await expect(
      assertWorkspaceDirectoryExists({
        cwd: "/repo/missing",
        directoryExists: async () => false,
        missingDirectoryMessage: "Workspace directory not found.",
      }),
    ).rejects.toThrow("Workspace directory not found.");
  });
});

describe("submitAgentInput", () => {
  function createSubmission(options: Partial<AgentInputSubmitActionInput<{ id: string }>> = {}) {
    const pending = createDeferredPromise<void>();
    const original = { text: "original message", attachments: [{ id: "original-image" }] };
    const state = {
      ...original,
      persisted: original as typeof original | null,
      error: null as unknown,
      processing: false,
      currentTarget: true,
    };
    const input: AgentInputSubmitActionInput<{ id: string }> = {
      message: original.text,
      attachments: original.attachments,
      forceSend: true,
      isAgentRunning: true,
      canSubmit: true,
      snapshot: {
        isCurrentTarget: () => state.currentTarget,
        isInputUnchanged: () => state.text === "" && state.attachments.length === 0,
      },
      queueMessage: vi.fn(),
      submitMessage: () => pending.promise,
      clearDraft: () => {
        state.persisted = null;
      },
      setUserInput: (text) => {
        state.text = text;
      },
      setAttachments: (attachments) => {
        state.attachments = attachments;
      },
      setSendError: (error) => {
        state.error = error;
      },
      setIsProcessing: (processing) => {
        state.processing = processing;
      },
      ...options,
    };
    return { pending, original, state, input };
  }

  it.each([false, true])(
    "clears live and persisted input before sending (active turn: %s)",
    async (isAgentRunning) => {
      const { input, pending, state } = createSubmission({ isAgentRunning });
      const sending = submitAgentInput(input);
      expect(state).toMatchObject({ text: "", attachments: [], persisted: null, processing: true });
      pending.resolve();
      await expect(sending).resolves.toBe("submitted");
      expect(state.processing).toBe(false);
    },
  );

  it("restores the cleared text and attachments after rejection", async () => {
    const { input, pending, state, original } = createSubmission();
    const sending = submitAgentInput(input);
    const failure = Object.assign(new Error("The old task is still running"), {
      code: "agent_cancellation_unacknowledged",
    });
    pending.reject(failure);
    await expect(sending).resolves.toBe("failed");
    expect(state).toMatchObject({ ...original, error: failure, processing: false });
  });

  it.each(["accepted", "rejected"] as const)(
    "preserves new text and attachments when the earlier send is %s",
    async (outcome) => {
      const { input, pending, state } = createSubmission();
      const sending = submitAgentInput(input);
      const next = { text: "the next message", attachments: [{ id: "new-image" }] };
      Object.assign(state, next, { persisted: next });
      if (outcome === "accepted") pending.resolve();
      else pending.reject(new Error("send failed"));
      await sending;
      expect(state).toMatchObject({ ...next, persisted: next, processing: false });
    },
  );

  it.each(["accepted", "rejected"] as const)(
    "does not mutate another target's draft or send state after stale %s settlement",
    async (outcome) => {
      const { input, pending, state } = createSubmission();
      const sending = submitAgentInput(input);
      const next = { text: "another target's draft", attachments: [{ id: "other-image" }] };
      Object.assign(state, next, {
        persisted: next,
        currentTarget: false,
        error: "another target's error",
        processing: true,
      });
      const before = { ...state };
      if (outcome === "accepted") pending.resolve();
      else pending.reject(new Error("old target failed"));
      await sending;
      expect(state).toEqual(before);
    },
  );

  it("keeps input visible when preservation is explicitly requested", async () => {
    const { input, pending, state, original } = createSubmission({
      submitBehavior: "preserve-and-lock",
      snapshot: undefined,
    });
    const sending = submitAgentInput(input);
    expect(state).toMatchObject({ ...original, persisted: original, processing: true });
    pending.resolve();
    await sending;
    expect(state.persisted).toBeNull();
  });

  it("queues an active-turn message without submitting it", async () => {
    const submitMessage = vi.fn();
    const { input, state } = createSubmission({ forceSend: false, submitMessage });
    await expect(submitAgentInput(input)).resolves.toBe("queued");
    expect(input.queueMessage).toHaveBeenCalledWith({
      message: "original message",
      attachments: [{ id: "original-image" }],
    });
    expect(submitMessage).not.toHaveBeenCalled();
    expect(state).toMatchObject({ text: "", attachments: [], processing: false });
  });

  it.each([{ canSubmit: false }, { message: "   ", attachments: [] }])(
    "leaves the draft untouched when no send starts: %j",
    async (options) => {
      const { input, state } = createSubmission(options);
      const before = { ...state };
      await expect(submitAgentInput(input)).resolves.toBe("noop");
      expect(state).toEqual(before);
    },
  );
});
