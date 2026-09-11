import http, { type IncomingMessage } from 'node:http'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { WebSocketServer } from 'ws'
import { registerLocalSyncEvent, callObj, sync } from './sync'
import { authCode, authConnect } from './auth'
import { getAddress, sendStatus, decryptMsg, encryptMsg } from '@/utils/tools'
import { accessLog, startupLog, syncLog } from '@/utils/log4js'
import { SYNC_CLOSE_CODE, SYNC_CODE } from '@/constants'
import { getUserSpace, releaseUserSpace, getUserName, getServerId } from '@/user'
import { createMsg2call } from 'message2call'
import { handleAdminRequest, initAdmin } from '@/admin/admin'


let status: LX.Sync.Status = {
  status: false,
  message: '',
  address: [],
  // code: '',
  devices: [],
}

let host = 'http://localhost'

// const codeTools: {
//   timeout: NodeJS.Timer | null
//   start: () => void
//   stop: () => void
// } = {
//   timeout: null,
//   start() {
//     this.stop()
//     this.timeout = setInterval(() => {
//       void generateCode()
//     }, 60 * 3 * 1000)
//   },
//   stop() {
//     if (!this.timeout) return
//     clearInterval(this.timeout)
//     this.timeout = null
//   },
// }

const checkDuplicateClient = (newSocket: LX.Socket) => {
  for (const client of [...wss!.clients]) {
    if (client === newSocket || client.keyInfo.clientId != newSocket.keyInfo.clientId) continue
    syncLog.info('duplicate client', client.userInfo.name, client.keyInfo.deviceName)
    client.isReady = false
    for (const name of Object.keys(client.moduleReadys) as Array<keyof LX.Socket['moduleReadys']>) {
      client.moduleReadys[name] = false
    }
    client.close(SYNC_CLOSE_CODE.normal)
  }
}

const handleConnection = async(socket: LX.Socket, request: IncomingMessage) => {
  const queryData = new URL(request.url as string, host).searchParams
  const clientId = queryData.get('i')

  //   // if (typeof socket.handshake.query.i != 'string') return socket.disconnect(true)
  const userName = getUserName(clientId)
  if (!userName) {
    socket.close(SYNC_CLOSE_CODE.failed)
    return
  }
  const userSpace = getUserSpace(userName)
  const keyInfo = userSpace.dataManage.getClientKeyInfo(clientId)
  if (!keyInfo) {
    socket.close(SYNC_CLOSE_CODE.failed)
    return
  }
  const user = global.lx.config.users.find(u => u.name == userName)
  if (!user) {
    socket.close(SYNC_CLOSE_CODE.failed)
    return
  }
  keyInfo.lastConnectDate = Date.now()
  userSpace.dataManage.saveClientKeyInfo(keyInfo)
  //   // socket.lx_keyInfo = keyInfo
  socket.keyInfo = keyInfo
  socket.userInfo = user

  checkDuplicateClient(socket)

  try {
    await sync(socket)
  } catch (err) {
    // console.log(err)
    syncLog.warn(err)
    socket.close(SYNC_CLOSE_CODE.failed)
    return
  }
  status.devices.push(keyInfo)
  // handleConnection(io, socket)
  sendStatus(status)
  socket.onClose(() => {
    status.devices.splice(status.devices.findIndex(k => k.clientId == keyInfo.clientId), 1)
    sendStatus(status)
  })

  // console.log('connection', keyInfo.deviceName)
  accessLog.info('connection', user.name, keyInfo.deviceName)
  // console.log(socket.handshake.query)

  socket.isReady = true
}

const handleUnconnection = (userName: string) => {
  // console.log('unconnection')
  releaseUserSpace(userName)
}

const authConnection = (req: http.IncomingMessage, callback: (err: string | null | undefined, success: boolean) => void) => {
  // console.log(req.headers)
  // // console.log(req.auth)
  // console.log(req._query.authCode)
  authConnect(req).then(() => {
    callback(null, true)
  }).catch(err => {
    callback(err, false)
  })
}

let wss: LX.SocketServer | null

function noop() {}
function onSocketError(err: Error) {
  console.error(err)
}

