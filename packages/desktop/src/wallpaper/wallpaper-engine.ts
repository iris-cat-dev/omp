import { BrowserView, type BrowserWindow } from "electron";
import type { WallpaperConfig, WallpaperFrame } from "./types";

/**
 * WallpaperEngine: renders wallpaper via a BrowserView behind the main window.
 *
 * - Static image: loads via HTML `<img>` in the BrowserView.
 * - Video: loads via HTML `<video autoplay loop muted playsinline>` in the BrowserView.
 *   Electron's Chromium has native video decoding — no extra dependency needed.
 */
export class WallpaperEngine {
  private browserView: BrowserView | null = null;
  private mainWindow: BrowserWindow | null = null;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  start(config: WallpaperConfig): void {
    if (!config.enabled || !config.source || config.source === "none") {
      this.stop();
      return;
    }

    this.ensureBrowserView();
    this.loadContent(config);
  }

  stop(): void {
    if (this.browserView) {
      try {
        this.mainWindow?.removeBrowserView(this.browserView);
      } catch {
        // View may already be gone during teardown.
      }
      this.browserView = null;
    }
  }

  updateConfig(config: WallpaperConfig): void {
    if (!config.enabled || !config.source || config.source === "none") {
      this.stop();
      return;
    }
    this.loadContent(config);
  }

  getFrame(_input: { path?: string; url?: string }): WallpaperFrame | null {
    // Stub: not yet implemented for video (streaming via BrowserView instead).
    return null;
  }

  private ensureBrowserView(): void {
    if (this.browserView) return;
    this.browserView = new BrowserView();
    const win = this.mainWindow;
    if (win) {
      win.setBrowserView(this.browserView);
      this.browserView.setAutoResize({ width: true, height: true });
      this.browserView.setBounds(win.getBounds());
    }
  }

  private loadContent(config: WallpaperConfig): void {
    if (!this.browserView) return;
    const opacity = Math.max(0, Math.min(1, config.opacity ?? 1));

    let html: string;
    if (config.source === "video" && config.videoPath) {
      const escaped = config.videoPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      html = this.videoHtml(escaped, opacity);
    } else if (config.source === "file" && config.path) {
      const escaped = config.path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      html = this.imageHtml(`file://${escaped}`, opacity);
    } else if (config.source === "url" && config.url) {
      html = this.imageHtml(config.url, opacity);
    } else {
      html = this.blankHtml();
    }

    this.browserView.webContents.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );
  }

  private imageHtml(src: string, opacity: number): string {
    return `<!DOCTYPE html><html><head><style>
      html,body{margin:0;padding:0;overflow:hidden;background:transparent}
      img{width:100vw;height:100vh;object-fit:cover;opacity:${opacity}}
    </style></head><body><img src="${src}"></body></html>`;
  }

  private videoHtml(path: string, opacity: number): string {
    return `<!DOCTYPE html><html><head><style>
      html,body{margin:0;padding:0;overflow:hidden;background:transparent}
      video{width:100vw;height:100vh;object-fit:cover;opacity:${opacity}}
    </style></head><body><video autoplay loop muted playsinline src="file://${path}"></video></body></html>`;
  }

  private blankHtml(): string {
    return `<!DOCTYPE html><html><head><style>
      html,body{margin:0;padding:0;overflow:hidden;background:transparent}
    </style></head><body></body></html>`;
  }
}
