import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { DaemonConfigStore, applyMutableProviderConfigToOverrides } from "./daemon-config-store.js";
import { loadPersistedConfig } from "./persisted-config.js";
import type { PersistedConfig } from "./persisted-config.js";
import {
  MutableDaemonConfigSchema,
  type MutableDaemonConfig,
} from "@omp-desktop/protocol/messages";
import { resolveConfigFromPersisted } from "./config.js";

function reloadableConfig(
  persisted: PersistedConfig,
  options: { relayEnabledFallback?: boolean } = {},
): MutableDaemonConfig {
  const daemon = persisted.daemon ?? {};
  const relay = daemon.relay ?? {};
  const resolvedRelay = resolveConfigFromPersisted(
    ".",
    { version: 1, daemon: { relay } },
    { env: {}, relayEnabledFallback: options.relayEnabledFallback },
  );
  const git = daemon.git ?? {};
  const agents = persisted.agents ?? {};
  return MutableDaemonConfigSchema.parse({
    relay: {
      enabled: relay.enabled ?? options.relayEnabledFallback ?? false,
      endpoint: resolvedRelay.relayEndpoint,
      useTls: resolvedRelay.relayUseTls,
      publicEndpoint: resolvedRelay.relayPublicEndpoint,
      publicUseTls: resolvedRelay.relayPublicUseTls,
    },
    mcp: { enabled: true, injectIntoAgents: false },
    providers: agents.providers ?? {},
    metadataGeneration: { providers: agents.metadataGeneration?.providers ?? [] },
    autoArchiveAfterMerge: daemon.autoArchiveAfterMerge ?? false,
    enableTerminalAgentHooks: daemon.enableTerminalAgentHooks ?? false,
    appendSystemPrompt: daemon.appendSystemPrompt ?? "",
    terminalProfiles: daemon.terminalProfiles,
    agentProfiles: daemon.agentProfiles,
    ompProviderAccountNotes: daemon.ompProviderAccountNotes,
    cors: { allowedOrigins: [] },
    trustedProxies: ["loopback"],
    git: {
      maxProcessesPerSecond: git.maxProcessesPerSecond ?? 64,
      maxProcessConcurrency: git.maxProcessConcurrency ?? 8,
    },
    app: { baseUrl: "https://app.paseo.sh" },
    pluginsEnabled: persisted.pluginsEnabled ?? false,
    plugins: persisted.plugins ?? {},
  });
}

describe("applyMutableProviderConfigToOverrides", () => {
  test("merges mutable provider fields onto provider overrides", () => {
    expect(
      applyMutableProviderConfigToOverrides(
        {
          gemini: {
            extends: "acp",
            label: "Gemini",
            command: ["gemini", "--acp"],
          },
        },
        {
          gemini: {
            enabled: false,
            description: "Gemini ACP",
            env: { GEMINI_AUTO_UPDATE: "0" },
          },
          claude: {
            additionalModels: [
              {
                id: "claude-custom",
                label: "claude-custom",
              },
            ],
          },
        },
      ),
    ).toEqual({
      gemini: {
        extends: "acp",
        label: "Gemini",
        description: "Gemini ACP",
        command: ["gemini", "--acp"],
        env: { GEMINI_AUTO_UPDATE: "0" },
        enabled: false,
      },
      claude: {
        additionalModels: [
          {
            id: "claude-custom",
            label: "claude-custom",
          },
        ],
      },
    });
  });

  test("preserves existing OMP params when saving a built-in tool restriction", () => {
    expect(
      applyMutableProviderConfigToOverrides(
        {
          omp: {
            command: ["omp"],
            params: {
              proxyEnabled: false,
              agentShell: { mode: "custom", path: "/bin/bash" },
            },
          },
        },
        { omp: { params: { disabledBuiltInTools: ["bash"] } } },
      )?.omp,
    ).toMatchObject({
      command: ["omp"],
      params: {
        proxyEnabled: false,
        agentShell: { mode: "custom", path: "/bin/bash" },
        disabledBuiltInTools: ["bash"],
      },
    });
  });
});

