/**
 * 在真实 DSH GUI 里跑插件的诊断入口 `__dshEditResend()`。
 *
 * 复用已登录的调试 Chrome 标签页（由 open-gui.mjs 注入 cookie），
 * 输出每条用户消息的 seq、将用作分叉锚点的前一条 seq、以及队列状态。
 *
 * 用法：node diagnose-gui.mjs [cdpPort]
 */

const CDP_PORT = process.argv[2] ?? '9222'
const SESSION_TITLE = process.argv[3] ?? ''
const GUI = 'http://127.0.0.1:43129'

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

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    return { __error: description }
  }
  return result.result.value
}

const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json())
const target = list.find((t) => t.type === 'page' && t.url.startsWith(GUI))
if (target === undefined) {
  console.error('没找到已登录的 GUI 标签页，请先跑 node open-gui.mjs')
  process.exit(1)
}

const cdp = await connect(target.webSocketDebuggerUrl)
await cdp.send('Runtime.enable')

if (SESSION_TITLE !== '') {
  const switched = await evaluate(cdp, `(() => {
    const wanted = ${JSON.stringify(SESSION_TITLE)}
    const rows = [...document.querySelectorAll('[role="row"], [class*="session"], [class*="item"]')]
    const row = rows.find((node) => (node.textContent || '').trim().includes(wanted))
    if (!row) return false
    row.click()
    return true
  })()`)
  if (!switched) console.warn(`没找到会话标题：${SESSION_TITLE}`)
  await new Promise((resolve) => setTimeout(resolve, 1200))
}

// 收集 console 输出，顺便把插件日志一起带回来
const logs = []
cdp.send('Log.enable').catch(() => {})
await cdp.send('Runtime.addBinding', { name: '__dshDiagSink' }).catch(() => {})

console.log('=== 当前会话与消息概览')
console.log(JSON.stringify(await evaluate(cdp, `(() => {
  const rows = [...document.querySelectorAll('[class*="userRow"]')]
  return {
    userMessageCount: rows.length,
    hasDiagEntry: typeof window.__dshEditResend === 'function',
    url: location.href,
  }
})()`), null, 2))

console.log('')
console.log('=== __dshEditResend() 诊断')
const report = await evaluate(cdp, `(() => {
  if (typeof window.__dshEditResend !== 'function') return { error: '诊断入口不存在，插件可能没加载' }
  try { return window.__dshEditResend() } catch (e) { return { error: String(e && e.message || e) } }
})()`)
console.log(JSON.stringify(report, null, 2))

console.log('')
console.log('=== React 节点的真实轮次边界')
const turnReport = await evaluate(cdp, `(() => {
  const fiberOf = (node) => {
    const key = Object.keys(node || {}).find((name) => name.startsWith('__reactFiber$'))
    return key ? node[key] : null
  }
  const compactNode = (node) => {
    const location = node && node.location
    const turn = location && (location.kind === 'turn' || location.kind === 'step') ? location.turn : null
    return {
      kind: node && node.kind,
      anchorSeq: node && node.anchorSeq,
      dataSeq: node && node.data && node.data.seq,
      turn: turn && turn.turn,
      turnStatus: turn && turn.status,
      turnStartSeq: turn && turn.start && turn.start.seq,
      turnEndSeq: turn && turn.end && turn.end.seq,
      locationKind: location && location.kind,
    }
  }
  return [...document.querySelectorAll('[class*="userRow"]')].map((row, index) => {
    const hits = []
    const seen = new Set()
    let fiber = fiberOf(row)
    for (let depth = 0; fiber && depth < 80; depth += 1, fiber = fiber.return) {
      for (const value of [fiber.memoizedProps, fiber.pendingProps]) {
        const candidates = [value, value && value.node, value && value.owner && value.owner.node]
        for (const candidate of candidates) {
          if (!candidate || seen.has(candidate)) continue
          if (candidate.kind !== 'user' && candidate.kind !== 'steering') continue
          seen.add(candidate)
          hits.push(compactNode(candidate))
        }
      }
    }
    return { index, text: (row.textContent || '').trim().slice(0, 80), hits }
  })
})()`)
console.log(JSON.stringify(turnReport, null, 2))

