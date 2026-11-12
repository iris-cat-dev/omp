import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { parseToolArgs, parseToolResult } from "./tool-call-detail.js";
import { mapOmpToolDetail, mapOmpGeneratedImages } from "./tool-call-mapper.js";

const png = {
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aShoAAAAASUVORK5CYII=",
  mimeType: "image/png",
};
const gif = {
  data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  mimeType: "image/gif",
};

describe("OMP tool call mapper", () => {
  test("projects only completed sandbox-native generated artifacts and displays their relative paths", () => {
    const tool = parseToolArgs("generate_image", { subject: "A pixel" });
    const generatedImages = [{ path: ".qqbot-media/generated/01234567-abcd.png", mimeType: "image/png", name: "pixel.png" }];
    const details = { generatedImagesSource: "omp-sandbox-image", generatedImages, imageCount: 1 };
    const result = parseToolResult({ content: [{ type: "text", text: generatedImages[0]!.path }], details });
    expect(mapOmpGeneratedImages(tool, result, "completed")).toEqual({ generatedImagesSource: "omp-sandbox-image", generatedImages });
    for (const status of ["running", "failed", "canceled"]) expect(mapOmpGeneratedImages(tool, result, status)).toEqual({});
    expect(mapOmpGeneratedImages(parseToolArgs("present_image", {}), result, "completed")).toEqual({});
    expect(mapOmpGeneratedImages(tool, parseToolResult({ content: [], details, isError: true }), "completed")).toEqual({});
    for (const path of ["/tmp/image.png", ".qqbot-media/generated/../image.png", ".qqbot-media/generated/nested/image.png"]) expect(mapOmpGeneratedImages(tool, parseToolResult({ content: [], details: { ...details, generatedImages: [{ path, mimeType: "image/png" }] } }), "completed")).toEqual({});
    expect(mapOmpToolDetail(tool, result, { toolCallId: "image", toolCallStatus: "completed" })).toMatchObject({ label: "Generated image", text: `Saved to ${generatedImages[0]!.path}` });
    const directory = mkdtempSync(join(tmpdir(), "omp-sandbox-image-preview-"));
    try {
      const withBytes = parseToolResult({ content: [], details: { ...details, images: [png] } });
      const card = mapOmpToolDetail(tool, withBytes, { toolCallId: "image", toolCallStatus: "completed", imageOutputDir: directory });
      expect(card).toMatchObject({ label: "Generated image", preview: { type: "image", mimeType: "image/png" } });
      if (card?.type !== "plain_text" || card.preview?.type !== "image") throw new Error("Missing sandbox image preview");
      expect(readFileSync(card.preview.source)).toEqual(Buffer.from(png.data, "base64"));
      expect(mapOmpGeneratedImages(tool, withBytes, "completed")).toEqual({ generatedImagesSource: "omp-sandbox-image", generatedImages });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
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

  test("prefers returned bytes and persists a content-addressed preview for replay", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-native-image-"));
    try {
      const context = { toolCallId: "native", imageOutputDir: join(directory, "blobs") };
      const args = parseToolArgs("generate_image", { subject: "a red fox" });
      const result = parseToolResult({
        details: {
          provider: "openai",
          model: "actual-native-model",
          imageCount: 1,
          imagePaths: [join(directory, "already-deleted.png")],
          images: [png],
        },
      });
      const detail = mapOmpToolDetail(args, result, context);
      const bytes = Buffer.from(png.data, "base64");
      const outputPath = join(
        context.imageOutputDir,
        "generated-images",
        `${createHash("sha256").update(bytes).digest("hex")}.png`,
      );
      expect(detail).toMatchObject({
        type: "plain_text",
        preview: { type: "image", source: outputPath, mimeType: "image/png" },
      });
      expect(readFileSync(outputPath)).toEqual(bytes);
      expect(mapOmpToolDetail(args, result, context)).toEqual(detail);
      expect(JSON.stringify(detail)).not.toContain(png.data);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("restores a paths-only historical result after native temp files disappear", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-native-path-"));
    try {
      const temporaryPath = join(directory, "native.png");
      writeFileSync(temporaryPath, Buffer.from(png.data, "base64"));
      const context = { toolCallId: "path-only", imageOutputDir: join(directory, "blobs") };
      const args = parseToolArgs("generate_image", { subject: "a fox" });
      const result = parseToolResult({ details: { imageCount: 1, imagePaths: [temporaryPath] } });
      const detail = mapOmpToolDetail(args, result, context);
      expect(detail).toMatchObject({ label: "Generated image", preview: { type: "image" } });
      rmSync(temporaryPath);
      expect(
        mapOmpToolDetail(args, parseToolResult(JSON.parse(JSON.stringify(result))), context),
      ).toEqual(detail);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("maps xd start, update, and end as the native image operation", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-xd-image-"));
    try {
      const args = parseToolArgs("write", {
        path: "xd://generate_image",
        content: '{"subject":"draft fox"}',
      });
      const context = { toolCallId: "xd-image", imageOutputDir: directory };
      const pending = mapOmpToolDetail(args, null, context);
      expect(pending?.type === "plain_text" ? pending.preview : undefined).toBeUndefined();
      const dispatch = {
        tool: "generate_image",
        mode: "execute",
        args: { subject: "validated fox", model: "native" },
      };
      const update = mapOmpToolDetail(
        args,
        parseToolResult({
          content: [{ type: "text", text: "Waiting for provider" }],
          details: { xdev: { ...dispatch, inner: { model: "native" } } },
        }),
        { ...context, toolCallStatus: "running" },
      );
      expect(update?.type === "plain_text" ? update.preview : undefined).toBeUndefined();
      expect(
        mapOmpToolDetail(
          args,
          parseToolResult({
            details: {
              xdev: {
                ...dispatch,
                inner: { imageCount: 1, images: [png], imagePaths: ["/missing/native.png"] },
              },
            },
          }),
          { ...context, toolCallStatus: "completed" },
        ),
      ).toMatchObject({
        preview: { type: "image", mimeType: "image/png" },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("preserves every output path and explicitly identifies the primary preview", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-multiple-image-"));
    try {
      const detail = mapOmpToolDetail(
        parseToolArgs("generate_image", { subject: "foxes" }),
        parseToolResult({
          details: {
            imageCount: 3,
            images: [png, gif],
            imagePaths: ["/missing/one.png", "/missing/two.gif", "/missing/three.png"],
          },
        }),
        { toolCallId: "multiple", imageOutputDir: directory },
      );
      expect(detail).toMatchObject({ preview: { mimeType: "image/png" } });
      if (detail?.type !== "plain_text") throw new Error("Expected image detail");
      for (const [image, extension] of [
        [png, "png"],
        [gif, "gif"],
      ] as const) {
        const hash = createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex");
        const imagePath = join(directory, "generated-images", `${hash}.${extension}`);
        expect(detail.text).toContain(imagePath);
        expect(readFileSync(imagePath)).toEqual(Buffer.from(image.data, "base64"));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not expose a preview for failed, empty or malformed image results", () => {
    const args = parseToolArgs("generate_image", { subject: "fox" });
    const results = [
      parseToolResult({ isError: true, details: { imageCount: 1, images: [png] } }),
      parseToolResult({ details: { imageCount: 0, imagePaths: [], images: [] } }),
      parseToolResult({
        details: { imageCount: 1, images: [{ data: "not-base64", mimeType: "image/png" }] },
      }),
    ];
    for (const result of results) {
      const detail = mapOmpToolDetail(args, result);
      expect(detail?.type).toBe("plain_text");
      expect(detail?.type === "plain_text" ? detail.preview : undefined).toBeUndefined();
    }
    for (const status of ["failed", "completed"] as const) {
      const detail = mapOmpToolDetail(args, null, { toolCallId: "empty", toolCallStatus: status });
      expect(detail?.type === "plain_text" ? detail.preview : undefined).toBeUndefined();
    }
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

  test("shares image identity between generation and publication, including replay after temp cleanup", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-published-image-"));
    try {
      const generatedPath = join(directory, "generated.png");
      const publishedPath = join(directory, "published.png");
      const bytes = Buffer.from(png.data, "base64");
      writeFileSync(generatedPath, bytes);
      writeFileSync(publishedPath, bytes);
      const context = { toolCallId: "image", imageOutputDir: join(directory, "blobs") };
      const generated = mapOmpToolDetail(
        parseToolArgs("generate_image", { subject: "a cat" }),
        parseToolResult({ details: { imageCount: 1, imagePaths: [generatedPath] } }),
        context,
      );
      const args = parseToolArgs("present_image", { path: publishedPath, alt: "A cat" });
      const result = parseToolResult({
        details: { status: "published", filePath: publishedPath, mimeType: "image/png" },
      });
      const published = mapOmpToolDetail(args, result, context);
      if (generated?.type !== "plain_text" || !generated.preview) {
        throw new Error("Expected generated image preview");
      }
      expect(published).toMatchObject({
        preview: { source: generated.preview.source, mimeType: "image/png", alt: "A cat" },
      });
      expect(readFileSync(generated.preview.source)).toEqual(bytes);
      rmSync(generatedPath);
      rmSync(publishedPath);
      expect(mapOmpToolDetail(args, result, context)).toEqual(published);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("falls back to shared unknown detail for unmapped tools", () => {
    expect(mapOmpToolDetail(parseToolArgs("lsp", { op: "hover" }), null)).toEqual({
      type: "unknown",
      input: { op: "hover" },
      output: null,
    });
  });
});
