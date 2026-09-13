<#
.SYNOPSIS
  Provisions the Bloom game server on a single AWS EC2 instance.

.DESCRIPTION
  Creates (or reuses) a security group, an SSM instance profile, an Elastic IP,
  and one EC2 instance running Amazon Linux 2023. The instance bootstraps itself
  from infra/user-data.sh: Node 22, the game server under systemd, and Caddy
  terminating TLS on a nip.io hostname derived from the Elastic IP.

  Safe to re-run. Resources are tagged Project=<ProjectTag> and reused when found.

.EXAMPLE
  .\infra\deploy-ec2.ps1
  .\infra\deploy-ec2.ps1 -HostnameSuffix sslip.io   # if nip.io hits a Let's Encrypt rate limit
  .\infra\deploy-ec2.ps1 -Recreate                  # replace the instance from scratch
#>
param(
  [string]$Region = "us-east-1",
  [string]$InstanceType = "t3.micro",
  [ValidateSet("nip.io", "sslip.io")]
  [string]$HostnameSuffix = "nip.io",
  [string]$ProjectTag = "bloom",
  [string]$RepoUrl = "https://github.com/GameDevRocky/bloom-wars.git",
  [switch]$Recreate
)

$ErrorActionPreference = "Stop"
$securityGroupName = "$ProjectTag-sg"
$roleName = "$ProjectTag-ssm-role"
$instanceProfileName = "$ProjectTag-ssm-profile"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-Aws {
  param([string[]]$Arguments, [string]$ErrorMessage)
  $output = & aws @Arguments --region $Region --output json
  if ($LASTEXITCODE -ne 0) { throw $ErrorMessage }
  if ([string]::IsNullOrWhiteSpace($output)) { return $null }
  return $output | ConvertFrom-Json
}

function Get-AwsText {
  param([string[]]$Arguments)
  $value = & aws @Arguments --region $Region --output text
  if ($LASTEXITCODE -ne 0) { return $null }
  $value = ($value | Out-String).Trim()
  if ($value -eq "" -or $value -eq "None") { return $null }
  return $value
}

function Test-AwsSucceeds {
  param([string[]]$Arguments)
  & aws @Arguments --region $Region --output json | Out-Null
  return ($LASTEXITCODE -eq 0)
}

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  throw "AWS CLI v2 is required. Install it and run 'aws configure'."
}

$identity = Invoke-Aws @("sts", "get-caller-identity") "AWS credentials are not configured. Run 'aws configure'."
Write-Host "Deploying Bloom to account $($identity.Account) in $Region" -ForegroundColor Cyan

# --- Network -----------------------------------------------------------------
$vpcId = Get-AwsText @("ec2", "describe-vpcs", "--filters", "Name=isDefault,Values=true", "--query", "Vpcs[0].VpcId")
if (-not $vpcId) { throw "No default VPC found in $Region. Create one, or supply a VPC and subnet manually." }

$subnetId = Get-AwsText @("ec2", "describe-subnets", "--filters", "Name=vpc-id,Values=$vpcId", "--query", "Subnets[0].SubnetId")
if (-not $subnetId) { throw "No subnet found in VPC $vpcId." }
Write-Host "Using VPC $vpcId, subnet $subnetId"

# --- Security group ----------------------------------------------------------
$securityGroupId = Get-AwsText @("ec2", "describe-security-groups", "--filters", "Name=group-name,Values=$securityGroupName", "Name=vpc-id,Values=$vpcId", "--query", "SecurityGroups[0].GroupId")
if (-not $securityGroupId) {
  $securityGroupId = Get-AwsText @("ec2", "create-security-group", "--group-name", $securityGroupName, "--description", "Bloom game server: HTTP and HTTPS only", "--vpc-id", $vpcId, "--query", "GroupId")
  if (-not $securityGroupId) { throw "Could not create security group $securityGroupName." }
  # Port 22 is deliberately absent: administration goes through SSM Session Manager.
  foreach ($port in 80, 443) {
    & aws ec2 authorize-security-group-ingress --group-id $securityGroupId --protocol tcp --port $port --cidr 0.0.0.0/0 --region $Region | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not open port $port on $securityGroupName." }
  }
  Write-Host "Created security group $securityGroupId (80, 443 inbound)" -ForegroundColor Green
} else {
  Write-Host "Reusing security group $securityGroupId"
}

