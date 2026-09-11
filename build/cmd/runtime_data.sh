#!/bin/bash

# GuSi Music — 数据目录准备（移植道理鱼 runtime_data.sh，去掉 SQLite 迁移，保留可写性探测与私有/共享回退）

runtime_dir_exists() {
  local target_dir="$1"
  [ -n "${target_dir}" ] || return 1
  [ -e "${target_dir}" ] || [ -L "${target_dir}" ]
}

runtime_dir_writable() {
  local target_dir="$1"
  local probe_file=""

  [ -n "${target_dir}" ] || return 1
  mkdir -p "${target_dir}" >/dev/null 2>&1 || return 1
  [ -d "${target_dir}" ] && [ ! -L "${target_dir}" ] && [ -r "${target_dir}" ] && [ -w "${target_dir}" ] && [ -x "${target_dir}" ] || return 1
  probe_file="${target_dir}/.lxm-write-test.$$.$RANDOM"
  if : > "${probe_file}" 2>/dev/null; then
    rm -f "${probe_file}" >/dev/null 2>&1 || true
    return 0
  fi
  rm -f "${probe_file}" >/dev/null 2>&1 || true
  return 1
}

log_runtime_path_status() {
  local label="$1"
  local target="$2"
  local details="missing"

  if [ -e "${target}" ] || [ -L "${target}" ]; then
    details="$(ls -ldn "${target}" 2>/dev/null || printf 'unavailable')"
  fi
  log_msg "Runtime path status: ${label}; ${details}"
}

# 优先私有目录（PKGVAR/data），不可用时回退共享目录（@appshare/<app>/data）
prepare_runtime_data_dir() {
  local private_dir="$1"
  local shared_dir="$2"
  local private_parent=""

  private_parent="$(dirname "${private_dir}")"
  mkdir -p "${private_dir}" >/dev/null 2>&1 || true
  if runtime_dir_exists "${private_parent}" && \
    { [ ! -d "${private_parent}" ] || [ ! -r "${private_parent}" ] || [ ! -w "${private_parent}" ] || [ ! -x "${private_parent}" ]; }; then
    log_msg "ERROR: private runtime parent exists but cannot be safely inspected: ${private_parent}"
    log_runtime_path_status "private runtime parent" "${private_parent}"
    return 1
  fi

  if runtime_dir_writable "${private_dir}"; then
    printf '%s' "${private_dir}"
    return 0
  fi
  if runtime_dir_writable "${shared_dir}"; then
    log_msg "WARN: private runtime is unavailable; using shared runtime: ${shared_dir}"
    printf '%s' "${shared_dir}"
    return 0
  fi

  log_msg "ERROR: no writable runtime data directory; private=${private_dir}; shared=${shared_dir}"
  log_runtime_path_status "private runtime" "${private_dir}"
  log_runtime_path_status "shared runtime" "${shared_dir}"
  return 1
}
