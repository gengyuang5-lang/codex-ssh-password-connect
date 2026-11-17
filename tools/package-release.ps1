param(
    [string]$OutputDirectory,
    [string]$DesktopPath
)

$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$parentDirectory = Split-Path -Parent $sourceRoot
$manifest = Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json
$version = $manifest.version

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $parentDirectory 'release'
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$node = (Get-Command node -ErrorAction Stop).Source
$nodeVersionText = (& $node --version).Trim()
if ($nodeVersionText.StartsWith('v')) { $nodeVersionText = $nodeVersionText.Substring(1) }
if ([Version]$nodeVersionText -lt [Version]'22.5.0') {
    throw 'Node.js 22.5 or newer is required.'
}

foreach ($script in @('server\index.js', 'server\chat-titles.js', 'server\backfill-chat-labels.js')) {
    & $node --check (Join-Path $sourceRoot $script)
    if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax check failed: $script" }
}

$null = & $node -e "const fs=require('fs'); for (const p of process.argv.slice(1)) JSON.parse(fs.readFileSync(p,'utf8'));" `
    (Join-Path $sourceRoot 'package.json') `
    (Join-Path $sourceRoot 'package-lock.json') `
    (Join-Path $sourceRoot 'plugin.json')
if ($LASTEXITCODE -ne 0) { throw 'A package manifest is not valid JSON.' }

& (Join-Path $sourceRoot 'monitor\build-monitor.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Could not build CodexSSHMonitor.exe.' }

$python = (Get-Command python -ErrorAction Stop).Source
& $python (Join-Path $sourceRoot 'tools\build-demo-video.py')
if ($LASTEXITCODE -ne 0) { throw 'Could not build docs\demo.mp4.' }

$archiveName = "CodexSSHPasswordConnect-$version-win-x64.zip"
$archivePath = Join-Path $OutputDirectory $archiveName
Compress-Archive -Path (Join-Path $sourceRoot '*') -DestinationPath $archivePath -Force
$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumPath = "$archivePath.sha256"
[System.IO.File]::WriteAllText($checksumPath, "$hash  $archiveName`n", [System.Text.UTF8Encoding]::new($false))

if (-not [string]::IsNullOrWhiteSpace($DesktopPath)) {
    New-Item -ItemType Directory -Force -Path $DesktopPath | Out-Null
    Copy-Item -LiteralPath $archivePath -Destination (Join-Path $DesktopPath $archiveName) -Force
    Copy-Item -LiteralPath $checksumPath -Destination (Join-Path $DesktopPath (Split-Path -Leaf $checksumPath)) -Force
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'docs\demo.mp4') -Destination (Join-Path $DesktopPath 'CodexSSHPasswordConnect-demo.mp4') -Force
    Copy-Item -LiteralPath $archivePath -Destination (Join-Path $DesktopPath 'CodexSSHPasswordConnect.zip') -Force
}

[PSCustomObject]@{
    Version = $version
    Archive = $archivePath
    SHA256 = $hash
    Demo = Join-Path $sourceRoot 'docs\demo.mp4'
    DesktopCopy = if ($DesktopPath) { Join-Path $DesktopPath $archiveName } else { '' }
} | Format-List