// fnOS 微应用网关：转发 /app/<slug> 前缀到本服务（TCP + Unix socket 双监听）
const publicBasePath = (process.env.GS_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '')
const stripBasePath = (url: string | undefined): string => {
  if (!publicBasePath) return url ?? '/'
  if (url === publicBasePath) return '/'
  if (url && url.startsWith(publicBasePath + '/')) return url.slice(publicBasePath.length)
  return url ?? '/'
}

const applySocketAcl = (sockPath: string) => {
  try {
    fs.chmodSync(sockPath, 0o660)
  } catch {}
  const users = (process.env.GS_HTTP_UNIX_SOCKET_ACL_USERS ?? 'www-data')
    .split(',').map(s => s.trim()).filter(Boolean)
  let ok = true
  for (const user of users) {
    const r = spawnSync('setfacl', ['-m', `u:${user}:rw`, sockPath], { timeout: 5000 })
    if (r.status !== 0) {
      ok = false
      break
    }
  }
  if (ok) {
    startupLog.info(`unix socket ACL granted to: ${users.join(',')}`)
  } else {
    // setfacl 不可用时保持 0660 权限，不放宽到 0666（避免绕过认证）
    startupLog.warn('setfacl unavailable; unix socket remains 0660 (owner+group only)')
  }
}

const listenUnixSocket = (server: http.Server, sockPath: string) => {
  try {
    // 清理崩溃残留的旧 socket，避免 EADDRINUSE
    if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath)
  } catch (err: any) {
    startupLog.warn(`remove stale unix socket failed: ${err?.message}`)
  }
  server.once('error', err => {
    startupLog.error(`unix socket server error: ${err.message}`)
  })
  server.listen(sockPath, () => {
    applySocketAcl(sockPath)
    startupLog.info(`Listening on unix socket ${sockPath}`)
  })
}

