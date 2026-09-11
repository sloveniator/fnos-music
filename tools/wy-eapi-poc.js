// wy eapi POC（算法照抄 lx-music-desktop wy/utils/crypto.js）
const crypto = require('crypto')
const eapiKey = 'e82ckenh8dichen8'
const aesEncrypt = (buf) => { const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(eapiKey), null); return Buffer.concat([c.update(buf), c.final()]) }
const eapi = (url, obj) => {
  const text = typeof obj === 'object' ? JSON.stringify(obj) : obj
  const digest = crypto.createHash('md5').update(`nobody${url}use${text}md5forencrypt`).digest('hex')
  return aesEncrypt(Buffer.from(`${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`)).toString('hex').toUpperCase()
}
async function post(url, params, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', 'Content-Type': 'application/x-www-form-urlencoded', origin: 'https://music.163.com', ...headers }, body: 'params=' + encodeURIComponent(params) })
  const t = await r.text(); try { return JSON.parse(t) } catch { return t }
}
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0', origin: 'https://music.163.com', referer: 'https://music.163.com/' }
;(async () => {
  // 1) search via eapi/batch gateway (desktop code path)
  const searchData = { keyword: '晴天 周杰伦', needCorrect: '1', channel: 'typing', offset: 0, scene: 'normal', total: true, limit: 5 }
  const s1 = await post('https://interface.music.163.com/eapi/batch', eapi('/api/search/song/list/page', searchData), UA)
  console.log('search code:', s1.code, typeof s1.data)
  let id = null
  if (s1.code === 200) {
    const res = (s1.data.resources || [])
    console.log('resources:', res.length, res[0] && res[0].baseInfo.simpleSongData.name)
    id = res[0].baseInfo.simpleSongData.id
  }
  // 2) lyric via eapi song/lyric
  if (id) {
    const ly = await post('https://interface.music.163.com/eapi/batch', eapi('/api/song/lyric', { id, lv: -1, tv: -1, kv: -1 }), UA)
    console.log('lyric code:', ly.code, ly.lrc ? ly.lrc.lyric.slice(0, 90).replace(/\n/g, ' / ') : 'no lrc', '| tlyric:', ly.tlyric ? 'Y' : 'N')
    // 3) play url via eapi song/enhance/player/url (anonymous)
    const ur = await post('https://interface.music.163.com/eapi/batch', eapi('/api/song/enhance/player/url', { ids: '[' + id + ']', br: 128000, level: 'standard' }), UA)
    console.log('url code:', ur.code, JSON.stringify(ur.data || ur.msg || '').slice(0, 160))
  }
})().catch(e => { console.error('ERR', e.message) })
