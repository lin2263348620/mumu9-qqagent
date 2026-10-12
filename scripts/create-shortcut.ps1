param([Parameter(Mandatory=$true)][string]$ProjectRoot, [Parameter(Mandatory=$true)][string]$ShortcutName)
$ErrorActionPreference = 'Stop'
$desktop = if ($env:BOT_DESKTOP_DIR) { $env:BOT_DESKTOP_DIR } else { [Environment]::GetFolderPath('DesktopDirectory') }
if (-not $desktop) { throw 'Desktop directory is unavailable.' }
[IO.Directory]::CreateDirectory($desktop) | Out-Null
$launcher = Join-Path $ProjectRoot ([string]::Concat([char]0x542f,[char]0x52a8,[char]0x7ba1,[char]0x7406,[char]0x540e,[char]0x53f0,'.cmd'))
if (-not (Test-Path -LiteralPath $launcher)) { throw 'Launcher is missing.' }
$shell = New-Object -ComObject WScript.Shell
try {
    $file = Join-Path $desktop $ShortcutName
    if (Test-Path -LiteralPath $file) {
        $existing = $shell.CreateShortcut($file)
        if ($existing.WorkingDirectory -ne $ProjectRoot) {
            $suffix = [Math]::Abs($ProjectRoot.GetHashCode()).ToString()
            $file = Join-Path $desktop ([IO.Path]::GetFileNameWithoutExtension($ShortcutName) + '-' + $suffix + '.lnk')
            if (Test-Path -LiteralPath $file) { throw 'A shortcut for another project already exists.' }
        }
    }
    $link = $shell.CreateShortcut($file)
    $link.TargetPath = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $link.Arguments = '/d /c ""' + $launcher + '""'
    $link.WorkingDirectory = $ProjectRoot
    $link.Description = 'Start bot services and open the admin console'
    $link.WindowStyle = 7
    $link.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',14'
    $link.Save()
    Write-Output ('Desktop shortcut: ' + $file)
} finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
