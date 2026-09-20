<#
.SYNOPSIS
  Sends each ready packet, one at a time, to a running Antigravity conversation.

.DESCRIPTION
  Run this in any terminal while Antigravity is open with this repository (or a parent
  folder) as its workspace. The `agentapi` command needs the address and CSRF token of
  Antigravity's running language server; if ANTIGRAVITY_LS_ADDRESS and
  ANTIGRAVITY_CSRF_TOKEN are not already set, the script reads them from that server's
  own process on this machine and keeps them in this process only. Nothing is written
  to disk or sent anywhere.

  Antigravity only lets its own agents create conversations, so the loop posts into one
  you create by hand: open a conversation in Antigravity, tell it to wait for packets,
  and leave it open. By default the loop targets the most recently used conversation;
  pass -ConversationId to pin one.

  Every interval the loop asks GitHub (with `gh`, no model tokens) for open issues labelled
  packet + ready + antigravity. If one exists and no packet is in flight, it sends the
  lowest-numbered one to that conversation as docs/antigravity/WORKER_PROMPT.md.
  A packet stays in flight while the agent works and while its pull request is under
  review: each `[ID][CHANGES_REQUESTED]` verdict the reviewer posts on that pull request
  is forwarded into the conversation once, so the agent fixes and re-posts its status.
  The packet is released when the reviewer posts READY_TO_MERGE or
  READY_FOR_NATIVE_REVIEW, when the pull request is merged or closed, when the issue
  closes, or when the wait limit passes.

.PARAMETER IntervalMinutes
  Minutes between GitHub polls. Default 5.
.PARAMETER MaxWaitMinutes
  How long one packet may stay in flight, including review rounds, before the loop
  moves on. Default 240.
.PARAMETER ConversationId
  The Antigravity conversation to send packets to. Default: the most recently used one.
.PARAMETER Once
  Dispatch at most one packet, then exit.

.EXAMPLE
  pwsh -File scripts/antigravity-worker-loop.ps1
#>
param(
  [int]$IntervalMinutes = 5,
  [int]$MaxWaitMinutes = 240,
  [string]$ConversationId,
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

# Conversations are stored one file per cascade id; the newest is the one the owner just
# opened as the dispatcher. Only file names are read.
if (-not $ConversationId) {
  $store = Join-Path $env:USERPROFILE '.gemini/antigravity-ide/conversations'
  $newest = Get-ChildItem (Join-Path $store '*.db') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $newest) { Write-Error "No Antigravity conversations found under $store. Open one in Antigravity first." }
  $ConversationId = $newest.BaseName
}
Write-Host "dispatching to conversation $ConversationId"

function Read-State {
  if (Test-Path $statePath) { return Get-Content $statePath -Raw | ConvertFrom-Json }
  return [pscustomobject]@{ issue = $null; packet = $null; conversation = $null; startedAt = $null; forwarded = @() }
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
  $prs = gh pr list --repo $repo --state all --search "`"Packet: $($state.packet)`" in:body" --json number,state | ConvertFrom-Json
  if (-not $prs -or $prs.Count -eq 0) { return $true }   # still working, no PR yet
  $pr = $prs[0]
  if ($pr.state -ne 'OPEN') {
    Write-Host "packet #$($state.issue): PR #$($pr.number) is $($pr.state); releasing"
    return $false
  }
  # Under review. Forward each CHANGES_REQUESTED verdict once; release on acceptance.
  $comments = gh api "repos/$repo/issues/$($pr.number)/comments?per_page=100" | ConvertFrom-Json
  $verdicts = @($comments | Where-Object { $_.body -match '^\s*\[[A-Z]+-\d+\]\[(CHANGES_REQUESTED|CI_BLOCKED|READY_TO_MERGE|READY_FOR_NATIVE_REVIEW)\]' })
  if ($verdicts.Count -eq 0) { return $true }
  $latest = $verdicts[-1]
  if ($latest.body -match '\]\[(READY_TO_MERGE|READY_FOR_NATIVE_REVIEW)\]') {
    Write-Host "packet #$($state.issue): reviewer accepted PR #$($pr.number); releasing"
    return $false
  }
  if ($latest.body -match '\]\[CHANGES_REQUESTED\]' -and ($state.forwarded -notcontains $latest.id)) {
    $text = "The integrator reviewed your pull request #$($pr.number) for issue #$($state.issue) and requested changes. Address every numbered item below on the same branch, run the packet's Checks again, push, and post a new [ID][STATUS] comment on the PR. Do not open a new PR. Review comment:`n`n$($latest.body)"
    Write-Host ("{0}  forwarding CHANGES_REQUESTED on PR #{1} to Antigravity" -f (Get-Date -Format 'HH:mm'), $pr.number)
    $out = Invoke-AgentApi send-message "--title=[review] PR #$($pr.number)" $ConversationId $text
    if ($out -match '"error"\s*:\s*"[^"]') { Write-Warning "forwarding failed: $out" }
    else { $state.forwarded = @($state.forwarded) + $latest.id; Write-State $state }
  }
  return $true
}

function Start-Packet($issue) {
  $prompt = (Get-Content $promptPath -Raw).Replace('{{ISSUE}}', "$($issue.number)").Replace('{{TITLE}}', $issue.title).Replace('{{PACKET}}', $issue.packet).Replace('{{ROOT}}', $root)
  $title = "[packet] $($issue.title)"
  Write-Host ("{0}  sending issue #{1} to Antigravity: {2}" -f (Get-Date -Format 'HH:mm'), $issue.number, $issue.title)
  $out = Invoke-AgentApi send-message "--title=$title" $ConversationId $prompt
  if ($out -match '"error"\s*:\s*"[^"]') {
    Write-Warning "agentapi send-message failed: $out"
    return $null
  }
  Write-Host "  sent to conversation $ConversationId"
  return $ConversationId
}

Write-Host "Antigravity worker loop: polling $repo every $IntervalMinutes min; Ctrl+C to stop."
while ($true) {
  $state = Read-State
  if (Test-InFlight $state) {
    Write-Host ("{0}  packet #{1} in flight" -f (Get-Date -Format 'HH:mm'), $state.issue)
  } else {
    $issue = Get-ReadyIssue
    if ($issue) {
      $conversation = Start-Packet $issue
      if ($conversation) {
        Write-State ([pscustomobject]@{ issue = $issue.number; packet = $issue.packet; conversation = $conversation; startedAt = (Get-Date).ToString('o'); forwarded = @() })
        if ($Once) { break }
      }
    } else {
      if ($state.issue) { Write-State ([pscustomobject]@{ issue = $null; packet = $null; conversation = $null; startedAt = $null; forwarded = @() }) }
      Write-Host ("{0}  no ready packets" -f (Get-Date -Format 'HH:mm'))
    }
  }
  Start-Sleep -Seconds ($IntervalMinutes * 60)
}
