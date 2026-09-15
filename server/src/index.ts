#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import { initLogger } from '@/utils/log4js'
import defaultConfig from './defaultConfig'
import { ENV_PARAMS, File } from './constants'
import { checkAndCreateDirSync } from './utils'

// 进程级异常处理：防止未捕获异常和未处理 Promise rejection 导致静默崩溃
process.on('unhandledRejection', (reason: any) => {
  console.error('[unhandledRejection]', reason?.message || reason)
})
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.message || err)
})

type ENV_PARAMS_Type = typeof ENV_PARAMS
type ENV_PARAMS_Value_Type = ENV_PARAMS_Type[number]

let envParams: Partial<Record<Exclude<ENV_PARAMS_Value_Type, 'LX_USER_'>, string>> = {}
let envUsers: LX.User[] = []
const envParamKeys = Object.values(ENV_PARAMS).filter(v => v != 'LX_USER_')

{
  const envLog = [
    ...(envParamKeys.map(e => [e, process.env[e]]) as Array<[Exclude<ENV_PARAMS_Value_Type, 'LX_USER_'>, string]>).filter(([k, v]) => {
      if (!v) return false
      envParams[k] = v
      return true
    }),
    ...Object.entries(process.env)
      .filter(([k, v]) => {
        if (k.startsWith('LX_USER_') && !!v) {
          const name = k.replace('LX_USER_', '')
          if (name) {
            envUsers.push({
              name,
              password: v,
            })
            return true
          }
        }
        return false
      }),
  ].map(([e, v]) => `${e}: ${v as string}`)
  if (envLog.length) console.log(`Load env: \n  ${envLog.join('\n  ')}`)
}

const dataPath = envParams.DATA_PATH ?? path.join(__dirname, '../data')
global.lx = {
  logPath: envParams.LOG_PATH ?? path.join(__dirname, '../logs'),
  dataPath,
  userPath: path.join(dataPath, File.userDir),
  config: defaultConfig,
  listenPort: 9527,
}

const mergeConfigFileEnv = (config: Partial<Record<ENV_PARAMS_Value_Type, string>>) => {
  const envLog = []
  for (const [k, v] of Object.entries(config).filter(([k]) => k.startsWith('env.'))) {
    const envKey = k.replace('env.', '') as keyof typeof envParams
    let value = String(v)
    if (envParamKeys.includes(envKey)) {
      if (envParams[envKey] == null) {
        envLog.push(`${envKey}: ${value}`)
        envParams[envKey] = value
      }
    } else if (envKey.startsWith('LX_USER_') && value) {
      const name = k.replace('LX_USER_', '')
      if (name) {
        envUsers.push({
          name,
          password: value,
        })
        envLog.push(`${envKey}: ${value}`)
      }
    }
  }
  if (envLog.length) console.log(`Load config file env:\n  ${envLog.join('\n  ')}`)
}

const margeConfig = (p: string) => {
  let config
  try {
    // 安全：仅允许 JSON 配置，禁止 require() 加载任意 JS（代码注入风险）
    if (path.extname(p) == '.js') {
      console.warn('JS config is no longer supported for security; please convert to JSON')
      return false
    }
    config = JSON.parse(fs.readFileSync(p).toString()) as LX.Config
  } catch (err: any) {
    console.warn('Read config error: ' + (err.message as string))
    return false
  }
  const newConfig = { ...global.lx.config }
  for (const key of Object.keys(defaultConfig) as Array<keyof LX.Config>) {
    // @ts-expect-error
    if (config[key] !== undefined) newConfig[key] = config[key]
  }

  console.log('Load config: ' + p)
  if (newConfig.users.length) {
    const users: LX.UserConfig[] = []
    for (const user of newConfig.users) {
      users.push({
        ...user,
        dataPath: '',
      })
    }
    newConfig.users = users
  }
  global.lx.config = newConfig

  mergeConfigFileEnv(config as any)
  return true
}


// 配置文件加载：默认读项目目录下的 config.json，可用环境变量 CONFIG_PATH 指定其他路径
const loadedConfigFiles = new Set<string>()
const loadConfigFile = (p: string, warnIfMissing = false) => {
  if (!fs.existsSync(p)) {
    if (warnIfMissing) console.warn('Config file not found: ' + p)
    return
  }
  // 默认路径与 CONFIG_PATH 指向同一文件时只加载一次，避免重复合并
  const filePath = path.resolve(p)
  if (loadedConfigFiles.has(filePath)) return
  loadedConfigFiles.add(filePath)
  margeConfig(filePath)
}

