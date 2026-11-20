param(
    [string]$BackendBaseUrl = 'http://127.0.0.1:8765',
    [string]$FrontendBaseUrl = 'http://127.0.0.1:5174',
    [int]$UtcOffsetMinutes = 360
)

$ErrorActionPreference = 'Stop'
$script:Failures = [System.Collections.Generic.List[string]]::new()
$script:Warnings = [System.Collections.Generic.List[string]]::new()
$script:Passed = [System.Collections.Generic.List[string]]::new()

Write-Host "Backend: $BackendBaseUrl · Frontend: $FrontendBaseUrl"

function Invoke-Check {
    param(
        [string]$Name,
        [scriptblock]$Action
    )

    try {
        $result = & $Action
        $script:Passed.Add($Name)
        return $result
    }
    catch {
        $script:Failures.Add("${Name}: $($_.Exception.Message)")
        return $null
    }
}

$health = Invoke-Check 'Backend + database' {
    $response = Invoke-RestMethod -Uri "$BackendBaseUrl/health" -TimeoutSec 5
    if ($response.status -ne 'ok' -or $response.database -ne 'ok') {
        throw 'health endpoint did not report status=ok and database=ok'
    }
    $response
}

$state = Invoke-Check 'Workspace API' {
    $response = Invoke-RestMethod -Uri "$BackendBaseUrl/api/state" -TimeoutSec 8
    if ($null -eq $response.conversations -or $null -eq $response.tasks) {
        throw 'workspace response is missing conversations or tasks'
    }
    $response
}

$conversationHistory = Invoke-Check 'Paginated conversation history API' {
    $historyByWorkspace = @{}
    foreach ($workspace in @('general', 'career')) {
        $response = Invoke-RestMethod -Uri "$BackendBaseUrl/api/conversations/history?workspace=$workspace" -TimeoutSec 8
        if ($null -eq $response.conversations -or $null -eq $response.has_more) {
            throw "conversation history for '$workspace' is missing its page metadata"
        }
        if ($response.has_more -and $null -eq $response.next_cursor) {
            throw "conversation history for '$workspace' says more results exist without a cursor"
        }
        $historyByWorkspace[$workspace] = @($response.conversations).Count
    }
    [pscustomobject]@{
        general_count = $historyByWorkspace.general
        career_count = $historyByWorkspace.career
    }
}

$memory = Invoke-Check 'Reviewable workspace memory' {
    $general = Invoke-RestMethod -Uri "$BackendBaseUrl/api/memory?workspace=general" -TimeoutSec 8
    $career = Invoke-RestMethod -Uri "$BackendBaseUrl/api/memory?workspace=career" -TimeoutSec 8
    if ($null -eq $general.sources -or $null -eq $career.sources) {
        throw 'memory response is missing its source list'
    }
    if ($null -eq $general.history_limit -or $general.history_limit -lt 1 -or $general.history_limit -gt 100) {
        throw 'memory response is missing a valid conversation history limit'
    }
    if ($career.history_limit -ne $general.history_limit) {
        throw 'general and career memory must report the same conversation history limit'
    }
    $historySource = @($general.dynamic_sources | Where-Object { $_.id -eq 'conversation-history' })
    if ($historySource.Count -ne 1 -or $historySource[0].description -notmatch [regex]::Escape([string]$general.history_limit)) {
        throw 'conversation history description does not match the API history limit'
    }
    $requiredSources = @('project-rules', 'project-charter', 'mvp-scope', 'learning-state', 'continuity-memory')
    foreach ($sourceId in $requiredSources) {
        $source = @($general.sources | Where-Object { $_.id -eq $sourceId -and $_.available -and $_.included })
        if ($source.Count -ne 1) {
            throw "general workspace is missing its packaged local context source '$sourceId'"
        }
    }
    $generalProfile = @($general.sources | Where-Object { $_.id -eq 'career-profile' })
    if ($generalProfile.Count -ne 1 -or -not $generalProfile[0].sensitive) {
        throw 'general workspace must show the career profile as a sensitive source'
    }
    if (-not $generalProfile[0].selected -and $generalProfile[0].included) {
        throw 'an unselected career profile must not enter the general workspace context'
    }
    $careerProfile = @($career.sources | Where-Object { $_.id -eq 'career-profile' })
    if ($careerProfile.Count -ne 1 -or -not $careerProfile[0].available -or -not $careerProfile[0].included) {
        throw 'career context is missing its read-only local career profile'
    }
    $careerRag = @($career.dynamic_sources | Where-Object { $_.id -eq 'career-rag' })
    if ($careerRag.Count -ne 1 -or $null -eq $careerRag[0].endpoint_configured -or $null -eq $careerRag[0].authentication_configured -or $careerRag[0].connection_verified -ne $false) {
        throw 'career RAG status must distinguish configured URL/token from an unverified connection'
    }
    if ([bool]$careerRag[0].enabled -ne ([bool]$careerRag[0].endpoint_configured -and [bool]$careerRag[0].authentication_configured)) {
        throw 'career RAG must be enabled only when both its URL and Header Auth token are configured'
    }
    [pscustomobject]@{
        general_source_count = @($general.sources).Count
        career_source_count = @($career.sources).Count
        history_limit = [int]$general.history_limit
        career_rag_enabled = [bool]$careerRag[0].enabled
        career_rag_endpoint_configured = [bool]$careerRag[0].endpoint_configured
        career_rag_authentication_configured = [bool]$careerRag[0].authentication_configured
    }
}

