import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as Reanimated from "react-native-reanimated";
import { userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import type {
  AgentCapabilityFlags,
  AgentUserMessageRewindStatus,
} from "@omp-desktop/protocol/agent-types";
import { RewindMenu } from "./rewind-menu";
import { resolveUserMessageRewindStatus } from "@/types/stream";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// Keep real menu DOM/interaction but replace the animation boundary, as in acceptance-clear.
// Hoisted mock factories run before static imports initialize react-native, so load it here.
vi.mock("react-native-reanimated", async (importOriginal) => {
  const actual = await importOriginal<typeof Reanimated>();
  const { View } = await import("react-native");
  return { ...actual, default: { ...actual.default, View } };
});

const capabilities: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
  supportsRewindFiles: true,
  supportsRewindBoth: true,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function mountMenu() {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

it("blocks rewind for a legacy local ID but honors explicit readiness with coincident IDs", async () => {
  mountMenu();
  const message = { messageId: "local-id", clientMessageId: "local-id" };
  const onRewind = vi.fn();
  const onSync = vi.fn();
  await act(async () =>
    root!.render(
      <RewindMenu
        capabilities={capabilities}
        rewindStatus={resolveUserMessageRewindStatus(message)}
        rewoundText="prompt"
        rewoundImages={[]}
        rewoundAttachments={[]}
        onRewind={onRewind}
        onSync={onSync}
      />,
    ),
  );
  const trigger = container!.querySelector<HTMLElement>('[data-testid="rewind-menu-trigger"]')!;
  expect(trigger.getAttribute("aria-disabled")).toBe("true");
  act(() => trigger.click());
  expect(document.querySelector('[data-testid="rewind-menu-content"]')).toBeNull();
  expect(onRewind).not.toHaveBeenCalled();

  await act(async () =>
    root!.render(
      <RewindMenu
        capabilities={capabilities}
        rewindStatus={resolveUserMessageRewindStatus({ ...message, rewindStatus: "ready" })}
        rewoundText="prompt"
        rewoundImages={[]}
        rewoundAttachments={[]}
        onRewind={onRewind}
        onSync={onSync}
      />,
    ),
  );
  expect(trigger.getAttribute("aria-disabled")).not.toBe("true");
  await userEvent.click(trigger);
  await expect
    .poll(() => document.querySelector('[data-testid="rewind-menu-conversation"]'))
    .not.toBeNull();
  await userEvent.click(document.querySelector('[data-testid="rewind-menu-conversation"]')!);
  await expect.poll(() => onRewind.mock.calls.length).toBe(1);
  expect(onSync).not.toHaveBeenCalled();
});

it("disables pending rewind and unlocks the same menu when metadata becomes ready", async () => {
  mountMenu();
  const onRewind = vi.fn();
  const onSync = vi.fn();
  const render = (rewindStatus: AgentUserMessageRewindStatus) =>
    root!.render(
      <RewindMenu
        capabilities={capabilities}
        rewindStatus={rewindStatus}
        rewoundText="prompt"
        rewoundImages={[]}
        rewoundAttachments={[]}
        onRewind={onRewind}
        onSync={onSync}
      />,
    );
  await act(async () => render("pending"));
  const trigger = container!.querySelector<HTMLElement>('[data-testid="rewind-menu-trigger"]')!;
  expect(trigger.getAttribute("aria-disabled")).toBe("true");
  act(() => trigger.click());
  expect(document.querySelector('[data-testid="rewind-menu-content"]')).toBeNull();
  expect(onRewind).not.toHaveBeenCalled();

  await act(async () => render("ready"));
  expect(container!.querySelector('[data-testid="rewind-menu-trigger"]')).toBe(trigger);
  expect(trigger.getAttribute("aria-disabled")).not.toBe("true");
  await userEvent.click(trigger);
  await expect
    .poll(() => document.querySelector('[data-testid="rewind-menu-conversation"]'))
    .not.toBeNull();
  await userEvent.click(document.querySelector('[data-testid="rewind-menu-conversation"]')!);
  await expect.poll(() => onRewind.mock.calls.length).toBe(1);
  expect(onRewind).toHaveBeenCalledWith({
    mode: "conversation",
    rewoundText: "prompt",
    rewoundImages: [],
    rewoundAttachments: [],
  });
  expect(onSync).not.toHaveBeenCalled();
});

it("only resyncs an unavailable message, then enables explicit rewind after a ready update", async () => {
  mountMenu();
  const sync = Promise.withResolvers<void>();
  const onSync = vi.fn(() => sync.promise);
  const onRewind = vi.fn();
  const render = (rewindStatus: AgentUserMessageRewindStatus) =>
    root!.render(
      <RewindMenu
        capabilities={capabilities}
        rewindStatus={rewindStatus}
        rewoundText="prompt"
        rewoundImages={[]}
        rewoundAttachments={[]}
        onRewind={onRewind}
        onSync={onSync}
      />,
    );
  await act(async () => render("unavailable"));
  const trigger = container!.querySelector<HTMLElement>('[data-testid="rewind-menu-trigger"]')!;
  expect(trigger.getAttribute("aria-disabled")).not.toBe("true");
  await userEvent.click(trigger);
  await expect
    .poll(() => document.querySelector('[data-testid="rewind-menu-sync"]'))
    .not.toBeNull();
  const rewind = document.querySelector<HTMLElement>('[data-testid="rewind-menu-conversation"]')!;
  const resync = document.querySelector<HTMLElement>('[data-testid="rewind-menu-sync"]')!;
  expect(rewind.getAttribute("aria-disabled")).toBe("true");
  act(() => {
    rewind.click();
    resync.click();
    resync.click();
  });
  await expect.poll(() => onSync.mock.calls.length).toBe(1);
  expect(onRewind).not.toHaveBeenCalled();

  await act(async () => {
    render("ready");
    sync.resolve();
  });
  await expect.poll(() => document.querySelector('[data-testid="rewind-menu-sync"]')).toBeNull();
  const readyRewind = document.querySelector<HTMLElement>(
    '[data-testid="rewind-menu-conversation"]',
  )!;
  expect(readyRewind.getAttribute("aria-disabled")).not.toBe("true");
  expect(onRewind).not.toHaveBeenCalled();
  await userEvent.click(readyRewind);
  await expect.poll(() => onRewind.mock.calls.length).toBe(1);
});
