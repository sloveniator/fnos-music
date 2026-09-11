# -*- coding: utf-8 -*-
"""Generate a small pretty preview library + start node server on port 19990."""
import os, random, subprocess, sys, tempfile

DATA = os.path.join(tempfile.gettempdir(), 'gusi-preview-19990')
if os.path.exists(DATA):
    import shutil; shutil.rmtree(DATA)

def wavfile(path, dur=1.0):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    rate = 44100; n = int(rate * dur)
    with open(path, 'wb') as f:
        f.write(b'RIFF')
        f.write((36 + n * 2).to_bytes(4, 'little'))
        f.write(b'WAVEfmt ')
        f.write((16).to_bytes(4, 'little'))
        f.write((1).to_bytes(2, 'little'))   # PCM
        f.write((1).to_bytes(2, 'little'))   # mono
        f.write(rate.to_bytes(4, 'little'))
        f.write((rate * 2).to_bytes(4, 'little'))
        f.write((2).to_bytes(2, 'little'))
        f.write((16).to_bytes(2, 'little'))
        f.write(b'data')
        f.write((n * 2).to_bytes(4, 'little'))
        for i in range(n):
            f.write(((i * 40) % 65536 - 32768).to_bytes(2, 'little', signed=True))

def mp3file(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        # minimal fake MP3 frame stream, ~1s of silence
        f.write(b'\xff\xfb\x90\x00')
        body = bytes(random.randrange(256) for _ in range(4000))
        f.write(body)

M = os.path.join(DATA, 'music')
lib = [
    (['【Music】', '周杰伦', '范特西'], ['爱在西元前', '爸我回来了', '简单爱', '忍者', '开不了口', '上海一九四三', '对不起', '威廉古堡'], 'wav'),
    (['【Music】', '周杰伦', '八度空间'], ['半兽人', '半岛铁盒', '暗号', '龙拳', '火车叨位去'], 'wav'),
    (['【Music】', '林俊杰', '第二天堂'], ['江南', '豆浆油条', '害怕', '第二天堂'], 'wav'),
    (['【Music】', '王菲', '寓言'], ['寒武纪', '新房客', '香奈儿', '阿修罗', '彼岸花'], 'mp3'),
    (['MusicDump', '陈奕迅', 'U87'], ['浮夸', '葡萄成熟时', '夕阳无限好', '阿牛'], 'wav'),
    (['MusicDump', '单曲', ''], ['晴天 - 周杰伦', '海阔天空 - Beyond', '夜曲 - 周杰伦'], 'mp3'),
]
idx = 0
for dirs, names, ext in lib:
    d = os.path.join(M, *dirs) if dirs[-1] else os.path.join(M, *dirs[:-1])
    for i, name in enumerate(names, 1):
        idx += 1
        p = os.path.join(d, ('%02d - %s.%s' % (i, name, ext)) if dirs[-1] else ('%s.%s' % (name, ext)))
        (wavfile if ext == 'wav' else mp3file)(p)

env = dict(os.environ)
env['PORT'] = '19990'
env['BIND_IP'] = '127.0.0.1'
env['GS_ADMIN_PASSWORD'] = 'preview-pw'
env['DATA_PATH'] = DATA
env['GS_WEB_STATIC_DIR'] = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'ui', 'dist')
env['GS_APP_STATIC_DIR'] = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'ui', 'app')
env['GS_ACCESSIBLE_PATHS_FILE'] = os.path.join(tempfile.gettempdir(), 'gusi-preview-access.env')

if os.path.exists(env['GS_ACCESSIBLE_PATHS_FILE']):
    os.remove(env['GS_ACCESSIBLE_PATHS_FILE'])

ps = r'''$env:PORT="{p}"; $env:BIND_IP="127.0.0.1"; $env:GS_ADMIN_PASSWORD="preview-pw"; $env:DATA_PATH="{d}"; $env:GS_WEB_STATIC_DIR="{w}"; $env:GS_APP_STATIC_DIR="{a}"; $env:GS_ACCESSIBLE_PATHS_FILE="{acc}"; Start-Process node -ArgumentList 'index.js' -WorkingDirectory "{srv}" -WindowStyle Hidden -RedirectStandardOutput "{d}\preview-out.log" -RedirectStandardError "{d}\preview-err.log"'''
ps = ps.replace('{p}', '19990').replace('{d}', DATA).replace('{w}', env['GS_WEB_STATIC_DIR']).replace('{a}', env['GS_APP_STATIC_DIR']).replace('{acc}', env['GS_ACCESSIBLE_PATHS_FILE']).replace('{srv}', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'server'))
with open(os.path.join(DATA, 'start.cmd'), 'w', encoding='ascii') as f:
    f.write('@echo off\npowershell -NoProfile -ExecutionPolicy Bypass -Command "' + ps + '"\n')

print('DATA', DATA)
print('files', idx)
