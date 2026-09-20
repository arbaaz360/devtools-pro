<#
.SYNOPSIS
  Starts an Antigravity agent on each ready packet, one at a time, without a human kickoff.

.DESCRIPTION
  Run this from Antigravity's integrated terminal, in the repository checkout. That terminal
  already carries ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN, which the `agentapi`
  command needs to reach the running language server; nothing is copied or stored.

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
  [switch]$Once
)

$ErrorActionPreference = 'Stop'
$repo = 'arbaaz360/devtools-pro'
$root = Split-Path -Parent $PSScriptRoot
$promptPath = Join-Path $root 'docs/antigravity/WORKER_PROMPT.md'
$statePath = Join-Path $root '.antigravity-worker-state.json'   # ignored by git; see .gitignore
$agentapi = Join-Path $env:USERPROFILE '.gemini/antigravity-ide/bin/agentapi.bat'

if (-not $env:ANTIGRAVITY_LS_ADDRESS -or -not $env:ANTIGRAVITY_CSRF_TOKEN) {
  Write-Error 'ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN are not set. Start this script from the terminal inside Antigravity, with the repository open as the workspace.'
}
if (-not (Test-Path $agentapi)) { Write-Error "agentapi not found at $agentapi" }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Write-Error 'gh is not on PATH' }

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
  $prompt = (Get-Content $promptPath -Raw).Replace('{{ISSUE}}', "$($issue.number)").Replace('{{TITLE}}', $issue.title).Replace('{{PACKET}}', $issue.packet)
  $title = "[worker] $($issue.title)"
  Write-Host ("{0}  starting Antigravity ({1}) on issue #{2}: {3}" -f (Get-Date -Format 'HH:mm'), $Model, $issue.number, $issue.title)
  $out = & $agentapi new-conversation "--model=$Model" "--title=$title" $prompt 2>&1 | Out-String
  $conversation = ([regex]::Match($out, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')).Value
  if (-not $conversation) { Write-Warning "agentapi did not return a conversation id: $out"; return $null }
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
