export interface WallpaperConfig {
  enabled: boolean;
  source: "none" | "file" | "url" | "video";
  path: string | null;
  url: string | null;
  videoPath: string | null;
  opacity: number;
}

export interface WallpaperFrame {
  dataUrl: string | null;
  width: number;
  height: number;
}
