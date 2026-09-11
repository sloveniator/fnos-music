import { getTracks, getScannedAt, type TrackInfo } from '@/library'

// ---------------------------------------------------------------------------
// 曲库聚合：专辑 / 歌手视图（带缓存，扫描结果变化自动失效）
// UPGRADE_0020：新增 buildGroupings(tracks, scannedAt, maxMtime) 供租户层复用；
// 全局版（listAlbums/listArtists/...）保留，读全局 tracks。
// ---------------------------------------------------------------------------

export interface AlbumInfo {
  key: string
  name: string
  singer: string
  year: string | null
  count: number
  size: number
  coverTrackId: string | null
}

export interface ArtistInfo {
  name: string
  count: number
  albumCount: number
  size: number
  coverTrackId: string | null
}

export interface Groupings {
  albums: AlbumInfo[]
  artists: ArtistInfo[]
  albumMap: Map<string, AlbumInfo>
  albumTrackIdx: Map<string, TrackInfo[]>
  artistTrackIdx: Map<string, TrackInfo[]>
  key: string
}

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, '')

/** 核心：从 tracks 数组一次性构建所有索引 */
export const buildGroupings = (tracks: TrackInfo[], scannedAt: number, maxMtime: number): Groupings => {
  const key = scannedAt + ':' + String(tracks.length) + ':' + String(maxMtime)
  const albumMap = new Map<string, AlbumInfo>()
  const albumTrackIdx = new Map<string, TrackInfo[]>()
  const artistTrackIdx = new Map<string, TrackInfo[]>()
  const artistMap = new Map<string, ArtistInfo & { albumSet: Set<string> }>()
  for (const t of tracks) {
    const singer = t.singer || '未知歌手'
    const album = t.album || '单曲'
    const aKey = `${singer}||${album}`
    let a = albumMap.get(aKey)
    if (!a) {
      a = { key: aKey, name: album, singer, year: t.year, count: 0, size: 0, coverTrackId: null }
      albumMap.set(aKey, a)
    }
    a.count++
    a.size += t.size
    if (!a.coverTrackId && t.hasCover) a.coverTrackId = t.id
    if (!a.year && t.year) a.year = t.year
    let ar = artistMap.get(singer)
    if (!ar) {
      ar = { name: singer, count: 0, albumCount: 0, size: 0, coverTrackId: null, albumSet: new Set() }
      artistMap.set(singer, ar)
    }
    ar.count++
    ar.size += t.size
    ar.albumSet.add(aKey)
    if (!ar.coverTrackId && t.hasCover) ar.coverTrackId = t.id
    let bt = albumTrackIdx.get(aKey)
    if (!bt) { bt = []; albumTrackIdx.set(aKey, bt) }
    bt.push(t)
    let at = artistTrackIdx.get(singer)
    if (!at) { at = []; artistTrackIdx.set(singer, at) }
    at.push(t)
  }
  for (const list of albumTrackIdx.values()) {
    list.sort((x, y) => (x.trackNum ?? 9999) - (y.trackNum ?? 9999) || collator.compare(x.name, y.name))
  }
  const albums = [...albumMap.values()].sort((x, y) => x.singer.localeCompare(y.singer) || x.name.localeCompare(y.name))
  const artists = [...artistMap.values()].map(({ albumSet, ...rest }) => ({ ...rest, albumCount: albumSet.size }))
    .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
  return { albums, artists, albumMap, albumTrackIdx, artistTrackIdx, key }
}

// ---------------- 全局版：admin UI / lx-music-mobile 客户端专用 ----------------
let cacheKey = ''
let albums: AlbumInfo[] = []
let artists: ArtistInfo[] = []
let albumMap = new Map<string, AlbumInfo>()
let albumTrackIdx = new Map<string, TrackInfo[]>()
let artistTrackIdx = new Map<string, TrackInfo[]>()

const rebuild = (): void => {
  const tracks = getTracks()
  let maxMtime = 0
  for (const t of tracks) if (t.mtime > maxMtime) maxMtime = t.mtime
  const built = buildGroupings(tracks, getScannedAt(), maxMtime)
  if (built.key === cacheKey) return
  cacheKey = built.key
  albumMap = built.albumMap
  albumTrackIdx = built.albumTrackIdx
  artistTrackIdx = built.artistTrackIdx
  albums = built.albums
  artists = built.artists
}

