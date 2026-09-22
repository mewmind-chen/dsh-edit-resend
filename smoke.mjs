/**
 * 离线冒烟测试：在 mock DOM 里加载 client.js，验证
 *  1. bundle 语法可解析、能注册到 __ModuleLoader__
 *  2. 导出 apply / inject
 *  3. apply() 能挂上监听、注册清理 effect，且不抛
 *  4. 鼠标进入铅笔热区时出现稳定的编辑浮层，移开就收起
 *  5. 点击后消息位置出现独立的原位编辑器
 *  6. 队列中的消息 → updateQueue(kind:'edit')，不分叉也不提交
 *  7. 已消费的消息 → 从 seq-1 分叉，在新会话只提交一次
 *  8. 取消按钮能退出编辑态
 *  9. 原地改写成功后 DOM 镜像：被编辑行换新文本、前文保留、记录落盘
 *
 * 用法：node smoke.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

//#region 极简 DOM
class ClassList {
  constructor() { this.set = new Set() }
  add(...names) { for (const n of names) this.set.add(n) }
  remove(...names) { for (const n of names) this.set.delete(n) }
  contains(name) { return this.set.has(name) }
  toString() { return [...this.set].join(' ') }
}

let nodeSeq = 0

/** 维护 mock 的 isConnected：真实 DOM 会自动做，这里手动传播。 */
function markConnected(el) {
  el.isConnected = true
  for (const child of el.children) markConnected(child)
}

class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase()
    this.ownerDocument = ownerDocument
    this.childNodes = []
    this.parentElement = null
    this.attributes = new Map()
    this.dataset = {}
    this.style = {}
    this.classList = new ClassList()
    this._classes = new Set()
    this._listeners = new Map()
    this.textContent = ''
    this.value = ''
    this.scrollHeight = 72
    this.isConnected = true
    this._uid = ++nodeSeq
    // 输入框要够大才被 findComposer 认出来
    this._rect = { width: 600, height: 40, top: 500, left: 100, right: 700, bottom: 540 }
  }
  get className() { return [...this._classes].join(' ') }
  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean))
    this.classList = new ClassList()
    for (const c of this._classes) this.classList.add(c)
  }
  get children() { return this.childNodes.filter((n) => n instanceof Element) }
  get firstChild() { return this.childNodes[0] ?? null }
  get offsetWidth() { return 96 }
  get offsetHeight() { return 26 }
  appendChild(child) {
    if (child.parentElement) child.parentElement.removeChild(child)
    child.parentElement = this
    this.childNodes.push(child)
    markConnected(child)
    return child
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child)
    if (i >= 0) this.childNodes.splice(i, 1)
    child.parentElement = null
    const disconnect = (node) => {
      node.isConnected = false
      for (const nested of node.children) disconnect(nested)
    }
    disconnect(child)
    return child
  }
  remove() { if (this.parentElement) this.parentElement.removeChild(this) }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  removeAttribute(name) { this.attributes.delete(name) }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set())
    this._listeners.get(type).add(fn)
  }
  removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn) }
  dispatchEvent(event) {
    event.target = this
    event.defaultPrevented = event.defaultPrevented === true
    const path = []
    let el = this
    while (el) { path.push(el); el = el.parentElement }
    event.composedPath = () => path
    for (const el of path) {
      if (event._stopped) break
      const set = el._listeners?.get(event.type)
      if (set) for (const fn of [...set]) fn.call(el, event)
    }
    return !event.defaultPrevented
  }
  getBoundingClientRect() { return this._rect }
  focus() { this.ownerDocument.activeElement = this }
  setSelectionRange() {}
  blur() {}
  closest(selector) {
    let el = this
    while (el) {
      if (matches(el, selector)) return el
      el = el.parentElement
    }
    return null
  }
  querySelector(selector) { return find(this, splitSelectors(selector)) }
  querySelectorAll(selector) { return collect(this, splitSelectors(selector)) }
}

function splitSelectors(selector) {
  return selector.split(',').map((s) => s.trim()).filter(Boolean)
}

function matches(el, selector) {
  if (!(el instanceof Element)) return false
  const s = selector.trim()
  const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s)
  if (attr) {
    if (!el.attributes.has(attr[1])) return false
    return attr[2] === undefined || el.attributes.get(attr[1]) === attr[2]
  }
  const cls = /^\[class\*="([^"]+)"\]$/.exec(s)
  if (cls) return el.className.includes(cls[1])
  if (s.startsWith('.')) return el.classList.contains(s.slice(1))
  return el.tagName === s.toUpperCase()
}

