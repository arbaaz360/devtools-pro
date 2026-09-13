#requires -Version 7.0
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
  $null = $entries.Add([ordered]@{
    file = $Name; format = $Format; expectation = $Expectation; description = $Description
    bytes = (Get-Item -LiteralPath $path).Length
    sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  })
}
function Write-Fixture([string]$Name, [string]$Value, [string]$Format, [string]$Expectation, [string]$Description) {
  [System.IO.File]::WriteAllText((Join-Path $Directory $Name), $Value, $utf8)
  Add-Fixture $Name $Format $Expectation $Description
}

# A deterministic, bounded allocation generator. Existing large JSON files are never rewritten.
$csvName = "representative-${CsvMiB}mib.csv"
$csvPath = Join-Path $Directory $csvName
$writer = [System.IO.StreamWriter]::new($csvPath, $false, $utf8, 65536)
$row = 0
try {
  $writer.Write("id,name,active,amount,created_at,note`r`n")
  $target = [long]$CsvMiB * 1MB
  while ($writer.BaseStream.Position -lt $target) {
    $active = if ($row % 2 -eq 0) { 'true' } else { 'false' }
    $amount = '{0}.{1:00}' -f ($row % 10000), ($row % 100)
    $note = if ($row % 97 -eq 0) { '"quoted, comma; ""escaped quote"" and' + "`r`n" + 'a second line"' } else { '"Unicode café 東京; deterministic mixed-field CSV payload"' }
    $writer.Write("$row,record-$row,$active,$amount,2026-09-13T00:00:00Z,$note`r`n")
    $row++
    if ($row % 4096 -eq 0) { $writer.Flush() }
  }
} finally { $writer.Dispose() }
Add-Fixture $csvName 'csv' 'valid' "Six fields, Unicode, CRLF, booleans, decimal numbers, escaped quotes and quoted multiline fields; $row data rows."

Write-Fixture 'deep-1024.json' (('[' * 1024) + '0' + (']' * 1024)) 'json' 'depth_limit' 'Valid JSON with 1024 array levels; a bounded parser should report its depth limit without crashing.'
Write-Fixture 'long-string.json' ('{"payload":"' + ('x' * 1MB) + '","after":true}') 'json' 'valid' 'A one MiB single string checks whether previews remain bounded.'
Write-Fixture 'malformed.json' '{"rows":[1,2,3],"missing":}' 'json' 'invalid' 'Missing JSON value after a colon.'
Write-Fixture 'trailing-content.json' '{"ok":true} false' 'json' 'invalid' 'A complete JSON root followed by a second root.'
Write-Fixture 'lexemes.json' '{"huge":123456789012345678901234567890,"exponent":1.2300e+100,"zero":-0,"dup":1,"dup":2,"escaped":"\u0061","unicode":"café 東京"}' 'json' 'valid' 'Large integer, exact number lexemes, duplicate keys, escapes and Unicode; transformation fidelity fixture.'
Write-Fixture 'unclosed-quote.csv' "id,note`r`n1,`"unterminated" 'csv' 'invalid' 'Unclosed quoted CSV field at EOF.'
Write-Fixture 'ragged.csv' "id,note`r`n1,ok`r`n2,extra,field`r`n" 'csv' 'policy_dependent' 'Ragged rows; inspection should document whether unequal field counts are accepted.'
Write-Fixture 'mixed-newlines.txt' "first café`r`nsecond 東京`nthird`rfourth" 'text' 'valid' 'Small UTF-8 text with CRLF, LF and CR newline forms.'
[System.IO.File]::WriteAllBytes((Join-Path $Directory 'invalid-utf8.json'), [byte[]](0x7B,0x22,0x78,0x22,0x3A,0x22,0xFF,0x22,0x7D))
Add-Fixture 'invalid-utf8.json' 'json' 'invalid' 'Invalid UTF-8 byte inside a JSON string.'
[System.IO.File]::WriteAllText((Join-Path $Directory 'bom.json'), '{"bom":true}', [System.Text.UTF8Encoding]::new($true))
Add-Fixture 'bom.json' 'json' 'policy_dependent' 'UTF-8 BOM before JSON; record whether the parser explicitly supports it.'
foreach ($name in @('fixture-50mb.json', 'fixture-250mb.json')) {
  if (Test-Path -LiteralPath (Join-Path $Directory $name)) {
    Add-Fixture $name 'json' 'valid' 'Historical ASCII array fixture: sequential integer IDs and a repeated payload string; not representative of heterogeneous real-world JSON.'
  }
}
$manifest = [ordered]@{ generated_at_utc = [DateTime]::UtcNow.ToString('o'); generator = 'generate-corpus.ps1'; fixtures = $entries.ToArray() }
[System.IO.File]::WriteAllText((Join-Path $Directory 'manifest.json'), ($manifest | ConvertTo-Json -Depth 8), $utf8)
foreach ($entry in $entries) {
  Write-Output ("{0}: {1:N0} bytes ({2})" -f $entry.file, $entry.bytes, $entry.expectation)
}
