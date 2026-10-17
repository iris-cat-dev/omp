[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$AppPath,
    [string]$DataDirectory,
    [ValidateRange(0, 65535)]
    [int]$DebugPort = 0
)

$ErrorActionPreference = "Stop"

function Write-NewJson([string]$Path, $Value) {
    if (Test-Path -LiteralPath $Path) { return }
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 10) + "`n")
    $file = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $file.Write($bytes, 0, $bytes.Length) } finally { $file.Dispose() }
}

$executable = (Resolve-Path -LiteralPath $AppPath).Path
if (-not (Test-Path -LiteralPath $executable -PathType Leaf) -or [System.IO.Path]::GetFileName($executable) -ne "OMP Desktop.exe") {
    throw "Expected the unpacked OMP Desktop.exe, not an installer."
}
if (-not $DataDirectory) {
    $DataDirectory = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "OMP-Desktop-Wallpaper-Trial"
}
if (-not [System.IO.Path]::IsPathRooted($DataDirectory)) { throw "Trial data directory must be an absolute path." }
$state = [System.IO.Path]::GetFullPath($DataDirectory)
$markerPath = Join-Path $state "wallpaper-trial.json"
if (Test-Path -LiteralPath $state) {
    $directory = Get-Item -LiteralPath $state -Force
    if (-not $directory.PSIsContainer -or ($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "Trial data directory must be a regular directory."
    }
    if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
        $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($marker.kind -ne "omp-desktop-wallpaper-trial" -or $marker.version -ne 1) { throw "Unrecognized trial data marker." }
    } elseif (@(Get-ChildItem -LiteralPath $state -Force).Count -ne 0) {
        throw "Refusing to use an existing non-trial directory. No data was changed."
    }
} else {
    New-Item -ItemType Directory -Path $state | Out-Null
}
Write-NewJson $markerPath @{ kind = "omp-desktop-wallpaper-trial"; version = 1 }

$profile = Join-Path $state "profile"
$userData = Join-Path $state "electron-user-data"
$daemonHome = Join-Path $state "daemon-home"
$agentHome = Join-Path $profile ".omp\agent"
$tempDirectory = Join-Path $state "temp"
foreach ($directory in @($profile, $userData, $daemonHome, $agentHome, $tempDirectory)) {
    if (Test-Path -LiteralPath $directory) {
        if ((Get-Item -LiteralPath $directory -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw "Trial state subdirectories cannot redirect to another profile."
        }
    } else {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
}

$configPath = Join-Path $daemonHome "config.json"
if (-not (Test-Path -LiteralPath $configPath)) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        $port = $listener.LocalEndpoint.Port
    } finally { $listener.Stop() }
    Write-NewJson $configPath @{
        version = 1
        daemon = @{
            listen = "127.0.0.1:$port"
            relay = @{ enabled = $false }
            mcp = @{ enabled = $false; injectIntoAgents = $false }
        }
    }
}
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.daemon.listen -notmatch '^127\.0\.0\.1:([0-9]+)$' -or [int]$Matches[1] -lt 1 -or [int]$Matches[1] -gt 65535) {
    throw "Trial daemon must use its own loopback TCP port. Existing settings were not overwritten."
}
Write-NewJson (Join-Path $userData "desktop-settings.json") @{
    version = 1
    settings = @{
        window = @{ closeBehavior = "quit" }
        daemon = @{ manageBuiltInDaemon = $true; keepRunningAfterQuit = $false }
    }
}
$emptyConfig = Join-Path $agentHome "trial-config.json"
Write-NewJson $emptyConfig @{}

$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = $executable
$start.WorkingDirectory = $profile
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
# Do not inherit provider secrets, development overrides or another daemon's home.
$start.EnvironmentVariables.Clear()
# Windows shell folders and Quick Access must keep the real Windows profile.
# OMP isolation uses HOME and the explicit application directories below.
foreach ($name in @("SystemRoot", "WINDIR", "SystemDrive", "ComSpec", "PATH", "PATHEXT", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "USERNAME", "USERDOMAIN", "SESSIONNAME", "ProgramFiles", "ProgramFiles(x86)", "CommonProgramFiles", "CommonProgramFiles(x86)", "ProgramData", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA")) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($null -ne $value) { $start.EnvironmentVariables[$name] = $value }
}
$environment = @{
    HOME = $profile
    TEMP = $tempDirectory
    TMP = $tempDirectory
    OMP_DESKTOP_HOME = $daemonHome
    PASEO_HOME = $daemonHome
    PASEO_LISTEN = $config.daemon.listen
    PASEO_ELECTRON_USER_DATA_DIR = $userData
    PASEO_TEST_APP_NAME = "OMP Desktop - 壁纸试用版"
    PASEO_DISABLE_APP_UPDATES = "1"
    OMP_PROFILE = "default"
    PI_PROFILE = "default"
    OMP_AGENT_DIR = $agentHome
    PI_CODING_AGENT_DIR = $agentHome
    PI_CONFIG_FILES = $emptyConfig
    XDG_CONFIG_HOME = (Join-Path $profile ".config")
    XDG_CACHE_HOME = (Join-Path $profile ".cache")
    XDG_DATA_HOME = (Join-Path $profile ".local\share")
    PASEO_ELECTRON_FLAGS = "--lang=zh-CN"
}
if ($DebugPort -ne 0) {
    $environment.PASEO_ELECTRON_FLAGS += " --remote-debugging-address=127.0.0.1 --remote-debugging-port=$DebugPort"
}
foreach ($entry in $environment.GetEnumerator()) { $start.EnvironmentVariables[$entry.Key] = [string]$entry.Value }
$child = [System.Diagnostics.Process]::Start($start)
try {
    [pscustomobject]@{ pid = $child.Id; dataDirectory = $state; daemonHome = $daemonHome; userData = $userData; listen = $config.daemon.listen; debugPort = $DebugPort } | ConvertTo-Json -Compress
} finally { $child.Dispose() }
