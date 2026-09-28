export const IMAGE_GENERATION_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;

export const IMAGE_GENERATION_QUALITIES = ["auto", "low", "medium", "high"] as const;
export const IMAGE_GENERATION_BACKGROUNDS = ["auto", "opaque", "transparent"] as const;
export const IMAGE_GENERATION_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;

export type ImageGenerationSize = (typeof IMAGE_GENERATION_SIZES)[number];
export type ImageGenerationQuality = (typeof IMAGE_GENERATION_QUALITIES)[number];
export type ImageGenerationBackground = (typeof IMAGE_GENERATION_BACKGROUNDS)[number];
export type ImageGenerationOutputFormat = (typeof IMAGE_GENERATION_OUTPUT_FORMATS)[number];

export const MAX_IMAGE_GENERATION_REFERENCE_IMAGES = 16;

export interface ImageGenerationInput {
  prompt: string;
  referenceImagePaths?: readonly string[];
  size?: ImageGenerationSize;
  quality?: ImageGenerationQuality;
  background?: ImageGenerationBackground;
  outputFormat?: ImageGenerationOutputFormat;
}

export interface ImageGenerationContext {
  agentId: string;
  signal?: AbortSignal;
}

export interface GeneratedImage {
  prompt: string;
  model: string;
  filePath: string;
  mimeType: string;
  size: ImageGenerationSize;
  quality: ImageGenerationQuality;
  background: ImageGenerationBackground;
  outputFormat: ImageGenerationOutputFormat;
  revisedPrompt?: string;
}

export interface ImageGenerationService {
  generate(input: ImageGenerationInput, context: ImageGenerationContext): Promise<GeneratedImage>;
}
