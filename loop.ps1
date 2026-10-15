# Wavelocal autonomous evolution loop.
# Every 5 hours: run one headless Claude Code session that picks the next ROADMAP.md item,
# implements and verifies it, then pushes to origin/main (which triggers the Android APK build).
#
#   Start (detached):  Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','loop.ps1'
#   Stop:              create a file named STOP next to this script (or Stop-Process -Id <PID>)
#   Inspect:           Get-Content evolution.log -Tail 50
param(
  [int]$IntervalSeconds = 18000,   # 5 hours
  [int]$RunTimeoutSeconds = 7200   # kill a single run that hangs after 2 hours
)

$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot
$log = Join-Path $PSScriptRoot 'evolution.log'
$lastRun = Join-Path $PSScriptRoot 'evolution-last-run.txt'
$errFile = Join-Path $PSScriptRoot 'evolution-last-run.err'
$stopFile = Join-Path $PSScriptRoot 'STOP'

function Write-Log([string]$msg) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg" | Out-File -FilePath $log -Append -Encoding utf8
}

# No double quotes inside: the prompt is passed as a single quoted argument.
$prompt = 'Read ROADMAP.md. Pick the next uncompleted task or performance/UI improvement. Run git status first; if a previous run left unfinished work, finish or cleanly revert only that work. Implement exactly one focused improvement with zero human intervention, keeping all existing features working and the app local-first and privacy-first. Ensure npm run build exits 0; if it cannot be fixed, revert your changes and record the blocker in ROADMAP.md instead of pushing broken code. Update ROADMAP.md (tick the box and add one Changelog line), commit with a conventional message, run git pull --rebase origin main, then git push origin main. Pushing triggers the Android APK build automatically.'

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) { $claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe' }

# Single-instance guard: a second copy (e.g. Startup entry + manual launch) exits immediately.
$script:instanceLock = New-Object System.Threading.Mutex($false, 'Local\WavelocalEvolutionLoop')
if (-not $script:instanceLock.WaitOne(0)) { Write-Log "another loop instance is already running - PID $PID exiting"; exit 0 }

Write-Log "loop started (PID $PID), interval ${IntervalSeconds}s, claude=$claude"

while ($true) {
  if (Test-Path -LiteralPath $stopFile) { Write-Log 'STOP file found - loop exiting'; break }

  $before = (git rev-parse --short HEAD 2>$null)
  Write-Log "run start (HEAD $before)"
  $status = 'ok'
  try {
    $p = Start-Process -FilePath $claude `
      -ArgumentList @('-p', "`"$prompt`"", '--dangerously-skip-permissions') `
      -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru `
      -RedirectStandardOutput $lastRun -RedirectStandardError $errFile
    $null = $p.Handle   # cache the process handle, otherwise ExitCode is $null in Windows PowerShell 5.1
    if (-not $p.WaitForExit($RunTimeoutSeconds * 1000)) {
      $p.Kill()
      $status = "TIMEOUT after ${RunTimeoutSeconds}s (killed)"
    } elseif ($p.ExitCode -and $p.ExitCode -ne 0) {
      $status = "FAILED exit=$($p.ExitCode)"
    }
  } catch {
    $status = "ERROR $($_.Exception.Message)"
  }

  $after = (git rev-parse --short HEAD 2>$null)
  $summary = if (Test-Path $lastRun) { (Get-Content $lastRun -Tail 6 -Encoding UTF8 -ErrorAction SilentlyContinue) -join ' | ' } else { '' }
  if ($before -ne $after) { Write-Log "run $status - new commits $before -> $after" } else { Write-Log "run $status - no new commit (HEAD $after)" }
  if ($summary) { Write-Log "  last output: $summary" }

  # Sleep until the next window, waking every 30s so STOP is honoured promptly.
  $next = (Get-Date).AddSeconds($IntervalSeconds)
  Write-Log "sleeping until $($next.ToString('yyyy-MM-dd HH:mm:ss'))"
  while ((Get-Date) -lt $next) {
    if (Test-Path -LiteralPath $stopFile) { break }
    Start-Sleep -Seconds 30
  }
}
