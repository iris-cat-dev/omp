import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { VisualFeedbackRequest } from "@omp-desktop/protocol/visual-feedback";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { VisualFeedbackService } from "../../visual-feedback-service.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

const directories: string[] = [];
const services: VisualFeedbackService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function catalog(cwd: string, service?: VisualFeedbackService, callerAgentId = "agent-1") {
  return createPaseoToolCatalog({
    agentManager: { getAgent: () => ({ cwd }) } as unknown as AgentManager,
    agentStorage: {} as AgentStorage,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    visualFeedbackService: service,
    callerAgentId,
    logger: pino({ level: "silent" }),
  });
}

function setup() {
  const service = new VisualFeedbackService();
  services.push(service);
  const opened = Promise.withResolvers<VisualFeedbackRequest>();
  service.subscribe((requests) => {
    if (requests[0]) opened.resolve(requests[0]);
  });
  return { service, opened: opened.promise };
}

describe("request_visual_feedback", () => {
  it("waits for the user's submission and returns original and annotated image content to the model", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "visual-feedback-tool-"));
    directories.push(directory);
    const pixels = await sharp({
      create: { width: 20, height: 10, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await writeFile(path.join(directory, "review.png"), pixels);
    const { service, opened } = setup();
    let completed = false;
    const result = catalog(directory, service)
      .executeTool("request_visual_feedback", {
        imagePath: "review.png",
        title: "Layout",
        instructions: "Mark the problem",
        text: "Initial copy",
      })
      .then((value) => {
        completed = true;
        return value;
      });
    const request = await opened;
    expect(request).toMatchObject({
      agentId: "agent-1",
      title: "Layout",
      instructions: "Mark the problem",
      text: "Initial copy",
    });
    expect(request.image?.data).toBe(pixels.toString("base64"));
    expect(completed).toBe(false);
    const annotation = { kind: "point" as const, id: "a", text: "Align", x: 2, y: 3 };
    await service.respond(request.id, {
      status: "submitted",
      submission: {
        text: "Revised copy",
        feedback: "Please align this",
        annotations: [annotation],
        image: request.image,
        preview: request.image,
      },
    });
    const response = await result;
    const expectedSummary = {
      status: "submitted",
      coordinateSpace: "original-image-pixels",
      coordinateOrigin: "top-left",
      submission: {
        text: "Revised copy",
        feedback: "Please align this",
        annotations: [{ number: 1, ...annotation }],
        image: { width: 20, height: 10, mimeType: "image/png" },
        preview: { width: 20, height: 10, mimeType: "image/png" },
      },
    };
    expect(response.content[0]?.type).toBe("text");
    expect(JSON.parse(response.content[0]?.text ?? "")).toEqual(expectedSummary);
    expect(response.structuredContent).toEqual(expectedSummary);
    expect(JSON.stringify(response.structuredContent)).not.toContain(pixels.toString("base64"));
    expect(response.content.filter((block) => block.type === "image")).toEqual([
      { type: "image", data: pixels.toString("base64"), mimeType: "image/png" },
      { type: "image", data: pixels.toString("base64"), mimeType: "image/png" },
    ]);
  });

  it("exposes cancellation separately and never returns the initial text draft", async () => {
    const { service, opened } = setup();
    const result = catalog("/tmp", service).executeTool("request_visual_feedback", {
      text: "private draft",
    });
    const request = await opened;
    await service.respond(request.id, { status: "cancelled" });
    const response = await result;
    expect(response.structuredContent).toEqual({ status: "cancelled" });
    expect(JSON.stringify(response)).not.toContain("private draft");
  });

  it("propagates tool abort and does not register without the service", async () => {
    const { service, opened } = setup();
    const controller = new AbortController();
    const result = catalog("/tmp", service).executeTool(
      "request_visual_feedback",
      {},
      { signal: controller.signal },
    );
    await opened;
    controller.abort();
    expect((await result).structuredContent).toEqual({ status: "cancelled" });
    expect(service.list()).toEqual([]);
    expect(catalog("/tmp").getTool("request_visual_feedback")).toBeUndefined();
  });

  it("clearly rejects a host/MCP invocation without callerAgentId", async () => {
    const { service } = setup();
    await expect(
      catalog("/tmp", service, "").executeTool("request_visual_feedback", {}),
    ).rejects.toThrow("callerAgentId");
    expect(service.list()).toEqual([]);
  });
});
