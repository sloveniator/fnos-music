import fs from 'node:fs'
import path from 'node:path'
import { getUserSpace, getUserDirname } from '@/user'
import { handleListAction } from '@/modules/list/sync/handler'
import { type TrackInfo } from '@/library'
import { getTenantTrack } from '@/library/tenant'
import { LIST_IDS } from '@/constants'

// ---------------------------------------------------------------------------
// Web 端歌单操作：复用同步 list 模块的数据变更 + 快照，并把动作广播给
// 该用户全部在线同步设备（手机端实时看到 Web 端的增删改）
// ---------------------------------------------------------------------------

let broadcastFn: ((userName: string, action: LX.Sync.List.ActionList) => Promise<void>) | null = null

export const setListBroadcaster = (fn: typeof broadcastFn): void => {
  broadcastFn = fn
}

/** NAS 曲库曲目 → 洛雪 MusicInfoLocal（与 .lxmc 导出同形状，手机端可播） */
export const trackToMusicInfo = (t: TrackInfo) => ({
  id: `local_${t.id}`,
  name: t.name,
  singer: t.singer || '未知歌手',
  source: 'local' as const,
  interval: t.interval,
  meta: {
    songId: t.id,
    albumName: t.album,
    picUrl: '',
    filePath: t.id,
    ext: t.ext,
  },
})

const applyAction = async(userName: string, action: LX.Sync.List.ActionList): Promise<void> => {
  await handleListAction(userName, action, false)
  if (broadcastFn) await broadcastFn(userName, action).catch(err => console.error('web list broadcast error:', err.message))
}

export const createPlaylist = async(userName: string, name: string): Promise<string> => {
  const id = 'userlist_web_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8)
  const listInfo = { name, id, source: undefined, sourceListId: undefined, locationUpdateTime: Date.now() }
  const userSpace = getUserSpace(userName)
  const position = (await userSpace.listManage.getListData()).userList.length
  await applyAction(userName, { action: 'list_create', data: { position, listInfos: [listInfo] } })
  return id
}

export const renamePlaylist = async(userName: string, id: string, name: string): Promise<void> => {
  const userSpace = getUserSpace(userName)
  const info = (await userSpace.listManage.getListData()).userList.find(l => l.id == id)
  if (!info) throw new Error('歌单不存在')
  await applyAction(userName, { action: 'list_update', data: [{ ...info, name, locationUpdateTime: Date.now() }] })
}

export const removePlaylists = async(userName: string, ids: string[]): Promise<void> => {
  await applyAction(userName, { action: 'list_remove', data: ids })
}

export const addTrackIds = async(userName: string, listId: string, trackIds: string[]): Promise<number> => {
  const musics = trackIds.map(id => getTenantTrack(userName, id)).filter(Boolean).map(t => trackToMusicInfo(t!))
  if (!musics.length) throw new Error('没有有效曲目')
  const addMusicLocationType = global.lx.config['list.addMusicLocationType']
  await applyAction(userName, { action: 'list_music_add', data: { id: listId, musicInfos: musics, addMusicLocationType } })
  return musics.length
}

export const removeMusicIds = async(userName: string, listId: string, musicIds: string[]): Promise<void> => {
  await applyAction(userName, { action: 'list_music_remove', data: { listId, ids: musicIds } })
}

export const clearPlaylist = async(userName: string, listId: string): Promise<void> => {
  await applyAction(userName, { action: 'list_music_clear', data: [listId] })
}

export const overwritePlaylistOrder = async(userName: string, listId: string, musicIds: string[]): Promise<void> => {
  const userSpace = getUserSpace(userName)
  const musics = await userSpace.listManage.listDataManage.getListMusics(listId)
  const map = new Map(musics.map(m => [m.id, m]))
  const ordered = musicIds.map(id => map.get(id)).filter(Boolean) as typeof musics
  if (ordered.length != musics.length) throw new Error('排序数据不完整')
  await applyAction(userName, { action: 'list_music_overwrite', data: { listId, musicInfos: ordered } })
}

