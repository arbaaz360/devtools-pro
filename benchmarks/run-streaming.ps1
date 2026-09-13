#requires -Version 7.0
param(
  [ValidateRange(1, 100)][int]$Runs = 5,
  [ValidateRange(0, 5)][int]$Warmups = 1,
  [ValidateRange(1, 100)][int]$SampleIntervalMs = 5,
  [ValidateRange(1, 3600)][int]$TimeoutSeconds = 120,
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
      $stderrPreview = if ($stderr.Length -gt 1000) { $stderr.Substring(0, 1000) + '…' } else { $stderr }
      $stdoutPreview = if ($stdout.Length -gt 1000) { $stdout.Substring(0, 1000) + '…' } else { $stdout }
      throw "Unexpected exit $exitCode (expected $ExpectedExitCode). stderr: $stderrPreview stdout: $stdoutPreview"
    }
    if ($exitCode -eq 0) {
      try { $summary = $stdout | ConvertFrom-Json -AsHashtable } catch { throw "CLI stdout was not a JSON summary: $stdout" }
      if (-not $summary.ContainsKey('input_bytes') -or $summary['valid'] -ne $true) {
        $stdoutPreview = if ($stdout.Length -gt 1000) { $stdout.Substring(0, 1000) + '…' } else { $stdout }
        throw "Unexpected success summary (CLI contract mismatch). stdout: $stdoutPreview"
      }
    } else { $summary = $null }
    return [ordered]@{
      elapsed_ms = [Math]::Round($watch.Elapsed.TotalMilliseconds, 3)
      peak_working_set_bytes = $peakWorking
      peak_private_bytes_sampled = $peakPrivateSampled
      memory_samples = $samples; exit_code = $exitCode; summary = $summary; stderr = $stderr.Trim()
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

$cases = [System.Collections.Generic.List[object]]::new()
foreach ($name in @('fixture-50mb.json', 'fixture-250mb.json')) {
  if (Test-Path -LiteralPath (Join-Path $FixtureDirectory $name)) {
    $cases.Add(@{ name = "$name inspect"; file = $name; format = 'json'; operation = 'inspect'; expected_exit = 0 })
  }
}
foreach ($file in @(Get-ChildItem -LiteralPath $FixtureDirectory -Filter 'representative-*mib.csv' | Sort-Object Name)) {
  $cases.Add(@{ name = "$($file.Name) inspect"; file = $file.Name; format = 'csv'; operation = 'inspect'; expected_exit = 0 })
}
if ($cases.Count -eq 0) { throw 'No benchmark fixtures found; run generate-corpus.ps1 first.' }
if (Test-Path -LiteralPath (Join-Path $FixtureDirectory 'fixture-250mb.json')) {
  $cases.Add(@{ name = 'fixture-250mb.json cancel at 50 ms'; file = 'fixture-250mb.json'; format = 'json'; operation = 'cancel'; expected_exit = 130 })
}
$scratchOutput = Join-Path $ResultsDirectory ("transform-{0}.json" -f [Guid]::NewGuid().ToString('N'))
if ($IncludeTransform) {
  foreach ($name in @('fixture-50mb.json', 'fixture-250mb.json')) {
    if (Test-Path -LiteralPath (Join-Path $FixtureDirectory $name)) {
      $cases.Add(@{ name = "$name minify to file"; file = $name; format = 'json'; operation = 'minify'; expected_exit = 0 })
    }
  }
}

$machine = [ordered]@{ os = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription; logical_processors = [Environment]::ProcessorCount }
try {
  $machine.cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name).Trim()
  $machine.physical_memory_bytes = [long](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
} catch { $machine.metadata_note = 'CIM hardware metadata unavailable.' }
$report = [ordered]@{
  schema_version = 1; recorded_at_utc = [DateTime]::UtcNow.ToString('o')
  executable = $Executable; executable_sha256 = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant()
  rustc = (& rustc --version | Out-String).Trim(); cargo = (& cargo --version | Out-String).Trim()
  powershell = $PSVersionTable.PSVersion.ToString(); machine = $machine
  methodology = [ordered]@{
    measured_runs = $Runs; discarded_warmups_per_case = $Warmups; sample_interval_ms = $SampleIntervalMs
    cache = 'Warm-cache fresh-process runs; OS file cache is not cleared. Do not label these cold-start results.'
    elapsed = 'Parent stopwatch around process launch and observed exit, including startup and file I/O; up to a sampling interval plus scheduler delay of measurement overhead.'
    memory = 'PeakWorkingSet64 highest observed OS peak; private bytes are the largest poll sample, not a true peak. Parent process excluded. Short-lived allocations can be missed.'
    cancellation = 'Wall time minus the requested 50 ms timer is a startup-inclusive overshoot, not isolated cancellation acknowledgement latency. Inspect CLI error details for operation-internal timing if available.'
    distribution = 'Report median, minimum and maximum. Five runs do not establish a meaningful p95/p99.'
    scope = 'Core CLI only. No GUI responsiveness, WebView memory, startup first paint, typing or accessibility claim.'
  }
  cases = [System.Collections.Generic.List[object]]::new()
}

try {
  foreach ($case in $cases) {
    $path = Join-Path $FixtureDirectory $case.file
    $arguments = @('--file', $path)
    if ($case.operation -eq 'minify') { $arguments += @('--minify', '--output', $scratchOutput) }
    else { $arguments += @('--inspect', '--format', $case.format) }
    if ($case.operation -eq 'cancel') { $arguments += @('--cancel-after-ms', '50') }
    # Hashing is outside the measured interval and also warms the OS cache deliberately.
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if (Test-Path -LiteralPath $scratchOutput) { Remove-Item -LiteralPath $scratchOutput -Force }
    for ($i = 0; $i -lt $Warmups; $i++) {
      $null = Invoke-MeasuredProcess $arguments $case.expected_exit
      if ($case.operation -eq 'minify' -and (Test-Path -LiteralPath $scratchOutput)) { Remove-Item -LiteralPath $scratchOutput -Force }
    }
    $measurements = [System.Collections.Generic.List[object]]::new()
    for ($i = 0; $i -lt $Runs; $i++) {
      $measurement = Invoke-MeasuredProcess $arguments $case.expected_exit
      if ($case.operation -eq 'minify' -and (Test-Path -LiteralPath $scratchOutput)) { Remove-Item -LiteralPath $scratchOutput -Force }
      if ($case.operation -eq 'cancel') { $measurement.cancel_timer_overshoot_ms = [Math]::Round($measurement.elapsed_ms - 50, 3) }
      if ($case.expected_exit -eq 0 -and [long]$measurement.summary.input_bytes -ne (Get-Item -LiteralPath $path).Length) {
        throw "CLI reported an incorrect input size for $($case.name)."
      }
      $measurements.Add($measurement)
    }
    $times = [double[]]@($measurements | ForEach-Object { $_.elapsed_ms })
    $aggregate = [ordered]@{
      median_elapsed_ms = [Math]::Round((Get-Median $times), 3)
      min_elapsed_ms = ($times | Measure-Object -Minimum).Minimum
      max_elapsed_ms = ($times | Measure-Object -Maximum).Maximum
      max_working_set_bytes = ($measurements.peak_working_set_bytes | Measure-Object -Maximum).Maximum
      max_private_bytes_sampled = ($measurements.peak_private_bytes_sampled | Measure-Object -Maximum).Maximum
    }
    $report.cases.Add([ordered]@{
      name = $case.name; fixture = $case.file; fixture_bytes = (Get-Item -LiteralPath $path).Length; fixture_sha256 = $hash
      arguments = $arguments; aggregate = $aggregate; runs = $measurements.ToArray()
    })
    Write-Host ("{0}: median {1:N1} ms, range {2:N1}-{3:N1} ms, max working set {4:N2} MiB" -f $case.name, $aggregate.median_elapsed_ms, $aggregate.min_elapsed_ms, $aggregate.max_elapsed_ms, ($aggregate.max_working_set_bytes / 1MB))
  }
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
  $resultPath = Join-Path $ResultsDirectory "streaming-$stamp.json"
  [System.IO.File]::WriteAllText($resultPath, ($report | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
  Write-Host "Saved raw results: $resultPath"
} finally {
  # This exact UUID-named file was created by this run; no recursive deletion.
  if (Test-Path -LiteralPath $scratchOutput) { Remove-Item -LiteralPath $scratchOutput -Force }
}
