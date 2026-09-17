#!/bin/sh
# 古四音乐 · 现场取证：「装了古四音乐之后，飞牛上的酷狗音乐不能用了」
#
# 只读脚本：不写任何配置、不重启任何服务、不删任何东西。全部命令都是查看类。
# 用法（在飞牛上，任意目录）：
#     sudo sh diag-kugou.sh 2>&1 | tee /tmp/diag.txt
# 没有 root 也能跑（第 1/2/5 节会缺进程名与别的应用的日志，其余照旧）。
#
# 为什么是这几项：古四音乐唯一的跨应用资源是「一个 TCP 端口（默认 43000）+ 一个
# app.sock（在自己应用目录里）」，其余全部读写都在自己的 @appdata/@appstore 里。
# 所以能影响别的应用的路径只有：端口抢占、磁盘/内存耗尽、应用中心/网关层面的登记。
# 本脚本就是把这四条一次问清楚。

hr() { printf '\n==================== %s ====================\n' "$1"; }

hr "0. 机器与时间（先把时间基准记下来，后面要跟酷狗出错的时间对齐）"
date '+%Y-%m-%d %H:%M:%S %Z'
uptime 2>/dev/null
uname -a 2>/dev/null
echo "--- 最近一次开机时间"
who -b 2>/dev/null || uptime -s 2>/dev/null || echo "(取不到)"

hr "1. 监听端口：43000 是谁在听？还有哪些 43xxx 段被占"
if command -v ss >/dev/null 2>&1; then LISTCMD="ss -lntp"; else LISTCMD="netstat -lntp"; fi
echo "--- $LISTCMD（全量，前 60 行）"
$LISTCMD 2>&1 | sed -n '1,60p'
echo "--- 只看 43xxx 段（古四音乐默认 43000）"
$LISTCMD 2>&1 | grep -E ':(43[0-9][0-9][0-9])\b' || echo "（43xxx 段没有任何监听）"

hr "2. 相关进程：古四/酷狗/node 后端各是谁、活了多久、占多少内存"
ps -eo pid,user,etime,rss,args 2>/dev/null | grep -Ei 'gusi|kugou|fnmusic|trim_music|node .*index\.js' | grep -v grep || echo "（无匹配进程）"

hr "3. 装了哪些应用，各自声明的端口/身份/依赖"
for d in /vol*/@appstore /vol*/@appcenter /vol*/@appdata /var/apps; do
  [ -d "$d" ] || continue
  echo "--- 目录 $d"
  ls -1 "$d" 2>/dev/null
done
echo "--- 各应用 manifest 关键字段"
for m in /vol*/@appstore/*/manifest /vol*/@appcenter/*/manifest /vol*/@appcenter/*/*/manifest /var/apps/*/*/manifest; do
  [ -f "$m" ] || continue
  echo "=== $m"
  grep -E '^(appname|display_name|service_port|micro_app|checkport|install_dep_apps|version)' "$m" 2>/dev/null
done

hr "4. 磁盘与内存：有没有写满 / 有没有被 OOM 杀过"
df -h 2>/dev/null | grep -vE 'tmpfs|devtmpfs|overlay'
echo "--- inode（写满也可能卡在 inode）"
df -i 2>/dev/null | grep -vE 'tmpfs|devtmpfs|overlay'
free -h 2>/dev/null
echo "--- 内核消息里的 OOM / kill（近 200 行）"
dmesg 2>/dev/null | tail -200 | grep -iE 'out of memory|oom-kill|killed process' || echo "（无 OOM 记录；若 dmesg 需要 root 请用 sudo 重跑）"

hr "5. 酷狗那一侧的日志与运行目录（看它自己怎么说）"
found_kugou=0
for d in /vol*/@appdata/*[Kk]ugou* /vol*/@appstore/*[Kk]ugou* /vol*/@appcenter/*[Kk]ugou* /var/apps/*[Kk]ugou*; do
  [ -e "$d" ] || continue
  found_kugou=1
  echo "=== $d"
  ls -la "$d" 2>/dev/null | head -25
  echo "--- 该目录下最近的日志文件（按时间倒序，取 8 个）"
  find "$d" -maxdepth 4 -name '*.log' -printf '%TY-%Tm-%Td %TH:%TM  %10s  %p\n' 2>/dev/null | sort | tail -8
done
[ "$found_kugou" -eq 0 ] && echo "（按名字没找到酷狗目录：它可能装成 Docker 容器，或应用名不含 kugou —— 见第 7 节）"

hr "6. 古四音乐自己的记录：它是什么时候被装上/启动的"
for f in /vol*/@appdata/gusi.music/info.log /tmp/gusi.music.install.log /tmp/gusi.music.uninstall.log; do
  [ -f "$f" ] || continue
  echo "=== $f"
  tail -25 "$f"
done
echo "--- 古四音乐应用目录/网关 socket"
ls -la /var/apps/gusi.music/target/app.sock /vol*/@appstore/gusi.music/app.sock 2>/dev/null || echo "（没看到 app.sock：网关可能走的别的路径）"

hr "7. Docker 可能性：酷狗如果是容器跑的，这里会露出来"
if command -v docker >/dev/null 2>&1; then
  echo "--- docker ps（端口映射，看有没有容器也在用 43000）"
  docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>&1 | head -30
else
  echo "（没有 docker 命令）"
fi
echo "--- /var/run 下的 socket（应用间抢全局 socket 的痕迹）"
ls -la /var/run/ 2>/dev/null | grep -iE 'sock|music|kugou|gusi' || echo "（无匹配）"
echo "--- 应用中心日志/网关配置里提到两个应用的行"
grep -rliE 'kugou|gusi' /usr/trim/var/log 2>/dev/null | head -5

hr "完"
echo "把上面整段输出（可去掉端口列表里的私人内容）发回来即可定位。"
