/**
 * dsh-edit-resend 主机半边：原地改写会话历史。
 *
 * 设计（对照 DSH 源码得出，不依赖猜测）：
 *
 * - 会话日志只追加。改写历史靠 `surface replace`（`dsh-compaction` 同款机制）：
 *   追加一条 `user/message` 事件，带
 *   `surfaceOp: { op: 'replace', startSeq, endSeq }`，
 *   把 `[startSeq, endSeq]` 这段从模型可见的 surface 上盖掉。
 *   旧事件仍在日志里（备份可回滚），但 surface 上只剩新文本。
 * - `sourceEventSeqs` 必须包含被盖住的**全部** surface 节点
 *   （见 `dsh-session/lib/types/surface.js` 的 `assertProvenance`），
 *   且 `startSeq/endSeq` 必须当时就在 surface 上（`replacementRange`），
 *   否则这次 `append` 直接抛错。
 * - `agents.get(sessionId)` 拿到的是 AgentLoop（见 `dsh-agent-loop`）：
 *   `followup/inject/steer` 都是“再塞一条消息进 inbox”，而我们要的恰恰是
 *   “不再塞消息、只把已追加的替换跑起来”。Loop 的公开方法里只有 `kick()`
 *   是无消息唤醒（`wakeDriver` 不公开），所以改写后调 `agent.kick()`，
 *   且**不 await**——`kick()` 跑完整个 driver 才 resolve，await 会让 HTTP
 *   请求挂到回答结束。
 * - 新消息的 `source` 用 `{ kind: 'user' }`：它就是用户亲手改出来的那条消息，
 *   和 `dsh-better-sidebar` 经 `followup` 承认的消息一个待遇， transcript 里
 *   显示为用户气泡。用 `kind: 'plugin'` 会被折叠成上下文行。
 *
 * 对外通道是一条插件自己注册的 HTTP 路由（`POST /edit-resend/rewrite`）。
 * 客户端直接 fetch 它——不用斜杠命令，界面上无中间物。
 *
 * 安全：改写前把会话日志复制到 `$DSH_HOME/edit-resend-backups/`。
 *
 * @module dsh-edit-resend
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'dsh-edit-resend'

/**
 * 不声明必需服务。
 *
 * 踩过的坑：写 `inject: ['commands','agents']` 时，只要有一个服务解析不到，
 * cordis 就让整个插件停在等待态、`apply()` 永不执行（日志里连挂载记录都没有）。
 * 所以这里全部用 `ctx.get()` 运行时取。
 */
export const inject = []

/** 路由前缀。 */
const ROUTE_PREFIX = '/edit-resend'

/**
 * 安全打日志：ctx.logger 也可能因未 inject 而抛，全部吞掉。
 */
function logInfo(ctx, message) {
  try {
    ctx.logger?.info?.(message)
  } catch { /* 日志不重要 */ }
}

function logWarn(ctx, message) {
  try {
    ctx.logger?.warn?.(message)
  } catch { /* 日志不重要 */ }
}

/**
 * 落盘调试日志：ctx.logger 在该版本是空操作，kick 的异步失败必须写文件，
 * 否则“toast 成功但没回答”永远查不到原因。
 * 路径：$DSH_HOME/edit-resend-debug.log，拿不到时用系统临时目录。
 */
function debugLog(dshHome, line) {
  const message = `[${new Date().toISOString()}] ${line}\n`
  const paths = []
  if (typeof dshHome === 'string' && dshHome !== '') paths.push(join(dshHome, 'edit-resend-debug.log'))
  try {
    paths.push(join(tmpdir(), 'edit-resend-debug.log'))
  } catch { /* 忽略 */ }
  for (const target of paths) {
    try {
      appendFileSync(target, message)
      return target
    } catch { /* 换下一个路径 */ }
  }
  return null
}

