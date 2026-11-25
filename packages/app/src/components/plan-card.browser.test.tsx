import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanCard } from "./plan-card";

vi.mock("@/hooks/use-fine-pointer", () => ({
  useShowPersistentActions: () => false,
  useTouchInteraction: () => false,
  useSupportsHover: () => true,
  useHasFinePointer: () => true,
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));

const mounted: { root: Root; container: HTMLDivElement }[] = [];

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
});

async function mountPlanCard(text: string) {
  const container = document.createElement("div");
  container.style.width = "760px";
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });

  await act(async () => {
    root.render(<PlanCard title="Plan #1" text={text} testID="plan-card" />);
  });
  return container;
}

describe("PlanCard MarkdownRenderer integration", () => {
  it("keeps <details> implementation specs collapsed by default and toggles them cleanly", async () => {
    const planMarkdown = [
      "## Overview",
      "",
      "Administrators can set a per-user concurrency limit; leaving it blank removes the personal cap.",
      "",
      "| Rule | Behavior |",
      "| --- | --- |",
      "| Allowed values | Integer 1–1000 or blank |",
      "",
      "### 1. Persist per-user limit",
      "",
      "- **Storage**: Save the limit in user preferences and clear the key when unset.",
      "",
      "<details>",
      "<summary>Implementation details: files & signatures</summary>",
      "",
      "- **File**: `packages/runs/src/limits.ts`",
      "",
      "```ts",
      "export function resolveCaller(owners: Pick<OwnerDao, 'get'>, id: string): Promise<Caller>",
      "```",
      "",
      "</details>",
    ].join("\n");

    const container = await mountPlanCard(planMarkdown);

    expect(container.textContent).toContain("Administrators can set a per-user concurrency limit");
    expect(container.textContent).toContain("Integer 1–1000 or blank");
    expect(container.textContent).not.toContain("packages/runs/src/limits.ts");
    expect(container.textContent).not.toContain("resolveCaller");

    const summaryButton = Array.from(container.querySelectorAll('[role="button"]')).find((el) =>
      el.textContent?.includes("Implementation details: files & signatures"),
    );
    expect(summaryButton).toBeInstanceOf(HTMLElement);
    expect(summaryButton?.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(summaryButton as HTMLElement);

    expect(summaryButton?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("packages/runs/src/limits.ts");
    expect(container.textContent).toContain("Pick<OwnerDao, 'get'>");

    await userEvent.click(summaryButton as HTMLElement);

    expect(summaryButton?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("packages/runs/src/limits.ts");
  });

  it("renders Mermaid diagrams inside PlanCard", async () => {
    const planMarkdown = [
      "## Flow",
      "",
      "```mermaid",
      "flowchart LR",
      "  UI[Admin UI] --> API[Limit API]",
      "  API --> Sched[Scheduler]",
      "```",
    ].join("\n");

    const container = await mountPlanCard(planMarkdown);

    await expect
      .poll(() => container.querySelector('[role="img"]') instanceof HTMLElement, {
        timeout: 10_000,
      })
      .toBe(true);
  });
});
