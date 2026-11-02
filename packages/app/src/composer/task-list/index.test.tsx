/** @vitest-environment jsdom */
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);

vi.mock("react-native", () => ({
  Platform: {
    OS: "web",
    select: (values: Record<string, unknown>) => values.web ?? values.default,
  },
  View: ({
    children,
    style: _style,
    testID,
    collapsable: _collapsable,
    accessibilityLabel,
    ...props
  }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement(
      "div",
      { ...props, "data-testid": testID, "aria-label": accessibilityLabel },
      children,
    ),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
    accessibilityRole: _accessibilityRole,
    style: _style,
    testID,
    ...props
  }: React.PropsWithChildren<{
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityState?: { expanded?: boolean };
    "aria-expanded"?: boolean;
    accessibilityRole?: string;
    style?: unknown;
    testID?: string;
  }>) =>
    React.createElement(
      "button",
      {
        ...props,
        type: "button",
        "data-testid": testID,
        "aria-label": accessibilityLabel,
        "aria-expanded": props["aria-expanded"] ?? accessibilityState?.expanded,
        onClick: onPress,
      },
      children,
    ),
  ScrollView: ({
    children,
    style: _style,
    contentContainerStyle: _contentContainerStyle,
    showsVerticalScrollIndicator: _showsVerticalScrollIndicator,
    ...props
  }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("div", props, children),
  Text: ({ children, style: _style, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("span", props, children),
}));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (theme: Record<string, unknown>) => unknown) =>
      factory({
        spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
        colors: {
          surface1: "#111",
          surface2: "#222",
          surfaceSidebarHover: "#333",
          border: "#222",
          foreground: "#fff",
          foregroundMuted: "#aaa",
          foregroundExtraMuted: "#777",
          statusDotRunning: "#48f",
          statusWarning: "#ba6",
          statusDanger: "#c77",
        },
        borderWidth: { 1: 1 },
        borderRadius: { md: 6, lg: 8, xl: 12 },
        fontSize: { xs: 11, sm: 12, base: 14 },
        fontWeight: { normal: "400", medium: "500", semibold: "600" },
        fontFamily: { mono: "monospace" },
      }),
  },
  withUnistyles: (Component: React.ComponentType) => Component,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { completed?: number; total?: number }) => {
      if (key === "message.todo.tasksProgress") {
        return `${values?.completed}/${values?.total} tasks`;
      }
      if (key === "message.todo.collapse") return "Collapse tasks";
      if (key === "message.todo.expand") return "Show tasks";
      return "Tasks";
    },
  }),
}));
vi.mock("lucide-react-native", () => ({
  ListTodo: () => null,
  PanelRightClose: () => null,
  ChevronRight: () => null,
  ChevronsUpDown: () => null,
  Circle: () => null,
  CircleDot: () => null,
  CircleCheck: () => null,
  CircleMinus: () => null,
  CirclePause: () => null,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => children,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => children,
  TooltipContent: () => null,
}));
vi.mock("@/constants/platform", () => ({ isWeb: true }));

import { AgentTaskPanel, AgentTaskPanelToggle } from "./index";
import { TaskListTree } from "@/components/task-list-tree";
import type { TodoEntry } from "@/types/stream";

function task(text: string, index?: number, status: TodoEntry["status"] = "pending"): TodoEntry {
  return {
    text,
    completed: status === "completed",
    status,
    ...(index === undefined ? {} : { phase: { name: `Stage ${index}`, index } }),
  };
}