$careerApplications = Invoke-Check 'Career application tracker API' {
    $response = Invoke-RestMethod -Uri "$BackendBaseUrl/api/career/applications" -TimeoutSec 8
    if ($null -eq $response.applications) {
        throw 'tracker response is missing the applications list; the backend code or its database schema is out of date'
    }
    $response
}

$careerCsvImport = Invoke-Check 'Career CSV import route' {
    $statusCode = $null
    try {
        $response = Invoke-WebRequest -Uri "$BackendBaseUrl/api/career/applications/import" -Method Post -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 5
        $statusCode = [int]$response.StatusCode
    }
    catch {
        if ($null -eq $_.Exception.Response) {
            throw
        }
        $statusCode = [int]$_.Exception.Response.StatusCode
    }

    if ($statusCode -ne 400) {
        throw "empty validation probe returned HTTP $statusCode instead of 400; the CSV import route is missing or changed"
    }
    [pscustomobject]@{ available = $true }
}

$catalog = Invoke-Check 'Mini App catalog' {
    $response = Invoke-RestMethod -Uri "$BackendBaseUrl/api/miniapp/catalog" -TimeoutSec 8
    $expectedIds = @('entropy-box', 'career-module-candidate', 'knowledge-module-candidate')
    $actualIds = @($response.products | ForEach-Object { $_.id })
    if ($actualIds.Count -ne $expectedIds.Count -or (Compare-Object $expectedIds $actualIds)) {
        $actualDescription = if ($actualIds.Count -gt 0) { $actualIds -join ', ' } else { '<empty>' }
        throw "catalog is outdated or incomplete; expected [$($expectedIds -join ', ')], received [$actualDescription]"
    }
    foreach ($product in $response.products) {
        $propertyNames = @($product.PSObject.Properties.Name)
        if ($propertyNames -contains 'price' -or $propertyNames -contains 'price_cents') {
            throw "catalog product '$($product.id)' unexpectedly exposes an unapproved price"
        }
    }
    $response
}

$observability = Invoke-Check 'Argus event stream' {
    $response = Invoke-RestMethod -Uri "$BackendBaseUrl/api/observability/events?utc_offset=$UtcOffsetMinutes" -TimeoutSec 8
    if ($null -eq $response.events -or $null -eq $response.summary.orders_today) {
        throw 'Argus response is missing events or the order count'
    }
    $response
}

$cloudflareBoundary = Invoke-Check 'Private API blocked for Cloudflare requests' {
    foreach ($privateRoute in @('/api/state', '/api/memory?workspace=career')) {
        $statusCode = $null
        try {
            $response = Invoke-WebRequest -Uri "$FrontendBaseUrl$privateRoute" -Headers @{ 'CF-Ray' = 'local-demo-check' } -UseBasicParsing -TimeoutSec 5
            $statusCode = [int]$response.StatusCode
        }
        catch {
            if ($null -eq $_.Exception.Response) {
                throw
            }
            $statusCode = [int]$_.Exception.Response.StatusCode
        }

        if ($statusCode -ne 403) {
            throw "Cloudflare-tagged private route $privateRoute returned HTTP $statusCode instead of 403; rebuild the application services to load the tunnel privacy guard"
        }
    }
}

foreach ($route in @('/', '/argus', '/miniapp?preview=1')) {
    $null = Invoke-Check "Frontend $route" {
        $response = Invoke-WebRequest -Uri "$FrontendBaseUrl$route" -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -ne 200 -or $response.Content -notmatch '<html') {
            throw "route returned HTTP $($response.StatusCode) or no HTML document"
        }
    }
}

