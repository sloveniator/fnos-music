// ---------------------------------------------------------------------------
// 在线音乐「平台歌单广场」：按音源给出该平台的在线歌单列表（默认视图，不用先搜索）
//
//   网易云：官方推荐歌单接口（/weapi/personalized/playlist），走 ./daily 的每日轮换缓存。
//   酷我 / 咪咕 / 汽水：这三家都没有可用的「推荐歌单」公开端点 ——
//     酷我 www.kuwo.cn/api/www 那套要网页下发的 kw_token（实测 cookie+csrf 仍被拒），
//     咪咕 cms 推荐接口只回 SPA 壳，汽水实测无公开榜单/推荐端点。
//     于是改用「平台热门标签 × 平台歌单搜索」拼出广场：每个标签取一页歌单，
//     并发取回后按标签轮流交错（保证同一批里标签多样），去重后截断。
//
//   「换一批」= batch 递增 → 换一组标签，所以每次点都能看到不同内容。
//   结果按 (source, batch) 做 30 分钟内存缓存，避免反复点切换时打爆上游。
// ---------------------------------------------------------------------------

import type { OnlineCollection } from './kw'
import { dailyRecPlaylists } from './daily'
import { kwSearchPlaylists } from './kw'
import { mgSearchPlaylists } from './mg'
import { sodaSearchPlaylists } from './soda'

/** 热门标签分组：每组一次「换一批」，组内每个标签取一行 12 张 */
const TAG_GROUPS: string[][] = [
  ['热歌', '华语流行', '经典老歌', '网络热歌'],
  ['粤语', '民谣', '摇滚', '电子'],
  ['古风', '二次元', '纯音乐', '轻音乐'],
  ['说唱', '爵士', '英文', '日韩'],
  ['情歌', '怀旧', '钢琴', 'dj'],
]

/** 每个标签取多少张（4 个标签 × 12 = 48 张池子，去重后按 limit 截） */
const PER_TAG = 12
/** 单源缓存 TTL：够「换一批 / 切音源」来回点不重复打上游 */
const CACHE_TTL = 30 * 60 * 1000

interface CacheRow { ts: number, list: OnlineCollection[] }
const cache = new Map<string, CacheRow>()

const searcherOf = (source: string) => {
  if (source === 'kw') return kwSearchPlaylists
  if (source === 'mg') return mgSearchPlaylists
  if (source === 'soda') return sodaSearchPlaylists
  return null
}

/** 轮流交错：把 [[a1,a2],[b1,b2],[c1]] 拉平成 a1,b1,c1,a2,b2 —— 让标签多样性前置 */
const interleave = (groups: OnlineCollection[][]): OnlineCollection[] => {
  const out: OnlineCollection[] = []
  const max = groups.reduce((n, g) => Math.max(n, g.length), 0)
  for (let i = 0; i < max; i++) {
    for (const g of groups) if (g[i]) out.push(g[i])
  }
  return out
}

const dedupe = (list: OnlineCollection[], limit: number): OnlineCollection[] => {
  const seen = new Set<string>()
  const out: OnlineCollection[] = []
  for (const x of list) {
    if (!x || !x.id || seen.has(x.id)) continue
    seen.add(x.id)
    out.push(x)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 平台歌单（batches 从 0 开始，前端「换一批」就 +1）。
 * 上游整体失败时抛错；单个标签失败只丢那一组（有就回，全空才算失败）。
 */
export const platformPlaylists = async (source: string, batch: number, limit: number): Promise<OnlineCollection[]> => {
  const n = Math.min(Math.max(limit | 0, 1), 48)

  // 网易云走官方推荐歌单（已按天轮换，不需要关键词拼）
  if (source === 'wy') {
    const list = await dailyRecPlaylists(n)
    return list.map((x) => ({
      source: 'wy', id: x.id, name: x.name, creator: x.creator, trackCount: x.trackCount, pic: x.pic || null,
    }))
  }

  const search = searcherOf(source)
  if (!search) return []

  const gi = ((batch | 0) % TAG_GROUPS.length + TAG_GROUPS.length) % TAG_GROUPS.length
  const tags = TAG_GROUPS[gi]
  const key = source + '|' + gi + '|' + n
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.list

  const settled = await Promise.allSettled(tags.map((t) => search(t, 1, PER_TAG)))
  const groups = settled.map((r) => (r.status === 'fulfilled' ? (r.value.list || []) : []))
  const got = groups.reduce((a, g) => a + g.length, 0)
  if (!got) {
    const first = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
    throw new Error(first ? String(first.reason?.message ?? first.reason) : '上游没有返回歌单')
  }
  const list = dedupe(interleave(groups), n)
  cache.set(key, { ts: Date.now(), list })
  return list
}

/** 平台歌单广场的来源说明（前端页头展示，说清这批歌单是怎么来的） */
export const platformPlaylistsHint = (source: string): string =>
  source === 'wy' ? '推荐歌单 · 每日轮换' : '平台歌单 · 按热门标签聚合（点「换一批」换一组标签）'
