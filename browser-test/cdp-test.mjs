/** CDP 驱动真实 Chrome + React fiber 验收。始终复用同一个测试标签页。 */
import { writeFileSync } from 'node:fs'

const CDP_PORT = process.argv[2] || '9222'
const PAGE_URL = 'http://127.0.0.1:8791/index.html'

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
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { send, close: () => socket.close() }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  }
  return result.result.value
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
let failures = 0
function check(name, ok, detail) {
  results.push(ok ? `  ok   ${name}` : `  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

async function acquireTarget() {
  const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((response) => response.json())
  const existing = list.find((target) => target.type === 'page' && target.url.startsWith(PAGE_URL))
  if (existing) return { target: existing, cdp: await connect(existing.webSocketDebuggerUrl), reused: true }
  const target = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(PAGE_URL)}`, {
    method: 'PUT',
  }).then((response) => response.json())
  return { target, cdp: await connect(target.webSocketDebuggerUrl), reused: false }
}

const acquired = await acquireTarget()
const cdp = acquired.cdp
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
await cdp.send('Page.navigate', { url: PAGE_URL })
await sleep(1400)

const boot = await evaluate(cdp, `(() => {
  const t = window.__DSH_TEST__ || {}
  return {
    moduleLoaded: t.moduleLoaded === true, hasApply: t.hasApply === true,
    applied: t.applied === true, applyError: t.applyError || null,
    userMessages: document.querySelectorAll('[class*="userRow"]').length,
  }
})()`)
check('复用单一测试标签页', acquired.reused === true)
check('bundle 加载并 apply', boot.moduleLoaded && boot.hasApply && boot.applied, JSON.stringify(boot))
check('渲染两条用户消息', boot.userMessages === 2, String(boot.userMessages))

async function hoverAt(index) {
  await evaluate(cdp, `(() => {
    const row = document.querySelectorAll('[class*="userRow"]')[${index}]
    const nativeActions = [...row.querySelectorAll('div')].find((el) =>
      String(el.className).includes('_actions') && el.querySelector('button'))
    const rect = nativeActions.getBoundingClientRect()
    nativeActions.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: rect.right + 8, clientY: rect.top + 8,
    }))
  })()`)
  await sleep(120)
}

// 1) 铅笔注入原生操作栏（不另起浮层）
const injected = await evaluate(cdp, `(() => {
  const rows = [...document.querySelectorAll('[class*="userRow"]')]
  return rows.map((row) => {
    const native = [...row.querySelectorAll('div')].find((el) =>
      String(el.className).includes('_actions') && el.querySelector('button'))
    const pencil = native && native.querySelector('[data-der-edit]')
    const copy = native && native.querySelector('button:not([data-der-edit])')
    const p = pencil && pencil.getBoundingClientRect()
    const c = copy && copy.getBoundingClientRect()
    return {
      hasPencil: !!pencil,
      isLastChild: pencil ? native.lastElementChild === pencil : false,
      label: pencil && pencil.getAttribute('aria-label'),
      title: pencil && pencil.title,
      pencilSize: p ? [Math.round(p.width), Math.round(p.height)] : null,
      copySize: c ? [Math.round(c.width), Math.round(c.height)] : null,
      barOpacity: native ? getComputedStyle(native).opacity : null,
    }
  })
})()`)
check('每条用户消息的原生操作栏都被注入铅笔', injected.length === 2 && injected.every((r) => r.hasPencil), JSON.stringify(injected))
check('铅笔是操作栏最后一个元素（排在复制右侧）', injected.every((r) => r.isLastChild), JSON.stringify(injected))
check('提示文字是「编辑」', injected.every((r) => r.label === '编辑' && r.title === '编辑'), JSON.stringify(injected))
check('铅笔尺寸与复制按钮一致', injected.every((r) => JSON.stringify(r.pencilSize) === JSON.stringify(r.copySize)), JSON.stringify(injected))
// 注意：不在这里断言 opacity。测试页的操作栏 CSS 是简化版，与 DSH 真实的
// [data-actions-reveal=hover] + :has 规则不同；这里要验的是插件**没有**插手显隐。
const noSelfToggle = await evaluate(cdp, `(() => {
  const pencil = document.querySelector('[data-der-edit]')
  if (!pencil) return { missing: true, testState: {
    applied: window.__DSH_TEST__?.applied,
    applyError: window.__DSH_TEST__?.applyError,
    scriptError: window.__DSH_TEST__?.scriptError,
    moduleLoaded: window.__DSH_TEST__?.moduleLoaded,
    userMessages: document.querySelectorAll('[class*="userRow"]').length,
  } }
  return {
    inlineDisplay: pencil.style.display,
    inlineOpacity: pencil.style.opacity,
    inlineVisibility: pencil.style.visibility,
  }
})()`)
if (noSelfToggle.missing) throw new Error(`测试页未注入编辑按钮：${JSON.stringify(noSelfToggle.testState)}`)
check('插件不使用内联样式控制显隐（完全交给原生）',
  noSelfToggle.inlineDisplay === '' && noSelfToggle.inlineOpacity === '' && noSelfToggle.inlineVisibility === '',
  JSON.stringify(noSelfToggle))

// 不再存在插件自建的浮层
const ownLayer = await evaluate(cdp, `document.querySelector('.der_actions') === null && document.querySelector('.der_layer') === null`)
check('不再创建插件自有浮层', ownLayer === true)

