/** @vitest-environment jsdom */
import React from "react";
import type { ScrollView as NativeScrollView } from "react-native";
import { cleanup, render, screen } from "@testing-library/react";
import { createInstance, type i18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";
import type { ShellExecution, ToolCallDetail } from "@omp-desktop/protocol/agent-types";
import { en } from "@/i18n/resources/en";
import { zhCN } from "@/i18n/resources/zh-CN";
import { ToolCallDetailsContent } from "./tool-call-details";

// Use the existing native-boundary mock convention and shared react-native-web
// alias; shell rendering and i18n remain the production implementations.
vi.mock("react-native-gesture-handler", async () => {
  const { ScrollView } = await vi.importActual<{ ScrollView: typeof NativeScrollView }>(
    "react-native",
  );
  return { ScrollView };
});

const execution: ShellExecution = {
  seq: 5,
  state: "running",
  steps: [
    { id: "0:0", command: "cmake -S . -B 构建", state: "ok", exitCode: 0 },
    { id: "1:0", command: "cmake --build 构建", state: "running" },
  ],
  currentStepId: "1:0",
  totalSteps: 2,
  truncated: false,
  progress: { kind: "fraction", completed: 6, total: 24, label: "Building CXX object 中文.o" },
};

afterEach(cleanup);
function shellDetailsElement(detail: ToolCallDetail, i18n: i18n) {
  return (
    <I18nextProvider i18n={i18n}>
      <ToolCallDetailsContent detail={detail} />
    </I18nextProvider>
  );
}

function renderShellDetails(detail: ToolCallDetail, i18n: i18n) {
  const view = render(shellDetailsElement(detail, i18n));
  return {
    rerender: (nextDetail: ToolCallDetail) => view.rerender(shellDetailsElement(nextDetail, i18n)),
  };
}

test("shows measured progress and selectable logs, then stops the same surface on cancellation", async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  const detail: ToolCallDetail = {
    type: "shell",
    command: "cmake -S . -B 构建 && cmake --build 构建",
    output: "Compiling...\n[6/24] Building CXX object 中文.o\n",
    execution,
  };
  const view = renderShellDetails(detail, i18n);
  const progress = screen.getByRole("progressbar", { name: "Build progress" });
  expect(progress.getAttribute("aria-valuenow")).toBe("6");
  expect(progress.getAttribute("aria-valuemax")).toBe("24");
  expect(progress.getAttribute("aria-valuemin")).toBe("0");
  expect(screen.getByText("6/24")).toBeTruthy();
  expect(screen.getByText(/Compiling\.\.\./)).toBeTruthy();
  const stopped: ShellExecution = {
    ...execution,
    seq: 6,
    state: "canceled",
    termination: "canceled",
    steps: [execution.steps[0]!, { ...execution.steps[1]!, state: "canceled" }],
  };
  view.rerender({ ...detail, execution: stopped });
  expect(screen.queryByText("Running")).toBeNull();
  expect(screen.getAllByText("Stopped").length).toBe(2);
  expect(screen.getByText(/Compiling\.\.\./)).toBeTruthy();
});

test("unknown progress has no percentage or progressbar and old shell histories keep their logs", async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const unknown = { ...execution, progress: undefined };
  const view = renderShellDetails(
    { type: "shell", command: "build", output: "Compiling...", execution: unknown },
    i18n,
  );
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText(/\d+%/)).toBeNull();
  expect(screen.getByText(/Compiling\.\.\./)).toBeTruthy();
  view.rerender({ type: "shell", command: "build", output: "Old build log" });
  expect(screen.queryByTestId("shell-execution")).toBeNull();
  expect(screen.getByText(/Old build log/)).toBeTruthy();
});

test("Chinese timeout copy and CMake percentage remain distinct from completion", async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "zh-CN", resources: { "zh-CN": { translation: zhCN } } });
  const failed: ShellExecution = {
    ...execution,
    state: "fail",
    termination: "timed_out",
    steps: [{ id: "1:0", command: "cmake --build 构建", state: "fail", exitCode: 124 }],
    progress: { kind: "percentage", percentage: 50, label: "Building CXX object 中文.o" },
  };
  renderShellDetails({ type: "shell", command: "cmake --build 构建", execution: failed }, i18n);
  expect(screen.getByText("执行超时")).toBeTruthy();
  expect(screen.getByText("50%")).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "编译进度" }).getAttribute("aria-valuenow")).toBe(
    "50",
  );
  expect(screen.getByRole("progressbar", { name: "编译进度" }).getAttribute("aria-valuemin")).toBe(
    "0",
  );
  expect(screen.getByRole("progressbar", { name: "编译进度" }).getAttribute("aria-valuemax")).toBe(
    "100",
  );
});
