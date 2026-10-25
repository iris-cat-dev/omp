import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { toCheckoutErrorMock } = vi.hoisted(() => ({
  toCheckoutErrorMock: vi.fn((error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  })),
}));

vi.mock("./checkout-git-utils.js", () => ({
  toCheckoutError: toCheckoutErrorMock,
}));

import type pino from "pino";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { WorkspaceGitRuntimeSnapshot, WorkspaceGitService } from "./workspace-git-service.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createWorkspaceSnapshot(
  overrides?: Partial<WorkspaceGitRuntimeSnapshot["git"]>,
): WorkspaceGitRuntimeSnapshot {
  return {
    cwd: "/tmp/repo",
    git: {
      isGit: true,
      repoRoot: "/tmp/repo",
      mainRepoRoot: null,
      currentBranch: "feature",
      remoteUrl: "https://github.com/acme/repo.git",
      isPaseoOwnedWorktree: false,
      isDirty: false,
      baseRef: "main",
      aheadBehind: { ahead: 1, behind: 0 },
      aheadOfOrigin: 1,
      behindOfOrigin: 0,
      hasRemote: true,
      diffStat: { additions: 1, deletions: 0 },
      ...overrides,
    },
    forge: {
      featuresEnabled: false,
      authState: "no_remote",
      pullRequest: null,
      error: null,
    },
  };
}

function createPendingManager() {
  const watches: Array<{
    cwd: string;
    onChange: () => void;
    unsubscribeCalls: number;
    resolve(): void;
  }> = [];
  const workspaceGitService = {
    getCheckoutDiff: vi.fn(async () => ({ diff: "", structured: [] })),
    getSnapshot: async () => createWorkspaceSnapshot(),
    peekSnapshot: () => null,
    registerWorkspace: () => ({ unsubscribe: () => {} }),
    requestWorkingTreeWatch: (cwd: string, onChange: () => void) => {
      const pending = createDeferred<{ repoRoot: string | null; unsubscribe: () => void }>();
      const watch = {
        cwd,
        onChange,
        unsubscribeCalls: 0,
        resolve: () => {
          pending.resolve({
            repoRoot: "/tmp/repo",
            unsubscribe: () => {
              watch.unsubscribeCalls += 1;
            },
          });
        },
      };
      watches.push(watch);
      return pending.promise;
    },
  };
  const logger = { child: () => logger, warn: () => {} };
  const manager = new CheckoutDiffManager({
    logger: logger as unknown as pino.Logger,
    paseoHome: "/tmp/paseo-test",
    workspaceGitService,
  });
  return { manager, watches, workspaceGitService };
}

