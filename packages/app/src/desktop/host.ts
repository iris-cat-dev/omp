import { Platform } from "react-native";
import { getElectronHost } from "@/desktop/electron/host";
import type { BrowserKeyboardPolicy } from "@/desktop/browser/shortcuts";
import type { SessionInboundMessage, SessionOutboundMessage } from "@omp-desktop/protocol/messages";

type BrowserAutomationExecuteRequest = Extract<
  SessionOutboundMessage,
  { type: "browser.automation.execute.request" }
>;
type BrowserAutomationExecuteResponse = Extract<
  SessionInboundMessage,
  { type: "browser.automation.execute.response" }
>;

export type DesktopNotificationPermission = "granted" | "denied" | "default";

export interface DesktopDialogAskOptions {
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
  kind?: "info" | "warning" | "error";
}

export interface DesktopDialogOpenOptions {
  title?: string;
  defaultPath?: string;
  directory?: boolean;
  createDirectory?: boolean;
  multiple?: boolean;
  filters?: Array<{
    name: string;
    extensions: string[];
  }>;
}

export interface DesktopDialogAskWithCheckboxOptions extends DesktopDialogAskOptions {
  checkboxLabel: string;
  checkboxChecked?: boolean;
}

export interface DesktopDialogAskWithCheckboxResult {
  confirmed: boolean;
  dontAskAgain: boolean;
}

export interface DesktopDialogBridge {
  ask?: (message: string, options?: DesktopDialogAskOptions) => Promise<boolean>;
  askWithCheckbox?: (
    message: string,
    options: DesktopDialogAskWithCheckboxOptions,
  ) => Promise<DesktopDialogAskWithCheckboxResult>;
  open?: (options?: DesktopDialogOpenOptions) => Promise<string | string[] | null>;
}

export interface DesktopNotificationBridge {
  isSupported?: () => Promise<boolean>;
  sendNotification?: (
    payload: string | { title: string; body?: string; data?: Record<string, unknown> },
  ) => Promise<boolean>;
}

export interface DesktopOpenerBridge {
  openUrl?: (url: string) => Promise<void>;
  openPath?: (input: { path: string; workspaceRoot: string }) => Promise<void>;
  revealPath?: (input: { path: string; workspaceRoot: string }) => Promise<void>;
}

export interface DesktopEditorTargetDescriptor {
  id: string;
  label: string;
  kind: "editor" | "file-manager";
  icon: { kind: "image"; dataUrl: string } | { kind: "symbol"; name: "folder" | "terminal" };
}

export interface DesktopEditorOpenTargetInput {
  editorId: string;
  workspacePath: string;
  filePath?: string;
  line?: number;
  column?: number;
}

export interface DesktopEditorBridge {
  listTargets?: () => Promise<DesktopEditorTargetDescriptor[]>;
  openTarget?: (input: DesktopEditorOpenTargetInput) => Promise<void>;
}

export interface DesktopWebUtilsBridge {
  getPathForFile?: (file: File) => string;
}

export type DesktopTerminalContextMenuAction = "clear";
export type DesktopLinkContextMenuAction = "open-in-desktop";
export type DesktopFileLinkContextMenuAction = "reveal-in-file-manager";
export type DesktopContextMenuAction =
  | DesktopTerminalContextMenuAction
  | DesktopLinkContextMenuAction
  | DesktopFileLinkContextMenuAction;

export type DesktopContextMenuInput =
  | {
      kind: "terminal";
      hasSelection?: boolean;
      clearLabel?: string;
    }
  | {
      kind: "assistant-http-link";
      url: string;
      openInDesktopLabel: string;
      openExternalLabel: string;
      copyAddressLabel: string;
    }
  | {
      kind: "assistant-file-link";
      revealLabel: string;
    };

export interface DesktopContextMenuLabels {
  addToDictionary: string;
  clear: string;
  copy: string;
  copyAddress: string;
  copyImage: string;
  cut: string;
  inspectElement: string;
  noSuggestions: string;
  openExternal: string;
  openInDesktop: string;
  paste: string;
  quitApp: string;
  saveImageAs: string;
  selectAll: string;
  showApp: string;
}

export interface DesktopMenuBridge {
  showContextMenu?: (input: DesktopContextMenuInput) => Promise<DesktopContextMenuAction | null>;
  setContextMenuLabels?: (labels: DesktopContextMenuLabels) => Promise<void>;
  setCapturingShortcut?: (capturing: boolean) => Promise<void>;
}

export interface DesktopWindowControlsOverlayUpdate {
  height?: number;
  backgroundColor?: string;
  foregroundColor?: string;
  trafficLightOffsetY?: number;
}

export type DesktopCloseChoice = "background" | "quit" | "cancel";

export interface DesktopCloseChoiceRequest {
  requestId: number;
}

export interface DesktopCloseChoiceResponse extends DesktopCloseChoiceRequest {
  choice: DesktopCloseChoice;
  remember: boolean;
}

export interface DesktopCloseChoiceBridge {
  ready?: () => Promise<DesktopCloseChoiceRequest | null>;
  respond?: (response: DesktopCloseChoiceResponse) => Promise<boolean>;
}

export interface DesktopWindowBridge {
  label?: string;
  toggleMaximize?: () => Promise<void>;
  setFullscreen?: (fullscreen: boolean) => Promise<void>;
  isFullscreen?: () => Promise<boolean>;
  isMaximized?: () => Promise<boolean>;
  beginWindowDrag?: (point: { screenX: number; screenY: number }) => Promise<void>;
  moveWindowDrag?: (point: { screenX: number; screenY: number }) => void;
  endWindowDrag?: () => void;
  updateWindowControls?: (update: DesktopWindowControlsOverlayUpdate) => Promise<void>;
  onResized?: <TEvent = unknown>(
    handler: (event: TEvent) => void,
  ) => Promise<() => void> | (() => void);
  setBadgeCount?: (count?: number) => Promise<void>;
}