console.log('')
console.log('=== 全 React 树中的会话能力对象')
const capabilityReport = await evaluate(cdp, `(() => {
  const rootHost = document.querySelector('#root') || document.body.firstElementChild
  const containerKey = Object.keys(rootHost || {}).find((name) => name.startsWith('__reactContainer$'))
  const root = containerKey ? rootHost[containerKey] : null
  const start = root && (root.stateNode && root.stateNode.current || root)
  const queue = start ? [start] : []
  const seenFibers = new Set()
  const seenValues = new Set()
  const hits = []
  let currentFiberLabel = null
  const inspect = (value, path, depth = 0) => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return
    if (seenValues.has(value)) return
    seenValues.add(value)
    const methods = ['getSnapshot', 'updateQueue', 'prompt', 'fork', 'open', 'binding']
      .filter((name) => typeof value[name] === 'function')
    if (methods.includes('updateQueue') || methods.includes('fork')) {
      let prototypeMethods = []
      try {
        const proto = Object.getPrototypeOf(value)
        prototypeMethods = proto ? Object.getOwnPropertyNames(proto)
          .filter((name) => name !== 'constructor' && typeof value[name] === 'function') : []
      } catch {}
      hits.push({
        fiber: currentFiberLabel,
        path,
        methods,
        prototypeMethods,
        keys: typeof value === 'object' ? Object.keys(value).slice(0, 30) : [],
        projectionKeys: value.projections && typeof value.projections === 'object'
          ? Object.keys(value.projections).slice(0, 30) : [],
        sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
        useSessionType: typeof value.useSession,
        useSessionKeys: value.useSession && (typeof value.useSession === 'object' || typeof value.useSession === 'function')
          ? Object.keys(value.useSession).slice(0, 30) : [],
        useSessionProto: value.useSession && (typeof value.useSession === 'object' || typeof value.useSession === 'function')
          ? Object.getOwnPropertyNames(Object.getPrototypeOf(value.useSession) || {}).slice(0, 30) : [],
        sessionType: typeof value.session,
        sessionKeys: value.session && typeof value.session === 'object'
          ? Object.keys(value.session).slice(0, 40) : [],
        sessionSummary: value.session && typeof value.session === 'object' ? {
          sessionId: value.session.sessionId,
          queue: Array.isArray(value.session.queue) ? value.session.queue.map((row) => ({
            id: row.id,
            placement: row.placement,
            rpcId: row.rpcId,
            text: row.text,
            preview: row.preview,
          })) : null,
          running: value.session.running,
        } : value.session,
      })
    }
    if (depth >= 2 || typeof value !== 'object') return
    for (const key of ['session', 'sessions', 'value', 'current', 'binding', 'manager', 'service']) {
      try { if (key in value) inspect(value[key], path + '.' + key, depth + 1) } catch {}
    }
  }
  while (queue.length && seenFibers.size < 30000 && hits.length < 40) {
    const fiber = queue.shift()
    if (!fiber || seenFibers.has(fiber)) continue
    seenFibers.add(fiber)
    currentFiberLabel = String(fiber.elementType && (fiber.elementType.displayName || fiber.elementType.name)
      || fiber.type && (fiber.type.displayName || fiber.type.name) || fiber.tag)
    inspect(fiber.memoizedProps, 'props')
    inspect(fiber.pendingProps, 'pendingProps')
    let hook = fiber.memoizedState
    for (let index = 0; hook && index < 300; index += 1, hook = hook.next) {
      inspect(hook.memoizedState, 'hook[' + index + ']')
      inspect(hook.baseState, 'hook[' + index + '].baseState')
      inspect(hook.queue, 'hook[' + index + '].queue')
    }
    if (fiber.child) queue.push(fiber.child)
    if (fiber.sibling) queue.push(fiber.sibling)
  }
  return { visitedFibers: seenFibers.size, hits }
})()`)
console.log(JSON.stringify(capabilityReport, null, 2))

cdp.close()
