# Wavelocal autonomous evolution loop.
# Each cycle runs up to $TasksPerCycle headless Claude Code sessions back to back. Each one picks the next
# ROADMAP.md item, implements and verifies it, then pushes to origin/main (which triggers the Android APK build).
# After the cycle it sleeps until the next window (default 5 hours), or retries sooner if it hit a rate limit.
#
#   Start (detached):  Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File .\loop.ps1" -WindowStyle Hidden
#   Stop:              create a file named STOP next to this script (or Stop-Process -Id <PID>)
#   Inspect:           Get-Content evolution.log -Tail 50
param(
  [int]$IntervalSeconds = 18000,        # 5 hours between cycles
  [int]$RunTimeoutSeconds = 7200,       # kill a single run that hangs after 2 hours
  [int]$TasksPerCycle = 3,              # sessions per cycle (stops early on failure / no new commit / rate limit)
  [int]$RateLimitRetrySeconds = 1800    # when rate limited, try again after 30 minutes instead of waiting 5 hours
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

# Single-instance guard: a second copy (e.g. Startup entry + manual launch) exits immediately.
$script:instanceLock = New-Object System.Threading.Mutex($false, 'Local\WavelocalEvolutionLoop')
if (-not $script:instanceLock.WaitOne(0)) { Write-Log "another loop instance is already running - PID $PID exiting"; exit 0 }

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) { $claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe' }

# One headless session. Returns @{ Status; RateLimited; NewCommit }.
function Invoke-Run([int]$n) {
  $before = (git rev-parse --short HEAD 2>$null)
  Write-Log "task $n/$TasksPerCycle start (HEAD $before)"
  $status = 'ok'
  $rateLimited = $false
  Remove-Item $lastRun, $errFile -ErrorAction SilentlyContinue
  try {
    $p = Start-Process -FilePath $claude `
      -ArgumentList @('-p', "`"$prompt`"", '--dangerously-skip-permissions', '--output-format', 'json') `
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

  # Parse the JSON result so token usage / cost / turns land in the log.
  $text = ''
  $raw = if (Test-Path $lastRun) { Get-Content $lastRun -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } else { '' }
  $err = if (Test-Path $errFile) { Get-Content $errFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } else { '' }
  try {
    $j = $raw | ConvertFrom-Json -ErrorAction Stop
    $text = [string]$j.result
    $u = $j.usage
    $in = [int64]($u.input_tokens) + [int64]($u.cache_creation_input_tokens) + [int64]($u.cache_read_input_tokens)
    Write-Log ("  usage: turns=$($j.num_turns) duration=$([math]::Round($j.duration_ms / 1000))s input_tokens=$in (fresh $($u.input_tokens), cached $($u.cache_read_input_tokens)) output_tokens=$($u.output_tokens) cost_usd=$($j.total_cost_usd) (notional on a subscription)")
    if ($j.is_error -and $status -eq 'ok') { $status = 'ERROR reported by claude' }
  } catch {
    $text = ($raw + ' ' + $err).Trim()
  }
  if ($status -ne 'ok' -and "$text $err" -match '(?i)rate.?limit|usage limit|quota|too many requests|429|overloaded|limit reached|resets? at') { $rateLimited = $true }

  $after = (git rev-parse --short HEAD 2>$null)
  $newCommit = ($before -ne $after)
  $commits = if ($newCommit) { "new commits $before -> $after" } else { "no new commit (HEAD $after)" }
  $rl = if ($rateLimited) { ' [RATE LIMITED]' } else { '' }
  Write-Log "task $n run $status$rl - $commits"
  $snippet = ($text -replace '\s+', ' ').Trim()
  if ($snippet.Length -gt 600) { $snippet = $snippet.Substring(0, 600) + '...' }
  if ($snippet) { Write-Log "  result: $snippet" }
  $errOne = ($err -replace '\s+', ' ').Trim()
  if ($errOne) { Write-Log "  stderr: $($errOne.Substring(0, [math]::Min(300, $errOne.Length)))" }
  return @{ Status = $status; RateLimited = $rateLimited; NewCommit = $newCommit }
}

Write-Log "loop started (PID $PID), interval ${IntervalSeconds}s, tasks/cycle $TasksPerCycle, claude=$claude"

while ($true) {
  if (Test-Path -LiteralPath $stopFile) { Write-Log 'STOP file found - loop exiting'; break }

  $rate = $false
  for ($i = 1; $i -le $TasksPerCycle; $i++) {
    $r = Invoke-Run $i
    if ($r.RateLimited) { $rate = $true; break }
    if ($r.Status -ne 'ok') { break }        # failed or timed out: do not chain more work on top
    if (-not $r.NewCommit) { break }          # nothing was pushed (blocker or nothing to do): stop for this cycle
    if (Test-Path -LiteralPath $stopFile) { break }
  }

  # Sleep until the next window, waking every 30s so STOP is honoured promptly.
  $wait = if ($rate) { $RateLimitRetrySeconds } else { $IntervalSeconds }
  $next = (Get-Date).AddSeconds($wait)
  Write-Log "cycle done$(if ($rate) { ' (rate limited - retrying early)' }); sleeping until $($next.ToString('yyyy-MM-dd HH:mm:ss'))"
  while ((Get-Date) -lt $next) {
    if (Test-Path -LiteralPath $stopFile) { break }
    Start-Sleep -Seconds 30
  }
}
