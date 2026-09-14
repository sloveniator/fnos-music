// ---------------------------------------------------------------------------
// 第三方 JS 音源 —— 服务端承载 worker
//   每个「第三方音源脚本」= 一个独立 worker_thread；本文件是 worker 入口。
//   对齐洛雪移动端 user-api-preload.js 宿主协议的最小完整面：
//     lx.EVENT_NAMES / lx.request(url, opts, cb) / lx.on / lx.send
//     lx.utils.crypto.{md5(hex), aesEncrypt, aesDecrypt, rsaEncrypt, randomBytes}
//     lx.utils.buffer.{from, bufToString, bufToBase64, base64ToBuf}
//     lx.env='server' / lx.version / lx.currentScriptInfo；console.*；setTimeout 族
//   worker 自持 node:crypto + node:http(s)，出网不经主线程；主线程只注入：
//     { t:'loadSource', script, sourceId }   → 回报 initedDone / sourceError / log
//     { t:'invoke', requestKey, source, action, info } → 回报 done
//   护栏：脚本在 vm 上下文执行（无 require/process/fs），禁 eval/Function 运行时生成；
//   单请求超时、响应体上限、重定向上限；worker 本身可被 terminate。
// ---------------------------------------------------------------------------
import { parentPort } from 'node:worker_threads'
import * as vm from 'node:vm'
import { createHash, createCipheriv, createDecipheriv, publicEncrypt, randomBytes } from 'node:crypto'
import * as http from 'node:http'
import * as https from 'node:https'

const MAX_BODY = 25 * 1024 * 1024
const MAX_REDIRECT = 5
const DEFAULT_TIMEOUT = 15_000

// ============================== 轻量 http 客户端 ==============================
interface HttpResult { statusCode: number; headers: Record<string, string>; body: string }

function doHttp(opts: { url: string; method?: string; headers?: Record<string, string>; body?: string | null; timeoutMs?: number; redirect?: number }): Promise<HttpResult> {
  const { url, method = 'GET', headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT, redirect = 0 } = opts
  return new Promise<HttpResult>((resolve, reject) => {
    let u: URL
    try { u = new URL(url) } catch { return reject(new Error('bad url')) }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('protocol not allowed: ' + u.protocol))
    const lib = u.protocol === 'https:' ? https : http
    const isBodyMethod = method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD'
    const reqHeaders: Record<string, string> = sanitizeHeaders(headers)
    if (isBodyMethod && body != null) reqHeaders['Content-Length'] = String(Buffer.byteLength(body))
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: method.toUpperCase(),
      headers: reqHeaders,
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY) { req.destroy(new Error('response body too large')); return }
        chunks.push(c)
      })
      res.on('end', () => {
        const status = res.statusCode || 0
        if (status >= 300 && status < 400 && res.headers.location && redirect < MAX_REDIRECT) {
          const next = new URL(res.headers.location, url).toString()
          return doHttp({ url: next, method, headers, body, timeoutMs, redirect: redirect + 1 }).then(resolve, reject)
        }
        const outHeaders: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) {
          outHeaders[k] = String(v)
          if (Object.keys(outHeaders).length >= 40) break
        }
        resolve({ statusCode: status, headers: outHeaders, body: Buffer.concat(chunks).toString('utf8') })
      })
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')))
    req.on('error', reject)
    if (isBodyMethod && body != null) req.write(String(body))
    req.end()
  })
}

/** JSON 启发式解析：Content-Type 含 json / 首字符 { [ 时尝试 parse（失败保留原文） */
function smartParse(raw: string, contentType: string | undefined): string | Record<string, any> {
  const ct = (contentType || '').toLowerCase()
  if (ct.includes('json') || /^\s*[\[{]/.test(raw)) {
    try { return JSON.parse(raw) } catch { /* keep raw */ }
  }
  return raw
}

/** header 清洗：脚本可能从远端配置带出含非法字符的头（如 tag 值为控制符），
 *   Node 会因 invalid character 同步抛错 → 丢非法头/净化值，避免一次请求把源打挂 */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  for (const [k, v] of Object.entries(headers)) {
    const name = String(k)
    if (!HEADER_NAME_RE.test(name)) continue
    const raw = String(v)
    // 保留 latin1 可打印 + tab；其余字符剥掉，避免 header 值非法
    let clean = ''
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i)
      if (c === 9 || (c >= 32 && c <= 255)) clean += raw[i]
    }
    if (clean) out[name] = clean
  }
  return out
}

