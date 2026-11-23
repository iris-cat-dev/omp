import { describe, expect, it } from "vitest";
import { resolvePluginFilePanel } from "./file-panel";
import {
  collectPluginContributions,
  emptyPluginContributions,
  type PluginClientInstance,
} from "./registry";

function panel(
  id: string,
  fileSuffix?: string,
  {
    hostId = "remote",
    owner = "daemon",
    mode = "active",
    aborted = false,
  }: {
    hostId?: string;
    owner?: "desktop" | "daemon";
    mode?: "manage" | "active";
    aborted?: boolean;
  } = {},
): PluginClientInstance {
  const activation = new AbortController();
  if (aborted) activation.abort();
  return {
    key: id,
    hostId,
    mode,
    installation: { id, owner },
    scope: { signal: activation.signal },
    contributions: {
      ...emptyPluginContributions(),
      panel: [{ id, fileSuffix, context: "workspace", title: id, icon: "Blocks", Component: () => null }],
    },
  } as unknown as PluginClientInstance;
}

function activePanels(...instances: PluginClientInstance[]) {
  return collectPluginContributions(
    { revision: 0, instances, errors: new Map(), backgroundSelection: null },
    "panel",
  );
}

const canvas = panel("canvas", ".canva.json", { owner: "desktop", hostId: "desktop" });

function resolve(path: string, panels = activePanels(canvas), workspaceRoot = "/work/checkout") {
  return resolvePluginFilePanel(panels, "remote", { path, workspaceRoot });
}

describe("workspace file editor resolution", () => {
  it("chooses the longest suffix on the right host and preserves the normalized path's case", () => {
    const otherHost = panel("a-other-host", ".canva.json", { hostId: "other" });
    const json = panel("b-json", ".json");
    expect(
      resolve("/work/checkout/canvases/Plan.CANVA.JSON", activePanels(otherHost, json, canvas)),
    ).toMatchObject({ contribution: { id: "canvas" }, filePath: "canvases/Plan.CANVA.JSON" });
  });

  it("uses an opted-in daemon panel on its own host", () => {
    const daemon = panel("daemon-canvas", ".canva.json");
    expect(resolve("canvases/Plan.canva.json", activePanels(daemon))?.instance).toBe(daemon);
    expect(
      resolvePluginFilePanel(activePanels(daemon), "other", {
        path: "canvases/Plan.canva.json",
        workspaceRoot: "/work/checkout",
      }),
    ).toBeNull();
  });

  it.each([
    ["canvases\\Plan.canva.json", "/work/checkout"],
    ["/canvases/Plan.canva.json", "/"],
    ["C:\\canvases\\Plan.canva.json", "c:\\"],
  ])("converts %s under %s to a checkout-relative path", (path, root) => {
    expect(resolve(path, activePanels(canvas), root)?.filePath).toBe("canvases/Plan.canva.json");
  });

  it.each([
    "canvases/ordinary.json",
    "canvases/Plan.canva.json.bak",
    "/work/checkout-other/canvases/Plan.canva.json",
    "canvases/../../Plan.canva.json",
    "~/canvases/Plan.canva.json",
  ])("keeps the default preview for %s", (path) => {
    expect(resolve(path)).toBeNull();
  });

  it("keeps the default preview without an active opted-in panel", () => {
    const panels = activePanels(
      panel("managed", ".canva.json", { mode: "manage" }),
      panel("disabled", ".canva.json", { aborted: true }),
      panel("regular"),
    );
    expect(resolve("canvases/Plan.canva.json", panels)).toBeNull();
  });
});
