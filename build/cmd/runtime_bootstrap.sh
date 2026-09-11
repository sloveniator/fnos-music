#!/bin/bash

# GuSi Music — 运行时引导：日志轮转、受管文件可写性、捆绑 Node 运行时解压
# （结构对齐道理鱼 runtime_bootstrap.sh，按 Node 应用裁剪：无 ffmpeg/chromaprint/DB）

LOG_FILE="${TRIM_PKGVAR}/info.log"
LOG_MAX_BYTES="${GS_LOG_MAX_BYTES:-10485760}"
LOG_KEEP_FILES="${GS_LOG_KEEP_FILES:-4}"
LOG_ROTATE_INTERVAL_SECONDS="${GS_LOG_ROTATE_INTERVAL_SECONDS:-60}"

rotate_log_file() {
  local target="$1"
  local max_bytes="${2:-${LOG_MAX_BYTES}}"
  local keep_files="${3:-${LOG_KEEP_FILES}}"
  local target_dir
  local size
  local idx
  local candidate
  local suffix

  [ -n "${target}" ] || return 0
  [ -f "${target}" ] || return 0
  case "${max_bytes}" in
    ''|*[!0-9]*) max_bytes="10485760" ;;
  esac
  case "${keep_files}" in
    ''|*[!0-9]*) keep_files="4" ;;
  esac
  [ "${max_bytes}" -gt 0 ] || return 0
  [ "${keep_files}" -gt 0 ] || keep_files="1"

  target_dir="$(dirname "${target}")"
  mkdir -p "${target_dir}" >/dev/null 2>&1 || return 0

  for candidate in "${target}".*; do
    [ -e "${candidate}" ] || continue
    suffix="${candidate#"${target}".}"
    case "${suffix}" in
      ''|*[!0-9]*) continue ;;
    esac
    if [ "${suffix}" -gt "${keep_files}" ]; then
      rm -f "${candidate}" >/dev/null 2>&1 || true
    fi
  done

  size="$(wc -c < "${target}" 2>/dev/null | tr -d '[:space:]')"
  case "${size}" in
    ''|*[!0-9]*) return 0 ;;
  esac
  [ "${size}" -lt "${max_bytes}" ] && return 0

  idx="${keep_files}"
  while [ "${idx}" -gt 1 ]; do
    if [ -e "${target}.$((idx - 1))" ]; then
      mv -f "${target}.$((idx - 1))" "${target}.${idx}" >/dev/null 2>&1 || true
    fi
    idx=$((idx - 1))
  done
  if cp -p "${target}" "${target}.1" >/dev/null 2>&1 || cat "${target}" > "${target}.1" 2>/dev/null; then
    : > "${target}" 2>/dev/null || true
  fi
}

log_rotate_interval_seconds() {
  local interval="${LOG_ROTATE_INTERVAL_SECONDS}"
  case "${interval}" in
    ''|*[!0-9]*) interval="60" ;;
  esac
  [ "${interval}" -gt 0 ] || interval="60"
  printf "%s" "${interval}"
}

_bootstrap_log() {
  local message="$1"
  local stamp
  stamp="$(date '+%Y-%m-%d %H:%M:%S')"
  if [ -n "${TRIM_PKGVAR:-}" ]; then
    mkdir -p "${TRIM_PKGVAR}" >/dev/null 2>&1 || true
    rotate_log_file "${LOG_FILE}"
    printf "%s - %s\n" "${stamp}" "${message}" >> "${LOG_FILE}" 2>/dev/null || true
  fi
}

