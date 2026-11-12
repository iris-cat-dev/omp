import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAttachmentSource, defineRpc } from "./index.js";
import { callPluginRpc, searchPluginAttachments } from "./host.js";
import type { PaseoApi, PaseoAgent } from "@omp-desktop/client";
import { createActivationScope } from "./activation.js";
import { createPluginPaseoApi } from "./paseo-api.js";
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
    const api = { agents: { ref: () => ({ observe: () => pending }) } } as unknown as PaseoApi;
    const controlled = createPluginPaseoApi(api, installation, scope, { mode: "active" });
    const observation = controlled.agents.ref({} as PaseoAgent).observe(() => {});
    await scope.dispose();
    complete({ unsubscribe });
    await expect(observation).rejects.toThrow("generation is no longer active");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps only an owned release callable after abort", async () => {
    const scope = createActivationScope(1);
    const unsubscribe = vi.fn();
    const api = { agents: { ref: () => ({ observe: async () => ({ unsubscribe, snapshot: {} }) }) } } as unknown as PaseoApi;
    const controlled = createPluginPaseoApi(api, installation, scope, { mode: "active" });
    const observation = await controlled.agents.ref({} as PaseoAgent).observe(() => {});
    await scope.dispose();
    await observation.unsubscribe();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(() => observation.snapshot).toThrow("generation is no longer active");
  });
});
