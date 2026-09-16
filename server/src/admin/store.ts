import fs from 'node:fs'
import path from 'node:path'
import { getUserDirname } from '@/user'

// ---------------------------------------------------------------------------
// 动态用户存储：data/admin-users.json
// 与 config.js / LX_USER_* 环境变量定义的用户合并后存于 global.lx.config.users
// ---------------------------------------------------------------------------

interface AdminUser { name: string, password: string }

const adminUsersFilePath = () => path.join(global.lx.dataPath, 'admin-users.json')

const readStore = (): AdminUser[] => {
  try {
    const data = JSON.parse(fs.readFileSync(adminUsersFilePath()).toString())
    return Array.isArray(data?.users) ? data.users : []
  } catch {
    return []
  }
}

const writeStore = (users: AdminUser[]) => {
  fs.writeFileSync(adminUsersFilePath(), JSON.stringify({ users }, null, 2))
}

export const loadDynamicUsers = () => {
  const stored = readStore()
  if (!stored.length) return
  const names = new Set(global.lx.config.users.map(u => u.name))
  for (const u of stored) {
    if (names.has(u.name)) continue
    global.lx.config.users.push({ ...u, dataPath: '' })
    console.log('Load dynamic user:', u.name)
  }
}

const persistAll = () => {
  writeStore(global.lx.config.users.map(u => ({ name: u.name, password: u.password })))
}

export const adminCreateUser = (name: string, password: string) => {
  name = name.trim()
  password = password.trim()
  if (!name || !password) throw new Error('用户名或密码不能为空')
  // 密码规范：只要求 6 位以上（与网页注册、重置密码同一套，不做大小写/数字/符号组合校验）
  if (password.length < 6) throw new Error('密码至少 6 位')
  if (/[\\/:*?"<>|\s]/.test(name)) throw new Error('用户名包含非法字符')
  if (name.length > 64) throw new Error('用户名过长')
  const users = global.lx.config.users
  if (users.some(u => u.name == name)) throw new Error('用户名已存在')
  if (users.some(u => u.password == password)) throw new Error('密码与其他用户重复')
  users.push({ name, password, dataPath: '' })
  const userDir = path.join(global.lx.userPath, getUserDirname(name))
  fs.mkdirSync(userDir, { recursive: true })
  try {
    persistAll()
  } catch (err) {
    // 回滚内存中的用户，避免重启后不一致
    const idx = users.findIndex(u => u.name == name)
    if (idx >= 0) users.splice(idx, 1)
    throw err
  }
}

export const adminRemoveUser = (name: string, purge = false) => {
  const users = global.lx.config.users
  const idx = users.findIndex(u => u.name == name)
  if (idx < 0) throw new Error('用户不存在')
  users.splice(idx, 1)
  persistAll()
  if (purge) {
    const userDir = path.join(global.lx.userPath, getUserDirname(name))
    fs.rmSync(userDir, { recursive: true, force: true })
  }
}

export const adminSetPassword = (name: string, password: string) => {
  password = password.trim()
  if (!password) throw new Error('密码不能为空')
  if (password.length < 6) throw new Error('密码至少 6 位')
  const user = global.lx.config.users.find(u => u.name == name)
  if (!user) throw new Error('用户不存在')
  if (global.lx.config.users.some(u => u.name != name && u.password == password)) throw new Error('密码与其他用户重复')
  user.password = password
  persistAll()
}