describe("AgentTaskPanel", () => {
  afterEach(cleanup);

  it("keeps panel collapse separate from expanding all phases", () => {
    const onCollapse = vi.fn();
    const view = render(
      <AgentTaskPanel
        onCollapse={onCollapse}
        tasks={[
          task("Inspect", 0, "completed"),
          {
            ...task("Implement", 1, "in_progress"),
            activeForm: "Implementing the complete task description",
          },
        ]}
      />,
    );
    expect(view.queryByText("Inspect")).toBeNull();
    expect(view.getByText("Implementing the complete task description")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Show tasks: 1/2 tasks" }));
    expect(view.getByText("Inspect")).toBeTruthy();
    expect(onCollapse).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Collapse tasks" }));
    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it("restores the tree from the compact progress entry point", () => {
    const items = [
      task("Done", undefined, "completed"),
      task("Discarded", undefined, "abandoned"),
      task("Next"),
    ];
    function Panel() {
      const [collapsed, setCollapsed] = React.useState(true);
      const expand = React.useCallback(() => setCollapsed(false), []);
      const collapse = React.useCallback(() => setCollapsed(true), []);
      return collapsed ? (
        <AgentTaskPanelToggle tasks={items} onExpand={expand} />
      ) : (
        <AgentTaskPanel tasks={items} onCollapse={collapse} />
      );
    }
    const view = render(<Panel />);
    expect(view.queryByRole("tree")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Show tasks: 2/3 tasks" }));
    expect(view.getByRole("tree")).toBeTruthy();
    expect(view.getByLabelText("abandoned: Discarded")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Collapse tasks" }));
    expect(view.queryByRole("tree")).toBeNull();
  });

  it("expands and collapses phases independently without hiding other stages", () => {
    const view = render(<TaskListTree items={[task("Current", 0), task("Future", 1)]} />);
    const current = view.getByRole("treeitem", { name: "Stage 0: 0/1" });
    const future = view.getByRole("treeitem", { name: "Stage 1: 0/1" });
    expect(current.getAttribute("aria-expanded")).toBe("true");
    expect(future.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(future);
    expect(view.getByText("Future")).toBeTruthy();
    expect(view.getByText("Current")).toBeTruthy();
    fireEvent.click(current);
    expect(view.queryByText("Current")).toBeNull();
    expect(view.getByText("Future")).toBeTruthy();
    expect(view.getByRole("treeitem", { name: "Stage 0: 0/1" })).toBeTruthy();
  });

  it("keeps same-named phases and their progress independently addressable", () => {
    const items = [
      task("Finished build", 0, "completed"),
      task("First build", 0),
      task("Second build", 1),
    ];
    for (const item of items) item.phase!.name = "Build";
    const view = render(<TaskListTree items={items} />);
    fireEvent.click(view.getByRole("treeitem", { name: "Build: 0/1" }));
    expect(view.getByText("First build")).toBeTruthy();
    expect(view.getByText("Second build")).toBeTruthy();
    fireEvent.click(view.getByRole("treeitem", { name: "Build: 1/2" }));
    expect(view.queryByText("First build")).toBeNull();
    expect(view.getByText("Second build")).toBeTruthy();
  });

  it("opens newly active work while preserving explicit phase disclosure choices", () => {
    const view = render(<TaskListTree items={[task("First", 0), task("Next", 1)]} />);
    fireEvent.click(view.getByRole("treeitem", { name: "Stage 0: 0/1" }));
    view.rerender(<TaskListTree items={[task("First", 0, "completed"), task("Next", 1)]} />);
    expect(view.queryByText("First")).toBeNull();
    expect(view.getByText("Next")).toBeTruthy();
    fireEvent.click(view.getByRole("treeitem", { name: "Stage 1: 0/1" }));
    view.rerender(
      <TaskListTree items={[task("First", 0, "completed"), task("Next", 1, "in_progress")]} />,
    );
    expect(view.queryByText("Next")).toBeNull();
    expect(view.getByRole("treeitem", { name: "Stage 1: 0/1" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("navigates visible tree items and their parent with arrow keys", () => {
    const view = render(<TaskListTree items={[task("First", 0), task("Next", 1)]} />);
    const first = view.getByRole("treeitem", { name: "Stage 0: 0/1" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(view.getByRole("treeitem", { name: "pending: First" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(view.queryByText("First")).toBeNull();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const next = view.getByRole("treeitem", { name: "Stage 1: 0/1" });
    expect(document.activeElement).toBe(next);
    fireEvent.keyDown(next, { key: "ArrowRight" });
    expect(view.getByText("Next")).toBeTruthy();
    fireEvent.keyDown(next, { key: "End" });
    expect(document.activeElement).toBe(view.getByRole("treeitem", { name: "pending: Next" }));
  });

  it("retains legacy ungrouped tasks without a viewport cutoff", () => {
    const items = Array.from({ length: 8 }, (_, index) => task(`Queued ${index}`));
    const view = render(<TaskListTree items={items} />);
    expect(view.getByRole("treeitem", { name: "pending: Queued 0" })).toBeTruthy();
    expect(view.getByRole("treeitem", { name: "pending: Queued 7" })).toBeTruthy();
    expect((view.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides an empty panel and disables the empty detail tree's expansion", () => {
    const view = render(<AgentTaskPanel tasks={[]} onCollapse={vi.fn()} />);
    expect(view.queryByRole("button")).toBeNull();
    view.rerender(<TaskListTree items={[]} />);
    expect((view.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
