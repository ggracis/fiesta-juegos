# Plan B (Windows notebook): copy the newest EC2 backup to app\data\fiesta.db, then print how to start the server.
# Usage: .\restore-latest.ps1 -Ec2 ubuntu@3.12.34.56 -Key C:\keys\fiesta.pem   (needs the OpenSSH client: ssh/scp)
param([Parameter(Mandatory)][string]$Ec2, [Parameter(Mandatory)][string]$Key)
$ErrorActionPreference = 'Stop'
$app = Split-Path $PSScriptRoot -Parent
$db = Join-Path $app 'data\fiesta.db'
# ponytail: backup names are timestamped, so lexical order == age
$latest = (ssh -i $Key $Ec2 'ls -1 /opt/fiesta/backups/fiesta-*.db | sort | tail -n 1').Trim()
New-Item -ItemType Directory -Force (Split-Path $db) | Out-Null
$stamp = Get-Date -Format yyyyMMddTHHmmss
foreach ($x in '', '-wal', '-shm') { if (Test-Path "$db$x") { Move-Item "$db$x" "$db$x.$stamp.bak" } }
scp -i $Key "${Ec2}:$latest" $db
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' } | Select-Object -First 1).IPAddress
Write-Host "Restored $latest -> $db"
Write-Host '$env:PORT=3000; $env:ADMIN_PASSWORD="..."; $env:PANEL_TOKEN="..."; npm --prefix app start   # run from the repo root'
Write-Host "Panels: http://${ip}:3000/play.html?api=http://${ip}:3000/&token=<PANEL_TOKEN>"