function find(root, selectors) {
  const stack = [...root.children]
  while (stack.length) {
    const el = stack.shift()
    for (const sel of selectors) if (matches(el, sel)) return el
    stack.push(...el.children)
  }
  return null
}

function collect(root, selectors) {
  const out = []
  const stack = [...root.children]
  while (stack.length) {
    const el = stack.shift()
    for (const sel of selectors) if (matches(el, sel)) { out.push(el); break }
    stack.push(...el.children)
  }
  return out
}

class Document extends Element {
  constructor() {
    super('#document', null)
    this.ownerDocument = this
    this.head = new Element('head', this)
    this.body = new Element('body', this)
    this.appendChild(this.head)
    this.appendChild(this.body)
    this.activeElement = null
  }
  createElement(tag) { return new Element(tag, this) }
  createRange() {
    return {
      selectNodeContents(el) { this._el = el },
      collapse() {},
      setStart() {},
      setEnd() {},
    }
  }
}

class Selection {
  constructor() { this._ranges = [] }
  removeAllRanges() { this._ranges = [] }
  addRange(r) { this._ranges.push(r) }
}
//#endregion

//#region 环境
const document = new Document()
globalThis.document = document

/**
 * 读 document 上注册的某类监听器。
 * 关键：监听器必须留在 Element._listeners 里，dispatchEvent 才查得到；
 * 早先把 document.addEventListener 覆盖成实例方法会绕过那张表，
 * 结果 apply() 明明注册了监听器，事件却永远送不到。
 */
function docListenersOf(type) {
  return document._listeners?.get(type) ?? new Set()
}

function clearDocListeners() {
  document._listeners?.clear()
}

globalThis.window = {
  getSelection: () => new Selection(),
  innerWidth: 1440,
  innerHeight: 900,
}
globalThis.DataTransfer = class { setData() {} }
globalThis.ClipboardEvent = class {
  constructor(type, init) { this.type = type; this.defaultPrevented = false; Object.assign(this, init) }
  preventDefault() { this.defaultPrevented = true }
  stopPropagation() { this._stopped = true }
  stopImmediatePropagation() { this._stopped = true; this._immediateStopped = true }
}
globalThis.InputEvent = globalThis.ClipboardEvent
globalThis.KeyboardEvent = class {
  constructor(type, init) { this.type = type; this.defaultPrevented = false; Object.assign(this, init) }
  preventDefault() { this.defaultPrevented = true }
  stopPropagation() { this._stopped = true }
  stopImmediatePropagation() { this._stopped = true; this._immediateStopped = true }
}
globalThis.__DER_DEBUG = true
/**
 * 最小 MutationObserver：插件用它被动观察消息列表，在 React 重渲染后补回铅笔。
 * 测试只需要 observe/disconnect/takeRecords 三个方法。
 */
/**
 * mock 的改写端点。
 * 插件现在走自己注册的 HTTP 路由（POST /edit-resend/rewrite），而不是命令，
 * 所以测试拦 fetch 就能看到「它到底请求了什么」。
 */
const rewriteCalls = []
globalThis.fetch = async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : null
  rewriteCalls.push({ url, body })
  return {
    status: 200,
    json: async () => ({ ok: true, shadowedRange: [body?.atSeq ?? 0, 999], backup: { ok: true, path: '/tmp/fake-backup' } }),
  }
}

globalThis.MutationObserver = class {
  constructor(callback) { this.callback = callback; this.targets = [] }
  observe(target, options) { this.targets.push({ target, options }) }
  disconnect() { this.targets = [] }
  takeRecords() { return [] }
  trigger() { this.callback([], this) }
}

globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)

// 模拟「编辑器不认 paste、只认 execCommand」这一真实分支：
// execCommand 是我们三级降级里的第二级。
document.execCommand = (command, _show, value) => {
  if (command !== 'insertText') return false
  const ed = document.activeElement
  if (!ed) return false
  ed.textContent = String(value)
  return true
}

const registered = []
globalThis.window.__ModuleLoader__ = { load: ({ id, factory }) => registered.push({ id, factory }) }
//#endregion

