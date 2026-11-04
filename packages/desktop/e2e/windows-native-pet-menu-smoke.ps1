param(
  [Parameter(Mandatory = $true)][string]$RequestPath
)
$ErrorActionPreference = 'Stop'
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $request.pid -or $request.pid -is [string] -or $request.pid -is [bool] -or
    [double]$request.pid -ne [math]::Truncate([double]$request.pid) -or
    [double]$request.pid -le 0 -or [double]$request.pid -gt [uint32]::MaxValue) {
  throw 'Request pid must be a positive numeric process ID'
}
if ($request.petHandle -isnot [string] -or $request.petHandle -notmatch '^[1-9][0-9]*$') {
  throw 'Request petHandle must be a decimal HWND string'
}
foreach ($axis in @('x', 'y')) {
  $value = $request.petCssPoint.$axis
  if ($null -eq $value -or $value -is [string] -or $value -is [bool] -or
      [double]::IsNaN([double]$value) -or [double]::IsInfinity([double]$value) -or [double]$value -lt 0) {
    throw "Request petCssPoint.$axis must be a finite nonnegative CSS coordinate"
  }
}
if ($request.inputObservationPath -isnot [string] -or
    -not [IO.Path]::IsPathRooted($request.inputObservationPath) -or
    $request.observationRunId -isnot [string] -or [string]::IsNullOrWhiteSpace($request.observationRunId)) {
  throw 'An owned interactivity observation path and run ID are required'
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.dll,System.Core.dll,System.Windows.Forms.dll,System.Drawing.dll -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
public static class OmpNativePetMenuSmoke {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT {
    public int dx, dy;
    public uint mouseData, dwFlags, time;
    public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)] private struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mouse;
  }
  [StructLayout(LayoutKind.Sequential)] private struct INPUT {
    public uint type;
    public INPUTUNION data;
  }
  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
  [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll", SetLastError=true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll", SetLastError=true)] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam, uint flags, uint timeout, out UIntPtr result);
  public sealed class Report {
    public bool menuOpened, dismissedAfterOutsideClick, petNoActivate, petVisible, foregroundIsOutsideFixture;
    public bool outsideClickTargetIsFixture, menuSelectionInputSent;
    public string petHandle, menuHandle, fixtureHandle;
    public uint pid, dpi;
    public int petScreenX, petScreenY, outsideScreenX, outsideScreenY;
    public bool petRepositioned;
    public int originalPetX, originalPetY, testPetX, testPetY;
    public long outsideInteractivitySequence, readyInteractivitySequence;
    public bool interactiveAckObserved;
    public string actionObservation = "Only native outside-click input was sent; application side effects require parent-side state checks after menu tracking ends.";
  }
  private sealed class OutsideFixture : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get { CreateParams value = base.CreateParams; value.ExStyle |= 0x80; return value; }
    }
    public OutsideFixture() {
      AutoScaleMode = AutoScaleMode.None;
      FormBorderStyle = FormBorderStyle.None;
      StartPosition = FormStartPosition.Manual;
      ShowInTaskbar = false;
      TopMost = true;
      BackColor = Color.FromArgb(39, 69, 87);
      // No controls, click handlers, or menu: the client center is inert. Show
      // without activation, but allow a genuine click to acquire foreground.
    }
  }
  private static void Require(bool condition, string reason) {
    if (!condition) throw new InvalidOperationException("SMOKE_PET_MENU: " + reason);
  }
  private static bool Owned(IntPtr hwnd, uint pid) {
    uint actual;
    return hwnd != IntPtr.Zero && IsWindow(hwnd) && GetWindowThreadProcessId(hwnd, out actual) != 0 && actual == pid;
  }
  private static void AssertRoot(IntPtr hwnd, uint pid) {
    Require(Owned(hwnd, pid) && GetAncestor(hwnd, 2) == hwnd, "top-level HWND ownership changed");
  }
  private static Rectangle Bounds(IntPtr hwnd) {
    RECT rect;
    Require(GetWindowRect(hwnd, out rect), "cannot read owned HWND bounds");
    Require(rect.Right > rect.Left && rect.Bottom > rect.Top, "owned HWND bounds are empty");
    return Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
  }
  private static Rectangle AssertPet(IntPtr pet, uint pid) {
    AssertRoot(pet, pid);
    Require(IsWindowVisible(pet) && !IsIconic(pet), "pet is hidden or minimized");
    Rectangle rect = Bounds(pet);
    Require(SystemInformation.VirtualScreen.Contains(rect), "pet extends outside physical virtual desktop bounds");
    return rect;
  }
  private static bool NoActivate(IntPtr hwnd) {
    return (GetWindowLongPtr(hwnd, -20).ToInt64() & 0x08000000L) != 0;
  }
  private static bool ButtonsHeld() {
    return (((ushort)GetAsyncKeyState(1) | (ushort)GetAsyncKeyState(2) | (ushort)GetAsyncKeyState(4) |
      (ushort)GetAsyncKeyState(5) | (ushort)GetAsyncKeyState(6)) & 0x8000) != 0;
  }
  private static bool HitOwnedRoot(POINT point, IntPtr expected, uint pid) {
    IntPtr hit = WindowFromPoint(point);
    return Owned(hit, pid) && GetAncestor(hit, 2) == expected && Owned(expected, pid);
  }
  private static bool HitOwnedClient(POINT point, IntPtr hwnd, uint pid) {
    if (!HitOwnedRoot(point, hwnd, pid)) return false;
    Require(point.X >= short.MinValue && point.X <= short.MaxValue &&
      point.Y >= short.MinValue && point.Y <= short.MaxValue, "hit-test point exceeds native signed-coordinate range");
    uint packed = (uint)(ushort)point.X | ((uint)(ushort)point.Y << 16);
    UIntPtr hit;
    Require(SendMessageTimeout(hwnd, 0x0084, UIntPtr.Zero, new IntPtr(unchecked((int)packed)),
      0x0023, 100, out hit) != IntPtr.Zero, "owned native hit-test timed out; no input sent");
    return unchecked((int)hit.ToUInt64()) == 1; // HTCLIENT, not HTTRANSPARENT.
  }
  private static bool InteractiveObserved(string file, string runId, uint pid, long handle,
      bool interactive, long afterSequence, double cssX, double cssY, out long sequence) {
    sequence = 0;
    string text;
    try {
      using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read,
          FileShare.ReadWrite | FileShare.Delete))
      using (var reader = new StreamReader(stream)) text = reader.ReadToEnd();
    } catch (IOException) { return false; }
    string[] fields = text.Split('|');
    if (fields.Length != 7 || fields[0] != runId) return false;
    long observedSequence, observedHandle;
    uint observedPid;
    double x, y;
    if (!long.TryParse(fields[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out observedSequence) ||
        !uint.TryParse(fields[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out observedPid) ||
        !long.TryParse(fields[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out observedHandle) ||
        observedSequence <= afterSequence || observedPid != pid || observedHandle != handle ||
        fields[4] != (interactive ? "1" : "0")) return false;
    if (!double.TryParse(fields[5], NumberStyles.Float, CultureInfo.InvariantCulture, out x) ||
        !double.TryParse(fields[6], NumberStyles.Float, CultureInfo.InvariantCulture, out y) ||
        double.IsNaN(x) || double.IsInfinity(x) || double.IsNaN(y) || double.IsInfinity(y)) return false;
    // Coordinates are cursor-relative DIP at the genuine main-side ACK, not
    // a fabricated renderer hit or an assertion about later right-up delivery.
    if (interactive && (Math.Abs(x - cssX) > 1 || Math.Abs(y - cssY) > 1)) return false;
    sequence = observedSequence;
    return true;
  }
  private static void Pump() { Application.DoEvents(); Thread.Sleep(20); }
  private static bool WaitFor(Func<bool> predicate, int milliseconds) {
    Stopwatch timer = Stopwatch.StartNew();
    do { if (predicate()) return true; Pump(); } while (timer.ElapsedMilliseconds < milliseconds);
    return predicate();
  }
  private static List<IntPtr> Menus(uint pid) {
    var result = new List<IntPtr>();
    bool complete = EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
      // Filter ownership before class inspection; never read foreign titles,
      // content, menu labels, or pixels.
      if (!Owned(hwnd, pid) || !IsWindowVisible(hwnd)) return true;
      var name = new StringBuilder(32);
      Require(GetClassName(hwnd, name, name.Capacity) != 0, "cannot inspect owned window class");
      if (name.ToString() == "#32768") result.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    Require(complete, "cannot enumerate owned native menus");
    return result;
  }
  private static Rectangle FixtureBounds(Rectangle pet, Rectangle menu) {
    var choices = new List<Rectangle>();
    foreach (Screen screen in Screen.AllScreens) {
      Rectangle work = screen.WorkingArea;
      const int width = 140, height = 90, margin = 12;
      if (work.Width < width + 2 * margin || work.Height < height + 2 * margin) continue;
      foreach (int x in new int[] { work.Left + margin, work.Right - width - margin, work.Left + (work.Width - width) / 2 })
        foreach (int y in new int[] { work.Top + margin, work.Bottom - height - margin, work.Top + (work.Height - height) / 2 }) {
          var candidate = new Rectangle(x, y, width, height);
          if (!candidate.IntersectsWith(pet) && !candidate.IntersectsWith(menu)) choices.Add(candidate);
        }
    }
    Require(choices.Count != 0, "no safe fixture rectangle outside pet/menu working areas");
    // Prefer the point furthest from the pet, reducing chance of popup overlap.
    choices.Sort(delegate(Rectangle left, Rectangle right) {
      long lx = (long)left.Left + left.Width / 2 - pet.Left - pet.Width / 2;
      long ly = (long)left.Top + left.Height / 2 - pet.Top - pet.Height / 2;
      long rx = (long)right.Left + right.Width / 2 - pet.Left - pet.Width / 2;
      long ry = (long)right.Top + right.Height / 2 - pet.Top - pet.Height / 2;
      return (rx * rx + ry * ry).CompareTo(lx * lx + ly * ly);
    });
    return choices[0];
  }
  private static POINT Center(IntPtr hwnd) {
    RECT client;
    Require(GetClientRect(hwnd, out client), "cannot read fixture client bounds");
    POINT point = new POINT { X = (client.Right - client.Left) / 2, Y = (client.Bottom - client.Top) / 2 };
    Require(ClientToScreen(hwnd, ref point), "cannot map fixture client center");
    return point;
  }
  private static void Move(POINT point, ref POINT last, ref bool moved) {
    Require(!ButtonsHeld(), "a real mouse button is held; input refused");
    Require(SetCursorPos(point.X, point.Y), "cannot position cursor");
    last = point; moved = true;
    POINT current;
    Require(GetCursorPos(out current) && current.X == point.X && current.Y == point.Y, "cursor movement was contested");
  }
  private static void Click(POINT point, IntPtr hwnd, uint pid, bool right, ref POINT last, ref bool moved) {
    AssertRoot(hwnd, pid);
    Require(HitOwnedClient(point, hwnd, pid), "input point does not hit the owned native client");
    Move(point, ref last, ref moved);
    Require(!ButtonsHeld() && HitOwnedClient(point, hwnd, pid), "owned native client hit-test changed before click");
    var inputs = new INPUT[2];
    inputs[0].data.mouse.dwFlags = right ? 0x0008U : 0x0002U;
    inputs[1].data.mouse.dwFlags = right ? 0x0010U : 0x0004U;
    // The paired real mouse events are submitted together; no selection keys or
    // synthetic app bridge calls are used.
    uint sent = 0;
    try {
      sent = SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
      Require(sent == 2, "native mouse input was not fully accepted");
    } finally {
      if (sent == 1) {
        uint release = right ? 0x0010U : 0x0004U;
        inputs[0].data.mouse.dwFlags = release;
        if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) != 1)
          mouse_event(release, 0, 0, 0, UIntPtr.Zero);
      }
    }
  }
  public static Report Run(uint pid, long handle, double cssX, double cssY,
      string observationFile, string runId) {
    IntPtr previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
    Require(previousDpi != IntPtr.Zero, "PMv2 physical coordinate awareness unavailable");
    IntPtr pet = new IntPtr(handle), observedMenu = IntPtr.Zero;
    OutsideFixture fixture = null;
    POINT original = new POINT(), last = new POINT();
    bool moved = false, cursorKnown = false, menuAttempted = false, petPlaced = false;
    long outsideSequence = 0, readySequence = 0;
    Rectangle originalPetRect = Rectangle.Empty;
    try {
      Rectangle petRect = AssertPet(pet, pid);
      originalPetRect = petRect;
      Require(NoActivate(pet), "pet did not initially have WS_EX_NOACTIVATE");
      Require(Menus(pid).Count == 0, "app already has an active native popup menu");
      Require(!ButtonsHeld(), "a real mouse button is held; input refused");
      cursorKnown = GetCursorPos(out original);
      Require(cursorKnown, "cannot save cursor position");
      // Shell flyouts may cover the product's bottom-right position. Control
      // only this owned fixture window; never dismiss or click a foreign window.
      Rectangle work = Screen.FromRectangle(petRect).WorkingArea;
      Require(work.Width >= petRect.Width && work.Height >= petRect.Height,
        "owned pet does not fit this monitor's working area");
      int targetX = work.Left + (work.Width - petRect.Width) / 2;
      int targetY = work.Top + (work.Height - petRect.Height) / 2;
      Require(SetWindowPos(pet, IntPtr.Zero, targetX, targetY, 0, 0, 0x0015),
        "cannot center owned pet without activation or z-order changes");
      petPlaced = true;
      petRect = AssertPet(pet, pid);
      Require(petRect.X == targetX && petRect.Y == targetY, "owned pet fixture placement did not settle");
      uint dpi = GetDpiForWindow(pet);
      Require(dpi != 0, "cannot establish pet DPI");
      RECT client;
      POINT origin = new POINT();
      Require(GetClientRect(pet, out client) && ClientToScreen(pet, ref origin), "cannot map pet client coordinates");
      double px = Math.Round(cssX * dpi / 96.0), py = Math.Round(cssY * dpi / 96.0);
      Require(px >= 0 && py >= 0 && px < client.Right - client.Left && py < client.Bottom - client.Top,
        "painted CSS point maps outside pet client");
      POINT petPoint = new POINT { X = checked(origin.X + (int)px), Y = checked(origin.Y + (int)py) };
      bool pointOnScreen = false;
      foreach (Screen screen in Screen.AllScreens) if (screen.Bounds.Contains(petPoint.X, petPoint.Y)) pointOnScreen = true;
      Require(pointOnScreen && petRect.Contains(petPoint.X, petPoint.Y), "pet input point is outside physical desktop/pet bounds");
      fixture = new OutsideFixture();
      fixture.Bounds = FixtureBounds(petRect, Rectangle.Empty);
      fixture.Show();
      fixture.Update();
      uint helperPid = (uint)Process.GetCurrentProcess().Id;
      IntPtr fixtureHwnd = fixture.Handle;
      AssertRoot(fixtureHwnd, helperPid);
      POINT outside = Center(fixtureHwnd);
      Require(WaitFor(delegate { return HitOwnedRoot(outside, fixtureHwnd, helperPid); }, 1500), "fixture center is occluded");
      Click(outside, fixtureHwnd, helperPid, false, ref last, ref moved);
      Require(WaitFor(delegate { return GetForegroundWindow() == fixtureHwnd; }, 1500), "real fixture activation click did not acquire foreground");
      Require(WaitFor(delegate {
        return InteractiveObserved(observationFile, runId, pid, handle, false, -1, cssX, cssY, out outsideSequence);
      }, 2500), "no genuine outside/noninteractive IPC observation for this live pet");
      AssertPet(pet, pid);
      Move(petPoint, ref last, ref moved);
      // Neither HWND ownership nor HTCLIENT exposes mini-electron's ignore flag.
      // Wait for a newer genuine product hit-test IPC ACK, without changing it.
      Require(WaitFor(delegate {
        return InteractiveObserved(observationFile, runId, pid, handle, true, outsideSequence, cssX, cssY, out readySequence);
      }, 2500), "painted pet point never received a fresh genuine interactive IPC ACK");
      if (!HitOwnedClient(petPoint, pet, pid)) {
        IntPtr hitWindow = WindowFromPoint(petPoint);
        uint hitPid;
        GetWindowThreadProcessId(hitWindow, out hitPid);
        var hitClass = new StringBuilder(128);
        GetClassName(hitWindow, hitClass, hitClass.Capacity);
        UIntPtr nonClientHit;
        uint packed = (uint)(ushort)petPoint.X | ((uint)(ushort)petPoint.Y << 16);
        bool inspected = SendMessageTimeout(pet, 0x0084, UIntPtr.Zero,
          new IntPtr(unchecked((int)packed)), 0x0023, 100, out nonClientHit) != IntPtr.Zero;
        Require(false, String.Format(CultureInfo.InvariantCulture,
          "ACK target is not an owned native client hit; point={0},{1}; hit={2}; hitPid={3}; hitClass={4}; root={5}; expected={6}; ncHit={7}; exStyle=0x{8:X}",
          petPoint.X, petPoint.Y, hitWindow.ToInt64(), hitPid, hitClass,
          GetAncestor(hitWindow, 2).ToInt64(), pet.ToInt64(),
          inspected ? unchecked((int)nonClientHit.ToUInt64()).ToString(CultureInfo.InvariantCulture) : "timeout",
          GetWindowLongPtr(pet, -20).ToInt64()));
      }
      AssertPet(pet, pid);
      Require(Menus(pid).Count == 0, "unexpected popup appeared before right click");
      Require(GetForegroundWindow() == fixtureHwnd, "foreground changed before pet right click");
      menuAttempted = true;
      Click(petPoint, pet, pid, true, ref last, ref moved);
      Require(WaitFor(delegate {
        List<IntPtr> menus = Menus(pid);
        Require(menus.Count <= 1, "multiple owned native popup menus appeared");
        if (menus.Count == 1) observedMenu = menus[0];
        return observedMenu != IntPtr.Zero;
      }, 3000), "right click did not open an owned OS popup menu");
      Rectangle menuRect = Bounds(observedMenu);
      petRect = AssertPet(pet, pid);
      if (Bounds(fixtureHwnd).IntersectsWith(menuRect) || Bounds(fixtureHwnd).IntersectsWith(petRect)) {
        Rectangle safe = FixtureBounds(petRect, menuRect);
        Require(SetWindowPos(fixtureHwnd, new IntPtr(-1), safe.X, safe.Y, safe.Width, safe.Height, 0x0010),
          "cannot move fixture clear of menu without activation");
        Pump();
      }
      outside = Center(fixtureHwnd);
      Require(Owned(observedMenu, pid) && IsWindowVisible(observedMenu), "observed menu disappeared before outside click");
      menuRect = Bounds(observedMenu);
      petRect = AssertPet(pet, pid);
      Require(!Bounds(fixtureHwnd).IntersectsWith(menuRect) && !Bounds(fixtureHwnd).IntersectsWith(petRect) &&
        !menuRect.Contains(outside.X, outside.Y) && !petRect.Contains(outside.X, outside.Y), "outside fixture overlaps pet/menu");
      AssertRoot(fixtureHwnd, helperPid);
      Require(HitOwnedRoot(outside, fixtureHwnd, helperPid), "outside click point no longer belongs to helper fixture");
      Click(outside, fixtureHwnd, helperPid, false, ref last, ref moved);
      bool dismissed = WaitFor(delegate { return !IsWindow(observedMenu) || !IsWindowVisible(observedMenu); }, 2500);
      // A menu may consume the dismissal click. Report actual foreground, not
      // an assumed fixture activation, and never send a second click to fix it.
      bool petOwned = Owned(pet, pid) && GetAncestor(pet, 2) == pet;
      return new Report {
        pid = pid, petHandle = pet.ToInt64().ToString(), menuHandle = observedMenu.ToInt64().ToString(),
        fixtureHandle = fixtureHwnd.ToInt64().ToString(), dpi = dpi,
        petScreenX = petPoint.X, petScreenY = petPoint.Y, outsideScreenX = outside.X, outsideScreenY = outside.Y,
        petRepositioned = petPlaced, originalPetX = originalPetRect.X, originalPetY = originalPetRect.Y,
        testPetX = petRect.X, testPetY = petRect.Y,
        outsideInteractivitySequence = outsideSequence, readyInteractivitySequence = readySequence,
        interactiveAckObserved = true,
        menuOpened = true, dismissedAfterOutsideClick = dismissed,
        petNoActivate = petOwned && NoActivate(pet),
        petVisible = petOwned && IsWindowVisible(pet) && !IsIconic(pet),
        foregroundIsOutsideFixture = GetForegroundWindow() == fixtureHwnd,
        outsideClickTargetIsFixture = true, menuSelectionInputSent = false
      };
    } finally {
      // Cancellation is not part of success measurement. It targets only the
      // still-owned app HWND, never Escape or a foreign foreground window.
      try {
        if (menuAttempted && Owned(pet, pid) &&
            (observedMenu == IntPtr.Zero || (Owned(observedMenu, pid) && IsWindowVisible(observedMenu))))
          PostMessage(pet, 0x001F, IntPtr.Zero, IntPtr.Zero); // WM_CANCELMODE
      } finally {
        try {
          if (fixture != null) {
            try { fixture.Close(); }
            finally { fixture.Dispose(); }
          }
        } finally {
          try {
            if (petPlaced && Owned(pet, pid) && GetAncestor(pet, 2) == pet)
              Require(SetWindowPos(pet, IntPtr.Zero, originalPetRect.X, originalPetRect.Y, 0, 0, 0x0015),
                "cannot restore owned pet fixture position");
          } finally {
            POINT current;
            if (cursorKnown && moved && !ButtonsHeld() && GetCursorPos(out current) && current.X == last.X && current.Y == last.Y)
              SetCursorPos(original.X, original.Y);
            SetThreadDpiAwarenessContext(previousDpi);
          }
        }
      }
    }
  }
}
'@
$report = [OmpNativePetMenuSmoke]::Run([uint32]$request.pid, [long]$request.petHandle,
  [double]$request.petCssPoint.x, [double]$request.petCssPoint.y,
  [string]$request.inputObservationPath, [string]$request.observationRunId)
$report | ConvertTo-Json -Depth 5 -Compress
