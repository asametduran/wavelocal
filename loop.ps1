# Wavelocal HYPERCODE evolution engine (continuous).
#
# While (true): run one heavy headless Claude Code session -> on success continue after a short breather ->
# on a rate limit / quota error wait and retry every ~17 minutes until the quota resets.
# Each session takes the next unchecked milestone from ROADMAP.md, verifies it, and pushes to origin/main
# (which triggers the Android APK build).
#
#   Start (detached):  Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File .\loop.ps1" -WindowStyle Hidden
#   Stop:              create a file named STOP next to this script (finishes the current session first), or Stop-Process -Id <PID>
#   Inspect:           Get-Content evolution.log -Tail 50      (loop.pid = supervisor PID, loop.heartbeat = last sign of life)
param(
  [int]$PauseSeconds = 15,               # breathing room between successful tasks
  [int]$RateLimitRetrySeconds = 1020,    # 17 min: re-check the quota this often while rate limited
  [int]$RunTimeoutSeconds = 14400,       # kill a single session that hangs after 4 hours
  [int]$FailurePauseSeconds = 60,        # pause after a failed (non rate-limit) session
  [int]$MaxConsecutiveFailures = 5,      # circuit breaker: this many failures in a row -> long backoff
  [int]$MaxNoCommitRuns = 3,             # circuit breaker: this many "ok but pushed nothing" runs in a row -> long backoff
  [int]$StuckBackoffSeconds = 1800,      # long backoff (30 min) used by both circuit breakers
  [string]$Effort = 'max'                # reasoning effort passed to every session (low|medium|high|xhigh|max)
)

$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot
$log = Join-Path $PSScriptRoot 'evolution.log'
$lastRun = Join-Path $PSScriptRoot 'evolution-last-run.txt'
$errFile = Join-Path $PSScriptRoot 'evolution-last-run.err'
$stopFile = Join-Path $PSScriptRoot 'STOP'
$pidFile = Join-Path $PSScriptRoot 'loop.pid'
$beatFile = Join-Path $PSScriptRoot 'loop.heartbeat'
$resumeFile = Join-Path $PSScriptRoot 'resume-at.txt'   # optional: local time (yyyy-MM-dd HH:mm:ss) before which the loop only sleeps

function Write-Log([string]$msg) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg" | Out-File -FilePath $log -Append -Encoding utf8
}
function Write-Beat([string]$state) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  PID $PID  $state" | Out-File -FilePath $beatFile -Encoding utf8
}

# Heavy-scope prompt. No double quotes or apostrophes inside: it is passed as one quoted argument.
$prompt = 'You are the autonomous engineering team for Wavelocal, a local-first React/Vite PWA and Capacitor Android music player. Read ROADMAP.md. Take the FIRST unchecked milestone in the HYPERCODE packs (A, then B, C, D, then any later packs) and deliver it completely as deep, production-quality engineering: multiple files, strict types where applicable, and tests where a test runner exists. Do not pick small tweaks. If every milestone in ROADMAP.md is already ticked, do not stop: perform a deep audit of the codebase (correctness, security, performance, accessibility, UX, test coverage, bundle size), append a new Pack with 3 to 5 heavy milestones to ROADMAP.md, commit that, then deliver its first milestone. Run git status first; if a previous run left unfinished work, finish or cleanly revert only that work. Keep every existing feature working and the app local-first and privacy-first. Before every push verify that npm run build exits 0 (and npm run typecheck and npm test once they exist); fix failures instead of skipping them. If a milestone is truly blocked, revert partial work, record the blocker in ROADMAP.md and move to the next milestone. After each verified milestone: tick its box, add one Changelog line, commit with a conventional message, run git pull --rebase origin main, then git push origin main. You may complete several consecutive milestones in this session as long as each one is verified and pushed. Pushing triggers the Android APK build automatically.'

# Single-instance guard: a second copy (e.g. Startup entry + manual launch) exits immediately.
$script:instanceLock = New-Object System.Threading.Mutex($false, 'Local\WavelocalEvolutionLoop')
if (-not $script:instanceLock.WaitOne(0)) { Write-Log "another loop instance is already running - PID $PID exiting"; exit 0 }

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) { $claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe' }

$script:runNo = 0
$script:totalIn = [int64]0
$script:totalOut = [int64]0

# Sleep in 30s slices so STOP is honoured and the heartbeat stays fresh.
function Wait-Interruptible([int]$seconds, [string]$state) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) {
    if (Test-Path -LiteralPath $stopFile) { return }
    Write-Beat "$state (resumes $($until.ToString('HH:mm:ss')))"
    Start-Sleep -Seconds ([math]::Min(30, [math]::Max(1, [int]($until - (Get-Date)).TotalSeconds)))
  }
}

