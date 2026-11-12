import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WallpaperLibrary, WallpaperMediaDescriptor } from "@omp-desktop/protocol/desktop-wallpaper";
import { validateWallpaperFile } from "./files.js";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import { wallpaperMediaRegistry as registry } from "./media-registry.js";

const bridge = vi.hoisted(() => ({
  userDataPath: "",
  windows: [] as Array<{
    webContents: { send: (channel: string, library: WallpaperLibrary) => void };
  }>,
}));
vi.mock("electron", () => ({ app: { getPath: () => bridge.userDataPath } }));
vi.mock("../window/main-windows.js", () => ({ getMainWindows: () => bridge.windows }));

afterEach(async () => {
  bridge.windows = [];
  if (bridge.userDataPath) await rm(bridge.userDataPath, { recursive: true, force: true });
});

describe("independent wallpaper library event integration", () => {
  it("publishes through the real host-event channel without pets and isolates failed window delivery after synchronous revocation", async () => {
    bridge.userDataPath = await mkdtemp(path.join(tmpdir(), "omp-wallpaper-events-"));
    const store = getDesktopSettingsStore();
    await store.getWallpaperLibrary();
    const filePath = path.join(bridge.userDataPath, "background.png");
    await writeFile(filePath, "wallpaper source");
    const received: Array<{ channel: string; library: WallpaperLibrary }> = [];
    let held: WallpaperMediaDescriptor | null = null;
    let revokedAtSend = false;
    bridge.windows = [
      {
        webContents: {
          send: () => {
            throw new Error("renderer closed");
          },
        },
      },
      {
        webContents: {
          send: (channel, library) => {
            if (held) revokedAtSend = registry.get(held.id, held.scope) === null;
            received.push({ channel, library });
          },
        },
      },
    ];
    const added = await store.addWallpaperCandidates([await validateWallpaperFile(filePath)]);
    expect(received).toEqual([
      { channel: "paseo:event:paseo:wallpaper:libraryChanged", library: added.library },
    ]);
    const owner = registry.activateOwner({});
    held = (await registry.setBackground(owner, owner.epoch, 0, added.added[0].candidateId,
      { installationId: "wallpaper", generation: 1 })).media!;
    await store.patch({ notifications: { playSound: false } });
    expect(received).toHaveLength(1);
    const removed = await store.removeWallpaperCandidates([added.added[0].candidateId]);
    expect(revokedAtSend).toBe(true);
    expect(received[1]).toEqual({
      channel: "paseo:event:paseo:wallpaper:libraryChanged",
      library: removed.library,
    });
    expect(registry.get(held.id, held.scope)).toBeNull();
    expect((await store.getWallpaperLibrary()).items).toEqual([]);
    registry.disposeOwner(owner);
  });
});
