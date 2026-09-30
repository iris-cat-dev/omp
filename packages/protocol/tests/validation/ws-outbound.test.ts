import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { describe, expect, it } from "vitest";
import { compileSharedSchemas } from "../../scripts/compile-shared-validation.mjs";
import { WSOutboundMessageSchema as GeneratedWSOutboundMessageSchema } from "../../src/generated/validation/ws-outbound.aot.js";

interface GeneratedSchema {
  safeParse(input: unknown): { success: boolean; data?: unknown };
}

const protocolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);

async function compileSchema(
  sourceSchema: string,
  mode: "shared" | "inline" = "shared",
): Promise<GeneratedSchema> {
  const scratchRoot = resolve(protocolRoot, "../../.tmp");
  await mkdir(scratchRoot, { recursive: true });
  const tempDir = await mkdtemp(join(scratchRoot, "paseo-zod-aot-"));

  try {
    const sourcePath = join(tempDir, "schema.source.js");
    const outputPath = join(tempDir, "schema.generated.ts");
    await writeFile(join(tempDir, "package.json"), '{"type":"module"}\n');
    await writeFile(
      sourcePath,
      [
        'import { z } from "zod";',
        'import { compile } from "zod-aot";',
        sourceSchema,
        "export const Schema = compile(SourceSchema);",
        "",
      ].join("\n"),
    );

    const zodAotEntry = require.resolve("zod-aot");
    const zodAotRoot = resolve(dirname(zodAotEntry), "..");
    const [
      { discoverSchemas },
      { compileSchemas },
      { extractSchema },
      { generateFast },
      { generateSlow },
      context,
      { generateCompiledFileContent },
    ] = await Promise.all([
      import(pathToFileURL(resolve(zodAotRoot, "dist/discovery.js")).href),
      import(pathToFileURL(resolve(zodAotRoot, "dist/core/pipeline.js")).href),
      import(pathToFileURL(resolve(zodAotRoot, "dist/core/extract/index.js")).href),
      import(pathToFileURL(resolve(zodAotRoot, "dist/core/codegen/fast-path.js")).href),
      import(pathToFileURL(resolve(zodAotRoot, "dist/core/codegen/slow-path.js")).href),
      import(pathToFileURL(resolve(zodAotRoot, "dist/core/codegen/context.js")).href),
      import(pathToFileURL(resolve(zodAotRoot, "dist/cli/emitter.js")).href),
    ]);

    const schemas = await discoverSchemas(sourcePath, { cacheBust: true });
    const compiled =
      mode === "inline"
        ? compileSchemas(schemas, { mode: "inline" })
        : compileSharedSchemas(schemas, { extractSchema, generateFast, generateSlow, context });
    const content = generateCompiledFileContent(compiled, "./schema.source.js", {
      zodCompat: false,
    });
    await writeFile(outputPath, content);

    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const generated = await jiti.import(outputPath);
    return generated.Schema as GeneratedSchema;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

const sharedSchemaSource = `
const Shared = z.object({
  id: z.string().min(2),
  values: z.array(z.number().int()),
  coordinates: z.tuple([z.number(), z.number()]),
  state: z.enum(["running", "completed", "failed", "canceled"]),
  label: z.string().optional(),
});
`;

describe("WS outbound zod-aot validation", () => {
  it("preserves shared fast-path data and ordered nested union errors", async () => {
    const source = `${sharedSchemaSource}
const SourceSchema = z.object({
  left: Shared,
  right: z.array(Shared),
  records: z.record(z.string(), Shared),
  choice: z.union([z.object({ data: Shared }), z.object({ other: Shared })]),
});
`;
    const [shared, inline] = await Promise.all([
      compileSchema(source),
      compileSchema(source, "inline"),
    ]);
    const item = { id: "ok", values: [1, 2], coordinates: [0, 1], state: "running" };
    const valid = { left: item, right: [item], records: { first: item }, choice: { data: item } };
    expect(shared.safeParse(valid)).toEqual({ success: true, data: valid });
    // An absent optional property must not become an own undefined property.
    expect(shared.safeParse(valid)).toEqual(inline.safeParse(valid));
    const invalid = {
      left: item,
      right: [{ ...item, id: 3 }],
      records: { first: { ...item, id: false } },
      choice: { data: { ...item, values: ["bad"] }, other: null },
    };
    expect(shared.safeParse(invalid)).toEqual(inline.safeParse(invalid));
    expect(shared.safeParse(invalid)).toMatchObject({
      success: false,
      error: {
        issues: [
          { code: "invalid_type", path: ["right", 0, "id"] },
          { code: "invalid_type", path: ["records", "first", "id"] },
          { code: "invalid_union", path: ["choice"] },
        ],
      },
    });
  });

  it("keeps defaults, transforms and fallback stripping beside shared validators", async () => {
    const source = `${sharedSchemaSource}
const Checked = z.object({ token: z.string(), nested: Shared }).superRefine((value, ctx) => {
  if (value.token !== "ok") ctx.addIssue({ code: "custom", path: ["token"], message: "bad token" });
});
const OtherChecked = z.object({ token: z.string(), nested: Shared }).superRefine((value, ctx) => {
  if (value.token !== "other") ctx.addIssue({ code: "custom", path: ["token"], message: "other token" });
});
const fields = {
  items: z.array(Shared),
  enabled: z.boolean().default(true),
  clean: z.string().transform((value) => value.trim()),
  checked: Checked,
  otherChecked: OtherChecked,
};
const SourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("first"), ...fields }),
  z.object({ type: z.literal("second"), ...fields }),
]);
`;
    const [shared, inline] = await Promise.all([
      compileSchema(source),
      compileSchema(source, "inline"),
    ]);
    const item = { id: "ok", values: [1], coordinates: [0, 1], state: "completed" };
    for (const type of ["first", "second"]) {
      const input = {
        type,
        items: [item],
        clean: "  trimmed  ",
        checked: { token: "ok", nested: item, stripMe: true },
        otherChecked: { token: "other", nested: item, stripMe: true },
      };
      expect(shared.safeParse(input)).toEqual({
        success: true,
        data: {
          type,
          items: [item],
          enabled: true,
          clean: "trimmed",
          checked: { token: "ok", nested: item },
          otherChecked: { token: "other", nested: item },
        },
      });
      expect(shared.safeParse(input)).toEqual(inline.safeParse(input));
      const invalid = {
        ...input,
        items: [{ ...item, id: false }],
        checked: { ...input.checked, token: "bad" },
        otherChecked: { ...input.otherChecked, token: "bad" },
      };
      expect(shared.safeParse(invalid)).toEqual(inline.safeParse(invalid));
      expect(shared.safeParse(invalid)).toMatchObject({
        success: false,
        error: {
          issues: [
            { code: "invalid_type", path: ["items", 0, "id"] },
            { code: "custom", path: ["checked", "token"] },
            { code: "custom", path: ["otherChecked", "token"] },
          ],
        },
      });
    }
  });

  it("applies defaults inside discriminated-union branches", async () => {
    const schema = await compileSchema(`
const SourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("with_default"),
    enabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("without_default"),
    label: z.string(),
  }),
]);
`);

    expect(schema.safeParse({ type: "with_default" })).toMatchObject({
      success: true,
      data: { type: "with_default", enabled: true },
    });
  });

  it("routes tool-call-like status unions through the current sequential item union", async () => {
    const schema = await compileSchema(`
const ToolCallItemSchema = z.discriminatedUnion("status", [
  z.object({ type: z.literal("tool_call"), status: z.literal("running"), callId: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("completed"), callId: z.string(), output: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("failed"), callId: z.string(), error: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("canceled"), callId: z.string() }),
]);

const TimelineItemSchema = z.union([
  z.object({ type: z.literal("assistant_message"), text: z.string() }),
  ToolCallItemSchema,
]);

const SourceSchema = z.object({
  item: TimelineItemSchema,
});
`);

    expect(
      schema.safeParse({ item: { type: "tool_call", status: "running", callId: "run" } }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "running", callId: "run" } },
    });
    expect(
      schema.safeParse({
        item: { type: "tool_call", status: "completed", callId: "done", output: "ok" },
      }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "completed", callId: "done", output: "ok" } },
    });
    expect(
      schema.safeParse({
        item: { type: "tool_call", status: "failed", callId: "fail", error: "boom" },
      }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "failed", callId: "fail", error: "boom" } },
    });
    expect(
      schema.safeParse({ item: { type: "tool_call", status: "canceled", callId: "stop" } }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "canceled", callId: "stop" } },
    });
  });

  it("accepts a minimal valid envelope and rejects a corrupted envelope", () => {
    expect(GeneratedWSOutboundMessageSchema.safeParse({ type: "pong" }).success).toBe(true);
    expect(GeneratedWSOutboundMessageSchema.safeParse({ type: "not_a_message" }).success).toBe(
      false,
    );
  });

  it("accepts project config responses with and without setup commit status", () => {
    const payload = {
      requestId: "project-config-read",
      repoRoot: "/repo",
      ok: true,
      config: null,
      revision: null,
    };
    const envelope = (
      responsePayload: typeof payload & {
        hasUncommittedWorktreeSetupChanges?: boolean;
      },
    ) => ({
      type: "session",
      message: {
        type: "read_project_config_response",
        payload: responsePayload,
      },
    });

    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope(payload)).success).toBe(true);
    expect(
      GeneratedWSOutboundMessageSchema.safeParse(
        envelope({ ...payload, hasUncommittedWorktreeSetupChanges: true }),
      ).success,
    ).toBe(true);
  });

  it("accepts a compact provider snapshot envelope", () => {
    const envelope = {
      type: "session",
      message: {
        type: "get_providers_snapshot_response",
        payload: {
          entries: [],
          compactSnapshot: {
            entries: [
              {
                provider: "pi",
                status: "ready",
                enabled: true,
                models: [{ id: "model-a", label: "Model A", thinkingSet: 0 }],
              },
            ],
            thinkingSets: [
              {
                options: [{ id: "high", label: "High", isDefault: true }],
                defaultOptionId: "high",
              },
            ],
          },
          snapshotHash: "snapshot-hash",
          generatedAt: "2026-08-04T00:00:00.000Z",
          requestId: "provider-snapshot",
        },
      },
    };

    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope)).toEqual({
      success: true,
      data: envelope,
    });
  });

  it.each([
    {
      name: "dedicated attention message",
      message: {
        type: "agent_attention_required",
        payload: {
          agentId: "agent-1",
          reason: "finished",
          timestamp: "2026-07-22T18:00:00.000Z",
          shouldNotify: true,
          notification: {
            title: "Agent finished",
            body: "Done",
            data: {
              serverId: "server-1",
              workspaceId: "workspace-1",
              agentId: "agent-1",
              reason: "finished",
            },
          },
        },
      },
    },
    {
      name: "agent stream attention event",
      message: {
        type: "agent_stream",
        payload: {
          agentId: "agent-1",
          timestamp: "2026-07-22T18:00:00.000Z",
          event: {
            type: "attention_required",
            provider: "codex",
            reason: "finished",
            timestamp: "2026-07-22T18:00:00.000Z",
            shouldNotify: true,
            notification: {
              title: "Agent finished",
              body: "Done",
              data: {
                serverId: "server-1",
                workspaceId: "workspace-1",
                agentId: "agent-1",
                reason: "finished",
              },
            },
          },
        },
      },
    },
  ])("preserves workspaceId in a $name", ({ message }) => {
    const envelope = { type: "session", message };

    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope)).toEqual({
      success: true,
      data: envelope,
    });
  });

  it("accepts a forge.search.response envelope", () => {
    const result = GeneratedWSOutboundMessageSchema.safeParse({
      type: "session",
      message: {
        type: "forge.search.response",
        payload: {
          items: [
            {
              kind: "change_request",
              number: 17,
              title: "Fix search",
              url: "https://gitlab.com/acme/repo/-/merge_requests/17",
              state: "open",
              body: null,
              labels: [],
            },
          ],
          authState: "authenticated",
          error: null,
          requestId: "search-forge",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a legacy github_search_response envelope", () => {
    const result = GeneratedWSOutboundMessageSchema.safeParse({
      type: "session",
      message: {
        type: "github_search_response",
        payload: {
          items: [
            {
              kind: "pr",
              number: 42,
              title: "Legacy PR",
              url: "https://github.com/acme/repo/pull/42",
              state: "open",
              body: null,
              labels: [],
            },
          ],
          featuresEnabled: true,
          githubFeaturesEnabled: true,
          authState: "authenticated",
          error: null,
          requestId: "search-github",
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
