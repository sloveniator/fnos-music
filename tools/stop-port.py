#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按「端口」定位并停止服务实例（不是按进程名）。

为什么不用 pgrep -f 'node ./index.js'：那条命令行会匹配到正在执行它的 shell 自己，
把调用方一起杀掉（踩过一次，退出码 -15）。这里改成：
  /proc/net/tcp(6) 找到监听端口的 socket inode → 扫 /proc/*/fd 反查持有它的进程。

用法：python3 tools/stop-port.py 20059 [--signal TERM]
"""
import os
import re
import signal
import sys
import time


def listen_inodes(port: int):
    inodes = set()
    for f in ('/proc/net/tcp', '/proc/net/tcp6'):
        try:
            lines = open(f).read().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            p = line.split()
            if len(p) < 10:
                continue
            try:
                if int(p[1].split(':')[1], 16) != port:
                    continue
            except (IndexError, ValueError):
                continue
            if p[3] != '0A':          # 0A = LISTEN
                continue
            inodes.add(p[9])
    return inodes


def find_pids(port: int):
    inodes = listen_inodes(port)
    if not inodes:
        return []
    out = []
    for pid in (d for d in os.listdir('/proc') if d.isdigit()):
        try:
            fds = os.listdir('/proc/%s/fd' % pid)
        except OSError:
            continue
        for fd in fds:
            try:
                link = os.readlink('/proc/%s/fd/%s' % (pid, fd))
            except OSError:
                continue
            m = re.match(r'socket:\[(\d+)\]', link)
            if m and m.group(1) in inodes:
                try:
                    cmd = open('/proc/%s/cmdline' % pid).read().replace('\0', ' ').strip()
                except OSError:
                    cmd = ''
                out.append((int(pid), cmd))
                break
    return out


def main():
    if len(sys.argv) < 2:
        print('用法: python3 tools/stop-port.py <port>', file=sys.stderr)
        return 2
    port = int(sys.argv[1])
    sig = signal.SIGTERM
    if '--signal' in sys.argv:
        sig = getattr(signal, sys.argv[sys.argv.index('--signal') + 1])
    pids = find_pids(port)
    if not pids:
        print('端口 %d 上没有监听进程（无需停止）' % port)
        return 0
    for pid, cmd in pids:
        print('停止 pid=%d  %s' % (pid, cmd[:100]))
        try:
            os.kill(pid, sig)
        except OSError as e:
            print('  kill 失败: %s' % e)
    # 等端口真正释放，否则紧接着启动会 EADDRINUSE
    for _ in range(30):
        time.sleep(0.3)
        if not find_pids(port):
            print('端口 %d 已释放' % port)
            return 0
    print('端口 %d 仍被占用（等超时）' % port, file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
