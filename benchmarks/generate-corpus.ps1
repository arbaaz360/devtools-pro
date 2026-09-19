#requires -Version 7.0
<# Prepares the benchmark corpus in benchmarks/fixtures (ignored by git).

The JSON and text fixtures, including fixture-50mb.json and fixture-250mb.json,
come from scripts/generate-fixtures.mjs: the same generator the quality gate and
the cargo acceptance tests use, so the benchmark measures the bytes those tests
exercise. That generator never rewrites an existing file; delete a fixture to
regenerate it. This script adds the representative CSV fixture and writes
manifest.json with the SHA-256 of every fixture it knows about.
#>
param(
  [ValidateRange(1, 250)][int]$CsvMiB = 50,
  [string]$Directory = (Join-Path $PSScriptRoot 'fixtures')
)
$ErrorActionPreference = 'Stop'
$null = New-Item -ItemType Directory -Path $Directory -Force
$Directory = (Resolve-Path -LiteralPath $Directory).Path
$utf8 = [System.Text.UTF8Encoding]::new($false)
$entries = [System.Collections.Generic.List[object]]::new()

function Add-Fixture([string]$Name, [string]$Format, [string]$Expectation, [string]$Description) {
  $path = Join-Path $Directory $Name
  if (-not (Test-Path -LiteralPath $path)) { throw "Expected fixture is missing after generation: $path" }
  $null = $entries.Add([ordered]@{
    file = $Name; format = $Format; expectation = $Expectation; description = $Description
    bytes = (Get-Item -LiteralPath $path).Length
    sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  })
}

$generator = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../scripts/generate-fixtures.mjs')).Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node is required to run $generator (it is already a repository dependency)." }
& node $generator $Directory
if ($LASTEXITCODE -ne 0) { throw "scripts/generate-fixtures.mjs exited with $LASTEXITCODE." }

# The CSV is rewritten every run. The stop condition counts encoded bytes
# explicitly so the fixture does not depend on StreamWriter buffering details.
$csvName = "representative-${CsvMiB}mib.csv"
$csvPath = Join-Path $Directory $csvName
$writer = [System.IO.StreamWriter]::new($csvPath, $false, $utf8, 65536)
$row = 0
try {
  $header = "id,name,active,amount,created_at,note`r`n"
  $writer.Write($header)
  $written = [long]$utf8.GetByteCount($header)
  $target = [long]$CsvMiB * 1MB
  while ($written -lt $target) {
    $active = if ($row % 2 -eq 0) { 'true' } else { 'false' }
    $amount = '{0}.{1:00}' -f ($row % 10000), ($row % 100)
    $note = if ($row % 97 -eq 0) { '"quoted, comma; ""escaped quote"" and' + "`r`n" + 'a second line"' } else { '"Unicode café 東京; deterministic mixed-field CSV payload"' }
    $line = "$row,record-$row,$active,$amount,2026-09-13T00:00:00Z,$note`r`n"
    $writer.Write($line)
    $written += $utf8.GetByteCount($line)
    $row++
  }
} finally { $writer.Dispose() }
Add-Fixture $csvName 'csv' 'valid' "Six fields, Unicode, CRLF, booleans, decimal numbers, escaped quotes and quoted multiline fields; $row data rows."

Add-Fixture 'fixture-50mb.json' 'json' 'valid' 'Generated ASCII array of identical 480-byte payload records; not representative of heterogeneous real-world JSON.'
Add-Fixture 'fixture-250mb.json' 'json' 'valid' 'Generated ASCII array of identical 480-byte payload records; not representative of heterogeneous real-world JSON.'
Add-Fixture 'deep-1024.json' 'json' 'depth_limit' 'Valid JSON with 1024 array levels; a bounded parser should report its depth limit without crashing.'
Add-Fixture 'long-string.json' 'json' 'valid' 'A one MiB single string checks whether previews remain bounded.'
Add-Fixture 'malformed.json' 'json' 'invalid' 'Missing JSON value after a colon.'
Add-Fixture 'trailing-content.json' 'json' 'invalid' 'A complete JSON root followed by a second root.'
Add-Fixture 'lexemes.json' 'json' 'valid' 'Large integer, exact number lexemes, duplicate keys, escapes and Unicode; transformation fidelity fixture.'
Add-Fixture 'unclosed-quote.csv' 'csv' 'invalid' 'Unclosed quoted CSV field at EOF.'
Add-Fixture 'ragged.csv' 'csv' 'policy_dependent' 'Ragged rows; inspection should document whether unequal field counts are accepted.'
Add-Fixture 'mixed-newlines.txt' 'text' 'valid' 'Small UTF-8 text with CRLF, LF and CR newline forms.'
Add-Fixture 'invalid-utf8.json' 'json' 'invalid' 'Invalid UTF-8 byte inside a JSON string.'
Add-Fixture 'bom.json' 'json' 'policy_dependent' 'UTF-8 BOM before JSON; record whether the parser explicitly supports it.'

$manifest = [ordered]@{ generated_at_utc = [DateTime]::UtcNow.ToString('o'); generator = 'generate-corpus.ps1 + scripts/generate-fixtures.mjs'; fixtures = $entries.ToArray() }
[System.IO.File]::WriteAllText((Join-Path $Directory 'manifest.json'), ($manifest | ConvertTo-Json -Depth 8), $utf8)
foreach ($entry in $entries) {
  Write-Output ("{0}: {1:N0} bytes ({2}) sha256 {3}" -f $entry.file, $entry.bytes, $entry.expectation, $entry.sha256)
}
