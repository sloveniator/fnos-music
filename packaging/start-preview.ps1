$ErrorActionPreference = 'Stop'
$Data = Join-Path $env:TEMP 'gusi-preview-19990'
$Root = Split-Path -Parent $PSScriptRoot
$env:PORT = '19990'
$env:BIND_IP = '127.0.0.1'
$env:GS_ADMIN_PASSWORD = 'preview-pw'
$env:DATA_PATH = $Data
$env:GS_WEB_STATIC_DIR = Join-Path $Root 'ui\dist'
$env:GS_APP_STATIC_DIR = Join-Path $Root 'ui\app'
$env:GS_ACCESSIBLE_PATHS_FILE = Join-Path $env:TEMP 'gusi-preview-access.env'
Start-Process node -ArgumentList 'index.js' -WorkingDirectory (Join-Path $Root 'server') -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $Data 'preview-out.log') -RedirectStandardError (Join-Path $Data 'preview-err.log')
Write-Host 'preview server starting on 19990'
