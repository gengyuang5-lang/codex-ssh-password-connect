$ErrorActionPreference = 'Stop'

$sourceRoot = $PSScriptRoot
$profileRoot = [Environment]::GetFolderPath('UserProfile')
$pluginRoot = Join-Path $profileRoot '.codex\plugins\codex-ssh-password'
$marketplaceDir = Join-Path $profileRoot '.agents\plugins'
$marketplacePath = Join-Path $marketplaceDir 'marketplace.json'
$CodexCommand = 'codex'
$legacyMcpName = 'ssh-password-local-project'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is required. Install Node.js 22.5 or newer, then run npm ci --omit=dev in this plugin folder.'
}
$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$nodeVersionText = (& $nodeCommand --version).Trim()
if ($nodeVersionText.StartsWith('v')) { $nodeVersionText = $nodeVersionText.Substring(1) }
try { $nodeVersion = [Version]$nodeVersionText } catch { throw 'Could not determine the Node.js version.' }
if ($nodeVersion -lt [Version]'22.5.0') { throw 'Node.js 22.5 or newer is required for local Codex title lookup.' }
if (-not (Test-Path (Join-Path $sourceRoot 'node_modules\@modelcontextprotocol\sdk'))) {
    throw 'Plugin dependencies are missing. Run npm ci --omit=dev in this plugin folder first.'
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pluginRoot) | Out-Null
New-Item -ItemType Directory -Force -Path $marketplaceDir | Out-Null
New-Item -ItemType Directory -Force -Path $pluginRoot | Out-Null
$targetDependencies = Join-Path $pluginRoot 'node_modules\@modelcontextprotocol\sdk'
if (-not (Test-Path -LiteralPath $targetDependencies)) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'node_modules') -Destination $pluginRoot -Recurse -Force
}
Get-ChildItem -LiteralPath $sourceRoot -Force |
    Where-Object { $_.Name -ne 'node_modules' } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $pluginRoot -Recurse -Force }

$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$chatTitleBackfill = Join-Path $pluginRoot 'server\backfill-chat-labels.js'
& $nodeCommand $chatTitleBackfill
if ($LASTEXITCODE -ne 0) { Write-Warning 'Existing Codex chat titles could not be backfilled; new SSH connections can still show their titles.' }

$promptHelper = Join-Path $pluginRoot 'server\windows-prompts.ps1'
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
& $powershellExe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $promptHelper -Mode Prepare | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Warning 'Windows prompt acceleration helper could not be precompiled; the prompt will compile it on first use.' }

$plugins = @()
$marketplaceName = 'codex-local'
$marketplaceInterface = [PSCustomObject]@{ displayName = 'Local plugins' }
if (Test-Path $marketplacePath) {
    $existingMarketplace = Get-Content -LiteralPath $marketplacePath -Raw | ConvertFrom-Json
    if ($existingMarketplace.name) { $marketplaceName = $existingMarketplace.name }
    if ($existingMarketplace.interface) { $marketplaceInterface = $existingMarketplace.interface }
    $plugins = @($existingMarketplace.plugins)
}

$relativePluginPath = './.codex/plugins/codex-ssh-password'
$plugins = @($plugins | Where-Object { $_.name -ne 'codex-ssh-password' })
$plugins += [PSCustomObject]@{
    name = 'codex-ssh-password'
    source = [PSCustomObject]@{ source = 'local'; path = $relativePluginPath }
    policy = [PSCustomObject]@{ installation = 'AVAILABLE'; authentication = 'ON_INSTALL' }
    category = 'Developer tools'
}
$marketplace = [PSCustomObject]@{
    name = $marketplaceName
    interface = $marketplaceInterface
    plugins = $plugins
}
$marketplaceJson = $marketplace | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($marketplacePath, "$marketplaceJson`n", [System.Text.UTF8Encoding]::new($false))

