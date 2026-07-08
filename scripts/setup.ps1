#Requires -Version 5.1
<#
.SYNOPSIS
  Zero Two environment setup — installs and records the tools the app needs,
  then hands off to doctor.ps1 for the authoritative status table + exit code.

.DESCRIPTION
  Implements spec §3.2:
    1. Verify/install Node LTS and Git via winget (idempotent; degrades
       gracefully with manual instructions when winget is absent).
    2. Install the two Microsoft preview CLIs globally via npm:
         @microsoft/powerbi-desktop-bridge-cli   (command: powerbi-desktop)
         @microsoft/powerbi-report-authoring-cli  (command: powerbi-report-author)
       Reads the installed package version/README at install time rather than
       hardcoding preview flags.
    3. Install Fab Inspector CLI (NatVanG/fab-inspector, "PBI Inspector V2")
       and record its path in %APPDATA%\ZeroTwo\config.json.
    4. Detect Power BI Desktop; if below the minimum, print upgrade guidance
       and record doctor state "desktop_outdated".
    5. Detect Claude Code and GitHub Copilot CLI and report login state. This
       script NEVER performs a login and NEVER reads/writes an API key.
    6. Call doctor.ps1 for the summary table and propagate its exit code.

  SECURITY: subscription-login only. This script must never prompt for, accept,
  or store ANTHROPIC_API_KEY / OPENAI_API_KEY or any secret. config.json holds
  only tool paths + preferences.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# --- Constants mirrored from packages/contracts/src/api/doctor.ts -----------
$MinimumNodeMajor = 20
$MinimumPowerBiDesktopVersion = [version]'2.155.756.0'

$ConfigDir  = Join-Path $env:APPDATA 'ZeroTwo'
$ConfigPath = Join-Path $ConfigDir 'config.json'
$ToolsDir   = Join-Path $ConfigDir 'tools'