loadConfigFile(path.join(__dirname, '../config.json'))
envParams.CONFIG_PATH && loadConfigFile(envParams.CONFIG_PATH, true)
if (envParams.PROXY_HEADER) {
  global.lx.config['proxy.enabled'] = true
  global.lx.config['proxy.header'] = envParams.PROXY_HEADER
}
if (envParams.MAX_SNAPSHOT_NUM) {
  const num = parseInt(envParams.MAX_SNAPSHOT_NUM)
  if (!isNaN(num)) global.lx.config.maxSnapshotNum = num
}
if (envParams.LIST_ADD_MUSIC_LOCATION_TYPE) {
  switch (envParams.LIST_ADD_MUSIC_LOCATION_TYPE) {
    case 'top':
    case 'bottom':
      global.lx.config['list.addMusicLocationType'] = envParams.LIST_ADD_MUSIC_LOCATION_TYPE
      break
  }
}

if (envUsers.length) {
  const users: LX.Config['users'] = []
  let u
  for (let user of envUsers) {
    let isLikeJSON = true
    try {
      u = JSON.parse(user.password) as Omit<LX.User, 'name'>
    } catch {
      isLikeJSON = false
    }
    if (isLikeJSON && typeof u == 'object') {
      users.push({
        name: user.name,
        ...u,
        dataPath: '',
      })
    } else {
      users.push({
        name: user.name,
        password: user.password,
        dataPath: '',
      })
    }
  }
  global.lx.config.users = users
}

const exit = (message: string, code = 1): never => {
  console.error(message)
  process.exit(code)
}

const checkAndCreateDir = (path: string) => {
  try {
    checkAndCreateDirSync(path)
  } catch (e: any) {
    if (e.code !== 'EEXIST') {
      exit(`Could not set up log directory, error was: ${e.message as string}`)
    }
  }
}

const checkUserConfig = (users: LX.Config['users']) => {
  const userNames: string[] = []
  const passwords: string[] = []
  for (const user of users) {
    if (userNames.includes(user.name)) exit('User name duplicate: ' + user.name)
    if (passwords.includes(user.password)) exit('User password duplicate: ' + user.password)
    userNames.push(user.name)
    passwords.push(user.password)
  }
}

checkAndCreateDir(global.lx.logPath)
checkAndCreateDir(global.lx.dataPath)
checkAndCreateDir(global.lx.userPath)
checkUserConfig(global.lx.config.users)

console.log(`Users:
${global.lx.config.users.map(user => `  ${user.name}: ${user.password ? '********' : '(no password)'}`).join('\n') || '  No User'}
`)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getUserDirname } = require('@/user')
for (const user of global.lx.config.users) {
  const dataPath = path.join(global.lx.userPath, getUserDirname(user.name))
  checkAndCreateDir(dataPath)
  user.dataPath = dataPath
}
initLogger()


/**
 * Normalize a port into a number, string, or false.
 */

function normalizePort(val: string) {
  const port = parseInt(val, 10)

  if (isNaN(port) || port < 1) {
    // named pipe
    exit(`port illegal: ${val}`)
  }
  return port
}

/**
 * Get port from environment and store in Express.
 */

const port = normalizePort(envParams.PORT ?? '9527')
const bindIP = envParams.BIND_IP ?? '127.0.0.1'
global.lx.listenPort = port

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createModuleEvent } = require('@/event')
createModuleEvent()

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('@/utils/migrate').default(global.lx.dataPath, global.lx.userPath)

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('@/library').loadLibrary()

// 启动下载队列（MVP）：把 downloading 任务归到 pending，起调度循环
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDownloads } = require('@/downloads/queue')
initDownloads()

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startServer } = require('@/server')
startServer(port, bindIP)

// 退出前刷盘「最近播放」防抖写入的内存队列（SIGTERM/SIGINT 与 beforeExit 双兜底）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { flushAllPlayed } = require('@/web/playlists')
let flushing = false
const flushOnce = (): void => {
  if (flushing) return
  flushing = true
  try { flushAllPlayed() } catch (err: any) { console.error('flush played on exit:', err?.message) }
}
process.on('SIGTERM', () => { flushOnce(); process.exit(0) })
process.on('SIGINT', () => { flushOnce(); process.exit(0) })
process.on('beforeExit', flushOnce)

