#!/bin/sh
# 快速探活公开源仓库端点（admin token 现取现用）
set -e
PASS="${1:-REDACTED}"
TOK=$(curl -sS --noproxy '*' -m 20 -X POST http://localhost:20059/admin/login \
  -H 'Content-Type: application/json' -d "{\"password\":\"$PASS\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
echo "token=${TOK%"${TOK#????????}"}..."
curl -sS --noproxy '*' -m 240 "http://localhost:20059/admin/api/library/source-registries?refresh=1" \
  -H "X-Admin-Token: $TOK" -o /tmp/reg.json -w 'HTTP %{http_code}\n'
python3 - <<'PY'
import json
d = json.load(open('/tmp/reg.json'))
data = d.get('data') or d
if 'list' not in data:
    print('返回异常:', json.dumps(d, ensure_ascii=False)[:400]); raise SystemExit(1)
print('cached=%s fetchedAt=%s' % (data.get('cached'), data.get('fetchedAt')))
print('registries:', json.dumps(data.get('registries'), ensure_ascii=False))
print('stats:', json.dumps(data.get('stats'), ensure_ascii=False))
lst = data.get('list') or []
print('共 %d 个音源' % len(lst))
for s in lst:
    inst = s['installed']
    tag = ('%s v%s %sB enabled=%s' % (inst['id'], inst.get('version'), inst['bytes'], inst['enabled'])) if inst else '未安装'
    print('%-9s %-22s 版本=%-10s %7dB  %-8s <- %s' % (s['key'], s['name'][:22], s['versionRaw'][:10], s['bytes'], s['state'], tag))
PY
