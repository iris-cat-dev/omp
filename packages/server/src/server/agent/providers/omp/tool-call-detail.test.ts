import { describe, expect, test } from "vitest";

import {
  parseToolArgs,
  parseToolResult,
  resolveToolCallName,
  resolveXdevToolCall,
} from "./tool-call-detail.js";

describe("OMP native device dispatch", () => {
  test("separates normalized intent from business input without changing device dispatch", () => {
    const args = {
      i: "  Opening browser... ",
      path: "xd://browser",
      content: '{"url":"https://example.com"}',
    };
    const tracked = parseToolArgs("write", args);
    expect(tracked.intent).toBe("Opening browser");
    expect(tracked.args).toEqual({ path: args.path, content: args.content });
    expect(args.i).toBe("  Opening browser... ");
    expect(resolveToolCallName(tracked)).toBe("browser");
    expect(parseToolArgs("read", { path: "source.ts", i: "fallback" }, "...  ").intent).toBe(
      "fallback",
    );
    expect(parseToolArgs("read", { path: "source.ts", i: 42 }).intent).toBeUndefined();
  });

  test("identifies a pending image device before result metadata exists", () => {
    const args = parseToolArgs("write", {
      path: "xd://generate_image",
      content: '{"subject":"fox"}',
    });
    expect(resolveToolCallName(args)).toBe("generate_image");
    expect(resolveXdevToolCall(args)).toEqual({
      toolCall: { kind: "unknown", toolName: "generate_image", args: { subject: "fox" } },
      result: null,
    });
    expect(
      resolveToolCallName(
        parseToolArgs("write", {
          path: "xd://generate_image",
          content: '{"subject":',
        }),
      ),
    ).toBe("generate_image");
  });

  test("uses validated xdev args and unwraps inner details without losing errors", () => {
    const args = parseToolArgs("write", {
      path: "xd://generate_image",
      content: '{"subject":"draft"}',
    });
    const inner = {
      provider: "openai",
      model: "actual",
      imageCount: 0,
      images: [],
      imagePaths: [],
    };
    const result = parseToolResult({
      isError: true,
      content: [{ type: "text", text: "Provider failed" }],
      details: {
        xdev: { tool: "generate_image", mode: "execute", args: { subject: "validated" }, inner },
      },
    });
    expect(resolveXdevToolCall(args, result)).toEqual({
      toolCall: { kind: "unknown", toolName: "generate_image", args: { subject: "validated" } },
      result: {
        isError: true,
        content: [{ type: "text", text: "Provider failed" }],
        details: inner,
      },
    });
    expect(resolveToolCallName(args, result)).toBe("generate_image");
  });

  test("does not interpret docs requests or regular file writes as generation", () => {
    for (const content of ["", "?", "help"]) {
      const args = parseToolArgs("write", { path: "xd://generate_image", content });
      expect(resolveToolCallName(args)).toBe("write");
      expect(resolveXdevToolCall(args)).toBeNull();
    }
    const args = parseToolArgs("write", {
      path: "xd://generate_image",
      content: '{"subject":"fox"}',
    });
    expect(
      resolveToolCallName(
        args,
        parseToolResult({
          details: { xdev: { tool: "generate_image", mode: "help" } },
        }),
      ),
    ).toBe("write");
    expect(
      resolveXdevToolCall(
        parseToolArgs("write", { path: "generated.png", content: "image bytes" }),
      ),
    ).toBeNull();
    expect(resolveToolCallName(parseToolArgs("generate_image", { subject: "fox" }))).toBe(
      "generate_image",
    );
  });
});