/** 我喜欢 收藏状态切换；返回切换后是否已收藏 */
export const toggleLove = async(userName: string, trackId: string): Promise<boolean> => {
  const userSpace = getUserSpace(userName)
  const track = getTenantTrack(userName, trackId)
  if (!track) throw new Error('曲目不存在')
  const music = trackToMusicInfo(track)
  const loveList = await userSpace.listManage.listDataManage.getListMusics(LIST_IDS.LOVE)
  const existing = loveList.find(m => m.id == music.id)
  if (existing) {
    await applyAction(userName, { action: 'list_music_remove', data: { listId: LIST_IDS.LOVE, ids: [music.id] } })
    return false
  }
  await applyAction(userName, { action: 'list_music_add', data: { id: LIST_IDS.LOVE, musicInfos: [music], addMusicLocationType: 'top' } })
  return true
}
/**
 * 冷启动竞态：ListDataManage 在构造函数里 fire-and-forget 读快照，用户空间刚
 * 创建时首个请求可能读到空列表（症状：歌单显示「一首都没有」、删歌后发现引用
 * 没清干净）。先 await ready，再保留一轮短重试兜底。
 */
const waitListData = async(userSpace: ReturnType<typeof getUserSpace>): Promise<LX.Sync.List.ListData> => {
  await userSpace.listManage.listDataManage.ready.catch(() => { /* 读快照失败时按空列表处理 */ })
  let data = await userSpace.listManage.getListData()
  for (let i = 0; i < 6; i++) {
    if (data.defaultList.length || data.loveList.length || data.userList.length) break
    await new Promise(r => setTimeout(r, 40))
    data = await userSpace.listManage.getListData()
  }
  return data
}
/**
 * 冷启动竞态：ListDataManage 在构造函数里 fire-and-forget 读快照，用户空间刚创建
 * 或服务刚启动时，首个请求可能读到空列表——表现就是歌单突然「一首都没有」。
 * 凡是要把列表内容展示给用户的读取都走这里，别直接 getListData()。
 */
export const getListDataStable = async(userName: string): Promise<LX.Sync.List.ListData> =>
  waitListData(getUserSpace(userName))

/**
 * 曲目文件名变化后迁移引用。
 * 曲目 id 由相对路径决定（scan.trackId），重命名会让 id 变化，而歌单里存的是
 * local_<id>；不迁移的话该曲目在歌单里会变成失效项。返回被改动的歌单名。
 * 「最近播放」是 Web 端本地记录、不参与同步，直接改内存并落盘。
 */
export const migrateTrackRefs = async(userName: string, oldId: string, newId: string): Promise<string[]> => {
  if (!oldId || !newId || oldId === newId) return []
  const oldMusicId = 'local_' + oldId
  const newMusicId = 'local_' + newId
  const touched: string[] = []
  const userSpace = getUserSpace(userName)
  // 直接取 getListData() 的数组（与 GET /web/api/playlists 同源）。
  // 「我的歌单」「我喜欢」是内置列表，不出现在 userList 里，必须单独并入，
  // 否则往内置歌单里加过的曲目在重命名后会变成失效项。
  const data = await waitListData(userSpace)
  const targets: Array<{ id: string, name: string, list: LX.Music.MusicInfo[] }> = [
    { id: LIST_IDS.DEFAULT, name: '我的歌单', list: data.defaultList as LX.Music.MusicInfo[] },
    { id: LIST_IDS.LOVE, name: '我喜欢', list: data.loveList as LX.Music.MusicInfo[] },
    ...data.userList.map(l => ({ id: l.id, name: l.name, list: l.list as LX.Music.MusicInfo[] })),
  ]
  for (const item of targets) {
    const list = item.list
    if (!Array.isArray(list) || !list.some(m => m?.id === oldMusicId)) continue
    // 顺带把显示名/歌手/专辑同步成新曲目的值，否则歌单里仍是旧名，看着像没重命名成功
    const fresh = getTenantTrack(userName, newId)
    const next = list.map(m => (
      m.id === oldMusicId
        ? {
            ...m,
            id: newMusicId,
            name: fresh?.name || m.name,
            singer: fresh?.singer || m.singer,
            meta: { ...((m as any).meta || {}), songId: newId, albumName: fresh?.album ?? (m as any).meta?.albumName, filePath: newId },
          }
        : m
    )) as typeof list
    await applyAction(userName, { action: 'list_music_overwrite', data: { listId: item.id, musicInfos: next } })
    touched.push(item.name || item.id)
  }
  const played = loadPlayed(userName)
  if (played.includes(oldId)) {
    playedCache.set(userName, played.map(x => (x === oldId ? newId : x)))
    flushPlayed(userName)
  }
  return touched
}