describe("DaemonConfigStore", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("patch persists relay state and emits its field change", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });
    const changes: unknown[] = [];
    store.onFieldChange("relay.enabled", (value) => changes.push(value));

    store.patch({ relay: { enabled: true } });

    expect(changes).toEqual([true]);
    expect(loadPersistedConfig(paseoHome).daemon?.relay?.enabled).toBe(true);
  });

  test("persists independent OMP Desktop tool capability switches", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: true },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });

    store.patch({ mcp: { toolCapabilities: { terminals: false } } });
    store.patch({ mcp: { toolCapabilities: { schedules: false } } });

    expect(store.get().mcp.toolCapabilities).toMatchObject({
      terminals: false,
      schedules: false,
    });
    expect(loadPersistedConfig(paseoHome).daemon?.mcp?.toolCapabilities).toEqual({
      terminals: false,
      schedules: false,
    });
  });

  function relayStore(
    relay: NonNullable<NonNullable<PersistedConfig["daemon"]>["relay"]>,
    env: NodeJS.ProcessEnv = {},
  ) {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-relay-address-"));
    tempDirs.push(paseoHome);
    const persisted: PersistedConfig = {
      version: 1,
      daemon: { relay },
      app: { baseUrl: "https://app.example.test" },
    };
    writeFileSync(path.join(paseoHome, "config.json"), JSON.stringify(persisted));
    const initial = reloadableConfig(persisted);
    const resolved = resolveConfigFromPersisted(paseoHome, persisted, { env });
    initial.relay = {
      enabled: resolved.relayEnabled ?? false,
      endpoint: resolved.relayEndpoint,
      useTls: resolved.relayUseTls,
      publicEndpoint: resolved.relayPublicEndpoint,
      publicUseTls: resolved.relayPublicUseTls,
    };
    const store = new DaemonConfigStore(paseoHome, initial, undefined, {
      env,
      relayOverrideControlledPaths: resolved.configReload?.overrideControlledPaths,
    });
    return { store, paseoHome };
  }

  test("persists canonical addresses without enabling relay or freezing public inheritance", () => {
    const { store, paseoHome } = relayStore({
      enabled: false,
      endpoint: "localhost:4000",
      useTls: false,
    });
    const next = store.patch({ relay: { endpoint: "wss://RELAY.example.test:8443/ws" } });
    expect(next.relay).toEqual({
      enabled: false,
      endpoint: "relay.example.test:8443",
      useTls: true,
      publicEndpoint: "relay.example.test:8443",
      publicUseTls: true,
    });
    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.relay).toEqual({
      enabled: false,
      endpoint: "relay.example.test:8443",
      useTls: true,
    });
    expect(persisted.app?.baseUrl).toBe("https://app.example.test");
    const restarted = resolveConfigFromPersisted(paseoHome, persisted, { env: {} });
    expect(restarted.relayPublicEndpoint).toBe(next.relay?.publicEndpoint);
    expect(restarted.relayPublicUseTls).toBe(true);
    expect(store.patch({ relay: { endpoint: "localhost:4002", useTls: false } }).relay).toEqual({
      enabled: false,
      endpoint: "localhost:4002",
      useTls: false,
      publicEndpoint: "localhost:4002",
      publicUseTls: false,
    });
  });

  test("preserves explicit public endpoint and TLS independently", () => {
    const { store } = relayStore({
      enabled: true,
      endpoint: "localhost:4000",
      useTls: false,
      publicEndpoint: "public.example.test:8443",
    });
    expect(
      store.patch({ relay: { endpoint: "wss://private.example.test:9443" } }).relay,
    ).toMatchObject({
      publicEndpoint: "public.example.test:8443",
      publicUseTls: true,
    });
    store.patch({ relay: { publicUseTls: false } });
    expect(
      store.patch({ relay: { endpoint: "wss://private.example.test:9444" } }).relay,
    ).toMatchObject({
      publicEndpoint: "public.example.test:8443",
      publicUseTls: false,
    });
    const inheritedEndpoint = relayStore({
      enabled: false,
      endpoint: "localhost:4000",
      useTls: false,
      publicUseTls: true,
    }).store;
    expect(inheritedEndpoint.patch({ relay: { endpoint: "localhost:4001" } }).relay).toMatchObject({
      publicEndpoint: "localhost:4001",
      publicUseTls: true,
    });
  });

  test("persists explicit public selections even when they equal inherited values", () => {
    const { store, paseoHome } = relayStore({
      enabled: false,
      endpoint: "localhost:4000",
      useTls: false,
    });
    store.patch({ relay: { publicEndpoint: "localhost:4000", publicUseTls: false } });
    expect(loadPersistedConfig(paseoHome).daemon?.relay?.publicEndpoint).toBe("localhost:4000");
    expect(
      store.patch({ relay: { endpoint: "wss://relay.example.test:8443" } }).relay,
    ).toMatchObject({
      publicEndpoint: "localhost:4000",
      publicUseTls: false,
    });
  });

  test("rejects invalid addresses atomically before persistence or config notifications", () => {
    const { store, paseoHome } = relayStore({ enabled: false, endpoint: "localhost:4000" });
    const before = loadPersistedConfig(paseoHome);
    const current = store.get();
    const changes: unknown[] = [];
    store.onChange((next) => {
      changes.push(next);
    });
    expect(() =>
      store.patch({
        relay: {
          enabled: true,
          endpoint: "wss://valid.example.test",
          publicEndpoint: "ws://bad.example.test?secret=x",
        },
      }),
    ).toThrow();
    expect(store.get()).toEqual(current);
    expect(loadPersistedConfig(paseoHome)).toEqual(before);
    expect(changes).toEqual([]);
  });

  test("rejects launch-owned address fields but preserves public overrides during private edits", () => {
    const { store, paseoHome } = relayStore(
      { enabled: false, endpoint: "localhost:4000", useTls: false },
      { PASEO_RELAY_ENDPOINT: "private.example.test:4000" },
    );
    const before = loadPersistedConfig(paseoHome);
    expect(() => store.patch({ relay: { endpoint: "localhost:4001", enabled: true } })).toThrow();
    expect(loadPersistedConfig(paseoHome)).toEqual(before);
    const publicOverride = relayStore(
      { enabled: false, endpoint: "localhost:4000", useTls: false },
      {
        PASEO_RELAY_PUBLIC_ENDPOINT: "public.example.test:8443",
        PASEO_RELAY_PUBLIC_USE_TLS: "true",
      },
    ).store;
    expect(publicOverride.patch({ relay: { endpoint: "localhost:4001" } }).relay).toMatchObject({
      endpoint: "localhost:4001",
      publicEndpoint: "public.example.test:8443",
      publicUseTls: true,
    });
    expect(() => publicOverride.patch({ relay: { publicUseTls: false } })).toThrow();
  });

  test("persists the OMP PI_PROXY environment setting", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });

    store.patch({
      providers: {
        omp: {
          env: { PI_PROXY: "http://127.0.0.1:7890" },
          params: { proxyEnabled: false },
        },
      },
    });

    expect(store.get().providers.omp).toMatchObject({
      env: { PI_PROXY: "http://127.0.0.1:7890" },
      params: { proxyEnabled: false },
    });
    expect(loadPersistedConfig(paseoHome).agents?.providers?.omp).toMatchObject({
      env: { PI_PROXY: "http://127.0.0.1:7890" },
      params: { proxyEnabled: false },
    });
  });

  test("saves a disabled OMP tool using the stock 18.3.0 CLI flags", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const help = "  --tools <names>  Enable specified tools\n  --no-tools  Disable all tools";
    const script = `process.stdout.write(process.argv[1] === "--version" ? "omp/18.3.0" : ${JSON.stringify(help)})`;
    const command = [process.execPath, "-e", script, "--"];
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      providers: { omp: { command } },
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });

    store.patch({ providers: { omp: { params: { disabledBuiltInTools: ["write"] } } } });

    expect(loadPersistedConfig(paseoHome).agents?.providers?.omp?.params).toMatchObject({
      disabledBuiltInTools: ["write"],
    });
  });

  test("patch round-trips agent profiles through the strictly-parsed persisted config", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });

    store.patch({
      agentProfiles: [
        {
          id: "profile_ui",
          name: "UI work",
          icon: "🎨",
          provider: "claude",
          model: "claude-opus-5",
          modeId: "plan",
          thinkingOptionId: "think-hard",
          featureValues: { webSearch: true },
          notes: "Use for components, layout and design tokens.",
        },
      ],
    });

    expect(loadPersistedConfig(paseoHome).daemon?.agentProfiles).toEqual([
      {
        id: "profile_ui",
        name: "UI work",
        icon: "🎨",
        provider: "claude",
        model: "claude-opus-5",
        modeId: "plan",
        thinkingOptionId: "think-hard",
        featureValues: { webSearch: true },
        notes: "Use for components, layout and design tokens.",
      },
    ]);
    expect(store.get().agentProfiles).toHaveLength(1);
  });

  test("patch round-trips OMP provider account notes through daemon config", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });

    store.patch({ ompProviderAccountNotes: { "4": "个人订阅" } });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.ompProviderAccountNotes).toEqual({ "4": "个人订阅" });
    expect(reloadableConfig(persisted).ompProviderAccountNotes).toEqual({ "4": "个人订阅" });
  });

  test("patch replaces the whole agent profile list rather than merging entries", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
      agentProfiles: [
        { id: "a", name: "Keep", provider: "claude" },
        { id: "b", name: "Drop", provider: "codex" },
      ],
    });

    store.patch({ agentProfiles: [{ id: "a", name: "Keep", provider: "claude" }] });

    expect(store.get().agentProfiles).toEqual([{ id: "a", name: "Keep", provider: "claude" }]);
    expect(loadPersistedConfig(paseoHome).daemon?.agentProfiles).toHaveLength(1);
  });

  test("rolls back config when a field transition fails", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    writeFileSync(
      path.join(paseoHome, "config.json"),
      `${JSON.stringify({ version: 1, daemon: { relay: { enabled: false } } }, null, 2)}\n`,
    );
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });
    store.onFieldChange("relay.enabled", (enabled) => {
      if (enabled === true) {
        throw new Error("Relay transport failed to start");
      }
    });

    expect(() => store.patch({ relay: { enabled: true } })).toThrow(
      "Relay transport failed to start",
    );
    expect(store.get().relay?.enabled).toBe(false);
    expect(loadPersistedConfig(paseoHome).daemon?.relay?.enabled).toBe(false);
  });

  test("rolls back live owners when a later transactional owner fails", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });
    let injectIntoAgents = false;
    store.onApply((next, previous) => {
      injectIntoAgents = next.mcp?.injectIntoAgents ?? false;
      return () => {
        injectIntoAgents = previous.mcp?.injectIntoAgents ?? false;
      };
    });
    store.onApply(() => {
      throw new Error("Provider refresh failed");
    });

    expect(() => store.patch({ mcp: { injectIntoAgents: true } })).toThrow(
      "Provider refresh failed",
    );
    expect(injectIntoAgents).toBe(false);
    expect(store.get().mcp?.injectIntoAgents).toBe(false);
    expect(loadPersistedConfig(paseoHome).daemon?.mcp?.injectIntoAgents).toBeUndefined();
  });

  test("rejects relay patches when a launch override owns the setting", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(
      paseoHome,
      {
        relay: { enabled: false },
        mcp: { injectIntoAgents: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
      { relayEnabledMutable: false },
    );

    expect(() => store.patch({ relay: { enabled: true } })).toThrow(
      "Relay is controlled by a daemon launch override",
    );
  });

  test("unrelated patches do not persist a one-launch relay override", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const persisted = loadPersistedConfig(paseoHome);
    writeFileSync(
      path.join(paseoHome, "config.json"),
      `${JSON.stringify({
        ...persisted,
        daemon: { ...persisted.daemon, relay: { enabled: false } },
      })}\n`,
    );
    const store = new DaemonConfigStore(
      paseoHome,
      {
        relay: { enabled: true },
        mcp: { injectIntoAgents: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
      { relayEnabledMutable: false },
    );

    store.patch({ mcp: { injectIntoAgents: true } });

    expect(loadPersistedConfig(paseoHome).daemon?.relay?.enabled).toBe(false);
  });

  test("unrelated patches persist only requested file intent", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const before = loadPersistedConfig(paseoHome);
    const store = new DaemonConfigStore(
      paseoHome,
      {
        relay: { enabled: true },
        mcp: { enabled: false, injectIntoAgents: false },
        hostnames: ["launch.example.test"],
        cors: { allowedOrigins: ["https://launch.example.test"] },
        trustedProxies: true,
        git: { maxProcessesPerSecond: 7, maxProcessConcurrency: 2 },
        app: { baseUrl: "https://launch.example.test" },
        catalogRefreshTimeoutMs: 9_000,
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
      { relayEnabledMutable: false },
    );

    store.patch({
      appendSystemPrompt: "Only this field",
      // Reload-only runtime state is accepted as unknown wire data for forward
      // compatibility but is not part of the patch capability.
      hostnames: ["attempted-patch.example.test"],
    } as Parameters<typeof store.patch>[0]);

    expect(store.get().hostnames).toEqual(["launch.example.test"]);
    expect(loadPersistedConfig(paseoHome)).toEqual({
      ...before,
      daemon: { ...before.daemon, appendSystemPrompt: "Only this field" },
    });
  });

  test("patch persists provider enabled flags into config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const initial = loadPersistedConfig(paseoHome);
    const configPath = path.join(paseoHome, "config.json");
    // Reuse the validated serializer through the store path by seeding the file directly.
    // This keeps the test focused on the merge behavior.
    const seeded =
      JSON.stringify(
        {
          ...initial,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
            },
          },
        },
        null,
        2,
      ) + "\n";
    writeFileSync(configPath, seeded);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({
      providers: {
        gemini: { enabled: false },
      },
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers?.gemini).toEqual({
      extends: "acp",
      label: "Gemini",
      command: ["gemini", "--acp"],
      enabled: false,
    });
  });

  test("patch removes provider entries from config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
              claude: {
                enabled: false,
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        providers: {
          gemini: {},
          claude: { enabled: false },
        },
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    const next = store.patch({ removeProviders: ["gemini"] });

    expect(next.providers.gemini).toBeUndefined();
    expect(next.providers.claude).toEqual({ enabled: false });
    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers?.gemini).toBeUndefined();
    expect(persisted.agents?.providers?.claude).toEqual({ enabled: false });
  });

  test("patch removes the providers object when the last provider is deleted", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        providers: { gemini: {} },
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({ removeProviders: ["gemini"] });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers).toBeUndefined();
  });

  test("persists independent commit-message and Quick Ask model selections", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    writeFileSync(
      path.join(paseoHome, "config.json"),
      JSON.stringify({
        version: 1,
        agents: {
          metadataGeneration: {
            providers: [{ provider: "claude", model: "haiku" }],
          },
        },
      }),
    );
    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        providers: {},
        metadataGeneration: {
          providers: [{ provider: "claude", model: "haiku" }],
        },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({
      metadataGeneration: {
        commitMessageProviders: [{ provider: "codex", model: "fast" }],
      },
    });
    const next = store.patch({
      quickAsk: {
        providers: [{ provider: "claude", model: "sonnet" }],
      },
    });

    expect(next.metadataGeneration).toEqual({
      providers: [{ provider: "claude", model: "haiku" }],
      commitMessageProviders: [{ provider: "codex", model: "fast" }],
    });
    expect(next.quickAsk).toEqual({
      providers: [{ provider: "claude", model: "sonnet" }],
    });
    expect(loadPersistedConfig(paseoHome).agents).toMatchObject({
      metadataGeneration: {
        providers: [{ provider: "claude", model: "haiku" }],
        commitMessageProviders: [{ provider: "codex", model: "fast" }],
      },
      quickAsk: {
        providers: [{ provider: "claude", model: "sonnet" }],
      },
    });
  });

  test("patch removes deleted providers from metadata generation", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
              claude: {
                enabled: false,
              },
            },
            metadataGeneration: {
              providers: [
                { provider: "gemini", model: "flash" },
                { provider: "claude", model: "haiku" },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        providers: {
          gemini: {},
          claude: { enabled: false },
        },
        metadataGeneration: {
          providers: [
            { provider: "gemini", model: "flash" },
            { provider: "claude", model: "haiku" },
          ],
        },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    const next = store.patch({ removeProviders: ["gemini"] });

    expect(next.metadataGeneration.providers).toEqual([{ provider: "claude", model: "haiku" }]);
    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.metadataGeneration).toEqual({
      providers: [{ provider: "claude", model: "haiku" }],
    });
  });

  test("patch persists provider removal when in-memory config is already clean", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
            },
            metadataGeneration: {
              providers: [{ provider: "gemini", model: "flash" }],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    const next = store.patch({ removeProviders: ["gemini"] });

    expect(next.providers.gemini).toBeUndefined();
    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers).toBeUndefined();
    expect(persisted.agents?.metadataGeneration).toEqual({ providers: [] });
  });

  test("patch persists append system prompt into config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({
      appendSystemPrompt: "Prefer terse replies.",
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.appendSystemPrompt).toBe("Prefer terse replies.");
  });

  test("patch persists provider additional models into config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({
      providers: {
        claude: {
          additionalModels: [
            {
              id: "claude-custom",
              label: "claude-custom",
            },
          ],
        },
      },
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers?.claude).toEqual({
      additionalModels: [
        {
          id: "claude-custom",
          label: "claude-custom",
        },
      ],
    });
  });

  test("patch persists daemon append system prompt into config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({
      appendSystemPrompt: "Prefer terse replies.",
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.appendSystemPrompt).toBe("Prefer terse replies.");
  });

  test("patch persists enable terminal agent hooks into config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({ enableTerminalAgentHooks: true });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.enableTerminalAgentHooks).toBe(true);
  });

  test("patch persists metadata generation providers into config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({
      metadataGeneration: {
        providers: [
          { provider: "claude", model: "haiku" },
          { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
        ],
      },
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.metadataGeneration).toEqual({
      providers: [
        { provider: "claude", model: "haiku" },
        { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
      ],
    });
  });

  test("patch persists clearing metadata generation providers into config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            metadataGeneration: {
              providers: [{ provider: "claude", model: "haiku" }],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        providers: {},
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
        metadataGeneration: { providers: [{ provider: "claude", model: "haiku" }] },
      },
      undefined,
    );

    store.patch({ metadataGeneration: { providers: [] } });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.metadataGeneration).toEqual({ providers: [] });
  });

  test("patch persists custom ACP provider overrides into config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        providers: {},
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
        metadataGeneration: { providers: [] },
      },
      undefined,
    );

    store.patch({
      providers: {
        "paseo-e2e-acp": {
          extends: "acp",
          label: "Paseo E2E ACP",
          description: "E2E ACP provider fixture",
          command: ["npx", "-y", "--version"],
          env: {},
        },
      },
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers?.["paseo-e2e-acp"]).toEqual({
      extends: "acp",
      label: "Paseo E2E ACP",
      description: "E2E ACP provider fixture",
      command: ["npx", "-y", "--version"],
      env: {},
    });
  });
});

