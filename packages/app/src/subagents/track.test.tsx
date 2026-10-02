// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import type { SubagentRow } from "./select";
import { SubagentsTrack } from "./track";

vi.mock("@/components/provider-icons", () => ({ getProviderIcon: () => null }));
vi.mock("@/screens/workspace/workspace-tab-presentation", () => ({ WorkspaceTabIcon: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
}));
vi.mock("@/composer/tracks", () => ({
  ComposerTrackPill: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ComposerTrackRow: ({
    children,
    onPress,
  }: {
    children: React.ReactNode | ((state: { active: boolean }) => React.ReactNode);
    onPress: () => void;
  }) => (
    <div onClick={onPress}>
      {typeof children === "function" ? children({ active: true }) : children}
    </div>
  ),
  ComposerTrackActions: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const managed: SubagentRow = {
  kind: "paseo",
  id: "managed",
  provider: "omp",
  title: "Managed task",
  description: null,
  model: null,
  subtitle: null,
  status: "running",
  requiresAttention: false,
  createdAt: new Date("2026-09-01T00:00:00Z"),
};
const provider: SubagentRow = {
  kind: "provider",
  id: "native",
  parentAgentId: "parent",
  provider: "omp",
  title: "Explore",
  description: "Inspect code",
  model: null,
  subtitle: null,
  status: "running",
  requiresAttention: false,
  createdAt: managed.createdAt,
};

beforeEach(async () => {
  vi.stubGlobal("React", React);
  if (!i18n.isInitialized) await i18n.init();
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SubagentsTrack stop controls", () => {
  it("allows one pending stop per running row and keeps it until server status changes", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const stopManaged = vi.fn(() => pending);
    const stopProvider = vi.fn(async () => {});
    const openManaged = vi.fn();
    const openProvider = vi.fn();
    render(
      <SubagentsTrack
        rows={[
          managed,
          provider,
          { ...provider, id: "finished", status: "completed" },
          { ...managed, id: "finished-managed", title: "Finished task", status: "idle" },
        ]}
        onOpenSubagent={openManaged}
        onOpenProviderSubagent={openProvider}
        onStopSubagent={stopManaged}
        onStopProviderSubagent={stopProvider}
        onArchiveSubagent={vi.fn()}
      />,
    );
    const managedStop = screen.getByRole("button", { name: "Stop Managed task" });
    expect(screen.getByRole("button", { name: "Stop Inspect code" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop Explore" })).toBeNull();
    expect(screen.queryByTestId("subagents-track-stop-finished")).toBeNull();
    expect(screen.queryByTestId("subagents-track-stop-finished-managed")).toBeNull();
    expect(screen.getByTestId("subagents-track-archive-finished-managed")).toBeTruthy();
    expect(screen.queryByTestId("subagents-track-archive-native")).toBeNull();
    fireEvent.click(managedStop);
    fireEvent.click(managedStop);
    await act(async () => {});
    expect(stopManaged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Stopping Managed task" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop Inspect code" }));
    expect(stopProvider).toHaveBeenCalledWith("parent", "native");
    expect(openManaged).not.toHaveBeenCalled();
    expect(openProvider).not.toHaveBeenCalled();
    await act(async () => resolve());
    expect(screen.queryByRole("button", { name: "Stopping Managed task" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop Managed task" })).toBeTruthy();
  });
});
