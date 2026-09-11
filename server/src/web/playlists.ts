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
  for (const userName of [...playedCache.keys()]) {
    const t = playedTimers.get(userName)
    if (t) clearTimeout(t)
    playedTimers.delete(userName)
    flushPlayed(userName)
  }
}

export const getPlayed = (userName: string): TrackInfo[] => {
  const ids = loadPlayed(userName)
  return ids.map(id => getTenantTrack(userName, id)).filter(Boolean) as TrackInfo[]
}
