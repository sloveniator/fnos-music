// 用真实网络的假 lx 环境运行 Grass.js，观察它注册的源/actions/远端调用
const fs = require('fs');
const http = require('http');
const https = require('https');

const code = fs.readFileSync(process.argv[2], 'utf8');

function requestReal(url, opts, cb) {
  const mod = String(url).startsWith('https') ? https : http;
  const u = new URL(String(url));
  const headers = Object.assign({ 'User-Agent': 'lx-probe/1.0' }, (opts && opts.headers) || {});
  const req = mod.request(u, { method: (opts && opts.method) || 'GET', headers, timeout: 8000 }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, { statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', (e) => cb(e));
  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  if (opts && opts.body) req.write(opts.body);
  req.end();
}

const seen = { on: [], send: [], events: {} };
globalThis.lx = {
  EVENT_NAMES: { request: '__REQ__', inited: '__INITED__', updateAlert: '__UPDATE_ALERT__', updateUrl: '__UPDATE_URL__' },
  env: { version: '2.0.0', os: 'node' },
  version: '2.0.0',
  currentScriptInfo: { version: '1' },
  utils: { crypto: {} },
  request: (url, opts, cb) => {
    console.log('[lx.request]', ((opts && opts.method) || 'GET'), String(url).slice(0, 180));
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    requestReal(url, opts || {}, (err, resp) => {
      if (err) return cb(err);
      // 洛雪回调为 (err, resp, body)：body 与 resp.body 同值
      cb(null, resp, resp.body);
    });
  },
  on: (ev, fn) => { seen.events[ev] = fn; },
  send: (ev, payload) => { seen.send.push([ev, JSON.stringify(payload)]); },
};

try {
  new Function(code)();
} catch (e) {
  console.log('[run error]', e.message);
}
setTimeout(() => {
  console.log('=== on registered events:', Object.keys(seen.events));
  console.log('=== send payloads ===');
  for (const [ev, pl] of seen.send) console.log('send', ev, pl.slice(0, 1500));
  const reqFn = seen.events['__REQ__'];
  if (reqFn && typeof reqFn === 'function') {
    console.log('=== trigger request(kw/musicUrl/TESTMID123) ===');
    reqFn({ source: 'kw', action: 'musicUrl', info: { musicInfo: { songmid: 'TESTMID123', type: 'song' }, type: 'song' } });
  }
  setTimeout(() => process.exit(0), 4000);
}, 1500);
