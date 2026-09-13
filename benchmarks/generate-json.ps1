param(
  [string]$Path = "fixture-50mb.json",
  [int]$Records = 300000
)

$writer = [System.IO.StreamWriter]::new($Path, $false, [System.Text.UTF8Encoding]::new($false))
try {
  $writer.Write('[')
  for ($i = 0; $i -lt $Records; $i++) {
    if ($i -gt 0) { $writer.Write(',') }
    $payload = ('x' * 120)
    $writer.Write('{"id":'); $writer.Write($i); $writer.Write(',"payload":"'); $writer.Write($payload); $writer.Write('"}')
  }
  $writer.Write(']')
} finally { $writer.Dispose() }
Write-Output ("Wrote {0:N0} bytes to {1}" -f (Get-Item $Path).Length, $Path)
