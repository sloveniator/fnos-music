// ---------------------------------------------------------------------------
// 内置在线源 registry（方案 B：服务端内置搜索客户端）
//   供 Web 播放器搜索/试听第三方公开音源；播放统一由 NAS 中转拉流，
//   不向浏览器暴露第三方地址，避免跨域/防盗链并统一走 Web 会话鉴权。
//   类型搜索：song（单曲）/ album（专辑）/ playlist（歌单）按源能力返回；
//   详情（曲目展开）能力以 capabilities 位暴露，前端据此渲染操作。
// ---------------------------------------------------------------------------

import { kwSearch, kwPlayUrl, kwParseJSON, kwSearchAlbums, kwSearchPlaylists, kwSearchArtists, kwPlaylistDetail } from './kw'
import type { OnlineItem, OnlineSearchResult, OnlineCollection, OnlineCollectionResult, OnlineCollectionDetail } from './kw'
import { wySearch, wyPlayUrl, wyLyric, WY_BOARDS, wyBoardList, wySearchAlbums, wySearchPlaylists, wySearchArtists, wyAlbumDetail, wyPlaylistDetail } from './wy'
import { platformPlaylists, platformPlaylistsHint } from './plaza'
import { mgSearch, mgPlayUrl, mgLyric, mgSearchPlaylists, mgSearchArtists } from './mg'
import {
  sodaSearch, sodaPlayUrl, sodaLyric, sodaSearchAlbums, sodaSearchPlaylists, sodaSearchArtists,
  sodaAlbumDetail, sodaPlaylistDetail, SODA_REFERER, SODA_AUDIO_EXT,
} from './soda'
import { getSettings } from '@/library'
import { resolveFromUserSources } from './user-source'

/** 平台定义（注册即候选，启用与否由管理后台 settings.onlineSources 决定） */
export interface OnlineSourceDef {
  id: string
  name: string
  search: (keyword: string, page: number, size: number) => Promise<OnlineSearchResult>
  resolvePlayUrl: (id: string) => Promise<string>
  /** 可选：歌词（LRC 明文；实现返回空串表示无歌词/接口不可用） */
  lyric?: (id: string) => Promise<{ lyric: string; tlyric: string }>
  /** 可选：榜单目录 */
  boards?: () => { id: string; name: string }[]
  /** 可选：榜单曲目 */
  boardList?: (bid: string, limit: number) => Promise<OnlineSearchResult>
  /** 可选：专辑搜索 */
  searchAlbums?: (keyword: string, page: number, size: number) => Promise<OnlineCollectionResult>
  /** 可选：歌单搜索 */
  searchPlaylists?: (keyword: string, page: number, size: number) => Promise<OnlineCollectionResult>
  /** 可选：歌手搜索（结果复用集合结构，trackCount = 歌曲数） */
  searchArtists?: (keyword: string, page: number, size: number) => Promise<OnlineCollectionResult>
  /** 可选：专辑曲目详情 */
  albumDetail?: (id: string) => Promise<OnlineCollectionDetail>
  /** 可选：歌单曲目详情 */
  playlistDetail?: (id: string) => Promise<OnlineCollectionDetail>
  /**
   * 可选：音频容器扩展名（不带点），落盘/下载命名用；缺省 mp3。
   * 汽水免登录档位是 m4a，必须显式声明，否则会被存成 .mp3 的 m4a 内容。
   */
  audioExt?: string
}

const REGISTRY: Record<string, OnlineSourceDef> = {
  kw: {
    id: 'kw', name: '酷我音乐', search: kwSearch, resolvePlayUrl: kwPlayUrl,
    searchAlbums: kwSearchAlbums, searchPlaylists: kwSearchPlaylists, searchArtists: kwSearchArtists,
    // 专辑详情接口受反爬限制（不注册）；歌单详情改走 nplserver pl.svc，免鉴权可用
    playlistDetail: kwPlaylistDetail,
  },
  wy: {
    id: 'wy',
    name: '网易云音乐',
    search: wySearch,
    resolvePlayUrl: wyPlayUrl,
    lyric: wyLyric,
    boards: () => WY_BOARDS.map((b) => ({ id: b.bangid, name: b.name })),
    boardList: (bid, limit) => wyBoardList(bid, limit),
    searchAlbums: wySearchAlbums, searchPlaylists: wySearchPlaylists, searchArtists: wySearchArtists,
    albumDetail: wyAlbumDetail, playlistDetail: wyPlaylistDetail,
  },
  mg: {
    id: 'mg', name: '咪咕音乐', search: mgSearch, resolvePlayUrl: mgPlayUrl, lyric: mgLyric,
    searchPlaylists: mgSearchPlaylists, searchArtists: mgSearchArtists,
    // 咪咕歌单曲目接口全线需要客户端签名，公开通道拿不到（searchAll 只回歌单元数据）
  },
  soda: {
    id: 'soda',
    name: '汽水音乐',
    search: sodaSearch,
    resolvePlayUrl: sodaPlayUrl,
    lyric: sodaLyric,
    searchAlbums: sodaSearchAlbums, searchPlaylists: sodaSearchPlaylists, searchArtists: sodaSearchArtists,
    albumDetail: sodaAlbumDetail, playlistDetail: sodaPlaylistDetail,
    audioExt: SODA_AUDIO_EXT,
    // 免登录无公开榜单接口，故不注册 boards/boardList 能力（见 soda.ts 头注释）
  },
}

