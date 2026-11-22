import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { VisualFeedbackEditor } from "./editor.web";
import { VisualFeedbackSubmitError } from "./submit-diagnostics";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native-unistyles", () => ({
  withUnistyles: (component: unknown) => component,
  UnistylesRuntime: { getTheme: () => ({ colors: {} }) },
}));

const emptyRequest = { id: "feedback", agentId: "agent", title: "", instructions: "", text: "" };
const ignoreSubmit = async () => {};
const ignoreCancel = () => {};

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
          request={emptyRequest}
          onSubmit={ignoreSubmit}
          onCancel={ignoreCancel}
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

it("logs a redacted save failure and preserves feedback for an explicit retry", async () => {
  vi.stubGlobal("React", React);
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  const onSubmit = vi
    .fn<React.ComponentProps<typeof VisualFeedbackEditor>["onSubmit"]>()
    .mockRejectedValueOnce(
      new VisualFeedbackSubmitError("save-preview", new Error("ENOSPC: /private/screenshot.png")),
    )
    .mockResolvedValueOnce(undefined);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const image = {
      data: canvas.toDataURL().split(",")[1]!,
      mimeType: "image/png" as const,
      width: 64,
      height: 48,
    };
    const request = { ...emptyRequest, id: "private-request-id", image };
    flushSync(() => {
      root.render(
        React.createElement(VisualFeedbackEditor, { request, onSubmit, onCancel: ignoreCancel }),
      );
    });
    const feedback = page.getByRole("textbox", { name: "visualFeedback.feedback" });
    await feedback.fill("private feedback text");
    const submit = page.getByRole("button", { name: "visualFeedback.submit", exact: true });
    await expect.element(submit).toBeEnabled();
    await submit.click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("visualFeedback.submitError");
    await expect.element(feedback).toHaveValue("private feedback text");

    const prefix = "[visual-feedback] Submit failed ";
    const logs = errorLog.mock.calls.flatMap(([line]) =>
      typeof line === "string" && line.startsWith(prefix) ? [line.slice(prefix.length)] : [],
    );
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      stage: "save-preview",
      image: { width: 64, height: 48, mimeType: "image/png" },
      error: { name: "Error", code: "ENOSPC" },
    });
    for (const privateValue of [
      "/private/screenshot.png",
      "private feedback text",
      "private-request-id",
      image.data,
    ]) {
      expect(logs[0]).not.toContain(privateValue);
    }
    await submit.click();
    await expect.poll(() => onSubmit.mock.calls[1]?.[0].feedback).toBe("private feedback text");
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    expect(
      errorLog.mock.calls.filter(([line]) => typeof line === "string" && line.startsWith(prefix)),
    ).toHaveLength(1);
  } finally {
    root.unmount();
    document.getElementById("overlay-root")?.remove();
    container.remove();
    errorLog.mockRestore();
    vi.unstubAllGlobals();
  }
});
