#requires -Version 5.1
<#
accessNG Console - local issue tracker + one-click deploy for the UberReaderWebInterface repo.

Serves http://localhost:<Port>/ with two tabs:
  Tracker - issues, subtasks, private comments and deadlines, stored in data\tracker.json
  Deploy  - cuts release/test/<today> from structure_update and deploys accesstest, or promotes
            the tested candidate to release/ng/<today> and deploys accessNG

Deploys shell out to the repo's own .claude\skills\deploy-accessng\deploy-accessng.ps1, so the
FTPS credentials never leave that repo. Branch work uses refspec pushes only - the repo's working
tree is never checked out, so this is safe to run while you have unrelated work in progress.
#>

[CmdletBinding()]
param(
    [int]$Port,
    [string]$RepoRoot,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$root       = $PSScriptRoot
$publicDir  = Join-Path $root 'public'
$dataDir    = Join-Path $root 'data'
$logDir     = Join-Path $root 'logs'
$configPath = Join-Path $root 'config.json'
$localCfg   = Join-Path $root 'config.local.json'

$config = @{ port = 8790; repoRoot = 'C:\Users\Lenovo\UberReaderWebInterface' }
foreach ($p in @($configPath, $localCfg)) {
    if (Test-Path $p) {
        $c = Get-Content $p -Raw | ConvertFrom-Json
        foreach ($k in $c.PSObject.Properties.Name) { $config[$k] = $c.$k }
    }
}
if ($Port)     { $config.port = $Port }
if ($RepoRoot) { $config.repoRoot = $RepoRoot }

$repoRoot     = $config.repoRoot
$deployScript = Join-Path $repoRoot '.claude\skills\deploy-accessng\deploy-accessng.ps1'
$trackerPath  = Join-Path $dataDir 'tracker.json'
$historyPath  = Join-Path $dataDir 'history.jsonl'
$origin       = "http://localhost:$($config.port)"

# Injected into the page and required on every /api/ call: a page served from here can read it,
# a site in another tab cannot, so no other origin can drive a deploy.
$token = [guid]::NewGuid().ToString('N')

foreach ($d in @($dataDir, $logDir, (Join-Path $dataDir 'backups'))) {
    New-Item -ItemType Directory -Path $d -Force | Out-Null
}

$script:Job   = @{ running = $false; env = $null; branch = $null; source = $null; sha = $null
                   startedAt = $null; endedAt = $null; exitCode = $null; log = $null; proc = $null }
$script:Cache = @{ state = $null; at = [DateTime]::MinValue }

$US = [string][char]0x1f

# ---------------------------------------------------------------- git

function Invoke-Git {
    param([string[]]$GitArgs)
    if (-not (Test-Path $repoRoot)) { return [pscustomobject]@{ Ok = $false; Out = @("repo not found: $repoRoot") } }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & git -C $repoRoot @GitArgs 2>&1 | ForEach-Object { $_.ToString() }
        [pscustomobject]@{ Ok = ($LASTEXITCODE -eq 0); Out = @($out) }
    } finally { $ErrorActionPreference = $prev }
}

function Get-GitText {
    param([string[]]$GitArgs)
    $r = Invoke-Git $GitArgs
    if (-not $r.Ok) { return $null }
    ($r.Out -join "`n").Trim()
}

function Get-Commit([string]$rev) {
    $line = Get-GitText @('log', '-1', '--format=%H%x1f%h%x1f%s%x1f%cI', $rev)
    if (-not $line) { return $null }
    $p = $line -split $US
    @{ sha = $p[0]; short = $p[1]; subject = $p[2]; date = $p[3] }
}

function Get-RemoteReleases {
    $r = Invoke-Git @('ls-remote', '--heads', 'origin', 'refs/heads/release/*')
    if (-not $r.Ok) { return @{ test = @(); ng = @() } }
    $test = @(); $ng = @()
    foreach ($line in $r.Out) {
        if ($line -notmatch '^([0-9a-f]{40})\s+refs/heads/(release/(test|ng)/(.+))$') { continue }
        $entry = @{ name = $Matches[2]; sha = $Matches[1]; label = $Matches[4] }
        if ($Matches[3] -eq 'test') { $test += $entry } else { $ng += $entry }
    }
    @{ test = @($test | Sort-Object { $_.label } -Descending)
       ng   = @($ng   | Sort-Object { $_.label } -Descending) }
}

