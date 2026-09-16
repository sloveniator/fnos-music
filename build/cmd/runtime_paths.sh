#!/bin/bash

# GuSi Music — 存储空间 / 共享目录动态解析
#
# fnOS 允许把应用装到任意存储空间（/vol1、/vol2、/vol10 …），共享目录的实际位置也由
# 系统下发。本文件只依据 fnOS 注入的环境变量（TRIM_APPDEST / TRIM_PKGVAR / …）与脚本
# 自身所在位置推导路径，绝不假定某个空间编号：
#   - 能判定 → 打印真实路径；
#   - 判定不出 → 返回非 0，由调用方决定降级或跳过（宁可不动，也不猜一个空间去写/删）。

# 从任意 "/vol<N>/..." 形态的路径中取出存储空间根（"/vol1/@appstore/x" → "/vol1"）
volume_root_from_path() {
  local raw="${1:-}"
  local head=""

  raw="${raw%/}"
  case "${raw}" in
    /vol*/*|/vol*) ;;
    *) return 1 ;;
  esac
  head="$(printf '%s' "${raw}" | cut -d/ -f2)"
  # 只接受 /vol 后跟纯数字（排除 /volume1、/volumeX 这类非 fnOS 空间命名）
  case "${head}" in
    vol[0-9]|vol[0-9][0-9]|vol[0-9][0-9][0-9]) printf '/%s' "${head}" ;;
    *) return 1 ;;
  esac
}

# 动态解析本应用所在的存储空间根；全部候选都不可用时返回非 0
resolve_volume_root() {
  local candidate=""
  local walk=""

  for candidate in \
    "${TRIM_APPDEST_VOL:-}" \
    "${TRIM_APPDEST:-}" \
    "${TRIM_PKGVAR:-}" \
    "${TRIM_PKGETC:-}" \
    "${TRIM_PKGTMP:-}" \
    "${TRIM_DATA_SHARE_PATHS:-}"
  do
    [ -n "${candidate}" ] || continue
    if volume_root_from_path "${candidate}"; then
      return 0
    fi
  done

  # 兜底：从生命周期脚本自身位置逐级上溯（…/@appstore/gusi.music/cmd → /vol1）
  walk="${SCRIPT_DIR:-}"
  while [ -n "${walk}" ] && [ "${walk}" != "/" ] && [ "${walk}" != "." ]; do
    if volume_root_from_path "${walk}"; then
      return 0
    fi
    walk="$(dirname "${walk}")"
  done

  return 1
}

# 共享目录：优先用 fnOS 下发的 data-share 路径；否则按解析出的空间推导；
# 最后回退到应用私有目录下的 data-share（不依赖任何固定空间编号）
resolve_app_share_dir() {
  local first_share="${TRIM_DATA_SHARE_PATHS:-}"
  local volume_root=""

  first_share="${first_share%%:*}"
  first_share="$(printf '%s' "${first_share}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if [ -n "${first_share}" ]; then
    printf '%s' "${first_share%/}"
    return 0
  fi

  if volume_root="$(resolve_volume_root)"; then
    printf '%s/@appshare/gusi.music' "${volume_root}"
    return 0
  fi

  printf '%s/data-share/gusi.music' "${TRIM_PKGVAR:-/tmp/gusi-music}"
}

# 安装档案（端口偏好跨「卸载并删除数据」保留）：仅当能确定存储空间时给出路径
resolve_install_profile_file() {
  local volume_root=""

  if volume_root="$(resolve_volume_root)"; then
    printf '%s/@appshare/gusi.music/install-profile.env' "${volume_root}"
    return 0
  fi
  return 1
}
