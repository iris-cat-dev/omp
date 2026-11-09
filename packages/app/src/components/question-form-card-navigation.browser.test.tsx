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

const groupedPermission: PendingPermission = {
  key: "grouped-ask",
  agentId: "agent",
  request: {
    id: "ask-dialog",
    provider: "omp",
    name: "OMP ask",
    kind: "question",
    metadata: { extensionUiMethod: "ask" },
    input: {
      questions: [
        {
          id: "deadline",
          header: "Policy",
          question: "How should the deadline work?",
          options: [
            { label: "Keep, original deadline", recommended: true },
            { label: "Reset deadline" },
          ],
          allowOther: true,
        },
        {
          id: "scope",
          header: "Policy",
          question: "Which orders are included?",
          options: [{ label: "Personal, unpaid" }, { label: "Business (Recommended)" }],
          multiSelect: true,
          allowOther: true,
        },
        {
          id: "unpaid",
          header: "Unpaid",
          question: "What happens to unpaid orders?",
          options: [{ label: "Keep pending" }, { label: "Close orders" }],
          allowOther: true,
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

it("keeps three RPC ask answers intact when revisiting and editing earlier questions", async () => {
  const onRespond = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <QuestionFormCard
        permission={groupedPermission}
        onRespond={onRespond}
        isResponding={false}
      />,
    );
  });

  const option = (label: string) => container.querySelector(`[aria-label="${label}"]`)!;
  const tab = (index: number) =>
    container.querySelector(`[data-testid="question-form-question-nav-${index}"]`)!;
  const primary = container.querySelector('[data-testid="question-form-primary-action"]')!;
  const custom = () =>
    container.querySelector('[data-testid="question-form-other-input"]') as HTMLInputElement;

  await userEvent.click(option("Keep, original deadline (Recommended)"));
  await expect.poll(() => container.textContent).toContain("Which orders are included?");
  await userEvent.click(option("Business (Recommended)"));
  await userEvent.click(option("Personal, unpaid"));
  await userEvent.fill(custom(), "Plus follow-up");
  await userEvent.click(primary);
  await expect.poll(() => container.textContent).toContain("What happens to unpaid orders?");
  await userEvent.click(option("Keep pending"));
  expect(onRespond).not.toHaveBeenCalled();

  await userEvent.click(tab(2));
  expect(option("Business (Recommended)").getAttribute("aria-checked")).toBe("true");
  expect(option("Personal, unpaid").getAttribute("aria-checked")).toBe("true");
  expect(custom().value).toBe("Plus follow-up");
  await userEvent.click(tab(1));
  expect(option("Keep, original deadline (Recommended)").getAttribute("aria-checked")).toBe("true");
  await userEvent.click(option("Reset deadline"));
  await expect.poll(() => container.textContent).toContain("Which orders are included?");
  expect(custom().value).toBe("Plus follow-up");
  await userEvent.click(tab(3));
  expect(option("Keep pending").getAttribute("aria-checked")).toBe("true");
  await userEvent.click(primary);
  expect(onRespond.mock.calls).toEqual([
    [
      {
        behavior: "allow",
        updatedInput: {
          ...groupedPermission.request.input,
          answers: [
            { id: "deadline", selectedOptions: ["Reset deadline"] },
            {
              id: "scope",
              selectedOptions: ["Personal, unpaid", "Business (Recommended)"],
              customInput: "Plus follow-up",
            },
            { id: "unpaid", selectedOptions: ["Keep pending"] },
          ],
        },
      },
    ],
  ]);
});