export interface DesktopWindowModuleBridge {
  openNew?: (options?: { pendingOpenProjectPath?: string | null }) => Promise<void>;
  closeChoice?: DesktopCloseChoiceBridge;
  getCurrentWindow?: () => DesktopWindowBridge;
}

export interface DesktopEventsBridge {
  on?: (event: string, handler: (payload: unknown) => void) => Promise<() => void> | (() => void);
}

export interface DesktopAgentNavigationBridge {
  ready?: () => Promise<{ serverId: string; agentId: string } | null>;
}

export interface DesktopRemoteSshTarget {
  host: string;
  username?: string;
  port?: number;
  identityFile?: string;
}

export interface DesktopRemoteSshStartInput {
  operationId: string;
  target: DesktopRemoteSshTarget;
  relayAddress?: string;
  expectedServerId?: string;
}

export interface DesktopRemoteSshDeployResult {
  operationId: string;
  offerUrl: string;
  hostname: string;
  platform: "linux" | "darwin";
  arch: "x64" | "arm64";
  runtimeRoot: string;
  deployedVersion: string;
  target: DesktopRemoteSshTarget;
}

export interface DesktopRemoteSshProfile {
  serverId: string;
  target: DesktopRemoteSshTarget;
  runtimeRoot: string;
  deployedVersion: string;
}

export type DesktopRemoteSshEvent =
  | {
      operationId: string;
      type: "phase";
      phase:
        | "connecting"
        | "inspecting"
        | "preparing-runtime"
        | "uploading"
        | "installing"
        | "starting"
        | "pairing"
        | "complete";
      message: string;
      progress?: number;
    }
  | { operationId: string; type: "terminal"; data: string }
  | { operationId: string; type: "interactive"; enabled: boolean }
  | { operationId: string; type: "failed"; message: string };

export interface DesktopRemoteSshBridge {
  start?: (input: DesktopRemoteSshStartInput) => Promise<DesktopRemoteSshDeployResult>;
  writeInput?: (input: { operationId: string; input: string }) => Promise<void>;
  cancel?: (input: { operationId: string }) => Promise<void>;
  getProfile?: (serverId: string) => Promise<DesktopRemoteSshProfile | null>;
  saveProfile?: (profile: DesktopRemoteSshProfile) => Promise<void>;
  removeProfile?: (serverId: string) => Promise<void>;
}

export type DesktopBrowserShortcutEvent =
  | { browserId?: string; action: "focus-url" }
  | { browserId: string; action: "new-tab" };

export interface DesktopBrowserNewTabRequestEvent {
  sourceBrowserId: string;
  url: string;
}

export interface DesktopAttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

export interface DesktopBrowserBridge {
  setShortcutPolicy?: (input: BrowserKeyboardPolicy) => Promise<void>;
  readonly profilePartition?: string;
  registerAttachedBrowser?: (input: DesktopAttachedBrowserRegistration) => Promise<void>;
  unregisterWorkspaceBrowser?: (browserId: string) => Promise<void>;
  setWorkspaceActiveBrowser?: (input: {
    workspaceId: string;
    browserId: string | null;
  }) => Promise<void>;
  focus?: (browserId: string) => Promise<boolean>;
  openDevTools?: (browserId: string) => Promise<unknown>;
  clearProfile?: (legacyBrowserIds: string[]) => Promise<void>;
  executeAutomationCommand?: (
    request: BrowserAutomationExecuteRequest,
  ) => Promise<BrowserAutomationExecuteResponse["payload"]>;
  /** Capture a PNG screenshot of the guest viewport cropped to `rect`. */
  captureElement?: (
    browserId: string,
    rect: { x: number; y: number; width: number; height: number },
  ) => Promise<string | null>;
  /** Copy element text and/or an image to the system clipboard from main. */
  copyElement?: (payload: { text?: string; imageDataUrl?: string }) => Promise<boolean>;
}

export interface DesktopInvokeBridge {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export interface DesktopHostBridge {
  platform?: string;
  loginShell?: string;
  invoke?: DesktopInvokeBridge["invoke"];
  getPendingOpenProject?: () => Promise<string | null>;
  agentNavigation?: DesktopAgentNavigationBridge;
  events?: DesktopEventsBridge;
  remoteSsh?: DesktopRemoteSshBridge;
  window?: DesktopWindowModuleBridge;
  dialog?: DesktopDialogBridge;
  notification?: DesktopNotificationBridge;
  opener?: DesktopOpenerBridge;
  editor?: DesktopEditorBridge;
  webUtils?: DesktopWebUtilsBridge;
  menu?: DesktopMenuBridge;
  browser?: DesktopBrowserBridge;
}

declare global {
  interface Window {
    paseoDesktop?: DesktopHostBridge;
  }
}

export function getDesktopHost(): DesktopHostBridge | null {
  if (Platform.OS !== "web") {
    return null;
  }
  return getElectronHost();
}

export function isElectronRuntime(): boolean {
  return getDesktopHost() !== null;
}

export function isElectronRuntimeMac(): boolean {
  if (!isElectronRuntime()) {
    return false;
  }
  if (typeof navigator === "undefined") {
    return false;
  }
  const hostPlatform = getDesktopHost()?.platform?.toLowerCase();
  if (hostPlatform === "darwin" || hostPlatform === "mac" || hostPlatform === "macos") {
    return true;
  }
  const ua = navigator.userAgent;
  return ua.includes("Mac OS") || ua.includes("Macintosh");
}
