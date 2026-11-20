$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$socialDir = Join-Path $repoRoot 'docs\social'
$htmlPath = Join-Path $socialDir 'entropy-career-carousel.html'
$zipPath = Join-Path $socialDir 'entropy-career-carousel.zip'

$chromeCandidates = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)
$chromeCommand = Get-Command chrome.exe -ErrorAction SilentlyContinue
if ($chromeCommand) {
    $chromeCandidates += $chromeCommand.Source
}
$chromePath = $chromeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $chromePath) {
    throw 'Google Chrome was not found. Install Chrome or add chrome.exe to PATH.'
}
if (-not (Test-Path -LiteralPath $htmlPath)) {
    throw "Carousel source was not found: $htmlPath"
}

$html = Get-Content -LiteralPath $htmlPath -Raw
$slidesMatch = [regex]::Match($html, 'const slides = \[(?<items>[\s\S]*?)\r?\n\s*\];')
if (-not $slidesMatch.Success) {
    throw 'Could not read the slides list from the carousel HTML.'
}
$slideCount = [regex]::Matches($slidesMatch.Groups['items'].Value, '\{ type:\s*"').Count
if ($slideCount -lt 2) {
    throw "Expected at least two slides, found $slideCount."
}

$tempRoot = [System.IO.Path]::GetTempPath()
$runId = [guid]::NewGuid().ToString('N')
$profilePath = Join-Path $tempRoot 'entropy-carousel-export-profile'
$htmlUrl = ([System.Uri]::new((Resolve-Path -LiteralPath $htmlPath).Path)).AbsoluteUri
$rendered = [System.Collections.Generic.List[string]]::new()

for ($index = 1; $index -lt $slideCount; $index++) {
    $number = '{0:D2}' -f ($index + 1)
    $outputPath = Join-Path $socialDir "entropy-career-slide-$number.png"
    $url = "${htmlUrl}?slide=$index&export=1"
    $argumentLine = "--headless=new --disable-gpu --no-first-run --hide-scrollbars --force-device-scale-factor=1 --window-size=1080,1350 --user-data-dir=`"$profilePath`" --screenshot=`"$outputPath`" --virtual-time-budget=3000 `"$url`""
    $process = Start-Process -FilePath $chromePath -ArgumentList $argumentLine -Wait -PassThru -NoNewWindow
    if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $outputPath)) {
        throw "Chrome failed to render slide $number (exit $($process.ExitCode))."
    }

    $fileInfo = Get-Item -LiteralPath $outputPath
    if ($fileInfo.Length -lt 10000) {
        throw "Rendered slide $number is unexpectedly small ($($fileInfo.Length) bytes)."
    }
    $stream = [System.IO.File]::OpenRead($outputPath)
    try {
        $header = [byte[]]::new(24)
        $bytesRead = $stream.Read($header, 0, $header.Length)
    }
    finally {
        $stream.Dispose()
    }
    if ($bytesRead -ne 24 -or [System.Text.Encoding]::ASCII.GetString($header, 1, 3) -ne 'PNG') {
        throw "Rendered slide $number is not a valid PNG."
    }
    $width = ($header[16] * 16777216) + ($header[17] * 65536) + ($header[18] * 256) + $header[19]
    $height = ($header[20] * 16777216) + ($header[21] * 65536) + ($header[22] * 256) + $header[23]
    if ($width -ne 1080 -or $height -ne 1350) {
        throw "Slide $number has unexpected dimensions ${width}x${height}."
    }
    $rendered.Add($outputPath)
    Write-Host "Rendered slide $number ($width x $height)"
}

$overviewHtmlPath = Join-Path $socialDir 'entropy-career-overview.html'
$overviewPath = Join-Path $socialDir 'entropy-career-overview.png'
if (-not (Test-Path -LiteralPath $overviewHtmlPath)) {
    throw "Overview source was not found: $overviewHtmlPath"
}
$overviewUrl = ([System.Uri]::new((Resolve-Path -LiteralPath $overviewHtmlPath).Path)).AbsoluteUri
$overviewArguments = "--headless=new --disable-gpu --no-first-run --hide-scrollbars --force-device-scale-factor=1 --window-size=1200,1600 --user-data-dir=`"$profilePath`" --screenshot=`"$overviewPath`" --virtual-time-budget=3000 `"$overviewUrl`""
$overviewProcess = Start-Process -FilePath $chromePath -ArgumentList $overviewArguments -Wait -PassThru -NoNewWindow
if ($overviewProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $overviewPath)) {
    throw "Chrome failed to render the contact sheet (exit $($overviewProcess.ExitCode))."
}
Write-Host 'Rendered the 9-slide contact sheet.'

$archiveNames = [System.Collections.Generic.List[string]]::new()
$coverPath = Join-Path $socialDir 'entropy-career-cover.png'
if (-not (Test-Path -LiteralPath $coverPath)) {
    throw "Cover image was not found: $coverPath"
}
$archiveNames.Add('entropy-career-cover.png')
for ($index = 1; $index -lt $slideCount; $index++) {
    $archiveNames.Add(('entropy-career-slide-{0:D2}.png' -f ($index + 1)))
}
$archiveNames.Add('entropy-career-caption.md')
$archiveNames.Add('README.md')
foreach ($name in $archiveNames) {
    if (-not (Test-Path -LiteralPath (Join-Path $socialDir $name))) {
        throw "Archive input is missing: $name"
    }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipTemp = Join-Path $tempRoot "entropy-carousel-$runId.zip"
$archive = [System.IO.Compression.ZipFile]::Open($zipTemp, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($name in $archiveNames) {
        $sourcePath = Join-Path $socialDir $name
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive,
            $sourcePath,
            $name,
            [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
}
finally {
    $archive.Dispose()
}
Move-Item -LiteralPath $zipTemp -Destination $zipPath -Force
Write-Host "Updated $zipPath with $($archiveNames.Count) files."