//#region 断言工具
let failures = 0
const results = []
function check(name, condition, detail) {
  if (condition) {
    results.push(`  ok   ${name}`)
  } else {
    failures += 1
    results.push(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}
//#endregion

//#region 场景
function buildConversation({ session }) {
  const root = document.createElement('div')
  root.className = 'conversationRoot'
  document.body.appendChild(root)

  const chat = document.createElement('div')
  root.appendChild(chat)

  const hosts = []
  for (const [index, text] of ['第一条消息', '第二条消息'].entries()) {
    const flow = document.createElement('div')
    flow.setAttribute('data-chat-flow', '')
    flow.setAttribute('data-chat-flow-kind', 'user')
    const row = document.createElement('div')
    row.className = 'Sixlwa_userRow'
    const stack = document.createElement('div')
    stack.className = 'Sixlwa_userStack'
    const bubble = document.createElement('div')
    bubble.className = 'Sixlwa_bubble'
    bubble.textContent = text
    stack.appendChild(bubble)
    row.appendChild(stack)
    // 原生操作栏：userRow 的最后一个子元素，就是放「复制」的那一行。
    // 插件应当把铅笔插进这里复用原生显隐，而不是自己另起浮层。
    const actions = document.createElement('div')
    actions.className = 'xzv4MW_actions'
    const copy = document.createElement('button')
    copy.className = 'xzv4MW_action'
    copy.setAttribute('aria-label', '复制')
    actions.appendChild(copy)
    row.appendChild(actions)
    flow.appendChild(row)
    chat.appendChild(flow)
    const seq = index * 10 + 11
    const turn = index + 1
    const node = {
      kind: 'user',
      anchorSeq: seq,
      data: { seq, source: { rpcId: `rpc-${index + 1}` } },
      location: {
        kind: 'step',
        turn: {
          turn,
          status: 'closed',
          start: { seq: seq - 1 },
          end: { seq: seq + 8 },
        },
      },
    }
    hosts.push({ flow, row, stack, text, node, actions, copy })
  }

  const composer = document.createElement('div')
  composer.setAttribute('contenteditable', 'true')
  composer.textContent = ''
  root.appendChild(composer)
  composer.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    const text = composer.textContent.trim()
    if (!text) return
    event.preventDefault()
    session.calls.submit.push(text)
    composer.textContent = ''
  })

  // 用 fiber 暴露会话对象：模拟 DSH 把会话句柄放在 hook 槽位里。
  //
  // 关键：真实 React 会给**每个** DOM 节点挂 `__reactFiber$`，而插件是从
  // 被点击的那条消息节点开始向上爬树的。所以这里必须把 fiber 挂在消息
  // 节点上，不是只挂 composer——否则测的就不是真实路径。
  const managerHook = { memoizedState: session.manager, next: null }
  const hook = { memoizedState: session, next: managerHook }
  const ownerFiber = {
    type: function ConversationPanel() {},
    memoizedState: hook,
    return: null,
    child: null,
    sibling: null,
  }
  const queueFiber = {
    type: function QueueSurface() {},
    memoizedProps: {
      session: session.queueSnapshot,
      sessionId: session.queueSnapshot.sessionId,
      updateQueue: (itemId, action) => session.updateQueue(itemId, action),
    },
    pendingProps: null,
    memoizedState: null,
    return: ownerFiber,
    child: null,
    sibling: null,
  }
  queueFiber.pendingProps = queueFiber.memoizedProps
  ownerFiber.child = queueFiber
  composer.__reactFiber$test = ownerFiber
  for (const entry of hosts) {
    const messageFiber = {
      type: function UserMessage() {},
      memoizedProps: { node: entry.node },
      pendingProps: { node: entry.node },
      memoizedState: null,
      return: ownerFiber,
      child: null,
      sibling: null,
    }
    entry.stack.__reactFiber$test = messageFiber
    entry.row.__reactFiber$test = messageFiber
  }
  session.onOpen = (childId) => {
    session.sessionId = childId
    session.queueSnapshot.sessionId = childId
    session.queueSnapshot.queue = [{
      id: 'inherited-second', rpcId: 'rpc-2', placement: 'queued',
      text: hosts[1].text, preview: hosts[1].text,
    }]
    queueFiber.memoizedProps.sessionId = childId
    // 分叉点在第一轮结束：第一条保留，第二条及助手后续从视图移除。
    hosts[1].flow.remove()
  }

  return { root, hosts, composer }
}

/**
 * mock 的客户端会话管理器。
 * 插件优先经它有 fork/open/create；缺了它会退回 forkAt / session.fork 路径。
 */
