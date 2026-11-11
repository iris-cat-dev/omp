import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import { validateWallpaperFile } from "./files.js";
import { WallpaperMediaRegistry, type NativeProtocolRequestIdentity } from "./media-registry.js";
import { bindWallpaperProtocolDocument, getNativeProtocolRequestIdentity, getWallpaperMediaRequestOwner } from "./media-request-authorization.js";
import { createWallpaperMediaResponse } from "./media-response.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function nativeRequest(url: string, nativeRequest: NativeProtocolRequestIdentity, init?: RequestInit): Request {
  const request = new Request(url, init);
  Object.defineProperty(request, "nativeRequest", { value: Object.freeze({ ...nativeRequest }) });
  return request;
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "omp-wallpaper-frame-")); roots.push(root);
  const mediaPath = path.join(root, "background.png"); await writeFile(mediaPath, "wallpaper");
  const candidate = { candidateId: randomUUID(), ...await validateWallpaperFile(mediaPath) };
  const registry = new WallpaperMediaRegistry(); registry.updateLibrary({ version: 1, revision: 1, items: [candidate] });
  const identities = ["15790216271289020344", "8650365625451015380"].map((frameId, index) => ({
    contentsId: index + 1, frameId, isMainFrame: true, isDocument: true, navigationToken: `document-${index + 1}`,
  }));
  const windows = identities.map(identity => ({ webContents: { id: identity.contentsId,
    mainFrame: { nativeID: identity.frameId, navigationToken: identity.navigationToken }, isDestroyed: () => false } }) as unknown as BrowserWindow);
  const documentRequest = nativeRequest("omp-desktop://app/", identities[0]);
  const first = bindWallpaperProtocolDocument(getNativeProtocolRequestIdentity(documentRequest), registry, windows)!;
  const second = bindWallpaperProtocolDocument(identities[1], registry, windows)!;
  const binding = { installationId: "wallpaper", generation: 1 };
  const media = (await registry.setBackground(first, first.epoch, 0, candidate.candidateId, binding)).media!;
  const identity = { ...identities[0], isDocument: false };
  const response = (request: Request) => createWallpaperMediaResponse(request, registry,
    getWallpaperMediaRequestOwner(getNativeProtocolRequestIdentity(request), registry, windows), null);
  return { registry, windows, identities, first, second, binding, media, identity, response };
}

describe("canonical wallpaper requesting-document authorization", () => {
  it("binds once to the real native main document and preserves its full 64-bit frame identity", async () => {
    const f = await fixture();
    expect(f.first.nativeIdentity).toEqual(f.identities[0]);
    expect(Object.isFrozen(f.first.nativeIdentity)).toBe(true);
    expect(bindWallpaperProtocolDocument(f.identities[0], f.registry, f.windows)).toBe(f.first);
    expect(bindWallpaperProtocolDocument({ ...f.identities[0], frameId: "15790216271289020345" }, f.registry, f.windows)).toBeNull();
    expect(bindWallpaperProtocolDocument({ ...f.identities[0], isMainFrame: false }, f.registry, f.windows)).toBeNull();
    expect(bindWallpaperProtocolDocument(f.identity, f.registry, f.windows)).toBeNull();
    expect(f.registry.getOwner(f.windows[0].webContents)).toBe(f.first);
  });
  it("requires the requesting frame's committed token even after a new canonical document has bound", async () => {
    const f = await fixture();
    const identity = { ...f.identities[0], navigationToken: "new-native-document" };
    const pending = bindWallpaperProtocolDocument(identity, f.registry, f.windows)!;
    const requestIdentity = { ...identity, isDocument: false };
    expect(getWallpaperMediaRequestOwner(requestIdentity, f.registry, f.windows)).toBeNull();
    expect(getWallpaperMediaRequestOwner(f.identity, f.registry, f.windows)).toBeNull();
    Object.assign(f.windows[0].webContents.mainFrame, { navigationToken: identity.navigationToken });
    expect(getWallpaperMediaRequestOwner(requestIdentity, f.registry, f.windows)).toBe(pending);
  });
  it("accepts Range only for the requesting owner and denies another window copying the entire URL", async () => {
    const f = await fixture();
    const accepted = await f.response(nativeRequest(f.media.uri, f.identity, { headers: { range: "bytes=1-4" } }));
    expect(accepted.status).toBe(206); expect(await accepted.text()).toBe("allp");
    const copied = nativeRequest(f.media.uri, { ...f.identities[1], isDocument: false });
    expect((await f.response(copied)).status).toBe(404);
    expect((await createWallpaperMediaResponse(copied, f.registry, f.second, null)).status).toBe(404);
    expect((await createWallpaperMediaResponse(new Request(f.media.uri), f.registry, null, null)).status).toBe(404);
  });
  it.each([
    { contentsId: 999 }, { frameId: "15790216271289020345" }, { navigationToken: "old-document" },
    { isMainFrame: false }, { isDocument: true },
  ])("denies a mismatched native field %j", async mismatch => {
    const f = await fixture();
    expect((await f.response(nativeRequest(f.media.uri, { ...f.identity, ...mismatch }))).status).toBe(404);
  });
  it("does not manufacture identity from URLs, headers, origin, referrer or renderer payloads", async () => {
    const f = await fixture();
    const forged = new Request(`${f.media.uri}&contentsId=1&frameId=${f.identity.frameId}&navigationToken=${f.identity.navigationToken}`, {
      headers: { "x-contents-id": "1", "x-frame-id": f.identity.frameId, "x-navigation-token": f.identity.navigationToken,
        origin: "omp-desktop://app", referer: "omp-desktop://app/" },
    });
    expect(getNativeProtocolRequestIdentity(forged)).toBeNull();
    expect((await f.response(forged)).status).toBe(404);
    for (const bad of [{ frameId: 15790216271289020344 }, { navigationToken: "" }, { contentsId: 0 }]) {
      const request = nativeRequest(f.media.uri, { ...f.identity, ...bad } as NativeProtocolRequestIdentity);
      expect(getNativeProtocolRequestIdentity(request)).toBeNull();
    }
  });
  it("rejects released generations and old documents rather than caching URL permission", async () => {
    const f = await fixture();
    f.registry.revokeInstallation(f.binding.installationId, f.binding.generation);
    expect((await f.response(nativeRequest(f.media.uri, f.identity))).status).toBe(404);
    const next = bindWallpaperProtocolDocument({ ...f.identities[0], navigationToken: "replacement-document" }, f.registry, f.windows)!;
    expect(next).not.toBe(f.first);
    expect(getWallpaperMediaRequestOwner(f.identity, f.registry, f.windows)).toBeNull();
    expect((await createWallpaperMediaResponse(new Request(f.media.uri), f.registry, f.first, null)).status).toBe(404);
  });
  it("rejects media navigation and authorizes encoded routes by the native document rather than spelling", async () => {
    const f = await fixture();
    expect((await f.response(nativeRequest(f.media.uri, f.identities[0]))).status).toBe(404);
    const encoded = await f.response(nativeRequest(f.media.uri.replace("/wallpaper-media", "/%77allpaper-media"), f.identity));
    expect(encoded.status).toBe(200); expect(await encoded.text()).toBe("wallpaper");
  });
});
