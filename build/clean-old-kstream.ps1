# Wipe previous kstream app installs so Setup can land a clean latest copy.
# Keeps roaming user data (login / bookmarks) under %APPDATA%\kstream.
$ErrorActionPreference = 'SilentlyContinue'

function Remove-Tree([string]$Path) {
  if (-not $Path) { return }
  if (-not (Test-Path -LiteralPath $Path)) { return }
  cmd /c "rmdir /s /q `"$Path`"" | Out-Null
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

Get-CimInstance Win32_Process -Filter "Name = 'kstream.exe'" -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 900

$dirs = New-Object System.Collections.Generic.List[string]
foreach ($name in @('kstream', 'kstream.bak', 'kstream-portable')) {
  $dirs.Add((Join-Path $env:LOCALAPPDATA "Programs\$name"))
}

Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'kstream*' } |
  ForEach-Object { $dirs.Add($_.FullName) }

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
  Remove-Tree $dir
}

Remove-Item (Join-Path $env:USERPROFILE 'Desktop\kstream.lnk') -Force
Remove-Item (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\kstream.lnk') -Force

Remove-Tree (Join-Path $env:LOCALAPPDATA 'kstream-updater')
Get-ChildItem $env:TEMP -Filter 'kstream-Setup.exe' -ErrorAction SilentlyContinue |
  Remove-Item -Force

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
  Remove-Tree (Join-Path $root 'kstream-portable')
  Remove-Tree (Join-Path $root 'kstream-data')
}

exit 0
