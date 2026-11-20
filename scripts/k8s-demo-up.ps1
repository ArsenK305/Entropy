param(
  [int]$LocalPort = 5174,
  [switch]$SkipPortForward
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestRoot = Join-Path $projectRoot 'k8s\demo'
Set-Location $projectRoot

foreach ($tool in @('docker', 'kubectl')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "'$tool' is not installed or is not available on PATH. Install/start Docker Desktop first."
  }
}

$context = (& kubectl config current-context 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $context -ne 'docker-desktop') {
  throw "Kubernetes context is '$context'. In Docker Desktop, create/enable its local Kubernetes cluster, then retry when kubectl context is 'docker-desktop'."
}

$containerOs = (& docker info --format '{{.OSType}}' 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $containerOs -ne 'linux') {
  throw 'Docker Desktop must be running in Linux container mode.'
}

if ($LocalPort -lt 1 -or $LocalPort -gt 65535) {
  throw 'LocalPort must be between 1 and 65535.'
}

if (-not $SkipPortForward) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $LocalPort -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    throw "Local port $LocalPort is busy. Stop the Vite frontend, or rerun with -LocalPort 5175."
  }
}

function Invoke-CheckedNative {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE."
  }
}

Invoke-CheckedNative -Command 'docker' -Arguments @('build', '-f', 'Dockerfile.backend', '-t', 'entropy/backend:local', '.')
Invoke-CheckedNative -Command 'docker' -Arguments @('build', '-f', 'Dockerfile.frontend', '-t', 'entropy/frontend:local', '.')

Invoke-CheckedNative -Command 'kubectl' -Arguments @('apply', '-f', (Join-Path $manifestRoot '00-namespace.yaml'))

& kubectl get secret entropy-demo-db --namespace entropy-demo *> $null
if ($LASTEXITCODE -ne 0) {
  $existingClaim = & kubectl get pvc postgres-data-postgres-0 --namespace entropy-demo --ignore-not-found --output=name 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not verify the demo PostgreSQL volume state. No database Secret was created.'
  }
  if ($existingClaim) {
    throw 'The entropy-demo-db Secret is missing while the PostgreSQL volume still exists. Restore the original Secret before starting the demo; generating a new password would not unlock this database.'
  }

  $randomBytes = New-Object byte[] 32
  $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $random.GetBytes($randomBytes)
  } finally {
    $random.Dispose()
  }
  $password = -join ($randomBytes | ForEach-Object { $_.ToString('x2') })
  $secretJson = [ordered]@{
    apiVersion = 'v1'
    kind = 'Secret'
    metadata = @{
      name = 'entropy-demo-db'
      namespace = 'entropy-demo'
    }
    type = 'Opaque'
    data = @{
      username = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('entropy_demo'))
      password = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($password))
    }
  } | ConvertTo-Json -Depth 5 -Compress
  $secretJson | & kubectl apply --filename -
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not create the local demo database Secret.'
  }
  $secretJson = $null
  $password = $null
  $randomBytes = $null
}

Invoke-CheckedNative -Command 'kubectl' -Arguments @('apply', '-f', (Join-Path $manifestRoot '10-config.yaml'))
Invoke-CheckedNative -Command 'kubectl' -Arguments @('apply', '-f', (Join-Path $manifestRoot '20-postgres.yaml'))
Invoke-CheckedNative -Command 'kubectl' -Arguments @('rollout', 'status', 'statefulset/postgres', '--namespace', 'entropy-demo', '--timeout=240s')

Invoke-CheckedNative -Command 'kubectl' -Arguments @('delete', 'job', 'entropy-migrate', '--namespace', 'entropy-demo', '--ignore-not-found=true')
Invoke-CheckedNative -Command 'kubectl' -Arguments @('apply', '-f', (Join-Path $manifestRoot '30-migration-job.yaml'))
Invoke-CheckedNative -Command 'kubectl' -Arguments @('wait', '--for=condition=complete', 'job/entropy-migrate', '--namespace', 'entropy-demo', '--timeout=240s')

Invoke-CheckedNative -Command 'kubectl' -Arguments @('apply', '-f', (Join-Path $manifestRoot '40-backend.yaml'))
Invoke-CheckedNative -Command 'kubectl' -Arguments @('apply', '-f', (Join-Path $manifestRoot '50-frontend.yaml'))
Invoke-CheckedNative -Command 'kubectl' -Arguments @('rollout', 'restart', 'deployment/entropy-backend', '--namespace', 'entropy-demo')
Invoke-CheckedNative -Command 'kubectl' -Arguments @('rollout', 'restart', 'deployment/entropy-frontend', '--namespace', 'entropy-demo')
Invoke-CheckedNative -Command 'kubectl' -Arguments @('rollout', 'status', 'deployment/entropy-backend', '--namespace', 'entropy-demo', '--timeout=180s')
Invoke-CheckedNative -Command 'kubectl' -Arguments @('rollout', 'status', 'deployment/entropy-frontend', '--namespace', 'entropy-demo', '--timeout=180s')
Invoke-CheckedNative -Command 'kubectl' -Arguments @('get', 'pods,services', '--namespace', 'entropy-demo')

if ($SkipPortForward) {
  Write-Host 'Demo is deployed. To open it, run: kubectl port-forward -n entropy-demo svc/entropy-frontend 5174:80'
  return
}

Write-Host "Opening http://127.0.0.1:$LocalPort - press Ctrl+C to stop port-forwarding; the Kubernetes workloads will keep running."
$portForwardSpec = '{0}:80' -f $LocalPort
& kubectl port-forward --namespace entropy-demo svc/entropy-frontend $portForwardSpec

