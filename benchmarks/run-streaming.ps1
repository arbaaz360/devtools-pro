#requires -Version 7.0
<# Streaming benchmark harness for the release devtools-cli executable.

Each sample launches a fresh process, captures stdout/stderr without a shell
pipeline, polls the child's working set, and checks the CLI's JSON summary
against the current core output contract (devtools_core::Inspection). The raw
per-run data is written as JSON and a Markdown summary to benchmarks/results/
(ignored by git). See benchmarks/README.md for the method and its caveats.
#>
param(
  [ValidateRange(1, 100)][int]$Runs = 5,
  [ValidateRange(0, 5)][int]$Warmups = 1,
  [ValidateRange(1, 100)][int]$SampleIntervalMs = 5,
  [ValidateRange(1, 3600)][int]$TimeoutSeconds = 120,
  [ValidateRange(1, 10000)][int]$CancelAfterMs = 50,
  [string]$Executable = (Join-Path $PSScriptRoot '../target/release/devtools-cli.exe'),
  [string]$FixtureDirectory = (Join-Path $PSScriptRoot 'fixtures'),
  [string]$ResultsDirectory = (Join-Path $PSScriptRoot 'results'),
  [switch]$IncludeTransform
)
$ErrorActionPreference = 'Stop'
$Executable = (Resolve-Path -LiteralPath $Executable).Path
$FixtureDirectory = (Resolve-Path -LiteralPath $FixtureDirectory).Path
$null = New-Item -ItemType Directory -Path $ResultsDirectory -Force
$ResultsDirectory = (Resolve-Path -LiteralPath $ResultsDirectory).Path

# The CLI output contract this harness is reconciled with (crates/devtools-cli/src/main.rs
# and devtools_core::Inspection). A drift here fails the run instead of producing a report.
$Contract = [ordered]@{
  summary_keys = @('input_bytes', 'output_bytes', 'elapsed_ms', 'valid', 'summary')
  error_key = 'code'
  exit_codes = [ordered]@{ success = 0; error = 1; usage = 2; cancelled = 130 }
}

function Get-Preview([string]$Text) { if ($Text.Length -gt 1000) { $Text.Substring(0, 1000) + '…' } else { $Text } }

function Invoke-MeasuredProcess([string[]]$Arguments, [int]$ExpectedExitCode = 0) {
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Executable
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $start
  $started = $false
  $peakWorking = [long]0
  $peakPrivateSampled = [long]0
  $samples = 0
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    if (-not $process.Start()) { throw 'Process failed to start.' }
    $started = $true
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    while (-not $process.HasExited) {
      try {
        $process.Refresh()
        $peakWorking = [Math]::Max($peakWorking, $process.PeakWorkingSet64)
        $peakPrivateSampled = [Math]::Max($peakPrivateSampled, $process.PrivateMemorySize64)
        $samples++
      } catch [System.InvalidOperationException] { # A short-lived child can exit between the two calls.
      }
      if ($watch.Elapsed.TotalSeconds -gt $TimeoutSeconds) {
        $process.Kill($true)
        $process.WaitForExit()
        throw "Benchmark process exceeded $TimeoutSeconds seconds. Arguments: $($Arguments -join ' ')"
      }
      $null = $process.WaitForExit($SampleIntervalMs)
    }
    $watch.Stop()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
    if ($exitCode -ne $ExpectedExitCode) {
      throw "Unexpected exit $exitCode (expected $ExpectedExitCode). stderr: $(Get-Preview $stderr) stdout: $(Get-Preview $stdout)"
    }
    $summary = $null; $errorCode = $null; $cliElapsed = $null
    if ($exitCode -eq $Contract.exit_codes.success) {
      try { $summary = $stdout | ConvertFrom-Json -AsHashtable } catch { throw "CLI stdout was not a JSON summary: $(Get-Preview $stdout)" }
      $keys = @($summary.Keys | Sort-Object)
      $expected = @($Contract.summary_keys | Sort-Object)
      if (($keys -join ',') -ne ($expected -join ',')) { throw "CLI summary keys [$($keys -join ', ')] do not match the contract [$($expected -join ', ')]. stdout: $(Get-Preview $stdout)" }
      if ($summary['valid'] -ne $true) { throw "CLI reported valid=false on exit 0 (contract mismatch). stdout: $(Get-Preview $stdout)" }
      $cliElapsed = [long]$summary['elapsed_ms']
    } elseif ($exitCode -ne $Contract.exit_codes.usage) {
      try { $failure = $stderr.Trim() | ConvertFrom-Json -AsHashtable } catch { throw "CLI stderr was not a JSON error: $(Get-Preview $stderr)" }
      if (-not $failure.ContainsKey($Contract.error_key)) { throw "CLI error lacks the '$($Contract.error_key)' field (contract mismatch). stderr: $(Get-Preview $stderr)" }
      $errorCode = [string]$failure[$Contract.error_key]
    }
    return [ordered]@{
      elapsed_ms = [Math]::Round($watch.Elapsed.TotalMilliseconds, 3)
      cli_elapsed_ms = $cliElapsed
      peak_working_set_bytes = $peakWorking
      peak_private_bytes_sampled = $peakPrivateSampled
      memory_samples = $samples; exit_code = $exitCode; error_code = $errorCode; summary = $summary; stderr = $stderr.Trim()
    }
  } finally {
    if ($started -and -not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
    $process.Dispose()
  }
}

