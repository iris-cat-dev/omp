import { z } from "zod";

export const IMAGE_GENERATION_CAPABILITY = "images.generate";
export const MAX_GENERATED_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_GENERATION_INPUT_BYTES = 8 * 1024 * 1024;
export const IMAGE_GENERATION_TIMEOUT_MS = 5 * 60_000;

export const GeneratedImageMimeTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);

function decodedBase64Bytes(data: string): number {
  return (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

export const GeneratedImageSchema = z.object({
  data: z
    .string()
    .max(Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4)
    .refine(
      (data) =>
        data.length % 4 === 0 &&
        decodedBase64Bytes(data) <= MAX_GENERATED_IMAGE_BYTES &&
        /^[A-Za-z0-9+/]+={0,2}(?![\s\S])/.test(data),
      "Expected a non-empty Base64 image of at most 4 MiB",
    ),
  mimeType: GeneratedImageMimeTypeSchema,
});

export const ImageGenerationInputSchema = z.object({
  prompt: z.string().max(32_000).regex(/\S/, "Enter a prompt for image generation"),
  images: z
    .array(GeneratedImageSchema)
    .max(16)
    .refine(
      (images) =>
        images.reduce((bytes, { data }) => bytes + decodedBase64Bytes(data), 0) <=
        MAX_IMAGE_GENERATION_INPUT_BYTES,
      "Reference images must total at most 8 MiB",
    ),
});

export type GeneratedImage = z.infer<typeof GeneratedImageSchema>;
export type ImageGenerationInput = z.infer<typeof ImageGenerationInputSchema>;

export const ImageGenerateRequestSchema = z.object({
  type: z.literal("images.generate.request"),
  requestId: z.uuid(),
  input: ImageGenerationInputSchema,
});

export const ImageGenerateCancelSchema = z.object({
  type: z.literal("images.generate.cancel"),
  requestId: z.uuid(),
});

export const ImageGenerateResponseSchema = z.object({
  type: z.literal("images.generate.response"),
  payload: z.union([
    z.object({ requestId: z.uuid(), ok: z.literal(true), image: GeneratedImageSchema }),
    z.object({ requestId: z.uuid(), ok: z.literal(false), error: z.string().min(1).max(512) }),
  ]),
});