// ============================== crypto utils ==============================
const md5Hex = (s: string | Buffer): string => createHash('md5').update(s).digest('hex')
const md5Raw = (s: string | Buffer): Buffer => createHash('md5').update(s).digest()
const aesEncrypt = (buf: Buffer, mode: 'cbc' | 'ecb', key: Buffer | string, inputIv?: Buffer | string): Buffer => {
  const useIv = mode === 'ecb' ? null : inputIv != null ? Buffer.from(inputIv as any) : null
  const cipher = useIv ? createCipheriv(`aes-128-${mode}`, Buffer.from(key as any), useIv) : createCipheriv(`aes-128-${mode}`, Buffer.from(key as any), null as any)
  return Buffer.concat([cipher.update(buf), cipher.final()])
}
const aesDecrypt = (buf: Buffer, mode: 'cbc' | 'ecb', key: Buffer | string, inputIv?: Buffer | string): Buffer => {
  const useIv = mode === 'ecb' ? null : inputIv != null ? Buffer.from(inputIv as any) : null
  const decipher = useIv ? createDecipheriv(`aes-128-${mode}`, Buffer.from(key as any), useIv) : createDecipheriv(`aes-128-${mode}`, Buffer.from(key as any), null as any)
  return Buffer.concat([decipher.update(buf), decipher.final()])
}
const rsaEncrypt = (toEncrypt: Buffer | string, pubKey: string): Buffer =>
  publicEncrypt({ key: pubKey, padding: 1 }, Buffer.isBuffer(toEncrypt) ? toEncrypt : Buffer.from(toEncrypt))

// ============================== 运行态 ==============================
interface SourceCap { [code: string]: { type: string; actions: string[]; qualitys?: string[] } }
const state: { requestHandler: null | ((payload: any) => any); inited: boolean; sources: SourceCap | null } = {
  requestHandler: null,
  inited: false,
  sources: null,
}
const post = (o: unknown): void => {
  try { parentPort!.postMessage(o) } catch { /* dying */ }
}

function parseScriptHeader(raw: string): { name: string; description: string; version: string; author: string; homepage: string } {
  const pick = (key: string): string => {
    const m = new RegExp('@' + key + '[ \\t]+([^\\r\\n]+)').exec(raw)
    return m ? m[1].replace(/[*\s]+$/, '').trim() : ''
  }
  return {
    name: pick('name'),
    description: pick('description'),
    version: pick('version'),
    author: pick('author'),
    homepage: pick('homepage'),
  }
}

