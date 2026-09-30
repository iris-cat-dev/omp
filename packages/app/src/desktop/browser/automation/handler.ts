import type { SessionInboundMessage, SessionOutboundMessage } from "@omp-desktop/protocol/messages";
import { getDesktopHost, type DesktopHostBridge } from "@/desktop/host";
import {
  ensureResidentBrowserWebview as ensureResidentBrowserWebviewDefault,
  removeResidentBrowserWebview,
  resizeResidentBrowserWebview,
} from "@/desktop/browser/resident-webviews";
import {
  createFixedBrowserViewport,
  createWorkspaceBrowser,
  getBrowserRecord,
  useBrowserStore,
} from "@/desktop/browser/store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { getBrowserPresentation, revealWorkspaceBrowser } from "@/desktop/browser/presentation";

type BrowserAutomationExecuteRequest = Extract<
  SessionOutboundMessage,
  { type: "browser.automation.execute.request" }
>;
type BrowserAutomationExecuteResponse = Extract<
  SessionInboundMessage,
  { type: "browser.automation.execute.response" }
>;
type BrowserAutomationResponsePayload = BrowserAutomationExecuteResponse["payload"];
type BrowserAutomationFailurePayload = Extract<BrowserAutomationResponsePayload, { ok: false }>;
type BrowserAutomationErrorCode = BrowserAutomationFailurePayload["error"]["code"];

interface BrowserAutomationClient {
  on(
    type: "browser.automation.execute.request",
    handler: (message: BrowserAutomationExecuteRequest) => void,
  ): () => void;
  sendBrowserAutomationExecuteResponse(response: BrowserAutomationExecuteResponse): void;
}

export interface BrowserAutomationHandlerOptions {
  client: BrowserAutomationClient;
  serverId?: string;
  getHost?: () => DesktopHostBridge | null;
  ensureResidentBrowserWebview?: typeof ensureResidentBrowserWebviewDefault;
  getVisibleWorkspaceSelection?: () => ActiveWorkspaceSelection | null;
  registrationWaitTimeoutMs?: number;
  registrationPollIntervalMs?: number;
}

export function mountBrowserAutomationHandler(
  options: BrowserAutomationHandlerOptions,
): () => void {
  const getHost = options.getHost ?? getDesktopHost;
  const unsubscribe = options.client.on("browser.automation.execute.request", (request) => {
    void handleBrowserAutomationRequest({
      client: options.client,
      getHost,
      request,
      serverId: options.serverId,
      ensureResidentBrowserWebview:
        options.ensureResidentBrowserWebview ?? ensureResidentBrowserWebviewDefault,
      getVisibleWorkspaceSelection:
        options.getVisibleWorkspaceSelection ??
        (() =>
          typeof window === "undefined"
            ? null
            : parseHostWorkspaceRouteFromPathname(window.location.pathname)),
      ...(options.registrationWaitTimeoutMs !== undefined
        ? { registrationWaitTimeoutMs: options.registrationWaitTimeoutMs }
        : {}),
      ...(options.registrationPollIntervalMs !== undefined
        ? { registrationPollIntervalMs: options.registrationPollIntervalMs }
        : {}),
    });
  });
  return () => {
    unsubscribe();
  };
}

export function mountBrowserAutomationDaemonClientHandler(
  client: unknown,
  options?: { serverId?: string },
): () => void {
  return mountBrowserAutomationHandler({
    client: client as BrowserAutomationClient,
    ...(options?.serverId ? { serverId: options.serverId } : {}),
  });
}

