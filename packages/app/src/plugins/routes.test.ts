import { describe, expect, it } from "vitest";
import { buildPluginSurfaceRoute } from "./routes";

describe("plugin route ownership", () => {
  it("keeps a daemon named desktop distinct from the local Desktop profile", () => {
    const surface = { kind: "surface" as const, id: "counter" };
    expect(buildPluginSurfaceRoute("desktop", "counter", surface, "daemon")).toBe("/h/desktop/plugin/counter/surface/counter");
    expect(buildPluginSurfaceRoute("desktop", "counter", surface, "desktop")).toBe("/plugin/counter/surface/counter");
  });
  it("encodes each daemon and contribution identity as one path segment", () => {
    expect(buildPluginSurfaceRoute("office/host?#", "counter", { kind: "sidebar", id: "page/one" }, "daemon")).toBe("/h/office%2Fhost%3F%23/plugin/counter/sidebar/page%2Fone");
  });
});