function buildLx(script: string): any {
  const scriptMeta = parseScriptHeader(script)
  const EVENT_NAMES = Object.freeze({ request: 'request', inited: 'inited', updateAlert: 'updateAlert' })
  const lxRequest = (url: string, optsIn: any, cb?: (err: Error | null, resp?: any, body?: any) => void): (() => void) => {
    const opts = optsIn || {}
    let cancelled = false
    doHttp({
      url,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body != null ? opts.body : null,
      timeoutMs: opts.timeout != null ? Number(opts.timeout) : DEFAULT_TIMEOUT,
    }).then((res) => {
      if (cancelled) return
      const parsed = smartParse(res.body, res.headers['content-type'])
      const resp = { statusCode: res.statusCode, headers: res.headers, body: parsed }
      if (typeof cb === 'function') {
        try {
          if (cb.length >= 3) cb(null, resp, parsed)
          else cb(null, resp)
        } catch (e) { post({ t: 'log', level: 'error', msg: 'script cb error: ' + errText(e) }) }
      }
    }).catch((err) => {
      if (cancelled) return
      if (typeof cb === 'function') {
        try { cb(err instanceof Error ? err : new Error(errText(err))) } catch { /* ignore */ }
      }
    })
    return () => { cancelled = true }
  }

  return {
    EVENT_NAMES,
    env: 'server',
    version: '2.0.0',
    currentScriptInfo: Object.freeze({
      name: scriptMeta.name,
      description: scriptMeta.description,
      version: scriptMeta.version,
      author: scriptMeta.author,
      homepage: scriptMeta.homepage,
      rawScript: script,
    }),
    request: lxRequest,
    on: (event: string, handler: any): Promise<void> => {
      if (event === EVENT_NAMES.request) {
        if (typeof handler !== 'function') return Promise.reject(new Error('request handler must be a function'))
        state.requestHandler = handler
        return Promise.resolve()
      }
      return Promise.reject(new Error('event not supported: ' + event))
    },
    send: (event: string, data: any): Promise<void> => {
      if (event === EVENT_NAMES.inited) {
        if (state.inited) return Promise.reject(new Error('script already inited'))
        state.inited = true
        state.sources = (data && data.sources) || null
        post({ t: 'initedDone', sources: state.sources, status: data ? data.status : undefined, raw: data })
        return Promise.resolve()
      }
      if (event === EVENT_NAMES.updateAlert) {
        post({ t: 'updateAlert', log: data && data.log, updateUrl: data && data.updateUrl })
        return Promise.resolve()
      }
      return Promise.reject(new Error('event not supported: ' + event))
    },
    utils: {
      crypto: {
        md5: md5Hex,
        md5Bytes: md5Raw,
        aesEncrypt,
        aesDecrypt,
        rsaEncrypt,
        randomBytes: (n: number) => randomBytes(n),
        sha256: (s: string | Buffer) => createHash('sha256').update(s).digest('hex'),
      },
      buffer: {
        from: (s: string) => Buffer.from(s, 'utf8'),
        bufToString: (b: Buffer | Uint8Array) => Buffer.from(b).toString('utf8'),
        bufToBase64: (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64'),
        base64ToBuf: (s: string) => Buffer.from(s, 'base64'),
      },
    },
  }
}

// ============================== 执行脚本（vm 沙箱） ==============================
function boot(script: string, sourceId: string): void {
  const lx = buildLx(script)
  const log = (level: string) => (...args: any[]) => post({ t: 'log', level, msg: args.map((a) => (typeof a === 'object' ? safeStr(a) : String(a))).join(' ') })
  const sandbox: any = {
    lx,
    console: { log: log('log'), info: log('log'), warn: log('warn'), error: log('error'), debug: log('log'), group: () => {}, groupEnd: () => {} },
    setTimeout: (cb: any, ms: number) => setTimeout(cb, ms),
    clearTimeout: (id: any) => clearTimeout(id),
    setInterval: (cb: any, ms: number) => setInterval(cb, ms),
    clearInterval: (id: any) => clearInterval(id),
    Buffer,
    URL,
    URLSearchParams,
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  }
  // 明确封死逃逸口
  sandbox.eval = undefined
  sandbox.Function = undefined
  sandbox.require = undefined
  sandbox.process = undefined
  try {
    const ctx = vm.createContext(sandbox, { name: 'gusi-user-source:' + sourceId })
    // 顶层按顺序执行；脚本内部同步注册 on/send，异步初始化靠 worker 自身事件循环继续
    vm.runInContext(script, ctx, { timeout: 5000, filename: 'gusi-user-source://' + sourceId + '.js' })
    post({ t: 'scriptBooted' })
  } catch (e) {
    post({ t: 'sourceError', error: errText(e) })
  }
}

function safeStr(v: any): string {
  try { return JSON.stringify(v) } catch { return String(v) }
}

/** 提取脚本异常的可读信息。vm 内的 Error 常常 message 为空，且 stack 会夹带
 *  整行混淆源码；这里只保留 message 与前若干 frame 行，避免上报成 "Error"。 */
function errText(e: any): string {
  try {
    const msg = String((e && e.message) || e || '').trim()
    const raw = String((e && e.stack) || '')
    const frames = raw.split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 3).map((l) => l.trim()).join(' | ')
    const base = msg || 'Error'
    return frames ? base + '  @ ' + frames : base
  } catch { return 'unknown error' }
}

// ============================== invoke ==============================
function invoke(payload: { requestKey: string; source: string; action: string; info: any }): void {
  const { requestKey, source, action, info } = payload
  const handler = state.requestHandler
  if (!handler) {
    post({ t: 'done', requestKey, ok: false, error: 'request handler not registered' })
    return
  }
  const t0 = Date.now()
  try {
    Promise.resolve(handler({ source, action, info })).then(
      (data: any) => {
        if (action === 'musicUrl') {
          const url = typeof data === 'string' ? data : data && (typeof data.url === 'string' ? data.url : typeof data.data === 'string' ? data.data : null)
          if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
            post({ t: 'done', requestKey, ok: false, error: 'musicUrl 未返回可播放 http(s) 地址', ms: Date.now() - t0 })
          } else {
            post({ t: 'done', requestKey, ok: true, data: url, ms: Date.now() - t0 })
          }
        } else {
          post({ t: 'done', requestKey, ok: true, data, ms: Date.now() - t0 })
        }
      },
      (err: any) => post({ t: 'done', requestKey, ok: false, error: errText(err), ms: Date.now() - t0 }),
    )
  } catch (e) {
    post({ t: 'done', requestKey, ok: false, error: errText(e), ms: Date.now() - t0 })
  }
}

// ============================== 消息主循环 ==============================
parentPort!.on('message', (msg: any) => {
  try {
    if (!msg || typeof msg.t !== 'string') return
    if (msg.t === 'loadSource') boot(String(msg.script ?? ''), String(msg.sourceId ?? '?'))
    else if (msg.t === 'invoke') invoke(msg)
    else if (msg.t === 'ping') post({ t: 'pong' })
  } catch (e) {
    post({ t: 'sourceError', error: errText(e) })
  }
})

post({ t: 'ready' })
