$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$required = @('vcruntime140.dll','vcruntime140_1.dll','msvcp140.dll')
$missing = @($required | Where-Object { -not [IO.File]::Exists((Join-Path $env:SystemRoot ('System32\' + $_))) })
if ($missing.Count -eq 0) { Write-Output 'Microsoft C++ runtime is already available.'; exit 0 }
Write-Output 'Installing the official Microsoft C++ runtime. Windows may request administrator approval.'
$downloads = Join-Path $projectRoot '.runtime\downloads'
[IO.Directory]::CreateDirectory($downloads) | Out-Null
$installer = Join-Path $downloads 'vc_redist.x64.exe'
if (-not [IO.File]::Exists($installer)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $request = [Net.HttpWebRequest]::Create('https://aka.ms/vs/17/release/vc_redist.x64.exe')
    $request.Timeout = 120000
    $request.ReadWriteTimeout = 60000
    $response = $request.GetResponse()
    try {
        $inputStream = $response.GetResponseStream()
        $outputStream = [IO.File]::Open($installer + '.partial',[IO.FileMode]::Create,[IO.FileAccess]::Write)
        try { $inputStream.CopyTo($outputStream) }
        finally { $inputStream.Dispose(); $outputStream.Dispose() }
    } finally { $response.Dispose() }
    [IO.File]::Move($installer + '.partial',$installer)
}
Import-Module (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)CN=Microsoft Corporation(,|$)') { throw 'The installer has no valid Microsoft signature. Refusing to execute it.' }
$process = Start-Process -FilePath $installer -ArgumentList '/install /passive /norestart' -Verb RunAs -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) { throw ('Microsoft C++ runtime installation failed: ' + $process.ExitCode) }
foreach ($file in $required) {
    if (-not [IO.File]::Exists((Join-Path $env:SystemRoot ('System32\' + $file)))) { throw 'Runtime installation requires a Windows restart. Restart and launch deployment again.' }
}
Write-Output 'Microsoft C++ runtime installation completed.'
