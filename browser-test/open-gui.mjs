/**
 * 用桌面端启动 token 换取认证 cookie，注入调试 Chrome，然后打开 DSH GUI。
 *
 * 认证机制（dsh-client-connection）：
 *   Harness 启动时打印 `http://host:port/?token=<launchToken>`；
 *   GET 该 URL 会换发一个签名的 HttpOnly cookie（dsh-auth-<authority>），
 *   之后同源请求凭 cookie 通过。token 每次启动都变，所以要从 harness.log 取最新那条。
 *
 * 用法：node open-gui.mjs [cdpPort]
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CDP_PORT = process.argv[2] ?? '9222'
const GUI_BASE = 'http://127.0.0.1:43129'
const LOG_PATH = join(homedir(), 'Library', 'Logs', 'DSH Desktop', 'harness.log')

/** 从桌面端 harness 日志里取最后一条启动 URL（含当前有效的 launch token）。 */
function latestLaunchUrl() {
  const text = readFileSync(LOG_PATH, 'utf8')
  const matches = [...text.matchAll(/http:\/\/127\.0\.0\.1:43129\/\?token=([A-Za-z0-9_-]+)/g)]
  if (matches.length === 0) throw new Error(`harness.log 里没有找到带 token 的启动 URL: ${LOG_PATH}`)
  return { token: matches[matches.length - 1][1], total: matches.length }
}

/** 用 token 换认证 cookie，直接返回 Set-Cookie 里的 name/value。 */
async function exchangeToken(token) {
  const response = await fetch(`${GUI_BASE}/?token=${token}`, { redirect: 'manual' })
  const setCookie = response.headers.getSetCookie?.() ?? []
  const raw = setCookie.find((line) => line.startsWith('dsh-auth-'))
  if (raw === undefined) {
    throw new Error(`token 交换没有返回认证 cookie（HTTP ${response.status}）`)
  }
  const [pair] = raw.split(';')
  const index = pair.indexOf('=')
  return { name: pair.slice(0, index), value: pair.slice(index + 1), status: response.status }
}

/** 极简 CDP 会话。 */
async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let seq = 0
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    seq += 1
    const id = seq
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { send, close: () => socket.close() }
}

const { token, total } = latestLaunchUrl()
console.log(`日志里有 ${total} 条启动 URL，取最后一条 token: ${token.slice(0, 12)}…`)

const cookie = await exchangeToken(token)
console.log(`token 交换成功（HTTP ${cookie.status}），cookie: ${cookie.name}`)

// 找一个可用的 page target（复用，不新建）
const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json())
let target = list.find((t) => t.type === 'page' && t.url.startsWith(GUI_BASE))
if (target === undefined) {
  target = list.find((t) => t.type === 'page')
  console.log(`复用现有 page target: ${target.url}`)
} else {
  console.log(`复用已打开 GUI 的 target`)
}

const cdp = await connect(target.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Network.enable')

// 注入认证 cookie（HttpOnly 只能走 CDP 写）
await cdp.send('Network.setCookie', {
  name: cookie.name,
  value: cookie.value,
  domain: '127.0.0.1',
  path: '/',
  httpOnly: true,
  sameSite: 'Strict',
})
console.log('认证 cookie 已注入')

await cdp.send('Page.navigate', { url: `${GUI_BASE}/` })
await new Promise((r) => setTimeout(r, 4000))

const state = await cdp.send('Runtime.evaluate', {
  expression: `(() => ({
    title: document.title,
    url: location.href,
    hasBoot: typeof window.__DSH_BOOT__ !== 'undefined',
    pluginRegistered: (() => {
      try { return typeof window.__dshEditResend === 'function' } catch (e) { return 'err:' + e.message }
    })(),
    bodyText: (document.body.innerText || '').slice(0, 200),
  }))()`,
  returnByValue: true,
})
console.log('页面状态:', JSON.stringify(state.result.value, null, 2))

cdp.close()
