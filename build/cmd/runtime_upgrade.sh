#!/bin/bash

# GuSi Music — 升级就绪标记（移植道理鱼 runtime_upgrade.sh 的标记机制；纯文件快照存储无需数据库快照回滚）

ROOTLESS_VERSION="${TRIM_APPVER:-1.0.0}"
UPGRADE_PENDING_MARKER="${TRIM_PKGVAR}/runtime/.upgrade-pending"
ROOTLESS_READY_MARKER="${TRIM_PKGVAR}/runtime/rootless-ready"

rootless_log() {
  if command -v log_msg >/dev/null 2>&1; then
    log_msg "$1"
  elif command -v _bootstrap_log >/dev/null 2>&1; then
    _bootstrap_log "$1"
  fi
}

# 升级安装后首次启动前打 pending 标记；服务成功监听后写 ready 标记（记录版本）
prepare_upgrade_start() {
  mkdir -p "${TRIM_PKGVAR}/runtime" >/dev/null 2>&1 || return 0
  if [ ! -e "${ROOTLESS_READY_MARKER}" ] || [ "$(cat "${ROOTLESS_READY_MARKER}" 2>/dev/null)" != "${ROOTLESS_VERSION}" ]; then
    printf '%s\n' "${ROOTLESS_VERSION}" > "${UPGRADE_PENDING_MARKER}" 2>/dev/null || true
    rootless_log "Upgrade/install pending marker set for ${ROOTLESS_VERSION}"
  fi
  return 0
}

mark_rootless_service_ready() {
  mkdir -p "${TRIM_PKGVAR}/runtime" >/dev/null 2>&1 || return 1
  printf '%s\n' "${ROOTLESS_VERSION}" > "${ROOTLESS_READY_MARKER}.tmp" 2>/dev/null || return 1
  mv -f "${ROOTLESS_READY_MARKER}.tmp" "${ROOTLESS_READY_MARKER}" 2>/dev/null || return 1
  rm -f "${UPGRADE_PENDING_MARKER}" >/dev/null 2>&1 || true
  rootless_log "Rootless service ready marker committed: ${ROOTLESS_VERSION}"
  return 0
}
