import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingPermission } from "@/types/shared";
import { QuestionFormCard } from "./question-form-card";

vi.mock("@/assistant-image/timeline-assets", () => ({
  persistTimelineImageAssets: vi.fn(),
  retainTimelineImageAssets: vi.fn(),
}));
interface MountedCard {
  root: Root;
  container: HTMLDivElement;
}

const mountedCards: MountedCard[] = [];
function createPermission(question: string): PendingPermission {
  return {
    key: "long-question",
    agentId: "agent",
    request: {
      id: "permission",
      provider: "omp",
      name: "question",
      kind: "question",
      input: {
        questions: [
          {
            header: "Approval",
            question,
            options: [{ label: "Approve" }, { label: "Deny" }],
          },
        ],
      },
    },
  };
}

function mountCard(question: string): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = "360px";
  document.body.appendChild(container);
  const root = createRoot(container);
  const permission = createPermission(question);

  act(() =>
    root.render(
      <QuestionFormCard
        serverId="question-card-layout"
        permission={permission}
        onRespond={vi.fn()}
        isResponding={false}
      />,
    ),
  );
  mountedCards.push({ root, container });
  return container;
}

afterEach(() => {
  for (const mounted of mountedCards.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.container.remove();
  }
});

describe("QuestionFormCard", () => {
  it("wraps an unbroken long question within the card", () => {
    const container = mountCard(
      `Allow tool: eval\nCode: ${"https://example.test/"}${"segment".repeat(80)}`,
    );
    const card = container.querySelector('[data-testid="question-form-card"]');
    const question = container.querySelector('[data-testid="question-form-current-question"]');
    if (!(card instanceof HTMLElement) || !(question instanceof HTMLElement)) {
      throw new Error("QuestionFormCard did not render its question");
    }

    expect(question.getBoundingClientRect().height).toBeGreaterThan(44);
    expect(question.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  });
});