ensure_managed_file_writable() {
  local target="$1"
  local target_dir=""
  local temp_path=""
  local legacy_path=""

  [ -n "${target}" ] || return 1
  target_dir="$(dirname "${target}")"
  mkdir -p "${target_dir}" >/dev/null 2>&1 || return 1
  [ -d "${target_dir}" ] && [ -w "${target_dir}" ] && [ -x "${target_dir}" ] || return 1
  [ -e "${target}" ] || [ -L "${target}" ] || return 0
  [ ! -L "${target}" ] || {
    legacy_path="${target}.rejected-symlink-$(date '+%Y%m%d-%H%M%S')-$$"
    mv "${target}" "${legacy_path}" >/dev/null 2>&1 || return 1
    return 0
  }
  [ -f "${target}" ] || return 1
  [ -w "${target}" ] && return 0

  temp_path="${target_dir}/.$(basename "${target}").owner-migration.$$.$RANDOM"
  if [ -r "${target}" ]; then
    cp "${target}" "${temp_path}" >/dev/null 2>&1 || return 1
    cmp -s "${target}" "${temp_path}" || {
      rm -f "${temp_path}" >/dev/null 2>&1 || true
      return 1
    }
  else
    legacy_path="${target_dir}/.$(basename "${target}").unreadable-legacy-$(date '+%Y%m%d-%H%M%S')-$$"
    mv "${target}" "${legacy_path}" >/dev/null 2>&1 || return 1
    : > "${temp_path}" 2>/dev/null || return 1
  fi
  chmod 0600 "${temp_path}" >/dev/null 2>&1 || {
    rm -f "${temp_path}" >/dev/null 2>&1 || true
    return 1
  }
  mv -f "${temp_path}" "${target}" >/dev/null 2>&1 || {
    rm -f "${temp_path}" >/dev/null 2>&1 || true
    return 1
  }
  return 0
}

detect_runtime_arch() {
  local raw
  raw="$(uname -m 2>/dev/null || true)"
  case "${raw}" in
    x86_64|amd64) printf "x64" ;;
    aarch64|arm64) printf "arm64" ;;
    *) printf "%s" "${raw}" ;;
  esac
}

resolve_node_archive() {
  local arch
  arch="${GS_RUNTIME_ARCH_OVERRIDE:-$(detect_runtime_arch)}"
  case "${arch}" in
    x64) printf "%s/node-linux-x64.tar.gz" "${OFFLINE_DIR}" ;;
    arm64) printf "%s/node-linux-arm64.tar.gz" "${OFFLINE_DIR}" ;;
    *) printf "" ;;
  esac
}

restore_runtime_exec_bits() {
  local fixed=0
  local target
  for target in "${RUNTIME_NODE_DIR}/node"; do
    [ -f "${target}" ] || continue
    chmod +x "${target}" >/dev/null 2>&1 && fixed=$((fixed + 1))
  done
  if [ "${fixed}" -gt 0 ]; then
    _bootstrap_log "Restored executable bits for ${fixed} runtime file(s)."
  fi
  return 0
}

# 捆绑 Node 运行时：按 md5 stamp 增量解压（升级时 tarball 变化自动重解），仅取 node 二进制
bootstrap_node_runtime() {
  NODE_BIN=""
  local archive
  archive="$(resolve_node_archive)"

  if [ -n "${archive}" ] && [ -f "${archive}" ]; then
    local cur_md5 stored_md5
    cur_md5="$(md5sum "${archive}" 2>/dev/null | awk '{print $1}')"
    stored_md5="$(cat "${STAMP_FILE}" 2>/dev/null || true)"
    if [ ! -x "${RUNTIME_NODE_DIR}/node" ] || [ "${cur_md5}" != "${stored_md5}" ]; then
      _bootstrap_log "Bootstrapping bundled node runtime from ${archive}"
      mkdir -p "${RUNTIME_NODE_DIR}" >/dev/null 2>&1 || return 1
      rm -f "${RUNTIME_NODE_DIR}/node" >/dev/null 2>&1 || true
      tar -xzf "${archive}" -C "${RUNTIME_NODE_DIR}" --strip-components=2 --wildcards 'node-v*/bin/node' >> "${LOG_FILE}" 2>&1 || true
      if [ -x "${RUNTIME_NODE_DIR}/node" ] && [ -n "${cur_md5}" ]; then
        printf '%s' "${cur_md5}" > "${STAMP_FILE}" || true
      fi
    fi
    restore_runtime_exec_bits
    if [ -x "${RUNTIME_NODE_DIR}/node" ]; then
      NODE_BIN="${RUNTIME_NODE_DIR}/node"
      _bootstrap_log "Bundled node runtime is ready: ${NODE_BIN}"
      return 0
    fi
    _bootstrap_log "WARN: bundled node runtime could not be prepared from ${archive}"
  fi

  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
    _bootstrap_log "WARN: using system node runtime ${NODE_BIN}"
    return 0
  fi

  _bootstrap_log "ERROR: no node runtime available (bundled archive missing and system node not found)"
  return 1
}

bootstrap_runtime() {
  mkdir -p "${TRIM_PKGVAR}/runtime" >/dev/null 2>&1 || true
  rotate_log_file "${LOG_FILE}"
  bootstrap_node_runtime
}