# Scheduled pause: while resume-at.txt names a future time, do nothing (no sessions, no commits, no tokens).
# The file survives restarts and reboots; it is deleted once the time has passed.
function Wait-ForResume {
  if (-not (Test-Path -LiteralPath $resumeFile)) { return }
  $t = [datetime]::MinValue
  $txt = ([string](Get-Content -LiteralPath $resumeFile -Raw -ErrorAction SilentlyContinue)).Trim()
  if (-not [datetime]::TryParse($txt, [ref]$t)) {
    Write-Log "resume-at.txt is not a valid time ('$txt') - ignoring and removing it"
    Remove-Item -LiteralPath $resumeFile -ErrorAction SilentlyContinue
    return
  }
  if ($t -gt (Get-Date)) {
    Write-Log "paused until $($t.ToString('yyyy-MM-dd HH:mm:ss')) (resume-at.txt) - sleeping, no sessions will run"
    while ((Get-Date) -lt $t) {
      if (Test-Path -LiteralPath $stopFile) { return }
      Write-Beat "PAUSED until $($t.ToString('yyyy-MM-dd HH:mm:ss'))"
      Start-Sleep -Seconds ([math]::Min(30, [math]::Max(1, [int]($t - (Get-Date)).TotalSeconds)))
    }
  }
  Remove-Item -LiteralPath $resumeFile -ErrorAction SilentlyContinue
  Write-Log 'resume time reached - resuming the HYPERCODE loop'
}