function Get-Median([double[]]$Values) {
  $sorted = @($Values | Sort-Object)
  $middle = [int][Math]::Floor($sorted.Count / 2)
  if ($sorted.Count % 2 -eq 0) { return ($sorted[$middle - 1] + $sorted[$middle]) / 2 }
  return $sorted[$middle]
}

function Get-FixtureHash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

# Preflight: prove the executable still speaks the contract before spending minutes on samples.
function Test-CliContract {
  $small = Join-Path $FixtureDirectory 'lexemes.json'
  $invalid = Join-Path $FixtureDirectory 'invalid-utf8.json'
  foreach ($required in @($small, $invalid)) { if (-not (Test-Path -LiteralPath $required)) { throw "Contract preflight fixture is missing: $required (run generate-corpus.ps1)." } }
  $usage = Invoke-MeasuredProcess @() $Contract.exit_codes.usage
  if ($usage.stderr -notmatch '^usage:') { throw "CLI without arguments did not print usage on exit $($Contract.exit_codes.usage): $(Get-Preview $usage.stderr)" }
  $ok = Invoke-MeasuredProcess @('--file', $small, '--inspect', '--format', 'json') $Contract.exit_codes.success
  if ($null -ne $ok.summary['output_bytes']) { throw 'Inspect reported output_bytes; the contract expects null for inspections.' }
  if ([long]$ok.summary['input_bytes'] -ne (Get-Item -LiteralPath $small).Length) { throw 'Inspect reported an incorrect input size for the preflight fixture.' }
  $bad = Invoke-MeasuredProcess @('--file', $invalid, '--inspect', '--format', 'json') $Contract.exit_codes.error
  if ($bad.error_code -ne 'invalid_utf8') { throw "Invalid UTF-8 preflight returned error code '$($bad.error_code)' instead of 'invalid_utf8'." }
  return [ordered]@{
    usage_exit = $usage.exit_code; usage_stderr = $usage.stderr
    inspect_summary = $ok.summary; invalid_utf8_error_code = $bad.error_code
  }
}

$manifestPath = Join-Path $FixtureDirectory 'manifest.json'
$manifest = if (Test-Path -LiteralPath $manifestPath) { Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -AsHashtable } else { $null }
function Get-ManifestHash([string]$Name) {
  if ($null -eq $manifest) { return $null }
  $entry = @($manifest['fixtures'] | Where-Object { $_['file'] -eq $Name }) | Select-Object -First 1
  if ($null -eq $entry) { return $null }
  return [string]$entry['sha256']
}