function makeSessionsService() {
  const calls = { fork: [], open: [], create: [], command: [] }
  const service = {
    calls,
    fork: async (opts) => {
      calls.fork.push(opts)
      return { ok: true, value: { sessionId: `session-child-${calls.fork.length}` } }
    },
    open: async (id) => { calls.open.push(id) },
    create: async (opts) => {
      calls.create.push(opts)
      return { ok: true, value: { sessionId: `session-fresh-${calls.create.length}` } }
    },
    get: (sessionId) => ({
      sessionId,
      // 新语义：客户端通过 session.command('/rewind ...') 发起原地改写，
      // 这条命令明确绑定目标会话，不会发到别的会话去。
      command: async (line) => {
        calls.command.push({ sessionId, line })
        return { ok: true, value: { matched: true } }
      },
    }),
    scope: () => undefined,
  }
  return service
}

/** 组装一个客户端 ctx，插件通过 ctx.get(name) 取服务。 */
function makeCtx(services = {}, extra = {}) {
  return {
    get: (name) => services[name] ?? null,
    effect: () => {},
    ...extra,
  }
}

function makeSession({ pending = null } = {}) {
  const calls = { updateQueue: [], fork: [], open: [], prompt: [], submit: [] }
  const queueSnapshot = {
    sessionId: 'session-old',
    queue: pending === null ? [] : [pending],
  }
  const session = {
    sessionId: 'session-old',
    calls,
    queueSnapshot,
    getSnapshot: () => queueSnapshot,
    updateQueue: async (itemId, action) => {
      calls.updateQueue.push({ itemId, action })
      queueSnapshot.queue = queueSnapshot.queue.map((item) => item.id === itemId
        ? { ...item, text: action.content?.[0]?.text || item.text, preview: action.content?.[0]?.text || item.preview }
        : item)
      return { ok: true }
    },
    prompt: async (content, mode) => { calls.prompt.push({ content, mode }); return { ok: true } },
  }
  session.manager = {
    binding: {},
    fork: async (opts) => { calls.fork.push(opts); return 'session-child' },
    open: async (id) => { calls.open.push(id); session.onOpen?.(id) },
  }
  return session
}

function resetCalls() {
  rewriteCalls.length = 0
}

function resetBody() {
  // 真实 DOM 会在移除时把 isConnected 变 false；mock 必须手动维护，
  // 否则插件的 `element.isConnected` 判断会误判成「还挂着」。
  const disconnect = (el) => {
    el.isConnected = false
    for (const child of el.children) disconnect(child)
  }
  for (const child of document.body.children) disconnect(child)
  for (const child of document.head.children) disconnect(child)
  document.body.childNodes = []
  document.head.childNodes = []
}

function fireMouseMove(target, clientX = 680, clientY = 550) {
  const event = { type: 'mousemove', target, clientX, clientY, defaultPrevented: false }
  for (const fn of docListenersOf('mousemove')) fn(event)
}

function fireMouseLeave() {
  const event = { type: 'mouseleave', target: document.body, defaultPrevented: false }
  for (const fn of docListenersOf('mouseleave')) fn(event)
}

function clickEdit(hostIndex = 0) {
  // 实时查找：DOM 变动后缓存的元素引用会失效，必须重新定位。
  const rows = [...document.querySelectorAll('[class*="userRow"]')]
  const row = rows[hostIndex]
  if (!row) return false
  const pencil = row.querySelector('[data-der-edit]')
  if (!pencil) return false
  const event = {
    type: 'click',
    target: pencil,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this._stopped = true },
  }
  pencil.dispatchEvent(event)
  return true
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))
//#endregion

//#region 1. 加载 bundle
const source = readFileSync(join(here, 'lib', 'client.js'), 'utf8')

/**
 * 每次调用都执行一遍 bundle，拿到一个全新的模块闭包。
 * 插件内部有 wired 幂等标记与模块级状态，复用同一个实例会让用例互相污染；
 * 真实运行时每个宿主页只加载一次，所以用例之间必须隔离。
 * @returns {{ apply: Function, inject: unknown[] }}
 */
function loadPlugin() {
  const seen = []
  const saved = globalThis.window.__ModuleLoader__
  globalThis.window.__ModuleLoader__ = { load: (record) => seen.push(record) }
  try {
    new Function(source)()
  } finally {
    globalThis.window.__ModuleLoader__ = saved
  }
  if (seen.length !== 1) throw new Error(`bundle 注册了 ${seen.length} 个模块，期望 1 个`)
  if (seen[0].id !== 'dsh-edit-resend') throw new Error(`模块 id 是 ${seen[0].id}`)
  return seen[0].factory(() => { throw new Error('unexpected require') })
}