/**
 * 曲目从曲库删除后清理引用（与 migrateTrackRefs 对称的反向操作）。
 * 歌单/收藏里存的是 local_<id>，曲目没了就成了死引用：歌单里会留下一行
 * 「看着能点、点了就报错」的幽灵曲目——内置歌单（我的歌单/我喜欢）没有移除
 * 入口，用户只能点「删除」，而服务端查不到该 id 只会回「曲目不存在」。
 * 所以删除曲目时必须顺手把引用摘掉，别再制造新的死引用。
 * 返回被改动的歌单名，供前端如实提示。
 */
export const dropTrackRefs = async(userName: string, trackIds: string[]): Promise<string[]> => {
  const gone = new Set((trackIds || []).map(String).filter(Boolean))
  if (!gone.size) return []
  const isGoneRef = (m: any): boolean =>
    !!m && m.source == 'local' && typeof m.id == 'string' && m.id.startsWith('local_') && gone.has(m.id.substring(6))
  const touched: string[] = []
  const userSpace = getUserSpace(userName)
  // 与 migrateTrackRefs 同源：内置列表不在 userList 里，必须单独并入
  const data = await waitListData(userSpace)
  const targets: Array<{ id: string, name: string, list: LX.Music.MusicInfo[] }> = [
    { id: LIST_IDS.DEFAULT, name: '我的歌单', list: data.defaultList as LX.Music.MusicInfo[] },
    { id: LIST_IDS.LOVE, name: '我喜欢', list: data.loveList as LX.Music.MusicInfo[] },
    ...data.userList.map(l => ({ id: l.id, name: l.name, list: l.list as LX.Music.MusicInfo[] })),
  ]
  for (const item of targets) {
    const list = item.list
    if (!Array.isArray(list)) continue
    const dead = list.filter(isGoneRef).map((m: any) => m.id as string)
    if (!dead.length) continue
    await applyAction(userName, { action: 'list_music_remove', data: { listId: item.id, ids: dead } })
    touched.push(item.name || item.id)
  }
  // 最近播放是 Web 端本地记录，不参与同步
  const played = loadPlayed(userName)
  const next = played.filter(id => !gone.has(id))
  if (next.length != played.length) {
    playedCache.set(userName, next)
    flushPlayed(userName)
  }
  return touched
}

// ---------------------------------------------------------------------------
// 最近播放（Web 端本地记录，每用户一份，不参与同步）
// ---------------------------------------------------------------------------

const playedFile = (userName: string): string =>
  path.join(global.lx.userPath, getUserDirname(userName), 'web-played.json')

const PLAYED_LIMIT = 100
/** 写入防抖：连续快速播放只落盘一次，避免每次播放都 read+write 整个 JSON */
const PLAYED_FLUSH_MS = 2000

// 每用户一份内存队列（启动时从磁盘载入，变更后防抖落盘）
const playedCache = new Map<string, string[]>()
const playedTimers = new Map<string, ReturnType<typeof setTimeout>>()

const loadPlayed = (userName: string): string[] => {
  const hit = playedCache.get(userName)
  if (hit) return hit
  let ids: string[] = []
  try {
    const data = JSON.parse(fs.readFileSync(playedFile(userName), 'utf8'))
    if (Array.isArray(data?.ids)) ids = data.ids.filter((id: unknown) => typeof id == 'string')
  } catch {}
  playedCache.set(userName, ids)
  return ids
}

const flushPlayed = (userName: string): void => {
  const ids = playedCache.get(userName) ?? []
  try {
    fs.mkdirSync(path.dirname(playedFile(userName)), { recursive: true })
    fs.writeFileSync(playedFile(userName) + '.tmp', JSON.stringify({ version: 1, ids }))
    fs.renameSync(playedFile(userName) + '.tmp', playedFile(userName))
  } catch (err: any) {
    console.error('flush played failed:', err?.message)
  }
}

export const recordPlayed = (userName: string, trackId: string): void => {
  if (!getTenantTrack(userName, trackId)) return
  const prev = loadPlayed(userName)
  // 置顶 + 去重：已存在的同名条目先剔除再放到队首
  const next = [trackId, ...prev.filter(id => id != trackId)].slice(0, PLAYED_LIMIT)
  playedCache.set(userName, next)
  const old = playedTimers.get(userName)
  if (old) clearTimeout(old)
  const t = setTimeout(() => {
    playedTimers.delete(userName)
    flushPlayed(userName)
  }, PLAYED_FLUSH_MS)
  // unref：不阻塞进程退出；退出前由 flushAllPlayed 兜底刷盘
  t.unref?.()
  playedTimers.set(userName, t)
}

