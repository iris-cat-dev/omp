// @vitest-environment jsdom
import React, { type PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettings, DesktopSettingsPatch } from "./desktop-settings";

const service = vi.hoisted(() => ({
  desktop: true,
  current: {} as DesktopSettings,
  listener: null as ((payload: unknown) => void) | null,
  resolvePatch: null as ((settings: DesktopSettings) => void) | null,
  rejectPatch: null as ((error: Error) => void) | null,
  invoke: vi.fn(),
  report: vi.fn(),
  unsubscribe: vi.fn(),
  on: vi.fn(),
}));
vi.mock("@/constants/platform", () => ({ getIsElectron: () => service.desktop }));
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => (service.desktop ? { events: { on: service.on } } : null),
}));
vi.mock("@/desktop/electron/invoke", () => ({ invokeDesktopCommand: service.invoke }));
vi.mock("@/desktop/hooks/desktop-ipc-error", () => ({
  useDesktopIpcErrorReporter: () => service.report,
  useDesktopIpcQueryErrorToast: () => {},
}));
import {
  DEFAULT_DESKTOP_SETTINGS,
  loadDesktopSettings,
  updatePersistedDesktopSettings,
  useDesktopSettings,
} from "./desktop-settings";

let queryClient: QueryClient;
function Wrapper({ children }: PropsWithChildren) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.resetAllMocks();
  service.desktop = true;
  service.current = { ...DEFAULT_DESKTOP_SETTINGS };
  service.listener = null;
  service.resolvePatch = null;
  service.rejectPatch = null;
  service.on.mockImplementation((_event: string, callback: (payload: unknown) => void) => {
    service.listener = callback;
    return service.unsubscribe;
  });
  service.invoke.mockImplementation((command: string, patch?: DesktopSettingsPatch) => {
    if (command === "get_desktop_settings") return Promise.resolve(service.current);
    if (command === "patch_desktop_settings") {
      const { promise, resolve, reject } = Promise.withResolvers<DesktopSettings>();
      service.current = { ...service.current, notifications: { ...service.current.notifications, ...patch?.notifications } };
      service.resolvePatch = resolve;
      service.rejectPatch = reject;
      return promise;
    }
    throw new Error(`Unexpected command ${command}`);
  });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("desktop browser settings normalization", () => {
  it("keeps legacy browser targets and supplies unconfigured custom defaults", async () => {
    service.invoke.mockResolvedValueOnce({ browser: { target: "firefox" } });
    expect((await loadDesktopSettings()).browser).toEqual({
      target: "firefox",
      custom: { executable: "", args: ["{url}"] },
    });
  });

  it("preserves literal custom executable and argv text when reading and patching", async () => {
    const custom = {
      executable: "/Applications/Browser With Spaces/browser",
      args: ["", 'literal "quotes"', "C:\\literal\\path", "first\nsecond", "{url}", "  "],
    };
    const persisted = { ...DEFAULT_DESKTOP_SETTINGS, browser: { target: "custom", custom } };
    service.invoke.mockResolvedValueOnce(persisted);
    expect((await loadDesktopSettings()).browser).toEqual(persisted.browser);
    service.invoke.mockResolvedValueOnce(persisted);
    expect((await updatePersistedDesktopSettings({ browser: { custom } })).browser).toEqual(
      persisted.browser,
    );
    expect(service.invoke).toHaveBeenLastCalledWith("patch_desktop_settings", {
      browser: { custom },
    });
  });

  it("sends a target-only patch without replacing the saved custom configuration", async () => {
    const custom = { executable: "/opt/browser", args: ["--private", "{url}", ""] };
    const persisted = {
      ...DEFAULT_DESKTOP_SETTINGS,
      browser: { target: "system", custom },
    };
    service.invoke.mockResolvedValueOnce(persisted);
    expect(
      (await updatePersistedDesktopSettings({ browser: { target: "system" } })).browser,
    ).toEqual(persisted.browser);
    expect(service.invoke).toHaveBeenLastCalledWith("patch_desktop_settings", {
      browser: { target: "system" },
    });
  });
});

describe("native desktop settings", () => {
  it("patches notification sound without dropping other persisted settings", async () => {
    const { result } = renderHook(useDesktopSettings, { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    let saving: Promise<void> | undefined;
    act(() => { saving = result.current.updateSettings({ notifications: { playSound: false } }); });
    await waitFor(() => expect(service.resolvePatch).not.toBeNull());
    await act(async () => { service.resolvePatch?.(service.current); await saving; });
    expect(result.current.settings.notifications.playSound).toBe(false);
    expect(result.current.settings.daemon).toEqual(DEFAULT_DESKTOP_SETTINGS.daemon);
  });

  it("receives native general settings changes independently of plugin execution", async () => {
    const { result, unmount } = renderHook(useDesktopSettings, { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const native = {
      ...service.current,
      notifications: { playSound: false },
    };
    act(() => {
      service.listener?.({ payload: native });
    });
    await waitFor(() => expect(result.current.settings.notifications.playSound).toBe(false));
    unmount();
    expect(service.unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure"] as const)(
    "keeps newer native settings over a late patch %s",
    async (outcome) => {
      const { result } = renderHook(useDesktopSettings, { wrapper: Wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      let saving: Promise<void> | undefined;
      act(() => {
        saving = result.current.updateSettings({ notifications: { playSound: false } });
      });
      await waitFor(() => expect(service.resolvePatch).not.toBeNull());
      const olderPatch = service.current;
      const native = {
        ...olderPatch,
        notifications: { playSound: true },
      };
      act(() => {
        service.listener?.({ payload: native });
      });
      await act(async () => {
        if (outcome === "success") service.resolvePatch?.(olderPatch);
        else service.rejectPatch?.(new Error("Unable to persist"));
        try {
          await saving;
        } catch {
          // The failure path is reported by the settings hook and asserted below.
        }
      });
      await waitFor(() => expect(result.current.settings.notifications).toEqual(native.notifications));
      if (outcome === "failure") expect(service.report).toHaveBeenCalledOnce();
    },
  );
});
