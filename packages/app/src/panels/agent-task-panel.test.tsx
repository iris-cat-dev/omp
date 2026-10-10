/** @vitest-environment jsdom */
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TodoEntry } from "@/types/stream";

vi.stubGlobal("React", React);

vi.mock("react-native", () => ({
  Platform: {
    OS: "web",
    select: (values: Record<string, unknown>) => values.web ?? values.default,
  },
  View: ({
    children,
    testID,
    ...props
  }: React.PropsWithChildren<Record<string, unknown> & { testID?: string }>) =>
    React.createElement("div", { ...props, "data-testid": testID }, children),
}));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (theme: { spacing: { 4: number } }) => unknown) =>
      factory({ spacing: { 4: 16 } }),
  },
}));
vi.mock("@/composer/task-list", () => ({
  AGENT_TASK_PANEL_DESKTOP_WIDTH: 340,
  AgentTaskPanel: ({ onCollapse }: { onCollapse: () => void }) => (
    <button type="button" onClick={onCollapse}>
      Collapse tasks
    </button>
  ),
  AgentTaskPanelToggle: ({ onExpand }: { onExpand: () => void }) => (
    <button type="button" onClick={onExpand}>
      Show tasks
    </button>
  ),
}));

import { useAgentTaskPanel } from "./agent-task-panel";

const TASKS: TodoEntry[] = [{ text: "Keep both panes readable", completed: false }];

function TaskPanelHarness({ isAvailable }: { isAvailable: boolean }) {
  const taskPanel = useAgentTaskPanel(TASKS, isAvailable);
  return (
    <>
      {taskPanel.content}
      {taskPanel.spacer}
    </>
  );
}

afterEach(cleanup);

describe("useAgentTaskPanel", () => {
  it("hides an expanded rail while its pane is narrow and restores it when space returns", () => {
    const view = render(<TaskPanelHarness isAvailable />);

    fireEvent.click(view.getByRole("button", { name: "Show tasks" }));
    expect(view.getByTestId("agent-task-panel-rail")).toBeTruthy();
    expect(view.getByTestId("agent-task-panel-spacer")).toBeTruthy();

    view.rerender(<TaskPanelHarness isAvailable={false} />);
    expect(view.queryByTestId("agent-task-panel-rail")).toBeNull();
    expect(view.queryByTestId("agent-task-panel-toggle")).toBeNull();
    expect(view.queryByTestId("agent-task-panel-spacer")).toBeNull();

    view.rerender(<TaskPanelHarness isAvailable />);
    expect(view.getByTestId("agent-task-panel-rail")).toBeTruthy();
    expect(view.getByTestId("agent-task-panel-spacer")).toBeTruthy();
  });
});
