import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BrowserWindow,
  IpcMainInvokeEvent,
  OpenDialogOptions,
  OpenDialogReturnValue,
} from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopSettingsStore } from "../settings/desktop-settings.js";
import { createWallpaperCommandHandler, registerWallpaperWindow } from "./commands.js";
import { validateWallpaperFile } from "./files.js";
import { WallpaperMediaRegistry } from "./media-registry.js";
import { createWallpaperMediaResponse } from "./media-response.js";
import { bindWallpaperProtocolDocument, getWallpaperMediaRequestOwner } from "./media-request-authorization.js";

const roots: string[] = [];
const binding = { installationId: "wallpaper", generation: 1 };
let nextContentsId = 0;
const labels = {
  title: "Add wallpapers",
  mediaLabel: "Images and videos",
  imageLabel: "Images",
  videoLabel: "Videos",
};
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function windowFixture(registry: WallpaperMediaRegistry) {
  const id = ++nextContentsId;
  const frameId = `15790216271289020${String(id).padStart(3, "0")}`;
  let navigation = 0;
  const contents = Object.assign(new EventEmitter(), { id, mainFrame: { nativeID: frameId, navigationToken: "" }, isDestroyed: () => false });
  const window = Object.assign(new EventEmitter(), { webContents: contents });
  const event = {
    sender: contents,
    senderFrame: contents.mainFrame,
  } as unknown as IpcMainInvokeEvent;
  const commit = (isMainFrame = true, url = "omp-desktop://app/", canonical = true) => {
    if (isMainFrame) {
      contents.emit("did-start-navigation", {}, url, false, true);
      const navigationToken = `document-${id}-${++navigation}`;
      if (canonical) bindWallpaperProtocolDocument({ contentsId: id, frameId, isMainFrame: true, isDocument: true,
        navigationToken }, registry, [window as unknown as BrowserWindow]);
      contents.mainFrame.navigationToken = navigationToken;
    }
    contents.emit("did-frame-navigate", {}, url, 200, "OK", isMainFrame);
  };
  return { contents, window: window as unknown as BrowserWindow, event, commit };
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "omp-wallpaper-command-"));
  roots.push(root);
  const registry = new WallpaperMediaRegistry();
  const store = createDesktopSettingsStore({
    userDataPath: root,
    onWallpaperLibraryCommitted: (library) => registry.updateLibrary(library),
  });
  await store.getWallpaperLibrary();
  const first = windowFixture(registry);
  const second = windowFixture(registry);
  registerWallpaperWindow(first.window, registry);
  registerWallpaperWindow(second.window, registry);
  first.commit();
  second.commit();
  const showOpenDialog = vi.fn(
    async (
      _window: BrowserWindow,
      _options: OpenDialogOptions,
    ): Promise<OpenDialogReturnValue> => ({ canceled: true, filePaths: [] }),
  );
  const dependencies = {
    registry,
    store,
    getMainWindows: () => [first.window, second.window],
    showOpenDialog,
    authorize: vi.fn((_event: IpcMainInvokeEvent, installationId: string, generation: number, _purpose: "manage" | "background" | "active", _capability?: string) => {
      if (installationId !== binding.installationId || generation !== binding.generation) throw new Error("Installation generation revoked.");
      return { installationId, generation, documentEpoch: 1, webContentsId: 1 };
    }),
  };
  return {
    root,
    registry,
    store,
    first,
    second,
    showOpenDialog,
    dependencies,
    handle: createWallpaperCommandHandler(dependencies),
  };
}
async function mediaFile(root: string, name: string) {
  const filePath = path.join(root, "media", name);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `source:${name}`);
  return filePath;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("wallpaper native commands", () => {
  it("requires the registered sender's real main frame and current epoch without creating owners from getContext", async () => {
    const { handle, first, second, registry, showOpenDialog, store } = await fixture();
    const firstOwner = registry.getOwner(first.contents)!;
    const secondOwner = registry.getOwner(second.contents)!;
    const foreign = windowFixture(registry);
    expect(await handle(foreign.event, "getContext", { ...binding,  })).toMatchObject({
      ok: false,
      code: "invalid-request",
    });
    expect(registry.getOwner(foreign.contents)).toBeNull();
    const child = { sender: first.contents, senderFrame: {} } as unknown as IpcMainInvokeEvent;
    expect(await handle(child, "getContext", { ...binding,  })).toMatchObject({
      ok: false,
      code: "invalid-request",
    });
    expect(
      await handle(first.event, "addCandidates", { ...binding, ...labels, epoch: secondOwner.epoch }),
    ).toMatchObject({ ok: false, code: "stale-document" });
    expect(
      await handle(first.event, "removeCandidates", { ...binding, epoch: firstOwner.epoch,
      candidateIds: ["not-a-uuid"], }),
    ).toMatchObject({ ok: false, code: "invalid-request" });
    expect(
      await handle(first.event, "getLibrary", { ...binding, epoch: firstOwner.epoch,
      ownerId: "another-window", }),
    ).toMatchObject({ ok: false, code: "invalid-request" });
    registry.disposeOwner(firstOwner);
    expect(await handle(first.event, "getContext", { ...binding,  })).toMatchObject({
      ok: false,
      code: "stale-document",
    });
    expect(registry.getOwner(first.contents)).toBeNull();
    expect(showOpenDialog).not.toHaveBeenCalled();
    expect((await store.getWallpaperLibrary()).items).toEqual([]);
  });

  it("reports missing native identity instead of advertising media readiness while keeping the library available", async () => {
    const { handle, first, registry } = await fixture();
    first.contents.emit("did-start-navigation", {}, "omp-desktop://app/", false, true);
    first.contents.mainFrame.navigationToken = "";
    first.contents.emit("did-frame-navigate", {}, "omp-desktop://app/", 200, "OK", true);
    const owner = registry.getOwner(first.contents)!;
    expect(owner.nativeIdentity).toBeNull();
    expect(await handle(first.event, "getContext", binding)).toMatchObject({ ok: false, code: "unsupported" });
    expect(await handle(first.event, "setPreviews", { ...binding, epoch: owner.epoch, revision: 0, candidateIds: [] })).toMatchObject({ ok: false, code: "unsupported" });
    expect(await handle(first.event, "getLibrary", { ...binding, epoch: owner.epoch })).toMatchObject({ ok: true });
    expect((await createWallpaperMediaResponse(new Request("omp-desktop://app/wallpaper-media"), registry, owner, null)).status).toBe(501);
  });

  it("binds HTTP development documents from committed native frame metadata and authorizes their media", async () => {
    const { root, handle, first, second, registry, store } = await fixture();
    first.commit(true, "http://localhost:8081/", false);
    const owner = registry.getOwner(first.contents)!;
    expect(owner.nativeIdentity).toEqual({ contentsId: first.contents.id, frameId: first.contents.mainFrame.nativeID,
      isMainFrame: true, isDocument: true, navigationToken: first.contents.mainFrame.navigationToken });
    expect(await handle(first.event, "getContext", binding)).toEqual({ ok: true, data: { epoch: owner.epoch } });
    const { added } = await store.addWallpaperCandidates([await validateWallpaperFile(await mediaFile(root, "development.png"))]);
    const held = await handle(first.event, "setBackground", { ...binding, epoch: owner.epoch, revision: 0, candidateId: added[0].candidateId });
    if (!held.ok || !held.data.media) throw new Error("Media must be acquired.");
    const identity = { ...owner.nativeIdentity!, isDocument: false };
    const authorized = getWallpaperMediaRequestOwner(identity, registry, [first.window, second.window]);
    expect(authorized).toBe(owner);
    expect(await (await createWallpaperMediaResponse(new Request(held.data.media.uri), registry, authorized, null)).text()).toBe("source:development.png");
    first.contents.emit("did-frame-navigate", {}, "http://localhost:8081/", 200, "OK", true);
    expect(registry.getOwner(first.contents)).toBe(owner);
  });

  it("does not disclose a pending canonical owner's epoch to the old committed frame or overwrite it on stale commit", async () => {
    const { handle, first, registry } = await fixture();
    const oldFrame = first.contents.mainFrame;
    first.contents.emit("did-start-navigation", {}, "omp-desktop://app/replacement", false, true);
    const pending = bindWallpaperProtocolDocument({ contentsId: first.contents.id, frameId: oldFrame.nativeID,
      isMainFrame: true, isDocument: true, navigationToken: "pending-native-document" }, registry, [first.window])!;
    expect(await handle(first.event, "getContext", binding)).toMatchObject({ ok: false, code: "stale-document" });
    expect(await handle(first.event, "getLibrary", { ...binding, epoch: pending.epoch })).toMatchObject({ ok: false, code: "stale-document" });
    first.contents.emit("did-frame-navigate", {}, "omp-desktop://app/old", 200, "OK", true);
    expect(registry.getOwner(first.contents)).toBe(pending);
    expect(await handle(first.event, "getContext", binding)).toMatchObject({ ok: false, code: "stale-document" });
    Object.assign(oldFrame, { detached: true });
    first.contents.mainFrame = { nativeID: oldFrame.nativeID, navigationToken: "pending-native-document" };
    first.contents.emit("did-frame-navigate", {}, "omp-desktop://app/replacement", 200, "OK", true);
    expect(registry.getOwner(first.contents)).toBe(pending);
    const committedEvent = { sender: first.contents, senderFrame: first.contents.mainFrame } as unknown as IpcMainInvokeEvent;
    expect(await handle(committedEvent, "getContext", binding)).toEqual({ ok: true, data: { epoch: pending.epoch } });
    expect(await handle(first.event, "getContext", binding)).toMatchObject({ ok: false, code: "invalid-request" });
  });

  it("appends mixed valid files in native order despite reversed validation, reports partial failures and never selects a background", async () => {
    const { root, first, registry, store, showOpenDialog, dependencies } = await fixture();
    const image = await mediaFile(root, "first/同名 image.png");
    const video = await mediaFile(root, "movie.webm");
    const sameName = await mediaFile(root, "second/同名 image.png");
    const unsupported = await mediaFile(root, "active.svg");
    const directory = path.join(root, "directory.jpg");
    await mkdir(directory);
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [image, unsupported, directory, video, image, sameName],
    });
    const firstStarted = deferred<void>();
    const videoDone = deferred<void>();
    const unblock = deferred<void>();
    const handle = createWallpaperCommandHandler({
      ...dependencies,
      validateFile: async (filePath) => {
        const file = await validateWallpaperFile(filePath);
        if (filePath === image) {
          firstStarted.resolve();
          await unblock.promise;
        }
        if (filePath === video) videoDone.resolve();
        return file;
      },
    });
    const owner = registry.getOwner(first.contents)!;
    const pending = handle(first.event, "addCandidates", { ...binding, ...labels, epoch: owner.epoch });
    await firstStarted.promise;
    await videoDone.promise;
    unblock.resolve();
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.cancelled).toBe(false);
    expect(result.data.added.map((item) => item.path)).toEqual(
      await Promise.all(
        [image, video, sameName].map(
          async (filePath) => (await validateWallpaperFile(filePath)).path,
        ),
      ),
    );
    expect(result.data.duplicates.map((item) => item.candidateId)).toEqual([
      result.data.added[0].candidateId,
    ]);
    expect(result.data.rejected.map((item) => [item.path, item.code])).toEqual([
      [unsupported, "unsupported"],
      [directory, "invalid-file"],
    ]);
    expect(owner.installations.size).toBe(0);
    const [dialogWindow, options] = showOpenDialog.mock.calls[0];
    expect(dialogWindow).toBe(first.window);
    expect(options.properties).toEqual(["openFile", "multiSelections"]);
    expect(options.filters?.[0].extensions).toEqual(
      expect.arrayContaining(["png", "jpg", "mp4", "webm"]),
    );
    expect((await store.getWallpaperLibrary()).items).toEqual(result.data.added);
    expect(await readFile(image, "utf8")).toBe("source:first/同名 image.png");
    expect((await store.get()).notifications.playSound).toBe(true);
  });

  it("allows one picker per owner, treats cancellation as unchanged, and keeps accepted additions after document close", async () => {
    const { root, first, second, registry, store, showOpenDialog, dependencies } = await fixture();
    const selection = deferred<OpenDialogReturnValue>();
    showOpenDialog.mockImplementationOnce(() => selection.promise);
    const handle = createWallpaperCommandHandler(dependencies);
    const owner = registry.getOwner(first.contents)!;
    const pending = handle(first.event, "addCandidates", { ...binding, ...labels, epoch: owner.epoch });
    expect(
      await handle(first.event, "addCandidates", { ...binding, ...labels, epoch: owner.epoch }),
    ).toMatchObject({ ok: false, code: "busy" });
    const other = registry.getOwner(second.contents)!;
    expect(
      await handle(second.event, "addCandidates", { ...binding, ...labels, epoch: other.epoch }),
    ).toMatchObject({ ok: true, data: { cancelled: true } });
    selection.resolve({ canceled: true, filePaths: [] });
    expect(await pending).toMatchObject({
      ok: true,
      data: { cancelled: true, added: [], rejected: [] },
    });
    expect((await store.getWallpaperLibrary()).revision).toBe(0);
    const filePath = await mediaFile(root, "accepted.mp4");
    const started = deferred<void>();
    const unblock = deferred<void>();
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] });
    const acceptedHandle = createWallpaperCommandHandler({
      ...dependencies,
      validateFile: async (requestedPath) => {
        const file = await validateWallpaperFile(requestedPath);
        started.resolve();
        await unblock.promise;
        return file;
      },
    });
    const accepted = acceptedHandle(first.event, "addCandidates", { ...binding, ...labels,
    epoch: owner.epoch, });
    await started.promise;
    first.commit();
    first.window.emit("closed");
    unblock.resolve();
    const result = await accepted;
    expect(result).toMatchObject({ ok: true, data: { cancelled: false } });
    expect((await store.getWallpaperLibrary()).items.map((item) => item.name)).toEqual([
      "accepted.mp4",
    ]);
    expect(registry.getOwner(first.contents)).toBeNull();
  });

  it("rejects a picker confirmation belonging to a replaced document and reports dialog failures distinctly", async () => {
    const { root, first, registry, store, showOpenDialog, handle } = await fixture();
    const filePath = await mediaFile(root, "late.png");
    const selection = deferred<OpenDialogReturnValue>();
    showOpenDialog.mockImplementationOnce(() => selection.promise);
    const epoch = registry.getOwner(first.contents)!.epoch;
    const pending = handle(first.event, "addCandidates", { ...binding, ...labels, epoch });
    first.commit();
    selection.resolve({ canceled: false, filePaths: [filePath] });
    expect(await pending).toMatchObject({ ok: false, code: "stale-document" });
    expect((await store.getWallpaperLibrary()).items).toEqual([]);
    showOpenDialog.mockRejectedValueOnce(new Error("native picker failed"));
    expect(
      await handle(first.event, "addCandidates", { ...binding, ...labels,
      epoch: registry.getOwner(first.contents)!.epoch, }),
    ).toMatchObject({ ok: false, code: "dialog-error" });
  });

  it("reports storage failure without replacing committed candidates or touching source media", async () => {
    const { root, first, registry, store, showOpenDialog, handle } = await fixture();
    const saved = await validateWallpaperFile(await mediaFile(root, "saved.png"));
    const initial = await store.addWallpaperCandidates([saved]);
    const freshPath = await mediaFile(root, "not-committed.mp4");
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [freshPath] });
    const settingsPath = path.join(root, "desktop-settings.json");
    await rename(settingsPath, `${settingsPath}.saved`);
    await mkdir(settingsPath);
    const result = await handle(first.event, "addCandidates", { ...binding, ...labels,
    epoch: registry.getOwner(first.contents)!.epoch, });
    expect(result).toMatchObject({ ok: false, code: "storage-error" });
    expect(await store.getWallpaperLibrary()).toEqual(initial.library);
    expect(await readFile(freshPath, "utf8")).toBe("source:not-committed.mp4");
    await rm(settingsPath, { recursive: true });
    await rename(`${settingsPath}.saved`, settingsPath);
  });

  it("revokes media at persistent removal before throwing listeners run, preserves other windows, and never deletes source files", async () => {
    const { root, first, second, registry, store, showOpenDialog, handle } = await fixture();
    const firstPath = await mediaFile(root, "one.png");
    const secondPath = await mediaFile(root, "two.mp4");
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [firstPath, secondPath] });
    const firstOwner = registry.getOwner(first.contents)!;
    const secondOwner = registry.getOwner(second.contents)!;
    const added = await handle(first.event, "addCandidates", { ...binding, ...labels,
    epoch: firstOwner.epoch, });
    if (!added.ok) throw new Error(added.message);
    const [one, two] = added.data.added;
    const background = await handle(first.event, "setBackground", { ...binding, epoch: firstOwner.epoch,
    revision: 0,
    candidateId: one.candidateId, });
    const other = await handle(second.event, "setBackground", { ...binding, epoch: secondOwner.epoch,
    revision: 0,
    candidateId: two.candidateId, });
    if (!background.ok || !background.data.media || !other.ok || !other.data.media)
      throw new Error("Media must be acquired.");
    const oneId = background.data.media.id;
    let revokedBeforeNotification = false;
    store.subscribeWallpaperLibrary(() => {
      revokedBeforeNotification = registry.get(oneId, background.data.media!.scope) === null;
      throw new Error("renderer notification failed");
    });
    const removed = await handle(first.event, "removeCandidates", { ...binding, epoch: firstOwner.epoch,
    candidateIds: [one.candidateId], });
    expect(removed).toMatchObject({
      ok: true,
      data: { removedCandidateIds: [one.candidateId], library: { items: [two] } },
    });
    expect(revokedBeforeNotification).toBe(true);
    const unavailable = await createWallpaperMediaResponse(
      new Request(background.data.media.uri),
      registry,
      firstOwner,
      null,
    );
    expect(unavailable.status).toBe(404);
    const preserved = await createWallpaperMediaResponse(
      new Request(other.data.media.uri),
      registry,
      secondOwner,
      null,
    );
    expect(await preserved.text()).toBe("source:two.mp4");
    expect(await readFile(firstPath, "utf8")).toBe("source:one.png");
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [firstPath] });
    const readded = await handle(first.event, "addCandidates", { ...binding, ...labels,
    epoch: firstOwner.epoch, });
    if (!readded.ok) throw new Error(readded.message);
    expect(readded.data.added[0].candidateId).not.toBe(one.candidateId);
    expect(
      await handle(first.event, "setBackground", { ...binding, epoch: firstOwner.epoch,
      revision: 1,
      candidateId: one.candidateId, }),
    ).toMatchObject({ ok: false, code: "not-found" });
  });

  it("preserves same-document and subframe holds, revokes at full navigation start, and does not overwrite the bound native owner on commit", async () => {
    const { root, first, registry, store, handle } = await fixture();
    const file = await validateWallpaperFile(await mediaFile(root, "background.png"));
    const { added } = await store.addWallpaperCandidates([file]);
    const owner = registry.getOwner(first.contents)!;
    const result = await handle(first.event, "setBackground", { ...binding, epoch: owner.epoch,
    revision: 0,
    candidateId: added[0].candidateId, });
    if (!result.ok || !result.data.media) throw new Error("Media must be acquired.");
    const id = result.data.media.id;
    first.contents.emit("did-navigate-in-page", {}, "omp-desktop://app/#settings", true);
    first.contents.emit("did-start-navigation", {}, "omp-desktop://app/#settings", true, true);
    first.contents.emit("did-start-navigation", {}, "https://subframe.invalid/", false, false);
    first.commit(false);
    expect(registry.getOwner(first.contents)).toBe(owner);
    const retained = await createWallpaperMediaResponse(
      new Request(result.data.media.uri),
      registry,
      owner,
      null,
    );
    expect(await retained.text()).toBe("source:background.png");
    first.contents.emit("did-start-navigation", {}, "https://cancelled.invalid", false, true);
    first.contents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://cancelled.invalid", true);
    expect(registry.getOwner(first.contents)).toBeNull();
    expect((await createWallpaperMediaResponse(new Request(result.data.media.uri), registry, owner, null)).status).toBe(404);
    first.commit();
    expect(registry.get(id, result.data.media.scope)).toBeNull();
    expect(
      await handle(first.event, "setBackground", { ...binding, epoch: owner.epoch,
      revision: 1,
      candidateId: added[0].candidateId, }),
    ).toMatchObject({ ok: false, code: "stale-document" });
    const next = registry.getOwner(first.contents)!;
    const acquired = await handle(first.event, "setBackground", { ...binding, epoch: next.epoch,
    revision: 0,
    candidateId: added[0].candidateId, });
    if (!acquired.ok || !acquired.data.media) throw new Error("Media must be acquired.");
    first.contents.emit("render-process-gone", {}, { reason: "crashed" });
    first.contents.emit("destroyed");
    first.window.emit("closed");
    expect(registry.getOwner(first.contents)).toBeNull();
    expect(registry.get(acquired.data.media.id, acquired.data.media.scope)).toBeNull();
  });

  it("rejects wrong installation and generation while allowing disabled management but denying background", async () => {
    const { first, registry, dependencies } = await fixture();
    const epoch = registry.getOwner(first.contents)!.epoch;
    dependencies.authorize.mockImplementation((_event, installationId, generation, purpose) => {
      if (installationId !== binding.installationId || generation !== binding.generation || purpose === "background") {
        throw new Error("Wallpaper activation was revoked.");
      }
      return { installationId, generation, documentEpoch: 1, webContentsId: 1 };
    });
    const handle = createWallpaperCommandHandler(dependencies);
    expect(await handle(first.event, "getLibrary", { ...binding, epoch })).toMatchObject({ ok: true });
    expect(await handle(first.event, "setBackground", { ...binding, epoch, revision: 0,
      candidateId: "0199ef80-5ff5-7000-8000-000000000001" })).toMatchObject({ ok: false, code: "unauthorized" });
    expect(await handle(first.event, "getContext", { ...binding, installationId: "another-plugin" })).toMatchObject({ ok: false, code: "unauthorized" });
    expect(await handle(first.event, "getContext", { ...binding, generation: 0 })).toMatchObject({ ok: false, code: "unauthorized" });
  });
});
