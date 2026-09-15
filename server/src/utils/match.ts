// 跨源文本匹配打分：把「本地曲目 / 下载任务」的 曲名+歌手+专辑 对一个在线搜索结果打分。
//
// 为什么独立成模块：这套打分有两处消费者，且必须保持一致——
//   1. library/cover-backfill.ts  曲库封面自动回填（无内嵌封面的本地曲目）
//   2. downloads/tags.ts          下载时内嵌封面（源没给封面图时按文本兜底找图）
// 宁可低分判定未命中，也不要错配一张别人的封面。

/** 归一化：去括号补充说明 / 版本词 / 标点空白，便于跨源比对 */
export const normText = (s: string): string => (s || '')
  .toLowerCase()
  .replace(/[（(\[【{][^)）\]】}]*[)）\]】}]/g, '')
  .replace(/\b(feat|ft|live|remaster|remastered|version|acoustic|instrumental|伴奏|纯音乐|翻唱)\b\.?/g, '')
  .replace(/[\s\-_·、,，.。!！?？:：;；'"“”‘’&+＋/\\|]+/g, '')

/** 歌手串拆成多个归一化名字（"BEYOND、黄家驹" → ['beyond','黄家驹']） */
export const splitArtists = (s: string): string[] =>
  (s || '').split(/[、,，/&;；]+/).map(x => normText(x)).filter(x => x.length > 0)

/** 接受匹配的最低分：低于此值视为未命中 */
export const MIN_COVER_SCORE = 0.8

export interface MatchTarget { name: string, singer: string, album?: string }

/**
 * 曲名 / 歌手 / 专辑三维打分，返回 0~1。
 * 曲名相同 → 1；互相包含 → 0.82~0.95（按长度比例）；否则按字符集合重合度打折。
 * 歌手命中额外 +0.15，未命中整体 ×0.72（防止同名翻唱抢走原唱封面）。
 */
export const coverScore = (track: MatchTarget, item: MatchTarget): number => {
  const tn = normText(track.name)
  const inn = normText(item.name)
  if (!tn || !inn) return 0
  let nameScore: number
  if (tn === inn) {
    nameScore = 1
  } else if (tn.includes(inn) || inn.includes(tn)) {
    const ratio = Math.min(tn.length, inn.length) / Math.max(tn.length, inn.length)
    nameScore = 0.82 + 0.13 * ratio
  } else {
    const a = new Set(tn.split(''))
    const b = new Set(inn.split(''))
    let inter = 0
    for (const c of a) if (b.has(c)) inter++
    nameScore = (inter / Math.max(a.size, b.size)) * 0.8
  }
  const ta = splitArtists(track.singer)
  const ia = splitArtists(item.singer)
  const artistHit = ta.length > 0 && ia.length > 0 &&
    ta.some(x => ia.some(y => x === y || x.includes(y) || y.includes(x)))
  let score = artistHit ? Math.min(1, nameScore + 0.15) : nameScore * 0.72
  if (track.album && item.album && normText(track.album) === normText(item.album)) score = Math.min(1, score + 0.08)
  return score
}
