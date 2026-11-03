import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

import { loadConfig, resolveBundledWebUiDistDir } from "./config.js";
import { mergeRuntimeSettings, toRuntimeSettings } from "./agent/provider-launch-config.js";

const roots: string[] = [];

describe("server config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("records when the daemon is managed by Paseo Desktop", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-desktop-managed-"));
    roots.push(paseoHome);

    const desktopConfig = loadConfig(paseoHome, {
      env: { PASEO_DESKTOP_MANAGED: "1" },
    });
    const standaloneConfig = loadConfig(paseoHome, { env: {} });

    expect(desktopConfig.desktopManaged).toBe(true);
    expect(standaloneConfig.desktopManaged).toBe(false);
  });

  test("selects the Desktop SDK even for a legacy CLI-era configuration", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-sdk-cutover-"));
    roots.push(paseoHome);
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({
        agents: {
          providers: {
            omp: {
              ompBackend: "cli",
              command: ["/old/resources/bin/omp", "--profile", "old"],
              env: { OMP_PROFILE: "work", KEEP: "yes" },
              params: { disabledBuiltInTools: ["write"] },
            },
          },
        },
      }),
    );
    const config = loadConfig(paseoHome, {
      env: {
        PASEO_DESKTOP_MANAGED: "1",
        OMP_DESKTOP_SDK_ROOT: "/staged/sdk",
      },
    });
    expect(config.providerOverrides?.omp).toMatchObject({
      ompBackend: "sdk",
      ompSdkPath: "/staged/sdk",
      env: { OMP_PROFILE: "work", KEEP: "yes" },
      params: { disabledBuiltInTools: ["write"] },
    });
    expect(config.providerOverrides?.omp?.command).toBeUndefined();
    expect(config.agentProviderSettings?.omp?.command).toBeUndefined();
  });

  test("keeps custom SDK root precedence and isolated environment selection", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-sdk-env-"));
    roots.push(paseoHome);
    vi.stubEnv("OMP_DESKTOP_SDK_ROOT", "/ambient/sdk");
    vi.stubEnv("PASEO_DESKTOP_MANAGED", "1");
    try {
      expect(
        loadConfig(paseoHome, {
          env: {
            OMP_DESKTOP_SDK_ROOT: "/selected/sdk",
          },
        }).agentProviderSettings?.omp,
      ).toMatchObject({
        ompBackend: "sdk",
        ompSdkPath: "/selected/sdk",
      });
      const isolated = loadConfig(paseoHome, { env: {} });
      expect(isolated.desktopManaged).toBe(false);
      expect(isolated.agentProviderSettings?.omp?.ompSdkPath).toBeUndefined();
      await writeFile(
        path.join(paseoHome, "config.json"),
        JSON.stringify({
          agents: {
            providers: {
              omp: {
                ompSdkPath: "/custom/sdk",
                env: { OMP_DESKTOP_SDK_ROOT: "/provider/sdk" },
              },
            },
          },
        }),
      );
      expect(
        loadConfig(paseoHome, {
          env: {
            PASEO_DESKTOP_MANAGED: "1",
            OMP_DESKTOP_SDK_ROOT: "/staged/sdk",
          },
        }).agentProviderSettings?.omp?.ompSdkPath,
      ).toBe("/custom/sdk");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("preserves an explicitly selected external CLI on a standalone SDK-equipped server", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-explicit-cli-"));
    roots.push(paseoHome);
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({
        agents: { providers: { omp: { ompBackend: "cli", command: ["/external/omp"] } } },
      }),
    );
    expect(
      loadConfig(paseoHome, {
        env: {
          OMP_DESKTOP_SDK_ROOT: "/installed/sdk",
        },
      }).agentProviderSettings?.omp,
    ).toMatchObject({
      ompBackend: "cli",
      command: { mode: "replace", argv: ["/external/omp"] },
    });
  });

  test("loads the provider catalog refresh timeout", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-provider-timeout-"));
    roots.push(paseoHome);
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({ agents: { catalogRefreshTimeoutMs: 180_000 } }),
    );

    const config = loadConfig(paseoHome, { env: {} });

    expect(config.providerCatalogRefreshTimeoutMs).toBe(180_000);
  });

  test("loads SDK backend selection from persisted provider overrides", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-omp-sdk-"));
    roots.push(paseoHome);
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({
        agents: {
          providers: { omp: { ompBackend: "sdk", ompSdkPath: "/opt/omp-sdk" } },
        },
      }),
    );

    const config = loadConfig(paseoHome, { env: {} });
    expect(config.agentProviderSettings?.omp).toMatchObject({
      ompBackend: "sdk",
      ompSdkPath: "/opt/omp-sdk",
    });
    expect(toRuntimeSettings(config.providerOverrides?.omp)).toMatchObject({
      ompBackend: "sdk",
      ompSdkPath: "/opt/omp-sdk",
    });
    expect(
      mergeRuntimeSettings(
        config.agentProviderSettings?.omp,
        toRuntimeSettings({ ...config.providerOverrides?.omp, ompBackend: "cli" }),
      ),
    ).toMatchObject({
      ompBackend: "cli",
      ompSdkPath: "/opt/omp-sdk",
    });
  });

  test("loads SDK-only and path-only overrides without requiring command or env", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-omp-sdk-only-"));
    roots.push(paseoHome);
    const configPath = path.join(paseoHome, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ agents: { providers: { omp: { ompBackend: "sdk" } } } }),
    );
    expect(loadConfig(paseoHome, { env: {} }).agentProviderSettings?.omp?.ompBackend).toBe("sdk");

    await writeFile(
      configPath,
      JSON.stringify({ agents: { providers: { omp: { ompSdkPath: "/opt/omp-sdk" } } } }),
    );
    const config = loadConfig(paseoHome, { env: {} });
    expect(config.agentProviderSettings?.omp?.ompSdkPath).toBe("/opt/omp-sdk");
    expect(config.agentProviderSettings?.omp?.ompBackend).toBe("sdk");
  });

  test("keeps existing CLI configuration unchanged and rejects invalid SDK paths", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-omp-cli-"));
    roots.push(paseoHome);
    const configPath = path.join(paseoHome, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        agents: { providers: { omp: { command: ["/opt/omp"], env: { CUSTOM: "value" } } } },
      }),
    );
    const config = loadConfig(paseoHome, { env: {} });
    expect(config.agentProviderSettings?.omp).toEqual({
      command: { mode: "replace", argv: ["/opt/omp"] },
      env: { CUSTOM: "value" },
    });
    expect(config.providerOverrides?.omp?.ompBackend).toBeUndefined();

    await writeFile(
      configPath,
      JSON.stringify({
        agents: { providers: { omp: { ompBackend: "sdk", ompSdkPath: "./omp-sdk" } } },
      }),
    );
    expect(() => loadConfig(paseoHome, { env: {} })).toThrow(
      "ompSdkPath must be an absolute SDK package root.",
    );
  });

  test("records mutable and startup launch overrides by persisted leaf", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-config-overrides-"));
    roots.push(paseoHome);
    const config = loadConfig(paseoHome, {
      env: {
        PASEO_LISTEN: "127.0.0.1:7000",
        PASEO_PASSWORD: "secret",
        PASEO_RELAY_ENDPOINT: "relay.example.test:443",
        PASEO_TRUSTED_PROXIES: "true",
        PASEO_WEB_UI_ENABLED: "true",
        PASEO_LOG_FILE_PATH: "custom.log",
      },
      cli: { relayUseTls: false },
    });

    expect(config.configReload?.overrideControlledPaths).toEqual([
      "daemon.auth.password",
      "daemon.listen",
      "daemon.relay.endpoint",
      "daemon.relay.useTls",
      "daemon.trustedProxies",
      "features.webUi.enabled",
      "log.file.path",
    ]);
    expect(config.listen).toBe("127.0.0.1:7000");
    expect(config.trustedProxies).toBe(true);
    expect(config.log?.file?.path).toBe("custom.log");
  });

  test("resolves bundled web UI path from source-tree modules", () => {
    const root = path.parse(process.cwd()).root;
    expect(
      resolveBundledWebUiDistDir({
        moduleUrl: pathToFileURL(
          path.join(root, "repo", "packages", "server", "src", "server", "config.ts"),
        ),
      }),
    ).toBe(path.join(root, "repo", "packages", "server", "dist", "server", "web-ui"));
  });

  test("resolves bundled web UI path from globally installed compiled modules", async () => {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-config-compiled-"));
    roots.push(packageRoot);
    await mkdir(path.join(packageRoot, "dist", "server", "web-ui"), { recursive: true });

    expect(
      resolveBundledWebUiDistDir({
        moduleUrl: pathToFileURL(path.join(packageRoot, "dist", "server", "server", "config.js")),
      }),
    ).toBe(path.join(packageRoot, "dist", "server", "web-ui"));
  });

  test("resolves packaged desktop web UI path from resources app-dist", async () => {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-config-packaged-"));
    roots.push(packageRoot);
    await mkdir(path.join(packageRoot, "app-dist"), { recursive: true });

    expect(
      resolveBundledWebUiDistDir({
        moduleUrl: pathToFileURL(
          path.join(
            packageRoot,
            "app.asar",
            "node_modules",
            "@getpaseo",
            "server",
            "dist",
            "server",
            "server",
            "config.js",
          ),
        ),
        resourcesPath: packageRoot,
      }),
    ).toBe(path.join(packageRoot, "app-dist"));
  });
});
