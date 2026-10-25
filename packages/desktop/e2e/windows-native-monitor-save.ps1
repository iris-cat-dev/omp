$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$root = [IO.Path]::GetFullPath($env:OMP_MONITOR_EXPORT_ROOT)
$destination = [IO.Path]::GetFullPath($env:OMP_MONITOR_EXPORT_PATH)
if ([IO.Path]::GetDirectoryName($destination) -ne $root -or (Test-Path $destination)) {
  throw 'CSV smoke may save only a fresh file directly under its disposable root'
}
$markerPath = Join-Path $root '.omp-monitor-export-owner.json'
$marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
if ($marker.token -ne $env:OMP_MONITOR_EXPORT_TOKEN -or $marker.root -ne $root) {
  throw 'CSV smoke ownership marker mismatch'
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OmpMonitorSaveNative {
  public delegate bool EnumCallback(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder buffer, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder buffer, int count);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hwnd, int id);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, string text);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
}
'@
$owner = [IntPtr]::new([long]$env:OMP_MONITOR_EXPORT_OWNER)
[uint32]$ownerPid = 0
[void][OmpMonitorSaveNative]::GetWindowThreadProcessId($owner, [ref]$ownerPid)
$ownerProcess = Get-Process -Id $ownerPid
$runtimeDirectory = [IO.Path]::GetFullPath((Join-Path $root 'runtime')) + [IO.Path]::DirectorySeparatorChar
if (-not ([IO.Path]::GetFullPath($ownerProcess.Path)).StartsWith($runtimeDirectory, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'CSV dialog owner is not a process from the disposable runtime'
}
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$script:dialog = [IntPtr]::Zero
while ($script:dialog -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline) {
  if (-not [OmpMonitorSaveNative]::IsWindow($owner)) { throw 'Owned monitor closed before its save dialog opened' }
  [OmpMonitorSaveNative]::EnumWindows({
    param($hwnd, $unused)
    $class = New-Object Text.StringBuilder 256
    [void][OmpMonitorSaveNative]::GetClassName($hwnd, $class, $class.Capacity)
    if ($class.ToString() -ne '#32770' -or -not [OmpMonitorSaveNative]::IsWindowVisible($hwnd)) { return $true }
    if ([OmpMonitorSaveNative]::GetWindow($hwnd, 4) -ne $owner -and [OmpMonitorSaveNative]::GetAncestor($hwnd, 3) -ne $owner) { return $true }
    $script:dialog = $hwnd
    return $false
  }, [IntPtr]::Zero) | Out-Null
  if ($script:dialog -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
}
if ($script:dialog -eq [IntPtr]::Zero) { throw 'No native save dialog owned by the monitor was found' }
$script:filenameEdits = New-Object 'System.Collections.Generic.List[System.IntPtr]'
$script:editDiagnostics = New-Object 'System.Collections.Generic.List[object]'
[OmpMonitorSaveNative]::EnumChildWindows($script:dialog, {
  param($hwnd, $unused)
  $class = New-Object Text.StringBuilder 256
  $text = New-Object Text.StringBuilder 4096
  [void][OmpMonitorSaveNative]::GetClassName($hwnd, $class, $class.Capacity)
  [void][OmpMonitorSaveNative]::GetWindowText($hwnd, $text, $text.Capacity)
  $controlId = [OmpMonitorSaveNative]::GetDlgCtrlID($hwnd)
  $matchesDefault = $text.ToString() -eq $env:OMP_MONITOR_EXPORT_DEFAULT
  if ($class.ToString() -eq 'Edit') {
    $script:editDiagnostics.Add([pscustomobject]@{ id = $controlId; textLength = $text.Length; matchesDefault = $matchesDefault; visible = [OmpMonitorSaveNative]::IsWindowVisible($hwnd) })
  }
  # 1001 is the modern common dialog's filename Edit; 1148 is the legacy filename control.
  $filenameIdentity = $matchesDefault -or $controlId -eq 1001 -or $controlId -eq 1148
  if ($class.ToString() -eq 'Edit' -and $filenameIdentity -and [OmpMonitorSaveNative]::IsWindowVisible($hwnd) -and [OmpMonitorSaveNative]::IsWindowEnabled($hwnd)) {
    $script:filenameEdits.Add($hwnd)
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
if ($script:filenameEdits.Count -ne 1) { throw ('Native filename edit is missing or ambiguous; no controls modified: ' + ($script:editDiagnostics | ConvertTo-Json -Compress)) }
$save = [OmpMonitorSaveNative]::GetDlgItem($script:dialog, 1)
if ($save -eq [IntPtr]::Zero -or -not [OmpMonitorSaveNative]::IsWindowEnabled($save)) { throw 'Owned save button unavailable' }
[void][OmpMonitorSaveNative]::SendMessage($script:filenameEdits[0], 12, [IntPtr]::Zero, $destination)
if (-not [OmpMonitorSaveNative]::PostMessage($save, 245, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Owned save button could not be activated' }
[pscustomobject]@{ ownedNativeDialog = $true; filenameControlMatched = $true; destinationOwned = $true; saveButtonActivated = $true } | ConvertTo-Json -Compress
