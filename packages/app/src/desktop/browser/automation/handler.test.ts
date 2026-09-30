import { beforeEach, describe, expect, test } from "vitest";
import type { SessionInboundMessage, SessionOutboundMessage } from "@omp-desktop/protocol/messages";
import { createJSONStorage, type StateStorage } from "zustand/middleware";
import { mountBrowserAutomationHandler } from "./handler";
import type { DesktopHostBridge } from "@/desktop/host";
import { useBrowserStore } from "@/desktop/browser/store";
import { findPaneById } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

type BrowserAutomationExecuteRequest = Extract<
  SessionOutboundMessage,
  { type: "browser.automation.execute.request" }
>;
type BrowserAutomationExecuteResponse = Extract<
  SessionInboundMessage,
  { type: "browser.automation.execute.response" }
>;
type BrowserAutomationResponsePayload = BrowserAutomationExecuteResponse["payload"];

class FakeStateStorage implements StateStorage {
  private readonly values = new Map<string, string>();

  public getItem = (key: string): string | null => this.values.get(key) ?? null;

  public setItem = (key: string, value: string): void => {
    this.values.set(key, value);
  };

  public removeItem = (key: string): void => {
    this.values.delete(key);
  };

  public clear(): void {
    this.values.clear();
  }
}

class FakeDaemonClient {
  public readonly sentResponses: BrowserAutomationExecuteResponse[] = [];
  private handler: ((request: BrowserAutomationExecuteRequest) => void) | null = null;

  public on(
    type: "browser.automation.execute.request",
    handler: (request: BrowserAutomationExecuteRequest) => void,
  ): () => void {
    expect(type).toBe("browser.automation.execute.request");
    this.handler = handler;
    return () => {
      if (this.handler === handler) {
        this.handler = null;
      }
    };
  }

  public sendBrowserAutomationExecuteResponse(response: BrowserAutomationExecuteResponse): void {
    this.sentResponses.push(response);
  }

  public receive(nextRequest: BrowserAutomationExecuteRequest): void {
    this.handler?.(nextRequest);
  }

  public payloadAt(index: number): BrowserAutomationResponsePayload {
    const response = this.sentResponses[index];
    if (!response) {
      throw new Error(`Missing browser automation response at index ${index}`);
    }
    return response.payload;
  }
}

class FakeBrowserBridge {
  public readonly executedRequests: BrowserAutomationExecuteRequest[] = [];
  public readonly unregisteredWorkspaceBrowsers: string[] = [];
  public readonly activeWorkspaceBrowsers: Array<{
    browserId: string | null;
    workspaceId: string;
  }> = [];
  public response: BrowserAutomationResponsePayload | null = null;
  public thrownError: unknown = null;

  public executeAutomationCommand = async (
    request: BrowserAutomationExecuteRequest,
  ): Promise<BrowserAutomationResponsePayload> => {
    this.executedRequests.push(request);
    if (this.thrownError) {
      throw this.thrownError;
    }
    return this.response ?? currentListTabsPayload(request.requestId);
  };

  public unregisterWorkspaceBrowser = async (browserId: string): Promise<void> => {
    this.unregisteredWorkspaceBrowsers.push(browserId);
  };

  public setWorkspaceActiveBrowser = async (input: {
    browserId: string | null;
    workspaceId: string;
  }): Promise<void> => {
    this.activeWorkspaceBrowsers.push(input);
  };
}

class FakeResidentBrowser {
  public readonly ensuredWebviews: Array<{
    browserId: string;
    workspaceId: string;
    url: string;
  }> = [];

  public ensure = (input: {
    browserId: string;
    workspaceId: string;
    url: string;
  }): HTMLElement | null => {
    this.ensuredWebviews.push(input);
    return null;
  };
}

class BrowserAutomationHandlerHarness {
  public readonly client = new FakeDaemonClient();
  public readonly browser = new FakeBrowserBridge();
  public readonly resident = new FakeResidentBrowser();
  private unsubscribe: (() => void) | null = null;

