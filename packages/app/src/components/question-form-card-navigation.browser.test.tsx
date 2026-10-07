import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { commands, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import type { PendingPermission } from "@/types/shared";
import { QuestionFormCard } from "./question-form-card";

declare module "vitest/browser" {
  interface BrowserCommands {
    dragPointerWithinElement(selector: string, deltaX: number, deltaY: number): Promise<void>;
  }
}

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
const permission: PendingPermission = {
  key: "questions",
  agentId: "agent",
  request: {
    id: "permission",
    provider: "omp",
    name: "question",
    kind: "question",
    input: {
      questions: [
        {
          header: "Response",
          question: "Which capability should ship first?",
          options: [{ label: "Task execution" }, { label: "Blueprint editor" }],
          allowOther: true,
        },
        {
          header: "Comment",
          question: "Optional comment",
          options: [],
          allowEmpty: true,
        },
      ],
    },
  },
};

afterEach(async () => {
  for (const item of mounted.splice(0)) {
    await act(async () => item.root.unmount());
    item.container.remove();
  }
});

it("switches without selecting tab text and preserves the complete answer group", async () => {
  const onRespond = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <QuestionFormCard permission={permission} onRespond={onRespond} isResponding={false} />,
    );
  });

  const secondTabLabelSelector = '[data-testid="question-form-question-nav-2"] > div[dir="auto"]';
  if (!container.querySelector(secondTabLabelSelector)) {
    throw new Error("second question tab label missing");
  }
  await commands.dragPointerWithinElement(secondTabLabelSelector, -6, 0);
  await expect.poll(() => container.textContent).toContain("Optional comment");
  expect(window.getSelection()?.toString()).toBe("");

  await userEvent.click(container.querySelector('[data-testid="question-form-question-nav-1"]')!);
  await userEvent.click(container.querySelector('[aria-label="Task execution"]')!);
  await expect.poll(() => container.textContent).toContain("Optional comment");
  const commentInput = container.querySelector('[data-testid="question-form-other-input"]');
  if (!(commentInput instanceof HTMLInputElement)) throw new Error("comment input missing");
  await userEvent.fill(commentInput, "Ship this week");

  await userEvent.click(container.querySelector('[data-testid="question-form-question-nav-1"]')!);
  expect(
    container.querySelector('[aria-label="Task execution"]')?.getAttribute("aria-checked"),
  ).toBe("true");
  await userEvent.click(container.querySelector('[data-testid="question-form-question-nav-2"]')!);
  expect(
    (container.querySelector('[data-testid="question-form-other-input"]') as HTMLInputElement)
      .value,
  ).toBe("Ship this week");

  await userEvent.click(container.querySelector('[data-testid="question-form-primary-action"]')!);
  expect(onRespond).toHaveBeenCalledWith({
    behavior: "allow",
    updatedInput: {
      ...permission.request.input,
      answers: {
        Response: "Task execution",
        Comment: "Ship this week",
      },
    },
  });
});