$cases = [System.Collections.Generic.List[object]]::new()
foreach ($name in @('fixture-50mb.json', 'fixture-250mb.json')) {
  if (Test-Path -LiteralPath (Join-Path $FixtureDirectory $name)) {
    $cases.Add(@{ name = "$name inspect"; file = $name; format = 'json'; operation = 'inspect'; expected_exit = $Contract.exit_codes.success })
  }
}
foreach ($file in @(Get-ChildItem -LiteralPath $FixtureDirectory -Filter 'representative-*mib.csv' | Sort-Object Name)) {
  $cases.Add(@{ name = "$($file.Name) inspect"; file = $file.Name; format = 'csv'; operation = 'inspect'; expected_exit = $Contract.exit_codes.success })
  # The same bytes through the text scanner: the only path that decodes every character.
  $cases.Add(@{ name = "$($file.Name) text inspect"; file = $file.Name; format = 'text'; operation = 'inspect'; expected_exit = $Contract.exit_codes.success })
}
if ($cases.Count -eq 0) { throw 'No benchmark fixtures found; run generate-corpus.ps1 first.' }
if (Test-Path -LiteralPath (Join-Path $FixtureDirectory 'fixture-250mb.json')) {
  $cases.Add(@{ name = "fixture-250mb.json inspect cancel at $CancelAfterMs ms"; file = 'fixture-250mb.json'; format = 'json'; operation = 'cancel-inspect'; expected_exit = $Contract.exit_codes.cancelled })
}
$scratchName = "transform-{0}.json" -f [Guid]::NewGuid().ToString('N')
$scratchOutput = Join-Path $ResultsDirectory $scratchName
if ($IncludeTransform) {
  foreach ($name in @('fixture-50mb.json', 'fixture-250mb.json')) {
    if (Test-Path -LiteralPath (Join-Path $FixtureDirectory $name)) {
      $cases.Add(@{ name = "$name minify to file"; file = $name; format = 'json'; operation = 'minify'; expected_exit = $Contract.exit_codes.success })
    }
  }
  if (Test-Path -LiteralPath (Join-Path $FixtureDirectory 'fixture-50mb.json')) {
    # Timer derived at run time from the measured validation pass so the cancel lands while a .partial- temporary is live.
    $cases.Add(@{ name = 'fixture-50mb.json minify cancel during formatting'; file = 'fixture-50mb.json'; format = 'json'; operation = 'cancel-minify'; expected_exit = $Contract.exit_codes.cancelled })
  }
}

function Remove-ScratchOutput {
  if (Test-Path -LiteralPath $scratchOutput) { Remove-Item -LiteralPath $scratchOutput -Force }
}
function Assert-NoPartialOutput([string]$CaseName) {
  # transform_json_file writes .<name>.partial-<pid>-<n> next to the output and must remove it on cancellation.
  $partials = @(Get-ChildItem -LiteralPath $ResultsDirectory -Force -Filter ".$scratchName.partial-*")
  if ($partials.Count -gt 0) { throw "$CaseName leaked temporary output: $($partials.Name -join ', ')" }
  if (Test-Path -LiteralPath $scratchOutput) { throw "$CaseName published an output file after cancellation." }
}

$machine = [ordered]@{ os = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription; logical_processors = [Environment]::ProcessorCount }
try {
  $machine.cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name).Trim()
  $machine.physical_memory_bytes = [long](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
} catch { $machine.metadata_note = 'CIM hardware metadata unavailable.' }
$git = $null
try {
  $commit = (& git -C $PSScriptRoot rev-parse HEAD 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -eq 0 -and $commit) {
    $dirty = @(& git -C $PSScriptRoot status --porcelain --untracked-files=no 2>$null).Count -gt 0
    # Only these paths feed the measured executable; a dirty harness or docs tree does not change it.
    # The :/ prefix anchors the pathspecs at the repository root; git runs from benchmarks/.
    $coreDirty = @(& git -C $PSScriptRoot status --porcelain --untracked-files=no -- :/crates :/Cargo.toml :/Cargo.lock 2>$null).Count -gt 0
    $git = [ordered]@{ commit = $commit; dirty = $dirty; core_dirty = $coreDirty }
  }
} catch { $git = $null }

