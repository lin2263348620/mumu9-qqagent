$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot

function Test-BotNode([string] $File) {
    if (-not $File -or -not (Test-Path -LiteralPath $File)) { return $false }
    try {
        & $File -e 'const [a,b]=process.versions.node.split(/\./).map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>$null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}

try {
    $existingNode = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodePath = if ($existingNode) { $existingNode.Source } else { '' }
    if ($env:BOT_USE_LOCAL_NODE -eq '1' -or -not (Test-BotNode $nodePath)) {
        $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
        if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows 64-bit is required.' }
        $archiveName = "node-v22.22.0-win-$architecture.zip"
        $expectedHash = if ($architecture -eq 'arm64') { '5b44fd410df7b4cd0a1891a05a7b606f8fb7d8786a94997b996a372e82478d7a' } else { 'c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a' }
        $runtimeRoot = Join-Path $projectRoot '.runtime'
        $nodePath = Join-Path $runtimeRoot "node22-$architecture/node.exe"
        if (-not (Test-BotNode $nodePath)) {
            New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
            $download = Join-Path $runtimeRoot ($archiveName + '.' + [Guid]::NewGuid().ToString('N') + '.download')
            $staging = Join-Path $runtimeRoot ('tmp-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
            Write-Host 'Downloading official portable Node.js 22.22.0...'
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $client = New-Object Net.WebClient
            try { $client.DownloadFile("https://nodejs.org/dist/v22.22.0/$archiveName", $download) }
            finally { $client.Dispose() }
            $stream = [IO.File]::OpenRead($download)
            $hasher = [Security.Cryptography.SHA256]::Create()
            try { $actualHash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
            finally { $hasher.Dispose(); $stream.Dispose() }
            if ($actualHash -ne $expectedHash) { throw 'Node.js checksum mismatch. Refusing to run the download.' }
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling', $false)
            [AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths', $false)
            $zip = [IO.Compression.ZipFile]::OpenRead($download)
            $prefix = "node-v22.22.0-win-$architecture/"
            [IO.Directory]::CreateDirectory($staging) | Out-Null
            try {
                foreach ($entry in $zip.Entries) {
                    if (-not $entry.FullName.StartsWith($prefix)) { throw 'Unexpected path in runtime archive.' }
                    $relative = $entry.FullName.Substring($prefix.Length)
                    if (-not $relative) { continue }
                    $destination = [IO.Path]::GetFullPath((Join-Path $staging $relative))
                    if (-not $destination.StartsWith($staging + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe path in runtime archive.' }
                    if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($destination) | Out-Null }
                    else {
                        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
                        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination)
                    }
                }
            } finally { $zip.Dispose() }
            $target = Join-Path $runtimeRoot "node22-$architecture"
            if (Test-Path -LiteralPath $target) { throw 'Incomplete runtime exists. Rename the .runtime folder and retry.' }
            [IO.Directory]::Move($staging, $target)
            Remove-Item -LiteralPath $download
            if (-not (Test-BotNode $nodePath)) { throw 'Downloaded Node.js cannot run on this Windows system.' }
        }
    }
    $env:PATH = (Split-Path $nodePath -Parent) + ';' + $env:PATH
    if (-not $env:BOT_OPEN_BROWSER) { $env:BOT_OPEN_BROWSER = '1' }
    Write-Host 'Preparing dependencies and starting bot. Keep this window open.'
    & $nodePath --env-file-if-exists=.env start.mjs
    exit $LASTEXITCODE
} catch {
    Write-Host ('Deployment failed: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
