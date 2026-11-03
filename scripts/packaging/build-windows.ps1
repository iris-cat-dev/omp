$ErrorActionPreference = "Stop"
$BuilderArgs = $args
$RepositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# Windows PowerShell 5.1 does not turn native command failures into exceptions.
function Invoke-CheckedCommand {
    param(
        [string]$Command,
        [string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE."
    }
}

# mini-electron currently publishes a Windows x64 runtime only.
$Arches = @("x64")
if (-not [string]::IsNullOrWhiteSpace($env:WINDOWS_ARCHES)) {
    $Arches = $env:WINDOWS_ARCHES.Trim() -split '\s+'
}
foreach ($Arch in $Arches) {
    if ($Arch -cne "x64") {
        throw "Unsupported Windows architecture: $Arch"
    }
}

$PreviousTarget = $env:OMP_DESKTOP_PACKAGE_TARGET
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "omp-desktop-windows-$([guid]::NewGuid().ToString('N'))"
Push-Location -LiteralPath $RepositoryRoot
try {
    $HostPlatformArch = Invoke-CheckedCommand "node" @("-p", "process.platform + ':' + process.arch")
    if ($HostPlatformArch -cne "win32:x64") {
        throw "This PowerShell packaging pipeline requires native Windows x64; use npm run build:windows on macOS with a Windows SDK artifact."
    }
    $env:OMP_DESKTOP_PACKAGE_TARGET = "win32-x64"

    # Desktop stages every Windows native dependency after prerequisite builds.

    # Merge release update metadata only after all requested architectures finish.
    $Version = Invoke-CheckedCommand "node" @("-p", "require('./packages/desktop/package.json').version")
    $BuildOutput = (Invoke-CheckedCommand "node" (@("packages/desktop/scripts/windows-build-output.mjs", $Version) + $BuilderArgs)).Split("`t")
    $ReleaseDir = Join-Path $RepositoryRoot $BuildOutput[0]
    $MetadataFilename = $BuildOutput[1]
    $LegacyInstaller = $BuildOutput[2]
    foreach ($Name in @($LegacyInstaller, "$LegacyInstaller.blockmap")) {
        $StalePath = Join-Path $ReleaseDir $Name
        if (Test-Path -LiteralPath $StalePath) {
            Remove-Item -LiteralPath $StalePath -Force
        }
    }

    $MetadataDir = Join-Path $TempDir "update-metadata"
    New-Item -ItemType Directory -Path $MetadataDir -Force | Out-Null
    $MetadataPath = Join-Path $ReleaseDir $MetadataFilename
    $MetadataFiles = @()
    foreach ($Arch in $Arches) {
        Invoke-CheckedCommand "npm.cmd" (@("run", "build:desktop", "--", "--win", "--$Arch", "--publish", "never") + $BuilderArgs)
        $SnapshotPath = Join-Path $MetadataDir "$Arch-$MetadataFilename"
        Copy-Item -LiteralPath $MetadataPath -Destination $SnapshotPath
        $MetadataFiles += $SnapshotPath
    }

    Invoke-CheckedCommand "node" (@("scripts/packaging/merge-windows-update-metadata.mjs", $MetadataPath) + $MetadataFiles)
} finally {
    $env:OMP_DESKTOP_PACKAGE_TARGET = $PreviousTarget
    if (Test-Path -LiteralPath $TempDir) {
        Remove-Item -LiteralPath $TempDir -Recurse -Force
    }
    Pop-Location
}
