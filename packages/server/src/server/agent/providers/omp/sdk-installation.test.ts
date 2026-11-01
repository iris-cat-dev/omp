import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOmpBackend, resolveOmpSdkInstallation } from "./sdk-installation.js";

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("node:module", () => ({ createRequire: () => ({ resolve: mocks.resolve }) }));
const roots: string[] = [];

beforeEach(() => {
  mocks.resolve.mockReset();
  mocks.resolve.mockImplementation(() => {
    throw Object.assign(new Error("not installed"), { code: "MODULE_NOT_FOUND" });
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeSdk() {
  const root = await mkdtemp(path.join(tmpdir(), "omp-sdk-installation-"));
  roots.push(root);
  await mkdir(path.join(root, "dist", "node"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@oh-my-pi/pi-coding-agent",
      version: "19.2.3",
    }),
  );
  for (const file of ["sdk.mjs", "rpc.mjs", "host.mjs", "plugins.mjs", "modules.json"]) {
    await writeFile(path.join(root, "dist", "node", file), "");
  }
  return root;
}

describe("OMP SDK runtime selection", () => {
  it("forces Desktop-managed configurations onto SDK without consulting the CLI", () => {
    expect(resolveOmpBackend({ ompBackend: "cli" }, { PASEO_DESKTOP_MANAGED: "1" })).toBe("sdk");
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("defaults an SDK-equipped remote installation to SDK, keeping explicit external CLI selection", () => {
    mocks.resolve.mockReturnValue("/installed/node_modules/@oh-my-pi/pi-coding-agent/package.json");
    expect(resolveOmpBackend(undefined, {})).toBe("sdk");
    expect(resolveOmpBackend({ ompBackend: "cli" }, {})).toBe("cli");
  });

  it("selects SDK for configured package roots while isolating the supplied environment", () => {
    vi.stubEnv("PASEO_DESKTOP_MANAGED", "1");
    vi.stubEnv("OMP_DESKTOP_SDK_ROOT", "/ambient/sdk");
    expect(resolveOmpBackend(undefined, {})).toBe("cli");
    expect(resolveOmpBackend(undefined, { OMP_DESKTOP_SDK_ROOT: "/selected/sdk" })).toBe("sdk");
    expect(resolveOmpBackend({ ompSdkPath: "/custom/sdk" }, {})).toBe("sdk");
    expect(resolveOmpBackend({ env: { OMP_DESKTOP_SDK_ROOT: "/provider/sdk" } }, {})).toBe("sdk");
  });

  it("preserves explicit SDK path precedence over provider and launch environments", async () => {
    const root = await makeSdk();
    expect(
      await resolveOmpSdkInstallation(
        {
          ompSdkPath: root,
          env: { OMP_DESKTOP_SDK_ROOT: "/provider/sdk" },
        },
        { OMP_DESKTOP_SDK_ROOT: "/launch/sdk" },
      ),
    ).toMatchObject({ root, version: "19.2.3" });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("does not substitute an installed SDK for a missing explicitly selected package", async () => {
    const root = await makeSdk();
    mocks.resolve.mockReturnValue(path.join(root, "package.json"));
    await expect(
      resolveOmpSdkInstallation({ ompSdkPath: path.join(root, "missing") }, {}),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("rejects missing Node artifacts without trying another runtime", async () => {
    const root = await makeSdk();
    await rm(path.join(root, "dist", "node", "host.mjs"));
    await expect(resolveOmpSdkInstallation({ ompSdkPath: root }, {})).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