let mod
try {
  mod = loadPlugin()
  check('bundle 可解析并执行', true)
} catch (error) {
  console.log(`  FAIL bundle 可解析并执行 — ${error.message}`)
  process.exit(1)
}
check('注册的模块 id 正确', true)
check('导出 apply', typeof mod.apply === 'function')
check('导出 inject 数组', Array.isArray(mod.inject))
//#endregion

//#region 2. 挂载
const session = makeSession()
const { hosts, composer } = buildConversation({ session })
let currentHosts = hosts
const effects = []
const sessionsSvc = makeSessionsService()
mod.apply(makeCtx({ sessions: sessionsSvc }, { effect: (fn, label) => effects.push({ fn, label }) }))
check('apply() 不抛异常', true)
check('注册了清理 effect', effects.length === 1)
check('挂了 keydown 监听（Enter/Esc 拦截用）', (docListenersOf('keydown')).size === 1)
check('不再挂 mousemove 监听（显隐交给原生 CSS）', (docListenersOf('mousemove')).size === 0)
//#endregion

//#region 3. 铅笔注入原生操作栏
await settle(20)
check('不再创建自有浮层', document.querySelector('.der_layer') === null)
check('第一条消息的原生操作栏里有铅笔', hosts[0].actions.querySelector('[data-der-edit]') !== null)
check('第二条消息的原生操作栏里也有铅笔', hosts[1].actions.querySelector('[data-der-edit]') !== null)
const pencil = hosts[0].actions.querySelector('[data-der-edit]')
check('铅笔是操作栏的最后一个子元素（排在复制右侧）', hosts[0].actions.children[hosts[0].actions.children.length - 1] === pencil)
check('铅笔说明是「编辑」', pencil.getAttribute('aria-label') === '编辑')
check('铅笔标题是「编辑」', pencil.title === '编辑')
check('铅笔是纯图标按钮（图标而非文字）', pencil.textContent.trim() === '' && pencil.innerHTML.includes('<svg'))

check('注入是幂等的（不会插第二个铅笔）', hosts[0].actions.querySelectorAll('[data-der-edit]').length === 1)
check('铅笔排在复制按钮右侧', hosts[0].actions.children[0] === hosts[0].copy)
//#endregion

//#region 4. 点击进入原位编辑态（已消费消息 → fork）
// 编辑第二条：第一轮真实的 turn/end 是 seq=19。
// 分叉必须直接使用这个完成边界，不能再用前一条用户消息 seq=11 猜边界。
check('铅笔可点击', clickEdit(1))
await settle(20)
const editor = document.querySelector('.der_editor')
const shell = document.querySelector('.der_editorShell')
check('文本回填进原位编辑器', editor !== null && editor.value === hosts[1].text, editor?.value)
check('底部输入框保持为空', composer.textContent === '')
check('原位编辑器是自有浮层，不进入 React 的消息树', shell !== null && shell.closest('[class*="userRow"]') === null && shell.closest('.der_layer') !== null && shell.closest('.der_layer').parentElement === document.body)
editor.value = '第二条消息：改过'
const enter = new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
editor.dispatchEvent(enter)
check('Enter 被拦截', enter.defaultPrevented === true)
await settle(900)
// 分叉现在走显式注入的 sessions 服务（真实环境里会话对象藏在 cordis 闭包，
// 扫 fiber 拿不到），所以断言看 sessionsSvc。
// 新语义：任何情况都不新建会话，改为向**目标会话**发起 /rewind 原地改写。
check('已消费消息发起原地改写（不 fork、不建会话）', sessionsSvc.calls.fork.length === 0
  && sessionsSvc.calls.create.length === 0
  && rewriteCalls.length === 1, JSON.stringify({ fork: sessionsSvc.calls.fork, calls: rewriteCalls }))
check('改写请求打到插件的 HTTP 端点', rewriteCalls[0]?.url === '/edit-resend/rewrite', String(rewriteCalls[0]?.url))
check('请求里带上了这条消息的 seq', rewriteCalls[0]?.body?.atSeq === 21, JSON.stringify(rewriteCalls[0]?.body))
// 关键语义：直接锚定前一轮的 turn/end=19，被编辑的第二条消息及其后的
// 内容都不进入新会话种子；同轮含 steering 消息时也不会误带目标轮次。
check('请求里的文本就是用户改写后的原文（不是命令、不是 base64）',
  rewriteCalls[0]?.body?.text === '第二条消息：改过', JSON.stringify(rewriteCalls[0]?.body))
