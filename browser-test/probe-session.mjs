/**
 * 在真实 DSH GUI 里探查 React fiber 树，定位「会话句柄」的真实位置与形状。
 *
 * 背景：插件的 inspectConversation() 拿不到 session（诊断里 hasSession:false），
 * 连带队列检测失效。这个脚本不猜，直接把候选对象和它们的键打出来。
 *
 * 用法：node probe-session.mjs
 */

const CDP_PORT = '9222'
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
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      seq += 1
      const id = seq
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    }),
    close: () => socket.close(),
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) {
    return { __error: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text }
  }
  return result.result.value
}

const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json())
const target = list.find((t) => t.type === 'page' && t.url.startsWith(GUI))
if (target === undefined) {
  console.error('没找到 GUI 标签页；先跑 node open-gui.mjs')
  process.exit(1)
}
const cdp = await connect(target.webSocketDebuggerUrl)
await cdp.send('Runtime.enable')

const report = await evaluate(cdp, `(() => {
  const row = document.querySelector('[class*="userRow"]')
  if (!row) return { error: '页面上没有用户消息，请先打开一个会话' }

  const fiberKeyOf = (node) => Object.keys(node).find((k) => k.startsWith('__reactFiber$'))
  const key = fiberKeyOf(row)
  if (!key) return { error: '消息节点上没有 __reactFiber$' }

  // 收集祖先链上每个 fiber 的 hook 值与 props 里的对象
  const candidates = []
  const seen = new Set()
  let fiber = row[key]
  let guard = 0
  while (fiber && guard < 300) {
    guard += 1
    const visit = (value, where) => {
      if (!value || typeof value !== 'object') return
      if (seen.has(value)) return
      seen.add(value)
      const keys = Object.keys(value)
      const methods = keys.filter((k) => typeof value[k] === 'function')
      // 只挑「像会话」的：有快照/生命周期方法的对象
      const interesting = methods.filter((m) =>
        ['getSnapshot','subscribe','fork','prompt','updateQueue','cancel','beginSubmission','open','loadOlder','resync','command','rename']
          .includes(m))
      if (interesting.length >= 2) {
        candidates.push({
          where,
          typeName: (value.constructor && value.constructor.name) || typeof value,
          interestingMethods: interesting,
          allMethodCount: methods.length,
          keySample: keys.slice(0, 14),
          sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
        })
      }
    }
    let hook = fiber.memoizedState
    let hookGuard = 0
    while (hook && hookGuard < 400) {
      hookGuard += 1
      visit(hook.memoizedState, 'hook@' + guard)
      hook = hook.next
    }
    visit(fiber.memoizedProps, 'props@' + guard)
    visit(fiber.pendingProps, 'pendingProps@' + guard)
    fiber = fiber.return
  }

  return {
    ancestorFibers: guard,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, 12),
    // 顺带看看队列消息在 DOM 上有没有标记
    queueMarkers: {
      pendingSteering: document.querySelectorAll('[data-pending-steering]').length,
      submissionEcho: document.querySelectorAll('[data-submission-echo]').length,
      queueDock: document.querySelectorAll('[data-queue-dock]').length,
    },
  }
})()`)

console.log(JSON.stringify(report, null, 2))
cdp.close()
