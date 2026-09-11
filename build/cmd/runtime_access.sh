#!/bin/bash

# GuSi Music — fnOS 授权目录诊断（移植道理鱼 runtime_access.sh，保留 zh-CN/zh-TW/en）

access_diagnostic_locale() {
  local raw="${GS_LOCALE:-${TRIM_SYS_LANGUAGE:-${LANG:-zh-CN}}}"
  raw="$(printf '%s' "${raw}" | tr '[:upper:]_' '[:lower:]-')"
  case "${raw}" in
    zh-tw*|zh-hk*|zh-hant*) printf 'zh-TW' ;;
    zh*) printf 'zh-CN' ;;
    en*) printf 'en' ;;
    *) printf 'zh-CN' ;;
  esac
}

access_diagnostic_message() {
  local key="$1"
  local locale=""
  locale="$(access_diagnostic_locale)"
  case "${locale}:${key}" in
    zh-CN:header) printf '以下目录由 fnOS 授权系统原样下发；古四音乐不会改写 /vol1、/vol2、/vol3 等存储空间编号。' ;;
    zh-CN:none) printf 'fnOS 没有向应用下发任何外部目录。请到“应用中心 > 古四音乐 > 设置 > 授权目录”选择目录并保存。' ;;
    zh-CN:ok) printf '应用专用账号可以进入、读取和写入该目录；扫描与在线播放具备基础权限。' ;;
    zh-CN:read-only) printf '该目录可进入和读取，可以扫描与播放；但当前不可写，下载到 NAS 或元数据回写可能失败。' ;;
    zh-CN:unavailable) printf 'fnOS 下发了这个路径，但应用专用账号看不到它。请检查存储空间是否在线、目录是否移动，以及授权路径是否与真实路径一致。' ;;
    zh-CN:not-directory) printf 'fnOS 下发的路径存在，但它不是目录，请重新选择媒体文件夹。' ;;
    zh-CN:broken-link) printf 'fnOS 下发的路径是已失效的符号链接，目标可能已移动或存储空间未挂载；请重新选择授权目录。' ;;
    zh-CN:parent-denied) printf '路径尚未能检查到本身，因为应用专用账号无法进入某个上级目录。请在 fnOS 重新保存授权，并检查提示的上级目录 ACL。' ;;
    zh-CN:denied) printf 'fnOS 下发了这个目录，但应用专用账号没有实际的读取或进入权限。请在 fnOS 中重新保存目录授权并检查上级目录 ACL；扫描器不能绕过系统权限。' ;;
    zh-CN:guide) printf '判断方法：路径没出现表示 fnOS 未下发；UNAVAILABLE 多为目录移动或存储离线；PARENT_DENIED/DENIED 需修复授权链 ACL；READ_ONLY 可扫描但不能保证写入。古四音乐不会使用 root 绕过这些权限。' ;;
    zh-TW:header) printf '以下目錄由 fnOS 授權系統原樣下發；洛雪雲音樂不會改寫 /vol1、/vol2、/vol3 等儲存空間編號。' ;;
    zh-TW:none) printf 'fnOS 沒有向應用下發任何外部目錄。請到「應用中心 > 洛雪雲音樂 > 設定 > 授權目錄」選擇目錄並儲存。' ;;
    zh-TW:ok) printf '應用專用帳號可以進入、讀取和寫入此目錄；掃描與線上播放具備基礎權限。' ;;
    zh-TW:read-only) printf '此目錄可進入和讀取，可以掃描與播放；但目前不可寫，下載到 NAS 或元資料回寫可能失敗。' ;;
    zh-TW:unavailable) printf 'fnOS 下發了此路徑，但應用專用帳號看不到它。請檢查儲存空間是否上線、目錄是否移動，以及授權路徑是否與真實路徑一致。' ;;
    zh-TW:not-directory) printf 'fnOS 下發的路徑存在，但它不是目錄，請重新選擇媒體資料夾。' ;;
    zh-TW:broken-link) printf 'fnOS 下發的路徑是已失效的符號連結，目標可能已移動或儲存空間未掛載；請重新選擇授權目錄。' ;;
    zh-TW:parent-denied) printf '路徑尚未能檢查到本身，因為應用專用帳號無法進入某個上級目錄。請在 fnOS 重新儲存授權，並檢查提示的上級目錄 ACL。' ;;
    zh-TW:denied) printf 'fnOS 下發了此目錄，但應用專用帳號沒有實際的讀取或進入權限。請在 fnOS 中重新儲存目錄授權並檢查上級目錄 ACL；掃描器不能繞過系統權限。' ;;
    zh-TW:guide) printf '判斷方法：路徑未出現表示 fnOS 未下發；UNAVAILABLE 多為目錄移動或儲存離線；PARENT_DENIED/DENIED 需修復授權鏈 ACL；READ_ONLY 可掃描但無法保證寫入。洛雪雲音樂不會使用 root 繞過這些權限。' ;;
    en:header) printf 'These paths are supplied unchanged by fnOS authorization; GuSi Music does not rewrite storage identifiers such as /vol1, /vol2, or /vol3.' ;;
    en:none) printf 'fnOS supplied no external directory. Select and save a folder under App Center > GuSi Music Music > Settings > Authorized folders.' ;;
    en:ok) printf 'The package user can enter, read and write this directory; scanning and streaming have the required base permissions.' ;;
    en:read-only) printf 'This directory can be entered and read, so scanning and playback can work; it is not writable, so downloads to NAS or metadata write-back may fail.' ;;
    en:unavailable) printf 'fnOS supplied this path, but the package user cannot see it. Check that the storage is online, the folder was not moved, and the authorized path matches the real path.' ;;
    en:not-directory) printf 'The path supplied by fnOS exists but is not a directory. Select a media folder again.' ;;
    en:broken-link) printf 'The path supplied by fnOS is a broken symbolic link. Its target may have moved or its storage may be unmounted; select the authorized directory again.' ;;
    en:parent-denied) printf 'The target itself cannot be checked because the package user cannot enter one of its parent directories. Save authorization again in fnOS and inspect the reported parent ACL.' ;;
    en:denied) printf 'fnOS supplied this directory, but the package user lacks effective read or traverse access. Save the authorization again in fnOS and check parent ACLs; the scanner cannot bypass system permissions.' ;;
    en:guide) printf 'How to read this: an absent path was not supplied by fnOS; UNAVAILABLE usually means moved or offline storage; PARENT_DENIED/DENIED requires authorization or ACL repair; READ_ONLY can scan but cannot guarantee writes. GuSi Music never uses root to bypass these permissions.' ;;
    *) printf 'Unknown authorization diagnostic message.' ;;
  esac
}

