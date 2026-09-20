<#
.SYNOPSIS
  Starts an Antigravity agent on each ready packet, one at a time, without a human kickoff.

.DESCRIPTION
  Run this in any terminal while Antigravity is open with this repository (or a parent
  folder) as its workspace. The `agentapi` command needs the address and CSRF token of
  Antigravity's running language server; if ANTIGRAVITY_LS_ADDRESS and
  ANTIGRAVITY_CSRF_TOKEN are not already set, the script reads them from that server's
  own process on this machine and keeps them in this process only. Nothing is written
  to disk or sent anywhere.

  Every interval the loop asks GitHub (with `gh`, no model tokens) for open issues labelled
  packet + ready + antigravity. If one exists and no packet is in flight, it starts a new
  Antigravity conversation on the lowest-numbered issue with docs/antigravity/WORKER_PROMPT.md.
  A packet is in flight until a pull request whose body carries its `Packet:` line exists, or
  its issue is no longer open, or the wait limit passes. The reviewer routine takes over from
  the pull request onward.

.PARAMETER IntervalMinutes
  Minutes between GitHub polls. Default 5.
.PARAMETER MaxWaitMinutes
  How long one packet may stay in flight before the loop moves on. Default 120.
.PARAMETER Model
  Antigravity model id: pro, flash or flash_lite. Default pro.
.PARAMETER Once
  Dispatch at most one packet, then exit.

.EXAMPLE
  pwsh -File scripts/antigravity-worker-loop.ps1
#>
param(
  [int]$IntervalMinutes = 5,
  [int]$MaxWaitMinutes = 120,
  [ValidateSet('pro', 'flash', 'flash_lite')][string]$Model = 'pro',
  [string]$ProjectId = $env:ANTIGRAVITY_PROJECT_ID,
  [switch]$Once
)

$ErrorActionPreference = 'Stop'
$repo = 'arbaaz360/devtools-pro'
$root = Split-Path -Parent $PSScriptRoot
$promptPath = Join-Path $root 'docs/antigravity/WORKER_PROMPT.md'
$statePath = Join-Path $root '.antigravity-worker-state.json'   # ignored by git; see .gitignore
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Write-Error 'gh is not on PATH' }

# The agentapi wrapper is a .bat that forwards to the language server binary. Call the
# binary directly so a long prompt with && and quotes is passed through untouched.
$wrapper = Join-Path $env:USERPROFILE '.gemini/antigravity-ide/bin/agentapi.bat'
if (-not (Test-Path $wrapper)) { Write-Error "agentapi wrapper not found at $wrapper; is Antigravity installed?" }
$serverExe = ([regex]::Match((Get-Content $wrapper -Raw), '"([^"]+language_server[^"]*\.exe)"')).Groups[1].Value
if (-not $serverExe -or -not (Test-Path $serverExe)) { Write-Error "could not resolve the language server binary from $wrapper" }

function Invoke-AgentApi { & $serverExe agentapi @args 2>&1 | Out-String }

function Connect-LanguageServer {
  if ($env:ANTIGRAVITY_LS_ADDRESS -and $env:ANTIGRAVITY_CSRF_TOKEN) { return }
  $repoTokens = ($root -split '[^A-Za-z0-9]+' | Where-Object { $_ }) | ForEach-Object { $_.ToLowerInvariant() }
  $servers = Get-CimInstance Win32_Process -Filter "Name = 'language_server_windows_x64.exe'" |
    Where-Object { $_.CommandLine -match '--csrf_token' }
  if (-not $servers) { Write-Error 'No Antigravity language server is running. Open Antigravity with the repository (or its parent folder) as the workspace first.' }
  # Antigravity runs a manager server (no --workspace_id) that owns projects and
  # conversations, plus one server per workspace that does not. Conversations must be
  # started on the manager server, so it ranks first; workspace servers follow, closest
  # path match first, as a fallback.
  $ranked = $servers | ForEach-Object {
    $id = ([regex]::Match($_.CommandLine, '--workspace_id\s+(\S+)')).Groups[1].Value.ToLowerInvariant()
    $score = if ($id) { ($repoTokens | Where-Object { $id -match "(^|_)$([regex]::Escape($_))(_|$)" }).Count } else { 1000 }
    [pscustomobject]@{ Process = $_; Score = $score }
  } | Sort-Object Score -Descending
  foreach ($candidate in $ranked) {
    $p = $candidate.Process
    $token = ([regex]::Match($p.CommandLine, '--csrf_token\s+([0-9A-Fa-f-]{36})')).Groups[1].Value
    if (-not $token) { continue }
    $ports = Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique
    foreach ($port in $ports) {
      $env:ANTIGRAVITY_LS_ADDRESS = "127.0.0.1:$port"
      $env:ANTIGRAVITY_CSRF_TOKEN = $token
      $probe = Invoke-AgentApi get-conversation-metadata probe
      if ($probe -notmatch 'connection error|Unavailable|missing CSRF|Unauthenticated|not set') {
        Write-Host "connected to Antigravity language server (pid $($p.ProcessId), port $port)"
        return
      }
    }
  }
  Remove-Item Env:ANTIGRAVITY_LS_ADDRESS, Env:ANTIGRAVITY_CSRF_TOKEN -ErrorAction SilentlyContinue
  Write-Error 'Found Antigravity language servers but none accepted agentapi calls. Last probe output above.'
}

