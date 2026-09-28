import { describe, expect, test } from "vitest";

import { parseToolArgs, parseToolResult } from "./tool-call-detail.js";
import { mapOmpToolDetail } from "./tool-call-mapper.js";

describe("OMP tool call mapper", () => {
  test("maps OMP bash, read, hashline edit, and write calls", () => {
    expect(
      mapOmpToolDetail(
        parseToolArgs("bash", { command: "echo hi" }),
        parseToolResult({
          content: [{ type: "text", text: "hi\n\n\nWall time: 0.02 seconds" }],
        }),
      ),
    ).toEqual({
      type: "shell",
      command: "echo hi",
      output: "hi\n\n\nWall time: 0.02 seconds",
      exitCode: null,
    });
    expect(
      mapOmpToolDetail(
        parseToolArgs("read", { path: "fixture.txt" }),
        parseToolResult({
          content: [{ type: "text", text: "[fixture.txt#0063]\n1:alpha\n2:beta\n3:" }],
          details: { displayContent: { text: "alpha\nbeta\n" } },
        }),
      ),
    ).toEqual({
      type: "read",
      filePath: "fixture.txt",
      content: "alpha\nbeta\n",
      offset: undefined,
      limit: undefined,
    });
    expect(
      mapOmpToolDetail(
        parseToolArgs("edit", {
          input: "*** Begin Patch\n[fixture.txt#0063]\nSWAP 2.=2:\n+gamma\n*** End Patch\n",
        }),
        parseToolResult({
          content: [],
          details: {
            path: "fixture.txt",
            oldText: "alpha\nbeta\n",
            newText: "alpha\ngamma\n",
            diff: " 1|alpha\n-2|beta\n+2|gamma",
          },
        }),
      ),
    ).toEqual({
      type: "edit",
      filePath: "fixture.txt",
      oldString: "alpha\nbeta\n",
      newString: "alpha\ngamma\n",
      unifiedDiff: " 1|alpha\n-2|beta\n+2|gamma",
    });
    expect(
      mapOmpToolDetail(
        parseToolArgs("write", { path: "created.txt", content: "hello write" }),
        null,
      ),
    ).toEqual({
      type: "write",
      filePath: "created.txt",
      content: "hello write",
    });
  });

  test("maps task to sub-agent detail and suppresses todo raw cards", () => {
    expect(
      mapOmpToolDetail(
        parseToolArgs("task", {
          agent: "explore",
          description: "Inspect the target files",
        }),
        null,
      ),
    ).toEqual({
      type: "sub_agent",
      subAgentType: "explore",
      description: "Inspect the target files",
      log: "",
    });
    expect(mapOmpToolDetail(parseToolArgs("todo", { op: "view" }), null)).toBeNull();
  });

  test("uses task result text and transcript path as the best static replay detail", () => {
    expect(
      mapOmpToolDetail(
        parseToolArgs("task", {
          agent: "explore",
          description: "Inspect the target files",
        }),
        parseToolResult({
          content: [
            {
              type: "text",
              text: "done\ntranscript: /tmp/omp-task-static/Explore.jsonl",
            },
          ],
        }),
      ),
    ).toEqual({
      type: "sub_agent",
      subAgentType: "explore",
      description: "Inspect the target files",
      childSessionId: "/tmp/omp-task-static/Explore.jsonl",
      log: "done\ntranscript: /tmp/omp-task-static/Explore.jsonl",
    });
  });

  test("maps image generation output to a backward-compatible inline preview", () => {
    expect(
      mapOmpToolDetail(
        parseToolArgs("image_gen", { prompt: "a red fox" }),
        parseToolResult({
          content: [{ type: "text", text: "Generated image" }],
          details: {
            prompt: "a red fox",
            filePath: "/tmp/generated.png",
            mimeType: "image/png",
          },
        }),
      ),
    ).toEqual({
      type: "plain_text",
      label: "Generated image",
      text: "Saved to /tmp/generated.png",
      icon: "sparkles",
      preview: {
        type: "image",
        source: "/tmp/generated.png",
        mimeType: "image/png",
        alt: "a red fox",
      },
    });
    expect(mapOmpToolDetail(parseToolArgs("image_gen", { prompt: "a red fox" }), null)).toEqual({
      type: "plain_text",
      label: "Generating image",
      text: "a red fox",
      icon: "sparkles",
    });
    expect(
      mapOmpToolDetail(
        parseToolArgs("image_gen", {
          prompt: "combine the subject and style",
          referenceImagePaths: ["/tmp/subject.png", "/tmp/style.png"],
        }),
        null,
      ),
    ).toEqual({
      type: "plain_text",
      label: "Generating image",
      text: "combine the subject and style · Using 2 reference images",
      icon: "sparkles",
    });
    expect(
      mapOmpToolDetail(
        parseToolArgs("image_gen", { prompt: "a red fox" }),
        parseToolResult({
          content: [{ type: "text", text: "Waiting for provider" }],
          details: {
            type: "image_generation_progress",
            prompt: "a red fox",
            elapsedSeconds: 195,
          },
        }),
      ),
    ).toEqual({
      type: "plain_text",
      label: "Generating image",
      text: "Waiting for the image provider · 3m 15s elapsed",
      icon: "sparkles",
    });
  });

  test("maps present_image published output to an inline preview", () => {
    expect(
      mapOmpToolDetail(
        parseToolArgs("present_image", { path: "/tmp/qr.png", alt: "WeChat login QR code" }),
        parseToolResult({
          content: [{ type: "text", text: "Published the image" }],
          details: {
            status: "published",
            filePath: "/tmp/qr.png",
            mimeType: "image/png",
            alt: "WeChat login QR code",
          },
        }),
      ),
    ).toEqual({
      type: "plain_text",
      label: "Presented image",
      text: "Published /tmp/qr.png",
      icon: "sparkles",
      preview: {
        type: "image",
        source: "/tmp/qr.png",
        mimeType: "image/png",
        alt: "WeChat login QR code",
      },
    });
    expect(mapOmpToolDetail(parseToolArgs("present_image", { path: "/tmp/qr.png" }), null)).toEqual(
      {
        type: "plain_text",
        label: "Presenting image",
        text: "/tmp/qr.png",
        icon: "sparkles",
      },
    );
  });

  test("falls back to shared unknown detail for unmapped tools", () => {
    expect(mapOmpToolDetail(parseToolArgs("lsp", { op: "hover" }), null)).toEqual({
      type: "unknown",
      input: { op: "hover" },
      output: null,
    });
  });
});