describe("CheckoutDiffManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    toCheckoutErrorMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createManager(options?: {
    repoRoot?: string | null;
    getCheckoutDiffImplementation?: ReturnType<typeof vi.fn>;
  }) {
    const unsubscribe = vi.fn();
    const workspaceUnsubscribe = vi.fn();
    let onChange: (() => void) | null = null;
    let onWorkspaceSnapshot: ((snapshot: WorkspaceGitRuntimeSnapshot) => void) | null = null;
    const mockRequestWorkingTreeWatch = vi.fn(async (_cwd: string, listener: () => void) => {
      onChange = listener;
      return {
        repoRoot: options?.repoRoot === undefined ? "/tmp/repo" : options.repoRoot,
        unsubscribe,
      };
    });

    const workspaceGitService = {
      subscribe: vi.fn(),
      peekSnapshot: vi.fn(),
      registerWorkspace: vi.fn(
        (_params: { cwd: string }, listener: (snapshot: WorkspaceGitRuntimeSnapshot) => void) => {
          onWorkspaceSnapshot = listener;
          return { unsubscribe: workspaceUnsubscribe };
        },
      ),
      getSnapshot: vi.fn(async () => createWorkspaceSnapshot()),
      getCheckoutDiff:
        options?.getCheckoutDiffImplementation ?? vi.fn(async () => ({ diff: "", structured: [] })),
      refresh: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      requestWorkingTreeWatch: mockRequestWorkingTreeWatch,
      dispose: vi.fn(),
    };

    const logger = {
      child: () => logger,
      warn: vi.fn(),
    };

    const manager = new CheckoutDiffManager({
      logger: logger as unknown as pino.Logger,
      paseoHome: "/tmp/paseo-test",
      workspaceGitService: workspaceGitService as unknown as WorkspaceGitService,
    });

    return {
      manager,
      workspaceGitService,
      mockRequestWorkingTreeWatch,
      unsubscribe,
      getOnChange: () => onChange,
      getOnWorkspaceSnapshot: () => onWorkspaceSnapshot,
      workspaceUnsubscribe,
    };
  }

  test("subscribe requests a working tree watch with the correct cwd", async () => {
    const { manager, mockRequestWorkingTreeWatch } = createManager();

    await manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
      },
      () => {},
    );

    expect(mockRequestWorkingTreeWatch).toHaveBeenCalledWith(
      "/tmp/repo/packages/server",
      expect.any(Function),
    );
  });

  test("unsubscribe calls the working tree watch unsubscribe", async () => {
    const { manager, unsubscribe } = createManager();

    const subscription = await manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
      },
      () => {},
    );

    subscription.unsubscribe();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("cancels a subscription while its working tree watch is still opening", async () => {
    const { manager, watches, workspaceGitService } = createPendingManager();
    const abort = new AbortController();

    const pendingSubscription = manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
        signal: abort.signal,
      },
      () => {},
    );
    abort.abort();
    watches[0].resolve();
    await expect(pendingSubscription).rejects.toMatchObject({ name: "AbortError" });

    expect(watches[0].unsubscribeCalls).toBe(1);
    expect(workspaceGitService.getCheckoutDiff).not.toHaveBeenCalled();
    expect(manager.getMetrics()).toEqual({
      checkoutDiffTargetCount: 0,
      checkoutDiffSubscriptionCount: 0,
      checkoutDiffWatcherCount: 0,
      checkoutDiffFallbackRefreshTargetCount: 0,
    });
  });

  test("does not initialize a subscription that was already aborted", async () => {
    const { manager, watches, workspaceGitService } = createPendingManager();
    const abort = new AbortController();
    abort.abort();

    await expect(
      manager.subscribe(
        {
          cwd: "/tmp/repo",
          compare: { mode: "uncommitted" },
          signal: abort.signal,
        },
        () => {},
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(watches).toHaveLength(0);
    expect(workspaceGitService.getCheckoutDiff).not.toHaveBeenCalled();
    expect(manager.getMetrics().checkoutDiffTargetCount).toBe(0);
  });

  test("canceling one opening consumer leaves the shared subscription live", async () => {
    const { manager, watches, workspaceGitService } = createPendingManager();
    const abort = new AbortController();
    const canceledListener = vi.fn();
    const canceled = manager.subscribe(
      { cwd: "/tmp/repo", compare: { mode: "uncommitted" }, signal: abort.signal },
      canceledListener,
    );
    const live = manager.subscribe(
      { cwd: "/tmp/repo", compare: { mode: "uncommitted" } },
      () => {},
    );
    abort.abort();
    watches[0].resolve();
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    const subscription = await live;

    expect(subscription.initial).toEqual({ cwd: "/tmp/repo", files: [], error: null });
    expect(workspaceGitService.getCheckoutDiff).toHaveBeenCalledTimes(1);
    expect(canceledListener).not.toHaveBeenCalled();
    expect(watches[0].unsubscribeCalls).toBe(0);
    expect(manager.getMetrics().checkoutDiffSubscriptionCount).toBe(1);
    subscription.unsubscribe();
    expect(watches[0].unsubscribeCalls).toBe(1);
  });

  test("drops an abandoned initial read without a fallback or queued refresh", async () => {
    const diff = createDeferred<{ diff: string; structured: [] }>();
    const started = createDeferred<void>();
    const getCheckoutDiff = vi.fn(() => {
      started.resolve();
      return diff.promise;
    });
    const { manager, getOnChange, unsubscribe } = createManager({
      getCheckoutDiffImplementation: getCheckoutDiff,
    });
    const abort = new AbortController();
    const listener = vi.fn();
    const pending = manager.subscribe(
      { cwd: "/tmp/repo", compare: { mode: "uncommitted" }, signal: abort.signal },
      listener,
    );
    await started.promise;
    manager.scheduleRefreshForCwd("/tmp/repo");
    abort.abort();
    getOnChange()?.();
    diff.resolve({ diff: "", structured: [] });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(150);

    expect(getCheckoutDiff).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(manager.getMetrics().checkoutDiffTargetCount).toBe(0);
  });

  test("does not initialize a base diff after its workspace read is abandoned", async () => {
    const snapshot = createDeferred<WorkspaceGitRuntimeSnapshot>();
    const { manager, workspaceGitService } = createManager();
    workspaceGitService.getSnapshot.mockImplementation(() => snapshot.promise);
    const abort = new AbortController();
    const pending = manager.subscribe(
      { cwd: "/tmp/repo", compare: { mode: "base" }, signal: abort.signal },
      () => {},
    );
    abort.abort();
    snapshot.resolve(createWorkspaceSnapshot());
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    expect(workspaceGitService.registerWorkspace).not.toHaveBeenCalled();
    expect(workspaceGitService.getCheckoutDiff).not.toHaveBeenCalled();
    expect(manager.getMetrics().checkoutDiffTargetCount).toBe(0);
  });

  test("shares one opening target between concurrent subscriptions", async () => {
    const { manager, watches } = createPendingManager();

    const firstSubscription = manager.subscribe(
      { cwd: "/tmp/repo/packages/server", compare: { mode: "uncommitted" } },
      () => {},
    );
    const secondSubscription = manager.subscribe(
      { cwd: "/tmp/repo/packages/server", compare: { mode: "uncommitted" } },
      () => {},
    );

    expect(watches).toHaveLength(1);
    watches[0].resolve();
    const [first, second] = await Promise.all([firstSubscription, secondSubscription]);
    expect(manager.getMetrics().checkoutDiffSubscriptionCount).toBe(2);

    first.unsubscribe();
    expect(watches[0].unsubscribeCalls).toBe(0);
    second.unsubscribe();
    expect(watches[0].unsubscribeCalls).toBe(1);
  });

  test("diffCwd uses repoRoot from the working tree watch result", async () => {
    const { manager, workspaceGitService } = createManager({ repoRoot: "/tmp/repo" });

    await manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
      },
      () => {},
    );

    expect(workspaceGitService.getCheckoutDiff).toHaveBeenCalledWith(
      "/tmp/repo",
      expect.objectContaining({ mode: "uncommitted", includeStructured: true }),
      undefined,
    );
  });

  test("diff refresh is triggered when the working tree watch callback fires", async () => {
    const getCheckoutDiff = vi
      .fn()
      .mockResolvedValueOnce({
        diff: "",
        structured: [{ path: "a.ts", additions: 1, deletions: 0, status: "modified" }],
      })
      .mockResolvedValueOnce({
        diff: "",
        structured: [{ path: "b.ts", additions: 2, deletions: 0, status: "modified" }],
      });

    const { manager, getOnChange } = createManager({
      getCheckoutDiffImplementation: getCheckoutDiff,
    });
    const listener = vi.fn();

    await manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
      },
      listener,
    );

    const onChange = getOnChange();
    expect(onChange).toBeTypeOf("function");

    onChange?.();
    await vi.advanceTimersByTimeAsync(150);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      cwd: "/tmp/repo/packages/server",
      files: [{ path: "b.ts", additions: 2, deletions: 0, status: "modified" }],
      error: null,
    });
  });

  test("watch-triggered refresh forces a cache bypass on getCheckoutDiff", async () => {
    const getCheckoutDiff = vi
      .fn()
      .mockResolvedValueOnce({
        diff: "",
        structured: [{ path: "a.ts", additions: 1, deletions: 0, status: "modified" }],
      })
      .mockResolvedValueOnce({
        diff: "",
        structured: [{ path: "b.ts", additions: 2, deletions: 0, status: "modified" }],
      });

    const { manager, getOnChange } = createManager({
      getCheckoutDiffImplementation: getCheckoutDiff,
    });

    await manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
      },
      vi.fn(),
    );

    expect(getCheckoutDiff).toHaveBeenNthCalledWith(
      1,
      "/tmp/repo",
      expect.objectContaining({ mode: "uncommitted" }),
      undefined,
    );

    const onChange = getOnChange();
    onChange?.();
    await vi.advanceTimersByTimeAsync(150);

    expect(getCheckoutDiff).toHaveBeenCalledTimes(2);
    const watchFiredCall = getCheckoutDiff.mock.calls[1];
    expect(watchFiredCall[2]).toEqual({
      force: true,
      reason: expect.stringContaining("working-tree"),
    });
  });

  test("an edit during an in-flight diff refresh produces one final follow-up", async () => {
    const inFlightDiff = createDeferred<{
      diff: string;
      structured: Array<{
        path: string;
        additions: number;
        deletions: number;
        status: "modified";
      }>;
    }>();
    const getCheckoutDiff = vi
      .fn()
      .mockResolvedValueOnce({
        diff: "",
        structured: [{ path: "tracked.ts", additions: 1, deletions: 0, status: "modified" }],
      })
      .mockImplementationOnce(() => inFlightDiff.promise)
      .mockResolvedValue({
        diff: "",
        structured: [{ path: "tracked.ts", additions: 100, deletions: 25, status: "modified" }],
      });
    const { manager, getOnChange } = createManager({
      getCheckoutDiffImplementation: getCheckoutDiff,
    });
    const listener = vi.fn();

    await manager.subscribe({ cwd: "/tmp/repo", compare: { mode: "uncommitted" } }, listener);
    getOnChange()?.();
    await vi.advanceTimersByTimeAsync(150);
    expect(getCheckoutDiff).toHaveBeenCalledTimes(2);

    for (let event = 0; event < 100; event += 1) {
      getOnChange()?.();
    }
    await vi.advanceTimersByTimeAsync(150);
    expect(getCheckoutDiff).toHaveBeenCalledTimes(2);

    inFlightDiff.resolve({
      diff: "",
      structured: [{ path: "tracked.ts", additions: 2, deletions: 1, status: "modified" }],
    });
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledTimes(1);
      expect(getCheckoutDiff).toHaveBeenCalledTimes(3);
      expect(listener).toHaveBeenLastCalledWith({
        cwd: "/tmp/repo",
        files: [{ path: "tracked.ts", additions: 100, deletions: 25, status: "modified" }],
        error: null,
      });
    });
  });

  test("publishes both staging lists immediately after a mutation", async () => {
    const stagedFiles = [{ path: "tracked.ts", additions: 1, deletions: 0, hunks: [] }];
    const getCheckoutDiff = vi
      .fn()
      .mockResolvedValueOnce({
        diff: "",
        structured: stagedFiles,
        staging: { stagedFiles: [], unstagedFiles: stagedFiles },
      })
      .mockResolvedValue({
        diff: "",
        structured: stagedFiles,
        staging: { stagedFiles, unstagedFiles: [] },
      });
    const { manager, getOnChange } = createManager({
      getCheckoutDiffImplementation: getCheckoutDiff,
    });
    const listener = vi.fn();
    await manager.subscribe(
      { cwd: "/tmp/repo", compare: { mode: "uncommitted", detail: "summary" } },
      listener,
    );

    getOnChange()?.();
    manager.scheduleRefreshForCwd("/tmp/repo");
    await vi.advanceTimersByTimeAsync(0);

    expect(listener).toHaveBeenCalledExactlyOnceWith({
      cwd: "/tmp/repo",
      files: stagedFiles,
      staging: { stagedFiles, unstagedFiles: [] },
      error: null,
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(listener).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  test("does not replace newer staging state with an in-flight pre-mutation snapshot", async () => {
    const staleRead = createDeferred<{
      diff: string;
      structured: never[];
      staging: { stagedFiles: never[]; unstagedFiles: never[] };
    }>();
    const file = { path: "tracked.ts", additions: 1, deletions: 0, hunks: [] };
    const getCheckoutDiff = vi
      .fn()
      .mockResolvedValueOnce({ diff: "", structured: [] })
      .mockImplementationOnce(() => staleRead.promise)
      .mockResolvedValue({
        diff: "",
        structured: [file],
        staging: { stagedFiles: [file], unstagedFiles: [] },
      });
    const { manager } = createManager({ getCheckoutDiffImplementation: getCheckoutDiff });
    const listener = vi.fn();
    await manager.subscribe(
      { cwd: "/tmp/repo", compare: { mode: "uncommitted", detail: "summary" } },
      listener,
    );

    manager.scheduleRefreshForCwd("/tmp/repo");
    manager.scheduleRefreshForCwd("/tmp/repo");
    staleRead.resolve({
      diff: "",
      structured: [],
      staging: { stagedFiles: [], unstagedFiles: [] },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(listener).toHaveBeenCalledExactlyOnceWith({
      cwd: "/tmp/repo",
      files: [file],
      staging: { stagedFiles: [file], unstagedFiles: [] },
      error: null,
    });
    manager.dispose();
  });

  test("a mutation during initial loading returns the refreshed staging snapshot", async () => {
    const initialRead = createDeferred<{ diff: string; structured: never[] }>();
    const file = { path: "tracked.ts", additions: 1, deletions: 0, hunks: [] };
    const getCheckoutDiff = vi
      .fn()
      .mockImplementationOnce(() => initialRead.promise)
      .mockResolvedValue({
        diff: "",
        structured: [file],
        staging: { stagedFiles: [file], unstagedFiles: [] },
      });
    const { manager } = createManager({ getCheckoutDiffImplementation: getCheckoutDiff });
    const subscription = manager.subscribe(
      { cwd: "/tmp/repo", compare: { mode: "uncommitted", detail: "summary" } },
      vi.fn(),
    );
    await vi.advanceTimersByTimeAsync(0);
    manager.scheduleRefreshForCwd("/tmp/repo");
    initialRead.resolve({ diff: "", structured: [] });

    expect((await subscription).initial).toEqual({
      cwd: "/tmp/repo",
      files: [file],
      staging: { stagedFiles: [file], unstagedFiles: [] },
      error: null,
    });
    manager.dispose();
  });

  test("base diff subscriptions ignore ordinary working tree edits", async () => {
    const getCheckoutDiff = vi.fn(async () => ({
      diff: "",
      structured: [{ path: "committed.ts", additions: 1, deletions: 0, status: "modified" }],
    }));
    const { manager, getOnChange, mockRequestWorkingTreeWatch } = createManager({
      getCheckoutDiffImplementation: getCheckoutDiff,
    });

    await manager.subscribe(
      { cwd: "/tmp/repo", compare: { mode: "base", baseRef: "main" } },
      vi.fn(),
    );
    getOnChange()?.();
    await vi.advanceTimersByTimeAsync(150);

    expect(getCheckoutDiff).toHaveBeenCalledTimes(1);
    expect(mockRequestWorkingTreeWatch).not.toHaveBeenCalled();
  });

  test("base diff subscriptions ignore worktree-only workspace snapshot updates", async () => {
    const getCheckoutDiff = vi.fn(async () => ({ diff: "", structured: [] }));
    const { manager, getOnWorkspaceSnapshot } = createManager({
      getCheckoutDiffImplementation: getCheckoutDiff,
    });

    await manager.subscribe(
      { cwd: "/tmp/repo", compare: { mode: "base", baseRef: "main" } },
      vi.fn(),
    );

    getOnWorkspaceSnapshot()?.(
      createWorkspaceSnapshot({
        isDirty: true,
        diffStat: { additions: 5, deletions: 2 },
      }),
    );
    await vi.advanceTimersByTimeAsync(150);

    expect(getCheckoutDiff).toHaveBeenCalledTimes(1);
  });

  test("base diff subscriptions refresh for structural workspace changes", async () => {
    const getCheckoutDiff = vi.fn(async () => ({ diff: "", structured: [] }));
    const { manager, getOnWorkspaceSnapshot, workspaceGitService } = createManager({
      getCheckoutDiffImplementation: getCheckoutDiff,
    });

    await manager.subscribe(
      { cwd: "/tmp/repo", compare: { mode: "base", baseRef: "main" } },
      vi.fn(),
    );

    expect(workspaceGitService.registerWorkspace).toHaveBeenCalledTimes(1);
    getOnWorkspaceSnapshot()?.(
      createWorkspaceSnapshot({
        currentBranch: "feature-2",
        isDirty: true,
        diffStat: { additions: 5, deletions: 2 },
      }),
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(getCheckoutDiff).toHaveBeenCalledTimes(2);
    expect(getCheckoutDiff.mock.calls[1]?.[2]).toBeUndefined();

    getOnWorkspaceSnapshot()?.(createWorkspaceSnapshot({ aheadBehind: { ahead: 2, behind: 0 } }));
    await vi.advanceTimersByTimeAsync(150);
    expect(getCheckoutDiff).toHaveBeenCalledTimes(3);
  });

  test("falls back to cwd when the working tree watch returns no repo root", async () => {
    const { manager, workspaceGitService } = createManager({ repoRoot: null });

    await manager.subscribe(
      {
        cwd: "/tmp/plain",
        compare: { mode: "uncommitted" },
      },
      () => {},
    );

    expect(workspaceGitService.getCheckoutDiff).toHaveBeenCalledWith(
      "/tmp/plain",
      expect.objectContaining({ mode: "uncommitted", includeStructured: true }),
      undefined,
    );
  });
});
