import { expect, it } from "vitest";
import { setCssColorAlpha } from "./color";

it("restores a translucent theme variable to an opaque, live overlay color", () => {
  const panel = document.createElement("div");
  panel.style.setProperty("--panel-color", "rgba(17, 34, 51, 0)");
  panel.style.backgroundColor = setCssColorAlpha("var(--panel-color)", 1);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Browser did not provide a canvas context");
  const pixel = () => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = getComputedStyle(panel).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  };

  document.body.appendChild(panel);
  try {
    expect(pixel()).toEqual([17, 34, 51, 255]);
    panel.style.setProperty("--panel-color", "rgba(204, 102, 51, 0.1)");
    expect(pixel()).toEqual([204, 102, 51, 255]);
    panel.style.setProperty("--panel-color", "rgba(0, 255, 0, 0.2)");
    panel.style.backgroundColor = setCssColorAlpha("var(--panel-color)", 0.5);
    expect(pixel()).toEqual([0, 255, 0, 128]);
  } finally {
    panel.remove();
  }
});
