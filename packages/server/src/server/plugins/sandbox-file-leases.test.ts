import { beforeEach, describe, expect, it, vi } from "vitest";
import { openOmpSandboxFiles, type OmpSandboxFiles } from "../agent/providers/omp/sandbox-files.js";
import { SandboxFileLeases } from "./sandbox-file-leases.js";

vi.mock("../agent/providers/omp/sandbox-files.js", () => ({ openOmpSandboxFiles: vi.fn() }));

function filesystem() {
  return {
    read: vi.fn(() => Buffer.from("authorized bytes")),
    write: vi.fn(),
    list: vi.fn(),
    stat: vi.fn(),
    mkdir: vi.fn(),
    remove: vi.fn(),
    close: vi.fn(),
  } satisfies OmpSandboxFiles;
}

const opened = vi.mocked(openOmpSandboxFiles);
beforeEach(() => opened.mockReset());

describe("plugin sandbox file lease authorization", () => {
  it("rejects another installation or generation without releasing the owner's handle", async () => {
    const files = filesystem();
    opened.mockResolvedValue(files);
    const leases = new SandboxFileLeases(() => undefined);
    const { handle } = await leases.invoke("owner", 4, { action: "open", root: "/sandbox" }, () => true) as { handle: string };
    for (const [installation, generation] of [["other", 4], ["owner", 3]] as const) {
      await expect(leases.invoke(installation, generation, { action: "read", handle, path: "owned.txt" }, () => true)).rejects.toThrow(/not owned/);
      await expect(leases.invoke(installation, generation, { action: "close", handle }, () => true)).rejects.toThrow(/not owned/);
    }
    expect(files.read).not.toHaveBeenCalled();
    expect(files.close).not.toHaveBeenCalled();
    await leases.invoke("owner", 4, { action: "read", handle, path: "owned.txt" }, () => true);
    expect(files.read).toHaveBeenCalledOnce();
    leases.close();
  });

  it("closes a filesystem acquired after its installation was revoked", async () => {
    const files = filesystem();
    const pending = Promise.withResolvers<OmpSandboxFiles>();
    opened.mockReturnValue(pending.promise);
    const leases = new SandboxFileLeases(() => undefined);
    let current = true;
    const opening = leases.invoke("owner", 4, { action: "open", root: "/sandbox" }, () => current);
    current = false;
    leases.revoke("owner");
    pending.resolve(files);
    await expect(opening).rejects.toThrow(/no longer active/);
    expect(files.close).toHaveBeenCalledOnce();
    leases.close();
    expect(files.close).toHaveBeenCalledOnce();
  });

  it("revokes file operations immediately and prevents stale handles from crossing restart", async () => {
    const first = filesystem();
    const second = filesystem();
    opened.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const leases = new SandboxFileLeases(() => undefined);
    const initial = await leases.invoke("owner", 4, { action: "open", root: "/sandbox" }, () => true) as { handle: string };
    await expect(leases.invoke("owner", 4, { action: "read", handle: initial.handle, path: "owned.txt" }, () => false)).rejects.toThrow(/no longer active/);
    expect(first.read).not.toHaveBeenCalled();
    leases.revoke("owner");
    expect(first.close).toHaveBeenCalledOnce();
    const restarted = await leases.invoke("owner", 5, { action: "open", root: "/sandbox" }, () => true) as { handle: string };
    await expect(leases.invoke("owner", 5, { action: "read", handle: initial.handle, path: "owned.txt" }, () => true)).rejects.toThrow(/not owned/);
    leases.close();
    expect(second.close).toHaveBeenCalledOnce();
    await expect(leases.invoke("owner", 5, { action: "read", handle: restarted.handle, path: "owned.txt" }, () => true)).rejects.toThrow(/not owned/);
  });
});
