# Runs the dashboard and keeps it on the latest main.
# Every $PollSeconds, fetches origin/main; if there are new commits it pulls,
# npm installs when package.json/package-lock.json changed, and restarts node.
# Also restarts node automatically if the process dies on its own.
#
# Usage: leave this running in the console window instead of `node server.js` / `npm start`.
#   powershell -File watch-and-run.ps1
#   powershell -File watch-and-run.ps1 -PollSeconds 60 -Branch main

param(
    [int]$PollSeconds = 300,
    [string]$Branch = "main"
)

$repoRoot = $PSScriptRoot
Set-Location $repoRoot

$nodeProcess = $null

function Start-Server {
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting node server.js..."
    return Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $repoRoot -NoNewWindow -PassThru
}

function Stop-Server($proc) {
    if ($proc -and -not $proc.HasExited) {
        Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Stopping node process (PID $($proc.Id))..."
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        $proc.WaitForExit(10000) | Out-Null
    }
}

$nodeProcess = Start-Server

while ($true) {
    Start-Sleep -Seconds $PollSeconds

    git fetch origin $Branch 2>&1 | Out-Null
    $localHead = git rev-parse HEAD
    $remoteHead = git rev-parse "origin/$Branch"

    if ($localHead -ne $remoteHead) {
        Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] New commits on origin/$Branch, updating..."

        $changedFiles = git diff --name-only $localHead $remoteHead

        git pull origin $Branch

        if ($changedFiles -match 'package(-lock)?\.json') {
            Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] package.json changed, running npm install..."
            npm install
        }

        Stop-Server $nodeProcess
        $nodeProcess = Start-Server
    }
    elseif ($nodeProcess.HasExited) {
        Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] node process exited unexpectedly, restarting..."
        $nodeProcess = Start-Server
    }
}