//#region 会话日志定位与备份
function sessionLogPath(dshHome, sessionId) {
  const sessionsDir = join(dshHome, 'sessions')
  if (!existsSync(sessionsDir)) return null
  let projectDirs
  try {
    projectDirs = readdirSync(sessionsDir)
  } catch {
    return null
  }
  for (const projectDir of projectDirs) {
    const candidateDir = join(sessionsDir, projectDir, sessionId)
    if (!existsSync(candidateDir)) continue
    let files
    try {
      files = readdirSync(candidateDir)
    } catch {
      continue
    }
    const logs = files
      .filter((entry) => entry.startsWith('session') && entry.endsWith('.jsonl.zstd'))
      .map((entry) => join(candidateDir, entry))
    if (logs.length === 0) continue
    logs.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    return logs[0]
  }
  return null
}

function backupSessionLog(dshHome, sessionId) {
  const source = sessionLogPath(dshHome, sessionId)
  if (source === null) return { ok: false, path: null, reason: '没有找到会话日志文件' }
  const backupDir = join(dshHome, 'edit-resend-backups')
  try {
    mkdirSync(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(backupDir, `${sessionId}.${stamp}.${basename(source)}`)
    copyFileSync(source, target)
    return { ok: true, path: target }
  } catch (error) {
    return { ok: false, path: null, reason: error instanceof Error ? error.message : String(error) }
  }
}
//#endregion

//#region 原地改写
/**
 * surface.nodes 里可能是裸 seq 也可能是节点对象，统一抽成 seq 数组。
 */
export function surfaceSeqs(session) {
  const raw = [...session.surface.nodes]
  const seqs = []
  for (const node of raw) {
    if (typeof node === 'number' && Number.isSafeInteger(node)) {
      seqs.push(node)
      continue
    }
    if (node && typeof node === 'object') {
      for (const key of ['seq', 'eventSeq']) {
        const value = Number(node[key] ?? node.data?.[key])
        if (Number.isSafeInteger(value)) {
          seqs.push(value)
          break
        }
      }
    }
  }
  return seqs
}

/** dsh-system-prompt 插件在 surface 上留下的运行时上下文快照的 source 标识。 */
export const SYS_PROMPT_PLUGIN = '@deepseek-ai/dsh-system-prompt'

/**
 * 找出 AgentLoop 的 RuntimeContextProjection 当前持有的快照 seq。
 *
 * 背景（对照 dsh-agent-loop 源码）：
 * 唤醒后的第一轮能不能跑起来，取决于 preStep 的 decision.messages 是否为空；
 * inbox 是空的（我们不塞第二条消息），所以全看运行时上下文投影会不会吐出
 * 一条快照：只有 retained 与当前渲染不一致时才吐。retained 在两种情况下变：
 * 新快照事件追加，或某次 replace 的 sourceEventSeqs 含 retained.seq 时置空。
 * 之前“只有盖住快照的那次能跑起来”（第 1、4 次行，第 2、3 次空转）就是这个原因。
 *
 * 修法：sourceEventSeqs 里原本就允许带被盖范围之外的 provenance
 *（compaction 自己就是这么干的：[startEvent, summaryEvent, ...shadowed]），
 * 所以把现存快照 seq 也 cite 进去——范围不动（不多盖任何历史），但下一轮
 * 必定吐出一条新鲜快照（UI 上就是正常的“上下文注入”行），turn 必跑。
 * 附带治好“改写后的回答没有上下文注入两行”。
 */
function retainedSnapshotSeq(session) {
  let surface
  try {
    surface = new Set(surfaceSeqs(session))
  } catch {
    return null
  }
  let events
  try {
    events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
  } catch {
    return null
  }
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== 'plugin' || source?.plugin !== SYS_PROMPT_PLUGIN) continue
    if (surface.has(event.seq)) return event.seq
  }
  return null
}

