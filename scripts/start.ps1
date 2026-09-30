# Start the backend bound to 127.0.0.1 on an automatic free port.
# Manages only THIS project: pid/port/db live under the project directory.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path data, tmp | Out-Null

$pidFile = Join-Path $root "tmp/server.pid"
if (Test-Path $pidFile) {
  $old = Get-Content $pidFile
  if (Get-Process -Id $old -ErrorAction SilentlyContinue) {
    Write-Host "already running with pid $old (see tmp/server.port)"
    exit 0
  }
}

$env:DRILL_DB = Join-Path $root "data/app.sqlite"
$env:DRILL_PORT_FILE = Join-Path $root "tmp/server.port"
$out = Join-Path $root "tmp/server.out.log"
$err = Join-Path $root "tmp/server.err.log"

$p = Start-Process node -ArgumentList "--experimental-strip-types","src/serve.ts" `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $out -RedirectStandardError $err
Set-Content -Path $pidFile -Value $p.Id
Start-Sleep -Milliseconds 800
$port = Get-Content (Join-Path $root "tmp/server.port")
Write-Host "started pid $($p.Id) on http://127.0.0.1:$port"
