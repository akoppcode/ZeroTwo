#Requires -Version 5.1
<#
.SYNOPSIS
  Zero Two environment doctor — a standalone, READ-ONLY environment check.

.DESCRIPTION
  Runs the Zero Two environment checks (spec §3.1) and prints a per-item
  status table (OK / WARNING / MISSING) plus an overall status line, then
  exits 0 when all HARD requirements pass and non-zero otherwise.

  The check matrix and the hard/soft classification are a faithful mirror of
  the daemon's EnvironmentService
  (apps/daemon/src/environment/environment-service.ts). Keep them in lockstep:
    - Hard checks (a non-ok hard check => overall "error" => exit 1):
        Windows, Node >= 20, Git, the two Microsoft CLIs, Fab Inspector,
        Power BI Desktop (MISSING is hard; OUTDATED is a soft warning),
        and the derived "at least one agent signed in".
    - Soft checks (warnings that still allow a pass):
        Desktop bridge connectivity, and each individual agent (Claude /
        Copilot) — only "no agent signed in at all" is a hard failure.

  This script performs NO installs and NO logins. It is safe to run anytime.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# --- Constants mirrored from packages/contracts/src/api/doctor.ts -----------
$MinimumNodeMajor = 20
$MinimumPowerBiDesktopVersion = [version]'2.155.756.0'

$ConfigPath = Join-Path $env:APPDATA 'ZeroTwo\config.json'

# --- Small helpers ----------------------------------------------------------

# Read the Zero Two config.json (tool paths + preferences, never secrets).
# Returns $null when absent or unreadable — callers treat that as "no config".
function Get-ZeroTwoConfig {
    if (-not (Test-Path -LiteralPath $ConfigPath)) { return $null }
    try {
        return (Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json)
    } catch {
        return $null
    }
}

# Invoke an external tool, capturing exit code and combined output without
# ever throwing. A tool that is not on PATH resolves to NotFound = $true.
function Invoke-Tool {
    param(
        [Parameter(Mandatory)] [string]   $Exe,
        [Parameter()]          [string[]] $Arguments = @()
    )
    $result = [pscustomobject]@{ NotFound = $false; Code = $null; Output = '' }
    $cmd = Get-Command $Exe -ErrorAction SilentlyContinue
    if (-not $cmd) {
        $result.NotFound = $true
        return $result
    }
    try {
        $global:LASTEXITCODE = 0
        $out = & $Exe @Arguments 2>&1
        $result.Code = $LASTEXITCODE
        $result.Output = ($out | Out-String).Trim()
    } catch {
        # Tool resolved but failed to launch/run — treat as present-but-failing.
        $result.Code = 1
        $result.Output = $_.Exception.Message
    }
    return $result
}

# Build a normalized check record. Status is one of ok|warning|error.
function New-Check {
    param(
        [string] $Id,
        [string] $Label,
        [bool]   $Hard,
        [string] $Status,
        [string] $Detected,
        [string] $Remediation
    )
    [pscustomobject]@{
        Id          = $Id
        Label       = $Label
        Hard        = $Hard
        Status      = $Status
        Detected    = $Detected
        Remediation = $Remediation
    }
}

# --- Power BI Desktop detection (spec §3.1) ---------------------------------
# Registry Uninstall keys (HKLM, HKLM WOW6432Node, HKCU): DisplayName like
# "Power BI Desktop" -> DisplayVersion. Falls back to PBIDesktop.exe file
# version if the registry has no match.
function Get-PowerBiDesktopVersion {
    $roots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        try {
            $subkeys = Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue
        } catch {
            continue
        }
        foreach ($key in $subkeys) {
            try {
                $props = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
            } catch {
                continue
            }
            if ($props -and $props.DisplayName -like '*Power BI Desktop*' -and $props.DisplayVersion) {
                return [string]$props.DisplayVersion
            }
        }
    }
    # Fallback: PBIDesktop.exe file version (Store / Download Center installs).
    $exe = Get-Command 'PBIDesktop.exe' -ErrorAction SilentlyContinue
    if ($exe -and $exe.Version) { return [string]$exe.Version }
    return $null
}

# Parse a dotted version, tolerating 2-4 numeric segments; returns [version]
# or $null when no numeric version can be extracted.
function ConvertTo-VersionOrNull {
    param([string] $Text)
    if (-not $Text) { return $null }
    $m = [regex]::Match($Text, '(\d+(?:\.\d+){1,3})')
    if (-not $m.Success) { return $null }
    try { return [version]$m.Groups[1].Value } catch { return $null }
}

# --- Individual checks (mirror EnvironmentService) --------------------------

