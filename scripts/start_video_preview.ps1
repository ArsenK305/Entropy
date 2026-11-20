param(
    [int]$Port = 8767,
    [switch]$ReuseLatest
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $projectRoot '.venv\Scripts\python.exe'
$rehearsalDir = Join-Path $projectRoot 'tmp'

if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    throw 'Project virtualenv not found. Run the setup steps in docs/LOCAL_START.md first.'
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($listener) {
    throw "Port $Port is already in use by PID $($listener.OwningProcess). Leave it running or choose another port."
}

if ($ReuseLatest) {
    $latestPreview = Get-ChildItem -LiteralPath $rehearsalDir -Filter 'video_preview_*.db' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $latestPreview) {
        throw 'No existing isolated video preview database found in tmp. Start once without -ReuseLatest to create one.'
    }
    $previewDatabase = $latestPreview.FullName
    Write-Host "Повторно использую изолированную SQLite-копию: $($latestPreview.Name)"
}
else {
    $database = Get-ChildItem -LiteralPath $rehearsalDir -Filter 'video_rehearsal_*.db' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -notmatch '^video_rehearsal_http_' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $database) {
        throw 'No ready-to-show rehearsal database found in tmp. Do not point this preview at the main database.'
    }

    $previewDatabase = Join-Path $rehearsalDir ("video_preview_{0}_{1}.db" -f (Get-Date -Format 'yyyyMMdd_HHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 8)))
    $cloneScript = Join-Path $PSScriptRoot 'clone_rehearsal_db.py'
    & $pythonPath $cloneScript $database.FullName $previewDatabase
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $previewDatabase -PathType Leaf)) {
        throw 'Could not create the isolated rehearsal database copy.'
    }
}

# This preview is deliberately isolated: no Telegram polling, n8n dispatch or live model calls.
$environment = @{
    ENTROPY_DATABASE_URL = 'sqlite:///' + $previewDatabase.Replace('\', '/')
    ENTROPY_MODE = 'demo'
    ENTROPY_HOST = '127.0.0.1'
    ENTROPY_PORT = [string]$Port
    ENTROPY_TELEGRAM_POLLING = '0'
    ENTROPY_MINIAPP_PREVIEW = '1'
    OPENAI_API_KEY = ''
    TELEGRAM_BOT_TOKEN = ''
    TELEGRAM_MINIAPP_URL = ''
    ENTROPY_N8N_WEBHOOK_URL = 'disabled'
    ENTROPY_N8N_EVENT_TOKEN = 'disabled'
    ENTROPY_RAG_SEARCH_WEBHOOK_URL = 'disabled'
    ENTROPY_RAG_WEBHOOK_TOKEN = 'disabled'
}
$previousEnvironment = @{}
foreach ($name in $environment.Keys) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

Write-Host "Изолированный preview: http://127.0.0.1:$Port/"
Write-Host "Копия репетиционной SQLite: $([IO.Path]::GetFileName($previewDatabase))"
Write-Host 'Режим demo: ключи OpenAI/Telegram и webhook-и отключены; заказы сохраняются только в эту копию.'
Write-Host 'Локальный тестовый заказ сохраняется только в копии SQLite и появляется в Argus.'

try {
    foreach ($name in $environment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process')
    }
    Write-Host 'Обновляю схему только в изолированной копии базы…'
    & $pythonPath -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not migrate the isolated rehearsal database copy.'
    }
    Write-Host 'Остановить preview: Ctrl+C.'
    & $pythonPath -u (Join-Path $projectRoot 'app.py')
}
finally {
    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
}
