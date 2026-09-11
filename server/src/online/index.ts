// ---------------------------------------------------------------------------
// 内置在线源 registry（方案 B：服务端内置搜索客户端）
//   供 Web 播放器搜索/试听第三方公开音源；播放统一由 NAS 中转拉流，
//   不向浏览器暴露第三方地址，避免跨域/防盗链并统一走 Web 会话鉴权。
// ---------------------------------------------------------------------------

import { kwSearch, kwPlayUrl, kwParseJSON } from './kw'
import type { OnlineItem, OnlineSearchResult } from './kw'
import { wySearch, wyPlayUrl, wyLyric, WY_BOARDS, wyBoardList } from './wy'
import { mgSearch, mgPlayUrl, mgLyric } from './mg'
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
}

const REGISTRY: Record<string, OnlineSourceDef> = {
  kw: { id: 'kw', name: '酷我音乐', search: kwSearch, resolvePlayUrl: kwPlayUrl },
  wy: {
    id: 'wy',
    name: '网易云音乐',
    search: wySearch,
    resolvePlayUrl: wyPlayUrl,
    lyric: wyLyric,
    boards: () => WY_BOARDS.map((b) => ({ id: b.bangid, name: b.name })),
    boardList: (bid, limit) => wyBoardList(bid, limit),
  },
  mg: { id: 'mg', name: '咪咕音乐', search: mgSearch, resolvePlayUrl: mgPlayUrl, lyric: mgLyric },
}

const KNOWN_IDS = Object.keys(REGISTRY)

/** 当前启用的在线源（settings 开关） */
const enabledIds = (): string[] => {
  const on = Array.isArray(getSettings().onlineSources) ? getSettings().onlineSources : []
  return on.filter((id) => !!REGISTRY[id])
}

export const onlineSources = (): { id: string; name: string; enabled: boolean; lyric: boolean; boards: boolean }[] =>
  KNOWN_IDS.map((id) => ({ id, name: REGISTRY[id].name, enabled: enabledIds().includes(id), lyric: !!REGISTRY[id].lyric, boards: !!REGISTRY[id].boards }))

export const isOnlineSource = (source: string): boolean => enabledIds().includes(source)

export const onlineSearch = async (source: string, keyword: string, page: number, size: number) => {
  if (!isOnlineSource(source)) throw new Error('在线源未启用或不存在：' + source)
  return REGISTRY[source].search(keyword, page, size)
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

export { kwParseJSON }
export type { OnlineItem }