export function handleRewriteSync(session, atSeq, text) {
  const seqs = surfaceSeqs(session)
  if (seqs.length === 0) return { ok: false, code: 'empty-surface' }
  const startIdx = seqs.indexOf(atSeq)
  // atSeq 不在 surface 上（已被 compaction 盖住等）：拒绝而不是静默盖错范围。
  if (startIdx === -1) return { ok: false, code: `seq ${atSeq} 不在当前 surface 上` }
  const startSeq = atSeq
  const endSeq = seqs.at(-1)
  const shadowedSeqs = seqs.slice(startIdx)
  // 把现存运行时快照 cite 进 provenance（范围不动）：下一轮投影必定吐出
  // 新鲜快照，turn 必跑起来。见 retainedSnapshotSeq 的注释。
  const retained = retainedSnapshotSeq(session)
  const sourceEventSeqs = retained !== null && !shadowedSeqs.includes(retained)
    ? [...shadowedSeqs, retained]
    : shadowedSeqs
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  const event = session.append('user/message', message, {
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs,
  })
  // 落盘后立刻验：surface 尾巴必须是刚追加的替换事件，否则这次改写盖错了地方，
  // 必须 loud 失败，不能报 ok（否则就是“显示成功但答的是旧的”）。
  const tailSeqs = surfaceSeqs(session)
  if (tailSeqs.at(-1) !== event.seq) {
    throw new Error(`surface 尾部不是替换事件（期望 ${event.seq}，实际 ${String(tailSeqs.at(-1))}）`)
  }
  return { ok: true, replacementSeq: event.seq, shadowedRange: [startSeq, endSeq] }
}
//#endregion

//#region HTTP 处理
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writeJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

