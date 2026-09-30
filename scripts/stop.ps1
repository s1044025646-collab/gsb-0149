# Stop the backend started by start.ps1 (this project's pid file only).
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root "tmp/server.pid"
if (-not (Test-Path $pidFile)) { Write-Host "no pid file; nothing to stop"; exit 0 }
$procId = Get-Content $pidFile
if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
  Stop-Process -Id $procId -Force
  Write-Host "stopped pid $procId"
} else {
  Write-Host "process $procId not running"
}
Remove-Item $pidFile -Force