const KNOWN_IDS = Object.keys(REGISTRY)

/** 当前启用的在线源（settings 开关） */
const enabledIds = (): string[] => {
  const on = Array.isArray(getSettings().onlineSources) ? getSettings().onlineSources : []
  return on.filter((id) => !!REGISTRY[id])
}

/**
 * 源能力位（前端据此显示搜索类型 tabs / 详情 / 导入）。
 * 搜索能力按类型细拆；详情能力按「专辑/歌单」细拆，因为同一源可能只有一种能展开
 * （如酷我：歌单可展开、专辑接口反爬），粗粒度的 detail 已不够用。
 */
const sourceAbilities = (def: OnlineSourceDef): string[] => {
  const a: string[] = ['search']
  if (def.boards && def.boardList) a.push('boards')
  if (def.searchAlbums) a.push('albums')
  if (def.searchPlaylists) a.push('playlists')
  if (def.searchArtists) a.push('artists')
  if (def.albumDetail) a.push('album-detail')
  if (def.playlistDetail) a.push('playlist-detail')
  // 兼容位：专辑 + 歌单都能展开才算完整 detail/import（导入链接也要求两种详情都在）
  if (def.albumDetail && def.playlistDetail) a.push('detail', 'import')
  return a
}

/**
 * 推荐歌单 / 平台歌单（在线音乐页默认视图「歌单广场」）：
 *   wy 走官方推荐歌单（每日轮换）；kw/mg/soda 无公开推荐端点，改用热门标签拼
 *   （见 ./plaza）。batch 只在标签拼法里有意义，wy 忽略。
 */
export const onlineRecPlaylists = async (source: string, limit: number, batch = 0): Promise<OnlineCollection[]> =>
  platformPlaylists(source, batch, limit)

/** 平台歌单的来源说明（页头小字） */
export const onlineRecHint = (source: string): string => platformPlaylistsHint(source)

export const onlineSources = (): { id: string; name: string; enabled: boolean; lyric: boolean; boards: boolean; abilities: string[] }[] =>
  KNOWN_IDS.map((id) => ({
    id,
    name: REGISTRY[id].name,
    enabled: enabledIds().includes(id),
    lyric: !!REGISTRY[id].lyric,
    boards: !!REGISTRY[id].boards,
    abilities: sourceAbilities(REGISTRY[id]),
  }))

export const isOnlineSource = (source: string): boolean => enabledIds().includes(source)

export const onlineSearch = async (source: string, keyword: string, page: number, size: number) => {
  if (!isOnlineSource(source)) throw new Error('在线源未启用或不存在：' + source)
  return REGISTRY[source].search(keyword, page, size)
}

export const onlineSearchAlbums = async (source: string, keyword: string, page: number, size: number) => {
  if (!isOnlineSource(source) || !REGISTRY[source].searchAlbums) throw new Error('该源不支持专辑搜索')
  return REGISTRY[source].searchAlbums!(keyword, page, size)
}

export const onlineSearchPlaylists = async (source: string, keyword: string, page: number, size: number) => {
  if (!isOnlineSource(source) || !REGISTRY[source].searchPlaylists) throw new Error('该源不支持歌单搜索')
  return REGISTRY[source].searchPlaylists!(keyword, page, size)
}

export const onlineSearchArtists = async (source: string, keyword: string, page: number, size: number) => {
  if (!isOnlineSource(source) || !REGISTRY[source].searchArtists) throw new Error('该源不支持歌手搜索')
  return REGISTRY[source].searchArtists!(keyword, page, size)
}

export const onlineCollection = async (source: string, type: 'album' | 'playlist', id: string): Promise<OnlineCollectionDetail> => {
  if (!isOnlineSource(source)) throw new Error('在线源未启用或不存在：' + source)
  const fn = type === 'album' ? REGISTRY[source].albumDetail : REGISTRY[source].playlistDetail
  if (!fn) throw new Error('该源暂不支持展开' + (type === 'album' ? '专辑' : '歌单') + '详情')
  return fn(id)
}

export const onlineResolvePlayUrl = async (source: string, id: string): Promise<string> => {
  if (!isOnlineSource(source)) throw new Error('在线源未启用或不存在：' + source)
  // 第三方 JS 源优先（服务端承载；用户确认过的脚本），失败/未启用回退内置适配器
  const attempt = await resolveFromUserSources(source, id)
  if (attempt) return attempt.url
  return REGISTRY[source].resolvePlayUrl(id)
}

/** 在线歌词（源不支持/接口失败时返回空文本，由调用方决定展示） */
export const onlineLyric = async (source: string, id: string): Promise<{ lyric: string; tlyric: string }> => {
  if (!isOnlineSource(source) || !REGISTRY[source].lyric) return { lyric: '', tlyric: '' }
  try {
    return await REGISTRY[source].lyric!(id)
  } catch {
    return { lyric: '', tlyric: '' }
  }
}

