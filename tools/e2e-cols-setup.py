#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""列模板测试的隔离账号 + 合成曲库（用完即删，绝不碰主人自己的曲库）。

为什么要隔离账号：主人把自己的曲库清空了（他的原话「曲库为空是预期的」），
列模板测试又必须有真实曲目行才测得出「表头列 = 行列」。
所以另开一个一次性账号，曲库目录是注册时自动分配的 server/data/library/<名字>，
里面放几个合成的 mp3（无 ID3 标签 → 显示名取文件名，正好用来压列宽）。

用法：
  python3 tools/e2e-cols-setup.py setup          # 建号 + 生成曲目 + 等扫描完，打印账号密码
  python3 tools/e2e-cols-setup.py cleanup <名字>  # 删号 + 删目录（users.json 里摘掉）
"""
import json
import os
import shutil
import sys
import time
import urllib.request

BASE = 'http://localhost:20059'
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 绕开 HTTP_PROXY
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'server', 'data')
USERS_JSON = os.path.join(DATA, 'users.json')

PASSWORD = 'E2eCols#2026'

# (相对曲库根的路径, 时长秒) —— 故意长短不一：长歌名压「歌曲」列、无专辑压空值列
FIXTURES = [
    ('长歌名测试歌手甲/超长专辑名称用来挤压列宽/这是一个非常非常长的歌曲名称用于测试固定列模板下的截断行为.mp3', 9),
    ('短歌手/短专辑/短.mp3', 3),
    ('歌手名称特别长的测试艺人组合/专辑甲/中等长度歌名.mp3', 6),
    ('无专辑歌手/只有歌名没有专辑名.mp3', 4),
    ('根目录歌曲没有歌手.mp3', 7),
    ('MixedCase Artist/Album 2/Track 06 English Title.mp3', 2),
]


def post_json(path, body, token=None, method='POST'):
    data = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('X-Web-Token', token)
    try:
        with OPENER.open(req, data, timeout=60) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def get_json(path, token=None):
    req = urllib.request.Request(BASE + path, method='GET')
    if token:
        req.add_header('X-Web-Token', token)
    try:
        with OPENER.open(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def synth_mp3(path, seconds):
    """写一个不含 ID3 的合法 CBR MPEG-1 Layer III 文件（128kbps/44.1kHz/单声道）。
    music-metadata 只按帧头算时长，不需要真的解码，所以帧数据填 0 就行。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    frame_len = 417  # 128kbps@44.1kHz 的帧长
    frames = max(1, int(seconds * 44100 / 1152))
    header = bytes([0xFF, 0xFB, 0x90, 0x00])
    with open(path, 'wb') as f:
        for _ in range(frames):
            f.write(header + b'\x00' * (frame_len - len(header)))


def cmd_setup():
    name = 'e2ecols%d' % (int(time.time()) % 10_000_000)
    st, r = post_json('/web/register', {
        'name': name, 'password': PASSWORD, 'confirm': PASSWORD, 'email': name + '@example.com',
    })
    if st != 200 or r.get('code') != 0:
        print('注册失败', st, r)
        return 1
    token = r['data']['token']
    libdir = os.path.join(DATA, 'library', name)
    for rel, secs in FIXTURES:
        synth_mp3(os.path.join(libdir, rel), secs)
    print('账号 %s / %s，曲库目录 %s，合成 %d 首' % (name, PASSWORD, libdir, len(FIXTURES)))

    # 注册后首次访问 /web/api/library/stats 会自动触发扫描
    for _ in range(30):
        st, r = get_json('/web/api/stats', token)
        if st == 200 and isinstance(r.get('data'), dict):
            d = r['data']
            if d.get('tracks') and not (d.get('scan') or {}).get('scanning'):
                print('扫描完成：tracks=%d albums=%d artists=%d' % (d['tracks'], d.get('albums', -1), d.get('artists', -1)))
                print('RESULT %s %s' % (name, PASSWORD))
                return 0
        time.sleep(1)
    st, r = get_json('/web/api/tracks?page=1&size=20', token)
    print('扫描未在 30s 内完成，当前索引：', str(r)[:300])
    print('RESULT %s %s' % (name, PASSWORD))
    return 1


def cmd_cleanup(name):
    if not name.startswith('e2ecols'):
        print('拒绝：只清理 e2ecols* 账号（防止误删主人账号）')
        return 1
    shutil.copy2(USERS_JSON, '/tmp/users.json.bak')
    with open(USERS_JSON, 'r', encoding='utf-8') as f:
        allu = json.load(f)
    before = len(allu.get('users', []))
    allu['users'] = [u for u in allu.get('users', []) if u.get('name') != name]
    with open(USERS_JSON, 'w', encoding='utf-8') as f:
        json.dump(allu, f, ensure_ascii=False, indent=4)
    print('users.json: %d -> %d 个账号（备份 /tmp/users.json.bak）' % (before, len(allu['users'])))
    for d in (os.path.join(DATA, 'library', name), os.path.join(DATA, 'libraries', name)):
        if os.path.isdir(d):
            shutil.rmtree(d)
            print('已删目录', d)
    for d in os.listdir(os.path.join(DATA, 'users')):
        if d.startswith(name + '_'):
            shutil.rmtree(os.path.join(DATA, 'users', d))
            print('已删会话目录', d)
    return 0


def cmd_cleanup_all():
    """兜底：清掉历史上遗留的所有 e2ecols* 账号"""
    names = []
    with open(USERS_JSON, 'r', encoding='utf-8') as f:
        for u in json.load(f).get('users', []):
            if str(u.get('name', '')).startswith('e2ecols'):
                names.append(u['name'])
    if not names:
        print('没有遗留的 e2ecols* 账号')
        return 0
    for n in names:
        cmd_cleanup(n)
    return 0


if __name__ == '__main__':
    if len(sys.argv) >= 2 and sys.argv[1] == 'setup':
        sys.exit(cmd_setup())
    if len(sys.argv) >= 3 and sys.argv[1] == 'cleanup':
        sys.exit(cmd_cleanup(sys.argv[2]))
    if len(sys.argv) >= 2 and sys.argv[1] == 'cleanup-all':
        sys.exit(cmd_cleanup_all())
    print(__doc__)
    sys.exit(2)