# --- SSM instance profile ----------------------------------------------------
if (-not (Test-AwsSucceeds @("iam", "get-role", "--role-name", $roleName))) {
  $trustPolicyPath = Join-Path ([System.IO.Path]::GetTempPath()) "bloom-trust-policy.json"
  $trustPolicy = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
  [System.IO.File]::WriteAllText($trustPolicyPath, $trustPolicy)
  & aws iam create-role --role-name $roleName --assume-role-policy-document "file://$trustPolicyPath" --region $Region | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not create IAM role $roleName." }
  & aws iam attach-role-policy --role-name $roleName --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore --region $Region | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not attach AmazonSSMManagedInstanceCore to $roleName." }
  Write-Host "Created IAM role $roleName" -ForegroundColor Green
} else {
  Write-Host "Reusing IAM role $roleName"
}

if (-not (Test-AwsSucceeds @("iam", "get-instance-profile", "--instance-profile-name", $instanceProfileName))) {
  & aws iam create-instance-profile --instance-profile-name $instanceProfileName --region $Region | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not create instance profile $instanceProfileName." }
  & aws iam add-role-to-instance-profile --instance-profile-name $instanceProfileName --role-name $roleName --region $Region | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not add $roleName to $instanceProfileName." }
  Write-Host "Created instance profile $instanceProfileName" -ForegroundColor Green
} else {
  Write-Host "Reusing instance profile $instanceProfileName"
}

# --- Elastic IP --------------------------------------------------------------
# Allocated before the instance so the hostname can be baked into user-data.
$addressJson = Invoke-Aws @("ec2", "describe-addresses", "--filters", "Name=tag:Project,Values=$ProjectTag", "--query", "Addresses[0]") "Could not query Elastic IPs."
if ($addressJson) {
  $publicIp = $addressJson.PublicIp
  $allocationId = $addressJson.AllocationId
  Write-Host "Reusing Elastic IP $publicIp"
} else {
  $allocated = Invoke-Aws @("ec2", "allocate-address", "--domain", "vpc", "--tag-specifications", "ResourceType=elastic-ip,Tags=[{Key=Project,Value=$ProjectTag}]") "Could not allocate an Elastic IP."
  $publicIp = $allocated.PublicIp
  $allocationId = $allocated.AllocationId
  Write-Host "Allocated Elastic IP $publicIp" -ForegroundColor Green
}

$hostname = "$($publicIp -replace '\.', '-').$HostnameSuffix"
Write-Host "Server hostname will be $hostname" -ForegroundColor Cyan

# --- Existing instance -------------------------------------------------------
$instanceId = Get-AwsText @("ec2", "describe-instances", "--filters", "Name=tag:Project,Values=$ProjectTag", "Name=instance-state-name,Values=pending,running,stopping,stopped", "--query", "Reservations[0].Instances[0].InstanceId")

if ($instanceId -and $Recreate) {
  Write-Host "Terminating existing instance $instanceId" -ForegroundColor Yellow
  & aws ec2 terminate-instances --instance-ids $instanceId --region $Region | Out-Null
  & aws ec2 wait instance-terminated --instance-ids $instanceId --region $Region
  $instanceId = $null
}

