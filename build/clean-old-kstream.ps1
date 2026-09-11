# Wipe previous kstream app installs so Setup can land a clean latest copy.
# Keeps roaming user data (login / bookmarks) under %APPDATA%\kstream.
# -Finalize <installDir> rewrites shortcuts and does not kill/wipe the new install.
param(
  [string]$Finalize = ''
)

$ErrorActionPreference = 'SilentlyContinue'

function Remove-Tree([string]$Path) {
  if (-not $Path) { return }
  if (-not (Test-Path -LiteralPath $Path)) { return }
  cmd /c "rmdir /s /q `"$Path`"" | Out-Null
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Remove-TreeRetry([string]$Path) {
  if (-not $Path) { return }
  for ($i = 0; $i -lt 5; $i++) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Remove-Tree $Path
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Start-Sleep -Milliseconds 400
  }
}

function Get-KstreamExeProcesses {
  Get-CimInstance Win32_Process -Filter "Name = 'kstream.exe'" -ErrorAction SilentlyContinue
}

function Test-KstreamAppDir([string]$Dir) {
  if (-not $Dir) { return $false }
  $name = Split-Path $Dir -Leaf
  if ($name -like 'kstream*') { return $true }
  if (Test-Path -LiteralPath (Join-Path $Dir 'kstream-portable.json')) { return $true }
  if (Test-Path -LiteralPath (Join-Path $Dir 'resources\app.asar')) { return $true }
  if (Test-Path -LiteralPath (Join-Path $Dir 'kstream.exe')) { return $true }
  return $false
}

function Write-KstreamShortcut([string]$LinkPath, [string]$Target) {
  if (-not $LinkPath -or -not $Target) { return }
  if (-not (Test-Path -LiteralPath $Target)) { return }
  $dir = Split-Path $LinkPath -Parent
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $w = New-Object -ComObject WScript.Shell
  $s = $w.CreateShortcut($LinkPath)
  $s.TargetPath = $Target
  $s.WorkingDirectory = Split-Path $Target -Parent
  $s.WindowStyle = 1
  $s.IconLocation = "$Target,0"
  $s.Save()
}

function Stop-KstreamApp {
  cmd /c 'taskkill /F /IM kstream.exe /T' | Out-Null
  Get-KstreamExeProcesses | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  for ($i = 0; $i -lt 8; $i++) {
    $left = @(Get-KstreamExeProcesses)
    if ($left.Count -eq 0) { return }
    Start-Sleep -Milliseconds 350
    cmd /c 'taskkill /F /IM kstream.exe /T' | Out-Null
    $left | ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

if ($Finalize) {
  $exe = Join-Path $Finalize 'kstream.exe'
  Write-KstreamShortcut (Join-Path $env:USERPROFILE 'Desktop\kstream.lnk') $exe
  Write-KstreamShortcut (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\kstream.lnk') $exe
  $pinDir = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
  if (Test-Path -LiteralPath $pinDir) {
    Get-ChildItem -LiteralPath $pinDir -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $w = New-Object -ComObject WScript.Shell
        $s = $w.CreateShortcut($_.FullName)
        $target = [string]$s.TargetPath
        $isKstream =
          $_.BaseName -eq 'kstream' -or
          $target -match '(?i)kstream\.exe$' -or
          $target -match '(?i)kstream-portable'
        if ($isKstream) {
          Write-KstreamShortcut $_.FullName $exe
        }
      } catch {
        # ignore
      }
    }
  }
  exit 0
}

$dirs = New-Object System.Collections.Generic.List[string]
Get-KstreamExeProcesses | ForEach-Object {
  if ($_.ExecutablePath) {
    $dirs.Add([string](Split-Path $_.ExecutablePath -Parent))
  }
}

Stop-KstreamApp
Start-Sleep -Milliseconds 400

Get-KstreamExeProcesses | ForEach-Object {
  if ($_.ExecutablePath) {
    $dirs.Add([string](Split-Path $_.ExecutablePath -Parent))
  }
}

foreach ($name in @('kstream', 'kstream.bak', 'kstream-portable')) {
  $dirs.Add((Join-Path $env:LOCALAPPDATA "Programs\$name"))
}

Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'kstream*' } |
  ForEach-Object { $dirs.Add($_.FullName) }

$dirs.Add((Join-Path $env:TEMP 'kstream-portable'))
$dirs.Add((Join-Path $env:LOCALAPPDATA 'Temp\kstream-portable'))
$dirs.Add((Join-Path $env:LOCALAPPDATA 'kstream-updater'))

$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
Get-ChildItem $uninstallRoot -ErrorAction SilentlyContinue | ForEach-Object {
  $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
  if (-not $props) { return }
  $display = [string]$props.DisplayName
  $id = $_.PSChildName
  $isKstream =
    $display -eq 'kstream' -or
    $display -like 'kstream *' -or
    $id -eq 'kstream' -or
    $id -like 'com.kdesafx.kstream*'
  if (-not $isKstream) { return }
  if ($props.InstallLocation) { $dirs.Add([string]$props.InstallLocation) }
  Remove-Item $_.PSPath -Recurse -Force
}

foreach ($dir in ($dirs | Select-Object -Unique)) {
  if (-not (Test-KstreamAppDir $dir)) { continue }
  Remove-TreeRetry $dir
}

Remove-Item (Join-Path $env:USERPROFILE 'Desktop\kstream.lnk') -Force
Remove-Item (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\kstream.lnk') -Force

foreach ($root in @(
  (Join-Path $env:USERPROFILE 'Desktop'),
  (Join-Path $env:USERPROFILE 'Downloads'),
  (Join-Path $env:USERPROFILE 'Documents')
)) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^kstream(-portable)?\.exe$' } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
  Remove-Item -LiteralPath (Join-Path $root 'kstream-portable.json') -Force
  Remove-TreeRetry (Join-Path $root 'kstream-portable')
  Remove-TreeRetry (Join-Path $root 'kstream-data')
}

exit 0
