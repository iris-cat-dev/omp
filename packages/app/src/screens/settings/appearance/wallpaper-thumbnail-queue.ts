import type { WallpaperMediaDescriptor } from "@omp-desktop/protocol/desktop-wallpaper";
import { buildWallpaperMediaSrc } from "@/wallpaper/media-src";

export type WallpaperThumbnailResult = { url: string; failed: false } | { url: null; failed: true };

interface ThumbnailTask {
  instance: number;
  media: WallpaperMediaDescriptor;
  priority: number;
  controller: AbortController;
  live: boolean;
  url: string | null;
  publish: (result: WallpaperThumbnailResult) => void;
}

export interface WallpaperThumbnailHandle {
  release: () => void;
  setPriority: (priority: number) => void;
}

class ThumbnailQueue {
  private tasks: ThumbnailTask[] = [];
  private active = false;
  private instance = 0;
  private video: HTMLVideoElement | null = null;

  constructor(private readonly document: Document) {}

  enqueue(
    media: WallpaperMediaDescriptor,
    priority: number,
    publish: (result: WallpaperThumbnailResult) => void,
  ): WallpaperThumbnailHandle {
    const task: ThumbnailTask = {
      instance: ++this.instance,
      media,
      priority,
      controller: new AbortController(),
      live: true,
      url: null,
      publish,
    };
    this.tasks.push(task);
    // Let the current virtual window finish enqueuing before choosing its first task.
    queueMicrotask(() => void this.drain());
    return {
      setPriority: (value) => {
        task.priority = value;
      },
      release: () => {
        if (!task.live) return;
        task.live = false;
        task.controller.abort();
        if (task.url) URL.revokeObjectURL(task.url);
        task.url = null;
        this.tasks = this.tasks.filter((entry) => entry !== task);
      },
    };
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      while (this.tasks.length) {
        this.tasks.sort(
          (left, right) => left.priority - right.priority || left.instance - right.instance,
        );
        const task = this.tasks.shift()!;
        if (!task.live) continue;
        try {
          const blob = await this.capture(task);
          if (!task.live) continue;
          if (!blob) {
            task.publish({ url: null, failed: true });
            continue;
          }
          const url = URL.createObjectURL(blob);
          task.url = url;
          task.publish({ url, failed: false });
        } catch {
          if (task.live) task.publish({ url: null, failed: true });
        }
      }
    } finally {
      this.active = false;
    }
  }

  private capture(task: ThumbnailTask): Promise<Blob | null> {
    const isVideo = task.media.kind === "video";
    const media = isVideo
      ? (this.video ??= this.document.createElement("video"))
      : this.document.createElement("img");
    const video = isVideo ? (media as HTMLVideoElement) : null;
    const image = isVideo ? null : (media as HTMLImageElement);
    const signal = task.controller.signal;
    const { promise, resolve } = Promise.withResolvers<Blob | null>();
    let settled = false;
    let exporting = false;
    let invalid = false;
    let frameCallback: number | null = null;
    const listeners: Array<[string, EventListener]> = [];
    const cleanupMedia = () => {
      for (const [name, listener] of listeners) media.removeEventListener(name, listener);
      listeners.length = 0;
      if (video) {
        if (frameCallback !== null) video.cancelVideoFrameCallback(frameCallback);
        frameCallback = null;
        video.pause();
        video.removeAttribute("src");
        video.load();
      } else {
        image?.removeAttribute("src");
      }
    };
    const finish = (blob: Blob | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      cleanupMedia();
      resolve(invalid || !task.live ? null : blob);
    };
    const cancel = () => {
      invalid = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      cleanupMedia();
      // A started toBlob owns the serial slot until its callback settles.
      if (!exporting) finish(null);
    };
    const timer = setTimeout(cancel, 10_000);
    const listen = (name: string, listener: EventListener) => {
      listeners.push([name, listener]);
      media.addEventListener(name, listener);
    };
    const draw = () => {
      if (settled || invalid || exporting || !task.live) return;
      const width = video?.videoWidth ?? image?.naturalWidth ?? 0;
      const height = video?.videoHeight ?? image?.naturalHeight ?? 0;
      if (!width || !height || (video && video.readyState < video.HAVE_CURRENT_DATA)) return;
      video?.pause();
      try {
        const scale = Math.min(192 / width, 144 / height, 1);
        const canvas = this.document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext("2d");
        if (!context) {
          finish(null);
          return;
        }
        context.drawImage(media, 0, 0, canvas.width, canvas.height);
        exporting = true;
        cleanupMedia();
        canvas.toBlob((blob) => finish(blob), "image/png");
      } catch {
        exporting = false;
        finish(null);
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    listen("error", () => finish(null));
    media.crossOrigin = "anonymous";
    if (video) {
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      // loadeddata/canplay are real-frame signals; metadata alone is not enough.
      listen("loadeddata", draw);
      listen("canplay", draw);
      if (typeof video.requestVideoFrameCallback === "function") {
        frameCallback = video.requestVideoFrameCallback(() => {
          frameCallback = null;
          draw();
        });
      }
    } else {
      listen("load", draw);
    }
    if (signal.aborted || !task.live) {
      cancel();
      return promise;
    }
    media.src = buildWallpaperMediaSrc(task.media.id);
    if (video) video.load();
    return promise;
  }
}

const queues = new WeakMap<Document, ThumbnailQueue>();

export function enqueueWallpaperThumbnail(
  document: Document,
  media: WallpaperMediaDescriptor,
  priority: number,
  publish: (result: WallpaperThumbnailResult) => void,
): WallpaperThumbnailHandle {
  let queue = queues.get(document);
  if (!queue) {
    queue = new ThumbnailQueue(document);
    queues.set(document, queue);
  }
  return queue.enqueue(media, priority, publish);
}
