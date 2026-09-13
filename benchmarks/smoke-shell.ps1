#requires -Version 7.0
<# Deterministic offline acceptance checklist for the desktop shell's CLI adapter.
Exercises: open -> automatic result (inspect) -> format/minify -> save copy -> reopen.
#>
param(
  [string]$Executable = (Join-Path $PSScriptRoot '../target/debug/devtools-cli.exe'),
  [string]$Fixture = (Join-Path $PSScriptRoot 'fixtures/lexemes.json')
)
$ErrorActionPreference = 'Stop'
$Executable = (Resolve-Path -LiteralPath $Executable).Path
$Fixture = (Resolve-Path -LiteralPath $Fixture).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ("devtools-smoke-" + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $work
$copy = Join-Path $work 'saved-minified.json'
try {
  $before = (Get-FileHash -LiteralPath $Fixture -Algorithm SHA256).Hash
  $inspect = (& $Executable --file $Fixture --inspect --format json | ConvertFrom-Json)
  if (-not $inspect.valid) { throw 'open/automatic result did not report valid JSON' }
  $result = (& $Executable --file $Fixture --minify --output $copy | ConvertFrom-Json)
  if (-not (Test-Path -LiteralPath $copy) -or $result.valid -ne $true) { throw 'minify did not publish a result copy' }
  $reopen = (& $Executable --file $copy --inspect --format json | ConvertFrom-Json)
  if ($reopen.valid -ne $true) { throw 'saved result could not be reopened' }
  $after = (Get-FileHash -LiteralPath $Fixture -Algorithm SHA256).Hash
  if ($before -ne $after) { throw 'source changed during transform' }
  $invalid = Join-Path $PSScriptRoot 'fixtures/invalid-utf8.json'
  $null = & $Executable --file $invalid --inspect --format json 2>$null
  if ($LASTEXITCODE -eq 0) { throw 'invalid UTF-8 unexpectedly succeeded' }
  Write-Output ("PASS smoke-shell source_bytes={0} result_bytes={1}" -f (Get-Item $Fixture).Length, (Get-Item $copy).Length)
} finally {
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
