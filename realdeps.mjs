/**
 * 真依赖回归：用 DSH 本体的 dsh-session + dsh-llm（非 mock），验证
 * handleRewriteSync 在真实 surface 语义下：
 *  1. 改中间一条 → 它及之后全被盖掉，deriveMessages 只剩前文 + 新文本
 *  2. 改第一条 → 整个 surface 只剩新文本
 *  3. 同一行连改两次（第二次 atSeq=第一次的 replacementSeq）→ 仍然精确盖住
 *  4. atSeq 已不在 surface 上 → 明确拒绝，不静默盖错
 *
 * 用法：node realdeps.mjs
 * 依赖：node_modules/@deepseek-ai/{dsh-llm,dsh-session} 软链到桌面端本体。
 */

import { Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { handleRewriteSync, surfaceSeqs } from './lib/index.js'

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

function userText(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function asstText(text) {
  return {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'test', model: 'test' },
    }),
  }
}

/** 搭一个两轮对话：user(A) asst(a) user(B) asst(b)，返回各事件 seq。 */
function buildTwoTurns() {
  const session = new Session('test-session', [], undefined, 'snapshot')
  const seqA = session.append('user/message', userText('第一条'), { surfaceOp: 'append' }).seq
  const seqReplyA = session.append(
    'assistant/message',
    asstText('回复一'),
    { surfaceOp: 'append' },
  ).seq
  const seqB = session.append('user/message', userText('第二条'), { surfaceOp: 'append' }).seq
  const seqReplyB = session.append(
    'assistant/message',
    asstText('回复二'),
    { surfaceOp: 'append' },
  ).seq
  return { session, seqA, seqReplyA, seqB, seqReplyB }
}

/** surface 上模型将看到的文本（按顺序）。 */
function surfaceTexts(session) {
  return session.deriveMessages().map((message) => {
    const content = Array.isArray(message.content) ? message.content : []
    return content.filter((block) => block.type === 'text').map((block) => block.text).join('')
  })
}

//#region 1. 改中间第一条
{
  const { session, seqA, seqB } = buildTwoTurns()
  const result = handleRewriteSync(session, seqA, '第一条：改过')
  check('改第一条成功', result.ok === true, JSON.stringify(result))
  check('范围从被编辑处盖到 surface 末尾',
    result.shadowedRange[0] === seqA && result.shadowedRange[1] === seqB + 1,
    JSON.stringify(result.shadowedRange))
  check('模型只看到新文本', JSON.stringify(surfaceTexts(session)) === JSON.stringify(['第一条：改过']),
    JSON.stringify(surfaceTexts(session)))
}
//#endregion

//#region 2. 改最后一条
{
  const { session, seqB } = buildTwoTurns()
  const result = handleRewriteSync(session, seqB, '第二条：改过')
  check('改第二条成功', result.ok === true, JSON.stringify(result))
  check('前文保留、新文本接在最后',
    JSON.stringify(surfaceTexts(session)) === JSON.stringify(['第一条', '回复一', '第二条：改过']),
    JSON.stringify(surfaceTexts(session)))
}
//#endregion

//#region 3. 同一行连改两次
{
  const { session, seqA, seqReplyA, seqB } = buildTwoTurns()
  const first = handleRewriteSync(session, seqB, '第二条：改过一次')
  check('第一次改写成功', first.ok === true, JSON.stringify(first))
  const second = handleRewriteSync(session, first.replacementSeq, '第二条：改过两次')
  check('第二次改写成功', second.ok === true, JSON.stringify(second))
  check('两次后模型只看到最新文本',
    JSON.stringify(surfaceTexts(session)) === JSON.stringify(['第一条', '回复一', '第二条：改过两次']),
    JSON.stringify(surfaceTexts(session)))
  check('surface 只剩前文两节点 + 最新替换',
    JSON.stringify(surfaceSeqs(session)) === JSON.stringify([seqA, seqReplyA, second.replacementSeq]),
    JSON.stringify(surfaceSeqs(session)))
}
//#endregion

//#region 4. 已被盖掉的 seq 拒绝
{
  const { session, seqB } = buildTwoTurns()
  handleRewriteSync(session, seqB, '第二条：改过')
  const retry = handleRewriteSync(session, seqB, '第二条：再改')
  check('旧 seq 明确拒绝', retry.ok === false, JSON.stringify(retry))
}
//#endregion

//#region 5. 范围外现存快照被 cite（下一轮必跑）
{
  const session = new Session('test-session-snap', [], undefined, 'snapshot')
  const seqA = session.append('user/message', userText('第一条'), { surfaceOp: 'append' }).seq
  const snapSeq = session.append('user/message', {
    content: [{ type: 'text', text: 'Current runtime context. snapshot' }],
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
  }, { surfaceOp: 'append' }).seq
  const seqB = session.append('user/message', userText('第二条'), { surfaceOp: 'append' }).seq
  const result = handleRewriteSync(session, seqB, '第二条：改过')
  check('改写成功', result.ok === true, JSON.stringify(result))
  const replacement = session.eventAt(result.replacementSeq)
  check('快照 seq 被 cite 进 provenance',
    Array.isArray(replacement.sourceEventSeqs) && replacement.sourceEventSeqs.includes(snapSeq),
    JSON.stringify(replacement.sourceEventSeqs))
  check('范围没动（只盖被编辑处到末尾）',
    result.shadowedRange[0] === seqB && result.shadowedRange[1] === seqB,
    JSON.stringify(result.shadowedRange))
  check('快照仍在 surface 上（没被多盖）',
    surfaceSeqs(session).includes(snapSeq), JSON.stringify(surfaceSeqs(session)))
  check('模型看到前文 + 快照 + 新文本',
    JSON.stringify(surfaceTexts(session)) === JSON.stringify(['第一条', 'Current runtime context. snapshot', '第二条：改过']),
    JSON.stringify(surfaceTexts(session)))
}
//#endregion

console.log('dsh-edit-resend 真依赖回归')
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
