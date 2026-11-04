import { describe, expect, it, vi } from "vitest";
import { assertWorkspaceDirectoryExists, submitAgentInput } from "./submit";

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
  it("clears the composer before an in-flight submit resolves", async () => {
    const deferred = createDeferredPromise<void>();
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {
      await deferred.promise;
    });
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    const submitPromise = submitAgentInput({
      message: "  hello world  ",
      attachments: [],
      isAgentRunning: false,
      canSubmit: true,
      queueMessage,
      submitMessage,
      clearDraft,
      setUserInput,
      setAttachments,
      setSendError,
      setIsProcessing,
    });

    expect(queueMessage).not.toHaveBeenCalled();
    expect(submitMessage).toHaveBeenCalledWith({
      message: "hello world",
      attachments: [],
    });
    expect(setUserInput).toHaveBeenCalledWith("");
    expect(setAttachments).toHaveBeenCalledWith([]);
    expect(setSendError).toHaveBeenCalledWith(null);
    expect(setIsProcessing).toHaveBeenCalledWith(true);
    expect(clearDraft).not.toHaveBeenCalled();

    deferred.resolve();

    await expect(submitPromise).resolves.toBe("submitted");
    expect(clearDraft).toHaveBeenCalledWith("sent");
  });

  it("preserves the composer before an in-flight submit resolves when requested", async () => {
    const deferred = createDeferredPromise<void>();
    const attachments = [{ id: "img-1" }];
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {
      await deferred.promise;
    });
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    const submitPromise = submitAgentInput({
      message: "  keep me  ",
      attachments,
      submitBehavior: "preserve-and-lock",
      isAgentRunning: false,
      canSubmit: true,
      queueMessage,
      submitMessage,
      clearDraft,
      setUserInput,
      setAttachments,
      setSendError,
      setIsProcessing,
    });

    expect(queueMessage).not.toHaveBeenCalled();
    expect(submitMessage).toHaveBeenCalledWith({
      message: "keep me",
      attachments,
    });
    expect(setUserInput).not.toHaveBeenCalled();
    expect(setAttachments).not.toHaveBeenCalled();
    expect(setSendError).toHaveBeenCalledWith(null);
    expect(setIsProcessing).toHaveBeenCalledWith(true);
    expect(clearDraft).not.toHaveBeenCalled();

    deferred.resolve();

    await expect(submitPromise).resolves.toBe("submitted");
    expect(clearDraft).toHaveBeenCalledWith("sent");
  });

  it("queues while the agent is running and clears the composer immediately", async () => {
    const queueMessage = vi.fn();
    const submitMessage = vi.fn();
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    await expect(
      submitAgentInput({
        message: "  queued message  ",
        attachments: [{ id: "img-1" }],
        isAgentRunning: true,
        canSubmit: true,
        queueMessage,
        submitMessage,
        clearDraft,
        setUserInput,
        setAttachments,
        setSendError,
        setIsProcessing,
      }),
    ).resolves.toBe("queued");

    expect(queueMessage).toHaveBeenCalledWith({
      message: "queued message",
      attachments: [{ id: "img-1" }],
    });
    expect(submitMessage).not.toHaveBeenCalled();
    expect(setUserInput).toHaveBeenCalledWith("");
    expect(setAttachments).toHaveBeenCalledWith([]);
    expect(setSendError).not.toHaveBeenCalled();
    expect(setIsProcessing).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
  });

  it("restores the composer when submit fails", async () => {
    const submitError = new Error("No host selected");
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {
      throw submitError;
    });
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();
    const onSubmitError = vi.fn();
    const attachments = [{ id: "img-1" }];

    await expect(
      submitAgentInput({
        message: "  hello world  ",
        attachments,
        isAgentRunning: false,
        canSubmit: true,
        queueMessage,
        submitMessage,
        clearDraft,
        setUserInput,
        setAttachments,
        setSendError,
        setIsProcessing,
        onSubmitError,
      }),
    ).resolves.toBe("failed");

    expect(onSubmitError).toHaveBeenCalledWith(submitError);
    expect(setUserInput).toHaveBeenNthCalledWith(1, "");
    expect(setUserInput).toHaveBeenNthCalledWith(2, "hello world");
    expect(setAttachments).toHaveBeenNthCalledWith(1, []);
    expect(setAttachments).toHaveBeenNthCalledWith(2, attachments);
    expect(setSendError).toHaveBeenNthCalledWith(1, null);
    expect(setSendError).toHaveBeenNthCalledWith(2, submitError);
    expect(setIsProcessing).toHaveBeenNthCalledWith(1, true);
    expect(setIsProcessing).toHaveBeenNthCalledWith(2, false);
    expect(clearDraft).not.toHaveBeenCalled();
  });

  it("restores a steered active-turn draft after an ambiguous immediate-send error", async () => {
    const error = new Error("connection lost after delivery");
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    await expect(
      submitAgentInput({
        message: "  steer this turn  ",
        attachments: [{ id: "img-1" }],
        forceSend: true,
        isAgentRunning: true,
        canSubmit: true,
        queueMessage: vi.fn(),
        submitMessage: async () => {
          throw error;
        },
        clearDraft: vi.fn(),
        setUserInput,
        setAttachments,
        setSendError,
        setIsProcessing,
      }),
    ).resolves.toBe("failed");

    expect(setUserInput).toHaveBeenNthCalledWith(1, "");
    expect(setUserInput).toHaveBeenNthCalledWith(2, "steer this turn");
    expect(setAttachments).toHaveBeenNthCalledWith(1, []);
    expect(setAttachments).toHaveBeenNthCalledWith(2, [{ id: "img-1" }]);
    expect(setSendError).toHaveBeenLastCalledWith(error);
  });

  it.each(["accepted", "rejected"] as const)(
    "keeps an interrupt draft and attachments editable until the request is %s",
    async (outcome) => {
      const pending = createDeferredPromise<void>();
      const failure = Object.assign(new Error("Diagnostic details from the host"), {
        code: "agent_cancellation_unacknowledged",
      });
      const originalAttachments = [{ id: "image-original" }];
      let text = "original message";
      let attachments = originalAttachments;
      const clearDraft = vi.fn();
      const setSendError = vi.fn();
      const setIsProcessing = vi.fn();
      const submitting = submitAgentInput({
        message: text,
        attachments,
        forceSend: true,
        isAgentRunning: true,
        canSubmit: true,
        snapshot: {
          isCurrentTarget: () => true,
          isInputUnchanged: () =>
            text === "original message" && attachments === originalAttachments,
        },
        queueMessage: vi.fn(),
        submitMessage: () => pending.promise,
        clearDraft,
        setUserInput: (next) => {
          text = next;
        },
        setAttachments: (next) => {
          attachments = next;
        },
        setSendError,
        setIsProcessing,
      });
      expect(text).toBe("original message");
      expect(attachments).toBe(originalAttachments);
      expect(setIsProcessing).toHaveBeenLastCalledWith(true);
      text = "edited while stopping";
      attachments = [...originalAttachments, { id: "new-image" }];
      if (outcome === "accepted") pending.resolve();
      else pending.reject(failure);

      await expect(submitting).resolves.toBe(outcome === "accepted" ? "submitted" : "failed");
      expect(text).toBe("edited while stopping");
      expect(attachments.map((attachment) => attachment.id)).toEqual([
        "image-original",
        "new-image",
      ]);
      expect(clearDraft).not.toHaveBeenCalled();
      expect(setIsProcessing).toHaveBeenLastCalledWith(false);
      if (outcome === "rejected") expect(setSendError).toHaveBeenLastCalledWith(failure);
    },
  );

  it.each(["accepted", "rejected"] as const)(
    "settles an unchanged retained draft only after it is %s",
    async (outcome) => {
      const pending = createDeferredPromise<void>();
      const failure = Object.assign(new Error("The old task is still running"), {
        code: "agent_cancellation_unacknowledged",
      });
      const image = { id: "image-retained" };
      let text = "retry me";
      let attachments = [image];
      const clearDraft = vi.fn();
      const setSendError = vi.fn();
      const submitting = submitAgentInput({
        message: text,
        attachments,
        forceSend: true,
        isAgentRunning: true,
        canSubmit: true,
        snapshot: { isCurrentTarget: () => true, isInputUnchanged: () => true },
        queueMessage: vi.fn(),
        submitMessage: () => pending.promise,
        clearDraft,
        setUserInput: (next) => {
          text = next;
        },
        setAttachments: (next) => {
          attachments = next;
        },
        setSendError,
        setIsProcessing: vi.fn(),
      });
      expect(text).toBe("retry me");
      expect(attachments).toEqual([image]);
      expect(clearDraft).not.toHaveBeenCalled();
      if (outcome === "accepted") pending.resolve();
      else pending.reject(failure);
      await expect(submitting).resolves.toBe(outcome === "accepted" ? "submitted" : "failed");
      if (outcome === "accepted") {
        expect(text).toBe("");
        expect(attachments).toEqual([]);
        expect(clearDraft).toHaveBeenCalledOnce();
      } else {
        expect(text).toBe("retry me");
        expect(attachments).toEqual([image]);
        expect(clearDraft).not.toHaveBeenCalled();
        expect(setSendError).toHaveBeenLastCalledWith(failure);
      }
    },
  );

  it.each(["accepted", "rejected"] as const)(
    "does not apply a stale %s submission to another target's draft, errors, or processing state",
    async (outcome) => {
      const pending = createDeferredPromise<void>();
      const oldTarget = { serverId: "host-a", agentId: "agent" };
      let currentTarget = oldTarget;
      let draft = { text: "old draft", attachments: [{ id: "old-image" }] };
      const clearDraft = vi.fn();
      const setSendError = vi.fn();
      const setIsProcessing = vi.fn();
      const submitting = submitAgentInput({
        message: draft.text,
        attachments: draft.attachments,
        forceSend: true,
        isAgentRunning: true,
        canSubmit: true,
        snapshot: {
          isCurrentTarget: () => currentTarget === oldTarget,
          isInputUnchanged: () => true,
        },
        queueMessage: vi.fn(),
        submitMessage: () => pending.promise,
        clearDraft,
        setUserInput: (text) => {
          draft = { ...draft, text };
        },
        setAttachments: (attachments) => {
          draft = { ...draft, attachments };
        },
        setSendError,
        setIsProcessing,
      });
      // Even the same agent ID on another server is a different composer target.
      currentTarget = { serverId: "host-b", agentId: "agent" };
      draft = { text: "new target's draft", attachments: [{ id: "new-image" }] };
      if (outcome === "accepted") pending.resolve();
      else pending.reject(new Error("old target failed"));
      await submitting;
      expect(draft).toEqual({ text: "new target's draft", attachments: [{ id: "new-image" }] });
      expect(clearDraft).not.toHaveBeenCalled();
      expect(setSendError.mock.calls).toEqual([[null]]);
      expect(setIsProcessing.mock.calls).toEqual([[true]]);
    },
  );

  it("submits when empty submit is explicitly allowed", async () => {
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {});
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    await expect(
      submitAgentInput({
        message: "   ",
        attachments: [],
        allowEmptySubmit: true,
        isAgentRunning: false,
        canSubmit: true,
        queueMessage,
        submitMessage,
        clearDraft,
        setUserInput,
        setAttachments,
        setSendError,
        setIsProcessing,
      }),
    ).resolves.toBe("submitted");

    expect(queueMessage).not.toHaveBeenCalled();
    expect(submitMessage).toHaveBeenCalledWith({
      message: "",
      attachments: [],
    });
    expect(clearDraft).toHaveBeenCalledWith("sent");
  });
});