# --- Output helpers ---------------------------------------------------------
function Write-Step { param([string] $Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Info { param([string] $Message) Write-Host "    $Message" -ForegroundColor Gray }
function Write-Ok   { param([string] $Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn { param([string] $Message) Write-Host "    $Message" -ForegroundColor Yellow }

# --- Config (merge, never clobber; secrets never written) -------------------
function Read-Config {
    if (Test-Path -LiteralPath $ConfigPath) {
        try { return (Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json) } catch { }
    }
    return [pscustomobject]@{}
}

function Set-ConfigValue {
    param($Config, [string] $Name, $Value)
    if ($Config.PSObject.Properties.Name -contains $Name) {
        $Config.$Name = $Value
    } else {
        $Config | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
}

function Save-Config {
    param($Config)
    if (-not (Test-Path -LiteralPath $ConfigDir)) {
        New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
    }
    $Config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
}

# --- Tool probing -----------------------------------------------------------
function Invoke-Tool {
    param([string] $Exe, [string[]] $Arguments = @())
    $result = [pscustomobject]@{ NotFound = $false; Code = $null; Output = '' }
    $cmd = Get-Command $Exe -ErrorAction SilentlyContinue
    if (-not $cmd) { $result.NotFound = $true; return $result }
    try {
        $global:LASTEXITCODE = 0
        $out = & $Exe @Arguments 2>&1
        $result.Code = $LASTEXITCODE
        $result.Output = ($out | Out-String).Trim()
    } catch {
        $result.Code = 1
        $result.Output = $_.Exception.Message
    }
    return $result
}

function ConvertTo-VersionOrNull {
    param([string] $Text)
    if (-not $Text) { return $null }
    $m = [regex]::Match($Text, '(\d+(?:\.\d+){1,3})')
    if (-not $m.Success) { return $null }
    try { return [version]$m.Groups[1].Value } catch { return $null }
}

# --- Step 1: Node + Git via winget ------------------------------------------
function Test-WingetAvailable {
    return [bool](Get-Command 'winget' -ErrorAction SilentlyContinue)
}

function Install-WithWinget {
    param([string] $Id, [string] $DisplayName)
    if (-not (Test-WingetAvailable)) {
        Write-Warn "winget is not available. Install $DisplayName manually, then re-run setup."
        return $false
    }
    Write-Info "Installing $DisplayName via winget ($Id)..."
    try {
        & winget install --id $Id --exact --silent --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "winget exited with code $LASTEXITCODE while installing $DisplayName. Install it manually if it is still missing."
            return $false
        }
        return $true
    } catch {
        Write-Warn "winget failed to install ${DisplayName}: $($_.Exception.Message)"
        return $false
    }
}

function Ensure-Node {
    Write-Step 'Node.js (>= 20 LTS)'
    $r = Invoke-Tool -Exe 'node' -Arguments @('--version')
    if (-not $r.NotFound -and $r.Code -eq 0) {
        $v = ConvertTo-VersionOrNull $r.Output
        if ($v -and $v.Major -ge $MinimumNodeMajor) {
            Write-Ok "Node $($r.Output) already satisfies the requirement."
            return
        }
        Write-Warn "Node $($r.Output) is below the minimum (>= $MinimumNodeMajor)."
    } else {
        Write-Info 'Node.js not found.'
    }
    [void](Install-WithWinget -Id 'OpenJS.NodeJS.LTS' -DisplayName 'Node.js LTS')
}

function Ensure-Git {
    Write-Step 'Git'
    $r = Invoke-Tool -Exe 'git' -Arguments @('--version')
    if (-not $r.NotFound -and $r.Code -eq 0) {
        Write-Ok "$($r.Output) already installed."
        return
    }
    Write-Info 'Git not found.'
    [void](Install-WithWinget -Id 'Git.Git' -DisplayName 'Git')
}

# --- Step 2: Microsoft preview CLIs via npm ---------------------------------
# Print the installed version + README location so preview flags are read from
# the package (spec §3.2 note) rather than hardcoded here.
function Show-NpmPackageDetails {
    param([string] $Package)
    try {
        $rootRes = Invoke-Tool -Exe 'npm' -Arguments @('root', '-g')
        if ($rootRes.Code -eq 0 -and $rootRes.Output) {
            $pkgDir = Join-Path $rootRes.Output $Package
            $pkgJson = Join-Path $pkgDir 'package.json'
            if (Test-Path -LiteralPath $pkgJson) {
                $meta = Get-Content -LiteralPath $pkgJson -Raw | ConvertFrom-Json
                Write-Info "Installed $Package version $($meta.version)."
            }
            $readme = Get-ChildItem -LiteralPath $pkgDir -Filter 'README*' -File -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($readme) {
                Write-Info "Preview flags/usage: see $($readme.FullName)"
            }
        }
    } catch {
        Write-Info "Could not read package metadata for ${Package}: $($_.Exception.Message)"
    }
}

function Ensure-NpmGlobalCli {
    param([string] $Package, [string] $Command)
    Write-Step "$Package (command: $Command)"
    if (-not (Get-Command 'npm' -ErrorAction SilentlyContinue)) {
        Write-Warn 'npm is not available (Node install may have failed). Skipping; re-run setup after Node is installed.'
        return
    }
    $probe = Invoke-Tool -Exe $Command -Arguments @('--version')
    if (-not $probe.NotFound -and $probe.Code -eq 0) {
        Write-Ok "$Command already present ($($probe.Output))."
        Show-NpmPackageDetails -Package $Package
        return
    }
    Write-Info "Installing $Package globally..."
    try {
        & npm install -g $Package
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "npm install -g $Package exited with code $LASTEXITCODE."
            return
        }
        Write-Ok "$Package installed."
        Show-NpmPackageDetails -Package $Package
    } catch {
        Write-Warn "Failed to install ${Package}: $($_.Exception.Message)"
    }
}

# --- Step 3: Fab Inspector (PBI Inspector V2) -------------------------------
# TODO(confirm-on-windows): The exact NatVanG/fab-inspector release asset name
# and the CLI executable name must be confirmed against the upstream README at
# real-machine time. This routine downloads the latest GitHub release, picks a
# Windows x64 .zip asset, extracts it, and records the first CLI-looking .exe.
# The repo slug (NatVanG/fab-inspector) comes from the spec; the asset/exe
# naming is a best-effort guess — verify before shipping. No fake URL is used;
# everything is resolved from the GitHub releases API.
function Ensure-FabInspector {
    param($Config)
    Write-Step 'Fab Inspector CLI (NatVanG/fab-inspector, "PBI Inspector V2")'

    # Idempotent: already recorded and present?
    if ($Config.PSObject.Properties.Name -contains 'FabInspectorPath' -and
        $Config.FabInspectorPath -and (Test-Path -LiteralPath $Config.FabInspectorPath)) {
        Write-Ok "Already installed at $($Config.FabInspectorPath)."
        return
    }
    # Already on PATH?
    $onPath = Get-Command 'fab-inspector' -ErrorAction SilentlyContinue
    if ($onPath) {
        Write-Ok "Found on PATH at $($onPath.Source)."
        Set-ConfigValue -Config $Config -Name 'FabInspectorPath' -Value $onPath.Source
        return
    }

    $installDir = Join-Path $ToolsDir 'fab-inspector'
    try {
        $api = 'https://api.github.com/repos/NatVanG/fab-inspector/releases/latest'
        Write-Info "Resolving latest release from $api ..."
        $release = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'ZeroTwo-Setup'; 'Accept' = 'application/vnd.github+json' }

        $asset = $release.assets |
            Where-Object { $_.name -match '(?i)win.*(x64|amd64)' -and $_.name -match '(?i)\.zip$' } |
            Select-Object -First 1
        if (-not $asset) {
            $asset = $release.assets | Where-Object { $_.name -match '(?i)\.zip$' } | Select-Object -First 1
        }
        if (-not $asset) {
            Write-Warn 'No downloadable .zip asset found on the latest release.'
            Write-Warn 'TODO: install Fab Inspector manually per its README, then set FabInspectorPath in %APPDATA%\ZeroTwo\config.json.'
            return
        }

        if (-not (Test-Path -LiteralPath $installDir)) {
            New-Item -ItemType Directory -Force -Path $installDir | Out-Null
        }
        $zipPath = Join-Path $installDir $asset.name
        Write-Info "Downloading $($asset.name) ..."
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -UseBasicParsing
        Write-Info 'Extracting ...'
        Expand-Archive -LiteralPath $zipPath -DestinationPath $installDir -Force
        Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue

        # Locate the CLI executable. Prefer a name that looks like an inspector.
        $exe = Get-ChildItem -LiteralPath $installDir -Recurse -Filter '*.exe' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '(?i)inspector|fab' } | Select-Object -First 1
        if (-not $exe) {
            $exe = Get-ChildItem -LiteralPath $installDir -Recurse -Filter '*.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
        }
        if (-not $exe) {
            Write-Warn "Extracted the release but found no .exe under $installDir."
            Write-Warn 'TODO: confirm the CLI entry point in the upstream README and set FabInspectorPath manually.'
            return
        }
        Set-ConfigValue -Config $Config -Name 'FabInspectorPath' -Value $exe.FullName
        Write-Ok "Installed Fab Inspector at $($exe.FullName)."
    } catch {
        Write-Warn "Could not auto-install Fab Inspector: $($_.Exception.Message)"
        Write-Warn 'TODO: install it manually per NatVanG/fab-inspector README, then set FabInspectorPath in %APPDATA%\ZeroTwo\config.json.'
    }
}

# --- Step 4: Power BI Desktop version (upgrade guidance + doctor state) ------
function Get-PowerBiDesktopVersion {
    $roots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        try { $subkeys = Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue } catch { continue }
        foreach ($key in $subkeys) {
            try { $props = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue } catch { continue }
            if ($props -and $props.DisplayName -like '*Power BI Desktop*' -and $props.DisplayVersion) {
                return [string]$props.DisplayVersion
            }
        }
    }
    $exe = Get-Command 'PBIDesktop.exe' -ErrorAction SilentlyContinue
    if ($exe -and $exe.Version) { return [string]$exe.Version }
    return $null
}

