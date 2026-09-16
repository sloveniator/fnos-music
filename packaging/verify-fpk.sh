#!/bin/bash
# GuSi Music — fpk 交付前验证（需 root；在临时存储空间里跑完整生命周期）
#
# 覆盖：包结构/校验和 → 安装 → 启动（捆绑 Node 运行时）→ HTTP 自检 → 状态/停止
#       → 升级（数据与运行时复用）→ 卸载保留 → 重装沿用端口 → 卸载彻底删除
#       → 路径动态解析（不预设任何 /vol 编号、解析不出就不动手）
#
# 用法：
#   sudo bash packaging/verify-fpk.sh [--fpk <path>] [--vol-root /vol9] [--port 43801] [--keep]
#
# 安全：--vol-root 指向的路径必须**不存在**，否则直接退出（绝不动真实存储空间）；
#       结束时只删除本次自己创建的目录，--keep 可保留现场。
set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FPK=""
VOL_ROOT=""
PORT=43801
KEEP=0
PKG_USER=gusi.music

while [ $# -gt 0 ]; do
  case "$1" in
    --fpk) FPK="${2:-}"; shift 2 ;;
    --vol-root) VOL_ROOT="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

[ -n "${FPK}" ] || FPK="$(ls -1t "${REPO_ROOT}"/packaging/out/*.fpk 2>/dev/null | head -n 1)"
[ -n "${VOL_ROOT}" ] || VOL_ROOT="/vol1"
while [ -e "${VOL_ROOT}" ]; do
  next=$(( ${VOL_ROOT#/vol} + 1 ))
  echo "[info] ${VOL_ROOT} 已存在，改用 /vol${next}（不触碰已有数据）"
  VOL_ROOT="/vol${next}"
done

[ "$(id -u)" -eq 0 ] || { echo "需要 root（创建包用户与存储空间）；请用 sudo 运行"; exit 2; }
[ -f "${FPK}" ] || { echo "找不到 fpk: ${FPK}"; exit 2; }
case "${VOL_ROOT}" in /vol[0-9]|/vol[0-9][0-9]|/vol[0-9][0-9][0-9]) ;; *) echo "--vol-root 必须是 /vol<N> 形态：${VOL_ROOT}"; exit 2 ;; esac

APP_ROOT="${VOL_ROOT}/@appstore/gusi.music"
APPDEST="${APP_ROOT}/target"
PKGVAR="${VOL_ROOT}/@appdata/gusi.music/var"
SHARE="${VOL_ROOT}/@appshare/gusi.music"
MEDIA="${VOL_ROOT}/media"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
check() { # check <描述> <实际> <期望>
  if [ "$2" = "$3" ]; then ok "$1 (= $2)"; else bad "$1: 实际=$2 期望=$3"; fi
}
step() { printf '\n──── %s ────\n' "$1"; }
cleanup() {
  if [ "${KEEP}" -eq 0 ]; then
    pkill -f "node ${APPDEST}/server/index.js" >/dev/null 2>&1 || true
    rm -rf "${VOL_ROOT}" >/dev/null 2>&1 || true
    echo; echo "[info] 已清理 ${VOL_ROOT}（--keep 可保留）"
  else
    echo; echo "[info] 现场保留在 ${VOL_ROOT}"
  fi
}
trap cleanup EXIT

echo "验证目标: ${FPK}"
echo "模拟存储空间: ${VOL_ROOT}（安装目录 ${APP_ROOT}）"

step "1. 包结构"
ENTRIES="$(tar -tzf "${FPK}")"
for required in manifest app.tgz LICENSE cmd/main cmd/install_init cmd/install_callback \
                cmd/config_callback cmd/uninstall_callback cmd/upgrade_init cmd/runtime_paths.sh \
                config/privilege config/resource wizard/install wizard/uninstall ICON.PNG ICON_256.PNG; do
  if printf '%s\n' "${ENTRIES}" | grep -qx "${required}"; then ok "条目存在 ${required}"; else bad "缺少条目 ${required}"; fi
done
if tar -tvzf "${FPK}" | grep -E "^-rwx.*cmd/main$" >/dev/null; then ok "cmd/main 可执行位"; else bad "cmd/main 缺少可执行位"; fi

# 包体合规：与飞牛官方打包器（fnpack 1.2.3）产物对齐 —— 无世界可写条目、无指向打包机的绝对软链接
WW_OUTER="$(tar -tvzf "${FPK}" | grep -cE '^[-d].{4}w|^[-d].{7}w' || true)"
check "外壳无世界可写条目（组/他人写位）" "${WW_OUTER}" "0"
WW_INNER="$(tar -xzOf "${FPK}" app.tgz | tar -tvzf - | grep -cE '^[-d].{4}w|^[-d].{7}w' || true)"
check "app.tgz 内无世界可写条目" "${WW_INNER}" "0"
ABS_LINK="$(tar -xzOf "${FPK}" app.tgz | tar -tvzf - | grep -c ' -> /' || true)"
check "app.tgz 内无指向打包机的绝对软链接" "${ABS_LINK}" "0"
BAD_NAME="$(tar -tzf "${FPK}" | grep -cE '^/|(^|/)\.\.(/|$)' || true)"
check "外壳无绝对/穿越条目名" "${BAD_NAME}" "0"
DIR_MODE="$(tar -tvzf "${FPK}" | awk '$1 ~ /^d/ {print $1}' | sort -u | tr '\n' ',')"
check "外壳目录权限规整" "${DIR_MODE}" "drwxr-xr-x,"
MANIFEST_CHECKSUM="$(tar -xzOf "${FPK}" manifest | awk -F' *= *' '/^checksum/{print $2}')"
APP_MD5="$(tar -xzOf "${FPK}" app.tgz | md5sum | awk '{print $1}')"
check "manifest checksum = app.tgz md5" "${MANIFEST_CHECKSUM}" "${APP_MD5}"
APP_TOP="$(tar -xzOf "${FPK}" app.tgz | tar -tzf - | awk -F/ '{print $1}' | sort -u | tr '\n' ',')"
check "app.tgz 顶层内容" "${APP_TOP}" "config,server,ui,"
if tar -xzOf "${FPK}" app.tgz | tar -tzf - | grep -qx 'server/config.json'; then ok "app.tgz 含 server/config.json"; else bad "app.tgz 缺 server/config.json"; fi
if tar -xzOf "${FPK}" app.tgz | tar -tzf - | grep -qx 'server/offline/node-linux-x64.tar.gz'; then ok "app.tgz 含捆绑 Node 运行时"; else bad "app.tgz 缺捆绑 Node 运行时"; fi

step "2. 展开为 fnOS 目录形态"
id "${PKG_USER}" >/dev/null 2>&1 || useradd -M -s /usr/sbin/nologin "${PKG_USER}"
PKG_UID="$(id -u "${PKG_USER}")"
mkdir -p "${APPDEST}" "${SHARE}" "${MEDIA}" "${PKGVAR}"
printf 'fake-mp3' > "${MEDIA}/sample.mp3"
tar -xzf "${FPK}" -C "${APP_ROOT}"
tar -xzf "${FPK}" -C "${APP_ROOT}" app.tgz
tar -xzf "${APP_ROOT}/app.tgz" -C "${APPDEST}"
rm -f "${APP_ROOT}/app.tgz"
chown -R "${PKG_USER}:${PKG_USER}" "${VOL_ROOT}/@appstore" "${VOL_ROOT}/@appdata" "${VOL_ROOT}/@appshare" "${MEDIA}"
chmod 755 "${VOL_ROOT}"
if [ -x "${APP_ROOT}/cmd/main" ]; then ok "生命周期脚本已就位且可执行"; else bad "cmd/main 不可执行"; fi

lifecycle() { # lifecycle <脚本名> [参数...]；WIZARD_ENV 数组作为向导变量注入
  local name="$1"; shift
  runuser -u "${PKG_USER}" -- env \
    TRIM_APPNAME=gusi.music TRIM_APPVER="$(tar -xzOf "${FPK}" manifest | awk -F' *= *' '/^version/{print $2}')" \
    TRIM_APPDEST="${APPDEST}" TRIM_PKGVAR="${PKGVAR}" \
    TRIM_USERNAME="${PKG_USER}" TRIM_GROUPNAME="${PKG_USER}" TRIM_UID="${PKG_UID}" \
    TRIM_DATA_SHARE_PATHS="${SHARE}" TRIM_DATA_ACCESSIBLE_PATHS="${MEDIA}" \
    TRIM_SERVICE_PORT="${PORT}" TRIM_TEMP_LOGFILE="/tmp/gusi-verify-templog.txt" \
    "${WIZARD_ENV[@]}" \
    /bin/bash "${APP_ROOT}/cmd/${name}" "$@"
}
WIZARD_ENV=(wizard_app_port="${PORT}" wizard_admin_password=verify-secret)

step "3. install_init / install_callback"
lifecycle install_init; check "install_init 退出码" "$?" "0"
lifecycle install_callback; check "install_callback 退出码" "$?" "0"
check "私有配置里的端口" "$(sed -n "s/^WIZARD_APP_PORT='\(.*\)'$/\1/p" "${PKGVAR}/app-config.env")" "${PORT}"
check "安装档案落盘（${VOL_ROOT}/@appshare）" "$([ -f "${SHARE}/install-profile.env" ] && echo yes || echo no)" "yes"

# fnOS 未下发 TRIM_DATA_SHARE_PATHS 时也不能因 set -u 直接死掉
( unset TRIM_DATA_SHARE_PATHS
  runuser -u "${PKG_USER}" -- env TRIM_APPNAME=gusi.music TRIM_APPDEST="${APPDEST}" TRIM_PKGVAR="${PKGVAR}" \
    TRIM_USERNAME="${PKG_USER}" TRIM_GROUPNAME="${PKG_USER}" TRIM_UID="${PKG_UID}" \
    TRIM_SERVICE_PORT="${PORT}" wizard_app_port="${PORT}" \
    /bin/bash "${APP_ROOT}/cmd/install_callback" >/dev/null 2>&1 )
check "未下发共享目录时 install_callback 仍成功" "$?" "0"

step "4. 启动（捆绑 Node 运行时 + 网关 socket + 授权目录诊断）"
lifecycle main start; check "main start 退出码" "$?" "0"
sleep 3
check "HTTP /（消费者应用）" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/")" "200"
check "HTTP /admin/（管理后台）" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/admin/")" "200"
check "HTTP /admin（无尾斜杠 → 302 补斜杠）" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/admin")" "302"
check "HTTP /admin 302 目标可跟随" "$(curl -sL -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/admin")" "200"
# 分享页构件必须进包：漏拷时 /s/assets/* 全 404（页面能开、样式与播放器全废）
check "HTTP /s/assets/share.css（分享页样式）" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/s/assets/share.css")" "200"
check "HTTP /s/assets/share.js（分享页脚本）" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/s/assets/share.js")" "200"
check "网关 socket 已建立" "$([ -S "${APPDEST}/app.sock" ] && echo yes || echo no)" "yes"
# 经 fnOS 网关（unix socket + /app/gusi-music 前缀）：前缀必须被服务端剥掉，且页面里的
# 资源路径必须带前缀回填，否则浏览器会打到网关根路径 404
SOCK="http://localhost"
check "网关 socket：/app/gusi-music/（消费者应用）" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --unix-socket "${APPDEST}/app.sock" "${SOCK}/app/gusi-music/")" "200"
check "网关 socket：/app/gusi-music（无尾斜杠 → 302）" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --unix-socket "${APPDEST}/app.sock" "${SOCK}/app/gusi-music")" "302"
check "网关 socket：/app/gusi-music/admin/（管理后台）" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --unix-socket "${APPDEST}/app.sock" "${SOCK}/app/gusi-music/admin/")" "200"
check "网关 socket：/app/gusi-music/admin/assets/admin.js" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --unix-socket "${APPDEST}/app.sock" "${SOCK}/app/gusi-music/admin/assets/admin.js")" "200"
# 后台接口经网关必须是 401（未授权）而不是 404（前缀走丢）
check "网关 socket：/app/gusi-music/admin/api/status 不是 404" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --unix-socket "${APPDEST}/app.sock" "${SOCK}/app/gusi-music/admin/api/status")" "401"
check "分享页 HTML 资源路径带网关前缀" "$(curl -s --max-time 5 --unix-socket "${APPDEST}/app.sock" "${SOCK}/app/gusi-music/s/nonexistent" | grep -c 'href="/app/gusi-music/s/assets/share.css"')" "1"
# 静态检查：后台前端不得再出现不带前缀的绝对 /admin 请求
check "admin.js 无裸 /admin 请求" "$(grep -c "fetch('/admin" "${APPDEST}/ui/dist/assets/admin.js")" "0"
check "share.js 的 API 基址带前缀变量" "$(grep -c "var API = PREFIX + '/s/' + CODE" "${APPDEST}/ui/share/share.js")" "1"
check "使用的是捆绑 Node 运行时" "$(grep -c 'Bundled node runtime is ready' "${PKGVAR}/info.log")" "1"
if "${PKGVAR}/runtime/node/node" -v >/dev/null 2>&1; then ok "捆绑运行时可直接执行（$("${PKGVAR}/runtime/node/node" -v)）"; else bad "捆绑运行时无法执行"; fi
check "授权目录被识别为可读写" "$([ "$(grep -c 'AUTH_PATH_OK' "${PKGVAR}/info.log")" -ge 1 ] && echo yes || echo no)" "yes"
SERVER_PID="$(cat "${PKGVAR}/app.pid" 2>/dev/null)"
check "PID 文件有效" "$([ -n "${SERVER_PID}" ] && kill -0 "${SERVER_PID}" 2>/dev/null && echo yes || echo no)" "yes"
check "数据目录已初始化" "$([ -d "${PKGVAR}/data/users" ] && echo yes || echo no)" "yes"

step "5. main status / stop"
lifecycle main status; check "main status 退出码" "$?" "0"
lifecycle main stop; check "main stop 退出码" "$?" "0"
sleep 1
check "停止后无残留服务进程" "$(kill -0 "${SERVER_PID}" 2>/dev/null && echo alive || echo gone)" "gone"
check "停止后 socket 已清理" "$([ -S "${APPDEST}/app.sock" ] && echo left || echo clean)" "clean"

step "6. 升级路径（数据与运行时复用）"
STAMP_BEFORE="$(cat "${PKGVAR}/runtime/.node-stamp" 2>/dev/null)"
lifecycle upgrade_init; check "upgrade_init 退出码" "$?" "0"
lifecycle main start; check "升级后 main start 退出码" "$?" "0"
sleep 3
check "升级后 HTTP /" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/")" "200"
check "升级未重复解压运行时（stamp 不变）" "$(cat "${PKGVAR}/runtime/.node-stamp" 2>/dev/null)" "${STAMP_BEFORE}"
check "升级保留数据目录" "$([ -d "${PKGVAR}/data" ] && echo yes || echo no)" "yes"
lifecycle main stop; check "升级后 main stop 退出码" "$?" "0"

step "7. 卸载（保留数据）"
WIZARD_ENV=(wizard_data_action=keep)
lifecycle uninstall_callback; check "uninstall(keep) 退出码" "$?" "0"
check "保留模式不清数据" "$([ -d "${PKGVAR}/data" ] && echo kept || echo deleted)" "kept"
check "保留模式保留安装档案" "$([ -f "${SHARE}/install-profile.env" ] && echo kept || echo deleted)" "kept"

step "8. 重装沿用端口 + 卸载（彻底删除）"
rm -rf "${PKGVAR}"; mkdir -p "${PKGVAR}"; chown "${PKG_USER}:${PKG_USER}" "${PKGVAR}"
WIZARD_ENV=(wizard_admin_password=verify-secret)   # 向导不给端口，应回读安装档案
lifecycle install_callback; check "重装 install_callback 退出码" "$?" "0"
check "端口由安装档案恢复" "$(sed -n "s/^WIZARD_APP_PORT='\(.*\)'$/\1/p" "${PKGVAR}/app-config.env")" "${PORT}"
mkdir -p "${PKGVAR}/data"; printf 'probe' > "${PKGVAR}/data/probe.txt"
WIZARD_ENV=(wizard_data_action=delete)
lifecycle uninstall_callback; check "uninstall(delete) 退出码" "$?" "0"
check "删数据模式清空数据目录" "$([ -d "${PKGVAR}/data" ] && echo left || echo deleted)" "deleted"
check "删数据模式清空安装档案" "$([ -f "${SHARE}/install-profile.env" ] && echo left || echo deleted)" "deleted"
check "删数据模式清空共享 runtime" "$([ -d "${SHARE}/runtime" ] && echo left || echo deleted)" "deleted"
check "授权目录未被误删" "$([ -f "${MEDIA}/sample.mp3" ] && echo intact || echo deleted)" "intact"

step "9. 路径动态解析（不预设空间编号）"
probe_volume_root() { # probe_volume_root <描述> <期望> <env...>
  local desc="$1" expect="$2"; shift 2
  local got
  got="$( ( unset TRIM_APPDEST_VOL TRIM_APPDEST TRIM_PKGVAR TRIM_PKGETC TRIM_PKGTMP TRIM_DATA_SHARE_PATHS SCRIPT_DIR
            export "$@"
            . "${APP_ROOT}/cmd/runtime_paths.sh"
            resolve_volume_root || echo "<none>" ) )"
  check "${desc}" "${got}" "${expect}"
}
probe_volume_root "按 TRIM_APPDEST 解析（/vol3）" "/vol3" TRIM_APPDEST=/vol3/@appstore/gusi.music/target
probe_volume_root "按 TRIM_PKGVAR 解析（两位数空间）" "/vol10" TRIM_PKGVAR=/vol10/@appdata/gusi.music/var
probe_volume_root "从脚本位置上溯（/vol7）" "/vol7" SCRIPT_DIR=/vol7/@appstore/gusi.music/cmd
probe_volume_root "非 /vol 布局不猜空间" "<none>" TRIM_APPDEST=/var/apps/gusi.music/target
probe_volume_root "无任何下发时不猜空间" "<none>" TRIM_APPDEST=

step "10. 卸载删除白名单"
sed -n "/^is_safe_delete_target/,/^}/p" "${APP_ROOT}/cmd/uninstall_callback" > /tmp/gusi-verify-guard.sh
guard() { ( . /tmp/gusi-verify-guard.sh; export TRIM_PKGVAR=/tmp/gusi-music
            if is_safe_delete_target "$1"; then echo allow; else echo deny; fi ) }
check "允许删除本应用数据目录" "$(guard /vol1/@appdata/gusi.music/var/data)" "allow"
check "允许删除其他空间上的本应用目录" "$(guard /vol4/@appshare/gusi.music)" "allow"
check "拒绝 .. 穿越到其他应用" "$(guard "/vol1/@appstore/gusi.music/../../@appdata/other.app/var")" "deny"
check "拒绝删除存储空间根" "$(guard /vol1)" "deny"
check "拒绝删除授权目录" "$(guard /vol1/music)" "deny"
check "拒绝删除其他应用目录" "$(guard /vol1/@appdata/other.app/var)" "deny"

printf '\n════════ 结果：%d 通过 / %d 失败 ════════\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ] || exit 1