export const onlineBoards = (source: string): { id: string; name: string }[] => {
  if (!isOnlineSource(source) || !REGISTRY[source].boards) return []
  return REGISTRY[source].boards!()
}

export const onlineBoardList = async (source: string, bid: string, limit: number): Promise<OnlineSearchResult> => {
  if (!isOnlineSource(source) || !REGISTRY[source].boardList) throw new Error('该源不支持榜单')
  return REGISTRY[source].boardList!(bid, limit)
}

/**
 * 粘贴分享链接导入歌单/专辑。
 * 自动识别平台（网易云 / 酷我 / 咪咕）与类型（playlist / album），
 * 仅当该源提供详情能力时返回曲目列表。
 */
export const importOnlineUrl = async (rawUrl: string): Promise<{ source: string; type: 'album' | 'playlist'; info: any; list: OnlineItem[] }> => {
  const url = String(rawUrl).trim()

  // 汽水（Soda）：分享页 music.douyin.com/qishui/share/{playlist,album}?xxx_id=… / www.qishui.com/{playlist,album}/{id}
  const soda =
    /(?:music\.douyin\.com\/qishui\/share|(?:www\.)?qishui\.com)\/(playlist|album)(?:\?[^#]*?|\/)(?:playlist_id|album_id)=(\d{1,24})/i.exec(url) ||
    /(?:www\.)?qishui\.com\/(playlist|album)\/(\d{1,24})/i.exec(url)
  if (soda) {
    if (!isOnlineSource('soda')) throw new Error('汽水音乐源未启用（管理后台「在线音乐源」可开启）')
    const type: 'album' | 'playlist' = soda[1].toLowerCase() === 'album' ? 'album' : 'playlist'
    const detail = await (type === 'album' ? sodaAlbumDetail : sodaPlaylistDetail)(soda[2])
    return { source: 'soda', type, info: detail.info, list: detail.list }
  }

  const m =
    // 网易云网页/移动
    /(?:music\.163\.com\/(?:#\/)?|y\.music\.163\.com\/m\/)(playlist|album)\?(?:[^#]*&)?id=(\d{1,16})/i.exec(url) ||
    /(?:music\.163\.com\/(?:#\/)?|y\.music\.163\.com\/m\/)(playlist|album)\/(\d{1,16})/i.exec(url) ||
    // 酷我
    /kuwo\.cn\/(playlist_detail|album_detail)\/(\d{1,16})/i.exec(url) ||
    // 咪咕
    /music\.migu\.cn\/v3\/music\/(playlist|album)\/(\d{1,16})/i.exec(url)

  if (!m) throw new Error('无法识别的分享链接（支持网易云/酷我/咪咕/汽水的歌单或专辑链接）')

  let source = 'wy'
  let type: 'album' | 'playlist' = 'playlist'
  let id = ''
  if (m[1] === 'playlist' || m[1] === 'album') {
    type = m[1] as 'album' | 'playlist'
    id = m[2]
  } else if (m[1] === 'playlist_detail' || m[1] === 'album_detail') {
    source = 'kw'
    type = m[1] === 'playlist_detail' ? 'playlist' : 'album'
    id = m[2]
  } else if (m[1] === 'playlist' || m[1] === 'album') {
    source = 'mg'
    type = m[1] as 'album' | 'playlist'
    id = m[2]
  }

  if (!isOnlineSource(source)) throw new Error('该平台的在线源未启用（管理后台「在线音乐源」可开启）')
  const def = REGISTRY[source]
  const fn = type === 'album' ? def.albumDetail : def.playlistDetail
  if (!fn) throw new Error('该平台暂不支持导入' + (type === 'album' ? '专辑' : '歌单') + '（接口受限）')
  const detail = await fn(id)
  return { source, type, info: detail.info, list: detail.list }
}

export { kwParseJSON }
export type { OnlineItem, OnlineCollection }

// FM 电台（汽水听歌模式 → 频道）：目录 + 频道曲流
export { fmChannels, fmChannel, fmNext, fmPoolSize } from './fm'
export type { FmChannel, FmNextResult } from './fm'

/**
 * 拉流（<audio> 经 NAS 代理）时上游需要的 Referer。
 * 缺省沿用酷我（历史行为，网易云/咪咕直链也接受）；汽水直链在 douyinvod，
 * 实测会 403 拒绝酷我/网易 Referer，只有不带或带抖音自家 Referer 才放行。
 */
export const onlineStreamReferer = (source: string): string =>
  source === 'soda' ? SODA_REFERER : 'http://www.kuwo.cn/'

/**
 * 服务端下载时上游需要的 Referer。
 * 缺省沿用网易云（历史行为）；汽水同上必须换成抖音 Referer。
 */
export const onlineDownloadReferer = (source: string): string =>
  source === 'soda' ? SODA_REFERER : 'https://music.163.com/'

/** 该在线源的音频容器扩展名（落盘 / 下载命名用），缺省 mp3 */
export const onlineAudioExt = (source: string): string => REGISTRY[source]?.audioExt ?? 'mp3'
