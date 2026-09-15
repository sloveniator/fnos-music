// ---------------------------------------------------------------------------
// 每日推荐歌单（首页「推荐歌单」+ 在线音乐「歌单广场」共用）
//
// 需求：推荐歌单每日轮换 —— 同一天里刷新多少次都是同一批，第二天自动换。
// 做法：以北京时间（UTC+8）当天为键缓存一份候选池，落盘 data/cache/rec-playlists.json
//       （重启不丢）；展示顺序与当天取哪几张由「当天种子」洗牌决定，所以哪怕上游
//       偶发返回同一批，第二天看到的子集与顺序也会变。
// 兜底：当天首次拉取失败时沿用上一次的池子（旧池子也没有才抛错）。
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import path from 'node:path'
import { wyRecPlaylists } from './wy'

export interface RecPlaylist {
  id: string
  name: string
  pic: string
  trackCount: number
  creator: string
}

/** 每天向上游要多少张候选（越多，日与日之间的差异越明显） */
const POOL_SIZE = 60
/** 单次返回上限（首页 12 张、歌单广场 60 张） */
const MAX_RETURN = 60

const cacheFile = () => path.join(global.lx.dataPath, 'cache', 'rec-playlists.json')

/** 北京时间当天，形如 2026-09-15（NAS 上按国内时区轮换，不受容器 TZ 影响） */
const dayKey = (): string => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

/** 当天种子洗牌：同一天结果稳定，第二天换序（xorshift32，确定性） */
const seededShuffle = <T>(list: T[], seed: string): T[] => {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const rnd = () => {
    h ^= h << 13; h >>>= 0
    h ^= h >>> 17
    h ^= h << 5; h >>>= 0
    return h / 4294967296
  }
  const a = list.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}

interface Cache { day: string, items: RecPlaylist[] }

const readCache = (): Cache | null => {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'))
    if (j && typeof j.day === 'string' && Array.isArray(j.items) && j.items.length) {
      return { day: j.day, items: j.items }
    }
  } catch { /* 无缓存/文件损坏都按没有处理 */ }
  return null
}

const writeCache = (day: string, items: RecPlaylist[]) => {
  try {
    const file = cacheFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ day, items }, null, 2))
    fs.renameSync(tmp, file)
  } catch (e) {
    // 写缓存失败不影响本次返回
    console.warn('[rec-playlists] 写缓存失败:', (e as Error).message)
  }
}

/** 去重（同一张歌单上游可能重复出现）+ 去掉拿不到封面的空条目 */
const normalize = (list: RecPlaylist[]): RecPlaylist[] => {
  const seen = new Set<string>()
  const out: RecPlaylist[] = []
  for (const x of list) {
    if (!x.id || seen.has(x.id)) continue
    seen.add(x.id)
    out.push(x)
  }
  return out
}

let inflight: Promise<RecPlaylist[]> | null = null

/** 取当天候选池（进程内并发合并成一次上游请求） */
const poolOfToday = async (): Promise<RecPlaylist[]> => {
  const day = dayKey()
  const cached = readCache()
  if (cached && cached.day === day) return cached.items
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const pool = normalize(await wyRecPlaylists(POOL_SIZE))
      if (!pool.length) throw new Error('上游返回空列表')
      writeCache(day, pool)
      return pool
    } catch (e) {
      // 上游抽风：沿用上一次的池子，总比首页空着强
      if (cached && cached.items.length) {
        console.warn('[rec-playlists] 今日拉取失败，沿用上次缓存:', (e as Error).message)
        return cached.items
      }
      throw e
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * 从候选池里挑出某一天的展示列表：同一天稳定、换一天换序换子集。
 * 独立导出是为了能用固定日期做确定性验证（testsuite 里直接跑编译产物）。
 */
export const pickForDay = (pool: RecPlaylist[], day: string, limit: number): RecPlaylist[] => {
  const n = Math.min(Math.max(limit | 0, 1), MAX_RETURN)
  return seededShuffle(pool, day).slice(0, n)
}

/** 当天推荐歌单（按 limit 截取，顺序为当天种子洗牌后的顺序） */
export const dailyRecPlaylists = async (limit: number): Promise<RecPlaylist[]> => {
  const pool = await poolOfToday()
  return pickForDay(pool, dayKey(), limit)
}

/** 仅供测试/诊断：当前缓存是哪一天、有多少张 */
export const recPlaylistsState = (): { day: string, count: number, today: string } => {
  const c = readCache()
  return { day: c?.day ?? '', count: c?.items.length ?? 0, today: dayKey() }
}
