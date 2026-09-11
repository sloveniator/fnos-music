@echo off
setlocal
set "NODE_ENV=production"
set "PORT=19990"
set "BIND_IP=127.0.0.1"
set "GS_ADMIN_PASSWORD=preview-pw"
set "DATA_PATH=%TEMP%\gusi-preview-19990"
set "GS_WEB_STATIC_DIR=C:\Users\Administrator\.qwenpaw\workspaces\default\fnos-music\ui\dist"
set "GS_APP_STATIC_DIR=C:\Users\Administrator\.qwenpaw\workspaces\default\fnos-music\ui\app"
set "GS_ACCESSIBLE_PATHS_FILE=%TEMP%\gusi-preview-access.env"
cd /d "C:\Users\Administrator\.qwenpaw\workspaces\default\fnos-music\server"
node index.js >> "%TEMP%\gusi-preview-19990\preview-out.log" 2>> "%TEMP%\gusi-preview-19990\preview-err.log"