if ($instanceId) {
  Write-Host "Instance $instanceId already exists. Re-run with -Recreate to rebuild it." -ForegroundColor Yellow
} else {
  # --- Render user-data ------------------------------------------------------
  # cloud-init requires LF; this repo is edited on Windows.
  $userDataSource = Join-Path $PSScriptRoot "user-data.sh"
  if (-not (Test-Path $userDataSource)) { throw "Missing $userDataSource." }
  $userData = [System.IO.File]::ReadAllText($userDataSource)
  $userData = $userData.Replace("__BLOOM_HOSTNAME__", $hostname)
  $userData = $userData.Replace("__BLOOM_EXPECTED_IP__", $publicIp)
  $userData = $userData.Replace("__BLOOM_REPO_URL__", $RepoUrl)
  $userData = $userData.Replace("`r`n", "`n")
  $userDataPath = Join-Path ([System.IO.Path]::GetTempPath()) "bloom-user-data.sh"
  [System.IO.File]::WriteAllText($userDataPath, $userData, (New-Object System.Text.UTF8Encoding $false))

  $amiId = Get-AwsText @("ssm", "get-parameter", "--name", "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64", "--query", "Parameter.Value")
  if (-not $amiId) { throw "Could not resolve the Amazon Linux 2023 AMI." }
  Write-Host "Launching $InstanceType from $amiId"

  # IAM instance profiles are eventually consistent; RunInstances can reject a
  # profile that was just created.
  $launched = $null
  foreach ($attempt in 1..10) {
    $launched = & aws ec2 run-instances `
      --image-id $amiId `
      --instance-type $InstanceType `
      --subnet-id $subnetId `
      --security-group-ids $securityGroupId `
      --iam-instance-profile "Name=$instanceProfileName" `
      --metadata-options "HttpTokens=required,HttpEndpoint=enabled" `
      --block-device-mappings "DeviceName=/dev/xvda,Ebs={VolumeSize=8,VolumeType=gp3,DeleteOnTermination=true}" `
      --tag-specifications "ResourceType=instance,Tags=[{Key=Project,Value=$ProjectTag},{Key=Name,Value=$ProjectTag-server}]" `
      --user-data "file://$userDataPath" `
      --region $Region --output json
    if ($LASTEXITCODE -eq 0) { break }
    if ($attempt -eq 10) { throw "RunInstances failed after 10 attempts." }
    Write-Host "RunInstances attempt $attempt failed (likely IAM propagation). Retrying in 6s..." -ForegroundColor Yellow
    Start-Sleep -Seconds 6
  }
  $instanceId = ($launched | ConvertFrom-Json).Instances[0].InstanceId
  Write-Host "Launched $instanceId" -ForegroundColor Green
}

Write-Host "Waiting for the instance to reach running state..."
& aws ec2 wait instance-running --instance-ids $instanceId --region $Region
if ($LASTEXITCODE -ne 0) { throw "Instance $instanceId did not reach running state." }

$associatedTo = Get-AwsText @("ec2", "describe-addresses", "--allocation-ids", $allocationId, "--query", "Addresses[0].InstanceId")
if ($associatedTo -ne $instanceId) {
  & aws ec2 associate-address --instance-id $instanceId --allocation-id $allocationId --region $Region | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not associate $publicIp with $instanceId." }
  Write-Host "Associated $publicIp with $instanceId" -ForegroundColor Green
}

Write-Host "Waiting for status checks (this takes a few minutes)..."
& aws ec2 wait instance-status-ok --instance-ids $instanceId --region $Region

$websocketUrl = "wss://$hostname/play"
Write-Host ""
Write-Host "Instance:      $instanceId" -ForegroundColor Cyan
Write-Host "Public IP:     $publicIp" -ForegroundColor Cyan
Write-Host "Health check:  https://$hostname/health" -ForegroundColor Cyan
Write-Host "WebSocket URL: $websocketUrl" -ForegroundColor Green
Write-Host ""
Write-Host "Bootstrap (Node, Caddy, TLS) continues for 2-4 minutes after this point."
Write-Host "Then set the URL on Vercel:"
Write-Host "  vercel env add BLOOM_SERVER_URL production   # value: $websocketUrl"
Write-Host "  vercel --prod"