async function handleRewrite(ctx, request) {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
  const atSeq = Number(request?.atSeq)
  const text = typeof request?.text === 'string' ? request.text : ''
  if (sessionId === '' || !Number.isSafeInteger(atSeq) || atSeq < 0 || text === '') {
    return { ok: false, reason: 'BAD_REQUEST' }
  }

  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  if (agent === undefined || agent.session === undefined) return { ok: false, reason: 'NO_AGENT' }
  if (agent.session.surface === undefined) return { ok: false, reason: 'NO_SURFACE' }

  // 只在空闲时改写：正在生成时改历史会把这一轮的上下文打乱。
  if (agent.status !== 'idle') return { ok: false, reason: 'BUSY' }

  // 注意：Cordis 的 ctx 是 Proxy，未声明 inject 就直接读 ctx.dshHome 会抛
  // `cannot get property "dshHome" without inject`。DSH_HOME 只是用来做备份，
  // 拿不到也不阻断改写。
  let dshHome = null
  try {
    dshHome = ctx.dshHome ?? null
  } catch {
    dshHome = null
  }
  if (dshHome === null) {
    try {
      dshHome = process.env.DSH_HOME ?? null
    } catch {
      dshHome = null
    }
  }
  const backup = dshHome === null
    ? { ok: false, path: null, reason: 'DSH_HOME 未知' }
    : backupSessionLog(dshHome, sessionId)

  let result
  try {
    result = handleRewriteSync(agent.session, atSeq, text)
  } catch (error) {
    return {
      ok: false,
      reason: 'REWRITE_FAILED',
      detail: error instanceof Error ? error.message : String(error),
      backup,
    }
  }
  if (!result.ok) return { ok: false, reason: 'REWRITE_FAILED', detail: result.code, backup }

  // 替换事件本身就是新用户消息：只唤醒 driver，不再塞第二条消息。
  //
  // 为什么调 wakeDriver 而不是 kick（对照 dsh-agent-loop 源码）：
  // `turn()` 要求 phase 为 running，否则直接抛 `turn without driver reservation`。
  // idle→running 的转换只发生在 `wakeDriver()` 里（followup/steer 也是经由它唤醒）；
  // 直接调 `kick()` 会立刻抛错、driver 永远起不来——这就是“返回成功但画面没反应”的原因。
  // wakeDriver 按命名是内部方法，但它是普通公开方法（无 # 前缀），可直接调用。
  const wakeMethod = typeof agent.wakeDriver === 'function'
    ? 'wakeDriver'
    : typeof agent.kick === 'function'
      ? 'kick'
      : null
  if (wakeMethod === null) {
    debugLog(dshHome, `session=${sessionId.slice(-8)} atSeq=${atSeq} NO_KICK no wake entry`)
    return { ok: false, reason: 'NO_KICK', detail: '当前 DSH 版本的 agent 没有可用的唤醒入口', backup }
  }
  const wake = wakeMethod === 'wakeDriver' ? () => agent.wakeDriver() : () => agent.kick()
  try {
    const wakeResult = wake()
    // kick() 跑完整个 driver 才 resolve，不能 await（会把 HTTP 请求挂到回答结束）；
    // 只接住异步拒绝，避免 unhandled rejection，原因写进落盘日志。
    if (wakeResult !== undefined && typeof wakeResult.catch === 'function') {
      wakeResult.catch((error) => {
        const detail = error instanceof Error ? (error.stack || error.message) : String(error)
        debugLog(dshHome, `session=${sessionId.slice(-8)} replacement=${result.replacementSeq} WAKE_REJECTED via=${wakeMethod}: ${detail}`)
        logWarn(ctx, `edit-resend: wake failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  } catch (error) {
    debugLog(dshHome, `session=${sessionId.slice(-8)} atSeq=${atSeq} WAKE_THREW via=${wakeMethod}: ${error instanceof Error ? error.message : String(error)}`)
    return {
      ok: false,
      reason: 'KICK_FAILED',
      detail: error instanceof Error ? error.message : String(error),
      backup,
    }
  }
  // wakeDriver 同步把 phase 切到 running；如果还是 idle，说明 driver 没起来，
  // 不能报成功（否则就是“成功但没反应”）。
  if (agent.status === 'idle') {
    debugLog(dshHome, `session=${sessionId.slice(-8)} replacement=${result.replacementSeq} STILL_IDLE via=${wakeMethod}`)
    return { ok: false, reason: 'KICK_FAILED', detail: 'driver 未能启动（仍是 idle）', backup }
  }

  logInfo(ctx, `edit-resend: rewrote from seq ${atSeq}, shadowed ${result.shadowedRange[0]}..${result.shadowedRange[1]}`)
  debugLog(dshHome, `session=${sessionId.slice(-8)} atSeq=${atSeq} shadowed=${result.shadowedRange[0]}..${result.shadowedRange[1]} replacement=${result.replacementSeq} via=${wakeMethod} status=${agent.status} backup=${backup.ok ? backup.path : backup.reason}`)
  return { ok: true, replacementSeq: result.replacementSeq, shadowedRange: result.shadowedRange, backup }
}

export function apply(ctx) {
  const register = (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => {
        const path = (req.url ?? '').split('?')[0]
        if (path !== `${ROUTE_PREFIX}/rewrite`) {
          writeJson(res, 404, { ok: false, reason: 'NOT_FOUND' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, reason: 'METHOD_NOT_ALLOWED' })
          return
        }
        void (async () => {
          const body = await readJsonBody(req)
          if (body === null) {
            writeJson(res, 400, { ok: false, reason: 'BAD_REQUEST' })
            return
          }
          try {
            const payload = await handleRewrite(ctx, body)
            writeJson(res, payload.ok ? 200 : 409, payload)
          } catch (error) {
            writeJson(res, 500, {
              ok: false,
              reason: 'INTERNAL',
              detail: error instanceof Error ? error.message : String(error),
            })
          }
        })()
      },
    }), 'edit-resend route')
    logInfo(ctx, `dsh-edit-resend: host half mounted (${ROUTE_PREFIX}/rewrite)`)
  }

  if (typeof ctx.get === 'function' && ctx.get('webServer') === undefined) {
    ctx.inject(['webServer'], register)
  } else {
    register(ctx)
  }
}