// 2) 真实鼠标 hover：原生 CSS 把操作栏显出来，铅笔随之可见且稳定
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
await sleep(120)
const pencilPoint = await evaluate(cdp, `(() => {
  const pencil = document.querySelector('[data-der-edit]')
  const rect = pencil.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
})()`)
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pencilPoint.x, y: pencilPoint.y })
await sleep(120)
const afterHover = await evaluate(cdp, `(() => {
  const pencil = document.querySelector('[data-der-edit]')
  const row = pencil.closest('[class*="userRow"]')
  const native = [...row.querySelectorAll('div')].find((el) =>
    String(el.className).includes('_actions') && el.querySelector('button'))
  return { barOpacity: getComputedStyle(native).opacity, pencilVisible: pencil.getBoundingClientRect().width > 0 }
})()`)
check('真实鼠标移到铅笔位置后操作栏显现', afterHover.barOpacity === '1' && afterHover.pencilVisible, JSON.stringify(afterHover))

// 停留远超 80ms 过渡时间：不应闪烁（透明度保持 1）
await sleep(600)
const stable = await evaluate(cdp, `(() => {
  const pencil = document.querySelector('[data-der-edit]')
  const row = pencil.closest('[class*="userRow"]')
  const native = [...row.querySelectorAll('div')].find((el) =>
    String(el.className).includes('_actions') && el.querySelector('button'))
  return getComputedStyle(native).opacity
})()`)
check('停在铅笔上超过过渡时间仍保持稳定（不闪）', stable === '1', String(stable))

const hoverShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
writeFileSync(new URL('./screenshot-hover.png', import.meta.url), Buffer.from(hoverShot.data, 'base64'))

// 2) 已消费消息：精确分叉到 seq-1，切换后只提交一次。
await evaluate(cdp, `window.__DSH_TEST__.pendingItem = null`)
await hoverAt(1)
await evaluate(cdp, `document.querySelectorAll('[data-der-edit]')[1].click()`)
await sleep(100)
const historyEnter = await evaluate(cdp, `(() => {
  const editor = document.querySelector('.der_editor')
  if (!editor) return { prevented: false, missingEditor: true }
  editor.value = '第二条消息：修改后重发'
  editor.dispatchEvent(new InputEvent('input', { bubbles: true }))
  const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
  editor.dispatchEvent(event)
  return { prevented: event.defaultPrevented }
})()`)
await sleep(900)
const consumed = await evaluate(cdp, `(() => ({
  forks: window.__DSH_TEST__.forks,
  opens: window.__DSH_TEST__.opens,
  commits: window.__DSH_TEST__.commits,
  queueEdits: window.__DSH_TEST__.queueEdits,
  queueText: document.querySelector('[data-test-queue-item]')?.textContent,
  lateCaptureCount: window.__DSH_TEST__.lateCaptureCount,
  sessionId: document.querySelector('.app')?.getAttribute('data-session-id'),
  userMessages: document.querySelectorAll('[class*="userRow"]').length,
  visibleText: document.querySelector('.app')?.innerText,
}))()`)
check('历史消息 Enter 也被 capture 阶段拦截', historyEnter.prevented === true)
// 关键语义：锚点必须是前一轮精确的 turn/end（此场景 seq=19），
// 不能用前一条用户消息的 seq 猜边界；同一轮含 steering 时会猜错。
check('分叉锚点使用前一轮精确的 turn/end seq', consumed.forks.length === 1
  && consumed.forks[0].sessionId === 'session-old'
  && consumed.forks[0].atSeq === 19
  && consumed.forks[0].increaseTitle === true, JSON.stringify(consumed.forks))
check('分叉后打开新会话', consumed.opens[0] === 'session-child-1' && consumed.sessionId === 'session-child-1', JSON.stringify(consumed))
// 精确边界生效后，被编辑的消息**不会**进入子会话，因此不存在需要改写的
// 「继承项」——这正是要的语义。旧断言期望的 queueEdits===1 属于「锚点偏早、
// 旧消息被带进子会话」的兜底场景，正常路径不该出现。
// 这里改为验证：没有多余的继承改写，也没有重复提交。
check('子会话没有继承项、不需要兜底改写', consumed.queueEdits.length === 0
  && consumed.commits.length === 0, JSON.stringify({ queueEdits: consumed.queueEdits, commits: consumed.commits }))
check('分叉重发不再额外触发 composer 提交', consumed.commits.length === 0, JSON.stringify(consumed.commits))
check('编辑点及其后的旧内容不再显示', consumed.userMessages === 1
  && !consumed.visibleText.includes('第二条消息：再检查一下权限'), JSON.stringify(consumed))
check('编辑 Enter 被 stopImmediatePropagation 截住，未产生第二次 Enter',
  consumed.lateCaptureCount === 0, String(consumed.lateCaptureCount))

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
writeFileSync(new URL('./screenshot.png', import.meta.url), Buffer.from(shot.data, 'base64'))
cdp.close()

console.log('真实浏览器测试（Chrome + React fiber + CDP）')
console.log('')
for (const line of results) console.log(line)
console.log('')
if (failures === 0) console.log(`全部通过 ✓ (${results.length} 项)`)
else console.log(`${failures} 项失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