function Check-PowerBiDesktop {
    param($Config)
    Write-Step 'Power BI Desktop'
    $version = Get-PowerBiDesktopVersion
    if (-not $version) {
        Write-Warn 'Power BI Desktop is not installed. Install it from the Microsoft Store or Download Center.'
        Set-ConfigValue -Config $Config -Name 'doctorState' -Value 'desktop_missing'
        return
    }
    $detected = ConvertTo-VersionOrNull $version
    if ($detected -and $detected -lt $MinimumPowerBiDesktopVersion) {
        Write-Warn "Power BI Desktop $version is below the minimum $MinimumPowerBiDesktopVersion (June 2026)."
        Write-Warn 'Upgrade: update via the Microsoft Store, or download the latest from https://www.microsoft.com/download/details.aspx?id=58494'
        Set-ConfigValue -Config $Config -Name 'doctorState' -Value 'desktop_outdated'
        return
    }
    Write-Ok "Power BI Desktop $version satisfies the requirement."
    if ($Config.PSObject.Properties.Name -contains 'doctorState') { $Config.doctorState = 'ok' }
}

# --- Step 5: Agent detection (report only; NEVER log in) --------------------
function Report-Agent {
    param([string] $Id, [string] $Label)
    $version = Invoke-Tool -Exe $Id -Arguments @('--version')
    if ($version.NotFound -or $version.Code -ne 0) {
        Write-Info "${Label}: not installed."
        return $false
    }
    $auth = Invoke-Tool -Exe $Id -Arguments @('auth', 'status')
    $authText = "$($auth.Output)"
    $loggedIn = ($auth.Code -eq 0) -and ($authText -notmatch 'not logged in|logged out|please (log|sign) in|unauthenticated')
    if ($loggedIn) {
        Write-Ok "${Label}: signed in ($($version.Output))."
        return $true
    }
    Write-Warn "${Label}: installed ($($version.Output)) but not signed in. Zero Two will guide you through subscription login interactively."
    return $false
}