async function handleBrowserAutomationRequest(params: {
  client: BrowserAutomationHandlerOptions["client"];
  getHost: () => DesktopHostBridge | null;
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
  ensureResidentBrowserWebview: typeof ensureResidentBrowserWebviewDefault;
  getVisibleWorkspaceSelection: () => ActiveWorkspaceSelection | null;
  registrationWaitTimeoutMs?: number;
  registrationPollIntervalMs?: number;
}): Promise<void> {
  const {
    client,
    getHost,
    request,
    serverId,
    ensureResidentBrowserWebview,
    registrationWaitTimeoutMs,
    registrationPollIntervalMs,
    getVisibleWorkspaceSelection,
  } = params;
  const browserHost = getHost()?.browser;
  const sendPayload = (payload: BrowserAutomationResponsePayload) => {
    client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: enrichBrowserPresentation({
        payload,
        request,
        serverId,
        visibleWorkspace: getVisibleWorkspaceSelection(),
      }),
    });
  };

  if (request.command.command === "reveal") {
    sendPayload(
      revealBrowserTabForRequest({
        request,
        serverId,
        visibleWorkspace: getVisibleWorkspaceSelection(),
      }),
    );
    return;
  }
  const executeAutomationCommand = browserHost?.executeAutomationCommand;

  if (request.command.command === "new_tab") {
    try {
      sendPayload(
        await openBrowserTabForRequest({
          request,
          serverId,
          browserHost,
          ensureResidentBrowserWebview,
          getVisibleWorkspaceSelection,
          ...(registrationWaitTimeoutMs !== undefined ? { registrationWaitTimeoutMs } : {}),
          ...(registrationPollIntervalMs !== undefined ? { registrationPollIntervalMs } : {}),
        }),
      );
    } catch (error) {
      client.sendBrowserAutomationExecuteResponse({
        type: "browser.automation.execute.response",
        payload: normalizeThrownBridgeError(request.requestId, error),
      });
    }
    return;
  }

  if (request.command.command === "resize") {
    sendPayload(resizeBrowserTabForRequest({ request, serverId }));
    return;
  }

  if (request.command.command === "close_tab") {
    try {
      sendPayload(
        await closeBrowserTabForRequest({
          request,
          serverId,
          browserHost,
        }),
      );
    } catch (error) {
      client.sendBrowserAutomationExecuteResponse({
        type: "browser.automation.execute.response",
        payload: normalizeThrownBridgeError(request.requestId, error),
      });
    }
    return;
  }

  if (!executeAutomationCommand) {
    client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: browserAutomationFailure({
        requestId: request.requestId,
        code: "browser_unsupported",
        message: "Browser automation is not available in this app runtime.",
      }),
    });
    return;
  }

  try {
    const payload = await executeAutomationCommand(request);
    sendPayload(normalizeBridgePayload(request.requestId, payload));
  } catch (error) {
    client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: normalizeThrownBridgeError(request.requestId, error),
    });
  }
}

function enrichBrowserPresentation(input: {
  payload: BrowserAutomationResponsePayload;
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
  visibleWorkspace: ActiveWorkspaceSelection | null;
}): BrowserAutomationResponsePayload {
  const { payload, request, serverId, visibleWorkspace } = input;
  if (!payload.ok || !serverId || !request.workspaceId || payload.result.command === "reveal")
    return payload;
  const ownerWorkspaceId = request.workspaceId;
  if (payload.result.command === "list_tabs") {
    return {
      ...payload,
      result: {
        ...payload.result,
        tabs: payload.result.tabs.map((tab) => {
          const state = getBrowserPresentation({
            serverId,
            ownerWorkspaceId,
            browserId: tab.browserId,
            visibleWorkspace,
          });
          return { ...tab, ...state, isActive: state.activated };
        }),
      },
    };
  }
  if ("browserId" in payload.result) {
    return {
      ...payload,
      result: {
        ...payload.result,
        ...getBrowserPresentation({
          serverId,
          ownerWorkspaceId,
          browserId: payload.result.browserId,
          visibleWorkspace,
        }),
      },
    };
  }
  return payload;
}

