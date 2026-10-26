import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { buildProviderRegistry, createAllClients } from "./provider-registry.js";
import { FakeOmp } from "./providers/omp/test-utils/fake-omp.js";
import { LocalModelBridge } from "../local-model-bridge.js";

const logger = createTestLogger();

describe("OMP provider registry", () => {
  test("registers the OMP provider plus import-only external providers", () => {
    const registry = buildProviderRegistry(logger);

    expect(Object.keys(registry)).toEqual(["omp", "pi", "codex"]);
    expect(registry.omp).toMatchObject({
      id: "omp",
      label: "Oh My Pi",
      enabled: true,
      defaultModeId: "ask",
      derivedFromProviderId: null,
    });
    // Import-only providers expose no creation modes.
    expect(registry.pi).toMatchObject({ id: "pi", enabled: true, defaultModeId: null, modes: [] });
    expect(registry.codex).toMatchObject({
      id: "codex",
      enabled: true,
      defaultModeId: null,
      modes: [],
    });
  });

  test("import-only providers keep empty modes even when the runtime catalog reports OMP modes", async () => {
    const registry = buildProviderRegistry(logger, { ompRuntime: new FakeOmp() });
    for (const provider of ["pi", "codex"] as const) {
      const catalog = await registry[provider].fetchCatalog({ scope: "global" });
      // The facade delegates to the OMP client, whose catalog carries OMP's
      // creation modes; the import-only definition must not inherit them, or
      // the UI's "no modes means not create-capable" filter leaks these
      // providers into the new-session provider list.
      expect(catalog.modes).toEqual([]);
    }
  });

  test("applies built-in OMP display overrides", () => {
    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        omp: {
          label: "OMP",
          description: "Local OMP runtime",
        },
      },
    });

    expect(registry.omp.label).toBe("OMP");
    expect(registry.omp.description).toBe("Local OMP runtime");
  });

  test("local source takes precedence over cached remote replacement and additional models", async () => {
    const bridge = new LocalModelBridge();
    try {
      await bridge.attach(
        "desktop",
        [{ provider: "local-provider", id: "local-model", api: "openai-completions" }],
        () => {},
      );
      const runtime = new FakeOmp();
      runtime.queueModels([
        { provider: "desktop-local", id: "local-provider/local-model", api: "openai-completions" },
        { provider: "remote-provider", id: "remote-model" },
      ]);
      const registry = buildProviderRegistry(logger, {
        ompRuntime: runtime,
        localModelBridge: bridge,
        providerOverrides: {
          omp: {
            models: [{ id: "remote-provider/replacement", label: "Remote replacement" }],
            additionalModels: [{ id: "remote-provider/addition", label: "Remote addition" }],
          },
        },
      });
      const cachedClient = registry.omp.createClient(logger);
      const localCatalog = await registry.omp.fetchCatalog({ scope: "global" }, cachedClient);
      expect(localCatalog.models.map((model) => model.id)).toEqual([
        "desktop-local/local-provider/local-model",
      ]);
      bridge.detach("desktop", { disable: true });
      const remoteCatalog = await registry.omp.fetchCatalog({ scope: "global" }, cachedClient);
      expect(remoteCatalog.models.map((model) => model.id)).toEqual([
        "remote-provider/replacement",
        "remote-provider/addition",
      ]);
    } finally {
      await bridge.close();
    }
  });

  test("rejects unknown custom providers", () => {
    expect(() =>
      buildProviderRegistry(logger, {
        providerOverrides: {
          claude: { enabled: true },
        },
      }),
    ).toThrow("OMP Desktop supports only the built-in 'omp' provider; received 'claude'");
  });

  test("creates the OMP client plus import facades", () => {
    const clients = createAllClients(logger, { ompRuntime: new FakeOmp() });

    expect(Object.keys(clients)).toEqual(["omp", "pi", "codex"]);
    expect(clients.omp.provider).toBe("omp");
    expect(clients.pi.provider).toBe("pi");
    expect(clients.pi.capabilities.supportsSessionListing).toBe(true);
    expect(typeof clients.pi.listImportableSessions).toBe("function");
    expect(typeof clients.pi.importSession).toBe("function");
    expect(clients.codex.provider).toBe("codex");
    expect(clients.codex.capabilities.supportsSessionListing).toBe(true);
  });
});
