import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAttachmentSource, defineRpc } from "./index.js";
import { createElement, memo } from "react";
import { callPluginRpc, searchPluginAttachments } from "./host.js";
import type { OmpApi, OmpAgent } from "@omp-desktop/client";
import { createActivationScope } from "./activation.js";
import { createPluginOmpApi } from "./omp-api.js";
import type { PluginInstallation } from "./runtime-contracts.js";

const contract = defineRpc({
  name: "increment",
  input: z.unknown().pipe(z.object({ value: z.number() })),
  output: z.object({ value: z.number() }),
});

describe("plugin RPC contracts", () => {
  it("validates input before invoking the daemon", async () => {
    let invocations = 0;
    const invoke = async () => {
      invocations += 1;
      return { value: 2 };
    };

    await expect(callPluginRpc(contract, invoke, { value: "wrong" })).rejects.toBeInstanceOf(
      z.ZodError,
    );
    expect(invocations).toBe(0);
  });

  it("validates output before resolving", async () => {
    const invoke = async () => ({ value: "wrong" });

    await expect(callPluginRpc(contract, invoke, { value: 1 })).rejects.toBeInstanceOf(z.ZodError);
  });

  it("returns parsed output for a valid invocation", async () => {
    const invoke = async (method: string, input: unknown) => ({
      value: method === "increment" && typeof input === "object" ? 2 : 0,
    });

    await expect(callPluginRpc(contract, invoke, { value: 1 })).resolves.toEqual({ value: 2 });
  });
});

describe("plugin attachment sources", () => {
  const search = defineRpc({
    name: "issues.search",
    input: z.object({ query: z.string() }),
    output: z.object({
      items: z.array(
        z.object({
          id: z.string(),
          identifier: z.string(),
          title: z.string(),
          subtitle: z.string().optional(),
          url: z.string(),
          text: z.string(),
          resourceType: z.string(),
        }),
      ),
    }),
  });

  it("searches through the declared RPC and validates the standard result", async () => {
    const source = defineAttachmentSource({
      id: "issues",
      title: "Issue",
      icon: "CircleDot",
      pickerTitle: "Attach issue",
      searchPlaceholder: "Search",
      search,
    });

    const payload = await searchPluginAttachments(
      source,
      async (method, input) => ({
        items: [
          {
            id: "issue-1",
            identifier: `${method}:${String(Reflect.get(input as object, "query"))}`,
            title: "Plugin attachments",
            url: "https://example.com/issues/1",
            text: "Issue snapshot",
            resourceType: "issue",
          },
        ],
      }),
      "ENG-123",
    );

    expect(payload.items[0]?.identifier).toBe("issues.search:ENG-123");
  });

  it("rejects a malformed standard search result", async () => {
    const source = defineAttachmentSource({
      id: "issues",
      title: "Issue",
      icon: "CircleDot",
      pickerTitle: "Attach issue",
      searchPlaceholder: "Search",
      search,
    });

    await expect(
      searchPluginAttachments(source, async () => ({ items: [{ id: "issue-1" }] }), "issue"),
    ).rejects.toBeInstanceOf(z.ZodError);
  });
});

describe("controlled agent observer cleanup", () => {
  const installation: PluginInstallation = {
    id: "observer", packageId: "observer", owner: "daemon", version: "1.0.0", generation: 1,
    enabled: true, declaredCapabilities: ["agents.events"], grantedCapabilities: ["agents.events"],
  };

  it("releases a subscription acquired after activation was revoked", async () => {
    const scope = createActivationScope(1);
    const unsubscribe = vi.fn();
    let complete!: (value: { unsubscribe: () => void }) => void;
    const pending = new Promise<{ unsubscribe: () => void }>(resolve => { complete = resolve; });
    const api = { agents: { ref: () => ({ observe: () => pending }) } } as unknown as OmpApi;
    const controlled = createPluginOmpApi(api, installation, scope, { mode: "active" });
    const observation = controlled.agents.ref({} as OmpAgent).observe(() => {});
    await scope.dispose();
    complete({ unsubscribe });
    await expect(observation).rejects.toThrow("generation is no longer active");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps only an owned release callable after abort", async () => {
    const scope = createActivationScope(1);
    const unsubscribe = vi.fn();
    const api = { agents: { ref: () => ({ observe: async () => ({ unsubscribe, snapshot: {} }) }) } } as unknown as OmpApi;
    const controlled = createPluginOmpApi(api, installation, scope, { mode: "active" });
    const observation = await controlled.agents.ref({} as OmpAgent).observe(() => {});
    await scope.dispose();
    await observation.unsubscribe();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(() => observation.snapshot).toThrow("generation is no longer active");
  });
});

it("does not expose agent configuration to an event-only plugin", () => {
  const scope = createActivationScope(1);
  const installation: PluginInstallation = {
    id: "observer", packageId: "observer", owner: "daemon", version: "1.0.0", generation: 1,
    enabled: true, declaredCapabilities: ["agents.events"], grantedCapabilities: ["agents.events"],
  };
  const api = { agents: { ref: () => ({ configuration: () => { throw new Error("Agent configuration was exposed"); } }) } } as unknown as OmpApi;
  const controlled = createPluginOmpApi(api, installation, scope, { mode: "active" });
  expect(() => controlled.agents.ref({} as OmpAgent).configuration()).toThrow("Plugin capability is not granted: agents.configuration");
});