function revealBrowserTabForRequest(input: {
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
  visibleWorkspace: ActiveWorkspaceSelection | null;
}): BrowserAutomationResponsePayload {
  const { request, serverId, visibleWorkspace } = input;
  if (request.command.command !== "reveal") throw new Error("Expected reveal command");
  const browserId = request.command.args.browserId;
  const browser = getBrowserRecord(browserId);
  const workspaceId = request.workspaceId;
  if (!serverId || !workspaceId) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_unsupported",
      message: "Cannot reveal a browser tab without a workspace context.",
    });
  }
  if (!browser || !isBrowserOwnedByWorkspace({ serverId, workspaceId, browserId, browser })) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_tab_not_found",
      message: `No browser tab found for ID: ${browserId}`,
    });
  }
  const host = resolveBrowserTabHostWorkspace({
    serverId,
    ownerWorkspaceId: workspaceId,
    agentId: request.agentId,
    visibleWorkspace,
  });
  if (!host.presented) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_denied",
      message:
        "Open the owning workspace or a tab host containing this agent before revealing its browser.",
    });
  }
  if (!revealWorkspaceBrowser({ serverId, workspaceId: host.workspaceId, browserId })) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_unknown_error",
      message: "Could not reveal the browser tab in the current workspace.",
    });
  }
  return {
    requestId: request.requestId,
    ok: true,
    result: {
      command: "reveal",
      browserId,
      ...getBrowserPresentation({
        serverId,
        ownerWorkspaceId: workspaceId,
        browserId,
        visibleWorkspace,
      }),
    },
  };
}

function resizeBrowserTabForRequest(params: {
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
}): BrowserAutomationResponsePayload {
  const { request, serverId } = params;
  const command = request.command as Extract<
    BrowserAutomationExecuteRequest["command"],
    { command: "resize" }
  >;
  const browserId = command.args.browserId;
  const browser = getBrowserRecord(browserId);
  if (!browser) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_tab_not_found",
      message: `No browser tab found for ID: ${browserId}`,
    });
  }

  const workspaceId = request.workspaceId;
  if (
    serverId &&
    workspaceId &&
    !isBrowserOwnedByWorkspace({ serverId, workspaceId, browserId, browser })
  ) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_tab_not_found",
      message: `No browser tab found for ID: ${browserId}`,
    });
  }

  const dimensions = resizeResidentBrowserWebview({
    browserId,
    width: command.args.width,
    height: command.args.height,
  });
  if (!dimensions) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_tab_not_found",
      message: `No browser tab found for ID: ${browserId}`,
    });
  }
  useBrowserStore
    .getState()
    .setBrowserViewport(browserId, createFixedBrowserViewport(dimensions.width, dimensions.height));

  return {
    requestId: request.requestId,
    ok: true,
    result: {
      command: "resize",
      browserId,
      width: dimensions.width,
      height: dimensions.height,
    },
  };
}

async function closeBrowserTabForRequest(params: {
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
  browserHost: DesktopHostBridge["browser"] | undefined;
}): Promise<BrowserAutomationResponsePayload> {
  const { request, serverId, browserHost } = params;
  const command = request.command as Extract<
    BrowserAutomationExecuteRequest["command"],
    { command: "close_tab" }
  >;
  const browserId = command.args.browserId;
  const workspaceId = request.workspaceId;
  const browser = getBrowserRecord(browserId);
  const workspaceTab =
    serverId && workspaceId && browser
      ? findBrowserTabForOwner({ serverId, workspaceId, browserId, browser })
      : null;
  if (!workspaceTab && (!serverId || !workspaceId)) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_unsupported",
      message: "Cannot close a browser tab without a workspace context.",
    });
  }
  if (!workspaceTab || !browser) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_tab_not_found",
      message: `No browser tab found for ID: ${browserId}`,
    });
  }

  useWorkspaceLayoutStore.getState().closeTab(workspaceTab.workspaceKey, workspaceTab.tabId);
  useBrowserStore.getState().removeBrowser(browserId);
  removeResidentBrowserWebview(browserId);
  await browserHost?.unregisterWorkspaceBrowser?.(browserId);

  return {
    requestId: request.requestId,
    ok: true,
    result: { command: "close_tab", browserId },
  };
}

function findWorkspaceBrowserTab(input: {
  serverId: string;
  workspaceId: string | undefined;
  browserId: string;
}): { workspaceKey: string; tabId: string } | null {
  if (!input.workspaceId) {
    return null;
  }
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  if (!workspaceKey) {
    return null;
  }
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  const tab = layout
    ? collectAllTabs(layout.root).find((candidate) => {
        return (
          candidate.target.kind === "browser" && candidate.target.browserId === input.browserId
        );
      })
    : null;
  return tab ? { workspaceKey, tabId: tab.tabId } : null;
}

