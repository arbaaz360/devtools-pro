#requires -Version 7.0
<# Validates a run-streaming.ps1 JSON report (schema_version 2) and exits nonzero
on the first violation. Defaults to the newest streaming-*.json in results/. #>
param(
  [string]$Path,
  [string]$ResultsDirectory = (Join-Path $PSScriptRoot 'results')
)
$ErrorActionPreference = 'Stop'
if (-not $Path) {
  $newest = Get-ChildItem -LiteralPath $ResultsDirectory -Filter 'streaming-*.json' | Sort-Object Name | Select-Object -Last 1
  if (-not $newest) { throw "No streaming-*.json report found in $ResultsDirectory." }
  $Path = $newest.FullName
}
$Path = (Resolve-Path -LiteralPath $Path).Path
$report = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable

function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "Invalid report ${Path}: $Message" } }
function Assert-Keys([hashtable]$Object, [string[]]$Keys, [string]$Where) {
  foreach ($key in $Keys) { Assert $Object.ContainsKey($key) "$Where lacks '$key'" }
}
function Assert-Number($Value, [string]$Where) { Assert ($Value -is [ValueType] -and $Value -isnot [bool]) "$Where is not a number" }

Assert-Keys $report @('schema_version', 'recorded_at_utc', 'executable', 'executable_sha256', 'rustc', 'cargo', 'powershell', 'machine', 'parameters', 'contract', 'contract_preflight', 'methodology', 'fixtures', 'cases') 'report'
Assert ($report.schema_version -eq 2) "schema_version is $($report.schema_version), expected 2"
Assert ($report.executable_sha256 -match '^[0-9a-f]{64}$') 'executable_sha256 is not a lowercase SHA-256'
Assert-Keys $report.parameters @('runs', 'warmups', 'sample_interval_ms', 'timeout_seconds', 'cancel_after_ms', 'include_transform') 'parameters'
Assert-Keys $report.contract @('summary_keys', 'error_key', 'exit_codes') 'contract'
Assert-Keys $report.contract_preflight @('usage_exit', 'inspect_summary', 'invalid_utf8_error_code') 'contract_preflight'
Assert ($report.contract_preflight.invalid_utf8_error_code -eq 'invalid_utf8') 'preflight did not record the invalid_utf8 error code'
Assert-Keys $report.methodology @('cache', 'elapsed', 'cli_elapsed', 'memory', 'cancellation', 'distribution', 'scope') 'methodology'

Assert (@($report.fixtures).Count -gt 0) 'no fixtures recorded'
foreach ($fixture in $report.fixtures) {
  Assert-Keys $fixture @('file', 'bytes', 'sha256', 'manifest_sha256', 'manifest_match') "fixture $($fixture.file)"
  Assert ($fixture.sha256 -match '^[0-9a-f]{64}$') "fixture $($fixture.file) sha256 is not a lowercase SHA-256"
  Assert ([long]$fixture.bytes -gt 0) "fixture $($fixture.file) has no bytes"
  if ($null -ne $fixture.manifest_sha256) { Assert ($fixture.manifest_sha256 -eq $fixture.sha256) "fixture $($fixture.file) differs from its manifest hash" }
}

$expectedKeys = @($report.contract.summary_keys | Sort-Object) -join ','
Assert (@($report.cases).Count -gt 0) 'no cases recorded'
foreach ($case in $report.cases) {
  $where = "case '$($case.name)'"
  Assert-Keys $case @('name', 'fixture', 'operation', 'format', 'expected_exit', 'cancel_timer_ms', 'fixture_bytes', 'fixture_sha256', 'arguments', 'aggregate', 'runs') $where
  Assert ($case.fixture_sha256 -match '^[0-9a-f]{64}$') "$where fixture_sha256 is not a lowercase SHA-256"
  Assert (@($report.fixtures | Where-Object { $_.file -eq $case.fixture -and $_.sha256 -eq $case.fixture_sha256 }).Count -eq 1) "$where does not reference a recorded fixture"
  Assert (@($case.runs).Count -eq [int]$report.parameters.runs) "$where has $(@($case.runs).Count) runs, expected $($report.parameters.runs)"
  Assert-Keys $case.aggregate @('median_elapsed_ms', 'min_elapsed_ms', 'max_elapsed_ms', 'median_cli_elapsed_ms', 'median_launch_overhead_ms', 'median_cancel_overshoot_ms', 'throughput_mib_per_s', 'max_working_set_bytes', 'max_private_bytes_sampled', 'working_set_to_input_ratio') "$where aggregate"
  Assert-Number $case.aggregate.median_elapsed_ms "$where median_elapsed_ms"
  Assert ($case.aggregate.min_elapsed_ms -le $case.aggregate.median_elapsed_ms -and $case.aggregate.median_elapsed_ms -le $case.aggregate.max_elapsed_ms) "$where median is outside its min-max range"
  Assert ([long]$case.aggregate.max_working_set_bytes -gt 0) "$where has no working-set observation"
  $isCancel = $null -ne $case.cancel_timer_ms
  if ($isCancel) {
    Assert ($case.expected_exit -eq $report.contract.exit_codes.cancelled) "$where expects exit $($case.expected_exit), not the cancelled code"
    Assert-Number $case.aggregate.median_cancel_overshoot_ms "$where median_cancel_overshoot_ms"
  } else {
    Assert ($case.expected_exit -eq $report.contract.exit_codes.success) "$where expects exit $($case.expected_exit), not the success code"
    Assert-Number $case.aggregate.median_cli_elapsed_ms "$where median_cli_elapsed_ms"
    Assert-Number $case.aggregate.throughput_mib_per_s "$where throughput_mib_per_s"
    Assert-Number $case.aggregate.working_set_to_input_ratio "$where working_set_to_input_ratio"
  }
  foreach ($run in $case.runs) {
    Assert-Keys $run @('elapsed_ms', 'cli_elapsed_ms', 'peak_working_set_bytes', 'peak_private_bytes_sampled', 'memory_samples', 'exit_code', 'error_code', 'summary', 'stderr') "$where run"
    Assert ([int]$run.exit_code -eq [int]$case.expected_exit) "$where run exited $($run.exit_code), expected $($case.expected_exit)"
    if ($isCancel) {
      Assert ($run.error_code -eq 'cancelled') "$where run recorded error code '$($run.error_code)'"
      Assert ($null -eq $run.summary) "$where cancelled run carries a success summary"
    } else {
      Assert ($null -ne $run.summary) "$where run has no summary"
      $keys = @($run.summary.Keys | Sort-Object) -join ','
      Assert ($keys -eq $expectedKeys) "$where run summary keys [$keys] do not match the contract [$expectedKeys]"
      Assert ($run.summary.valid -eq $true) "$where run summary is not valid"
      Assert ([long]$run.summary.input_bytes -eq [long]$case.fixture_bytes) "$where run input_bytes does not match the fixture size"
      Assert-Number $run.cli_elapsed_ms "$where run cli_elapsed_ms"
    }
  }
}
Write-Output ("OK {0}: schema {1}, {2} fixture(s), {3} case(s), {4} run(s) each" -f $Path, $report.schema_version, @($report.fixtures).Count, @($report.cases).Count, $report.parameters.runs)