$null = Invoke-Check 'Frontend JavaScript and CSS assets' {
    $document = Invoke-WebRequest -Uri "$FrontendBaseUrl/" -UseBasicParsing -TimeoutSec 5
    # Production HTML points to hashed JS/CSS bundles; Vite dev HTML points to TS/TSX modules.
    $assetPattern = '(?:src|href)=["''](?<path>/[^"'']+\.(?:js|jsx|ts|tsx|css)(?:\?[^"'']*)?)["'']'
    $assetPaths = @(
        [regex]::Matches($document.Content, $assetPattern) |
            ForEach-Object { $_.Groups['path'].Value } |
            Select-Object -Unique
    )
    if ($assetPaths.Count -eq 0) {
        throw 'the page did not reference local JavaScript or CSS assets'
    }

    foreach ($assetPath in $assetPaths) {
        $assetUri = [Uri]::new([Uri]$FrontendBaseUrl, $assetPath)
        $asset = Invoke-WebRequest -Uri $assetUri.AbsoluteUri -UseBasicParsing -TimeoutSec 8
        if ($asset.StatusCode -ne 200 -or [string]::IsNullOrWhiteSpace($asset.Content)) {
            throw "asset $assetPath returned HTTP $($asset.StatusCode) or an empty body"
        }
    }
}

if ($null -ne $catalog -and -not $catalog.telegram_configured) {
    $script:Warnings.Add('Telegram bot token is not configured; bot interactions cannot be verified locally.')
}
if ($null -ne $observability -and -not $observability.n8n_configured) {
    $script:Warnings.Add('n8n is not configured; order dispatch will not reach the workflow.')
}
if ($null -ne $observability -and $observability.n8n_configured -and $observability.n8n_event_token_configured -eq $false) {
    $script:Warnings.Add('n8n callback token is not loaded in this backend process; incoming workflow events will be rejected.')
}
if ($null -ne $observability -and $observability.n8n_configured -and $null -eq $observability.n8n_event_token_configured) {
    $script:Warnings.Add('This backend does not report callback-token status; restart it to load the current diagnostics.')
}
if ($null -ne $observability -and $observability.n8n_configured -and $observability.n8n_event_token_configured) {
    $script:Warnings.Add('Backend callback token is loaded; its value is not shown and the match with n8n credentials is not checked.')
}
if ($null -ne $memory) {
    if ($memory.career_rag_endpoint_configured -and $memory.career_rag_authentication_configured) {
        $script:Warnings.Add('RAG URL and Header Auth token are loaded; n8n/Qdrant connectivity and credential match are not checked.')
    }
    elseif ($memory.career_rag_endpoint_configured) {
        $script:Warnings.Add('RAG URL is loaded but its required Header Auth token is missing; RAG search is disabled.')
    }
    elseif ($memory.career_rag_authentication_configured) {
        $script:Warnings.Add('RAG token is loaded but its URL is missing; RAG search is disabled.')
    }
    else {
        $script:Warnings.Add('RAG search is disabled; career answers use local context only.')
    }
}
if ($null -ne $catalog -and -not $catalog.preview_enabled) {
    $script:Warnings.Add('Mini App preview is disabled; Telegram initData is required to create a test order.')
}

Write-Host "ENTROPY local demo check — $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'))"
foreach ($item in $script:Passed) { Write-Host "  PASS  $item" -ForegroundColor Green }
foreach ($item in $script:Warnings) { Write-Host "  WARN  $item" -ForegroundColor Yellow }
foreach ($item in $script:Failures) { Write-Host "  FAIL  $item" -ForegroundColor Red }

