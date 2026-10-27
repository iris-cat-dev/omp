import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);

// Run in a separate STA process: neither Windows Forms nor its DPI context may
// change Electron's UI thread. Keep the snapshot and selection in physical pixels.
const SELECTOR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public sealed class OmpScreenshotSelector : Form {
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("dwmapi.dll")]
    private static extern int DwmFlush();

    private readonly Bitmap snapshot;
    private readonly Rectangle desktop;
    private readonly Button confirm;
    private readonly FlowLayoutPanel toolbar;
    private readonly Brush shade = new SolidBrush(Color.FromArgb(135, 0, 0, 0));
    private readonly Pen outline = new Pen(Color.FromArgb(78, 180, 255), 2);
    private readonly Font toolbarFont;
    private Point anchor;
    private Rectangle selection;
    private bool dragging;
    private string dimensions = "";

    private OmpScreenshotSelector(Bitmap image, Rectangle bounds) {
        snapshot = image;
        desktop = bounds;
        Text = "OMP Screenshot";
        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Bounds = bounds;
        ShowInTaskbar = false;
        TopMost = true;
        KeyPreview = true;
        DoubleBuffered = true;
        Cursor = Cursors.Cross;
        bool chinese = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh";
        float scale = GetDpiForWindow(Handle) / 96f;
        toolbarFont = new Font(SystemFonts.MessageBoxFont.FontFamily, 14 * scale, FontStyle.Regular, GraphicsUnit.Pixel);
        Font = toolbarFont;
        toolbar = new FlowLayoutPanel {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            WrapContents = false,
            BackColor = Color.FromArgb(30, 33, 39),
            ForeColor = Color.White,
            Padding = new Padding((int)(10 * scale)),
            Cursor = Cursors.Default,
        };
        toolbar.Controls.Add(new Label {
            Text = chinese ? "拖动框选 · Enter 确认 · Esc / 右键取消" : "Drag to select · Enter to capture · Esc / right-click to cancel",
            AutoSize = true,
            Margin = new Padding(6, (int)(8 * scale), 12, 0),
        });
        confirm = AddButton(chinese ? "截取选区" : "Capture selection", delegate { CompleteSelection(); });
        confirm.Enabled = false;
        AddButton(chinese ? "整个桌面" : "Entire desktop", delegate {
            selection = new Rectangle(Point.Empty, snapshot.Size);
            CompleteSelection();
        });
        AddButton(chinese ? "取消" : "Cancel", delegate { DialogResult = DialogResult.Cancel; Close(); });
        Controls.Add(toolbar);
        Rectangle monitor = Screen.FromPoint(System.Windows.Forms.Cursor.Position).Bounds;
        toolbar.Location = new Point(monitor.Left - desktop.Left + Math.Max(0, (monitor.Width - toolbar.PreferredSize.Width) / 2), monitor.Top - desktop.Top + (int)(24 * scale));
    }

    private Button AddButton(string text, EventHandler click) {
        var button = new Button { Text = text, AutoSize = true, FlatStyle = FlatStyle.Flat, Padding = new Padding(8, 4, 8, 4) };
        button.Click += click;
        toolbar.Controls.Add(button);
        return button;
    }

    protected override void OnShown(EventArgs e) {
        base.OnShown(e);
        Bounds = desktop;
        Activate();
        Focus();
    }

    protected override void WndProc(ref Message message) {
        // One overlay spans all monitors. Do not accept WM_DPICHANGED's suggested
        // scaled rectangle when its origin crosses a mixed-DPI monitor boundary.
        if (message.Msg == 0x02E0) { message.Result = IntPtr.Zero; return; }
        base.WndProc(ref message);
    }

    private Point Clamp(Point point) {
        return new Point(Math.Max(0, Math.Min(snapshot.Width, point.X)), Math.Max(0, Math.Min(snapshot.Height, point.Y)));
    }

    private void UpdateSelection(Point end) {
        end = Clamp(end);
        selection = Rectangle.FromLTRB(Math.Min(anchor.X, end.X), Math.Min(anchor.Y, end.Y), Math.Max(anchor.X, end.X), Math.Max(anchor.Y, end.Y));
        dimensions = selection.Width + " × " + selection.Height + " px";
        confirm.Enabled = selection.Width >= 2 && selection.Height >= 2;
        Invalidate();
    }

    protected override void OnMouseDown(MouseEventArgs e) {
        base.OnMouseDown(e);
        if (e.Button == MouseButtons.Right) { DialogResult = DialogResult.Cancel; Close(); return; }
        if (e.Button != MouseButtons.Left) return;
        anchor = Clamp(e.Location);
        dragging = true;
        Capture = true;
        UpdateSelection(anchor);
    }

    protected override void OnMouseMove(MouseEventArgs e) {
        base.OnMouseMove(e);
        if (dragging) UpdateSelection(e.Location);
    }

    protected override void OnMouseUp(MouseEventArgs e) {
        base.OnMouseUp(e);
        if (e.Button != MouseButtons.Left || !dragging) return;
        UpdateSelection(e.Location);
        dragging = false;
        Capture = false;
    }

    protected override void OnMouseCaptureChanged(EventArgs e) {
        base.OnMouseCaptureChanged(e);
        if (!dragging) return;
        dragging = false;
        selection = Rectangle.Empty;
        confirm.Enabled = false;
        Invalidate();
    }

    protected override bool ProcessCmdKey(ref Message message, Keys key) {
        if (key == Keys.Escape) { DialogResult = DialogResult.Cancel; Close(); return true; }
        if (key == Keys.Enter) { if (!dragging) CompleteSelection(); return true; }
        return base.ProcessCmdKey(ref message, key);
    }

    private void CompleteSelection() {
        if (selection.Width < 2 || selection.Height < 2 || dragging) return;
        DialogResult = DialogResult.OK;
        Close();
    }

    protected override void OnPaint(PaintEventArgs e) {
        e.Graphics.DrawImageUnscaled(snapshot, 0, 0);
        if (selection.Width < 2 || selection.Height < 2) {
            e.Graphics.FillRectangle(shade, ClientRectangle);
            return;
        }
        e.Graphics.FillRectangle(shade, 0, 0, snapshot.Width, selection.Top);
        e.Graphics.FillRectangle(shade, 0, selection.Bottom, snapshot.Width, snapshot.Height - selection.Bottom);
        e.Graphics.FillRectangle(shade, 0, selection.Top, selection.Left, selection.Height);
        e.Graphics.FillRectangle(shade, selection.Right, selection.Top, snapshot.Width - selection.Right, selection.Height);
        e.Graphics.DrawRectangle(outline, selection.X, selection.Y, selection.Width - 1, selection.Height - 1);
        Size size = TextRenderer.MeasureText(dimensions, Font);
        Point position = new Point(Math.Min(selection.Left, snapshot.Width - size.Width), Math.Max(0, selection.Top - size.Height - 6));
        TextRenderer.DrawText(e.Graphics, dimensions, Font, position, Color.White, Color.FromArgb(30, 33, 39));
    }

    protected override void Dispose(bool disposing) {
        if (disposing) { shade.Dispose(); outline.Dispose(); toolbarFont.Dispose(); }
        base.Dispose(disposing);
    }

    public static bool CaptureTo(string destination) {
        // PowerShell otherwise reports DPI-virtualized bounds (e.g. 2560x1440
        // for a 3840x2160 display at 150%), but CopyFromScreen copies pixels.
        IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            Application.EnableVisualStyles();
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
            Rectangle bounds = new Rectangle(GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79));
            if (bounds.Width <= 0 || bounds.Height <= 0) throw new InvalidOperationException("The desktop is unavailable");
            // Wait for the requesting window's hide to reach the compositor.
            DwmFlush();
            using (var image = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppRgb)) {
                using (Graphics graphics = Graphics.FromImage(image)) {
                    graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy);
                }
                using (var selector = new OmpScreenshotSelector(image, bounds)) {
                    if (selector.ShowDialog() != DialogResult.OK) return false;
                    if (selector.selection == new Rectangle(Point.Empty, image.Size)) image.Save(destination, ImageFormat.Png);
                    else using (Bitmap cropped = image.Clone(selector.selection, PixelFormat.Format32bppRgb)) cropped.Save(destination, ImageFormat.Png);
                    return true;
                }
            }
        } finally { SetThreadDpiAwarenessContext(previous); }
    }
}
'@
`;

export async function captureWindowsScreenshot(destination: string): Promise<boolean> {
  const scriptPath = path.join(path.dirname(destination), "select-region.ps1");
  const invocation = `\nif ([OmpScreenshotSelector]::CaptureTo('${destination.replace(/'/g, "''")}')) { 'captured' } else { 'cancelled' }\n`;
  // A script file avoids Windows' command-line length limit; PS 5.1 needs a BOM
  // to preserve localized labels. The caller removes the private temp directory.
  await writeFile(scriptPath, `\uFEFF${SELECTOR_SCRIPT}${invocation}`, "utf8");
  const { stdout } = await runFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { timeout: 180000, windowsHide: true },
  );
  const result = stdout.trim();
  if (result === "cancelled") return false;
  if (result !== "captured") throw new Error("The screen selector returned no capture result");
  return true;
}