function Test-Windows {
    if (-not [Environment]::Is64BitOperatingSystem) {
        return New-Check 'windows' 'Windows 10/11 (x64)' $true 'error' 'Windows (32-bit)' `
            'A 64-bit build of Windows 10/11 is required.'
    }
    $ver = [Environment]::OSVersion.Version
    return New-Check 'windows' 'Windows 10/11 (x64)' $true 'ok' "Windows $ver (x64)" $null
}

function Test-Node {
    $r = Invoke-Tool -Exe 'node' -Arguments @('--version')
    if ($r.NotFound -or $r.Code -ne 0) {
        return New-Check 'node' 'Node.js' $true 'error' $null `
            "Node.js $MinimumNodeMajor+ is required. Install: winget install OpenJS.NodeJS.LTS"
    }
    $v = ConvertTo-VersionOrNull $r.Output
    $major = if ($v) { $v.Major } else { 0 }
    if ($major -ge $MinimumNodeMajor) {
        return New-Check 'node' 'Node.js' $true 'ok' $r.Output $null
    }
    return New-Check 'node' 'Node.js' $true 'error' $r.Output `
        "Node.js $MinimumNodeMajor+ is required. Install: winget install OpenJS.NodeJS.LTS"
}

function Test-Git {
    $r = Invoke-Tool -Exe 'git' -Arguments @('--version')
    if ($r.NotFound -or $r.Code -ne 0) {
        return New-Check 'git' 'Git' $true 'error' $null `
            'Git is required. Install: winget install Git.Git'
    }
    return New-Check 'git' 'Git' $true 'ok' $r.Output $null
}

function Test-PowerBiDesktop {
    $version = Get-PowerBiDesktopVersion
    if (-not $version) {
        return New-Check 'powerbi-desktop' 'Power BI Desktop' $true 'error' $null `
            'Power BI Desktop is not installed. Install it from the Microsoft Store or Download Center.'
    }
    $detected = ConvertTo-VersionOrNull $version
    if ($detected -and $detected -lt $MinimumPowerBiDesktopVersion) {
        return New-Check 'powerbi-desktop' 'Power BI Desktop' $true 'warning' $version `
            "Power BI Desktop $MinimumPowerBiDesktopVersion+ is required for the Desktop bridge. Update Power BI Desktop."
    }
    return New-Check 'powerbi-desktop' 'Power BI Desktop' $true 'ok' $version $null
}

# The two Microsoft preview CLIs: probe `--version`; missing/failing is a hard
# error with the exact `npm install -g <pkg>` remediation.
function Test-VersionedCli {
    param(
        [string] $Id,
        [string] $Label,
        [string] $Command,
        [string] $Package
    )
    $r = Invoke-Tool -Exe $Command -Arguments @('--version')
    if ($r.NotFound -or $r.Code -ne 0) {
        return New-Check $Id $Label $true 'error' $null "$Label is not installed. Install: npm install -g $Package"
    }
    $detected = if ($r.Output) { $r.Output } else { 'installed' }
    return New-Check $Id $Label $true 'ok' $detected $null
}

# Fab Inspector (PBI Inspector V2): the daemon probes `fab-inspector --help` on
# PATH. We additionally honour a recorded install path in config.json
# (FabInspectorPath) so a non-PATH install still passes.
function Test-FabInspector {
    $config = Get-ZeroTwoConfig
    $exe = 'fab-inspector'
    if ($config -and $config.FabInspectorPath -and (Test-Path -LiteralPath $config.FabInspectorPath)) {
        $exe = $config.FabInspectorPath
    }
    $r = Invoke-Tool -Exe $exe -Arguments @('--help')
    if ($r.NotFound -or $r.Code -ne 0) {
        return New-Check 'fab-inspector' 'Fab Inspector CLI' $true 'error' $null `
            'Fab Inspector (PBI Inspector V2) is not installed. Run setup.ps1 to install it (NatVanG/fab-inspector).'
    }
    $detected = if ($exe -ne 'fab-inspector') { $exe } else { 'installed' }
    return New-Check 'fab-inspector' 'Fab Inspector CLI' $true 'ok' $detected $null
}

# Desktop bridge liveness: SOFT check. `powerbi-desktop status` reporting
# "connected" is ok; anything else is a warning; the CLI missing is a soft error.
function Test-DesktopBridge {
    $r = Invoke-Tool -Exe 'powerbi-desktop' -Arguments @('status')
    if ($r.NotFound) {
        return New-Check 'desktop-bridge' 'Desktop bridge' $false 'error' $null `
            'The Desktop bridge CLI is not installed.'
    }
    $out = $r.Output.ToLowerInvariant()
    if ($out -match 'connected' -and $out -notmatch 'not[_ ]connected') {
        return New-Check 'desktop-bridge' 'Desktop bridge' $false 'ok' 'connected' $null
    }
    return New-Check 'desktop-bridge' 'Desktop bridge' $false 'warning' 'not connected' `
        'Open a report in Power BI Desktop and enable "Enable external tool access to Power BI Desktop through secure local APIs" (Options -> Preview features), then re-check.'
}

# Agent CLI: SOFT check. `--version` proves install; `auth status` proves
# subscription login. We never attempt or store a login here.
function Test-Agent {
    param(
        [string] $Id,
        [string] $Label
    )
    $version = Invoke-Tool -Exe $Id -Arguments @('--version')
    if ($version.NotFound -or $version.Code -ne 0) {
        return New-Check $Id $Label $false 'warning' $null "$Label is not installed."
    }
    $auth = Invoke-Tool -Exe $Id -Arguments @('auth', 'status')
    $authText = "$($auth.Output)"
    $loggedIn = ($auth.Code -eq 0) -and ($authText -notmatch 'not logged in|logged out|please (log|sign) in|unauthenticated')
    if (-not $loggedIn) {
        $detected = if ($version.Output) { $version.Output } else { 'installed' }
        return New-Check $Id $Label $false 'warning' "$detected (not signed in)" `
            "Sign in to $Label with your subscription from Settings -> Agents."
    }
    $detected = if ($auth.Output) { $auth.Output } elseif ($version.Output) { $version.Output } else { 'signed in' }
    return New-Check $Id $Label $false 'ok' $detected $null
}