  public mount(
    input: {
      serverId?: string;
      host?: DesktopHostBridge | null;
      registrationWaitTimeoutMs?: number;
      registrationPollIntervalMs?: number;
      getVisibleWorkspaceSelection?: () => { serverId: string; workspaceId: string } | null;
    } = {},
  ): void {
    this.unsubscribe = mountBrowserAutomationHandler({
      client: this.client,
      ...(input.serverId ? { serverId: input.serverId } : {}),
      getHost: () => (input.host === undefined ? { browser: this.browser } : input.host),
      ensureResidentBrowserWebview: this.resident.ensure,
      ...(input.getVisibleWorkspaceSelection
        ? { getVisibleWorkspaceSelection: input.getVisibleWorkspaceSelection }
        : {}),
      ...(input.registrationWaitTimeoutMs !== undefined
        ? { registrationWaitTimeoutMs: input.registrationWaitTimeoutMs }
        : {}),
      ...(input.registrationPollIntervalMs !== undefined
        ? { registrationPollIntervalMs: input.registrationPollIntervalMs }
        : {}),
    });
  }

  public unmount(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  public receive(request: BrowserAutomationExecuteRequest): void {
    this.client.receive(request);
  }
}

function browserAutomationRequest(): BrowserAutomationExecuteRequest {
  return {
    type: "browser.automation.execute.request",
    requestId: "req-1",
    command: { command: "list_tabs", args: {} },
  };
}

function browserNewTabRequest(): BrowserAutomationExecuteRequest {
  return {
    type: "browser.automation.execute.request",
    requestId: "req-new",
    agentId: "agent-1",
    workspaceId: "wks_workspace_a",
    command: {
      command: "new_tab",
      args: { url: "https://example.com" },
    },
  };
}

function browserResizeRequest(
  browserId: string,
  input: { workspaceId?: string } = {},
): BrowserAutomationExecuteRequest {
  return {
    type: "browser.automation.execute.request",
    requestId: "req-resize",
    agentId: "agent-1",
    workspaceId: input.workspaceId ?? "wks_workspace_a",
    command: {
      command: "resize",
      args: { browserId, width: 1024, height: 768 },
    },
  };
}

function browserCloseTabRequest(browserId: string): BrowserAutomationExecuteRequest {
  return {
    type: "browser.automation.execute.request",
    requestId: "req-close-tab",
    agentId: "agent-1",
    workspaceId: "wks_workspace_a",
    command: {
      command: "close_tab",
      args: { browserId },
    },
  };
}

function emptyListTabsPayload(requestId = "req-new:list_tabs"): BrowserAutomationResponsePayload {
  return {
    requestId,
    ok: true,
    result: {
      command: "list_tabs",
      tabs: [],
    },
  };
}

function currentListTabsPayload(requestId = "req-new:list_tabs"): BrowserAutomationResponsePayload {
  return {
    requestId,
    ok: true,
    result: {
      command: "list_tabs",
      tabs: currentBrowserTabs(),
    },
  };
}

function currentBrowserTabs() {
  return Object.values(useBrowserStore.getState().browsersById).map((browser) => ({
    browserId: browser.browserId,
    workspaceId: "wks_workspace_a",
    url: browser.url,
    title: browser.title,
    isActive: true,
    isLoading: false,
  }));
}

function newTabResultFrom(payload: BrowserAutomationResponsePayload) {
  expect(payload).toMatchObject({
    requestId: "req-new",
    ok: true,
    result: {
      command: "new_tab",
      workspaceId: "wks_workspace_a",
      presentationHostWorkspaceId: "wks_workspace_a",
      presented: false,
      activated: false,
      url: "https://example.com",
    },
  });
  if (!payload.ok || payload.result.command !== "new_tab") {
    throw new Error("Expected browser_new_tab success payload");
  }
  return payload.result;
}

function workspaceBrowserTabs(workspaceKey: string, browserId: string) {
  return useWorkspaceLayoutStore
    .getState()
    .getWorkspaceTabs(workspaceKey)
    .filter((tab) => tab.target.kind === "browser" && tab.target.browserId === browserId);
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function waitForRegistrationTimeout(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

const browserAutomationStorage = new FakeStateStorage();
useBrowserStore.persist.setOptions({
  storage: createJSONStorage(() => browserAutomationStorage),
});
useWorkspaceLayoutStore.persist.setOptions({
  storage: createJSONStorage(() => browserAutomationStorage),
});

describe("mountBrowserAutomationHandler", () => {
  beforeEach(() => {
    browserAutomationStorage.clear();
    useBrowserStore.setState({ browsersById: {} });
    useWorkspaceLayoutStore.setState({ layoutByWorkspace: {} });
  });

  test("browser_new_tab creates a workspace browser tab without stealing focus", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: "server-1",
      workspaceId: "wks_workspace_a",
    });
    if (!workspaceKey) {
      throw new Error("Expected workspace key");
    }
    const previousFocusedTabId = useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: workspaceKey,
      target: { kind: "draft", draftId: "human-draft" },
      intent: "reveal",
    });
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();

    const result = newTabResultFrom(browser.client.payloadAt(0));
    const openedTabs = workspaceBrowserTabs(workspaceKey, result.browserId);
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(openedTabs).toEqual([
      expect.objectContaining({
        target: { kind: "browser", browserId: result.browserId },
      }),
    ]);
    // Workspaces keep a stable hidden explorer companion pane at the root
    // (see "retain workspace explorer pane"), so the root is a group and the
    // draft/browser tabs land in the "main" pane, not at the root directly.
    if (!layout) {
      throw new Error("Expected workspace layout");
    }
    expect(layout.root.kind).toBe("group");
    expect(findPaneById(layout.root, "main")).toEqual(
      expect.objectContaining({ focusedTabId: previousFocusedTabId }),
    );
    expect(openedTabs[0]?.tabId).not.toBe(previousFocusedTabId);
    expect(browser.browser.activeWorkspaceBrowsers).toEqual([]);
    expect(browser.resident.ensuredWebviews).toEqual([
      {
        browserId: result.browserId,
        workspaceId: "wks_workspace_a",
        url: "https://example.com",
      },
    ]);
    expect(browser.browser.executedRequests).toEqual([
      {
        type: "browser.automation.execute.request",
        requestId: "req-new:list_tabs",
        agentId: "agent-1",
        workspaceId: "wks_workspace_a",
        command: { command: "list_tabs", args: {} },
      },
    ]);
  });

  test("recovers an existing cross-host browser after owner-route reentry without replacing its page", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    const ownerKey = "server-1:wks_workspace_a";
    const hostKey = "server-1:wks_workspace_b";
    let visibleWorkspace = { serverId: "server-1", workspaceId: "wks_workspace_b" };
    const draftTabId = useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: hostKey,
      target: { kind: "draft", draftId: "msg_cross_host" },
      intent: "reveal",
    })!;
    useWorkspaceLayoutStore.getState().convertDraftToAgent(hostKey, draftTabId, "agent-1");
    browser.mount({
      serverId: "server-1",
      getVisibleWorkspaceSelection: () => visibleWorkspace,
    });
    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    const created = browser.client.payloadAt(0);
    if (!created.ok || created.result.command !== "new_tab") throw new Error("Expected browser");
    const browserId = created.result.browserId;
    const originalRecord = useBrowserStore.getState().browsersById[browserId];
    visibleWorkspace = { serverId: "server-1", workspaceId: "wks_workspace_a" };
    const focusedAgent = useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: ownerKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    browser.receive({
      ...browserNewTabRequest(),
      requestId: "req-list",
      command: { command: "list_tabs", args: {} },
    });
    await flushAsyncWork();
    expect(browser.client.payloadAt(1)).toMatchObject({
      ok: true,
      result: {
        tabs: [
          {
            browserId,
            ownerWorkspaceId: "wks_workspace_a",
            presentationHostWorkspaceId: "wks_workspace_b",
            presented: false,
            activated: false,
            isActive: false,
          },
        ],
      },
    });
    browser.browser.response = {
      requestId: "req-navigate",
      ok: true,
      result: { command: "navigate", browserId, url: "https://example.com/next" },
    };
    browser.receive({
      ...browserNewTabRequest(),
      requestId: "req-navigate",
      command: { command: "navigate", args: { browserId, url: "https://example.com/next" } },
    });
    await flushAsyncWork();
    expect(browser.client.payloadAt(2)).toMatchObject({
      ok: true,
      result: { command: "navigate", presented: false, activated: false },
    });
    expect(
      findPaneById(useWorkspaceLayoutStore.getState().layoutByWorkspace[ownerKey]!.root, "main")
        ?.focusedTabId,
    ).toBe(focusedAgent);
    browser.receive({
      ...browserNewTabRequest(),
      requestId: "req-reveal",
      command: { command: "reveal", args: { browserId } },
    });
    await flushAsyncWork();
    expect(browser.client.payloadAt(3)).toMatchObject({
      ok: true,
      result: {
        command: "reveal",
        browserId,
        ownerWorkspaceId: "wks_workspace_a",
        presentationHostWorkspaceId: "wks_workspace_a",
        presented: true,
        activated: true,
      },
    });
    expect(workspaceBrowserTabs(hostKey, browserId)).toEqual([]);
    const recovered = workspaceBrowserTabs(ownerKey, browserId);
    expect(
      findPaneById(useWorkspaceLayoutStore.getState().layoutByWorkspace[ownerKey]!.root, "main")
        ?.focusedTabId,
    ).toBe(recovered[0]?.tabId);
    expect(useBrowserStore.getState().browsersById[browserId]).toBe(originalRecord);
    expect(browser.resident.ensuredWebviews).toEqual([
      { browserId, workspaceId: "wks_workspace_a", url: "https://example.com" },
    ]);
    expect(browser.browser.unregisteredWorkspaceBrowsers).toEqual([]);
    browser.unmount();
  });

  test.each([
    {
      name: "unrelated host",
      visible: { serverId: "server-1", workspaceId: "wks_other" },
      owner: "wks_workspace_a",
      serverId: "server-1",
      code: "browser_denied",
    },
    {
      name: "other visible server",
      visible: { serverId: "server-2", workspaceId: "wks_workspace_a" },
      owner: "wks_workspace_a",
      serverId: "server-1",
      code: "browser_denied",
    },
    {
      name: "no visible host",
      visible: null,
      owner: "wks_workspace_a",
      serverId: "server-1",
      code: "browser_denied",
    },
    {
      name: "wrong owner",
      visible: { serverId: "server-1", workspaceId: "wks_other" },
      owner: "wks_other",
      serverId: "server-1",
      code: "browser_tab_not_found",
    },
    {
      name: "wrong owning server",
      visible: { serverId: "server-2", workspaceId: "wks_workspace_a" },
      owner: "wks_workspace_a",
      serverId: "server-2",
      code: "browser_tab_not_found",
    },
  ])(
    "reveal rejects $name without moving or activating a browser",
    async ({ visible, owner, serverId, code }) => {
      const browser = new BrowserAutomationHandlerHarness();
      browser.mount({ serverId: "server-1" });
      browser.receive(browserNewTabRequest());
      await flushAsyncWork();
      const created = browser.client.payloadAt(0);
      if (!created.ok || created.result.command !== "new_tab") throw new Error("Expected browser");
      browser.unmount();
      const previousLayouts = useWorkspaceLayoutStore.getState().layoutByWorkspace;
      browser.mount({ serverId, getVisibleWorkspaceSelection: () => visible });
      browser.receive({
        ...browserNewTabRequest(),
        workspaceId: owner,
        command: { command: "reveal", args: { browserId: created.result.browserId } },
      });
      await flushAsyncWork();
      expect(browser.client.payloadAt(1)).toMatchObject({ ok: false, error: { code } });
      expect(useWorkspaceLayoutStore.getState().layoutByWorkspace).toBe(previousLayouts);
      expect(browser.browser.unregisteredWorkspaceBrowsers).toEqual([]);
      browser.unmount();
    },
  );

  test("browser_new_tab hosts the tab beside a cross-workspace agent without changing ownership", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    const ownerWorkspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: "server-1",
      workspaceId: "wks_workspace_a",
    })!;
    const hostWorkspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: "server-1",
      workspaceId: "wks_workspace_b",
    })!;
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: hostWorkspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    browser.mount({
      serverId: "server-1",
      getVisibleWorkspaceSelection: () => ({
        serverId: "server-1",
        workspaceId: "wks_workspace_b",
      }),
    });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();

    const result = browser.client.payloadAt(0);
    expect(result).toMatchObject({
      ok: true,
      result: {
        command: "new_tab",
        workspaceId: "wks_workspace_a",
        presentationHostWorkspaceId: "wks_workspace_b",
        presented: true,
        activated: false,
      },
    });
    if (!result.ok || result.result.command !== "new_tab") {
      throw new Error("Expected browser_new_tab success payload");
    }
    expect(workspaceBrowserTabs(ownerWorkspaceKey, result.result.browserId)).toEqual([]);
    expect(workspaceBrowserTabs(hostWorkspaceKey, result.result.browserId)).toHaveLength(1);
    expect(
      useBrowserStore.getState().browsersById[result.result.browserId]?.automationWorkspaceId,
    ).toBe("wks_workspace_a");

    browser.receive(browserResizeRequest(result.result.browserId));
    await flushAsyncWork();
    expect(browser.client.payloadAt(1)).toMatchObject({ ok: true, result: { command: "resize" } });

    browser.receive(browserCloseTabRequest(result.result.browserId));
    await flushAsyncWork();
    expect(browser.client.payloadAt(2)).toMatchObject({
      requestId: "req-close-tab",
      ok: true,
      result: { command: "close_tab", browserId: result.result.browserId },
    });
    expect(workspaceBrowserTabs(hostWorkspaceKey, result.result.browserId)).toEqual([]);
  });

  test("browser_new_tab returns a retryable timeout when the resident webview does not register", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.browser.response = emptyListTabsPayload();
    browser.mount({
      serverId: "server-1",
      registrationWaitTimeoutMs: 1,
      registrationPollIntervalMs: 1,
    });

    browser.receive(browserNewTabRequest());
    await waitForRegistrationTimeout();

    expect(browser.client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-new",
          ok: false,
          error: {
            code: "browser_timeout",
            message: expect.stringContaining("Timed out waiting for browser tab"),
            retryable: true,
          },
        },
      },
    ]);
    expect(browser.resident.ensuredWebviews).toEqual([
      expect.objectContaining({
        workspaceId: "wks_workspace_a",
        url: "https://example.com",
      }),
    ]);
  });

  test("browser_new_tab wraps registration bridge errors in a response", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.browser.thrownError = new Error("IPC registration check failed");
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();

    expect(browser.client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-new",
          ok: false,
          error: {
            code: "browser_unknown_error",
            message: "IPC registration check failed",
            retryable: false,
          },
        },
      },
    ]);
  });

  test("browser_resize updates resident webview dimensions", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    const result = newTabResultFrom(browser.client.payloadAt(0));

    browser.receive(browserResizeRequest(result.browserId));
    await flushAsyncWork();

    expect(browser.client.payloadAt(1)).toMatchObject({
      requestId: "req-resize",
      ok: true,
      result: {
        command: "resize",
        browserId: result.browserId,
        width: 1024,
        height: 768,
      },
    });
    expect(useBrowserStore.getState().browsersById[result.browserId]?.viewport).toEqual({
      mode: "fixed",
      width: 1024,
      height: 768,
    });
    expect(browser.browser.executedRequests).toHaveLength(1);
  });

  test("browser_resize returns not found for a tab outside the request workspace", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    const result = newTabResultFrom(browser.client.payloadAt(0));

    browser.receive(browserResizeRequest(result.browserId, { workspaceId: "wks_workspace_b" }));
    await flushAsyncWork();

    expect(browser.client.payloadAt(1)).toEqual({
      requestId: "req-resize",
      ok: false,
      error: {
        code: "browser_tab_not_found",
        message: `No browser tab found for ID: ${result.browserId}`,
        retryable: false,
      },
    });
  });

  test("browser_close_tab removes the workspace tab, browser record, resident webview, and registry entry", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: "server-1",
      workspaceId: "wks_workspace_a",
    });
    if (!workspaceKey) {
      throw new Error("Expected workspace key");
    }
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    const result = newTabResultFrom(browser.client.payloadAt(0));

    browser.receive(browserCloseTabRequest(result.browserId));
    await flushAsyncWork();

    expect(browser.client.payloadAt(1)).toEqual({
      requestId: "req-close-tab",
      ok: true,
      result: {
        command: "close_tab",
        browserId: result.browserId,
        ownerWorkspaceId: "wks_workspace_a",
        presentationHostWorkspaceId: null,
        presented: false,
        activated: false,
      },
    });
    expect(workspaceBrowserTabs(workspaceKey, result.browserId)).toEqual([]);
    expect(useBrowserStore.getState().browsersById[result.browserId]).toBeUndefined();
    expect(browser.browser.unregisteredWorkspaceBrowsers).toEqual([result.browserId]);
    expect(currentBrowserTabs()).toEqual([]);
  });

  test("browser_close_tab returns not found after the tab is gone", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    const result = newTabResultFrom(browser.client.payloadAt(0));

    browser.receive(browserCloseTabRequest(result.browserId));
    await flushAsyncWork();
    browser.receive(browserCloseTabRequest(result.browserId));
    await flushAsyncWork();

    expect(browser.client.payloadAt(2)).toEqual({
      requestId: "req-close-tab",
      ok: false,
      error: {
        code: "browser_tab_not_found",
        message: `No browser tab found for ID: ${result.browserId}`,
        retryable: false,
      },
    });
  });

  test("non-new-tab requests send the desktop bridge response", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.browser.response = {
      requestId: "desktop-req",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    };
    browser.mount();
    const request = browserAutomationRequest();

    browser.receive(request);
    await flushAsyncWork();

    expect(browser.browser.executedRequests).toEqual([request]);
    expect(browser.client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-1",
          ok: true,
          result: { command: "list_tabs", tabs: [] },
        },
      },
    ]);
  });

  test("missing desktop bridge sends browser_unsupported", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.mount({ host: null });

    browser.receive(browserAutomationRequest());
    await flushAsyncWork();

    expect(browser.client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-1",
          ok: false,
          error: {
            code: "browser_unsupported",
            message: "Browser automation is not available in this app runtime.",
            retryable: false,
          },
        },
      },
    ]);
  });

  test("typed bridge errors become failure responses", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.browser.thrownError = {
      code: "browser_tab_not_found",
      message: "Browser tab browser-1 was not found.",
      retryable: false,
    };
    browser.mount();

    browser.receive(browserAutomationRequest());
    await flushAsyncWork();

    expect(browser.client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-1",
          ok: false,
          error: {
            code: "browser_tab_not_found",
            message: "Browser tab browser-1 was not found.",
            retryable: false,
          },
        },
      },
    ]);
  });

  test("unimplemented preload IPC reports browser_unsupported", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.browser.thrownError = new Error(
      'No handler registered for "paseo:browser:execute-automation-command"',
    );
    browser.mount();

    browser.receive(browserAutomationRequest());
    await flushAsyncWork();

    expect(browser.client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-1",
          ok: false,
          error: {
            code: "browser_unsupported",
            message: "Browser automation is not implemented by this app build yet.",
            retryable: false,
          },
        },
      },
    ]);
  });

  test("unsubscribe stops handling browser automation requests", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.mount();

    browser.unmount();
    browser.receive(browserAutomationRequest());
    await flushAsyncWork();

    expect(browser.browser.executedRequests).toEqual([]);
    expect(browser.client.sentResponses).toEqual([]);
  });
});