it("requires declared and granted image generation access, including for legacy plugins", async () => {
  const scope = createActivationScope(1);
  const installation: PluginInstallation = {
    id: "canvas", packageId: "canvas", owner: "desktop", version: "1.0.0", generation: 1,
    enabled: true, declaredCapabilities: ["agents.events"], grantedCapabilities: ["agents.events"],
  };
  const generate = vi.fn<OmpApi["images"]["generate"]>().mockResolvedValue({
    data: "aGVsbG8=", mimeType: "image/webp",
  });
  const api = { images: { generate } } as unknown as OmpApi;
  const input = { prompt: "Draw an island", images: [] };
  const eventOnly = createPluginOmpApi(api, installation, scope, { mode: "active", legacy: true });
  expect(() => eventOnly.images.generate(input)).toThrow("Plugin capability is not granted: images.generate");
  const declared = { ...installation, declaredCapabilities: ["agents.events", "images.generate"] };
  const notGranted = createPluginOmpApi(api, declared, scope, { mode: "active" });
  expect(() => notGranted.images.generate(input)).toThrow("Plugin capability is not granted: images.generate");
  const approved = { ...declared, grantedCapabilities: declared.declaredCapabilities };
  const manage = createPluginOmpApi(api, approved, scope, { mode: "manage" });
  expect(() => manage.images.generate(input)).toThrow("unavailable in management mode");
  expect(generate).not.toHaveBeenCalled();

  const active = createPluginOmpApi(api, approved, scope, { mode: "active" });
  const caller = new AbortController();
  await expect(active.images.generate(input, { signal: caller.signal })).resolves.toEqual({
    data: "aGVsbG8=", mimeType: "image/webp",
  });
  const signal = generate.mock.calls[0]?.[1]?.signal;
  expect(signal?.aborted).toBe(false);
  await scope.dispose();
  expect(signal?.aborted).toBe(true);
  expect(caller.signal.aborted).toBe(false);
});

it("keeps provider model data usable by React without proxying frozen element types", async () => {
  const scope = createActivationScope(1);
  const installation: PluginInstallation = {
    id: "models", packageId: "models", owner: "daemon", version: "1.0.0", generation: 1,
    enabled: true, declaredCapabilities: ["agents.events"], grantedCapabilities: ["agents.events"],
  };
  const api = { providers: { listModels: async () => ({ models: [{ id: "codex-mini" }] }) } } as unknown as OmpApi;
  const controlled = createPluginOmpApi(api, installation, scope, { mode: "active" });
  const Label = memo(({ id }: { id: string }) => createElement("span", null, id));
  const models = await controlled.providers.listModels("codex");
  const elements = models.models.map(model => createElement(Label, { id: model.id }));
  expect(elements[0].type).toBe(Label);
  await scope.dispose();
  expect(() => controlled.providers.listModels("codex")).toThrow("generation is no longer active");
});

it("limits disabled Desktop authoring to newly created workspaces and preserves capability checks", async () => {
  const scope = createActivationScope(1);
  const installation: PluginInstallation = {
    id: "authoring", packageId: "authoring", owner: "desktop", version: "1.0.0", generation: 1,
    enabled: false, declaredCapabilities: ["agents.events", "agents.create"], grantedCapabilities: ["agents.events", "agents.create"],
  };
  const workspace = { id: "new-workspace", agents: { create: async () => ({ id: "new-agent" }) }, archive() { throw new Error("Existing workspace mutation reached the host"); } };
  const api = { workspaces: { create: async () => workspace, ref() { throw new Error("Existing workspace reached the host"); } }, agents: { create() { throw new Error("Unplaced agent creation reached the host"); } } } as unknown as OmpApi;
  const managed = createPluginOmpApi(api, installation, scope, { mode: "manage" });
  const created = await managed.workspaces.create({ source: { kind: "directory", path: "/tmp/authoring" } });
  await created.agents.create({ config: { provider: "codex/test" } });
  expect(() => created.archive()).toThrow("Agent operations are unavailable in management mode");
  expect(() => managed.workspaces.ref("existing")).toThrow("Agent operations are unavailable in management mode");
  expect(() => managed.agents.create({ config: { provider: "codex/test" }, cwd: "/tmp" })).toThrow("Agent operations are unavailable in management mode");
  const unapproved = createPluginOmpApi(api, { ...installation, grantedCapabilities: ["agents.events"] }, scope, { mode: "manage" });
  expect(() => unapproved.workspaces.create({ source: { kind: "directory", path: "/tmp/authoring" } })).toThrow("Plugin capability is not granted: agents.create");
  const daemon = createPluginOmpApi(api, { ...installation, owner: "daemon" }, scope, { mode: "manage" });
  expect(() => daemon.workspaces.create({ source: { kind: "directory", path: "/tmp/authoring" } })).toThrow("Agent operations are unavailable in management mode");
  await scope.dispose();
  expect(() => created.agents.create({ config: { provider: "codex/test" } })).toThrow("Plugin generation is no longer active");
});
