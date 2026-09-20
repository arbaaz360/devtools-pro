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

  Before starting a new packet, the loop looks for any open antigravity/* pull request
  whose latest verdict is CHANGES_REQUESTED and has not been forwarded yet, and tracks
  that packet again first. A review that lands after a release, a timeout or a loop
  restart is therefore still relayed. Forwarded comment ids persist in the state file.

  Agents stop early: they push a branch and forget the pull request, or pause to ask for
  confirmation nobody will give. While a packet has no pull request, the loop nudges the
  conversation, at most once every 30 minutes: when the packet's branch is on origin and
  its last commit is older than 10 minutes, it asks for the PR; when no branch exists
  45 minutes after dispatch, it asks the agent to continue or post BLOCKED or QUESTION.

  When -Root points at another checkout, the loop's own checkout is pulled every tick
  and the loop restarts itself when this script changes, so merged fixes take effect
  without anyone restarting it.

.PARAMETER IntervalMinutes
  Minutes between GitHub polls. Default 5.
.PARAMETER MaxWaitMinutes
  How long one packet may stay in flight, including review rounds, before the loop
  moves on. Default 240.
.PARAMETER Root
  The repository checkout the agent works in. Default: the checkout this script lives in.
  Point it elsewhere when the loop runs from a separate checkout that stays on main.
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
  [string]$Root,
  [switch]$Once
)

$ErrorActionPreference = 'Stop'
$repo = 'arbaaz360/devtools-pro'
$root = if ($Root) { (Resolve-Path $Root).Path } else { Split-Path -Parent $PSScriptRoot }
$self = Split-Path -Parent $PSScriptRoot
$selfUpdates = $Root -and ((Resolve-Path $self).Path -ne $root)
$selfHash = (Get-FileHash $PSCommandPath).Hash
$scriptArgs = $PSBoundParameters
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

# A state file written by an older loop may lack newer fields; a PSCustomObject from
# ConvertFrom-Json refuses to set a field it does not have, so every field is ensured here.
function Read-State {
  $state = if (Test-Path $statePath) { Get-Content $statePath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
  $defaults = [ordered]@{ issue = $null; packet = $null; conversation = $null; startedAt = $null; forwarded = @(); nudgedAt = $null }
  foreach ($name in $defaults.Keys) {
    if (-not ($state.PSObject.Properties.Name -contains $name)) { $state | Add-Member -NotePropertyName $name -NotePropertyValue $defaults[$name] }
  }
  if ($null -eq $state.forwarded) { $state.forwarded = @() }
  return $state
}
function Set-Tracked($state, $issue, $packet) {
  $startedAt = if ($issue) { (Get-Date).ToString('o') } else { $null }
  $conversation = if ($issue) { $ConversationId } else { $null }
  Write-State ([pscustomobject]@{ issue = $issue; packet = $packet; conversation = $conversation; startedAt = $startedAt; forwarded = @($state.forwarded); nudgedAt = $null })
}

# Pull the loop's own checkout and restart when this script changed. Only when the loop
# runs from a checkout other than the agent's, which must never be pulled under it.
function Update-Self {
  if (-not $selfUpdates) { return }
  $null = git -C $self pull -q --ff-only 2>&1
  if ((Get-FileHash $PSCommandPath).Hash -eq $selfHash) { return }
  Write-Host ('{0}  script updated on main; restarting' -f (Get-Date -Format 'HH:mm'))
  $restartArgs = @()
  foreach ($k in $scriptArgs.Keys) {
    $v = $scriptArgs[$k]
    if ($v -is [switch]) { if ($v) { $restartArgs += "-$k" } } else { $restartArgs += "-$k"; $restartArgs += "$v" }
  }
  & pwsh -NoProfile -File $PSCommandPath @restartArgs
  exit $LASTEXITCODE
}
$packetLine = '(?m)^\s*Packet:\s*(docs/packets/[A-Za-z0-9._-]+\.md)'
$verdictLine = '^\s*\[[A-Z]+-\d+\]\[(CHANGES_REQUESTED|CI_BLOCKED|READY_TO_MERGE|READY_FOR_NATIVE_REVIEW)\]'

function Get-LatestVerdict($prNumber) {
  $comments = gh api "repos/$repo/issues/$prNumber/comments?per_page=100" | ConvertFrom-Json
  $verdicts = @($comments | Where-Object { $_.body -match $verdictLine })
  if ($verdicts.Count -eq 0) { return $null }
  return $verdicts[-1]
}
function Write-State($state) { $state | ConvertTo-Json | Set-Content $statePath -Encoding UTF8 }

function Get-ReadyIssue {
  $issues = gh issue list --repo $repo --state open --label packet --label ready --label antigravity --json number,title,body | ConvertFrom-Json
  if (-not $issues) { return $null }
  $issue = $issues | Sort-Object number | Select-Object -First 1
  $packet = ([regex]::Match($issue.body, $packetLine)).Groups[1].Value
  if (-not $packet) { Write-Warning "issue #$($issue.number) has no Packet line; skipping"; return $null }
  return [pscustomobject]@{ number = $issue.number; title = $issue.title; packet = $packet }
}

# An open antigravity/* pull request whose latest verdict is CHANGES_REQUESTED and not yet
# forwarded. Its packet is tracked again so the verdict reaches the agent.
function Get-PendingReview($state) {
  $prs = gh pr list --repo $repo --state open --json number,body,headRefName | ConvertFrom-Json
  foreach ($pr in ($prs | Where-Object { $_.headRefName -like 'antigravity/*' } | Sort-Object number)) {
    $packet = ([regex]::Match($pr.body, $packetLine)).Groups[1].Value
    if (-not $packet) { continue }
    $latest = Get-LatestVerdict $pr.number
    if (-not $latest -or $latest.body -notmatch '\]\[CHANGES_REQUESTED\]' -or ($state.forwarded -contains $latest.id)) { continue }
    $issues = gh issue list --repo $repo --state open --label packet --json number,body | ConvertFrom-Json
    $issue = $issues | Where-Object { $_.body -match [regex]::Escape($packet) } | Sort-Object number | Select-Object -First 1
    if (-not $issue) { continue }
    return [pscustomobject]@{ number = $issue.number; packet = $packet; pr = $pr.number }
  }
  return $null
}

# The branch a packet prescribes, from its "## Branch" section, and when origin last saw it.
function Get-PacketBranch($packet) {
  $path = Join-Path $root $packet
  if (-not (Test-Path $path)) { return $null }
  $m = [regex]::Match((Get-Content $path -Raw), '(?s)## Branch.*?`(antigravity/[^`]+)`')
  if ($m.Success) { return $m.Groups[1].Value }
  return $null
}
function Get-BranchCommitDate($branch) {
  $out = gh api "repos/$repo/branches/$branch" --jq '.commit.commit.committer.date' 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0 -or $out -notmatch '\d{4}-\d{2}-\d{2}T') { return $null }
  return [datetime]::Parse($out.Trim()).ToUniversalTime()
}

# No pull request yet: remind a stopped agent, at most once every 30 minutes.
function Send-Nudge($state) {
  if ($state.nudgedAt -and ((Get-Date) - [datetime]$state.nudgedAt) -lt [timespan]::FromMinutes(30)) { return }
  $id = ([regex]::Match($state.packet, 'packets/([A-Z]+-\d+)')).Groups[1].Value
  $branch = Get-PacketBranch $state.packet
  $pushed = if ($branch) { Get-BranchCommitDate $branch } else { $null }
  $text = $null
  if ($pushed) {
    if (((Get-Date).ToUniversalTime() - $pushed) -gt [timespan]::FromMinutes(10)) {
      $text = "Packet #$($state.issue) ([$id]): branch $branch is pushed to origin but no pull request exists. Finish Step 5 now: open the PR against main with the line Packet: $($state.packet) first in the body and the [$id][STATUS] block, then report the PR number. If something blocks you, post [$id][BLOCKED] on issue #$($state.issue) instead."
    }
  } elseif (((Get-Date) - [datetime]$state.startedAt) -gt [timespan]::FromMinutes(45)) {
    $text = "Packet #$($state.issue) ([$id]): no branch has been pushed and no [BLOCKED] or [QUESTION] posted 45 minutes after dispatch. Continue the packet through Step 6 without waiting for confirmation. If you are stuck, post [$id][BLOCKED] or [$id][QUESTION] on issue #$($state.issue)."
  }
  if (-not $text) { return }
  Write-Host ('{0}  nudging Antigravity about packet #{1}' -f (Get-Date -Format 'HH:mm'), $state.issue)
  $out = Invoke-AgentApi send-message "--title=[nudge] packet #$($state.issue)" $ConversationId $text
  if ($out -match '"error"\s*:\s*"[^"]') { Write-Warning "nudge failed: $out"; return }
  $state | Add-Member -NotePropertyName nudgedAt -NotePropertyValue (Get-Date).ToString('o') -Force
  Write-State $state
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
  if (-not $prs -or $prs.Count -eq 0) { Send-Nudge $state; return $true }   # still working, no PR yet
  $pr = $prs[0]
  if ($pr.state -ne 'OPEN') {
    Write-Host "packet #$($state.issue): PR #$($pr.number) is $($pr.state); releasing"
    return $false
  }
  # Under review. Forward each CHANGES_REQUESTED verdict once; release on acceptance.
  $latest = Get-LatestVerdict $pr.number
  if (-not $latest) { return $true }
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
# One tick. A failure inside a tick is reported and the loop carries on; only Ctrl+C
# or a failed self-restart ends it.
function Invoke-Tick {
  $state = Read-State
  if (Test-InFlight $state) {
    Write-Host ("{0}  packet #{1} in flight" -f (Get-Date -Format 'HH:mm'), $state.issue)
  } else {
    $pending = Get-PendingReview $state
    if ($pending) {
      Write-Host ("{0}  PR #{1} has an unforwarded review; tracking packet #{2} again" -f (Get-Date -Format 'HH:mm'), $pending.pr, $pending.number)
      Set-Tracked $state $pending.number $pending.packet
      [void](Test-InFlight (Read-State))
    } else {
      $issue = Get-ReadyIssue
      if ($issue) {
        $conversation = Start-Packet $issue
        if ($conversation) {
          Set-Tracked $state $issue.number $issue.packet
          if ($Once) { return $false }
        }
      } else {
        if ($state.issue) { Set-Tracked $state $null $null }
        Write-Host ("{0}  no ready packets" -f (Get-Date -Format 'HH:mm'))
      }
    }
  }
  return $true
}

while ($true) {
  Update-Self
  try {
    if (-not (Invoke-Tick)) { break }
  } catch {
    Write-Warning ("{0}  tick failed, will retry: {1}" -f (Get-Date -Format 'HH:mm'), $_.Exception.Message)
  }
  Start-Sleep -Seconds ($IntervalMinutes * 60)
}
