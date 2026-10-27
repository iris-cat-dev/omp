import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { BrowserWindow, ipcMain, nativeImage } from "electron";
import {
  VISUAL_FEEDBACK_MAX_IMAGE_BYTES,
  VISUAL_FEEDBACK_MAX_IMAGE_PIXELS,
} from "@omp-desktop/protocol/visual-feedback";
import { isMainWindowSender, showMainWindow } from "../window/main-windows.js";

const runFile = promisify(execFile);
let capturing = false;

async function captureSystemScreen(destination: string): Promise<boolean> {
  if (process.platform === "darwin") {
    try {
      await runFile("/usr/sbin/screencapture", ["-i", "-x", destination], { timeout: 180000 });
      return true;
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      if (Number(failure.code) === 1 && !failure.stderr?.trim()) return false;
      const detail = failure.stderr?.trim() || failure.message;
      throw new Error(`Screen capture failed: ${detail}`, { cause: error });
    }
  }
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen",
    "$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)",
    "$graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
    "try {",
    "  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)",
    `  $bitmap.Save('${destination.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "} finally { $graphics.Dispose(); $bitmap.Dispose() }",
  ].join("\n");
  await runFile(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { timeout: 30000, windowsHide: true },
  );
  return true;
}

async function readCapturedImage(destination: string) {
  const info = await stat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && process.platform === "darwin") return null;
    throw error;
  });
  if (!info) return null;
  if (info.size > 128 * 1024 * 1024)
    throw new Error("The captured screen is too large; select a smaller area");
  const image = nativeImage.createFromBuffer(await readFile(destination));
  if (image.isEmpty()) throw new Error("Screen capture returned an empty image");
  const { width, height } = image.getSize();
  if (width > 32768 || height > 32768 || width * height > VISUAL_FEEDBACK_MAX_IMAGE_PIXELS)
    throw new Error("The captured screen is too large; select a smaller area");
  let bytes = image.toPNG();
  let mimeType: "image/png" | "image/jpeg" = "image/png";
  if (bytes.length > VISUAL_FEEDBACK_MAX_IMAGE_BYTES) {
    bytes = image.toJPEG(85);
    mimeType = "image/jpeg";
  }
  if (bytes.length > VISUAL_FEEDBACK_MAX_IMAGE_BYTES)
    throw new Error("The screenshot exceeds 8 MiB; select a smaller area");
  return { data: bytes.toString("base64"), mimeType, width, height };
}

export function registerScreenshotHandler(): void {
  ipcMain.handle("paseo:screenshot:capture", async (event) => {
    if (!isMainWindowSender(event.sender) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Screen capture is restricted to the main application window");
    }
    if (process.platform !== "darwin" && process.platform !== "win32") {
      throw new Error("Use your browser's screen picker or import a screenshot on this platform");
    }
    if (capturing) throw new Error("A screen capture is already in progress");
    capturing = true;
    const owner = BrowserWindow.fromWebContents(event.sender);
    const restore = owner?.isVisible() === true;
    let directory: string | undefined;
    try {
      directory = await mkdtemp(path.join(tmpdir(), "omp-feedback-"));
      const destination = path.join(directory, "capture.png");
      if (restore) owner?.hide();
      if (!(await captureSystemScreen(destination))) return null;
      return await readCapturedImage(destination);
    } finally {
      capturing = false;
      if (restore && owner && !owner.isDestroyed()) showMainWindow(owner);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });
}