# One headless session. Returns @{ Status; RateLimited; NewCommit }.
function Invoke-Run {
  $script:runNo++
  $n = $script:runNo
  $before = (git rev-parse --short HEAD 2>$null)
  Write-Log "run #$n start (HEAD $before)"
  Write-Beat "run #$n in progress"
  $status = 'ok'
  $rateLimited = $false
  Remove-Item $lastRun, $errFile -ErrorAction SilentlyContinue
  $started = Get-Date
  try {
    $p = Start-Process -FilePath $claude `
      -ArgumentList @('-p', "`"$prompt`"", '--dangerously-skip-permissions', '--output-format', 'json', '--effort', $Effort) `
      -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru `
      -RedirectStandardOutput $lastRun -RedirectStandardError $errFile
    $null = $p.Handle   # cache the process handle, otherwise ExitCode is $null in Windows PowerShell 5.1
    while (-not $p.WaitForExit(30000)) {
      Write-Beat "run #$n in progress ($([int]((Get-Date) - $started).TotalMinutes) min)"
      if (((Get-Date) - $started).TotalSeconds -gt $RunTimeoutSeconds) {
        $p.Kill()
        $status = "TIMEOUT after ${RunTimeoutSeconds}s (killed)"
        break
      }
    }
    if ($status -eq 'ok' -and $p.ExitCode -and $p.ExitCode -ne 0) { $status = "FAILED exit=$($p.ExitCode)" }
  } catch {
    $status = "ERROR $($_.Exception.Message)"
  }

  # Parse the JSON result so token usage / cost / turns land in the log.
  $text = ''
  # [string] cast: Get-Content -Raw returns an empty object[] (not a string) for a 0-byte file such as an empty stderr capture
  $raw = if (Test-Path $lastRun) { [string](Get-Content $lastRun -Raw -Encoding UTF8 -ErrorAction SilentlyContinue) } else { '' }
  $err = if (Test-Path $errFile) { [string](Get-Content $errFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue) } else { '' }
  try {
    $j = $raw | ConvertFrom-Json -ErrorAction Stop
    $text = [string]$j.result
    $u = $j.usage
    $in = [int64]($u.input_tokens) + [int64]($u.cache_creation_input_tokens) + [int64]($u.cache_read_input_tokens)
    $script:totalIn += $in
    $script:totalOut += [int64]($u.output_tokens)
    Write-Log ("  usage: turns=$($j.num_turns) duration=$([math]::Round($j.duration_ms / 1000))s input_tokens=$in (fresh $($u.input_tokens), cached $($u.cache_read_input_tokens)) output_tokens=$($u.output_tokens) cost_usd=$($j.total_cost_usd) (notional on a subscription) | session totals: in=$($script:totalIn) out=$($script:totalOut)")
    if ($j.is_error -and $status -eq 'ok') { $status = 'ERROR reported by claude' }
  } catch {
    $text = ($raw + ' ' + $err).Trim()
  }
  $resetAt = $null
  if ($status -ne 'ok' -and "$text $err" -match '(?i)rate.?limit|usage limit|session limit|weekly limit|quota|too many requests|429|overloaded|limit reached|hit your .{0,30}limit|resets? (at )?\d') {
    $rateLimited = $true
    # Claude says e.g. "You have hit your session limit - resets 1:30pm (Europe/Istanbul)": wait for that time, not a fixed guess.
    if ("$text $err" -match '(?i)resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)') {
      $h = [int]$Matches[1]
      $mi = if ($Matches[2]) { [int]$Matches[2] } else { 0 }
      $ap = $Matches[3].ToLower()
      if ($ap -eq 'pm' -and $h -lt 12) { $h += 12 } elseif ($ap -eq 'am' -and $h -eq 12) { $h = 0 }
      $resetAt = (Get-Date).Date.AddHours($h).AddMinutes($mi)
      if ($resetAt -le (Get-Date)) { $resetAt = $resetAt.AddDays(1) }
    }
  }

  $after = (git rev-parse --short HEAD 2>$null)
  $newCommit = ($before -ne $after)
  $commits = if ($newCommit) { "new commits $before -> $after ($(git rev-list --count "$before..$after" 2>$null) commit(s))" } else { "no new commit (HEAD $after)" }
  $rl = if ($rateLimited) { ' [RATE LIMITED]' } else { '' }
  Write-Log "run #$n $status$rl - $commits"
  $snippet = ($text -replace '\s+', ' ').Trim()
  if ($snippet.Length -gt 600) { $snippet = $snippet.Substring(0, 600) + '...' }
  if ($snippet) { Write-Log "  result: $snippet" }
  $errOne = ($err -replace '\s+', ' ').Trim()
  if ($errOne) { Write-Log "  stderr: $($errOne.Substring(0, [math]::Min(300, $errOne.Length)))" }
  return @{ Status = $status; RateLimited = $rateLimited; NewCommit = $newCommit; ResetAt = $resetAt }
}

try {
  Set-Content -Path $pidFile -Value $PID -Encoding ascii
  Write-Log "HYPERCODE loop started (PID $PID), pause ${PauseSeconds}s, rate-limit retry ${RateLimitRetrySeconds}s, claude=$claude"
  $fails = 0
  $noCommit = 0

  while ($true) {
    if (Test-Path -LiteralPath $stopFile) { Write-Log 'STOP file found - loop exiting'; break }
    Wait-ForResume
    if (Test-Path -LiteralPath $stopFile) { Write-Log 'STOP file found - loop exiting'; break }
    try {
      $r = Invoke-Run

      if ($r.RateLimited) {
        $fails = 0; $noCommit = 0
        # Known reset time: sleep until then (+90s margin, clamped to 1 min .. 6 h). Unknown: poll every ~17 min.
        $wait = $RateLimitRetrySeconds
        $why = 'reset time unknown'
        if ($r.ResetAt) {
          $wait = [math]::Min(21600, [math]::Max(60, [int]($r.ResetAt - (Get-Date)).TotalSeconds + 90))
          $why = "resets $($r.ResetAt.ToString('HH:mm'))"
        }
        Write-Log "quota exhausted ($why) - waiting $([int]($wait / 60)) min, then resuming immediately"
        Wait-Interruptible $wait 'rate limited, waiting for quota reset'
      } elseif ($r.Status -ne 'ok') {
        $noCommit = 0
        $fails++
        if ($fails -ge $MaxConsecutiveFailures) {
          Write-Log "circuit breaker: $fails failed runs in a row - backing off $([int]($StuckBackoffSeconds / 60)) min"
          $fails = 0
          Wait-Interruptible $StuckBackoffSeconds 'circuit breaker backoff (failures)'
        } else {
          Wait-Interruptible $FailurePauseSeconds 'pause after failed run'
        }
      } elseif (-not $r.NewCommit) {
        $fails = 0
        $noCommit++
        if ($noCommit -ge $MaxNoCommitRuns) {
          Write-Log "circuit breaker: $noCommit runs in a row pushed nothing (blocked or nothing to do) - backing off $([int]($StuckBackoffSeconds / 60)) min"
          $noCommit = 0
          Wait-Interruptible $StuckBackoffSeconds 'circuit breaker backoff (no progress)'
        } else {
          Wait-Interruptible $PauseSeconds 'breather'
        }
      } else {
        $fails = 0; $noCommit = 0
        Wait-Interruptible $PauseSeconds 'breather'
      }
    } catch {
      # Supervisor self-healing: never let an unexpected error kill the loop.
      Write-Log "loop error (continuing): $($_.Exception.Message)"
      Wait-Interruptible $FailurePauseSeconds 'recovering from loop error'
    }
  }
} finally {
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  Write-Beat 'stopped'
  Write-Log "loop stopped (PID $PID)"
}