/** 退出前刷盘全部用户的待落盘播放记录 */
export const flushAllPlayed = (): void => {
  const users = new Set([...playedCache.keys(), ...onlinePlayedCache.keys()])
  for (const userName of users) {
    const t = playedTimers.get(userName)
    if (t) clearTimeout(t)
    playedTimers.delete(userName)
    flushPlayed(userName)
    const t2 = onlinePlayedTimers.get(userName)
    if (t2) clearTimeout(t2)
    onlinePlayedTimers.delete(userName)
    flushPlayedOnline(userName)
  }
}

export const getPlayed = (userName: string): TrackInfo[] => {
  const ids = loadPlayed(userName)
  return ids.map(id => getTenantTrack(userName, id)).filter(Boolean) as TrackInfo[]
}

// ---------------------------------------------------------------------------
// 在线播放记录（Web 端本地记录，每用户一份，不参与同步）
//   在线曲目不在曲库索引里，但「听的是谁」是口味画像的关键信号，所以单独存一份
//   { source, rid, name, singer, album, at }。写入防抖与本地播放记录一致，
//   避免每次播放都整份重写。
// ---------------------------------------------------------------------------

export interface OnlinePlayed {
  source: string
  rid: string
  name: string
  singer: string
  album: string
  at: number
}

const onlinePlayedFile = (userName: string): string =>
  path.join(global.lx.userPath, getUserDirname(userName), 'web-played-online.json')

const ONLINE_PLAYED_LIMIT = 100
const onlinePlayedCache = new Map<string, OnlinePlayed[]>()
const onlinePlayedTimers = new Map<string, ReturnType<typeof setTimeout>>()

const loadPlayedOnline = (userName: string): OnlinePlayed[] => {
  const hit = onlinePlayedCache.get(userName)
  if (hit) return hit
  let list: OnlinePlayed[] = []
  try {
    const data = JSON.parse(fs.readFileSync(onlinePlayedFile(userName), 'utf8'))
    if (Array.isArray(data?.list)) {
      list = data.list.filter((x: any) => x && typeof x.rid == 'string' && typeof x.source == 'string')
    }
  } catch {}
  onlinePlayedCache.set(userName, list)
  return list
}

const flushPlayedOnline = (userName: string): void => {
  const list = onlinePlayedCache.get(userName) ?? []
  try {
    fs.mkdirSync(path.dirname(onlinePlayedFile(userName)), { recursive: true })
    fs.writeFileSync(onlinePlayedFile(userName) + '.tmp', JSON.stringify({ version: 1, list }))
    fs.renameSync(onlinePlayedFile(userName) + '.tmp', onlinePlayedFile(userName))
  } catch (err: any) {
    console.error('flush online played failed:', err?.message)
  }
}

/** 在线曲目开始播放时记一笔（同一首再听置顶去重） */
export const recordPlayedOnline = (userName: string, item: Omit<OnlinePlayed, 'at'>): void => {
  if (!item?.source || !item?.rid) return
  const prev = loadPlayedOnline(userName)
  const rest = prev.filter(x => !(x.source == item.source && x.rid == item.rid))
  const next = [{ ...item, at: Date.now() }, ...rest].slice(0, ONLINE_PLAYED_LIMIT)
  onlinePlayedCache.set(userName, next)
  const old = onlinePlayedTimers.get(userName)
  if (old) clearTimeout(old)
  const t = setTimeout(() => {
    onlinePlayedTimers.delete(userName)
    flushPlayedOnline(userName)
  }, PLAYED_FLUSH_MS)
  t.unref?.()
  onlinePlayedTimers.set(userName, t)
}

/** 在线播放记录，最近在前 */
export const getPlayedOnline = (userName: string): OnlinePlayed[] => loadPlayedOnline(userName)

/**
 * 口味画像用：一次取齐「我喜欢」与全部自建歌单的曲目（原始 MusicInfo，含 singer/album）。
 * 只读不改；单只歌单读失败不影响整体画像。
 */
export const tasteLibrary = async(userName: string): Promise<{ loved: LX.Music.MusicInfo[], playlists: LX.Music.MusicInfo[][] }> => {
  const userSpace = getUserSpace(userName)
  const data = await getListDataStable(userName)
  const playlists: LX.Music.MusicInfo[][] = []
  for (const item of data.userList) {
    try {
      playlists.push(await userSpace.listManage.listDataManage.getListMusics(item.id))
    } catch { /* 跳过读不出来的歌单 */ }
  }
  return { loved: data.loveList, playlists }
}
