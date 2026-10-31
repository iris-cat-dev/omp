import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OMP_SDK_ROOT_ENV } from "./agent/providers/omp/sdk-host-protocol.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import {
  OmpPluginCliService,
  type OmpPluginRunner,
} from "./omp-plugin-cli-service.js";

async function createFixture() {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "omp-sdk-plugin-management-")),
  );
  const cwd = path.join(directory, "project with spaces");
  await fs.mkdir(cwd);
  async function sdk(name: string, pluginSource?: string) {
    const root = path.join(directory, name);
    await fs.mkdir(path.join(root, "dist/node"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "19.2.3" }),
    );
    for (const entry of ["sdk.mjs", "rpc.mjs", "host.mjs"]) {
      await fs.writeFile(
        path.join(root, "dist/node", entry),
        'throw new Error("Management must not load a model session");',
      );
    }
    await fs.writeFile(path.join(root, "dist/node/modules.json"), "{}");
    const state = path.join(root, "plugins.json");
    await fs.writeFile(
      state,
      JSON.stringify([{ name, version: "1.0.0", enabled: true }]),
    );
    await fs.writeFile(
      path.join(root, "dist/node/plugins.mjs"),
      pluginSource ??
        `
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    export async function runNodePluginCommand(args) {
      assert.equal(process.env.ELECTRON_RUN_AS_NODE, "1");
      assert.equal(process.env.${OMP_SDK_ROOT_ENV}, ${JSON.stringify(root)});
      assert.equal(process.env.OMP_PLUGIN_FIXTURE_TOKEN, "provider-token");
      assert.equal(process.env.HTTP_PROXY, process.env.OMP_PLUGIN_FIXTURE_PROXY);
      assert.equal(process.env.HTTPS_PROXY, process.env.OMP_PLUGIN_FIXTURE_PROXY);
      assert.equal(process.cwd(), ${JSON.stringify(cwd)});
      const file = ${JSON.stringify(state)};
      const plugins = JSON.parse(await readFile(file, "utf8"));
      if (args[1] === "list") {
        assert.deepEqual(args, ["plugin", "list", "--json"]);
        process.stdout.write(JSON.stringify({ npm: plugins, marketplace: [] }));
        return;
      }
      throw new Error("Unexpected fixture operation");
    }
    `,
    );
    return { root, state };
  }
  return {
    directory,
    cwd,
    sdk,
    dispose: () => fs.rm(directory, { recursive: true, force: true }),
  };
}