function findBrowserTabAcrossLayouts(
  browserId: string,
  serverId: string,
): { workspaceKey: string; tabId: string } | null {
  for (const [workspaceKey, layout] of Object.entries(
    useWorkspaceLayoutStore.getState().layoutByWorkspace,
  )) {
    if (!workspaceKey.startsWith(`${serverId}:`)) {
      continue;
    }
    const tab = collectAllTabs(layout.root).find(
      (candidate) =>
        candidate.target.kind === "browser" && candidate.target.browserId === browserId,
    );
    if (tab) return { workspaceKey, tabId: tab.tabId };
  }
  return null;
}

function isBrowserOwnedByWorkspace(input: {
  serverId: string;
  workspaceId: string;
  browserId: string;
  browser: NonNullable<ReturnType<typeof getBrowserRecord>>;
}): boolean {
  return input.browser.automationWorkspaceId
    ? input.browser.automationWorkspaceId === input.workspaceId &&
        (!input.browser.automationServerId || input.browser.automationServerId === input.serverId)
    : Boolean(findWorkspaceBrowserTab(input));
}

function findBrowserTabForOwner(input: {
  serverId: string;
  workspaceId: string;
  browserId: string;
  browser: NonNullable<ReturnType<typeof getBrowserRecord>>;
}): { workspaceKey: string; tabId: string } | null {
  return isBrowserOwnedByWorkspace(input)
    ? findBrowserTabAcrossLayouts(input.browserId, input.serverId)
    : null;
}

function resolveBrowserTabHostWorkspace(input: {
  serverId: string;
  ownerWorkspaceId: string;
  agentId?: string;
  visibleWorkspace: ActiveWorkspaceSelection | null;
}): { workspaceId: string; presented: boolean } {
  const visible = input.visibleWorkspace;
  if (!visible || visible.serverId !== input.serverId) {
    return { workspaceId: input.ownerWorkspaceId, presented: false };
  }
  if (visible.workspaceId === input.ownerWorkspaceId) {
    return { workspaceId: input.ownerWorkspaceId, presented: true };
  }
  if (!input.agentId) {
    return { workspaceId: input.ownerWorkspaceId, presented: false };
  }
  const visibleWorkspaceKey = buildWorkspaceTabPersistenceKey(visible);
  const visibleLayout = visibleWorkspaceKey
    ? useWorkspaceLayoutStore.getState().layoutByWorkspace[visibleWorkspaceKey]
    : null;
  const hostsAgent = visibleLayout
    ? collectAllTabs(visibleLayout.root).some(
        (tab) => tab.target.kind === "agent" && tab.target.agentId === input.agentId,
      )
    : false;
  return hostsAgent
    ? { workspaceId: visible.workspaceId, presented: true }
    : { workspaceId: input.ownerWorkspaceId, presented: false };
}

