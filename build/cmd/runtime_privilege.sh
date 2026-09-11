#!/bin/bash

# GuSi Music — 包身份与路径安全校验（对齐道理鱼 runtime_privilege.sh）
# fnOS 以包专属用户运行本应用与全部生命周期回调；本辅助不做任何提权。

package_service_user() {
  printf '%s' "${TRIM_USERNAME:-gusi.music}"
}

package_service_group() {
  printf '%s' "${TRIM_GROUPNAME:-$(package_service_user)}"
}

assert_package_identity() {
  local current_uid=""
  local current_user=""
  local service_user=""

  current_uid="$(id -u 2>/dev/null || true)"
  current_user="$(id -un 2>/dev/null || true)"
  service_user="$(package_service_user)"
  [ -n "${current_uid}" ] && [ "${current_uid}" -ne 0 ] || {
    _bootstrap_log "Package lifecycle or service refused root execution."
    return 1
  }
  [ "${current_user}" = "${service_user}" ] || {
    _bootstrap_log "Process user does not match package user: current=${current_user}; expected=${service_user}"
    return 1
  }
  case "${TRIM_UID:-}" in
    ''|*[!0-9]*) ;;
    *)
      [ "${current_uid}" = "${TRIM_UID}" ] || {
        _bootstrap_log "Process uid does not match package uid: current=${current_uid}; expected=${TRIM_UID}"
        return 1
      }
      ;;
  esac
}

validate_package_path() {
  local target="$1"

  case "${target:-}" in
    /*) ;;
    *)
      _bootstrap_log "Unsafe or empty package path: ${target:-<empty>}"
      return 1
      ;;
  esac
  [ ! -L "${target}" ] || {
    _bootstrap_log "Refusing symlinked package path: ${target}"
    return 1
  }
  [ ! -e "${target}" ] || [ -d "${target}" ] || {
    _bootstrap_log "Package path is not a directory: ${target}"
    return 1
  }
}

managed_directory_is_package_writable() {
  local target="$1"
  local probe=""

  [ -d "${target}" ] && [ ! -L "${target}" ] && [ -r "${target}" ] && [ -w "${target}" ] && [ -x "${target}" ] || return 1
  probe="${target}/.lxm-access-test.$$.$RANDOM"
  if : > "${probe}" 2>/dev/null; then
    rm -f "${probe}" >/dev/null 2>&1 || true
    return 0
  fi
  return 1
}

validate_rootless_runtime_paths() {
  local private_root="${TRIM_PKGVAR}/runtime"

  case "${TRIM_PKGVAR:-}" in
    /*) ;;
    *)
      _bootstrap_log "Package runtime path is empty or unsafe."
      return 1
      ;;
  esac
  validate_package_path "${private_root}" || return 1
}

validate_rootless_runtime_access() {
  validate_rootless_runtime_paths || return 1
  mkdir -p "${TRIM_PKGVAR}/data" "${TRIM_PKGVAR}/logs" >/dev/null 2>&1 || {
    _bootstrap_log "Package runtime is not writable by the fnOS package user: ${TRIM_PKGVAR}"
    return 1
  }
  managed_directory_is_package_writable "${TRIM_PKGVAR}/data" || {
    _bootstrap_log "Existing data directory is not safely writable by the fnOS package user"
    return 1
  }
}

# 只准备包用户拥有或新建的目录；共享媒体根目录保持有界，不触碰用户数据
prepare_package_runtime() {
  local share_base="$1"
  local private_runtime="${TRIM_PKGVAR}/runtime"

  validate_rootless_runtime_paths || return 1
  case "${share_base:-}" in
    /*) ;;
    *)
      _bootstrap_log "Unsafe or empty application share path: ${share_base:-<empty>}"
      return 1
      ;;
  esac
  case "${share_base}" in
    /|/var|/usr|/etc|/tmp|/vol|/vol[0-9]|/vol[0-9][0-9])
      _bootstrap_log "Refusing broad application share path: ${share_base}"
      return 1
      ;;
  esac
  mkdir -p \
    "${private_runtime}" \
    "${TRIM_PKGVAR}/data" \
    "${TRIM_PKGVAR}/logs" \
    "${share_base%/}/runtime" >/dev/null 2>&1 || return 1
  validate_package_path "${private_runtime}" || return 1
  managed_directory_is_package_writable "${TRIM_PKGVAR}/data" || return 1
}
