import { auditLog } from '@/utils/log4js'

/**
 * 破坏性操作审计：删除（软删除）/ 恢复 / 彻底删除。
 *
 * 为什么单独一份日志：这三个动作都在动真实文件，事后必须能回答「谁、什么时候、
 * 从哪个 IP、动了多少、具体哪些」。混在 app.log 里的业务日志事后翻不出来 ——
 * 上次整库被软删、却查不到调用者，就是缺了这一行。
 *
 * 一行一条 JSON，写入 <logPath>/audit.log（log4js 轮转，保留 50 份），
 * 同时打到 stdout：服务端用 `nohup` 起的，日志里直接 grep `"action":"tracks.delete"` 即可。
 *
 * 纪律：只记事实（id / 回收站相对路径 / 失败原因），不记任何 token 或口令；
 * 审计本身失败绝不影响删除动作本身。
 */

export type AuditAction = 'tracks.delete' | 'trash.restore' | 'trash.purge'

export interface AuditActor {
  /** 曲库所属用户（App 登录名） */
  user: string
  /** 来源 IP：`proxy.enabled` 时取配置的反代头第一跳，否则 socket 地址 */
  ip: string
  /** User-Agent（截断 300 字符），用于区分「手机浏览器 / 桌面 / 脚本」 */
  ua?: string
}

export const auditDestructive = (
  action: AuditAction,
  actor: AuditActor,
  detail: Record<string, unknown>,
): void => {
  try {
    auditLog.info(JSON.stringify({
      t: new Date().toISOString(),
      action,
      user: actor.user,
      ip: actor.ip,
      ua: (actor.ua ?? '').slice(0, 300),
      ...detail,
    }))
  } catch (e) {
    console.error('audit log failed:', (e as Error).message)
  }
}