check('请求带上目标 sessionId（服务端据此定位，不靠当前输入框）',
  typeof rewriteCalls[0]?.body?.sessionId === 'string' && rewriteCalls[0].body.sessionId !== '',
  JSON.stringify(rewriteCalls[0]?.body))
// 锚点取的是「前一轮的 turn/end」，被编辑的消息整轮都不进新会话，
// 所以正常路径下**不需要**再去改写子会话的继承队列。
check('锚点正确时无需改写继承队列', session.calls.updateQueue.length === 0, JSON.stringify(session.calls.updateQueue))
check('分叉后不再额外提交 composer', session.calls.submit.length === 0, JSON.stringify(session.calls.submit))
// 第一条消息没有「前一条」可作锚点：不应分叉，而是降级为回填 + 提示。
resetBody()
clearDocListeners()
resetCalls()
const mod0 = loadPlugin()
const session0 = makeSession()
const conv0 = buildConversation({ session: session0 })
mod0.apply(makeCtx({ sessions: makeSessionsService() }))
await settle(20)
check('第一条消息的铅笔可点', clickEdit(0))
await settle(40)
const editor0 = document.querySelector('.der_editor')
check('第一条消息也能进编辑态', editor0 !== null)
if (editor0) {
  editor0.value = '第一条：改过'
  editor0.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
}
await settle(300)
check('第一条消息不分叉（前面没有可保留的上下文）', session0.calls.fork.length === 0, JSON.stringify(session0.calls.fork))

//#endregion

//#region 5. 队列中的消息 → 引导去原生队列区编辑（不硬撑、不分叉）
resetBody()
clearDocListeners()
resetCalls()
const mod2 = loadPlugin()
const session2 = makeSession({ pending: { id: 'item-7', rpcId: 'rpc-1', placement: 'queued', text: '第一条消息', preview: '第一条消息' } })
const conv2 = buildConversation({ session: session2 })
currentHosts = conv2.hosts
mod2.apply(makeCtx({ sessions: makeSessionsService() }))
await settle(20)
clickEdit()
await settle(20)
const enter2 = new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
const editor2 = document.querySelector('.der_editor')
editor2.value = '第一条消息：队列改写'
editor2.dispatchEvent(enter2)
await settle(150)
// 队列里的消息归 DSH 原生队列区管（那里本就有编辑按钮）。
// 插件拿不到带 updateQueue 的会话句柄，所以不做原地改写：
// 既不该误分叉，也不该偷偷多发一条。
check('队列消息不分叉', session2.calls.fork.length === 0, JSON.stringify(session2.calls.fork))
check('队列消息不额外提交', session2.calls.submit.length === 0, JSON.stringify(session2.calls.submit))
check('队列消息调用原生 updateQueue 原地改写', session2.calls.updateQueue.length === 1
  && session2.calls.updateQueue[0]?.itemId === 'item-7'
  && session2.calls.updateQueue[0]?.action?.kind === 'edit', JSON.stringify(session2.calls.updateQueue))
//#endregion

//#region 6. 取消编辑态
resetBody()
clearDocListeners()
resetCalls()
const mod3 = loadPlugin()
const session3 = makeSession()
const conv3 = buildConversation({ session: session3 })
currentHosts = conv3.hosts
mod3.apply(makeCtx({ sessions: makeSessionsService() }))
await settle(20)
clickEdit(1)
await settle(20)
const shell3 = document.querySelector('.der_editorShell')
check('编辑态已激活', shell3 !== null && shell3.style.display === 'block')
const cancelButton = document.querySelector('.der_cancel')
cancelButton.dispatchEvent({ type: 'click', target: cancelButton, defaultPrevented: false })
await settle(20)
check('取消后原位编辑器收起', shell3.style.display === 'none')
const enter3 = new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
conv3.composer.dispatchEvent(enter3)
await settle(60)
check('取消后 Enter 不再触发 fork', session3.calls.fork.length === 0)
//#endregion