function Get-CommitsBetween([string]$from, [string]$to) {
    if (-not $from) { return @() }
    $r = Invoke-Git @('log', '--format=%h%x1f%s', "$from..$to")
    if (-not $r.Ok) { return @() }
    @($r.Out | Where-Object { $_ } | ForEach-Object {
        $p = $_ -split $US
        @{ short = $p[0]; subject = $p[1] }
    })
}

function Resolve-NgBranchName([string]$today, [string]$sha, $ngRefs) {
    foreach ($suffix in @('', 'b', 'c', 'd', 'e')) {
        $name = "release/ng/$today$suffix"
        $hit = $ngRefs | Where-Object { $_.name -eq $name } | Select-Object -First 1
        if (-not $hit) { return $name }
        if ($hit.sha -eq $sha) { return $name }
    }
    "release/ng/$today-x"
}

# ---------------------------------------------------------------- deploy state

function Get-JobState {
    $j = $script:Job
    if ($j.running -and $j.proc -and $j.proc.HasExited) {
        $j.running = $false
        $j.endedAt = (Get-Date).ToString('o')
        $exitFile = "$($j.log).exit"
        if (Test-Path -LiteralPath $exitFile) {
            $j.exitCode = [int]((Get-Content -LiteralPath $exitFile -Raw).Trim())
        } else {
            try { $j.exitCode = [int]$j.proc.ExitCode } catch { $j.exitCode = 1 }
        }
        $errPath = "$($j.log).err"
        if ((Test-Path -LiteralPath $errPath) -and (Get-Item -LiteralPath $errPath).Length -gt 0) {
            Add-Content -Path $j.log -Encoding UTF8 -Value ("`n=== stderr ===`n" + (Get-Content -LiteralPath $errPath -Raw))
        }
        $secs = [int]((Get-Date) - [datetime]$j.startedAt).TotalSeconds
        Add-History @{ kind = 'deploy'; action = $(if ($j.exitCode -eq 0) { 'finished' } else { 'failed' })
                       env = $j.env; branch = $j.branch; sha = $j.sha; exitCode = $j.exitCode
                       seconds = $secs; log = (Split-Path $j.log -Leaf) }
        $script:Cache.at = [DateTime]::MinValue
    }
    @{ running = $j.running; env = $j.env; branch = $j.branch; source = $j.source
       startedAt = $j.startedAt; endedAt = $j.endedAt; exitCode = $j.exitCode; hasLog = [bool]$j.log }
}

function Get-DeployState([switch]$Refresh) {
    if (-not $Refresh -and $script:Cache.state -and ((Get-Date) - $script:Cache.at).TotalSeconds -lt 25) {
        $s = $script:Cache.state
        $s.job = Get-JobState
        return $s
    }

    if (-not (Test-Path $deployScript)) {
        $s = @{ ok = $false; error = "deploy-accessng.ps1 not found under $repoRoot"; repo = $repoRoot
                plans = @{ accesstest = @{ ready = $false; reason = 'repo not reachable' }
                           accessNG   = @{ ready = $false; reason = 'repo not reachable' } } }
        $s.job = Get-JobState
        return $s
    }

    Invoke-Git @('fetch', 'origin', '--prune') | Out-Null

    $today    = Get-Date -Format 'yyyy-MM-dd'
    $master   = Get-Commit 'origin/structure_update'
    $releases = Get-RemoteReleases
    $lastTest = $releases.test | Select-Object -First 1
    $lastNg   = $releases.ng   | Select-Object -First 1

    $testPlan = @{ branch = "release/test/$today"; source = 'origin/structure_update'
                   sha = $master.sha; short = $master.short; ready = $true; reason = $null
                   action = 'create'; changes = @() }
    $todayTest = $releases.test | Where-Object { $_.name -eq "release/test/$today" } | Select-Object -First 1
    if ($todayTest) {
        if ($todayTest.sha -eq $master.sha) { $testPlan.action = 'redeploy' } else { $testPlan.action = 'update' }
    }
    if ($lastTest) { $testPlan.changes = Get-CommitsBetween $lastTest.sha 'origin/structure_update' }

    $ngPlan = @{ ready = $false; reason = 'No release/test candidate exists yet.'; branch = $null
                 source = $null; sha = $null; short = $null; changes = @(); alreadyLive = $false
                 staleCandidate = $false }
    if ($lastTest) {
        $ngPlan.branch = Resolve-NgBranchName $today $lastTest.sha $releases.ng
        $ngPlan.source = $lastTest.name
        $ngPlan.sha    = $lastTest.sha
        $ngPlan.short  = $lastTest.sha.Substring(0, 7)
        $ngPlan.ready  = $true
        $ngPlan.reason = $null
        $ngPlan.staleCandidate = ($lastTest.sha -ne $master.sha)
        if ($lastNg -and $lastNg.sha -eq $lastTest.sha) { $ngPlan.alreadyLive = $true }
        if ($lastNg) { $ngPlan.changes = Get-CommitsBetween $lastNg.sha $lastTest.sha }
    }

    $state = @{
        ok = $true; repo = $repoRoot; fetchedAt = (Get-Date).ToString('o'); master = $master
        test = $(if ($lastTest) { @{ name = $lastTest.name; short = $lastTest.sha.Substring(0,7)
                                     sha = $lastTest.sha; current = ($lastTest.sha -eq $master.sha) } } else { $null })
        prod = $(if ($lastNg)   { @{ name = $lastNg.name; short = $lastNg.sha.Substring(0,7)
                                     sha = $lastNg.sha; current = ($lastNg.sha -eq $master.sha) } } else { $null })
        plans = @{ accesstest = $testPlan; accessNG = $ngPlan }
    }
    $script:Cache.state = $state
    $script:Cache.at    = Get-Date
    $state.job = Get-JobState
    $state
}

