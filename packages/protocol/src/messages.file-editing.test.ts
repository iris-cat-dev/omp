import { describe, expect, test } from "vitest";
import {
  FileEntryCreateRequestSchema,
  FileExplorerResponseSchema,
  FileSubscribeRequestSchema,
  FileSubscribeResponseSchema,
  FileUnsubscribeRequestSchema,
  FileUpdateSchema,
  FileWriteRequestSchema,
  FileWriteResponseSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("workspace file editing messages", () => {
  test("keeps the capability optional for older server info payloads", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: {},
      }).features?.workspaceFileEditing,
    ).toBeUndefined();
  });

  test("scoped creates require initial content and cannot parse as a legacy create", () => {
    const request = {
      type: "workspace.files.create.request",
      workspaceId: "workspace-1",
      scope: "project",
      path: "canvases/diagram.canva.json",
      entry: { kind: "file", contentBase64: "e30=" },
      requestId: "request-1",
    };
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    expect(FileEntryCreateRequestSchema.safeParse(request).success).toBe(false);
    for (const entry of [{ kind: "file" }, { kind: "file", contentBase64: "not base64" }]) {
      expect(SessionInboundMessageSchema.safeParse({ ...request, entry }).success).toBe(false);
    }
    const response = {
      type: "workspace.files.create.response",
      payload: { requestId: "request-1", result: { status: "created" } },
    };
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  });

  test("adds an optional structured absence code to explorer responses", () => {
    const response = {
      type: "file_explorer_response",
      payload: {
        cwd: "/workspace",
        path: "canvases",
        mode: "list",
        directory: null,
        file: null,
        error: "No such file or directory",
        requestId: "request-1",
      },
    };
    expect(FileExplorerResponseSchema.parse(response)).toEqual(response);
    const missing = { ...response, payload: { ...response.payload, errorCode: "not_found" } };
    expect(FileExplorerResponseSchema.parse(missing)).toEqual(missing);
  });

  test("parses subscribe, unsubscribe, and version update messages", () => {
    expect(
      FileSubscribeRequestSchema.parse({
        type: "fs.file.subscribe.request",
        cwd: "/workspace",
        path: "file.ts",
        subscriptionId: "subscription-1",
        requestId: "request-1",
      }).subscriptionId,
    ).toBe("subscription-1");
    expect(
      FileSubscribeResponseSchema.parse({
        type: "fs.file.subscribe.response",
        payload: {
          subscriptionId: "subscription-1",
          initial: {
            status: "ready",
            cwd: "/workspace",
            path: "file.ts",
            size: 12,
            modifiedAt: "2026-07-18T00:00:00.000Z",
          },
          requestId: "request-1",
        },
      }).payload.initial.status,
    ).toBe("ready");
    expect(
      FileUnsubscribeRequestSchema.parse({
        type: "fs.file.unsubscribe.request",
        subscriptionId: "subscription-1",
        requestId: "request-2",
      }).subscriptionId,
    ).toBe("subscription-1");
    expect(
      FileUpdateSchema.parse({
        type: "fs.file.update",
        payload: {
          subscriptionId: "subscription-1",
          version: { status: "missing", cwd: "/workspace", path: "file.ts" },
        },
      }).payload.version.status,
    ).toBe("missing");
  });

  test("parses optimistic write requests and conflict responses", () => {
    expect(
      FileWriteRequestSchema.parse({
        type: "fs.file.write.request",
        cwd: "/workspace",
        path: "file.ts",
        content: "const value = 1;\n",
        expectedModifiedAt: "2026-07-18T00:00:00.000Z",
        requestId: "request-1",
      }).content,
    ).toBe("const value = 1;\n");
    expect(
      FileWriteResponseSchema.parse({
        type: "fs.file.write.response",
        payload: {
          result: {
            status: "conflict",
            version: {
              status: "ready",
              cwd: "/workspace",
              path: "file.ts",
              size: 20,
              modifiedAt: "2026-07-18T00:00:01.000Z",
            },
          },
          requestId: "request-1",
        },
      }).payload.result.status,
    ).toBe("conflict");
  });
});
