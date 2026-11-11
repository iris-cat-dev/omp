import { beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeLocalPlugins } from "./local-plugins";

const host = vi.hoisted(() => ({ on: vi.fn(), receive: null as ((value: unknown) => void) | null }));
vi.mock("@/desktop/host", () => ({ getDesktopHost: () => ({ events: { on: host.on } }) }));
beforeEach(() => { host.on.mockReset(); host.receive = null; });
const snapshot = { revision: 1, backgroundProvider: null, installations: [] };

describe("local plugin catalog subscriptions", () => {
  it.each(["sync", "async"] as const)("owns an unsubscribe returned by a %s native event API", async mode => {
    const remove = vi.fn(), listener = vi.fn();
    host.on.mockImplementation((event: string, receive: (value: unknown) => void) => {
      expect(event).toBe("desktop-plugins-changed"); host.receive = receive;
      return mode === "sync" ? remove : Promise.resolve(remove);
    });
    const stop = subscribeLocalPlugins(listener);
    await Promise.resolve();
    host.receive!(snapshot); expect(listener).toHaveBeenCalledWith(snapshot);
    stop(); expect(remove).toHaveBeenCalledOnce();
    host.receive!({ ...snapshot, revision: 2 }); expect(listener).toHaveBeenCalledOnce();
  });
  it("releases an asynchronously registered subscription when cancellation happened before it resolved", async () => {
    const { promise, resolve } = Promise.withResolvers<() => void>();
    const remove = vi.fn(), listener = vi.fn();
    host.on.mockImplementation((_event: string, receive: (value: unknown) => void) => { host.receive = receive; return promise; });
    const stop = subscribeLocalPlugins(listener); stop();
    resolve(remove); await promise; await Promise.resolve();
    expect(remove).toHaveBeenCalledOnce(); host.receive!(snapshot); expect(listener).not.toHaveBeenCalled();
  });
});