$hasOutdatedCatalog = @(
    $script:Failures | Where-Object {
        $_ -like 'Mini App catalog:*catalog is outdated or incomplete*'
    }
).Count -gt 0
$hasMissingCareerTracker = @(
    $script:Failures | Where-Object { $_ -like 'Career application tracker API:*' }
).Count -gt 0
$hasMissingCareerCsvImport = @(
    $script:Failures | Where-Object { $_ -like 'Career CSV import route:*' }
).Count -gt 0
$hasMissingConversationHistory = @(
    $script:Failures | Where-Object { $_ -like 'Paginated conversation history API:*' }
).Count -gt 0
$hasMissingCloudflareGuard = @(
    $script:Failures | Where-Object { $_ -like 'Private API blocked for Cloudflare requests:*' }
).Count -gt 0
if ($hasOutdatedCatalog) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
    Write-Host '  NEXT  The backend process on this URL started with older catalog code.' -ForegroundColor Cyan
    Write-Host '        In the PowerShell or PyCharm window that owns that backend, press Ctrl+C.' -ForegroundColor Cyan
    Write-Host "        Then run: Set-Location '$projectRoot'; & .\.venv\Scripts\python.exe app.py" -ForegroundColor Cyan
    Write-Host '        Rerun this check afterward; do not start another process on the same port.' -ForegroundColor Cyan
}
if ($hasMissingCareerTracker) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
    Write-Host '  NEXT  The backend process does not serve the new tracker API, or its database is missing migration 0003.' -ForegroundColor Cyan
    Write-Host '        For Docker Compose, rebuild the app services from the project root: docker compose up -d --build backend frontend' -ForegroundColor Cyan
    Write-Host '        For direct Python, run Alembic upgrade head with the same .env, then stop and restart the existing app.py process.' -ForegroundColor Cyan
    Write-Host "        Command: Set-Location '$projectRoot'; & .\.venv\Scripts\python.exe -m alembic upgrade head" -ForegroundColor Cyan
    Write-Host '        Do not start a second backend on the same port; rerun this check afterward.' -ForegroundColor Cyan
}
if ($hasMissingCareerCsvImport) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
    Write-Host '  NEXT  The backend process does not serve the new career CSV import endpoint yet.' -ForegroundColor Cyan
    Write-Host '        For Docker Compose, rebuild the app services from the project root: docker compose up -d --build backend frontend' -ForegroundColor Cyan
    Write-Host '        For direct Python, stop the existing app.py process, then start it again from the project root.' -ForegroundColor Cyan
    Write-Host "        Project: $projectRoot" -ForegroundColor Cyan
    Write-Host '        The check sent an empty validation request only; it did not create any vacancy.' -ForegroundColor Cyan
}
if ($hasMissingConversationHistory) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
    Write-Host '  NEXT  The backend process does not serve paginated conversation history yet.' -ForegroundColor Cyan
    Write-Host '        For Docker Compose: docker compose up -d --build backend frontend' -ForegroundColor Cyan
    Write-Host '        For direct Python: stop the existing app.py process, then start it again from the project root.' -ForegroundColor Cyan
    Write-Host "        Project: $projectRoot" -ForegroundColor Cyan
    Write-Host '        Do not start a second backend on the same port; rerun this check afterward.' -ForegroundColor Cyan
}
if ($hasMissingCloudflareGuard) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
    Write-Host '  NEXT  The backend/frontend process on this URL does not enforce the Cloudflare private-API boundary.' -ForegroundColor Cyan
    Write-Host '        For Docker Compose, rebuild the app services from the project root: docker compose up -d --build backend frontend' -ForegroundColor Cyan
    Write-Host '        For direct Python/Vite, stop the existing processes and restart them from the updated project files.' -ForegroundColor Cyan
    Write-Host "        Project: $projectRoot" -ForegroundColor Cyan
    Write-Host '        Rerun this check afterward; do not start a second backend on the same port.' -ForegroundColor Cyan
}

if ($null -ne $state) {
    $modeLabel = if ($state.mode -in @('demo', 'local-demo')) { 'demo · синтетические ответы' } else { [string]$state.mode }
    $modelLabel = if ([string]::IsNullOrWhiteSpace([string]$state.model)) { 'модель не указана' } else { [string]$state.model }
    Write-Host "  INFO  Режим: $modeLabel · модель: $modelLabel"
    Write-Host "  INFO  $(@($state.conversations).Count) conversations · $(@($state.tasks).Count) tasks"
}
if ($null -ne $conversationHistory) {
    Write-Host "  INFO  History pages: $($conversationHistory.general_count) general · $($conversationHistory.career_count) career"
}
if ($null -ne $memory) {
    Write-Host "  INFO  Контекст: $($memory.general_source_count) общих источника · $($memory.career_source_count) для поиска работы"
    Write-Host "  INFO  История диалога: до $($memory.history_limit) предыдущих сообщений в контексте"
    Write-Host "  INFO  RAG career: enabled=$($memory.career_rag_enabled) · URL=$($memory.career_rag_endpoint_configured) · token=$($memory.career_rag_authentication_configured)"
}
if ($null -ne $careerApplications) {
    Write-Host "  INFO  $(@($careerApplications.applications).Count) saved career applications"
}
if ($null -ne $careerCsvImport) {
    Write-Host "  INFO  CSV import route: $($careerCsvImport.available)"
}
if ($null -ne $catalog) {
    Write-Host "  INFO  $(@($catalog.products).Count) products · preview=$($catalog.preview_enabled)"
}
if ($null -ne $observability) {
    Write-Host "  INFO  $(@($observability.events).Count) recent events · $($observability.summary.orders_today) orders today"
}

if ($script:Failures.Count -gt 0) { exit 1 }
