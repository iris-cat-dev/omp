import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "./node-entrypoint-runner";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn((_file: unknown) => false),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  existsSync: mocks.existsSync,
}));

vi.mock("../packaged-distribution.js", () => ({
  readPackagedDesktopDistribution: () => ({
    identity: "public",
    privatePlugins: false,
    bundledOmpPath: null,
    bundledPluginsPath: null,
  }),
}));

declare global {
  // eslint-disable-next-line no-var
  var __PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__:
    | {
        argv: string[];
        electronRunAsNode: string | undefined;
        electronNoAttachConsole: string | undefined;
        sdkRoot?: string;
      }
    | undefined;
}

describe("node-entrypoint-runner", () => {
  it("preserves Electron node-mode env before loading the target entrypoint", async () => {
    const originalArgv = process.argv;
    const originalRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    const originalNoAttachConsole = process.env.ELECTRON_NO_ATTACH_CONSOLE;
    const originalFixture = globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__;
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "paseo-node-entrypoint-runner-"));
    const fixturePath = path.join(fixtureDir, "fixture.mjs");
    writeFileSync(
      fixturePath,
      `
globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__ = {
  argv: process.argv,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
  electronNoAttachConsole: process.env.ELECTRON_NO_ATTACH_CONSOLE,
};
`,
    );

    process.argv = ["Paseo", "runner", "node-script", fixturePath, "daemon", "start"];
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
    delete globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__;

    try {
      await main();

      expect(globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__).toEqual({
        argv: ["Paseo", fixturePath, "daemon", "start"],
        electronRunAsNode: "1",
        electronNoAttachConsole: "1",
      });
    } finally {
      process.argv = originalArgv;
      if (originalRunAsNode === undefined) {
        delete process.env.ELECTRON_RUN_AS_NODE;
      } else {
        process.env.ELECTRON_RUN_AS_NODE = originalRunAsNode;
      }
      if (originalNoAttachConsole === undefined) {
        delete process.env.ELECTRON_NO_ATTACH_CONSOLE;
      } else {
        process.env.ELECTRON_NO_ATTACH_CONSOLE = originalNoAttachConsole;
      }
      globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__ = originalFixture;
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
  it.each([true, false])(
    "sets a packaged SDK root only when staged (staged=%s)",
    async (staged) => {
      const originalArgv = process.argv;
      const originalFixture = globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__;
      const fixtureDir = mkdtempSync(path.join(tmpdir(), "omp-sdk-entrypoint-"));
      const fixturePath = path.join(fixtureDir, "fixture.mjs");
      writeFileSync(
        fixturePath,
        `
globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__ = {
  argv: process.argv,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
  electronNoAttachConsole: process.env.ELECTRON_NO_ATTACH_CONSOLE,
  sdkRoot: process.env.OMP_DESKTOP_SDK_ROOT,
};
`,
      );
      mocks.existsSync.mockReset();
      mocks.existsSync.mockReturnValue(staged);
      vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
      vi.stubEnv("PASEO_DESKTOP_MANAGED", "1");
      vi.stubEnv("PASEO_DESKTOP_DISTRIBUTION_IDENTITY", "");
      vi.stubEnv("OMP_DESKTOP_BUNDLED_PLUGINS", "");
      vi.stubEnv("OMP_DESKTOP_SDK_ROOT", "/inherited/sdk");
      process.argv = ["OMP Desktop", "runner", "node-script", fixturePath];
      try {
        await main();
        const manifestPath = String(mocks.existsSync.mock.calls[0]?.[0]);
        expect(manifestPath).toMatch(/[\\/]omp-sdk[\\/]manifest\.json$/u);
        expect(globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__?.sdkRoot).toBe(
          staged
            ? path.resolve(
                path.dirname(manifestPath),
                "node_modules",
                "@oh-my-pi",
                "pi-coding-agent",
              )
            : undefined,
        );
      } finally {
        vi.unstubAllEnvs();
        mocks.existsSync.mockReset();
        process.argv = originalArgv;
        globalThis.__PASEO_NODE_ENTRYPOINT_RUNNER_FIXTURE__ = originalFixture;
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
  );
});
