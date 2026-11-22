import { expect, test } from "vitest";
import {
  GeneratedImageSchema,
  ImageGenerationInputSchema,
  MAX_GENERATED_IMAGE_BYTES,
} from "./image-generation.js";
import { WSInboundMessageSchema } from "./messages.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

const requestId = "00000000-0000-4000-8000-000000000001";
const image = { mimeType: "image/png", data: "aGVsbG8=" } as const;

test("validates direct generation and its cancellation and result envelopes", () => {
  const input = { prompt: "Draw an island", images: [image] };
  for (const message of [
    { type: "images.generate.request", requestId, input },
    { type: "images.generate.cancel", requestId },
  ]) {
    const envelope = { type: "session", message };
    expect(WSInboundMessageSchema.parse(envelope)).toEqual(envelope);
  }
  for (const payload of [{ requestId, ok: true, image }, { requestId, ok: false, error: "Canceled" }]) {
    const envelope = { type: "session", message: { type: "images.generate.response", payload } };
    expect(validateWSOutboundMessage(envelope)).toEqual({ success: true, data: envelope });
  }
  expect(validateWSOutboundMessage({
    type: "session",
    message: { type: "images.generate.response", payload: { requestId, ok: true, image: { ...image, data: "AAA\n" } } },
  }).success).toBe(false);
});

test("rejects oversized decoded images even when padding keeps the encoded length unchanged", () => {
  const data = Buffer.alloc(MAX_GENERATED_IMAGE_BYTES).toString("base64");
  const maxImage = { ...image, data };
  expect(GeneratedImageSchema.safeParse(maxImage).success).toBe(true);
  expect(GeneratedImageSchema.safeParse({ ...maxImage, data: data.replace(/==$/, "A=") }).success).toBe(false);
  expect(GeneratedImageSchema.safeParse({ ...image, mimeType: "image/svg+xml" }).success).toBe(false);
  expect(ImageGenerationInputSchema.safeParse({ prompt: "Draw", images: [maxImage, maxImage] }).success).toBe(true);
  expect(ImageGenerationInputSchema.safeParse({ prompt: "Draw", images: [maxImage, maxImage, image] }).success).toBe(false);
  expect(ImageGenerationInputSchema.safeParse({ prompt: "\n ", images: [] }).success).toBe(false);
});