$codex = Get-Command $CodexCommand -ErrorAction SilentlyContinue
if ($codex) {
    & $codex.Source plugin marketplace add $profileRoot
    if ($LASTEXITCODE -ne 0) { throw 'Could not register the local plugin marketplace.' }

    $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $profileRoot '.codex' }
    $codexConfig = Join-Path $codexHome 'config.toml'
    if (Test-Path -LiteralPath $codexConfig) {
        $backupStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backupPath = "$codexConfig.codex-ssh-$backupStamp.bak"
        Copy-Item -LiteralPath $codexConfig -Destination $backupPath
        Write-Host "Saved Codex config backup: $backupPath"
    }

    $configuredServers = (& $codex.Source mcp list --json) | ConvertFrom-Json
    $legacyServerExists = @($configuredServers | Where-Object { $_.name -eq $legacyMcpName }).Count -gt 0
    if ($legacyServerExists) {
        & $codex.Source mcp remove $legacyMcpName
        if ($LASTEXITCODE -ne 0) { throw "Could not remove duplicate legacy MCP server '$legacyMcpName'." }
        Write-Host "Removed duplicate legacy MCP server '$legacyMcpName'; the plugin is the single SSH entry point."
    }

    if (Test-Path -LiteralPath $codexConfig) {
        $originalConfig = [System.IO.File]::ReadAllText($codexConfig)
        $configText = $originalConfig
        $approvalTables = @(
            [PSCustomObject]@{ Header = '[plugins."codex-ssh-password@codex-local"]'; Body = 'enabled = true' },
            [PSCustomObject]@{ Header = '[plugins."codex-ssh-password@codex-local".mcp_servers."ssh-password"]'; Body = "enabled = true`r`ndefault_tools_approval_mode = `"auto`"" },
            [PSCustomObject]@{ Header = '[plugins."codex-ssh-password@codex-local".mcp_servers."ssh-password".tools.ssh_run]'; Body = 'approval_mode = "prompt"' },
            [PSCustomObject]@{ Header = '[plugins."codex-ssh-password@codex-local".mcp_servers."ssh-password".tools.ssh_write_file]'; Body = 'approval_mode = "prompt"' },
            [PSCustomObject]@{ Header = '[plugins."codex-ssh-password@codex-local".mcp_servers."ssh-password".tools.ssh_patch_file]'; Body = 'approval_mode = "prompt"' },
            [PSCustomObject]@{ Header = '[plugins."codex-ssh-password@codex-local".mcp_servers."ssh-password".tools.ssh_upload_begin]'; Body = 'approval_mode = "prompt"' },
            [PSCustomObject]@{ Header = '[plugins."codex-ssh-password@codex-local".mcp_servers."ssh-password".tools.ssh_upload_chunk]'; Body = 'approval_mode = "prompt"' },
            [PSCustomObject]@{ Header = '[plugins."codex-ssh-password@codex-local".mcp_servers."ssh-password".tools.ssh_upload_commit]'; Body = 'approval_mode = "prompt"' },
            [PSCustomObject]@{ Header = '[plugins."codex-ssh-password@codex-local".mcp_servers."ssh-password".tools.ssh_upload_abort]'; Body = 'approval_mode = "prompt"' }
        )
        foreach ($table in $approvalTables) {
            if (-not $configText.Contains($table.Header)) {
                $configText = $configText.TrimEnd() + "`r`n`r`n" + $table.Header + "`r`n" + $table.Body + "`r`n"
            }
        }

        [System.IO.File]::WriteAllText($codexConfig, $configText, [System.Text.UTF8Encoding]::new($false))
        $null = & $codex.Source mcp list --json
        if ($LASTEXITCODE -ne 0) {
            [System.IO.File]::WriteAllText($codexConfig, $originalConfig, [System.Text.UTF8Encoding]::new($false))
            throw 'Codex rejected the MCP approval settings; the previous Codex config was restored.'
        }
    }
} else {
    Write-Warning 'Plugin files and marketplace were prepared. Add the marketplace with: codex plugin marketplace add "$profileRoot"'
    Write-Warning 'Install and enable codex-ssh-password from the local Codex plugin marketplace.'
}

Write-Host "Installed plugin files at: $pluginRoot"
Write-Host "Marketplace file: $marketplacePath"
Write-Host 'Fully restart Codex and VS Code to load the updated plugin and stop old MCP processes.'
