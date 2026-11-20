$ErrorActionPreference = 'Stop'

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
  throw "'kubectl' is not installed or is not available on PATH."
}

$context = (& kubectl config current-context 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $context -ne 'docker-desktop') {
  throw "Expected Docker Desktop Kubernetes context 'docker-desktop'; current context is '$context'."
}

kubectl scale deployment/entropy-backend deployment/entropy-frontend statefulset/postgres --replicas=0 --namespace entropy-demo
if ($LASTEXITCODE -ne 0) {
  throw 'Could not scale down the Entropy demo workloads.'
}

Write-Host 'Entropy demo workloads are stopped. The namespace, Secret, and PostgreSQL PVC remain so demo data is preserved.'