sanitize_access_diagnostic_value() {
  printf '%s' "$1" | tr '\r\n\t' '   '
}

access_path_real_path() {
  local target="$1"
  local parent=""
  local name=""
  local resolved_parent=""

  if command -v realpath >/dev/null 2>&1; then
    realpath "${target}" 2>/dev/null && return 0
  fi
  if command -v readlink >/dev/null 2>&1; then
    readlink -f "${target}" 2>/dev/null && return 0
  fi
  if [ -d "${target}" ]; then
    (cd "${target}" 2>/dev/null && pwd -P) && return 0
  fi
  parent="$(dirname "${target}")"
  name="$(basename "${target}")"
  resolved_parent="$(cd "${parent}" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s' "${resolved_parent%/}" "${name}"
}

access_path_stat_details() {
  local target="$1"
  local details=""

  details="$(stat -c 'owner=%U; group=%G; mode=%a' "${target}" 2>/dev/null)" || \
    details="$(stat -f 'owner=%Su; group=%Sg; mode=%Lp' "${target}" 2>/dev/null)" || \
    details="owner=unknown; group=unknown; mode=unknown"
  sanitize_access_diagnostic_value "${details}"
}

access_path_nearest_existing_parent() {
  local candidate=""
  local next=""

  candidate="$(dirname "$1")"
  while [ -n "${candidate}" ]; do
    if [ -e "${candidate}" ] || [ -L "${candidate}" ]; then
      printf '%s' "${candidate}"
      return 0
    fi
    [ "${candidate}" = "/" ] && break
    next="$(dirname "${candidate}")"
    [ "${next}" != "${candidate}" ] || break
    candidate="${next}"
  done
  printf '/'
}