describe("SDK plugin management through the compiled Desktop host", () => {
  it("uses the live selected SDK and provider environment without resolving a CLI or opening a session", async () => {
    const fixture = await createFixture();
    try {
      const first = await fixture.sdk("first-sdk");
      const second = await fixture.sdk("second-sdk");
      let selected = first.root;
      let proxy = "http://127.0.0.1:18880";
      const resolveOmpCommand = vi.fn(async () => {
        throw new Error("CLI lookup forbidden");
      });
      const service = new OmpPluginCliService({
        logger: createTestLogger(),
        resolveOmpCommand,
        getProxyUrl: () => proxy,
        getProviderConfig: () => ({
          ompBackend: "sdk",
          ompSdkPath: selected,
          command: [
            "nonexistent-cli-must-not-run",
            "--profile",
            "ignored-cli-profile",
          ],
          env: {
            OMP_PLUGIN_FIXTURE_TOKEN: "provider-token",
            OMP_PLUGIN_FIXTURE_PROXY: proxy,
            HTTP_PROXY: "http://stale.invalid",
            OMP_DESKTOP_BUNDLED_PLUGINS: "",
            PATH: "",
            [OMP_SDK_ROOT_ENV]: first.root,
          },
        }),
      });
      const firstResult = await service.list(fixture.cwd);
      expect(firstResult.plugins[0]?.name, firstResult.rawOutput).toBe(
        "first-sdk",
      );
      selected = second.root;
      proxy = "http://127.0.0.1:18881";
      const secondResult = await service.list(fixture.cwd);
      expect(secondResult.plugins[0]?.name, secondResult.rawOutput).toBe(
        "second-sdk",
      );
      expect(resolveOmpCommand).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it.each(["missing package", "wrong package", "missing plugin artifact"])(
    "fails for %s without CLI fallback",
    async (failure) => {
      const fixture = await createFixture();
      try {
        const sdk = await fixture.sdk("selected-sdk");
        if (failure === "missing package")
          await fs.rm(path.join(sdk.root, "package.json"));
        if (failure === "wrong package")
          await fs.writeFile(
            path.join(sdk.root, "package.json"),
            JSON.stringify({ name: "wrong-package", version: "1.0.0" }),
          );
        if (failure === "missing plugin artifact")
          await fs.rm(path.join(sdk.root, "dist/node/plugins.mjs"));
        const resolveOmpCommand = vi.fn(
          async () => "available-cli-must-not-run",
        );
        const runner = vi.fn<OmpPluginRunner>();
        const service = new OmpPluginCliService({
          logger: createTestLogger(),
          runner,
          resolveOmpCommand,
          getProviderConfig: () => ({
            ompBackend: "sdk",
            ompSdkPath: sdk.root,
            env: { OMP_DESKTOP_BUNDLED_PLUGINS: "" },
          }),
        });
        expect(
          await service.install({ spec: "fixture-plugin", cwd: fixture.cwd }),
        ).toMatchObject({ ok: false, output: expect.any(String) });
        expect(runner).not.toHaveBeenCalled();
        expect(resolveOmpCommand).not.toHaveBeenCalled();
      } finally {
        await fixture.dispose();
      }
    },
  );

  it.each([
    {
      source: "export const notThePluginHost = true;",
      error: "does not export runNodePluginCommand",
    },
    {
      source:
        'export async function runNodePluginCommand() { process.stdout.write("plugin context\\n"); process.stderr.write("permission denied\\n"); throw new Error("selected SDK failure"); }',
      error: "selected SDK failure",
    },
  ])(
    "surfaces SDK host errors without falling back: $error",
    async ({ source, error }) => {
      const fixture = await createFixture();
      try {
        const sdk = await fixture.sdk("broken-sdk", source);
        const resolveOmpCommand = vi.fn(
          async () => "available-cli-must-not-run",
        );
        const service = new OmpPluginCliService({
          logger: createTestLogger(),
          resolveOmpCommand,
          getProviderConfig: () => ({
            ompBackend: "sdk",
            ompSdkPath: sdk.root,
            env: { OMP_DESKTOP_BUNDLED_PLUGINS: "" },
          }),
        });
        const result = await service.install({
          spec: "fixture-plugin",
          cwd: fixture.cwd,
        });
        expect(result.ok).toBe(false);
        expect(result.output).toContain(error);
        if (error === "selected SDK failure") {
          expect(result.output).toContain("plugin context");
          expect(result.output).toContain("permission denied");
        }
        expect(resolveOmpCommand).not.toHaveBeenCalled();
      } finally {
        await fixture.dispose();
      }
    },
  );

  it("rejects the legacy private plugin-bound distribution before SDK or CLI lookup", async () => {
    const resolveOmpCommand = vi.fn(async () => "available-cli-must-not-run");
    const runner = vi.fn<OmpPluginRunner>();
    const service = new OmpPluginCliService({
      logger: createTestLogger(),
      runner,
      resolveOmpCommand,
      getProviderConfig: () => ({
        ompBackend: "sdk",
        ompSdkPath: "/missing-sdk",
        env: { OMP_DESKTOP_BUNDLED_PLUGINS: "private" },
      }),
    });
    expect(await service.install({ spec: "fixture-plugin" })).toMatchObject({
      ok: false,
      output: expect.stringContaining("plugin-bound CLI distribution"),
    });
    expect(runner).not.toHaveBeenCalled();
    expect(resolveOmpCommand).not.toHaveBeenCalled();
  });
});
