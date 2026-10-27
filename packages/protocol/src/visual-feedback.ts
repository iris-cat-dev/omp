import { z } from "zod";

export const VISUAL_FEEDBACK_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const VISUAL_FEEDBACK_MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
const MAX_IMAGE_BASE64_LENGTH = Math.ceil(VISUAL_FEEDBACK_MAX_IMAGE_BYTES / 3) * 4;
const CoordinateSchema = z.number().finite().min(0).max(32768);
const PointSchema = z.object({ x: CoordinateSchema, y: CoordinateSchema });
const AnnotationFields = {
  id: z.string().min(1).max(100),
  text: z.string().max(10000),
};

export const VisualFeedbackImageSchema = z
  .object({
    data: z.string().min(1).max(MAX_IMAGE_BASE64_LENGTH),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.number().int().positive().max(32768),
    height: z.number().int().positive().max(32768),
  })
  .refine((image) => image.width * image.height <= VISUAL_FEEDBACK_MAX_IMAGE_PIXELS, {
    message: "Visual feedback images must not exceed 32 megapixels",
  });

export const VisualFeedbackAnnotationSchema = z.discriminatedUnion("kind", [
  z.object({
    ...AnnotationFields,
    kind: z.literal("point"),
    x: CoordinateSchema,
    y: CoordinateSchema,
  }),
  z.object({
    ...AnnotationFields,
    kind: z.literal("rectangle"),
    x: CoordinateSchema,
    y: CoordinateSchema,
    width: z.number().positive().max(32768),
    height: z.number().positive().max(32768),
  }),
  z.object({
    ...AnnotationFields,
    kind: z.literal("arrow"),
    x: CoordinateSchema,
    y: CoordinateSchema,
    x2: CoordinateSchema,
    y2: CoordinateSchema,
  }),
  z.object({
    ...AnnotationFields,
    kind: z.literal("pen"),
    points: z.array(PointSchema).min(2).max(5000),
  }),
]);

export const VisualFeedbackSubmissionSchema = z.object({
  text: z.string().max(200000),
  feedback: z.string().max(100000),
  annotations: z.array(VisualFeedbackAnnotationSchema).max(200),
  image: VisualFeedbackImageSchema.optional(),
  preview: VisualFeedbackImageSchema.optional(),
});

export const VisualFeedbackRequestSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string().max(200),
  instructions: z.string().max(10000),
  text: z.string().max(200000),
  image: VisualFeedbackImageSchema.optional(),
});

export const VisualFeedbackResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("submitted"), submission: VisualFeedbackSubmissionSchema }),
  z.object({ status: z.literal("cancelled") }),
]);

export type VisualFeedbackImage = z.infer<typeof VisualFeedbackImageSchema>;
export type VisualFeedbackAnnotation = z.infer<typeof VisualFeedbackAnnotationSchema>;
export type VisualFeedbackSubmission = z.infer<typeof VisualFeedbackSubmissionSchema>;
export type VisualFeedbackRequest = z.infer<typeof VisualFeedbackRequestSchema>;
export type VisualFeedbackResponse = z.infer<typeof VisualFeedbackResponseSchema>;