//#region 6.5 编辑第一条消息 → 新建空上下文会话
resetBody()
clearDocListeners()
resetCalls()
const modFirst = loadPlugin()
const sessionFirst = makeSession()
const sessionsFirst = makeSessionsService()
const convFirst = buildConversation({ session: sessionFirst })
currentHosts = convFirst.hosts
modFirst.apply(makeCtx({ sessions: sessionsFirst }))
await settle(20)
check('第一条消息的铅笔可点', clickEdit(0))
await settle(60)
const editorFirst = document.querySelector('.der_editor')
check('第一条消息也能进编辑态', editorFirst !== null)
if (editorFirst) {
  editorFirst.value = '第一条：改过'
  editorFirst.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
}
await settle(700)
// Codex 语义：前面没有可保留的上下文 → 不 fork，而是新建一个空会话
check('编辑第一条不分叉', sessionsFirst.calls.fork.length === 0, JSON.stringify(sessionsFirst.calls.fork))
// 用户明确要求：改写跟「第几条」无关，就是重新修改刚才的输入。
// 所以编辑第一条也照样发起原地改写，只是不新建任何会话。
check('编辑第一条也走原地改写', rewriteCalls.length === 1, JSON.stringify(rewriteCalls))
check('编辑第一条不新建会话、不分叉', sessionsFirst.calls.create.length === 0
  && sessionsFirst.calls.fork.length === 0, JSON.stringify(sessionsFirst.calls))
check('也没有打开任何新会话', sessionsFirst.calls.open.length === 0, JSON.stringify(sessionsFirst.calls.open))
//#endregion

//#region 6.8 编辑历史消息，但队列里有「短文本包含在长文本里」的项 → 必须走分叉
//
// 这是真机复现出来的判定误判：
//   被编辑的是**已消费的历史消息**「可以了，现在就是在公网回答你的」，
//   用户把它改短成「可以了」。而队列里当时还有一条长文本。
//   旧的包含式匹配（itemText.includes(needle)）会把历史消息认成队列消息，
//   于是走「原地改写队列」、不分叉——现象就是旧消息还在 + 改后内容在排队。
resetBody()
clearDocListeners()
resetCalls()
const modAmb = loadPlugin()
const sessionAmb = makeSession({
  pending: {
    id: 'q-long', rpcId: 'rpc-other', placement: 'queued',
    text: '可以了，现在就是在公网回答你的', preview: '可以了，现在就是在公网回答你的',
  },
})
const sessionsAmb = makeSessionsService()
const convAmb = buildConversation({ session: sessionAmb })
currentHosts = convAmb.hosts
modAmb.apply(makeCtx({ sessions: sessionsAmb }))
await settle(20)
// 编辑第二条（历史消息），它的文本是「第二条消息：再检查一下权限」
check('历史消息的铅笔可点', clickEdit(1))
await settle(60)
const editorAmb = document.querySelector('.der_editor')
check('历史消息进入编辑态', editorAmb !== null)
if (editorAmb) {
  // 改短：只保留前缀，模拟「可以了，现在就是在公网回答你的」→「可以了」
  editorAmb.value = '第二条消息：再检查'
  editorAmb.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
}
await settle(800)
check('历史消息不应被误判成队列项（不改队列）', sessionAmb.calls.updateQueue.length === 0,
  JSON.stringify(sessionAmb.calls.updateQueue))
check('历史消息走原地改写（不 fork）', sessionsAmb.calls.fork.length === 0
  && rewriteCalls.length === 1, JSON.stringify({ fork: sessionsAmb.calls.fork, calls: rewriteCalls }))
check('改写点用的是这条消息自己的 seq（不是前一轮边界）',
  rewriteCalls[0]?.body?.atSeq === 21, JSON.stringify(rewriteCalls[0]?.body))
//#endregion

