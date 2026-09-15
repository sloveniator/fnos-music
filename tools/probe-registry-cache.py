import json, urllib.request, urllib.error, hashlib
BASE='http://localhost:20059'
OP=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def api(p, m='GET', b=None, tok=None, t=120):
    r=urllib.request.Request(BASE+p, method=m); r.add_header('Content-Type','application/json')
    if tok: r.add_header('X-Admin-Token', tok)
    d=json.dumps(b).encode() if b is not None else None
    try:
        with OP.open(r,d,timeout=t) as x: return x.status, json.loads(x.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, {}
st,d=api('/admin/login','POST',{'password':'REDACTED'})
tok=(d.get('data') or d).get('token'); assert tok, d
snap=(api('/admin/api/library/user-sources/ikun',tok=tok)[1].get('data') or {})
snap_script=snap.get('script') or ''
print('快照 ikun: %dB enabled=%s' % (len(snap_script), snap.get('enabled')))
old=api('/admin/api/library/user-sources/fetch','POST',{'url':'https://cdn.jsdelivr.net/gh/pdone/lx-music-source@main/ikun/6.js'},tok=tok)[1]
old_script=(old.get('data') or {}).get('script') or ''
st,_=api('/admin/api/library/user-sources','POST',{'id':'ikun','name':snap.get('name') or 'ikun音源','script':old_script,'enabled':bool(snap.get('enabled'))},tok=tok)
print('降级为 v6: HTTP', st)
st,cd=api('/admin/api/library/source-registries',tok=tok,t=60)
c=cd.get('data') or {}
ik=next((x for x in (c.get('list') or []) if x['key']=='ikun'), {})
print('不带 refresh 的缓存读取: cached=%s state=%s 本地版本=%s' % (c.get('cached'), ik.get('state'), (ik.get('installed') or {}).get('version')))
print('判定: %s' % ('FAIL —— 缓存仍是旧状态（未重新贴本地状态）' if ik.get('state')!='upgrade' else 'OK —— 缓存立即反映本地已降级'))
st,_=api('/admin/api/library/source-registries/apply','POST',{'keys':['ikun']},tok=tok,t=180)
fin=api('/admin/api/library/user-sources/ikun',tok=tok)[1].get('data') or {}
same=hashlib.sha256((fin.get('script') or '').encode()).hexdigest()==hashlib.sha256(snap_script.encode()).hexdigest()
print('还原 ikun: 与快照一致=%s enabled=%s/%s' % (same, fin.get('enabled'), snap.get('enabled')))
