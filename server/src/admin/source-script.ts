import { getStreamToken } from '@/library'

// ---------------------------------------------------------------------------
// 古四音乐 · 自定义源脚本生成器
// 脚本运行在 mobile 端 QuickJS（user-api-preload.js），协议 v2：
//   - 只能覆盖白名单源 ['kw','kg','tx','wy','mg','local']，不能注册自定义 ID
//   - local 源歌曲本地文件缺失时走 apis('local').getMusicUrl → 本脚本返回 NAS 流 URL
//   - 第三方源（用户启用 user_api 后）musicUrl 全部转发到本脚本 → /api/proxy
// 生成的脚本内嵌服务器地址 + 流媒体 token（重置 token 即让旧脚本失效）。
// ---------------------------------------------------------------------------

const VALID_PROXY_SOURCES = ['wy', 'kw', 'tx', 'kg', 'mg']

export const buildSourceScript = (base: string, proxySources: string[]): string => {
  const token = getStreamToken()
  const sources = proxySources.filter(s => VALID_PROXY_SOURCES.includes(s))
  return `/**
 * @name 古四音乐源
 * @description NAS 私人云盘曲库播放/下载 + 第三方音源代理（古四音乐服务端自动生成）
 * @version 1.0.0
 * @author gusi-music
 * @homepage ${base}
 */
(function() {
  'use strict'
  var BASE = ${JSON.stringify(base)}
  var TOKEN = ${JSON.stringify(token)}
  var PROXY_SOURCES = ${JSON.stringify(sources)}

  var lx = globalThis.lx
  var EVENT_NAMES = lx.EVENT_NAMES

  var sign = function(path) {
    return BASE + path + (path.indexOf('?') > -1 ? '&' : '?') + 'k=' + encodeURIComponent(TOKEN)
  }

  var httpGetJson = function(url) {
    return new Promise(function(resolve, reject) {
      lx.request(url, { method: 'get', timeout: 15000, headers: { Accept: 'application/json' } }, function(err, resp, body) {
        if (err) return reject(new Error('NAS 连接失败'))
        if (!resp || resp.statusCode !== 200) return reject(new Error('HTTP ' + (resp && resp.statusCode)))
        var data = body
        if (typeof data === 'string') {
          try { data = JSON.parse(data) } catch (e) { return reject(new Error('响应解析失败')) }
        }
        if (!data || data.code !== 0) return reject(new Error((data && data.msg) || '服务端返回错误'))
        resolve(data.data)
      })
    })
  }

  var getSongId = function(musicInfo) {
    if (!musicInfo) return ''
    return String(musicInfo.songmid || (musicInfo.meta && musicInfo.meta.songId) || '')
  }

  lx.on(EVENT_NAMES.request, function(req) {
    var source = req.source
    var action = req.action
    var info = req.info || {}
    var id = getSongId(info.musicInfo)
    if (!id) return Promise.reject(new Error('缺少歌曲 ID'))

    if (source === 'local') {
      if (action === 'musicUrl') return Promise.resolve(sign('/api/stream/' + encodeURIComponent(id)))
      if (action === 'downloadUrl') return Promise.resolve(sign('/api/download/' + encodeURIComponent(id)))
      if (action === 'pic') return Promise.resolve(sign('/api/cover/' + encodeURIComponent(id)))
      if (action === 'lyric') {
        return httpGetJson(sign('/api/lyric/' + encodeURIComponent(id))).then(function(data) {
          return {
            lyric: (data && data.lyric) || '',
            tlyric: (data && data.tlyric) || null,
            rlyric: (data && data.rlyric) || null,
            lxlyric: (data && data.lxlyric) || null,
          }
        })
      }
      return Promise.reject(new Error('不支持的操作: ' + action))
    }

    if (PROXY_SOURCES.indexOf(source) > -1 && action === 'musicUrl') {
      return httpGetJson(sign('/api/proxy?source=' + encodeURIComponent(source) +
        '&id=' + encodeURIComponent(id) + '&q=' + encodeURIComponent(info.type || '128k')))
    }
    return Promise.reject(new Error('源未启用: ' + source))
  })

  var sources = {
    local: { type: 'music', actions: ['musicUrl', 'downloadUrl', 'pic', 'lyric'], qualitys: [] },
  }
  for (var i = 0; i < PROXY_SOURCES.length; i++) {
    sources[PROXY_SOURCES[i]] = { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac', 'flac24bit'] }
  }

  lx.send(EVENT_NAMES.inited, { status: true, sources: sources })
})()
`
}
