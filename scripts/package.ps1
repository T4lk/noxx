# Builds the NSIS installer and the portable zip into dist/.
# Usage (from the repo root): powershell -ExecutionPolicy Bypass -File scripts/package.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tauri = Join-Path $root 'src-tauri'
$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $tauri 'target' }
$version = (Get-Content (Join-Path $tauri 'tauri.conf.json') -Raw | ConvertFrom-Json).version

Push-Location $tauri
try {
  npx --yes @tauri-apps/cli@^2 build --bundles nsis
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed ($LASTEXITCODE)" }
} finally { Pop-Location }

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null

# Installer
$setup = Get-ChildItem (Join-Path $target 'release/bundle/nsis') -Filter '*-setup.exe' | Select-Object -First 1
Copy-Item $setup.FullName (Join-Path $dist "noxx_${version}_x64-setup.exe") -Force

# Portable: the exe plus a `portable` marker, so data stays in .\data next to it
$stage = Join-Path $dist 'portable'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force (Join-Path $stage 'noxx') | Out-Null
Copy-Item (Join-Path $target 'release/noxx.exe') (Join-Path $stage 'noxx/noxx.exe')
Set-Content -Encoding ascii (Join-Path $stage 'noxx/portable') 'This file makes noxx portable: settings, library and login are kept in the data folder next to noxx.exe. Delete it to use %APPDATA% instead.'
$zip = Join-Path $dist "noxx_${version}_x64-portable.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path (Join-Path $stage 'noxx') -DestinationPath $zip
Remove-Item -Recurse -Force $stage

Get-ChildItem $dist | Format-Table Name, Length