//#region 6.9 DOM 镜像（改写成功后所见即所得，刷新后重放）
//
// 背景：DSH 的 transcript 按设计只追加，replace 事件只进模型投影，
// 用户气泡定义只匹配 append 事件。所以“旧的不再显示”由插件在 DOM 层
// 完成：被编辑行换新文本，同轮及之后的 flow 藏掉，记录落 localStorage。
resetBody()
clearDocListeners()
resetCalls()
globalThis.localStorage = {
  _m: {},
  getItem(k) { return this._m[k] ?? null },
  setItem(k, v) { this._m[k] = String(v) },
  removeItem(k) { delete this._m[k] },
}
const modM = loadPlugin()
const sessionM = makeSession()
const sessionsM = makeSessionsService()
const convM = buildConversation({ session: sessionM })
currentHosts = convM.hosts
modM.apply(makeCtx({ sessions: sessionsM }))
await settle(20)
// 给 mock 的 flow 补上真实 DSH 的 turn 标记。
convM.hosts[0].flow.setAttribute('data-chat-flow', '')
convM.hosts[0].flow.setAttribute('data-chat-turn', '1')
convM.hosts[1].flow.setAttribute('data-chat-flow', '')
convM.hosts[1].flow.setAttribute('data-chat-turn', '2')
// turn 1 的旧助手回复（应保留），turn 2 的旧助手回复（应被藏掉）。
const oldReply1 = document.createElement('div')
oldReply1.setAttribute('data-chat-flow-kind', 'assistant')
oldReply1.setAttribute('data-chat-turn', '1')
oldReply1.textContent = '旧回复1'
convM.hosts[0].flow.parentElement.appendChild(oldReply1)
const oldReply2 = document.createElement('div')
oldReply2.setAttribute('data-chat-flow-kind', 'assistant')
oldReply2.setAttribute('data-chat-turn', '2')
oldReply2.textContent = '旧回复2'
convM.hosts[1].flow.parentElement.appendChild(oldReply2)
check('镜像：第二条的铅笔可点', clickEdit(1))
await settle(60)
const editorM = document.querySelector('.der_editor')
check('镜像：进入编辑态', editorM !== null)
editorM.value = '第二条消息：镜像改写'
editorM.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
await settle(900)
check('镜像：改写请求发出', rewriteCalls.length === 1, JSON.stringify(rewriteCalls))
const sidM = rewriteCalls[0]?.body?.sessionId
const storeM = JSON.parse(globalThis.localStorage.getItem('dsh-edit-resend.mirror.v2') || '{}')
const editsM = Array.isArray(storeM[sidM]) ? storeM[sidM] : (storeM[sidM] && storeM[sidM].edits) || []
check('镜像：改写记录落盘', editsM.length === 1
  && editsM[0].text === '第二条消息：镜像改写', JSON.stringify(storeM))
const bubbleM = convM.hosts[1].stack.querySelector('[class*="bubble"]')
check('镜像：被编辑行的气泡换成新文本', bubbleM !== null && bubbleM.textContent === '第二条消息：镜像改写',
  bubbleM?.textContent)
check('镜像：前文 flow 保持可见', convM.hosts[0].flow.style.display !== 'none'
  && convM.hosts[0].flow.getAttribute('data-der-hidden') === null)
check('镜像：同轮及之后的旧内容被藏掉', oldReply2.style.display === 'none'
  && oldReply2.getAttribute('data-der-hidden') !== null,
  `display=${oldReply2.style.display}`)
check('镜像：前轮的旧回复保留', oldReply1.style.display !== 'none'
  && oldReply1.getAttribute('data-der-hidden') === null)
// 刷新后重放：全新 DOM + 同一份 localStorage，镜像要自己回来。
resetBody()
clearDocListeners()
const modM2 = loadPlugin()
const sessionM2 = makeSession()
const convM2 = buildConversation({ session: sessionM2 })
convM2.hosts[0].flow.setAttribute('data-chat-flow', '')
convM2.hosts[0].flow.setAttribute('data-chat-turn', '1')
convM2.hosts[1].flow.setAttribute('data-chat-flow', '')
convM2.hosts[1].flow.setAttribute('data-chat-turn', '2')
modM2.apply(makeCtx({ sessions: makeSessionsService() }))
await settle(60)
const bubbleM2 = convM2.hosts[1].stack.querySelector('[class*="bubble"]')
check('镜像：刷新后重放，被编辑行仍是新文本', bubbleM2 !== null && bubbleM2.textContent === '第二条消息：镜像改写',
  bubbleM2?.textContent)
delete globalThis.localStorage
//#endregion

//#region 7. 清理
resetBody()
clearDocListeners()
resetCalls()
const mod4 = loadPlugin()
const session4 = makeSession()
buildConversation({ session: session4 })
const effects4 = []
mod4.apply(makeCtx({}, { effect: (fn) => effects4.push(fn) }))
await settle(20)
const cleanup4 = effects4[0]()
cleanup4()
await settle(20)
check('dispose 移除监听', (docListenersOf('mousemove')).size === 0)
check('dispose 移除浮层', document.querySelector('.der_actions') === null)
//#endregion

console.log('dsh-edit-resend 离线冒烟测试')
console.log('')
for (const line of results) console.log(line)
console.log('')
if (failures === 0) {
  console.log(`全部通过 ✓ (${results.length} 项)`)
  process.exit(0)
} else {
  console.log(`${failures} 项失败 ✗`)
  process.exit(1)
}
