#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""行尾守护：把文件统一成指定行尾，避免 edit_file 把 CRLF 文件归一成 LF。

用法：
  python3 tools/eol.py check <file...>        # 打印每个文件的行尾实况
  python3 tools/eol.py crlf <file...>         # 统一成 CRLF
  python3 tools/eol.py lf <file...>           # 统一成 LF
  python3 tools/eol.py restore <file...>      # 按 git HEAD 的既有行尾还原（推荐）
  python3 tools/eol.py audit                 # 全仓审计：工作区行尾 vs HEAD 行尾
"""
import subprocess
import sys


def read(p):
    with open(p, 'rb') as f:
        return f.read()


def write(p, b):
    with open(p, 'wb') as f:
        f.write(b)


def eol_of(b):
    crlf = b.count(b'\r\n')
    lf = b.count(b'\n')
    if crlf == 0:
        return 'lf'
    if crlf == lf:
        return 'crlf'
    return 'mixed'


def to_crlf(p):
    b = read(p).replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
    write(p, b)
    return eol_of(read(p))


def to_lf(p):
    b = read(p).replace(b'\r\n', b'\n')
    write(p, b)
    return eol_of(read(p))


def head_eol(p):
    r = subprocess.run(['git', 'cat-file', '-p', 'HEAD:' + p], capture_output=True)
    if r.returncode != 0:
        return None
    return eol_of(r.stdout)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cmd = sys.argv[1]
    if cmd == 'audit':
        out = subprocess.run(['git', 'ls-files'], capture_output=True, text=True).stdout.split()
        bad = 0
        for p in out:
            he = head_eol(p)
            if not he:
                continue
            try:
                we = eol_of(read(p))
            except FileNotFoundError:
                continue
            if we != he:
                print('EOL 不一致: %-50s HEAD=%s 工作区=%s' % (p, he, we))
                bad += 1
        print('EOL 审计：%d 个文件不一致（0 = 全部保持原行尾）' % bad)
        return 1 if bad else 0
    files = sys.argv[2:]
    if not files:
        print('未指定文件')
        return 2
    for p in files:
        if cmd == 'check':
            print('%-50s %s' % (p, eol_of(read(p))))
        elif cmd == 'crlf':
            print('%-50s -> %s' % (p, to_crlf(p)))
        elif cmd == 'lf':
            print('%-50s -> %s' % (p, to_lf(p)))
        elif cmd == 'restore':
            he = head_eol(p)
            if he is None:
                print('%-50s 未纳入版本管理，跳过' % p)
                continue
            print('%-50s HEAD=%s -> %s' % (p, he, to_crlf(p) if he == 'crlf' else to_lf(p)))
        else:
            print('未知命令', cmd)
            return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