Connect-LanguageServer
if ($ProjectId) { $env:ANTIGRAVITY_PROJECT_ID = $ProjectId }

function Read-State {
  if (Test-Path $statePath) { return Get-Content $statePath -Raw | ConvertFrom-Json }
  return [pscustomobject]@{ issue = $null; packet = $null; conversation = $null; startedAt = $null }
}
function Write-State($state) { $state | ConvertTo-Json | Set-Content $statePath -Encoding UTF8 }

function Get-ReadyIssue {
  $issues = gh issue list --repo $repo --state open --label packet --label ready --label antigravity --json number,title,body | ConvertFrom-Json
  if (-not $issues) { return $null }
  $issue = $issues | Sort-Object number | Select-Object -First 1
  $packet = ([regex]::Match($issue.body, '(?m)^\s*Packet:\s*(docs/packets/[A-Za-z0-9._-]+\.md)')).Groups[1].Value
  if (-not $packet) { Write-Warning "issue #$($issue.number) has no Packet line; skipping"; return $null }
  return [pscustomobject]@{ number = $issue.number; title = $issue.title; packet = $packet }
}

function Test-InFlight($state) {
  if (-not $state.issue) { return $false }
  $started = [datetime]$state.startedAt
  if ((Get-Date) - $started -gt [timespan]::FromMinutes($MaxWaitMinutes)) {
    Write-Host "packet #$($state.issue) exceeded $MaxWaitMinutes minutes; releasing"
    return $false
  }
  $open = gh issue view $state.issue --repo $repo --json state --jq .state
  if ($open -ne 'OPEN') { return $false }
  $prs = gh pr list --repo $repo --state all --search "`"Packet: $($state.packet)`" in:body" --json number | ConvertFrom-Json
  if ($prs -and $prs.Count -gt 0) {
    Write-Host "packet #$($state.issue) has PR #$($prs[0].number); handing over to the reviewer"
    return $false
  }
  return $true
}

function Start-Packet($issue) {
  $prompt = (Get-Content $promptPath -Raw).Replace('{{ISSUE}}', "$($issue.number)").Replace('{{TITLE}}', $issue.title).Replace('{{PACKET}}', $issue.packet).Replace('{{ROOT}}', $root)
  $title = "[worker] $($issue.title)"
  Write-Host ("{0}  starting Antigravity ({1}) on issue #{2}: {3}" -f (Get-Date -Format 'HH:mm'), $Model, $issue.number, $issue.title)
  $out = Invoke-AgentApi new-conversation "--model=$Model" "--title=$title" $prompt
  $conversation = ([regex]::Match($out, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')).Value
  if (-not $conversation) {
    Write-Warning "agentapi did not return a conversation id: $out"
    if ($out -match 'project_id is required') { Write-Host '  Pass the Antigravity project id with -ProjectId (or set ANTIGRAVITY_PROJECT_ID).' }
    if ($out -match 'projectsStore is nil') { Write-Host '  This server has no projects store; the manager server (the one without --workspace_id) must be running.' }
    return $null
  }
  Write-Host "  conversation $conversation"
  return $conversation
}

Write-Host "Antigravity worker loop: polling $repo every $IntervalMinutes min; model $Model; Ctrl+C to stop."
while ($true) {
  $state = Read-State
  if (Test-InFlight $state) {
    Write-Host ("{0}  packet #{1} in flight" -f (Get-Date -Format 'HH:mm'), $state.issue)
  } else {
    $issue = Get-ReadyIssue
    if ($issue) {
      $conversation = Start-Packet $issue
      if ($conversation) {
        Write-State ([pscustomobject]@{ issue = $issue.number; packet = $issue.packet; conversation = $conversation; startedAt = (Get-Date).ToString('o') })
        if ($Once) { break }
      }
    } else {
      if ($state.issue) { Write-State ([pscustomobject]@{ issue = $null; packet = $null; conversation = $null; startedAt = $null }) }
      Write-Host ("{0}  no ready packets" -f (Get-Date -Format 'HH:mm'))
    }
  }
  Start-Sleep -Seconds ($IntervalMinutes * 60)
}