$runTemplate = @'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$ErrorActionPreference = 'Continue'
$env:GIT_TERMINAL_PROMPT = '0'

$repo     = '@@REPO@@'
$deploy   = '@@DEPLOY@@'
$branch   = '@@BRANCH@@'
$source   = '@@SOURCE@@'
$remote   = '@@REMOTE@@'
$expect   = '@@EXPECT@@'
$exitFile = '@@EXITFILE@@'
$isProd   = @@ISPROD@@

function G {
    param([string[]]$a)
    $out = & git -C $repo @a 2>&1 | ForEach-Object { $_.ToString() }
    foreach ($l in $out) { if ($l) { Write-Host "  $l" } }
    if ($LASTEXITCODE -ne 0) { throw "git $($a -join ' ') failed with exit code $LASTEXITCODE" }
    return $out
}

$code = 1
try {
    Write-Host "=== Prepare $branch (from $source) ==="
    G @('fetch','origin','--prune') | Out-Null

    $sha = ((G @('rev-parse',$source)) | Select-Object -Last 1).Trim()
    if ($sha -ne $expect) {
        throw "$source moved to $sha since the console last refreshed (expected $expect). Refresh and review the change list before deploying."
    }

    if ($isProd) {
        $ex = & git -C $repo ls-remote --heads origin "refs/heads/$branch"
        if ($ex) {
            $exSha = (($ex -join "`n") -split "\s+")[0].Trim()
            if ($exSha -ne $sha) {
                throw "$branch already exists at $exSha. A release/ng branch is the record of what production ran and must never be moved."
            }
        }
    }

    G @('push','origin',"$sha`:refs/heads/$branch") | Out-Null
    Write-Host "  $branch -> $sha"

    & $deploy -Branch $branch -RemotePath $remote

    Write-Host ""
    Write-Host "=== CONSOLE OK: $branch deployed to $remote ==="
    $code = 0
} catch {
    Write-Host ""
    Write-Host "=== CONSOLE FAILED: $($_.Exception.Message) ==="
    $code = 1
}
Set-Content -LiteralPath $exitFile -Value $code -Encoding ASCII
exit $code
'@

function Start-Deploy([string]$targetEnv) {
    if ($script:Job.running) { throw 'A deploy is already running.' }

    $state = Get-DeployState
    $plan  = $state.plans[$targetEnv]
    if (-not $plan.ready) { throw $plan.reason }

    $stamp  = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
    $log    = Join-Path $logDir "$targetEnv-$stamp.log"
    $runPs1 = Join-Path $logDir "$targetEnv-$stamp.run.ps1"

    $body = $runTemplate.
        Replace('@@REPO@@',     $repoRoot).
        Replace('@@DEPLOY@@',   $deployScript).
        Replace('@@BRANCH@@',   $plan.branch).
        Replace('@@SOURCE@@',   $plan.source).
        Replace('@@REMOTE@@',   $targetEnv).
        Replace('@@EXPECT@@',   $plan.sha).
        Replace('@@EXITFILE@@', "$log.exit").
        Replace('@@ISPROD@@',   $(if ($targetEnv -eq 'accessNG') { '$true' } else { '$false' }))
    Set-Content -Path $runPs1 -Value $body -Encoding UTF8

    $proc = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$runPs1`"") `
        -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err"

    $script:Job = @{ running = $true; env = $targetEnv; branch = $plan.branch; source = $plan.source
                     sha = $plan.sha; startedAt = (Get-Date).ToString('o'); endedAt = $null
                     exitCode = $null; log = $log; proc = $proc }
    Add-History @{ kind = 'deploy'; action = 'started'; env = $targetEnv; branch = $plan.branch
                   source = $plan.source; sha = $plan.sha
                   commits = @($plan.changes | ForEach-Object { "$($_.short) $($_.subject)" }) }
    @{ ok = $true; branch = $plan.branch; log = (Split-Path $log -Leaf) }
}