# Derived HARD requirement: at least one agent installed AND signed in.
function Test-AgentsAggregate {
    param($Claude, $Copilot)
    if ($Claude.Status -eq 'ok' -or $Copilot.Status -eq 'ok') {
        return New-Check 'agents' 'At least one agent signed in' $true 'ok' $null $null
    }
    return New-Check 'agents' 'At least one agent signed in' $true 'error' $null `
        'Sign in to Claude Code or GitHub Copilot CLI (subscription login) so Zero Two can drive an agent.'
}

# --- Orchestration ----------------------------------------------------------

function Get-DoctorChecks {
    $windows   = Test-Windows
    $node      = Test-Node
    $git       = Test-Git
    $desktop   = Test-PowerBiDesktop
    $bridgeCli = Test-VersionedCli 'desktop-bridge-cli'  'Power BI Desktop bridge CLI'   'powerbi-desktop'       '@microsoft/powerbi-desktop-bridge-cli'
    $reportCli = Test-VersionedCli 'report-authoring-cli' 'Power BI report-authoring CLI' 'powerbi-report-author' '@microsoft/powerbi-report-authoring-cli'
    $fab       = Test-FabInspector
    $bridge    = Test-DesktopBridge
    $claude    = Test-Agent 'claude'  'Claude Code'
    $copilot   = Test-Agent 'copilot' 'GitHub Copilot CLI'
    $agents    = Test-AgentsAggregate $claude $copilot

    return @($windows, $node, $git, $desktop, $bridgeCli, $reportCli, $fab, $bridge, $claude, $copilot, $agents)
}

# Overall status mirrors EnvironmentService.overallStatus:
#   error   if any HARD check is error
#   warning if any check is warning or error
#   ok      otherwise
function Get-OverallStatus {
    param($Checks)
    foreach ($c in $Checks) {
        if ($c.Hard -and $c.Status -eq 'error') { return 'error' }
    }
    foreach ($c in $Checks) {
        if ($c.Status -eq 'warning' -or $c.Status -eq 'error') { return 'warning' }
    }
    return 'ok'
}

# Map internal status -> display label + colour.
function Get-StatusDisplay {
    param([string] $Status)
    switch ($Status) {
        'ok'      { return [pscustomobject]@{ Text = 'OK';      Color = 'Green'  } }
        'warning' { return [pscustomobject]@{ Text = 'WARNING'; Color = 'Yellow' } }
        default   { return [pscustomobject]@{ Text = 'MISSING'; Color = 'Red'    } }
    }
}

function Show-DoctorReport {
    param($Checks, [string] $Overall)

    Write-Host ''
    Write-Host 'Zero Two - Environment Doctor' -ForegroundColor Cyan
    Write-Host ("Generated: {0}" -f (Get-Date).ToString('u'))
    Write-Host ('-' * 78)

    $labelWidth = ($Checks | ForEach-Object { $_.Label.Length } | Measure-Object -Maximum).Maximum
    if ($labelWidth -lt 12) { $labelWidth = 12 }

    foreach ($c in $Checks) {
        $disp = Get-StatusDisplay $c.Status
        $reqTag = if ($c.Hard) { 'required' } else { 'optional' }
        $line = ('  {0,-9} {1,-' + $labelWidth + '}  {2,-8}  {3}') -f `
            "[$($disp.Text)]", $c.Label, $reqTag, ($(if ($c.Detected) { $c.Detected } else { '-' }))
        Write-Host $line -ForegroundColor $disp.Color
        if ($c.Status -ne 'ok' -and $c.Remediation) {
            Write-Host ('            -> {0}' -f $c.Remediation) -ForegroundColor DarkGray
        }
    }

    Write-Host ('-' * 78)
    $overallDisp = Get-StatusDisplay $Overall
    switch ($Overall) {
        'ok'      { $verdict = 'PASS'; $msg = 'All hard requirements satisfied.' }
        'warning' { $verdict = 'PASS (with warnings)'; $msg = 'Hard requirements satisfied; warnings above are non-blocking.' }
        default   { $verdict = 'FAIL'; $msg = 'One or more hard requirements are missing (see [MISSING] rows).' }
    }
    Write-Host ("Overall: {0} - {1}" -f $verdict, $msg) -ForegroundColor $overallDisp.Color
    Write-Host ''
}

# --- Entry point ------------------------------------------------------------

$checks = Get-DoctorChecks
$overall = Get-OverallStatus $checks
Show-DoctorReport -Checks $checks -Overall $overall

if ($overall -eq 'error') { exit 1 } else { exit 0 }
