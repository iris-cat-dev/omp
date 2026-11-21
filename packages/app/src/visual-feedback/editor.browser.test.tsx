import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { VisualFeedbackEditor } from "./editor.web";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native-unistyles", () => ({
  withUnistyles: (component: unknown) => component,
  UnistylesRuntime: { getTheme: () => ({ colors: {} }) },
}));

it("keeps a fitted image still at a fractional viewport size and scrolls when zoomed", async () => {
  await page.viewport(1440, 900);
  vi.stubGlobal("React", React);
  const style = document.createElement("style");
  // A half-pixel viewport can overflow if the fit calculation rounds it up.
  style.textContent = `
    .vf-main { flex: 0 0 1000px !important; }
    .vf-canvas-scroll { flex: 0 0 607.5px !important; }
    .vf-canvas-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
  `;
  const container = document.createElement("div");
  document.body.append(style, container);
  const root = createRoot(container);
  try {
    flushSync(() => {
      root.render(
        <VisualFeedbackEditor
          request={{ id: "feedback", agentId: "agent", title: "", instructions: "", text: "" }}
          onSubmit={async () => {}}
          onCancel={() => {}}
        />,
      );
    });
    const canvas = document.createElement("canvas");
    canvas.width = 3260;
    canvas.height = 1926;
    const { promise, resolve } = Promise.withResolvers<Blob | null>();
    canvas.toBlob(resolve, "image/png");
    const png = await promise;
    if (!png) throw new Error("Could not generate the test screenshot");
    await userEvent.upload(
      document.querySelector<HTMLInputElement>('input[type="file"]')!,
      new File([png], "capture.png", { type: "image/png" }),
    );
    await expect
      .poll(() => document.querySelector<HTMLImageElement>(".vf-image img")?.complete)
      .toBe(true);
    const viewport = document.querySelector<HTMLDivElement>(".vf-canvas-scroll")!;
    const imageBox = document.querySelector<HTMLDivElement>(".vf-image")!;
    const fitted = imageBox.getBoundingClientRect().toJSON();
    for (let frame = 0; frame < 8; frame++) {
      const nextFrame = Promise.withResolvers<number>();
      requestAnimationFrame(nextFrame.resolve);
      await nextFrame.promise;
      expect(imageBox.getBoundingClientRect().toJSON()).toEqual(fitted);
    }
    expect(fitted.height).toBeCloseTo(559.5, 1);
    expect(viewport.scrollHeight).toBe(viewport.clientHeight);
    expect(viewport.scrollWidth).toBe(viewport.clientWidth);
    await page.getByRole("button", { name: "visualFeedback.zoomIn" }).click();
    expect(imageBox.getBoundingClientRect().height).toBeCloseTo(fitted.height * 1.25, 1);
    viewport.scrollTo(50, 50);
    expect(viewport.scrollLeft).toBe(50);
    expect(viewport.scrollTop).toBe(50);

    await page.getByRole("button", { name: "visualFeedback.fit" }).click();
    expect(viewport.scrollLeft).toBe(0);
    expect(viewport.scrollTop).toBe(0);
    expect(imageBox.getBoundingClientRect().toJSON()).toEqual(fitted);
  } finally {
    root.unmount();
    document.getElementById("overlay-root")?.remove();
    style.remove();
    container.remove();
    vi.unstubAllGlobals();
  }
});