access_path_details() {
  local target="$1"
  local kind="$2"
  local access="$3"
  local resolved=""

  resolved="$(access_path_real_path "${target}" 2>/dev/null || printf '%s' 'unresolved')"
  printf 'resolved=%s; type=%s; access=%s; %s' \
    "$(sanitize_access_diagnostic_value "${resolved}")" \
    "${kind}" \
    "${access}" \
    "$(access_path_stat_details "${target}")"
}

log_accessible_paths_diagnostic() {
  local raw_paths="$1"
  local root=""
  local safe_root=""
  local parent=""
  local safe_parent=""
  local identity=""
  local path_count=0
  local -a access_roots=()

  identity="user=$(id -un 2>/dev/null || printf unknown); uid=$(id -u 2>/dev/null || printf unknown); gid=$(id -g 2>/dev/null || printf unknown)"
  log_msg "[AUTH_PATH_INFO] ${identity}; $(access_diagnostic_message header)"
  if [ -z "${raw_paths}" ]; then
    log_msg "[AUTH_PATH_NONE] $(access_diagnostic_message none)"
    log_msg "[AUTH_PATH_GUIDE] $(access_diagnostic_message guide)"
    return 0
  fi

  IFS=':' read -r -a access_roots <<< "${raw_paths}"
  for root in "${access_roots[@]}"; do
    root="$(printf '%s' "${root}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -n "${root}" ] || continue
    path_count=$((path_count + 1))
    safe_root="$(sanitize_access_diagnostic_value "${root}")"
    if [ -L "${root}" ] && [ ! -e "${root}" ]; then
      log_msg "[AUTH_PATH_BROKEN_LINK] path=${safe_root}; $(access_path_details "${root}" symbolic-link unavailable); $(access_diagnostic_message broken-link)"
    elif [ ! -e "${root}" ]; then
      parent="$(access_path_nearest_existing_parent "${root}")"
      safe_parent="$(sanitize_access_diagnostic_value "${parent}")"
      if [ -d "${parent}" ] && [ ! -x "${parent}" ]; then
        log_msg "[AUTH_PATH_PARENT_DENIED] path=${safe_root}; blocked_parent=${safe_parent}; $(access_path_details "${parent}" directory denied); $(access_diagnostic_message parent-denied)"
      else
        log_msg "[AUTH_PATH_UNAVAILABLE] path=${safe_root}; nearest_parent=${safe_parent}; $(access_diagnostic_message unavailable)"
      fi
    elif [ ! -d "${root}" ]; then
      log_msg "[AUTH_PATH_NOT_DIRECTORY] path=${safe_root}; $(access_path_details "${root}" file unknown); $(access_diagnostic_message not-directory)"
    elif [ ! -r "${root}" ] || [ ! -x "${root}" ]; then
      log_msg "[AUTH_PATH_DENIED] path=${safe_root}; $(access_path_details "${root}" directory denied); $(access_diagnostic_message denied)"
    elif [ ! -w "${root}" ]; then
      log_msg "[AUTH_PATH_READ_ONLY] path=${safe_root}; $(access_path_details "${root}" directory read-only); $(access_diagnostic_message read-only)"
    else
      log_msg "[AUTH_PATH_OK] path=${safe_root}; $(access_path_details "${root}" directory read-write); $(access_diagnostic_message ok)"
    fi
  done

  if [ "${path_count}" -eq 0 ]; then
    log_msg "[AUTH_PATH_NONE] $(access_diagnostic_message none)"
  fi
  log_msg "[AUTH_PATH_GUIDE] $(access_diagnostic_message guide)"
}