export const listAlbums = (opts: { q?: string, page?: number, size?: number }): { total: number, page: number, size: number, albums: AlbumInfo[] } => {
  rebuild()
  const size = Math.max(1, Math.min(200, opts.size ?? 60))
  const page = Math.max(1, Math.min(1e9, opts.page ?? 1))
  let list = albums
  const q = (opts.q ?? '').trim()
  if (q) {
    const nq = norm(q)
    list = list.filter(a => norm(a.name).includes(nq) || norm(a.singer).includes(nq))
  }
  const total = list.length
  return { total, page, size, albums: list.slice((page - 1) * size, page * size) }
}

export const listArtists = (opts: { q?: string, page?: number, size?: number }): { total: number, page: number, size?: number, artists: ArtistInfo[] } => {
  rebuild()
  const size = Math.max(1, Math.min(200, opts.size ?? 60))
  const page = Math.max(1, Math.min(1e9, opts.page ?? 1))
  let list = artists
  const q = (opts.q ?? '').trim()
  if (q) {
    const nq = norm(q)
    list = list.filter(a => norm(a.name).includes(nq))
  }
  const total = list.length
  return { total, page, size, artists: list.slice((page - 1) * size, page * size) }
}

export const albumTracks = (singer: string, album: string): TrackInfo[] => {
  rebuild()
  return albumTrackIdx.get(`${singer}||${album}`) ?? []
}

export const artistAlbums = (singer: string): AlbumInfo[] => {
  rebuild()
  return albums.filter(a => a.singer == singer)
}

export const artistTracks = (singer: string): TrackInfo[] => {
  rebuild()
  return artistTrackIdx.get(singer) ?? []
}

// ---------------- 租户版：每次调用传入 tracks，独立缓存键 ----------------
const tenantCache = new Map<string, Groupings>()

export interface TenantGroupingOpts { q?: string, page?: number, size?: number }

export const tenantListAlbums = (cacheKeyUser: string, tracks: TrackInfo[], scannedAt: number, maxMtime: number, opts: TenantGroupingOpts): { total: number, page: number, size: number, albums: AlbumInfo[] } => {
  const g = ensureTenant(cacheKeyUser, tracks, scannedAt, maxMtime)
  const size = Math.max(1, Math.min(200, opts.size ?? 60))
  const page = Math.max(1, Math.min(1e9, opts.page ?? 1))
  let list = g.albums
  const q = (opts.q ?? '').trim()
  if (q) {
    const nq = norm(q)
    list = list.filter(a => norm(a.name).includes(nq) || norm(a.singer).includes(nq))
  }
  const total = list.length
  return { total, page, size, albums: list.slice((page - 1) * size, page * size) }
}

export const tenantListArtists = (cacheKeyUser: string, tracks: TrackInfo[], scannedAt: number, maxMtime: number, opts: TenantGroupingOpts): { total: number, page: number, size: number, artists: ArtistInfo[] } => {
  const g = ensureTenant(cacheKeyUser, tracks, scannedAt, maxMtime)
  const size = Math.max(1, Math.min(200, opts.size ?? 60))
  const page = Math.max(1, Math.min(1e9, opts.page ?? 1))
  let list = g.artists
  const q = (opts.q ?? '').trim()
  if (q) {
    const nq = norm(q)
    list = list.filter(a => norm(a.name).includes(nq))
  }
  const total = list.length
  return { total, page, size, artists: list.slice((page - 1) * size, page * size) }
}

export const tenantAlbumTracks = (cacheKeyUser: string, tracks: TrackInfo[], scannedAt: number, maxMtime: number, singer: string, album: string): TrackInfo[] => {
  const g = ensureTenant(cacheKeyUser, tracks, scannedAt, maxMtime)
  return g.albumTrackIdx.get(`${singer}||${album}`) ?? []
}

export const tenantArtistAlbums = (cacheKeyUser: string, tracks: TrackInfo[], scannedAt: number, maxMtime: number, singer: string): AlbumInfo[] => {
  const g = ensureTenant(cacheKeyUser, tracks, scannedAt, maxMtime)
  return g.albums.filter(a => a.singer == singer)
}

export const tenantArtistTracks = (cacheKeyUser: string, tracks: TrackInfo[], scannedAt: number, maxMtime: number, singer: string): TrackInfo[] => {
  const g = ensureTenant(cacheKeyUser, tracks, scannedAt, maxMtime)
  return g.artistTrackIdx.get(singer) ?? []
}

const ensureTenant = (cacheKeyUser: string, tracks: TrackInfo[], scannedAt: number, maxMtime: number): Groupings => {
  const freshKey = scannedAt + ':' + String(tracks.length) + ':' + String(maxMtime)
  const old = tenantCache.get(cacheKeyUser)
  if (old && old.key === freshKey) return old
  const built = buildGroupings(tracks, scannedAt, maxMtime)
  tenantCache.set(cacheKeyUser, built)
  return built
}