function Read-LogFrom([long]$from) {
    $path = $script:Job.log
    if (-not $path -or -not (Test-Path -LiteralPath $path)) { return @{ offset = 0; text = '' } }
    $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        if ($from -gt $fs.Length) { $from = 0 }
        $len = $fs.Length - $from
        if ($len -le 0) { return @{ offset = $from; text = '' } }
        [void]$fs.Seek($from, [System.IO.SeekOrigin]::Begin)
        $buf  = New-Object byte[] $len
        $read = $fs.Read($buf, 0, $buf.Length)
        $text = [Text.Encoding]::UTF8.GetString($buf, 0, $read)
        $cut  = $text.LastIndexOf("`n")
        if ($cut -lt 0) {
            if ($script:Job.running) { return @{ offset = $from; text = '' } }
            return @{ offset = $from + $read; text = $text }
        }
        $keep = $text.Substring(0, $cut + 1)
        @{ offset = $from + [Text.Encoding]::UTF8.GetByteCount($keep); text = $keep }
    } finally { $fs.Dispose() }
}

# ---------------------------------------------------------------- tracker store

function Read-Tracker {
    if (-not (Test-Path $trackerPath)) { return '{"version":1,"issues":[]}' }
    [System.IO.File]::ReadAllText($trackerPath, [Text.Encoding]::UTF8)
}

function Add-History($entry) {
    if (-not $entry.at) {
        if ($entry -is [hashtable]) { $entry.at = (Get-Date).ToString('o') }
        else { $entry | Add-Member -NotePropertyName at -NotePropertyValue ((Get-Date).ToString('o')) -Force }
    }
    $line = ($entry | ConvertTo-Json -Depth 8 -Compress)
    [System.IO.File]::AppendAllText($historyPath, $line + "`n", (New-Object Text.UTF8Encoding($false)))
}

function Read-History([int]$limit) {
    if (-not (Test-Path $historyPath)) { return @() }
    $lines = @(Get-Content -LiteralPath $historyPath -Encoding UTF8 | Where-Object { $_.Trim() })
    if ($limit -gt 0 -and $lines.Count -gt $limit) { $lines = $lines[($lines.Count - $limit)..($lines.Count - 1)] }
    [array]::Reverse($lines)
    @($lines | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} })
}

function Write-Tracker([string]$json) {
    $null = $json | ConvertFrom-Json
    if (Test-Path $trackerPath) {
        $stamp  = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
        $bakDir = Join-Path $dataDir 'backups'
        Copy-Item $trackerPath (Join-Path $bakDir "tracker-$stamp.json") -Force
        Get-ChildItem $bakDir -Filter 'tracker-*.json' | Sort-Object LastWriteTime -Descending |
            Select-Object -Skip 40 | Remove-Item -Force -ErrorAction SilentlyContinue
    }
    $tmp = "$trackerPath.tmp"
    [System.IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item $tmp $trackerPath -Force
}

# ---------------------------------------------------------------- http

$mime = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
           '.css'  = 'text/css; charset=utf-8';  '.json' = 'application/json; charset=utf-8'
           '.svg'  = 'image/svg+xml'; '.ico' = 'image/x-icon' }