async function openBrowserTabForRequest(params: {
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
  browserHost: DesktopHostBridge["browser"] | undefined;
  ensureResidentBrowserWebview: typeof ensureResidentBrowserWebviewDefault;
  getVisibleWorkspaceSelection: () => ActiveWorkspaceSelection | null;
  registrationWaitTimeoutMs?: number;
  registrationPollIntervalMs?: number;
}): Promise<BrowserAutomationResponsePayload> {
  const {
    request,
    serverId,
    browserHost,
    ensureResidentBrowserWebview,
    getVisibleWorkspaceSelection,
    registrationWaitTimeoutMs,
    registrationPollIntervalMs,
  } = params;
  const command = request.command as Extract<
    BrowserAutomationExecuteRequest["command"],
    { command: "new_tab" }
  >;
  const workspaceId = request.workspaceId;
  if (!serverId || !workspaceId) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_unsupported",
      message: "Cannot create a browser tab without a workspace context.",
    });
  }

  const url = command.args.url ?? "https://example.com";
  const tabHost = resolveBrowserTabHostWorkspace({
    serverId,
    ownerWorkspaceId: workspaceId,
    agentId: request.agentId,
    visibleWorkspace: getVisibleWorkspaceSelection(),
  });
  const { browserId, url: normalizedUrl } = createWorkspaceBrowser({
    initialUrl: url,
    automationServerId: serverId,
    automationWorkspaceId: workspaceId,
  });
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId,
    workspaceId: tabHost.workspaceId,
  });
  if (!workspaceKey) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_unsupported",
      message: "Cannot create a browser tab without a workspace context.",
    });
  }
  useWorkspaceLayoutStore.getState().openTab({
    workspaceKey,
    target: { kind: "browser", browserId },
    intent: "background",
  });

  if (browserHost?.executeAutomationCommand) {
    ensureResidentBrowserWebview({ browserId, workspaceId, url: normalizedUrl });
    const registered = await waitForBrowserRegistration({
      request,
      browserId,
      workspaceId,
      executeAutomationCommand: browserHost.executeAutomationCommand,
      ...(registrationWaitTimeoutMs !== undefined ? { timeoutMs: registrationWaitTimeoutMs } : {}),
      ...(registrationPollIntervalMs !== undefined
        ? { pollIntervalMs: registrationPollIntervalMs }
        : {}),
    });
    if (!registered) {
      return browserAutomationFailure({
        requestId: request.requestId,
        code: "browser_timeout",
        message: `Timed out waiting for browser tab ${browserId} to register with the browser automation host. Try browser_new_tab again.`,
        retryable: true,
      });
    }
  }

  return {
    requestId: request.requestId,
    ok: true,
    result: {
      command: "new_tab",
      browserId,
      workspaceId,
      url: normalizedUrl,
    },
  };
}

async function waitForBrowserRegistration(params: {
  request: BrowserAutomationExecuteRequest;
  browserId: string;
  workspaceId: string;
  executeAutomationCommand: (
    request: BrowserAutomationExecuteRequest,
  ) => Promise<BrowserAutomationResponsePayload>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<boolean> {
  const deadline = Date.now() + (params.timeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    const payload = await params.executeAutomationCommand({
      type: "browser.automation.execute.request",
      requestId: `${params.request.requestId}:list_tabs`,
      agentId: params.request.agentId,
      cwd: params.request.cwd,
      workspaceId: params.workspaceId,
      command: { command: "list_tabs", args: {} },
    });
    if (payload.ok && payload.result.command === "list_tabs") {
      if (payload.result.tabs.some((tab) => tab.browserId === params.browserId)) {
        return true;
      }
    }
    await delay(params.pollIntervalMs ?? 100);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBridgePayload(
  requestId: string,
  payload: BrowserAutomationResponsePayload,
): BrowserAutomationResponsePayload {
  return { ...payload, requestId } as BrowserAutomationResponsePayload;
}

function normalizeThrownBridgeError(
  requestId: string,
  error: unknown,
): BrowserAutomationFailurePayload {
  const typed = readTypedBrowserAutomationError(error);
  if (typed) {
    return browserAutomationFailure({ requestId, ...typed });
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("No handler registered")) {
    return browserAutomationFailure({
      requestId,
      code: "browser_unsupported",
      message: "Browser automation is not implemented by this app build yet.",
    });
  }

  return browserAutomationFailure({
    requestId,
    code: "browser_unknown_error",
    message: message || "Browser automation failed.",
  });
}

function readTypedBrowserAutomationError(
  value: unknown,
): { code: BrowserAutomationErrorCode; message: string; retryable?: boolean } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || !record.code.startsWith("browser_")) {
    return null;
  }
  if (typeof record.message !== "string" || record.message.length === 0) {
    return null;
  }
  return {
    code: record.code as BrowserAutomationErrorCode,
    message: record.message,
    ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
  };
}

function browserAutomationFailure(params: {
  requestId: string;
  code: BrowserAutomationErrorCode;
  message: string;
  retryable?: boolean;
}): BrowserAutomationFailurePayload {
  return {
    requestId: params.requestId,
    ok: false,
    error: {
      code: params.code,
      message: params.message,
      retryable: params.retryable ?? false,
    },
  };
}
