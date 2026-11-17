import type { ToolCallDetail } from "@omp-desktop/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";

import { buildToolCallPresentation, type ToolCallPresentationIcon } from "./presentation";

const fakeIcons = {
  brain: (() => null) as ToolCallPresentationIcon,
  eye: (() => null) as ToolCallPresentationIcon,
  wrench: (() => null) as ToolCallPresentationIcon,
};

function fakeResolveIcon(
  toolName: string,
  detail: ToolCallDetail | undefined,
): ToolCallPresentationIcon {
  if (detail?.type === "plan") {
    return fakeIcons.brain;
  }
  if (detail?.type === "read") {
    return fakeIcons.eye;
  }
  if (toolName === "exec_command") {
    return fakeIcons.wrench;
  }
  return fakeIcons.wrench;
}

describe("tool-call presentation", () => {
  it("shows the current build and measured progress in a collapsed shell badge", () => {
    const input = {
      toolName: "bash",
      status: "running" as const,
      error: null,
      detail: {
        type: "shell" as const,
        command: "cmake --build 构建",
        execution: {
          seq: 4,
          state: "running" as const,
          steps: [{ id: "0:0", command: "cmake --build 构建", state: "running" as const }],
          currentStepId: "0:0",
          totalSteps: 1,
          truncated: false,
          progress: {
            kind: "fraction" as const,
            completed: 6,
            total: 24,
            label: "Building CXX object 中文.o",
          },
        },
      },
      resolveIcon: fakeResolveIcon,
      t: i18n.getFixedT("en"),
    };
    expect(buildToolCallPresentation(input).summary).toBe(
      "Running · 6/24 · Building CXX object 中文.o",
    );
    expect(buildToolCallPresentation({ ...input, status: "canceled" }).summary).toBe(
      "Stopped · 6/24 · Building CXX object 中文.o",
    );
    expect(
      buildToolCallPresentation({
        ...input,
        detail: { ...input.detail, execution: { ...input.detail.execution, progress: undefined } },
      }).summary,
    ).toBe("Running · cmake --build 构建");
  });

  it("builds badge, detail, icon, and file-open policy in one model", () => {
    const presentation = buildToolCallPresentation({
      toolName: "read_file",
      status: "completed",
      error: null,
      cwd: "/tmp/repo",
      detail: {
        type: "read",
        filePath: "/tmp/repo/src/index.ts",
        content: "console.log('hi');",
      },
      resolveIcon: fakeResolveIcon,
      t: i18n.getFixedT("en"),
    });

    expect(presentation).toMatchObject({
      displayName: "Read",
      summary: "src/index.ts",
      icon: fakeIcons.eye,
      isLoadingDetails: false,
      hasDetails: true,
      canOpenDetails: true,
      openFileTarget: {
        raw: "/tmp/repo/src/index.ts",
        path: "/tmp/repo/src/index.ts",
      },
      isPlan: false,
    });
  });

  it("separates a read line range from the path opened in the file preview", () => {
    const presentation = buildToolCallPresentation({
      toolName: "read",
      status: "completed",
      error: null,
      detail: {
        type: "read",
        filePath: "/tmp/repo/src/index.ts:50-90",
        content: "console.log('hi');",
      },
      resolveIcon: fakeResolveIcon,
      t: i18n.getFixedT("en"),
    });

    expect(presentation.openFileTarget).toEqual({
      raw: "/tmp/repo/src/index.ts:50-90",
      path: "/tmp/repo/src/index.ts",
      lineStart: 50,
      lineEnd: 90,
    });
  });

  it("opens a read with discontiguous ranges as the underlying file", () => {
    const presentation = buildToolCallPresentation({
      toolName: "read",
      status: "completed",
      error: null,
      detail: {
        type: "read",
        filePath: "/tmp/repo/src/index.ts:1-180,1950-2145,2145-2225",
        content: "console.log('hi');",
      },
      resolveIcon: fakeResolveIcon,
      t: i18n.getFixedT("en"),
    });

    expect(presentation.openFileTarget).toEqual({
      raw: "/tmp/repo/src/index.ts:1-180,1950-2145,2145-2225",
      path: "/tmp/repo/src/index.ts",
      lineStart: 1,
      lineEnd: 180,
    });
  });

  it("marks running calls without meaningful detail as loading details", () => {
    const presentation = buildToolCallPresentation({
      toolName: "exec_command",
      status: "running",
      error: null,
      detail: {
        type: "unknown",
        input: {},
        output: null,
      },
      resolveIcon: fakeResolveIcon,
      t: i18n.getFixedT("en"),
    });

    expect(presentation).toMatchObject({
      displayName: "Exec Command",
      icon: fakeIcons.wrench,
      isLoadingDetails: true,
      hasDetails: false,
      canOpenDetails: true,
      openFileTarget: null,
      isPlan: false,
    });
  });

  it("keeps plan calls out of the expandable badge path", () => {
    const presentation = buildToolCallPresentation({
      toolName: "ExitPlanMode",
      status: "completed",
      error: null,
      detail: {
        type: "plan",
        text: "1. Do the thing",
      },
      resolveIcon: fakeResolveIcon,
      t: i18n.getFixedT("en"),
    });

    expect(presentation.isPlan).toBe(true);
    expect(presentation.icon).toBe(fakeIcons.brain);
  });
});
