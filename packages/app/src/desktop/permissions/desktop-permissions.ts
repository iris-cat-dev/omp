import { type DesktopHostBridge, getDesktopHost } from "@/desktop/host";
import { isNative, isWeb } from "@/constants/platform";
import { i18n } from "@/i18n/i18next";

export type DesktopPermissionKind = "notifications";

export type DesktopPermissionState =
  | "granted"
  | "denied"
  | "prompt"
  | "not-granted"
  | "unavailable"
  | "unknown";

export interface DesktopPermissionStatus {
  state: DesktopPermissionState;
  detail: string;
}

export interface DesktopPermissionSnapshot {
  checkedAt: number;
  notifications: DesktopPermissionStatus;
}

export interface NotificationConstructorLike {
  permission?: string;
  requestPermission?: () => Promise<string>;
}


export interface DesktopPermissionEnvironment {
  isWeb: boolean;
  getDesktopHost: () => DesktopHostBridge | null;
  getNotification: () => NotificationConstructorLike | null;
}

export interface DesktopPermissions {
  shouldShowDesktopPermissionSection: () => boolean;
  getDesktopPermissionSnapshot: () => Promise<DesktopPermissionSnapshot>;
  requestDesktopPermission: (input: {
    kind: DesktopPermissionKind;
  }) => Promise<DesktopPermissionStatus>;
}

function status(input: DesktopPermissionStatus): DesktopPermissionStatus {
  return input;
}


function getErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}


function mapNotificationPermissionString(permission: string): DesktopPermissionStatus {
  if (permission === "granted") {
    return status({
      state: "granted",
      detail: i18n.t("desktop.permissions.notifications.allowed"),
    });
  }
  if (permission === "denied") {
    return status({
      state: "denied",
      detail: i18n.t("desktop.permissions.notifications.denied"),
    });
  }
  if (permission === "default") {
    return status({
      state: "prompt",
      detail: i18n.t("desktop.permissions.notifications.notGranted"),
    });
  }
  return status({
    state: "unknown",
    detail: i18n.t("desktop.permissions.notifications.unexpectedState", {
      state: permission,
    }),
  });
}

export function createDesktopPermissions(env: DesktopPermissionEnvironment): DesktopPermissions {
  function shouldShowDesktopPermissionSection(): boolean {
    return env.isWeb && env.getDesktopHost() !== null;
  }

  async function getNotificationPermissionStatus(): Promise<DesktopPermissionStatus> {
    if (!env.isWeb) {
      return status({
        state: "unavailable",
        detail: i18n.t("desktop.permissions.notifications.webOnly"),
      });
    }

    const desktopHost = env.getDesktopHost();
    if (desktopHost && typeof desktopHost.notification?.isSupported === "function") {
      try {
        const supported = await desktopHost.notification.isSupported();
        return status({
          state: supported ? "granted" : "unavailable",
          detail: supported
            ? i18n.t("desktop.permissions.notifications.supported")
            : i18n.t("desktop.permissions.notifications.unsupported"),
        });
      } catch {
        // Fall through to web API check
      }
    }

    const NotificationConstructor = env.getNotification();
    if (NotificationConstructor && typeof NotificationConstructor.permission === "string") {
      return mapNotificationPermissionString(NotificationConstructor.permission);
    }

    return status({
      state: "unavailable",
      detail: i18n.t("desktop.permissions.notifications.apiUnavailable"),
    });
  }


  async function requestNotificationPermissionStatus(): Promise<DesktopPermissionStatus> {
    if (!env.isWeb) {
      return status({
        state: "unavailable",
        detail: i18n.t("desktop.permissions.notifications.requestsWebOnly"),
      });
    }

    const NotificationConstructor = env.getNotification();
    if (
      NotificationConstructor &&
      typeof NotificationConstructor.requestPermission === "function"
    ) {
      try {
        const permission = await NotificationConstructor.requestPermission();
        return mapNotificationPermissionString(permission);
      } catch (error) {
        return status({
          state: "unknown",
          detail: i18n.t("desktop.permissions.notifications.requestFailed", {
            message: getErrorMessage(error),
          }),
        });
      }
    }

    return status({
      state: "unavailable",
      detail: i18n.t("desktop.permissions.notifications.requestUnavailable"),
    });
  }


  async function requestDesktopPermission(_input: {
    kind: DesktopPermissionKind;
  }): Promise<DesktopPermissionStatus> {
    return await requestNotificationPermissionStatus();
  }

  async function getDesktopPermissionSnapshot(): Promise<DesktopPermissionSnapshot> {
    return {
      checkedAt: Date.now(),
      notifications: await getNotificationPermissionStatus(),
    };
  }

  return {
    shouldShowDesktopPermissionSection,
    getDesktopPermissionSnapshot,
    requestDesktopPermission,
  };
}

function getRealNotification(): NotificationConstructorLike | null {
  if (isNative) {
    return null;
  }
  const NotificationConstructor = (globalThis as { Notification?: unknown }).Notification;
  if (
    NotificationConstructor == null ||
    (typeof NotificationConstructor !== "function" && typeof NotificationConstructor !== "object")
  ) {
    return null;
  }
  return NotificationConstructor as NotificationConstructorLike;
}


const realDesktopPermissions = createDesktopPermissions({
  isWeb,
  getDesktopHost,
  getNotification: getRealNotification,
});

export const shouldShowDesktopPermissionSection =
  realDesktopPermissions.shouldShowDesktopPermissionSection;
export const getDesktopPermissionSnapshot = realDesktopPermissions.getDesktopPermissionSnapshot;
export const requestDesktopPermission = realDesktopPermissions.requestDesktopPermission;
