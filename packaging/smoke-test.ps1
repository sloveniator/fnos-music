# GuSi Music - server smoke test (.NET HttpClient, PS 5.1/7 compatible, ASCII only)
# Usage: powershell -File packaging\smoke-test.ps1 [-Port 19530]
param([int]$Port = 19530)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot   # fnos-music/
$ServerDir = Join-Path $Root 'server'
$DataDir = Join-Path $env:TEMP "gusi-smoke-$Port"
$AccFile = Join-Path $env:TEMP "gusi-smoke-access-$Port.env"
$Pass = 'smoke-test-pw'

if (Test-Path $DataDir) { Remove-Item $DataDir -Recurse -Force }
$env:PORT = "$Port"
$env:BIND_IP = '127.0.0.1'
$env:GS_ADMIN_PASSWORD = $Pass
$env:DATA_PATH = $DataDir
$env:GS_WEB_STATIC_DIR = Join-Path $Root 'ui\dist'
$env:GS_ACCESSIBLE_PATHS_FILE = $AccFile

$proc = Start-Process node -ArgumentList 'index.js' -WorkingDirectory $ServerDir -PassThru `
  -RedirectStandardOutput "$env:TEMP\gusi-smoke-out.log" -RedirectStandardError "$env:TEMP\gusi-smoke-err.log" -WindowStyle Hidden

$Base = "http://127.0.0.1:$Port"
$fail = 0

# Unified HTTP client: no auto-redirect, non-2xx does NOT throw (unlike Invoke-WebRequest)
Add-Type -AssemblyName System.Net.Http
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AllowAutoRedirect = $false
$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromSeconds(10)

function Http([string]$Method, [string]$Uri, [hashtable]$Headers, $Body) {
  $req = New-Object System.Net.Http.HttpRequestMessage((New-Object System.Net.Http.HttpMethod($Method)), $Uri)
  if ($Headers) {
    foreach ($k in $Headers.Keys) { $req.Headers.TryAddWithoutValidation($k, [string]$Headers[$k]) | Out-Null }
  }
  if (-not [string]::IsNullOrEmpty($Body)) {
    $req.Content = New-Object System.Net.Http.StringContent($Body, [Text.Encoding]::UTF8, 'application/json')
  }
  $resp = $client.SendAsync($req).GetAwaiter().GetResult()
  $respBody = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  $loc = $null
  if ($resp.Headers.Location -ne $null) { $loc = $resp.Headers.Location.ToString() }
  return @{ Status = [int]$resp.StatusCode; Body = $respBody; Location = $loc }
}

function Check($name, $cond) {
  if ($cond) { Write-Host ("  PASS  " + $name) -ForegroundColor Green }
  else { Write-Host ("  FAIL  " + $name) -ForegroundColor Red; $script:fail++ }
}

try {
  Start-Sleep 3

  # 1. protocol handshake
  $r = Http 'GET' "$Base/hello" $null $null
  Check '/hello v4 handshake' ($r.Body -eq 'Hello~::^-^::~v4~')

  $r = Http 'GET' "$Base/id" $null $null
  Check '/id prefix' ($r.Body.StartsWith('OjppZDo6'))

  # 2. admin login
  $r = Http 'POST' "$Base/admin/login" $null ('{"password":"' + $Pass + '"}')
  $login = $r.Body | ConvertFrom-Json
  Check 'admin login token' ($login.token.Length -ge 32)
  $hdr = @{ 'X-Admin-Token' = $login.token }

  $r = Http 'POST' "$Base/admin/login" $null '{"password":"wrong"}'
  Check 'wrong password rejected' ($r.Status -eq 401)

  # 3. user CRUD
  $r = Http 'POST' "$Base/admin/api/users" $hdr '{"name":"smokeuser","password":"pw-smoke-001"}'
  Check 'create user' ($r.Status -eq 200 -and (($r.Body | ConvertFrom-Json).success -eq $true))

  $r = Http 'POST' "$Base/admin/api/users" $hdr '{"name":"smokeuser","password":"pw-other-01"}'
  Check 'duplicate name rejected' ($r.Status -eq 400)

  $r = Http 'GET' "$Base/admin/api/users" $hdr $null
  $users = ($r.Body | ConvertFrom-Json).users
  Check 'list contains user' (@($users | Where-Object { $_.name -eq 'smokeuser' }).Count -ge 1)

  $r = Http 'POST' "$Base/admin/api/users/smokeuser/password" $hdr '{"password":"pw-smoke-002"}'
  Check 'reset password' ($r.Status -eq 200)

  $r = Http 'GET' "$Base/admin/api/users/smokeuser/devices" $hdr $null
  Check 'devices empty list' ((($r.Body | ConvertFrom-Json).devices).Count -eq 0)

  # 4. static UI
  $r = Http 'GET' "$Base/admin" $null $null
  Check '/admin 302 redirect' ($r.Status -eq 302 -and $r.Location -eq '/admin/')

  $r = Http 'GET' "$Base/" $null $null
  Check 'root 302 to /admin/' ($r.Status -eq 302 -and $r.Location -eq '/admin/')

  $r = Http 'GET' "$Base/admin/" $null $null
  Check 'UI index 200' ($r.Status -eq 200 -and $r.Body.Length -gt 500)

  $r = Http 'GET' "$Base/admin/assets/admin.css" $null $null
  Check 'assets css 200' ($r.Status -eq 200 -and $r.Body.Length -gt 1000)

  $r = Http 'GET' "$Base/admin/assets/admin.js" $null $null
  Check 'assets js 200' ($r.Status -eq 200 -and $r.Body.Length -gt 1000)

  $r = Http 'GET' "$Base/admin/assets/icon.png" $null $null
  Check 'favicon 200' ($r.Status -eq 200 -and $r.Body.Length -gt 100)

  $r = Http 'GET' "$Base/admin/assets/..%2f..%2fserver%2fconfig.js" $null $null
  Check 'path traversal blocked' ($r.Status -ne 200)

  # 5. auth boundary
  $r = Http 'GET' "$Base/admin/api/users" $null $null
  Check 'no token -> 401' ($r.Status -eq 401)

  $r = Http 'GET' "$Base/admin/api/users" @{ 'X-Admin-Token' = 'deadbeef' } $null
  Check 'bad token -> 401' ($r.Status -eq 401)

  # 6. status endpoint (bare object {status,users,...})
  $r = Http 'GET' "$Base/admin/api/status" $hdr $null
  $st = $r.Body | ConvertFrom-Json
  Check 'status running' ($r.Status -eq 200 -and $st.status -eq $true -and $st.users -ge 1)

  # 7. persistence
  $usersFile = Join-Path $DataDir 'admin-users.json'
  $store = (Get-Content $usersFile -Raw) | ConvertFrom-Json
  Check 'persisted admin-users.json' (@($store.users | Where-Object { $_.name -eq 'smokeuser' }).Count -ge 1)

  # 8. delete user
  $r = Http 'DELETE' "$Base/admin/api/users/smokeuser" $hdr $null
  $r2 = Http 'GET' "$Base/admin/api/users" $hdr $null
  $users2 = ($r2.Body | ConvertFrom-Json).users
  Check 'delete user' ($r.Status -eq 200 -and @($users2 | Where-Object { $_.name -eq 'smokeuser' }).Count -eq 0)

  # ---------------- library (NAS music library) ----------------
  # build a small fake library on disk (ASCII names; parser is language-agnostic)
  $MusicDir = Join-Path $DataDir 'music'
  New-Item -ItemType Directory -Force -Path (Join-Path $MusicDir 'ArtistA\AlbumOne') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $MusicDir 'misc') | Out-Null
  $song1 = Join-Path $MusicDir 'ArtistA\AlbumOne\01 - First Song.mp3'
  $song2 = Join-Path $MusicDir 'ArtistA\AlbumOne\02 - Second Song.mp3'
  $song3 = Join-Path $MusicDir 'Bob - Hello World.mp3'
  $song4 = Join-Path $MusicDir 'misc\track04.flac'
  $bytes = New-Object byte[] 2048
  $rnd = New-Object Random
  $rnd.NextBytes($bytes)
  [IO.File]::WriteAllBytes($song1, $bytes)
  [IO.File]::WriteAllBytes($song2, $bytes)
  [IO.File]::WriteAllBytes($song3, $bytes)
  [IO.File]::WriteAllBytes($song4, $bytes)

  # 9. settings
  $r = Http 'POST' "$Base/admin/api/library/settings" $hdr ('{"dirs":["' + ($MusicDir -replace '\\','\\') + '"]}')
  $saved = ($r.Body | ConvertFrom-Json).data
  Check 'library settings save' ($r.Status -eq 200 -and @($saved.dirs).Count -eq 1)

  # 10. scan + poll
  $r = Http 'POST' "$Base/admin/api/library/scan" $hdr $null
  Check 'scan accepted' ($r.Status -eq 200)
  $trackCount = 0
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    $r = Http 'GET' "$Base/admin/api/library/stats" $hdr $null
    $st = ($r.Body | ConvertFrom-Json).data
    $trackCount = $st.tracks
    if ($st.scan.scanning -eq $false -and $trackCount -ge 4) { break }
  }
  Check 'scan found 4 tracks' ($trackCount -ge 4)

  # 11. metadata parsing: folder ArtistA/AlbumOne + track number
  $r = Http 'GET' "$Base/admin/api/library/tracks?q=First" $hdr $null
  $page = ($r.Body | ConvertFrom-Json).data
  $t1 = @($page.tracks | Where-Object { $_.name -eq 'First Song' })[0]
  Check 'folder-based artist/album' ($t1.singer -eq 'ArtistA' -and $t1.album -eq 'AlbumOne')
  Check 'track number parsed' ($t1.trackNum -eq 1)

  # filename "Bob - Hello World"
  $r = Http 'GET' "$Base/admin/api/library/tracks?q=Hello" $hdr $null
  $t3 = @(($r.Body | ConvertFrom-Json).data.tracks | Where-Object { $_.name -eq 'Hello World' })[0]
  Check 'filename artist parsed' ($t3.singer -eq 'Bob')

  # 12. stream auth boundary
  $r = Http 'GET' "$Base/admin/api/library/stream-token" $hdr $null
  $tok = ($r.Body | ConvertFrom-Json).data.token
  Check 'stream token issued' ($tok.Length -ge 32)

  $r = Http 'GET' "$Base/api/stream/$($t1.id)" $null $null
  Check 'stream no token -> 403' ($r.Status -eq 403)

  $r = Http 'GET' "$Base/api/stream/$($t1.id)?k=$tok" $null $null
  Check 'stream 200 full' ($r.Status -eq 200 -and $r.Body.Length -gt 0)

  $r = Http 'GET' "$Base/api/stream/$($t1.id)?k=$tok" @{ 'Range' = 'bytes=0-99' } $null
  Check 'stream range 206' ($r.Status -eq 206)

  $r = Http 'GET' "$Base/api/stream/deadbeef00000000?k=$tok" $null $null
  Check 'stream unknown id -> 404' ($r.Status -eq 404)

  # 13. search API
  $r = Http 'GET' "$Base/api/search?q=Second&k=$tok" $null $null
  $hits = ($r.Body | ConvertFrom-Json).data
  Check 'search api' ($r.Status -eq 200 -and @($hits).Count -ge 1)

  # 14. lyric api (no lrc -> empty lyric, code 0)
  $r = Http 'GET' "$Base/api/lyric/$($t1.id)?k=$tok" $null $null
  $lyr = $r.Body | ConvertFrom-Json
  Check 'lyric api' ($r.Status -eq 200 -and $lyr.code -eq 0)

  # 15. export .lxmc
  $ids = '["' + $t1.id + '","' + $t3.id + '"]'
  $r = Http 'POST' "$Base/admin/api/library/export" $hdr ('{"name":"Smoke List","ids":' + $ids + '}')
  $exp = $r.Body | ConvertFrom-Json
  Check 'export playListPart_v2' ($exp.type -eq 'playListPart_v2' -and @($exp.data.list).Count -eq 2)
  Check 'export local source song' ($exp.data.list[0].source -eq 'local' -and $exp.data.list[0].meta.songId.Length -ge 8)

  # 16. source script
  $r = Http 'GET' "$Base/admin/api/library/source-script" $hdr $null
  Check 'source script generated' ($r.Status -eq 200 -and $r.Body.Contains('lx.send') -and $r.Body.Contains('/api/stream/'))
  Check 'source script direct base' ($r.Body.Contains(':' + $Port + '"'))
  Check 'source script downloadUrl action' ($r.Body.Contains('downloadUrl') -and $r.Body.Contains('/api/download/'))

  # 16b. generic container dirs skipped (【Music】 style folder is not an artist)
  $G = Join-Path $MusicDir '【Music】'
  New-Item -ItemType Directory -Force -Path (Join-Path $G '容器歌手\某专辑') | Out-Null
  [IO.File]::WriteAllBytes((Join-Path $G '容器歌手\某专辑\01 - 测试歌.mp3'), (New-Object byte[] 2048))
  $r = Http 'POST' "$Base/admin/api/library/scan" $hdr $null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $r = Http 'GET' "$Base/admin/api/library/stats" $hdr $null
    if ((($r.Body | ConvertFrom-Json).data.scan).scanning -eq $false) { break }
  }
  $r = Http 'GET' "$Base/admin/api/library/tracks?q=%E6%B5%8B%E8%AF%95" $hdr $null
  $pageG = ($r.Body | ConvertFrom-Json).data
  $tg = @($pageG.tracks | Where-Object { $_.name -eq '测试歌' })[0]
  Check 'generic 【Music】 container skipped as artist' ($tg.singer -eq '容器歌手' -and $tg.album -eq '某专辑')

  # 16b2. upload raw audio -> auto re-scan -> appears in library
  $upBytes = New-Object byte[] 4096
  $rnd2 = New-Object Random
  $rnd2.NextBytes($upBytes)
  $upName = 'uploaded_%E5%AE%9A.mp3'   # uploaded_定.mp3 (URL-encoded)
  $upReq = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Put, "$Base/admin/api/library/upload?name=$upName&dir=")
  $upReq.Headers.TryAddWithoutValidation('X-Admin-Token', $login.token) | Out-Null
  $upReq.Content = New-Object System.Net.Http.ByteArrayContent(,$upBytes)
  $upResp = $client.SendAsync($upReq).GetAwaiter().GetResult()
  $upBody = $upResp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  $upJson = $upBody | ConvertFrom-Json
  Check 'upload accepted (PUT raw)' ($upResp.StatusCode -eq 200 -and $upJson.code -eq 0)
  $foundUp = $false
  for ($i = 0; $i -lt 30 -and -not $foundUp; $i++) {
    Start-Sleep -Milliseconds 500
    $r = Http 'GET' "$Base/admin/api/library/tracks?q=%E5%AE%9A" $hdr $null
    if (@(($r.Body | ConvertFrom-Json).data.tracks).Count -ge 1) { $foundUp = $true }
  }
  Check 'uploaded file auto rescanned into library' ($foundUp)

  # 16c. web consumer API
  $r = Http 'POST' "$Base/admin/api/users" $hdr '{"name":"webuser","password":"web-pass-001"}'
  $r = Http 'POST' "$Base/web/login" $null '{"name":"webuser","password":"wrong-pass"}'
  Check 'web login wrong pass 401' ($r.Status -eq 401)
  $r = Http 'POST' "$Base/web/login" $null '{"name":"webuser","password":"web-pass-001"}'
  $wt = (($r.Body | ConvertFrom-Json).data).token
  Check 'web login ok' ($r.Status -eq 200 -and $wt.Length -ge 32)
  $whdr = @{ 'X-Web-Token' = $wt }
  $r = Http 'GET' "$Base/web/api/playlists" $whdr $null
  $pl = $r.Body | ConvertFrom-Json
  Check 'web playlists' ($r.Status -eq 200 -and @($pl.data.playlists).Count -ge 2)
  $r = Http 'GET' "$Base/web/api/albums" $whdr $null
  Check 'web albums' ($r.Status -eq 200)
  $r = Http 'GET' "$Base/web/api/playlists" $null $null
  Check 'web no token 401' ($r.Status -eq 401)
  $r = Http 'POST' "$Base/web/api/love/toggle" $whdr ('{"trackId":"' + $t1.id + '"}')
  Check 'web love toggle' ($r.Status -eq 200 -and (($r.Body | ConvertFrom-Json).data).loved -eq $true)
  $r = Http 'POST' "$Base/web/api/playlists" $whdr '{"name":"Smoke Web List"}'
  $wpl = (($r.Body | ConvertFrom-Json).data).id
  Check 'web playlist create' ($wpl.StartsWith('userlist_web_'))
  $r = Http 'POST' "$Base/web/api/playlists/$wpl/add" $whdr ('{"trackIds":["' + $t1.id + '"]}')
  Check 'web playlist add' (($r.Body | ConvertFrom-Json).data.added -eq 1)
  $r = Http 'GET' "$Base/web/api/playlists/$wpl" $whdr $null
  $pld = $r.Body | ConvertFrom-Json
  Check 'web playlist detail' (@($pld.data.tracks).Count -eq 1 -and $pld.data.tracks[0].trackId -eq $t1.id)
  # P0-6: playlist reorder (add second track, reverse order, verify)
  $r = Http 'POST' "$Base/web/api/playlists/$wpl/add" $whdr ('{"trackIds":["' + $t3.id + '"]}')
  $r = Http 'GET' "$Base/web/api/playlists/$wpl" $whdr $null
  $two = @(($r.Body | ConvertFrom-Json).data.tracks)
  Check 'web playlist two tracks' ($two.Count -eq 2)
  $rev = @($two[1].id, $two[0].id)
  $orderBody = '{"musicIds":["' + ($rev -join '","') + '"]}'
  $r = Http 'POST' "$Base/web/api/playlists/$wpl/order" $whdr $orderBody
  Check 'web playlist order ok' ($r.Status -eq 200 -and (($r.Body | ConvertFrom-Json).code -eq 0))
  $r = Http 'GET' "$Base/web/api/playlists/$wpl" $whdr $null
  $after = @((($r.Body | ConvertFrom-Json).data.tracks | ForEach-Object { $_.id }))
  Check 'web playlist reordered' ($after.Count -eq 2 -and $after[0] -eq $rev[0] -and $after[1] -eq $rev[1])
  $r = Http 'GET' "$Base/web/media/stream/$($t1.id)?k=$wt" $null $null
  Check 'web media stream' ($r.Status -eq 200)
  $r = Http 'GET' "$Base/web/media/stream/$($t1.id)" $null $null
  Check 'web media no session 401' ($r.Status -eq 401)

  # 16b. fnOS system authorized dirs: snapshot file hot-read (P0-2, no restart needed)
  Set-Content -Path $AccFile -Value "TRIM_DATA_ACCESSIBLE_PATHS='/vol1/1000/gusi-test-a'" -Encoding Ascii
  $r = Http 'GET' "$Base/admin/api/library/system-dirs" $hdr $null
  $sd = ($r.Body | ConvertFrom-Json).data
  Check 'system-dirs from file' ($sd.dirs.Count -eq 1 -and $sd.dirs[0] -eq '/vol1/1000/gusi-test-a')
  Set-Content -Path $AccFile -Value "TRIM_DATA_ACCESSIBLE_PATHS='/vol1/1000/gusi-test-a:/vol2/1000/gusi-test-b'" -Encoding Ascii
  $r = Http 'GET' "$Base/admin/api/library/system-dirs" $hdr $null
  $sd = ($r.Body | ConvertFrom-Json).data
  Check 'system-dirs hot reload' ($sd.dirs.Count -eq 2 -and $sd.dirs[1] -eq '/vol2/1000/gusi-test-b')

  # 17. proxy without upstream -> code -1
  $r = Http 'GET' "$Base/api/proxy?source=wy&id=123&k=$tok" $null $null
  $px = $r.Body | ConvertFrom-Json
  Check 'proxy unconfigured rejected' ($px.code -eq -1)

  # 18. admin login rate limit (P0-1): earlier 1 wrong attempt + 9 more = 10 -> blocked
  for ($i = 0; $i -lt 9; $i++) { Http 'POST' "$Base/admin/login" $null '{"password":"wrong"}' | Out-Null }
  $r = Http 'POST' "$Base/admin/login" $null ('{"password":"' + $Pass + '"}')
  Check 'admin login rate limited 429' ($r.Status -eq 429)
  # web login bucket independent (not prefixed) -> still works
  $r = Http 'POST' "$Base/web/login" $null '{"name":"webuser","password":"web-pass-001"}'
  Check 'web login unaffected by admin bucket' ($r.Status -eq 200)
}
catch {
  Write-Host ("EXCEPTION: " + $_.Exception.Message) -ForegroundColor Red
  $fail++
}
finally {
  try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
  $client.Dispose()
}

Write-Host ''
if ($fail -eq 0) { Write-Host 'SMOKE TEST: ALL PASSED' -ForegroundColor Green }
else { Write-Host ("SMOKE TEST: " + $fail + " FAILED") -ForegroundColor Red; exit 1 }