const handleStartServer = async(port = 9527, ip = '127.0.0.1') => await new Promise((resolve, reject) => {
  // 在注册任何连接处理器之前设置 host，避免竞态
  host = `http://${ip.includes(':') ? `[${ip}]` : ip}:${port}`

  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const rawUrl = req.url ?? '/'
    req.url = stripBasePath(rawUrl)
    // 网关打开 /app/<slug>（无尾斜杠）时必须 302 补斜杠：
    // 否则 HTML 内相对资源会被浏览器解析到 /app/assets/*，跳出前缀致白屏
    if (publicBasePath && rawUrl.split('?')[0] === publicBasePath) {
      res.writeHead(302, { Location: publicBasePath + '/' })
      res.end()
      return
    }
    // 管理后台 / Web 应用 API / 静态 UI（异步处理，直接吞掉请求）
    void handleAdminRequest(req, res).then(handled => {
      if (handled) return
      const endUrl = `/${req.url?.split('/').at(-1) ?? ''}`
      let code
      let msg
      switch (endUrl) {
        case '/hello':
          code = 200
          msg = SYNC_CODE.helloMsg
          break
        case '/id':
          code = 200
          msg = SYNC_CODE.idPrefix + getServerId()
          break
        case '/ah':
          void authCode(req, res, lx.config.users)
          break
        default:
          code = 401
          msg = 'Forbidden'
          break
      }
      if (!code) return
      res.writeHead(code)
      res.end(msg)
    }).catch(err => {
      console.error('admin request error:', err)
      try {
        res.writeHead(500)
        res.end('Internal Server Error')
      } catch {}
    })
  }

  const httpServer = http.createServer(handleRequest)

  wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024, // 1MB — 防止内存耗尽 DoS
  })

  wss.on('connection', function(socket, request) {
    socket.isReady = false
    socket.moduleReadys = {
      list: false,
      dislike: false,
    }
    socket.feature = {
      list: false,
      dislike: false,
    }
    socket.on('pong', () => {
      socket.isAlive = true
    })

    // const events = new Map<keyof ActionsType, Array<(err: Error | null, data: LX.Sync.ActionSyncType[keyof LX.Sync.ActionSyncType]) => void>>()
    // const events = new Map<keyof LX.Sync.ActionSyncType, Array<(err: Error | null, data: LX.Sync.ActionSyncType[keyof LX.Sync.ActionSyncType]) => void>>()
    // let events: Partial<{ [K in keyof LX.Sync.ActionSyncType]: Array<(data: LX.Sync.ActionSyncType[K]) => void> }> = {}
    let closeEvents: Array<(err: Error) => (void | Promise<void>)> = []
    let disconnected = false
    const msg2call = createMsg2call<LX.Sync.ClientSyncActions>({
      funcsObj: callObj,
      timeout: 120 * 1000,
      sendMessage(data) {
        if (disconnected) throw new Error('disconnected')
        void encryptMsg(socket.keyInfo, JSON.stringify(data)).then((data) => {
          // console.log('sendData', eventName)
          socket.send(data)
        }).catch(err => {
          syncLog.error('encrypt message error:', err)
          syncLog.error(err.message)
          socket.close(SYNC_CLOSE_CODE.failed)
        })
      },
      onCallBeforeParams(rawArgs) {
        return [socket, ...rawArgs]
      },
      onError(error, path, groupName) {
        const name = groupName ?? ''
        const userName = socket.userInfo?.name ?? ''
        const deviceName = socket.keyInfo?.deviceName ?? ''
        syncLog.error(`sync call ${userName} ${deviceName} ${name} ${path.join('.')} error:`, error)
        // if (groupName == null) return
        // // TODO
        // socket.close(SYNC_CLOSE_CODE.failed)
      },
    })
    socket.remote = msg2call.remote
    socket.remoteQueueList = msg2call.createQueueRemote('list')
    socket.remoteQueueDislike = msg2call.createQueueRemote('dislike')
    socket.addEventListener('message', ({ data }) => {
      if (typeof data != 'string') return
      void decryptMsg(socket.keyInfo, data).then((data) => {
        let syncData: any
        try {
          syncData = JSON.parse(data)
        } catch (err) {
          syncLog.error('parse message error:', err)
          socket.close(SYNC_CLOSE_CODE.failed)
          return
        }
        msg2call.message(syncData)
      }).catch(err => {
        syncLog.error('decrypt message error:', err)
        syncLog.error(err.message)
        socket.close(SYNC_CLOSE_CODE.failed)
      })
    })
    socket.addEventListener('close', () => {
      const err = new Error('closed')
      try {
        for (const handler of closeEvents) void handler(err)
      } catch (err: any) {
        syncLog.error(err?.message)
      }
      closeEvents = []
      disconnected = true
      msg2call.destroy()
      if (socket.isReady) {
        accessLog.info('deconnection', socket.userInfo.name, socket.keyInfo.deviceName)
        // events = {}
        if (!status.devices.map(d => getUserName(d.clientId)).filter(n => n == socket.userInfo.name).length) handleUnconnection(socket.userInfo.name)
      } else {
        const queryData = new URL(request.url as string, host).searchParams
        accessLog.info('deconnection', queryData.get('i'))
      }
    })
    socket.onClose = function(handler: typeof closeEvents[number]) {
      closeEvents.push(handler)
      return () => {
        closeEvents.splice(closeEvents.indexOf(handler), 1)
      }
    }
    socket.broadcast = function(handler) {
      if (!wss) return
      for (const client of wss.clients) handler(client)
    }

    void handleConnection(socket, request).catch(err => {
      syncLog.error('handleConnection error:', err?.message || err)
      socket.close(SYNC_CLOSE_CODE.failed)
    })
  })

  const handleUpgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    request.url = stripBasePath(request.url)
    socket.addListener('error', onSocketError)
    // This function is not defined on purpose. Implement it with your own logic.
    authConnection(request, err => {
      if (err) {
        console.log(err)
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      socket.removeListener('error', onSocketError)

      wss?.handleUpgrade(request, socket, head, function done(ws) {
        wss?.emit('connection', ws, request)
      })
    })
  }
  httpServer.on('upgrade', handleUpgrade)

  const interval = setInterval(() => {
    wss?.clients.forEach(socket => {
      if (socket.isAlive == false) {
        syncLog.info('alive check false:', socket.userInfo.name, socket.keyInfo.deviceName)
        socket.terminate()
        return
      }

      socket.isAlive = false
      socket.ping(noop)
      if (socket.keyInfo.isMobile) socket.send('ping', noop)
    })
  }, 30000)

  wss.on('close', function close() {
    clearInterval(interval)
  })

  httpServer.on('error', error => {
    console.log(error)
    reject(error)
  })

  httpServer.on('listening', () => {
    const addr = httpServer.address()
    // console.log(addr)
    if (!addr) {
      reject(new Error('address is null'))
      return
    }
    const bind = typeof addr == 'string' ? `pipe ${addr}` : `port ${addr.port}`
    startupLog.info(`Listening on ${ip} ${bind}`)
    resolve(null)
    void registerLocalSyncEvent(wss as LX.SocketServer)
  })

  httpServer.listen(port, ip)

  // fnOS 网关通道：同一套路由再监听一个 Unix socket（TCP 直连保持独立，供手机同步客户端使用）
  const unixSocketPath = process.env.GS_HTTP_UNIX_SOCKET ?? ''
  if (unixSocketPath) {
    const socketServer = http.createServer(handleRequest)
    socketServer.on('upgrade', handleUpgrade)
    listenUnixSocket(socketServer, unixSocketPath)
  }
})