$report = [ordered]@{
  schema_version = 2; recorded_at_utc = [DateTime]::UtcNow.ToString('o')
  git = $git
  executable = $Executable; executable_sha256 = Get-FixtureHash $Executable
  rustc = (& rustc --version | Out-String).Trim(); cargo = (& cargo --version | Out-String).Trim()
  powershell = $PSVersionTable.PSVersion.ToString(); machine = $machine
  parameters = [ordered]@{ runs = $Runs; warmups = $Warmups; sample_interval_ms = $SampleIntervalMs; timeout_seconds = $TimeoutSeconds; cancel_after_ms = $CancelAfterMs; include_transform = [bool]$IncludeTransform }
  contract = $Contract
  methodology = [ordered]@{
    cache = 'Warm-cache fresh-process runs; the OS file cache is not cleared and fixtures are hashed (read) before sampling. Do not label these cold-start results.'
    elapsed = 'elapsed_ms is the parent stopwatch around process launch and observed exit, including executable startup, argument parsing, file I/O and teardown, plus up to one sampling interval and scheduler delay.'
    cli_elapsed = 'cli_elapsed_ms is the integer elapsed_ms the core reports for the operation itself (devtools_core::Inspection), excluding process startup and JSON printing. launch_overhead_ms is elapsed_ms minus cli_elapsed_ms per run.'
    memory = 'peak_working_set_bytes is the highest PeakWorkingSet64 observed while polling; it includes shared pages such as loaded DLLs and misses whatever happens after the last poll. peak_private_bytes_sampled is the largest PrivateMemorySize64 poll, not a true peak. sample_interval_ms is a lower bound on the poll cadence; memory_samples records how many polls actually happened. The parent PowerShell process is excluded. Short-lived allocations can be missed.'
    cancellation = 'Cancellation is a timer inside the CLI that sets the cooperative token after cancel_timer_ms; the core checks it between 64 KiB reads. cancel_overshoot_ms is wall time minus the timer, which includes process startup and teardown, so it bounds acknowledgement latency from above rather than measuring it; median_launch_overhead_ms of the uncancelled cases estimates the startup share. The CLI cancellation error carries no internal timing. The minify cancellation timer is the measured median validation time plus cancel_after_ms so that the cancel is expected, not guaranteed, to land in the formatting phase while a .partial- temporary exists; the harness checks that neither the output file nor a .partial- temporary survives.'
    distribution = 'Report median, minimum and maximum. Five runs do not establish a meaningful p95/p99.'
    scope = 'Core CLI only. No GUI responsiveness, WebView memory, startup first paint, typing or accessibility claim. Fixtures are synthetic and ASCII-heavy; heterogeneous real-world documents may behave differently.'
  }
  fixtures = [System.Collections.Generic.List[object]]::new()
  cases = [System.Collections.Generic.List[object]]::new()
}

