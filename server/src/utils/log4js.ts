import path from 'node:path'
import log4js from 'log4js'

const createLogConfig = (logPath: string) => {
  return {
    appenders: {
      access: {
        type: 'file',
        filename: path.join(logPath, 'access.log'),
        maxLogSize: 1024 * 1024 * 10,
        category: 'access',
        // compress: true,
        keepFileExt: true,
        numBackups: 10,
      },
      app: {
        type: 'file',
        filename: path.join(logPath, 'app.log'),
        maxLogSize: 10485760,
        backups: 10,
        keepFileExt: true,
      },
      errorFile: {
        type: 'file',
        filename: path.join(logPath, 'errors.log'),
      },
      errors: {
        type: 'logLevelFilter',
        level: 'ERROR',
        appender: 'errorFile',
      },
      // 破坏性操作审计：JSON 行，原样落盘（不加 log4js 前缀，方便 jq / grep 解析）
      audit: {
        type: 'file',
        filename: path.join(logPath, 'audit.log'),
        maxLogSize: 10485760,
        numBackups: 50,
        keepFileExt: true,
        layout: { type: 'messagePassThrough' },
      },
      console: {
        type: 'console',
      },
    },
    categories: {
      default: { appenders: ['app', 'errors', 'console'], level: 'DEBUG' },
      access: { appenders: ['access'], level: 'ALL' },
      audit: { appenders: ['audit', 'console'], level: 'ALL' },
    },
  }
}


export const initLogger = () => {
  log4js.configure(createLogConfig(global.lx.logPath))
}


export const startupLog = log4js.getLogger('startup')
export const auditLog = log4js.getLogger('audit')
export const syncLog = log4js.getLogger('sync')
export const accessLog = log4js.getLogger('access')