// const handleStopServer = async() => new Promise<void>((resolve, reject) => {
//   if (!wss) return
//   for (const client of wss.clients) client.close(SYNC_CLOSE_CODE.normal)
//   unregisterLocalSyncEvent()
//   wss.close()
//   wss = null
//   httpServer.close((err) => {
//     if (err) {
//       reject(err)
//       return
//     }
//     resolve()
//   })
// })

// export const stopServer = async() => {
//   codeTools.stop()
//   if (!status.status) {
//     status.status = false
//     status.message = ''
//     status.address = []
//     status.code = ''
//     sendStatus(status)
//     return
//   }
//   console.log('stoping sync server...')
//   await handleStopServer().then(() => {
//     console.log('sync server stoped')
//     status.status = false
//     status.message = ''
//     status.address = []
//     status.code = ''
//   }).catch(err => {
//     console.log(err)
//     status.message = err.message
//   }).finally(() => {
//     sendStatus(status)
//   })
// }

export const startServer = async(port: number, ip: string) => {
  // if (status.status) await handleStopServer()

  initAdmin({
    getStatus: () => status,
    getConnectionCount: () => wss?.clients.size ?? 0,
    getConnectionCountByUser: (userName) => {
      if (!wss) return 0
      let count = 0
      for (const client of wss.clients) {
        if (client.userInfo?.name == userName) count++
      }
      return count
    },
    removeDevice,
    kickUser: (userName) => {
      if (!wss) return
      for (const client of wss.clients) {
        if (client.userInfo?.name == userName) {
          syncLog.info('kick user', userName, client.keyInfo?.deviceName)
          client.isReady = false
          client.close(SYNC_CLOSE_CODE.normal)
        }
      }
    },
    broadcastListAction: async(userName, action) => {
      if (!wss) return
      const userSpace = getUserSpace(userName)
      const key = await userSpace.listManage.createSnapshot()
      for (const client of wss.clients) {
        if (!client.moduleReadys?.list || client.userInfo?.name != userName) continue
        void client.remoteQueueList.onListSyncAction(action).then(() => {
          return userSpace.listManage.updateDeviceSnapshotKey(client.keyInfo.clientId, key)
        }).catch(err => {
          syncLog.error('broadcast list action failed:', err.message)
          client.close(SYNC_CLOSE_CODE.failed)
        })
      }
    },
  })

  startupLog.info(`starting sync server in ${process.env.NODE_ENV == 'production' ? 'production' : 'development'}`)
  await handleStartServer(port, ip).then(() => {
    // console.log('sync server started')
    status.status = true
    status.message = ''
    status.address = ip == '0.0.0.0' ? getAddress() : [ip]

    // void generateCode()
    // codeTools.start()
  }).catch(err => {
    console.log(err)
    status.status = false
    status.message = err.message
    status.address = []
    // status.code = ''
  })
  // .finally(() => {
  //   sendStatus(status)
  // })
}

export const getStatus = (): LX.Sync.Status => status

// export const generateCode = async() => {
//   status.code = handleGenerateCode()
//   sendStatus(status)
//   return status.code
// }

export const getDevices = async(userName: string) => {
  const userSpace = getUserSpace(userName)
  return userSpace.getDecices()
}

export const removeDevice = async(userName: string, clientId: string) => {
  if (wss) {
    for (const client of wss.clients) {
      if (client.userInfo?.name == userName && client.keyInfo?.clientId == clientId) client.close(SYNC_CLOSE_CODE.normal)
    }
  }
  const userSpace = getUserSpace(userName)
  await userSpace.removeDevice(clientId)
}

