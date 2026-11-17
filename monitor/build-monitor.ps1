param(
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSEdition -eq 'Core') {
    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $windowsPowerShell)) {
        throw 'Windows PowerShell 5.1 is required to compile the WinForms monitor.'
    }
    $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $arguments += @('-OutputPath', $OutputPath)
    }
    & $windowsPowerShell @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Windows PowerShell 5.1 failed to compile the monitor.' }
    return
}

$source = Join-Path $PSScriptRoot 'CodexSSHMonitor.cs'
$output = if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    Join-Path (Split-Path -Parent $PSScriptRoot) 'CodexSSHMonitor.exe'
} else {
    [System.IO.Path]::GetFullPath($OutputPath)
}
$outputDirectory = Split-Path -Parent $output
if (-not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
}
$references = @(
    (Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\System.Windows.Forms.dll'),
    (Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\System.Drawing.dll'),
    (Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\System.Web.Extensions.dll')
)

Add-Type -TypeDefinition ([System.IO.File]::ReadAllText($source)) `
    -OutputAssembly $output `
    -OutputType WindowsApplication `
    -ReferencedAssemblies $references

Write-Host "Built monitor app: $output"
