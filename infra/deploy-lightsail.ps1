param(
  [string]$Region = "us-east-1",
  [string]$ServiceName = "bloom-server",
  [ValidateSet("nano", "micro", "small", "medium", "large", "xlarge")]
  [string]$Power = "nano",
  [ValidateRange(1, 20)]
  [int]$Scale = 1
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  throw "AWS CLI v2 is required. Install it, then run 'aws configure sso' or provide a least-privilege profile."
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker Desktop is required to build the Linux container image."
}

$identity = aws sts get-caller-identity --output json | ConvertFrom-Json
if (-not $identity.Account) { throw "AWS credentials are not configured." }
Write-Host "Deploying Bloom to AWS account $($identity.Account) in $Region"

$existingJson = aws lightsail get-container-services --service-name $ServiceName --region $Region --output json 2>$null
if ($LASTEXITCODE -ne 0) { throw "Unable to query Lightsail in $Region." }
$existing = $existingJson | ConvertFrom-Json
if (-not $existing.containerServices) {
  aws lightsail create-container-service --service-name $ServiceName --power $Power --scale $Scale --region $Region | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not create the Lightsail container service." }
}

$deadline = (Get-Date).AddMinutes(12)
do {
  $service = (aws lightsail get-container-services --service-name $ServiceName --region $Region --output json | ConvertFrom-Json).containerServices[0]
  Write-Host "Service state: $($service.state)"
  if ($service.state -eq "READY") { break }
  if ($service.state -match "FAILED|ERROR") { throw "Lightsail entered state $($service.state)." }
  if ((Get-Date) -gt $deadline) { throw "Timed out waiting for Lightsail to become ready." }
  Start-Sleep -Seconds 10
} while ($true)

docker build --tag bloom-server:local .
if ($LASTEXITCODE -ne 0) { throw "Docker build failed." }

$image = aws lightsail push-container-image --service-name $ServiceName --label "bloom" --image "bloom-server:local" --region $Region --output json | ConvertFrom-Json
if (-not $image.image) { throw "Image push failed." }

$tempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "bloom-lightsail-deploy"
New-Item -ItemType Directory -Force -Path $tempDirectory | Out-Null
$containersPath = Join-Path $tempDirectory "containers.json"
$endpointPath = Join-Path $tempDirectory "endpoint.json"

@{
  bloom = @{
    image = $image.image
    ports = @{ "8080" = "HTTP" }
    environment = @{ NODE_ENV = "production"; PORT = "8080" }
  }
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $containersPath -Encoding utf8NoBOM

@{
  containerName = "bloom"
  containerPort = 8080
  healthCheck = @{
    healthyThreshold = 2
    unhealthyThreshold = 2
    timeoutSeconds = 5
    intervalSeconds = 10
    path = "/health"
    successCodes = "200-299"
  }
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $endpointPath -Encoding utf8NoBOM

aws lightsail create-container-service-deployment `
  --service-name $ServiceName `
  --containers "file://$containersPath" `
  --public-endpoint "file://$endpointPath" `
  --region $Region | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Lightsail deployment creation failed." }

$service = (aws lightsail get-container-services --service-name $ServiceName --region $Region --output json | ConvertFrom-Json).containerServices[0]
$websocketUrl = "$($service.url -replace '^https:', 'wss:')/play"
Write-Host "Deployment submitted. WebSocket URL: $websocketUrl"
Write-Host "Set the GitHub repository variable BLOOM_SERVER_URL to this value before publishing Pages."
