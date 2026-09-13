<#
.SYNOPSIS
  Pulls the latest committed server code onto the running EC2 instance.

.DESCRIPTION
  Sends a git pull + npm ci + systemctl restart over SSM Session Manager. No SSH
  key and no open port 22 required.

  The server holds all match state in memory, so restarting ends every live
  match. This script refuses to run while rooms are active unless -Force is set.

.EXAMPLE
  .\infra\redeploy.ps1
  .\infra\redeploy.ps1 -Force
#>
param(
  [string]$Region = "us-east-1",
  [string]$ProjectTag = "bloom",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$instanceId = & aws ec2 describe-instances `
  --filters "Name=tag:Project,Values=$ProjectTag" "Name=instance-state-name,Values=running" `
  --query "Reservations[0].Instances[0].InstanceId" --region $Region --output text
if ($LASTEXITCODE -ne 0) { throw "Could not query EC2 instances." }
$instanceId = ($instanceId | Out-String).Trim()
if ($instanceId -eq "" -or $instanceId -eq "None") { throw "No running instance tagged Project=$ProjectTag." }

$publicIp = & aws ec2 describe-instances --instance-ids $instanceId `
  --query "Reservations[0].Instances[0].PublicIpAddress" --region $Region --output text
$publicIp = ($publicIp | Out-String).Trim()
$hostname = "$($publicIp -replace '\.', '-').nip.io"

if (-not $Force) {
  try {
    $health = Invoke-RestMethod -Uri "https://$hostname/health" -TimeoutSec 10
    if ($health.rooms -gt 0) {
      throw "$($health.rooms) room(s) are active. Restarting ends those matches. Re-run with -Force to proceed."
    }
  } catch [System.Net.WebException] {
    Write-Host "Health check unreachable; continuing anyway." -ForegroundColor Yellow
  }
}

Write-Host "Redeploying to $instanceId..." -ForegroundColor Cyan
$commandId = & aws ssm send-command `
  --instance-ids $instanceId `
  --document-name AWS-RunShellScript `
  --parameters 'commands=["set -e","cd /opt/bloom","git -c safe.directory=/opt/bloom fetch --depth 1 origin master","git -c safe.directory=/opt/bloom reset --hard origin/master","npm ci --omit=dev","chown -R bloom:bloom /opt/bloom","systemctl restart bloom","sleep 2","systemctl is-active bloom"]' `
  --query "Command.CommandId" --region $Region --output text
if ($LASTEXITCODE -ne 0) { throw "Could not send the SSM command. Is the SSM agent registered?" }
$commandId = ($commandId | Out-String).Trim()

Write-Host "Command $commandId dispatched. Waiting..."
do {
  Start-Sleep -Seconds 3
  $status = & aws ssm get-command-invocation --command-id $commandId --instance-id $instanceId --query "Status" --region $Region --output text
  $status = ($status | Out-String).Trim()
} while ($status -eq "Pending" -or $status -eq "InProgress")

$result = & aws ssm get-command-invocation --command-id $commandId --instance-id $instanceId --region $Region --output json | ConvertFrom-Json
Write-Host $result.StandardOutputContent
if ($status -ne "Success") {
  Write-Host $result.StandardErrorContent -ForegroundColor Red
  throw "Redeploy failed with status $status."
}

Write-Host "Redeploy complete. Health: https://$hostname/health" -ForegroundColor Green