function Report-Agents {
    Write-Step 'AI agents (Claude Code / GitHub Copilot CLI)'
    $claudeOk  = Report-Agent -Id 'claude'  -Label 'Claude Code'
    $copilotOk = Report-Agent -Id 'copilot' -Label 'GitHub Copilot CLI'
    if (-not ($claudeOk -or $copilotOk)) {
        Write-Warn 'No agent is signed in yet. Sign in to at least one (subscription login) before using Zero Two.'
    }
}

# --- Orchestration ----------------------------------------------------------
Write-Host ''
Write-Host 'Zero Two - Setup' -ForegroundColor Cyan
Write-Host ('=' * 78)

$config = Read-Config

Ensure-Node
Ensure-Git
Ensure-NpmGlobalCli -Package '@microsoft/powerbi-desktop-bridge-cli'   -Command 'powerbi-desktop'
Ensure-NpmGlobalCli -Package '@microsoft/powerbi-report-authoring-cli' -Command 'powerbi-report-author'
Ensure-FabInspector -Config $config
Check-PowerBiDesktop -Config $config
Report-Agents

Save-Config -Config $config
Write-Host ''
Write-Info "Config written to $ConfigPath (tool paths + preferences only; no secrets)."

# --- Step 6: hand off to doctor.ps1 for the authoritative summary + exit -----
Write-Host ''
Write-Host ('=' * 78)
Write-Host 'Running environment doctor...' -ForegroundColor Cyan

$doctor = Join-Path $PSScriptRoot 'doctor.ps1'
& $doctor
exit $LASTEXITCODE
