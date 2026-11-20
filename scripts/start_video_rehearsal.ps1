$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $projectRoot '.venv\Scripts\python.exe'
$rehearsalDir = Join-Path $projectRoot 'tmp'

if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    throw 'Project virtualenv not found. Run the setup steps in docs/LOCAL_START.md first.'
}

$database = Get-ChildItem -LiteralPath $rehearsalDir -Filter 'video_rehearsal_*.db' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -notmatch '^video_rehearsal_http_' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $database) {
    throw 'No ready-to-show rehearsal database found in tmp. Do not point this script at the main database.'
}

$listener = Get-NetTCPConnection -State Listen -LocalPort 8766 -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($listener) {
    throw "Port 8766 is already in use by PID $($listener.OwningProcess). Leave it running or inspect it before retrying."
}

$environment = @{
    ENTROPY_DATABASE_URL = 'sqlite:///' + $database.FullName.Replace('\', '/')
    ENTROPY_MODE = 'live'
    ENTROPY_HOST = '127.0.0.1'
    ENTROPY_PORT = '8766'
    ENTROPY_TELEGRAM_POLLING = '0'
}
$previousEnvironment = @{}
foreach ($name in $environment.Keys) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

Write-Host "Изолированная репетиция: http://127.0.0.1:8766/"
Write-Host "SQLite: $($database.Name)"
Write-Host 'Режим live: новые сообщения вызывают OpenAI API. Telegram polling выключен.'
Write-Host 'Остановить сервер: Ctrl+C.'

try {
    foreach ($name in $environment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process')
    }
    & $pythonPath -u (Join-Path $projectRoot 'app.py')
}
finally {
    foreach ($name in $previousEnvironment.Keys) {
        $value = $previousEnvironment[$name]
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}