describe("DaemonConfigStore reload", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  function createReloadableStore(
    options: {
      overrideControlledPaths?: string[];
      initialPersisted?: PersistedConfig;
    } = {},
  ) {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-reload-"));
    tempDirs.push(paseoHome);
    if (options.initialPersisted) {
      writeFileSync(
        path.join(paseoHome, "config.json"),
        `${JSON.stringify(options.initialPersisted, null, 2)}\n`,
      );
    }
    const persisted = loadPersistedConfig(paseoHome);
    const relayEnabledFallback = false;
    const initialMutable = reloadableConfig(persisted, { relayEnabledFallback });
    const store = new DaemonConfigStore(paseoHome, initialMutable, undefined, {
      reloadSource: {
        resolve: (nextPersisted) => {
          const mutable = reloadableConfig(nextPersisted, { relayEnabledFallback });
          for (const field of ["enabled", "endpoint", "useTls"] as const) {
            if (options.overrideControlledPaths?.includes(`daemon.relay.${field}`)) {
              mutable.relay = { ...mutable.relay, [field]: initialMutable.relay?.[field] };
            }
          }
          if (
            options.overrideControlledPaths?.includes("daemon.relay.endpoint") &&
            nextPersisted.daemon?.relay?.publicEndpoint === undefined
          ) {
            mutable.relay = {
              ...mutable.relay,
              publicEndpoint: initialMutable.relay?.publicEndpoint,
            };
          }
          if (
            options.overrideControlledPaths?.includes("daemon.relay.useTls") &&
            nextPersisted.daemon?.relay?.publicUseTls === undefined
          ) {
            mutable.relay = {
              ...mutable.relay,
              publicUseTls: initialMutable.relay?.publicUseTls,
            };
          }
          return {
            mutable,
            overrideControlledPaths: options.overrideControlledPaths ?? [],
          };
        },
      },
    });
    return { paseoHome, store, persisted };
  }

  function writeConfig(paseoHome: string, config: unknown): void {
    writeFileSync(path.join(paseoHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  }

  test("applies mutable edits and reports startup-only edits", () => {
    const { paseoHome, store, persisted } = createReloadableStore();
    writeConfig(paseoHome, {
      ...persisted,
      daemon: {
        ...persisted.daemon,
        listen: "127.0.0.1:7777",
        git: { maxProcessesPerSecond: 12, maxProcessConcurrency: 3 },
      },
    });

    expect(store.reload()).toEqual({
      appliedPaths: ["daemon.git.maxProcessConcurrency", "daemon.git.maxProcessesPerSecond"],
      restartRequiredPaths: ["daemon.listen"],
      overrideControlledPaths: [],
    });
    expect(store.get().git).toEqual({ maxProcessesPerSecond: 12, maxProcessConcurrency: 3 });
  });

  test("applies the global plugin switch in both directions", () => {
    const { paseoHome, store, persisted } = createReloadableStore({
      initialPersisted: { version: 1, pluginsEnabled: false },
    });
    const changes: unknown[] = [];
    store.onFieldChange("pluginsEnabled", (value) => changes.push(value));

    writeConfig(paseoHome, { ...persisted, pluginsEnabled: true });
    expect(store.reload()).toEqual({
      appliedPaths: ["pluginsEnabled"],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    expect(store.get().pluginsEnabled).toBe(true);

    writeConfig(paseoHome, { ...persisted, pluginsEnabled: false });
    expect(store.reload()).toEqual({
      appliedPaths: ["pluginsEnabled"],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    expect(store.get().pluginsEnabled).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  test("classifies every leaf when a parent subtree is added", () => {
    const { paseoHome, store } = createReloadableStore({
      initialPersisted: { version: 1 },
    });
    writeConfig(paseoHome, {
      version: 1,
      daemon: {
        relay: {
          enabled: true,
          endpoint: "relay.example.test:443",
          useTls: false,
        },
      },
    });

    expect(store.reload()).toEqual({
      appliedPaths: [
        "daemon.relay.enabled",
        "daemon.relay.endpoint",
        "daemon.relay.publicEndpoint",
        "daemon.relay.publicUseTls",
        "daemon.relay.useTls",
      ],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    expect(store.get().relay.enabled).toBe(true);
  });

  test("classifies every leaf when the daemon subtree is removed", () => {
    const { paseoHome, store } = createReloadableStore({
      initialPersisted: {
        version: 1,
        daemon: {
          listen: "127.0.0.1:7777",
          relay: {
            enabled: false,
            endpoint: "relay.example.test:443",
            useTls: false,
          },
          serviceProxy: {
            listen: "127.0.0.1:7788",
            publicBaseUrl: "https://services.example.test",
          },
        },
      },
    });
    writeConfig(paseoHome, { version: 1 });

    expect(store.reload()).toEqual({
      appliedPaths: [
        "daemon.relay.endpoint",
        "daemon.relay.publicEndpoint",
        "daemon.relay.publicUseTls",
        "daemon.relay.useTls",
      ],
      restartRequiredPaths: [
        "daemon.listen",
        "daemon.serviceProxy.listen",
        "daemon.serviceProxy.publicBaseUrl",
      ],
      overrideControlledPaths: [],
    });
    expect(store.get().relay?.enabled).toBe(false);
  });

  test("keeps overridden leaves separate from restart-required siblings", () => {
    const { paseoHome, store } = createReloadableStore({
      initialPersisted: { version: 1 },
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
    writeConfig(paseoHome, {
      version: 1,
      daemon: {
        relay: { enabled: false, endpoint: "relay.example.test:443" },
      },
    });

    expect(store.reload()).toEqual({
      appliedPaths: ["daemon.relay.endpoint", "daemon.relay.publicEndpoint"],
      restartRequiredPaths: [],
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
  });

  test("invalid JSON and invalid schema apply nothing", () => {
    const { paseoHome, store } = createReloadableStore();
    const before = store.get();
    writeFileSync(path.join(paseoHome, "config.json"), "{ nope\n");
    expect(() => store.reload()).toThrow("Invalid JSON");
    expect(store.get()).toEqual(before);

    writeConfig(paseoHome, { daemon: { git: { maxProcessConcurrency: "invalid" } } });
    expect(() => store.reload()).toThrow("Invalid config");
    expect(store.get()).toEqual(before);
  });

  test("removing providers and optional profiles clears live state", () => {
    const { paseoHome, store, persisted } = createReloadableStore();
    writeConfig(paseoHome, {
      ...persisted,
      daemon: {
        ...persisted.daemon,
        terminalProfiles: [{ id: "shell", name: "Shell", command: "bash" }],
        agentProfiles: [{ id: "review", name: "Review", provider: "codex" }],
      },
      agents: {
        providers: {
          gemini: { extends: "acp", label: "Gemini", command: ["gemini", "--acp"] },
        },
      },
    });
    store.reload();

    writeConfig(paseoHome, persisted);
    const result = store.reload();

    expect(result.appliedPaths).toEqual([
      "agents.providers",
      "daemon.agentProfiles",
      "daemon.terminalProfiles",
    ]);
    expect(store.get().providers).toEqual({});
    expect(store.get().terminalProfiles).toBeUndefined();
    expect(store.get().agentProfiles).toBeUndefined();
  });

  test("reports a launch-controlled edit without changing live state", () => {
    const { paseoHome, store, persisted } = createReloadableStore({
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
    const initialRelay = store.get().relay?.enabled;
    writeConfig(paseoHome, {
      ...persisted,
      daemon: { ...persisted.daemon, relay: { enabled: !initialRelay } },
    });

    expect(store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
    expect(store.get().relay?.enabled).toBe(initialRelay);
  });

  test("an unrelated patch does not mark a manual override-owned edit as applied", () => {
    const { paseoHome, store, persisted } = createReloadableStore({
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
    writeConfig(paseoHome, {
      ...persisted,
      daemon: { ...persisted.daemon, relay: { enabled: false } },
    });
    store.patch({ appendSystemPrompt: "patched elsewhere" });

    expect(store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
  });

  test("reports startup-only launch overrides instead of restart warnings", () => {
    const { paseoHome, store, persisted } = createReloadableStore({
      overrideControlledPaths: ["daemon.listen", "daemon.relay.endpoint"],
    });
    writeConfig(paseoHome, {
      ...persisted,
      daemon: {
        ...persisted.daemon,
        listen: "127.0.0.1:7777",
        relay: {
          ...persisted.daemon?.relay,
          endpoint: "relay.example.test:443",
        },
      },
    });

    expect(store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: ["daemon.listen", "daemon.relay.endpoint"],
    });
  });

  test("a no-op reload returns empty path lists", () => {
    const { store } = createReloadableStore();
    expect(store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
  });
});