try {
  $report.contract_preflight = Test-CliContract
  Write-Host 'Contract preflight passed (usage exit, inspect summary keys, invalid UTF-8 error code).'
  $seenFixtures = @{}
  foreach ($case in $cases) {
    $path = Join-Path $FixtureDirectory $case.file
    $isCancel = $case.operation -like 'cancel-*'
    $timerMs = $CancelAfterMs
    if ($case.operation -eq 'cancel-minify') {
      # transform_json_file validates with inspect_file first, then formats; land the cancel after validation.
      $validation = @($report.cases | Where-Object { $_.name -eq "$($case.file) inspect" }) | Select-Object -First 1
      if ($null -eq $validation) { throw "The '$($case.file) inspect' case must run before the minify cancellation case." }
      $timerMs = [int][Math]::Round($validation.aggregate.median_cli_elapsed_ms) + $CancelAfterMs
      $case.name = "$($case.name) (timer $timerMs ms)"
    }
    $arguments = @('--file', $path)
    switch ($case.operation) {
      'inspect' { $arguments += @('--inspect', '--format', $case.format) }
      'cancel-inspect' { $arguments += @('--inspect', '--format', $case.format, '--cancel-after-ms', "$timerMs") }
      'minify' { $arguments += @('--minify', '--output', $scratchOutput) }
      'cancel-minify' { $arguments += @('--minify', '--output', $scratchOutput, '--cancel-after-ms', "$timerMs") }
    }
    $fixtureBytes = (Get-Item -LiteralPath $path).Length
    # Hashing is outside the measured interval and also warms the OS cache deliberately.
    $hash = Get-FixtureHash $path
    $manifestHash = Get-ManifestHash $case.file
    if ($null -ne $manifestHash -and $manifestHash -ne $hash) { throw "$($case.file) does not match manifest.json ($hash vs $manifestHash); regenerate the corpus or delete the stale fixture." }
    if (-not $seenFixtures.ContainsKey($case.file)) {
      $seenFixtures[$case.file] = $true
      $report.fixtures.Add([ordered]@{ file = $case.file; bytes = $fixtureBytes; sha256 = $hash; manifest_sha256 = $manifestHash; manifest_match = if ($null -eq $manifestHash) { $null } else { $true } })
    }
    Remove-ScratchOutput
    for ($i = 0; $i -lt $Warmups; $i++) {
      $null = Invoke-MeasuredProcess $arguments $case.expected_exit
      Remove-ScratchOutput
    }
    $measurements = [System.Collections.Generic.List[object]]::new()
    for ($i = 0; $i -lt $Runs; $i++) {
      $measurement = Invoke-MeasuredProcess $arguments $case.expected_exit
      if ($isCancel) {
        if ($measurement.error_code -ne 'cancelled') { throw "$($case.name) exited $($measurement.exit_code) with error code '$($measurement.error_code)' instead of 'cancelled'." }
        $measurement.cancel_overshoot_ms = [Math]::Round($measurement.elapsed_ms - $timerMs, 3)
        if ($case.operation -eq 'cancel-minify') { Assert-NoPartialOutput $case.name }
      } else {
        if ([long]$measurement.summary['input_bytes'] -ne $fixtureBytes) { throw "CLI reported an incorrect input size for $($case.name)." }
        if ($case.operation -eq 'minify') {
          if (-not (Test-Path -LiteralPath $scratchOutput)) { throw "$($case.name) did not publish an output file." }
          $outputBytes = (Get-Item -LiteralPath $scratchOutput).Length
          if ([long]$measurement.summary['output_bytes'] -ne $outputBytes) { throw "$($case.name) reported output_bytes $($measurement.summary['output_bytes']) but wrote $outputBytes bytes." }
        } elseif ($null -ne $measurement.summary['output_bytes']) { throw "$($case.name) reported output_bytes for an inspection." }
        $measurement.launch_overhead_ms = [Math]::Round($measurement.elapsed_ms - $measurement.cli_elapsed_ms, 3)
      }
      Remove-ScratchOutput
      $measurements.Add($measurement)
    }
    $times = [double[]]@($measurements | ForEach-Object { $_.elapsed_ms })
    $medianElapsed = [Math]::Round((Get-Median $times), 3)
    $maxWorkingSet = ($measurements.peak_working_set_bytes | Measure-Object -Maximum).Maximum
    $aggregate = [ordered]@{
      median_elapsed_ms = $medianElapsed
      min_elapsed_ms = ($times | Measure-Object -Minimum).Minimum
      max_elapsed_ms = ($times | Measure-Object -Maximum).Maximum
      median_cli_elapsed_ms = if ($isCancel) { $null } else { [Math]::Round((Get-Median ([double[]]@($measurements | ForEach-Object { $_.cli_elapsed_ms }))), 3) }
      median_launch_overhead_ms = if ($isCancel) { $null } else { [Math]::Round((Get-Median ([double[]]@($measurements | ForEach-Object { $_.launch_overhead_ms }))), 3) }
      median_cancel_overshoot_ms = if ($isCancel) { [Math]::Round((Get-Median ([double[]]@($measurements | ForEach-Object { $_.cancel_overshoot_ms }))), 3) } else { $null }
      throughput_mib_per_s = if ($isCancel) { $null } else { [Math]::Round(($fixtureBytes / 1MB) / ($medianElapsed / 1000.0), 1) }
      max_working_set_bytes = $maxWorkingSet
      max_private_bytes_sampled = ($measurements.peak_private_bytes_sampled | Measure-Object -Maximum).Maximum
      working_set_to_input_ratio = if ($isCancel) { $null } else { [Math]::Round($maxWorkingSet / [double]$fixtureBytes, 3) }
    }
    $report.cases.Add([ordered]@{
      name = $case.name; fixture = $case.file; operation = $case.operation; format = $case.format; expected_exit = $case.expected_exit
      cancel_timer_ms = if ($isCancel) { $timerMs } else { $null }
      fixture_bytes = $fixtureBytes; fixture_sha256 = $hash
      arguments = $arguments; aggregate = $aggregate; runs = $measurements.ToArray()
    })
    if ($isCancel) {
      Write-Host ("{0}: median {1:N1} ms wall (overshoot {2:N1} ms past the {3} ms timer), max working set {4:N2} MiB" -f $case.name, $aggregate.median_elapsed_ms, $aggregate.median_cancel_overshoot_ms, $timerMs, ($aggregate.max_working_set_bytes / 1MB))
    } else {
      Write-Host ("{0}: median {1:N1} ms wall ({2:N1} ms in core), range {3:N1}-{4:N1} ms, {5:N1} MiB/s, max working set {6:N2} MiB ({7:N3}x input)" -f $case.name, $aggregate.median_elapsed_ms, $aggregate.median_cli_elapsed_ms, $aggregate.min_elapsed_ms, $aggregate.max_elapsed_ms, $aggregate.throughput_mib_per_s, ($aggregate.max_working_set_bytes / 1MB), $aggregate.working_set_to_input_ratio)
    }
  }

  $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
  $resultPath = Join-Path $ResultsDirectory "streaming-$stamp.json"
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($resultPath, ($report | ConvertTo-Json -Depth 12), $utf8)
  # The file must round-trip as JSON before it is announced as machine-readable output.
  $null = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json -AsHashtable

  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add("# Streaming benchmark $($report.recorded_at_utc)")
  $lines.Add('')
  $lines.Add("- Executable: ``$($report.executable)`` (SHA-256 ``$($report.executable_sha256)``)")
  $gitLine = if ($git) { "``$($git.commit)``" + $(if ($git.core_dirty) { ' (core sources modified)' } elseif ($git.dirty) { ' (tracked files modified outside crates/)' } else { ' (clean)' }) } else { 'unavailable' }
  $lines.Add("- Git commit: $gitLine")
  $lines.Add("- Toolchain: $($report.rustc); $($report.cargo); PowerShell $($report.powershell)")
  $lines.Add("- Machine: $($machine.cpu), $($machine.logical_processors) logical processors, $([Math]::Round($machine.physical_memory_bytes / 1GB, 1)) GiB RAM, $($machine.os)")
  $lines.Add("- Method: $Runs measured fresh-process runs per case after $Warmups discarded warm-up(s); warm OS file cache; working set polled at least every $SampleIntervalMs ms.")
  $lines.Add('')
  $lines.Add('| Case | Input bytes | Median wall ms | Min–max wall ms | Median core ms | MiB/s | Peak working set MiB | Working set ÷ input |')
  $lines.Add('|---|---:|---:|---:|---:|---:|---:|---:|')
  foreach ($case in @($report.cases | Where-Object { $null -eq $_.cancel_timer_ms })) {
    $a = $case.aggregate
    $lines.Add(('| {0} | {1:N0} | {2:N1} | {3:N1}–{4:N1} | {5:N0} | {6:N1} | {7:N2} | {8:N3} |' -f $case.name, $case.fixture_bytes, $a.median_elapsed_ms, $a.min_elapsed_ms, $a.max_elapsed_ms, $a.median_cli_elapsed_ms, $a.throughput_mib_per_s, ($a.max_working_set_bytes / 1MB), $a.working_set_to_input_ratio))
  }
  $cancelCases = @($report.cases | Where-Object { $null -ne $_.cancel_timer_ms })
  if ($cancelCases.Count -gt 0) {
    $lines.Add('')
    $lines.Add('| Cancellation case | Timer ms | Median wall ms | Min–max wall ms | Median overshoot past timer ms | Exit | Output left behind |')
    $lines.Add('|---|---:|---:|---:|---:|---:|---|')
    foreach ($case in $cancelCases) {
      $a = $case.aggregate
      $leftover = if ($case.operation -eq 'cancel-minify') { 'none (checked)' } else { 'n/a (inspection)' }
      $lines.Add(('| {0} | {1} | {2:N1} | {3:N1}–{4:N1} | {5:N1} | {6} | {7} |' -f $case.name, $case.cancel_timer_ms, $a.median_elapsed_ms, $a.min_elapsed_ms, $a.max_elapsed_ms, $a.median_cancel_overshoot_ms, $case.expected_exit, $leftover))
    }
  }
  $lines.Add('')
  $lines.Add('## Fixtures')
  $lines.Add('')
  $lines.Add('| Fixture | Bytes | SHA-256 | Matches manifest.json |')
  $lines.Add('|---|---:|---|---|')
  foreach ($fixture in $report.fixtures) {
    $match = if ($null -eq $fixture.manifest_match) { 'no manifest entry' } else { 'yes' }
    $lines.Add(('| {0} | {1:N0} | `{2}` | {3} |' -f $fixture.file, $fixture.bytes, $fixture.sha256, $match))
  }
  $lines.Add('')
  $lines.Add('## Caveats')
  $lines.Add('')
  foreach ($key in $report.methodology.Keys) { $lines.Add("- **$key**: $($report.methodology[$key])") }
  $lines.Add('')
  $summaryPath = Join-Path $ResultsDirectory "streaming-$stamp.md"
  [System.IO.File]::WriteAllText($summaryPath, ($lines -join "`n"), $utf8)
  Write-Host "Saved raw results: $resultPath"
  Write-Host "Saved summary: $summaryPath"
} finally {
  # This exact UUID-named file was created by this run; no recursive deletion.
  Remove-ScratchOutput
}
