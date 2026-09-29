#!/usr/bin/env bash
# 修复:本机 Debian 11 (glibc 2.31) 无法运行 workerd(需 GLIBC_2.35+)导致 `wrangler dev` 失败。
# 原理:从 Debian 12 官方源解包 glibc 2.36 到 /opt/workerd-glibc(用户态,不动系统 glibc),
#       再用 patchelf 把 workerd 的 interpreter/rpath 指向它。幂等,可重复运行。
# 用法:
#   ./scripts/fix-workerd-glibc.sh            # 自动扫描 npx 缓存 + 当前项目 node_modules
#   ./scripts/fix-workerd-glibc.sh <路径...>  # 显式指定 workerd 二进制
# 何时需要重跑:npm install / npx 升级 wrangler / npm cache clean 之后(出现新的未打补丁 workerd)。
set -euo pipefail

GLIBC_DIR=/opt/workerd-glibc
LIB_DIR=$GLIBC_DIR/extracted/lib/x86_64-linux-gnu
DEB=libc6_2.36-9+deb12u14_amd64.deb
DEB_URL=https://deb.debian.org/debian/pool/main/g/glibc/$DEB

# 1. 确保 glibc 2.36 就位(幂等)
if [ ! -x "$LIB_DIR/ld-linux-x86-64.so.2" ]; then
  echo "下载并解包 glibc 2.36 -> $GLIBC_DIR"
  mkdir -p "$GLIBC_DIR"
  curl -fsSL -o "$GLIBC_DIR/$DEB" "$DEB_URL"
  dpkg -x "$GLIBC_DIR/$DEB" "$GLIBC_DIR/extracted"
fi

command -v patchelf >/dev/null || { echo "缺少 patchelf,先执行: apt-get install -y patchelf" >&2; exit 1; }
command -v readelf  >/dev/null || { echo "缺少 readelf,先执行: apt-get install -y binutils" >&2; exit 1; }

# 2. 收集目标 workerd 二进制
targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  mapfile -t targets < <(find "$HOME/.npm/_npx" "$PWD/node_modules" -path '*workerd-linux-64/bin/workerd' -type f 2>/dev/null || true)
fi
if [ ${#targets[@]} -eq 0 ]; then
  echo "未找到任何 workerd 二进制(先 npm install / npx wrangler 一次再跑本脚本)" >&2
  exit 1
fi

# 3. 逐个检查并打补丁(已能跑的跳过)
fail=0
for w in "${targets[@]}"; do
  if "$w" --version >/dev/null 2>&1; then
    echo "跳过(已可用): $w"
    continue
  fi
  patchelf --set-interpreter "$LIB_DIR/ld-linux-x86-64.so.2" --set-rpath "$LIB_DIR" "$w"
  if "$w" --version >/dev/null 2>&1; then
    echo "已修复: $w -> $("$w" --version 2>&1 | head -1)"
  else
    echo "修复失败: $w" >&2
    fail=1
  fi
done
exit $fail