function Send-Bytes($ctx, [int]$status, [string]$type, [byte[]]$bytes) {
    $ctx.Response.StatusCode  = $status
    $ctx.Response.ContentType = $type
    $ctx.Response.Headers['Cache-Control'] = 'no-store'
    $ctx.Response.ContentLength64 = $bytes.Length
    if ($bytes.Length) { $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length) }
    $ctx.Response.OutputStream.Close()
}
function Send-Text($ctx, [int]$status, [string]$type, [string]$text) {
    Send-Bytes $ctx $status $type ([Text.Encoding]::UTF8.GetBytes($text))
}
function Send-Json($ctx, $obj, [int]$status = 200) {
    Send-Text $ctx $status 'application/json; charset=utf-8' ($obj | ConvertTo-Json -Depth 12 -Compress)
}
function Read-Body($ctx) {
    $sr = New-Object System.IO.StreamReader($ctx.Request.InputStream, [Text.Encoding]::UTF8)
    try { $sr.ReadToEnd() } finally { $sr.Dispose() }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("$origin/")
$listener.Start()

Write-Host ''
Write-Host '  accessNG Console' -ForegroundColor Cyan
Write-Host "  repo : $repoRoot"
Write-Host "  data : $trackerPath"
Write-Host "  open : $origin/" -ForegroundColor Green
Write-Host '  close this window to stop the console'
Write-Host ''

if (-not $NoBrowser) { Start-Process "$origin/" | Out-Null }

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        try {
            $req  = $ctx.Request
            $path = $req.Url.AbsolutePath
            if ($path.Length -gt 1) { $path = $path.TrimEnd('/') }

            $hostHdr = $req.Headers['Host']
            if ($hostHdr -and $hostHdr -notmatch "^localhost(:$($config.port))?$") { Send-Text $ctx 403 'text/plain' 'forbidden'; continue }
            $orig = $req.Headers['Origin']
            if ($orig -and $orig -ne $origin) { Send-Text $ctx 403 'text/plain' 'forbidden'; continue }

            if ($path -eq '/') {
                $html = (Get-Content (Join-Path $publicDir 'index.html') -Raw -Encoding UTF8).Replace('{{TOKEN}}', $token)
                Send-Text $ctx 200 'text/html; charset=utf-8' $html
                continue
            }

            if ($path -notlike '/api/*') {
                $rel  = $path.TrimStart('/') -replace '/', '\'
                $file = Join-Path $publicDir $rel
                $full = [System.IO.Path]::GetFullPath($file)
                if (-not $full.StartsWith([System.IO.Path]::GetFullPath($publicDir))) { Send-Text $ctx 403 'text/plain' 'forbidden'; continue }
                if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { Send-Text $ctx 404 'text/plain' 'not found'; continue }
                $ext = [System.IO.Path]::GetExtension($full).ToLower()
                $ct  = $mime[$ext]
                if (-not $ct) { $ct = 'application/octet-stream' }
                Send-Bytes $ctx 200 $ct ([System.IO.File]::ReadAllBytes($full))
                continue
            }

            if ($req.QueryString['t'] -ne $token) { Send-Json $ctx @{ ok = $false; error = 'bad token' } 403; continue }

            switch ($path) {
                '/api/tracker' {
                    if ($req.HttpMethod -eq 'GET') {
                        Send-Text $ctx 200 'application/json; charset=utf-8' (Read-Tracker)
                    } else {
                        try   { Write-Tracker (Read-Body $ctx); Send-Json $ctx @{ ok = $true } }
                        catch { Send-Json $ctx @{ ok = $false; error = $_.Exception.Message } 400 }
                    }
                }
                '/api/history' {
                    if ($req.HttpMethod -eq 'GET') {
                        [int]$limit = 500
                        [void][int]::TryParse([string]$req.QueryString['limit'], [ref]$limit)
                        Send-Json $ctx @{ ok = $true; entries = @(Read-History $limit) }
                    } else {
                        try {
                            $parsed = (Read-Body $ctx) | ConvertFrom-Json
                            foreach ($e in @($parsed)) { Add-History $e }
                            Send-Json $ctx @{ ok = $true }
                        } catch { Send-Json $ctx @{ ok = $false; error = $_.Exception.Message } 400 }
                    }
                }
                '/api/state' {
                    Send-Json $ctx (Get-DeployState -Refresh:($req.QueryString['refresh'] -eq '1'))
                }
                '/api/log' {
                    [long]$from = 0
                    [void][long]::TryParse([string]$req.QueryString['from'], [ref]$from)
                    $chunk = Read-LogFrom $from
                    Send-Json $ctx @{ ok = $true; offset = $chunk.offset; text = $chunk.text; job = (Get-JobState) }
                }
                '/api/deploy' {
                    $targetEnv = $req.QueryString['env']
                    if ($targetEnv -ne 'accesstest' -and $targetEnv -ne 'accessNG') {
                        Send-Json $ctx @{ ok = $false; error = 'unknown environment' } 400
                    } else {
                        try   { Send-Json $ctx (Start-Deploy $targetEnv) }
                        catch { Send-Json $ctx @{ ok = $false; error = $_.Exception.Message } 409 }
                    }
                }
                default { Send-Json $ctx @{ ok = $false; error = 'not found' } 404 }
            }
        } catch {
            try { Send-Text $ctx 500 'text/plain' $_.Exception.Message } catch {}
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
