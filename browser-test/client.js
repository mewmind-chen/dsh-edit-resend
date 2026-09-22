/**
 * dsh-edit-resend — 浏览器半边。
 *
 * 「修改后再次发送」：把已经发出去的用户消息拿回来改一改，重发一次。
 *
 * 三条路径，按 DSH 现有能力从强到弱选择：
 *  1. 消息**还在队列里**（Agent 忙时发的，尚未被消费）：直接走 DSH 原生
 *     `session.updateQueue(id, {kind:'edit'})` 原地改写，零副作用。
 *  2. 消息**已被消费**（Agent 已经答过）：DSH 的会话日志是只追加的，没有任何
 *     「删掉历史消息」的接口，所以改用「分叉到该消息之前的 seq 边界 + 在新
 *     会话里重发」，表达「这条之后的都作废」。
 *  3. 分叉不可用（例如助手还没答完、没有已完成轮次）：只把文本回填输入框，
 *     提示用户手动发送，不做任何破坏性动作。
 *
 * 全程只用 DOM + 已注册的客户端模块，无构建步骤。
 *
 * @module dsh-edit-resend/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-edit-resend',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    //#region 常量
    const PLUGIN_ID = 'dsh-edit-resend'
    const CSS_TAG = 'dsh-edit-resend/style'
    const Z = 2147483000
    //#endregion

    //#region css
    const css = [
      // 铅笔直接活在原生操作栏里，尺寸/间距/显隐全部交给原生 CSS。
      // 这里只补原生 _action 没覆盖到的部分，样式与它逐项对齐（28/15/圆角/色值）。
      // margin-left 补上原生操作栏的 gap（8px）：原生靠 flex gap 排按钮，
      // 而我们追加的是行内最后一个元素，gap 不会自动作用到它身上。
      `.der_editAction{box-sizing:border-box;width:calc(28px + var(--dsh-content-font-delta,0px));`,
      `height:calc(28px + var(--dsh-content-font-delta,0px));margin-left:8px;`,
      `color:var(--dsw-alias-label-tertiary);flex:none;`,
      `cursor:pointer;background:0 0;border:none;border-radius:28px;padding:6px;`,
      `display:inline-flex;justify-content:center;align-items:center}`,
      `.der_editAction svg{width:calc(15px + var(--dsh-content-font-delta,0px));`,
      `height:calc(15px + var(--dsh-content-font-delta,0px));display:block}`,
      `.der_editAction:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000a);`,
      `color:var(--dsw-alias-label-secondary,#666)}`,
      `.der_editAction:focus-visible{outline:1.5px solid var(--dsw-alias-button-info-fill,#2f6fed);outline-offset:1px}`,
      `.der_layer{position:fixed;inset:0;pointer-events:none;z-index:${Z}}`,
      `.der_editorShell{position:fixed;display:none;box-sizing:border-box;pointer-events:auto;`,
      `background:var(--dsw-specific-input-major,var(--dsw-specific-bubble,#f4f4f4));`,
      `border:1px solid var(--dsw-alias-border-l2,#0000001f);border-radius:18px;padding:12px;`,
      `box-shadow:0 8px 28px #0000001f;color:var(--dsw-alias-label-primary,#171717)}`,
      `.der_editor{display:block;box-sizing:border-box;width:100%;min-height:58px;max-height:min(44vh,360px);`,
      `resize:none;overflow:auto;border:0;outline:0;background:transparent;color:inherit;padding:0;`,
      `font:var(--dsw-font-s-14,400 14px/22px var(--dsw-font-family,system-ui));line-height:22px;white-space:pre-wrap}`,
      `.der_editorFooter{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:10px}`,
      `.der_editorFooter button{border:0;border-radius:16px;padding:5px 12px;cursor:pointer;`,
      `font:500 13px/20px var(--dsw-font-family,system-ui)}`,
      `.der_cancel{background:var(--dsw-alias-button-secondary-fill,#fff);color:var(--dsw-alias-label-primary,#171717)}`,
      `.der_send{background:var(--dsw-alias-button-primary-fill,#181818);color:var(--dsw-alias-button-primary-label,#fff)}`,
      `.der_editorFooter button:disabled{cursor:default;opacity:.45}`,
      `.der_toast{position:fixed;z-index:${Z};left:50%;bottom:150px;transform:translateX(-50%);`,
      `background:var(--dsw-alias-bg-layer-3,#303038);color:var(--dsw-alias-label-primary,#ececf0);`,
      `border:1px solid var(--dsw-alias-border-l2,#3d3d44);border-radius:10px;padding:8px 14px;`,
      `font:12px/18px var(--dsw-font-family,system-ui);box-shadow:0 8px 26px #0000008c;`,
      `pointer-events:none;opacity:0;transition:opacity .18s ease;max-width:min(560px,calc(100vw - 32px))}`,
      `.der_toast.der_show{opacity:1}`,
    ].join('')
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }
    //#endregion

    //#region 状态
    /** 当前待重发的目标：{ host, text, pendingId?, session?, handles, boundarySeq } */
    let target = null
    /** 编辑器专用图层的容器。 */
    let editorLayer = null
    /** 挂在 body 上、覆盖原消息气泡的原位编辑器。 */
    let editorShell = null
    let editor = null
    let sendButton = null
    let toast = null
    let toastTimer = 0
    /** cordis 客户端服务（由 inject 保证在 apply 前就绪）。 */
    let sessionsService = null
    let conversationService = null
    /** 被动观察消息列表，React 重渲染后补回铅笔。 */
    let observer = null
    /** 编辑态的 rAF 句柄：原位编辑器要跟着消息滚动/重排走。 */
    let rafId = 0
    let wired = false
    //#endregion

    //#region 诊断
    /**
     * 诊断输出。
     *
     * 这个功能分支多（队列改写 / 分叉重发 / 降级回填），失败时界面上只有一句
     * toast，拿不到「走了哪个分支、边界算成多少」。所以把关键判定打成一行
     * `[edit-resend]` 日志，便于直接从浏览器控制台定位。
     *
     * @param stage - 阶段名。
     * @param detail - 该阶段的判定数据。
     */
    function diag(stage, detail) {
      if (typeof console === 'undefined') return
      try {
        // 只读的环形记录：控制台里 `__dshEditResendLog` 就能看到完整判定链。
        // 排查「分叉边界/走了哪个分支」时不必靠猜。
        const log = (globalThis.__dshEditResendLog ||= [])
        log.push({ at: new Date().toISOString().slice(11, 23), stage, detail })
        if (log.length > 200) log.splice(0, log.length - 200)
        console.info(`[edit-resend] ${stage}`, detail === undefined ? '' : detail)
      } catch (error) {
        /* 诊断本身不能影响功能 */
      }
    }
    //#endregion

    //#region 小工具
    function showToast(msg, ms = 3200) {
      if (typeof document === 'undefined') return
      if (!toast || !toast.isConnected) {
        toast = document.createElement('div')
        toast.className = 'der_toast'
        document.body.appendChild(toast)
      }
      toast.textContent = msg
      toast.classList.add('der_show')
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => toast.classList.remove('der_show'), ms)
    }

    /** 找输入框：界面最底部那个可见的 contenteditable。 */
    function findComposer() {
      if (typeof document === 'undefined') return null
      const nodes = document.querySelectorAll('[contenteditable="true"]')
      let best = null
      let bestTop = -Infinity
      for (const el of nodes) {
        if (el.closest('.der_layer')) continue
        const rect = el.getBoundingClientRect()
        if (rect.width < 40 || rect.height < 20) continue
        if (rect.top > bestTop) {
          bestTop = rect.top
          best = el
        }
      }
      return best
    }

    /**
     * 把纯文本整段写进输入框（替换其全部内容）。
     *
     * 三个要点，都是被真实浏览器实测逼出来的：
     *
     * 1. **每次写入前重新定位输入框**。DSH 的输入框由 React 渲染，任何状态
     *    更新都可能换掉那个 DOM 节点；缓存下来的引用会变成"写进去但看不见"。
     * 2. 写法沿用已在真实 DSH 上验证可用的 `dsh-select-to-chat`：聚焦 →
     *    光标收到末尾 → 派发 `ClipboardEvent('paste')`（Lexical 的标准入水口）
     *    → 兜底 `execCommand` 逐行插入。
     * 3. **判据只看最终文本对不对**，不看"有没有动过"，也不靠 dispatch 的返回值。
     *    另外本插件是"拿回来改"，所以写入前要先清空（官方那套是往末尾追加）。
     *
     * @param text - 要写入的纯文本。
     * @returns 是否确实写入。
     */
    async function setComposerText(text) {
      const canonical = (value) => String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/\n$/, '')
      const expected = canonical(text)

      /** 当前编辑器里的规范化文本。 */
      const currentText = () => {
        const ed = findComposer()
        return ed === null ? null : canonical(ed.textContent || '')
      }

      /** 轮询等待期望文本出现。 */
      const waitForText = async (rounds = 10) => {
        for (let i = 0; i < rounds; i += 1) {
          await delay(40)
          if (currentText() === expected) return true
        }
        return false
      }

      /** 清空输入框（全选后删，让编辑器感知这次删除）。 */
      const clearComposer = () => {
        const ed = findComposer()
        if (!ed) return
        ed.focus({ preventScroll: true })
        const sel = window.getSelection()
        if (sel) {
          const range = document.createRange()
          range.selectNodeContents(ed)
          sel.removeAllRanges()
          sel.addRange(range)
        }
        try {
          document.execCommand('delete')
        } catch (error) {
          /* 删不掉就靠赋值兜底 */
        }
        if ((ed.textContent || '') !== '') {
          ed.textContent = ''
          try {
            ed.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }))
          } catch (error) {
            /* 老 Chromium 没有可构造的 InputEvent 时，下一层写入仍会接管。 */
          }
        }
      }

      /** 把光标收到编辑器内容末尾。 */
      const collapseToEnd = (ed) => {
        ed.focus({ preventScroll: true })
        const sel = window.getSelection()
        if (!sel) return
        const range = document.createRange()
        range.selectNodeContents(ed)
        range.collapse(false)
        sel.removeAllRanges()
        sel.addRange(range)
      }

      clearComposer()
      await delay(40)
      if (currentText() === expected) return true

      // 1) 标准入水口：paste
      try {
        const ed = findComposer()
        if (ed) {
          collapseToEnd(ed)
          const dt = new DataTransfer()
          dt.setData('text/plain', text + '\n')
          ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
        }
      } catch (error) {
        /* 落到下一级 */
      }
      if (await waitForText()) return true

      // 2) 兜底：逐行 execCommand
      try {
        clearComposer()
        await delay(30)
        const ed = findComposer()
        if (ed) {
          collapseToEnd(ed)
          const lines = text.split('\n')
          for (let i = 0; i < lines.length; i += 1) {
            if (i > 0) document.execCommand('insertParagraph')
            if (lines[i] !== '') document.execCommand('insertText', false, lines[i])
          }
        }
      } catch (error) {
        /* 落到下一级 */
      }
      if (await waitForText()) return true

      // 3) 最后兜底：直接改 DOM 并通知编辑器
      try {
        const ed = findComposer()
        if (ed) {
          ed.textContent = text
          ed.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }))
        }
      } catch (error) {
        return false
      }
      return await waitForText()
    }

    /** 等一小段真实时间（让出渲染帧）。 */
    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    /**
     * 触发一次真实提交：在输入框里按 Enter。
     * DSH 的输入框把 Enter 解释为「发送 / 排队」，与用户手动按完全同一条路径。
     */
    function submitComposer() {
      const ed = findComposer()
      if (!ed) return false
      ed.focus({ preventScroll: true })
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
      })
      // DSH 成功处理 Enter 时本来就会 preventDefault，因此 dispatchEvent()
      // 返回 false 反而可能代表正常提交；只以「找到了输入框且派发完成」为准。
      ed.dispatchEvent(event)
      return true
    }
    //#endregion

    //#region 会话访问（经 React fiber 拿 DSH 自己的会话对象）
    /**
     * 从一条消息的 DOM 节点出发，找到 DSH 自己的会话句柄。
     *
     * 会话句柄挂在 React 组件的 hook 槽位里（useSyncExternalStore 订阅 store
     * 的结果），DOM 上拿不到。所以沿 `__reactFiber$` 向上爬，逐层扫 hook 链，
     * 认「长得像会话」的那个对象。
     *
     * 刻意**不按组件名匹配**：组件名属于 DSH 内部实现，改个名或换层包装就会
     * 失效；按对象形状识别才稳。
     *
     * @param hostNode - 对话区里的任意节点（这里是被悬停的那条消息）。
     * @returns 会话句柄，找不到则 null。
     */
    function inspectConversation(hostNode) {
      const found = {
        session: null,
        sessions: null,
        forkAt: null,
        node: null,
        sessionId: null,
        snapshot: null,
        probe: [],
      }
      const seen = new Set()

      /**
       * 只按能力形状识别，不碰组件名。除了 hook 值，也看 memoizedProps：
       * DSH 0.9.1 的正确边界函数 `forkAt(seq)` 就由 Chat 的 owner props 下传。
       */
      const consider = (value, depth = 0) => {
        if (!value || (typeof value !== 'object' && typeof value !== 'function')) return
        if (seen.has(value)) return
        seen.add(value)
        // 画像：诊断入口会读它，用来回答「会话对象到底扫到没有、长什么样」。
        if (found.probe.length < 40 && typeof value === 'object') {
          const keys = Object.keys(value)
          const interesting = keys.filter((key) => /snapshot|queue|session|fork|prompt|cancel|running/i.test(key))
          if (interesting.length > 0) {
            found.probe.push({
              depth,
              keys: interesting.slice(0, 12),
              hasGetSnapshot: typeof value.getSnapshot === 'function',
              hasUpdateQueue: typeof value.updateQueue === 'function',
              hasFork: typeof value.fork === 'function',
              sessionId: typeof value.sessionId === 'string' ? value.sessionId.slice(0, 24) : undefined,
            })
          }
        }
        if (typeof value === 'object') {
          // 两类都收，但**职责必须分开**：
          //  - session  ：带方法的真句柄（updateQueue + getSnapshot），用于真正调用；
          //  - snapshot ：纯数据快照（{sessionId, queue, running, ...}），用于读队列。
          // 顺序与条件都很关键：快照没有任何方法，若把它当 session 用，
          // 队列改写会在调用 updateQueue 时炸掉，所以 session 只认带方法的。
          if (!found.session && typeof value.updateQueue === 'function' && typeof value.getSnapshot === 'function') {
            found.session = value
          }
          // 真实 DSH 的 UI 持有的正是这份**纯数据快照**。早先只认「带方法的句柄」，
          // 于是永远找不到它、queue 读不到，最新那条被误判成已消费而走了分叉。
          if (!found.snapshot && value.sessionId !== undefined && Array.isArray(value.queue)) {
            found.snapshot = value
            if (!found.sessionId) found.sessionId = value.sessionId
          }
          if (!found.sessions && typeof value.fork === 'function' && (typeof value.open === 'function' || typeof value.binding === 'function')) {
            found.sessions = value
          }
          if (!found.node && (value.kind === 'user' || value.kind === 'steering') && value.data && typeof value.data === 'object') {
            found.node = value
          }
          if (!found.sessionId && typeof value.sessionId === 'string') found.sessionId = value.sessionId
          if (!found.forkAt && typeof value.forkAt === 'function') found.forkAt = value.forkAt
          if (depth < 2) {
            for (const key of ['session', 'sessions', 'value', 'current', 'node', 'owner']) {
              if (key in value) consider(value[key], depth + 1)
            }
          }
        }
      }

      let fiber = fiberOf(hostNode)
      let guard = 0
      while (fiber && guard < 600) {
        guard += 1
        consider(fiber.memoizedProps)
        consider(fiber.pendingProps)
        let hook = fiber.memoizedState
        let hookGuard = 0
        while (hook && hookGuard < 200) {
          hookGuard += 1
          consider(hook.memoizedState)
          hook = hook.next
        }
        fiber = fiber.return
      }

      // 祖先链常常不够：DSH 的会话句柄可能挂在 store 订阅组件、context
      // provider 或整棵渲染树的其它分支上。所以再从渲染根做一次更宽的扫描。
      // 这一步是「拿不到 session → 队列检测失效」那个真实故障的修复点。
      if (!found.session) {
        const renderRoot = rootFiberOf(hostNode)
        scanSubtree(renderRoot, (value) => {
          consider(value)
          return found.session !== null
        }, 6000)
      }
      // 仍然没有：退而从祖先链上的每个 context 依赖里捞（provider 常放这里）。
      if (!found.session) {
        let fiber = fiberOf(hostNode)
        let guard = 0
        while (fiber && guard < 600 && found.session === null) {
          guard += 1
          const dependencies = fiber.dependencies && fiber.dependencies.firstContext
          let context = dependencies
          let contextGuard = 0
          while (context && contextGuard < 60) {
            contextGuard += 1
            consider(context.memoizedValue)
            context = context.next
          }
          if (fiber.return) fiber = fiber.return
          else break
        }
      }
      if (!found.sessionId && found.session && typeof found.session.sessionId === 'string') {
        found.sessionId = found.session.sessionId
      }
      const seq = found.node && found.node.data && Number(found.node.data.seq)
      const anchorSeq = found.node && Number(found.node.anchorSeq)
      found.messageSeq = Number.isFinite(seq) ? seq : Number.isFinite(anchorSeq) ? anchorSeq : null
      return found
    }

    /**
     * 从一条消息节点上取出它的事件 seq。
     * @param node - React fiber 上的对话节点。
     * @returns seq，取不到则 null。
     */
    function messageSeqOf(node) {
      if (!node) return null
      // 按可靠性从高到低试三个位置：DSH 的 chatNode 同时带顶层 anchorSeq 和
      // data（事件数据），不同事件类型把 seq 放在不同层，所以三条都要兜。
      for (const candidate of [node.data && node.data.seq, node.seq, node.anchorSeq]) {
        const value = Number(candidate)
        if (Number.isFinite(value)) return value
      }
      return null
    }

    /** 取一条消息所属的真实 DSH 轮次及其完成边界。 */
    function turnInfoOf(node) {
      const location = node && node.location
      if (!location || (location.kind !== 'turn' && location.kind !== 'step')) return null
      const turn = location.turn
      if (!turn || !Number.isFinite(Number(turn.turn))) return null
      const endSeq = turn.end && Number(turn.end.seq)
      return {
        turn: Number(turn.turn),
        status: turn.status,
        endSeq: Number.isFinite(endSeq) ? endSeq : null,
      }
    }

    /**
     * 找到「被编辑消息所在轮次之前」最后一个已完成轮次的 turn/end seq。
     *
     * 不能拿前一条用户消息的 seq 代替：一轮里可能同时出现 opening user 和
     * steering 消息；真实现场里二者会落在同一个 turn，拿 steering.seq 去 fork
     * 虽然看似在目标消息之前，却可能把目标轮次一起复制进子会话。
     */
    function forkBoundaryBefore(node, prevUserSeq) {
      // 取「被编辑消息**之前**那一轮的 turn/end」作为 fork 锚点。
      //
      // DSH 的 fork 内部是：boundary = 第一个 turn/end >= atSeq，
      // seed = events.slice(0, boundary.seq + 1)。所以锚点落在前一轮里，
      // 被编辑的消息连同它所在整轮都不会进入新会话 —— 这正是
      // 「编辑点及其后的内容都不显示，从这条之前的上下文继续」。
      //
      // 注意 fork 的粒度是**轮次**，做不到「保留前一轮、只去掉这一条」；
      // 同一轮里若既有多条用户消息，它们只能整轮保留或整轮丢弃。
      const targetTurn = turnInfoOf(node)
      if (targetTurn) {
        let boundary = null
        for (const host of userMessageHosts()) {
          const candidate = turnInfoOf(inspectConversation(host).node)
          if (!candidate || candidate.turn >= targetTurn.turn) continue
          if (candidate.status !== 'closed' || !Number.isFinite(candidate.endSeq)) continue
          if (boundary === null || candidate.endSeq > boundary) boundary = candidate.endSeq
        }
        if (Number.isFinite(boundary)) return boundary
      }
      // 兜底：实机里 `node.location.turn` 常是精简引用（status 恒为 open、
      // 没有 end 字段），拿不到 turn/end。这时用「前一条用户消息的 seq」，
      // 它同样落在前一轮里，命中同一个切点。
      return Number.isFinite(prevUserSeq) ? prevUserSeq : null
    }

    /**
     * 收集对话区里所有用户消息的 seq（文档顺序）。
     *
     * 为什么不只用被编辑那条的 seq：DSH 的 `fork({atSeq})` 取的是
     * 「第一个 `turn/end >= atSeq`」作为切点，也就是**包含该 seq 的那一轮**
     * 的结束位置。传被编辑消息自己的 seq，它必然会留在新会话的种子里；
     * 要让「编辑点及其后都不显示」，切点必须落在**它前面那一轮**的 turn/end 上。
     *
     * 而「前一条用户消息的 seq」正好落在前一轮里，用它当锚点就会命中
     * 前一轮的 turn/end —— 这就是这里收集全部 seq 的原因。
     *
     * @returns seq 数组（可能含 null）。
     */
    function collectUserMessageSeqs() {
      return userMessageHosts().map((host) => {
        const info = inspectConversation(host)
        return messageSeqOf(info.node)
      })
    }

    /** 升到渲染树的根 fiber（扫描需要覆盖整棵树时用）。 */
    function rootFiberOf(node) {
      let fiber = fiberOf(node)
      let guard = 0
      while (fiber && fiber.return && guard < 800) {
        guard += 1
        fiber = fiber.return
      }
      return fiber
    }

    /** 取一个 DOM 节点关联的 fiber（React 会给每个节点挂 __reactFiber$）。 */
    function fiberOf(node) {
      if (!node || typeof node !== 'object') return null
      const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$'))
      return key === undefined ? null : node[key]
    }

    /**
     * 广度优先扫一棵 fiber 子树的 hook 链，找第一个符合形状的值。
     * @param start - 起始 fiber。
     * @param accept - 判定函数。
     * @param budget - 最多访问多少个 fiber，防止在大树上卡住。
     * @returns 命中的值，或 null。
     */
    function scanSubtree(start, accept, budget) {
      if (!start) return null
      const queue = [start]
      let visited = 0
      while (queue.length > 0 && visited < budget) {
        const fiber = queue.shift()
        visited += 1
        // 三个来源都要看：
        //  - memoizedProps / pendingProps：DSH 把会话句柄和能力函数（forkAt 等）
        //    作为 props 往下传，真正的 Session 就在这里；
        //  - memoizedState：store 订阅结果（useSyncExternalStore）落在 hook 链；
        //  - _debugOwner / return 链上的 context：部分包装层把值挂在 context 上。
        // 只看 memoizedState 是之前扫不到 session 的原因。
        for (const bag of [fiber.memoizedProps, fiber.pendingProps]) {
          if (bag && typeof bag === 'object') {
            for (const key of Object.keys(bag)) {
              if (accept(bag[key])) return bag[key]
            }
          }
        }
        let hook = fiber.memoizedState
        let hookGuard = 0
        while (hook && hookGuard < 200) {
          hookGuard += 1
          if (accept(hook.memoizedState)) return hook.memoizedState
          hook = hook.next
        }
        if (fiber.child) queue.push(fiber.child)
        if (fiber.sibling) queue.push(fiber.sibling)
      }
      return null
    }

    /**
     * 找当前会话的原生队列桥。
     *
     * DSH 0.9.1 不把可调用的 Session 实例挂在消息祖先链上，但队列 dock
     * 的 props 会稳定暴露 `updateQueue` 和 `session.queue`。这里只按对象形状
     * 识别，不依赖组件名或 CSS module 前缀。
     */
    function collectQueueBridges(sessionId) {
      if (typeof document === 'undefined') return []
      const exact = []
      const active = []
      const fallback = []
      const seen = new Map()

      const add = (props, fromActiveDock = false) => {
        if (!props || typeof props !== 'object' || typeof props.updateQueue !== 'function') return
        const snapshot = props.session
        if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.queue)) return
        // memoizedProps / pendingProps 通常指向同一组值；按函数 + 快照去重，
        // 避免同一个 QueueDock 被当成两个候选而破坏“唯一命中”判定。
        let functions = seen.get(props.updateQueue)
        if (!functions) {
          functions = new Set()
          seen.set(props.updateQueue, functions)
        }
        if (functions.has(snapshot)) return
        functions.add(snapshot)
        const bridge = {
          sessionId: snapshot.sessionId || props.sessionId || null,
          snapshot,
          updateQueue: props.updateQueue,
          fromActiveDock,
        }
        if (sessionId && (snapshot.sessionId === sessionId || props.sessionId === sessionId)) exact.push(bridge)
        else if (fromActiveDock) active.push(bridge)
        else fallback.push(bridge)
      }

      // 优先从「消息行 / 输入框」自身的 fiber 向上找：那个 props.updateQueue
      // 就挂在它们不远的祖先上。原来只从整棵树根往下 BFS（12000 个 fiber），
      // 在大会话里跑不完 2.2s 的预算，导致分叉后找不到本地改写能力而误判
      // 「未能安全替换继承消息」。
      const docks = [...document.querySelectorAll('[data-queue-dock]')]
      for (const anchor of [...docks, findComposer(), ...userMessageHosts()]) {
        if (!anchor) continue
        const fromActiveDock = docks.includes(anchor)
        let fiber = fiberOf(anchor)
        let depth = 0
        while (fiber && depth < 60) {
          for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
            add(props, fromActiveDock)
          }
          fiber = fiber.return
          depth += 1
        }
      }
      const start = rootFiberOf(document.body.firstElementChild)
      if (!start) return [...exact, ...active, ...fallback]
      const queue = [start]
      let visited = 0
      while (queue.length > 0 && visited < 12000) {
        const fiber = queue.shift()
        visited += 1
        for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
          add(props)
        }
        if (fiber.child) queue.push(fiber.child)
        if (fiber.sibling) queue.push(fiber.sibling)
      }
      return [...exact, ...active, ...fallback]
    }

    function findQueueBridge(sessionId) {
      return collectQueueBridges(sessionId)[0] || null
    }
    //#endregion

    //#region 消息识别
    /**
     * 收集对话区里的用户消息宿主节点（从早到晚）。
     *
     * DSH 的 chat 插件渲染用户消息时带这些 className（CSS module 有稳定前缀）：
     * 外层 `…_userRow`（含时间/操作位）→ `…_userStack` → 气泡 `…_bubble`。
     * 选最外层 userRow 作宿主，操作浮层才好贴着整行定位。
     *
     * @returns 宿主节点数组，文档顺序。
     */
    function userMessageHosts() {
      if (typeof document === 'undefined') return []
      const stacks = document.querySelectorAll('[class*="userStack"]')
      const hosts = []
      const seen = new Set()
      for (const stack of stacks) {
        if (stack.closest('.der_layer')) continue
        const host = stack.closest('[class*="userRow"]') || stack
        if (seen.has(host)) continue
        seen.add(host)
        hosts.push(host)
      }
      return hosts
    }

    /**
     * 读一条消息在对话流转中的真实状态。
     *
     * 依据是 DSH 自己在 DOM 上打的标记（实测有效，比扫 React fiber 可靠）：
     *   `data-chat-flow-kind` = "user" | "steering" | …
     *   `data-chat-turn`      = 该消息所属轮次号
     *
     * 其中 `steering` 表示这条消息还在流转（尚未作为 user/message 落地到
     * 会话日志），也就是「Agent 忙的时候发出去、还在队列里」的那种。
     *
     * @param host - 用户消息宿主节点。
     * @returns {{kind: string|null, turn: number|null}}
     */
    function flowInfoOf(host) {
      const flow = host && host.closest ? host.closest('[data-chat-flow-kind]') : null
      const kind = flow === null ? null : flow.getAttribute('data-chat-flow-kind')
      const turnRaw = flow === null ? null : flow.getAttribute('data-chat-turn')
      const turn = Number(turnRaw)
      return { kind, turn: Number.isFinite(turn) ? turn : null }
    }

    /** 读一条用户消息的可见文本。 */
    function messageText(host) {
      const bubble = host.querySelector('[class*="userBubble"],[class*="_bubble"]') || host
      return (bubble.textContent || '').replace(/\u00a0/g, ' ').trim()
    }

    /** 这条消息是否还在队列里（= 尚未被 Agent 消费）。 */
    function pendingItemFor(source, node, text) {
      // source 可能是：带 getSnapshot() 的会话句柄，或本身就是一份会话快照。
      // 真实 DSH 的 UI 持有的是后者（纯数据），所以两种都要认。
      let snapshot = null
      if (source && typeof source.getSnapshot === 'function') {
        try {
          snapshot = source.getSnapshot()
        } catch (error) {
          snapshot = null
        }
      } else if (source && Array.isArray(source.queue)) {
        snapshot = source
      }
      const queue = Array.isArray(snapshot && snapshot.queue) ? snapshot.queue : []
      const queued = queue.filter((item) => item.placement === 'queued')

      // 1) 身份匹配：节点带着 rpcId 时最可靠。
      const rpcId = node && node.data && node.data.source && node.data.source.rpcId
      if (typeof rpcId === 'string') {
        const byIdentity = queued.find((item) => item.rpcId === rpcId)
        if (byIdentity) return byIdentity
      }

      // 2) 文本匹配：**不再要求全等**。
      //    队列项里的文本可能已经是用户上一轮改过的版本（原地改写会把新文本
      //    写回队列项，而它的 rpcId 会变成新的），此时和被编辑气泡的原文不再
      //    相等。全等匹配会因此漏掉，pendingId 变成 null，于是被误判成
      //    「已消费的历史消息」而走分叉——这正是「最新一条不分叉」的原因。
      const needle = text.replace(/\s+/g, ' ').trim()
      if (needle !== '') {
        const same = queued.filter((item) => {
          const itemText = (item.text === null || item.text === undefined ? item.preview || '' : item.text)
            .replace(/\s+/g, ' ')
            .trim()
          if (itemText === '') return false
          return itemText === needle || itemText.includes(needle) || needle.includes(itemText)
        })
        if (same.length === 1) return same[0]
      }

      // 3) 兜底：这条消息在界面上就是最后一条用户消息，且队列里只剩一项未排队
      //    的同类项时，按位置认领，避免「编辑最新一条」这种最常见场景漏判。
      if (queued.length === 1 && isLastUserMessage(node)) return queued[0]
      return null
    }

    /** 队列项的可比较纯文本。 */
    function comparableQueueText(item) {
      return String(item && (item.text === null || item.text === undefined ? item.preview || '' : item.text) || '')
        .replace(/\s+/g, ' ')
        .trim()
    }

    /**
     * fork 后 DSH 会把前一轮结束之后、下一轮开始之前的 inbox splice 一并
     * 放进子会话种子。那一项正是被编辑的旧消息。必须原地 edit 它，不能再
     * 从 composer 提交一次，否则旧消息会先执行，新文本只会排成第二条。
     */
    async function rewriteInheritedForkMessage(current, newText, childSessionId, timeoutMs = 6000) {
      const deadline = Date.now() + timeoutMs
      const oldText = String(current.text || '').replace(/\s+/g, ' ').trim()
      while (Date.now() < deadline) {
        const matches = []
        for (const bridge of collectQueueBridges(childSessionId)) {
          const rows = bridge.snapshot.queue.filter((item) => item && item.placement === 'queued')
          let item = null
          if (current.rpcId) item = rows.find((row) => row.rpcId === current.rpcId) || null
          if (!item) {
            const matches = rows.filter((row) => comparableQueueText(row) === oldText)
            if (matches.length === 1) item = matches[0]
          }
          if (item) matches.push({ bridge, item })
        }
        if (matches.length > 0) {
          // 消息区的 fiber 在切会话后可能短暂保留父会话 sessionId，所以不能把
          // childSessionId 当硬条件。优先顺序是：ID 精确命中 → 当前 DOM 里真实
          // 渲染的 QueueDock → 全树扫描后唯一命中。最后一档只有唯一时才允许写，
          // 避免同时挂载多个会话时误改隐藏会话。
          const selected = matches.find(({ bridge }) => bridge.sessionId === childSessionId)
            || matches.find(({ bridge }) => bridge.fromActiveDock)
            || (matches.length === 1 ? matches[0] : null)
          if (selected) {
            await selected.bridge.updateQueue(selected.item.id, {
              kind: 'edit',
              content: [{ type: 'text', text: newText }],
            })
            diag('fork inherited queue edited', {
              childSessionId,
              bridgeSessionId: selected.bridge.sessionId,
              fromActiveDock: selected.bridge.fromActiveDock,
              itemId: selected.item.id,
              rpcId: selected.item.rpcId || null,
            })
            return true
          }
        }
        await delay(20)
      }
      return false
    }

    /**
     * 新会话里是否还留着那条被继承的原消息。
     *
     * 锚点取「前一轮的 turn/end」时它不该出现；一旦出现就说明切点没落到预期
     * 位置（例如同轮内还有别的用户消息），此时必须停手，不能再提交一次。
     *
     * @param current - 编辑目标（含原文）。
     * @param childSessionId - 子会话 id，仅用于日志。
     * @returns 是否仍存在同名旧消息。
     */
    function checkInheritedMessageStillPresent(current, childSessionId) {
      const oldText = String(current.text || '').replace(/\s+/g, ' ').trim()
      if (oldText === '') return false
      for (const host of userMessageHosts()) {
        // messageText() 已经只取气泡正文。这里必须全等：包含关系会把较短的
        // 历史消息误认成目标（例如“用这个”误中“用这个（再次测试）”），
        // 导致明明已经安全截断却拒绝发送。
        const text = messageText(host).replace(/\s+/g, ' ').trim()
        if (text === oldText) {
          diag('inherited original still visible', { childSessionId, text: text.slice(0, 30) })
          return true
        }
      }
      return false
    }

    /**
     * 这条消息是不是界面上最后一条用户消息。
     * @param node - 被编辑消息的对话节点。
     * @returns 是否是最后一条。
     */
    function isLastUserMessage(node) {
      const hosts = userMessageHosts()
      if (hosts.length === 0) return false
      const last = inspectConversation(hosts[hosts.length - 1])
      return last.node !== null && last.node === node
    }
    //#endregion

    //#region 编辑按钮（直接放进 DSH 原生的消息操作栏）
    /**
     * 找一条用户消息的**原生操作栏**——就是放「复制」按钮的那一行。
     *
     * 结构（dsh-client-ui-chat 的 UserStyleBubble）：
     *   div.userRow
     *     ├─ div.userStack   ← 气泡
     *     └─ div._actions    ← 操作栏（复制 / 分支 / 时间），userRow 的最后一个子元素
     *
     * 操作栏的显隐完全由原生 CSS 负责：`[data-actions-reveal=hover]:hover ._actions`
     * 这类规则在 hover 时把 opacity 从 0 过渡到 1。所以只要把铅笔放进这一行，
     * 它就自动获得正确的尺寸、间距、图标大小、悬停显隐和 80ms 过渡——
     * 不需要我们自己算坐标，也就没有热区漂移导致的闪烁。
     *
     * @param host - 用户消息的 userRow 节点。
     * @returns 操作栏节点，找不到则 null。
     */
    function nativeActionsRow(host) {
      const candidates = host.querySelectorAll('div')
      // 从后往前找：操作栏是最后一个子元素，倒序能更快命中。
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const el = candidates[i]
        const className = typeof el.className === 'string' ? el.className : ''
        if (className.includes('_actions') && el.querySelector('button')) return el
      }
      return null
    }

    /** 造一个和原生操作按钮同款的铅笔按钮。 */
    function createEditButton(host) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'der_editAction'
      button.setAttribute('data-der-edit', '')
      button.setAttribute('aria-label', '编辑')
      button.title = '编辑'
      // 图标沿用原生 15px 的视觉重量，颜色继承原生 _action 的 currentColor。
      button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">'
        + '<path d="M11.3 1.6a1.6 1.6 0 0 1 2.3 0l.8.8a1.6 1.6 0 0 1 0 2.3l-8.1 8.1-3.4.9.9-3.4 7.5-8.7Zm1.5.8a.6.6 0 0 0-.9 0L4.6 10.9l-.4 1.5 1.5-.4 7.3-7.3a.6.6 0 0 0 0-.9l-.8-.8Z"/>'
        + '</svg>'
      // 由插件自己处理点击；不经过 React，所以不需要合成事件。
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const row = button.closest('[class*="userRow"]') || host
        startEdit(row)
      })
      return button
    }

    /**
     * 确保每条用户消息的操作栏里都有铅笔。
     *
     * 幂等：已经插过（或 React 重渲染后又存在）就跳过。
     * 用 MutationObserver 兜底 React 的 reconcile —— 被动观察，不主动改写
     * React 的树，所以不会和它打架。
     */
    function ensureEditButtons() {
      if (typeof document === 'undefined') return
      for (const host of userMessageHosts()) {
        const row = nativeActionsRow(host)
        if (row === null) continue
        if (row.querySelector('[data-der-edit]') !== null) continue
        row.appendChild(createEditButton(host))
      }
    }

    /** 启动对消息列表的被动观察，重渲染后自动补回铅笔。 */
    function startObserving() {
      if (observer !== null) return
      observer = new MutationObserver(() => {
        // 只在有新增节点时补，避免无谓抖动。
        ensureEditButtons()
      })
      observer.observe(document.body, { childList: true, subtree: true })
      ensureEditButtons()
    }

    /** 移除所有已插入的铅笔（卸载时用）。 */
    function removeEditButtons() {
      if (typeof document === 'undefined') return
      for (const button of document.querySelectorAll('[data-der-edit]')) button.remove()
    }
    //#endregion


    //#region 编辑态
    /**
     * 编辑器的专用图层。
     *
     * 编辑器是覆盖在原消息位置上的浮层，不能放进 React 管的 userRow 里
     * （reconcile 会把它清掉）。所以它自己一层，挂在 body 上、fixed 定位。
     * 注意这跟铅笔按钮无关：铅笔活在原生操作栏里，不需要图层。
     */
    function ensureEditorLayer() {
      if (editorLayer && editorLayer.isConnected) return editorLayer
      editorLayer = document.createElement('div')
      editorLayer.className = 'der_layer'
      document.body.appendChild(editorLayer)
      return editorLayer
    }

    function ensureEditor() {
      if (editorShell && editorShell.isConnected) return editorShell
      const layer = ensureEditorLayer()
      editorShell = document.createElement('div')
      editorShell.className = 'der_editorShell'
      editor = document.createElement('textarea')
      editor.className = 'der_editor'
      editor.setAttribute('aria-label', '编辑已发送的消息')
      editor.spellcheck = true
      // Enter 发送、Shift+Enter 换行、Esc 取消。
      // 之前编辑器没绑键盘，只能点「发送」按钮——这与 Codex 的手感不一致。
      editor.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          clearTarget()
          return
        }
        if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
        event.preventDefault()
        if (editor.value.trim() === '') return
        void commit(editor.value)
      })
      editor.addEventListener('input', () => {
        resizeEditor()
        if (sendButton) sendButton.disabled = editor.value.trim() === ''
      })
      const footer = document.createElement('div')
      footer.className = 'der_editorFooter'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'der_cancel'
      cancel.textContent = '取消'
      cancel.addEventListener('click', () => clearTarget())
      sendButton = document.createElement('button')
      sendButton.type = 'button'
      sendButton.className = 'der_send'
      sendButton.textContent = '发送'
      sendButton.addEventListener('click', () => {
        if (!target || !editor || editor.value.trim() === '') return
        void commit(editor.value)
      })
      footer.appendChild(cancel)
      footer.appendChild(sendButton)
      editorShell.appendChild(editor)
      editorShell.appendChild(footer)
      layer.appendChild(editorShell)
      return editorShell
    }

    function resizeEditor() {
      if (!editor) return
      editor.style.height = '0px'
      editor.style.height = `${Math.max(58, Math.min(editor.scrollHeight, Math.round(window.innerHeight * 0.44)))}px`
    }

    /** 编辑器是 body 上的 fixed 浮层，不进入 React 管理的消息 DOM。 */
    function placeEditor(host) {
      if (!editorShell || !target) return
      const bubble = host.querySelector('[class*="userBubble"],[class*="_bubble"]') || host
      const rect = bubble.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return
      const flow = host.closest('[data-chat-flow]')
      const flowRect = flow ? flow.getBoundingClientRect() : null
      const available = Math.max(rect.width, Math.min(flowRect && flowRect.width > 0 ? flowRect.width : 732, window.innerWidth - 32))
      const width = Math.min(Math.max(rect.width, Math.min(available, 732)), window.innerWidth - 24)
      const left = Math.min(Math.max(12, rect.right - width), window.innerWidth - width - 12)
      const top = Math.min(Math.max(8, rect.top), window.innerHeight - Math.min(editorShell.offsetHeight || 140, window.innerHeight - 16) - 8)
      editorShell.style.width = `${width}px`
      editorShell.style.left = `${left}px`
      editorShell.style.top = `${top}px`
      editorShell.style.display = 'block'
    }

    /**
     * 进入编辑态：在原消息位置显示编辑器，并记住要替换哪条消息。
     * @param host - 被点击的用户消息宿主节点。
     */
    function startEdit(host) {
      const text = messageText(host)
      if (text === '') {
        showToast('这条消息没有可用文本，无法重发')
        return
      }
      const handles = inspectConversation(host)
      const session = handles.session
      const queueBridge = findQueueBridge(handles.sessionId)
      const pending = pendingItemFor(handles.snapshot || session || (queueBridge && queueBridge.snapshot), handles.node, text)
      const flow = flowInfoOf(host)
      const messageSeq = messageSeqOf(handles.node)
      // 「还在队列里」的两条判据（任一条成立即算）：
      //  1. flow-kind 是 steering —— DSH 自己标的「流转中」
      //  2. 没有事件 seq —— 还没落地到会话日志
      // 这类消息不能用 fork 处理：它在日志里还不存在，分叉会把**同轮的正常消息**
      // 一起带进子会话，而它自己反而留在原处。
      const inFlight = flow.kind === 'steering' || messageSeq === null
      // 诊断仍保留前一条用户消息 seq，但真正分叉只用前一轮的 turn/end。
      const allHosts = userMessageHosts()
      const index = allHosts.indexOf(host)
      const seqs = collectUserMessageSeqs()
      const prevUserSeq = index > 0 ? seqs[index - 1] : null
      const turn = turnInfoOf(handles.node)
      target = {
        host,
        text,
        pendingId: pending ? pending.id : null,
        session,
        queueUpdate: session && typeof session.updateQueue === 'function'
          ? session.updateQueue.bind(session)
          : queueBridge && queueBridge.updateQueue,
        handles,
        rpcId: handles.node && handles.node.data && handles.node.data.source
          && handles.node.data.source.rpcId,
        messageSeq,
        inFlight,
        flowKind: flow.kind,
        prevUserSeq: Number.isFinite(prevUserSeq) ? prevUserSeq : null,
        turn: turn && turn.turn,
        boundarySeq: forkBoundaryBefore(handles.node, Number.isFinite(prevUserSeq) ? prevUserSeq : null),
        isFirstMessage: index === 0,
      }
      diag('startEdit', {
        index,
        total: allHosts.length,
        seqs,
        messageSeq: target.messageSeq,
        inFlight: target.inFlight,
        flowKind: target.flowKind,
        prevUserSeq: target.prevUserSeq,
        turn: target.turn,
        boundarySeq: target.boundarySeq,
        pendingId: target.pendingId,
        hasQueueBridge: queueBridge !== null,
        hasSession: session !== null,
        hasSessions: !!(handles && handles.sessions),
        hasForkAt: !!(handles && typeof handles.forkAt === 'function'),
        isFirstMessage: target.isFirstMessage,
      })
      ensureEditor()
      editor.value = text
      sendButton.disabled = false
      placeEditor(host)
      resizeEditor()
      editor.focus({ preventScroll: true })
      editor.setSelectionRange(editor.value.length, editor.value.length)
      ensureLoop()
    }

    /**
     * 编辑态的跟随循环。
     *
     * 只做一件事：让原位编辑器贴住那条消息。消息会因为滚动、图片加载、
     * 流式输出而移动，所以这里必须持续跟；编辑态一结束就停，不做无谓轮询。
     */
    function loop() {
      rafId = 0
      if (!target) return
      if (!target.host || !target.host.isConnected) {
        clearTarget()
        return
      }
      placeEditor(target.host)
      rafId = requestAnimationFrame(loop)
    }

    function ensureLoop() {
      if (!rafId) rafId = requestAnimationFrame(loop)
    }

    function clearTarget() {
      target = null
      if (editorShell && editorShell.isConnected) editorShell.style.display = 'none'
      if (editor) editor.value = ''
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
    }
    //#endregion

    //#region 提交拦截
    /**
     * 用户按下发送时：如果处于编辑态，先处理「替换」语义再放行。
     * - 队列中的消息：只调用原生 edit 改掉它，不再提交一次。
     * - 已消费的消息：先 fork 出新会话再发送（异步，因此拦截这次提交）。
     */
    function onCaptureKeyDown(event) {
      if (event.key === 'Enter' && target === null) {
        // 没进编辑态却在别的输入处敲了 Enter —— 记一笔便于对照现场。
        diag('keydown-no-target', { targetPath: typeof event.composedPath === 'function' ? 'yes' : 'no' })
      }
      if (event.key === 'Escape' && target && editor && event.target === editor) {
        event.preventDefault()
        event.stopImmediatePropagation()
        event.stopPropagation()
        clearTarget()
        return
      }
      if (event.key !== 'Enter') return
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
      if (!target) return
      if (!editor || event.target !== editor) return
      if (event.isComposing || event.keyCode === 229) return
      const newText = editor.value
      if (newText.trim() === '') return
      // 关键：**必须** stopImmediatePropagation。
      // DSH 的输入框由 React/Lexical 管，它们的事件委托监听器注册得比本插件早
      // （插件是页面起来之后才加载的），在同一节点上按注册顺序排在前面。
      // 只 preventDefault 拦不住已经排进队列的监听器——实测 Enter 仍会被提交一次；
      // stopImmediatePropagation 掐断同节点后续监听器，才是真正的拦截。
      event.preventDefault()
      event.stopImmediatePropagation()
      event.stopPropagation()
      void commit(newText)
    }

    /** 当前对话视图对应的 sessionId（从当前仍挂载的消息 fiber 读取）。 */
    function activeConversationSessionId() {
      for (const host of userMessageHosts()) {
        const sessionId = inspectConversation(host).sessionId
        if (typeof sessionId === 'string' && sessionId !== '') return sessionId
      }
      return null
    }

    /**
     * 等到 DSH 真正打开 fork 出来的子会话。
     *
     * 不能只看 DOM 节点或 composer 有没有被 React 换掉：关闭原位编辑器时，
     * 原会话也可能先 reconcile 一次，从而产生“已经切换”的假象。真实 DSH 的
     * `forkAt` 还是 fire-and-forget（不返回 Promise），所以必须以 sessionId 改变
     * 作为强判据，否则修改后的文本会抢先提交到父会话，再被 fork 一并复制过去。
     */
    async function waitForForkTransition(oldSessionId, oldHost, oldComposer, strictSessionChange = false, timeoutMs = 12000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        // 子会话会立即尝试消费继承队列；用短轮询尽快接管那一项。
        await delay(20)
        const activeSessionId = activeConversationSessionId()
        if (oldSessionId && activeSessionId && activeSessionId !== oldSessionId) return true
        // fire-and-forget 的 forkAt 必须等 sessionId 真正改变；能够 await 的
        // sessions.fork/open 路径则仍可用 DOM 切换作兼容判据。
        if (oldSessionId && strictSessionChange) continue
        const currentComposer = findComposer()
        if (!oldHost.isConnected || (currentComposer && currentComposer !== oldComposer)) return true
      }
      return false
    }

    /**
     * 从「这条消息之前的那一轮」开新会话，并切换过去。
     *
     * 边界怎么选（这是这个功能的正确性核心）：
     * DSH 的 `fork({atSeq})` 内部是
     *     boundary = events.find(e => e.type === 'turn/end' && e.seq >= atSeq)
     *     cut      = boundary.seq + 1
     *     while (events[cut]?.type !== 'turn/start') cut++
     *     seed     = events.slice(0, cut)
     * 即切点是「包含 atSeq 的那一轮结束后、下一轮开始前」。因此前一轮之后
     * 已经入 inbox 的目标消息也会进入 seed，子会话打开后还要原地改写该队列项。
     *
     * 所以：
     *  - 传这条消息自己的 seq → 命中的是**它所在轮次**的 turn/end，
     *    它自己会留在种子里（旧行为，编辑后旧消息仍然显示）。
     *  - 传**前一轮精确的 turn/end seq** → 种子到前一轮为止，被编辑的消息
     *    及其后的助手回复、工具调用全部不在种子里。
     *
     * 第一轮前面没有已完成轮次；拿不到精确边界时一律降级回填，不猜边界。
     *
     * @param current - 当前编辑目标。
     * @returns 是否成功分叉。
     */
    async function forkBefore(current) {
      // 边界优先用 forkBoundaryBefore 的结果（按 turn 精确找前一轮的 turn/end）；
      // 它拿不到时那里已回退成「前一条用户消息的 seq」，语义一致。
      const atSeq = current.boundarySeq
      if (!Number.isFinite(atSeq)) {
        throw new Error(current.isFirstMessage ? 'FIRST_MESSAGE' : 'BOUNDARY_UNAVAILABLE')
      }
      const sessionId = current.handles && current.handles.sessionId

      // 首选：显式注入的 sessions 服务（fork + open 一步到位）。
      if (sessionsService !== null && typeof sessionsService.fork === 'function' && sessionId) {
        const result = await sessionsService.fork({ sessionId, atSeq, increaseTitle: true })
        const childId = unwrapSessionId(result)
        if (childId !== null && typeof sessionsService.open === 'function') await sessionsService.open(childId)
        return true
      }
      // 次选：Chat owner 下传的 forkAt（内部已封装 fork + open）。
      if (current.handles && typeof current.handles.forkAt === 'function') {
        await current.handles.forkAt(atSeq)
        return true
      }
      // 兜底：会话对象自己的 fork。
      if (current.session && typeof current.session.fork === 'function') {
        await current.session.fork({ atSeq, increaseTitle: true })
        return true
      }
      return false
    }

    /** 从会话接口的返回值里取出子会话 id（不同层返回形状不同）。 */
    function unwrapSessionId(result) {
      if (typeof result === 'string') return result
      if (result && typeof result === 'object') {
        if (typeof result.sessionId === 'string') return result.sessionId
        if (result.value && typeof result.value.sessionId === 'string') return result.value.sessionId
      }
      return null
    }

    /**
     * 编辑会话的**第一条**消息：新建一个空上下文会话，只发送修改后的内容。
     *
     * 这是 Codex 语义里的一种特例——前面没有任何可保留的上下文，
     * 所以不是「分叉」，而是「开一个干净会话重新开始」。
     *
     * @returns 是否成功新建并打开。
     */
    async function createFreshSession() {
      if (sessionsService === null || typeof sessionsService.create !== 'function') return false
      let result
      try {
        result = await sessionsService.create({})
      } catch (error) {
        diag('createFreshSession threw', { message: error && error.message })
        return false
      }
      const childId = unwrapSessionId(result)
      if (childId === null) {
        diag('createFreshSession no id', { result: result && typeof result === 'object' ? Object.keys(result) : typeof result })
        return false
      }
      if (typeof sessionsService.open === 'function') await sessionsService.open(childId)
      diag('createFreshSession ok', { childId })
      return true
    }

    async function commit(newText) {
      const current = target
      diag('commit', { hasTarget: current !== null, newText: newText.slice(0, 40) })
      if (!current) return
      const oldComposer = findComposer()
      clearTarget()

      // 路径 0：这条消息还在流转（steering / 尚未落地）。
      // 它不能走分叉——日志里还没有它，分叉只会把同轮的其它消息带走。
      if (current.inFlight) {
        if (current.pendingId && current.queueUpdate) {
          diag('commit', { branch: 'queue-edit', pendingId: current.pendingId })
          // 有队列句柄：走 DSH 原生的原地改写。
        } else {
          diag('commit', { branch: 'in-flight-refused', flowKind: current.flowKind, hasQueueUpdate: !!current.queueUpdate })
          await setComposerText(newText)
          showToast('这条消息还在处理中（尚未落地到会话），暂时不能编辑重发；等它落地后再试')
          return
        }
      }

      if (current.pendingId) {
        diag('commit', { branch: 'queue-edit', pendingId: current.pendingId })
        try {
          await current.queueUpdate(current.pendingId, {
            kind: 'edit',
            content: [{ type: 'text', text: newText }],
          })
        } catch (error) {
          showToast(`改写队列消息失败：${error && error.message ? error.message : String(error)}`)
          return
        }
        showToast('已原地更新队列中的消息')
        return
      }

      // 路径 2：已被消费的历史消息 → 分叉后重发。
      diag('commit', {
        branch: 'fork',
        turn: current.turn,
        boundarySeq: current.boundarySeq,
        isFirstMessage: current.isFirstMessage,
      })
      diag('fork atSeq', {
        boundarySeq: current.boundarySeq,
        messageSeq: current.messageSeq,
        turn: current.turn,
        isFirstMessage: current.isFirstMessage,
      })
      let forked = false
      try {
        forked = await forkBefore(current)
      } catch (error) {
        diag('fork threw', { message: error && error.message })
        if (error && error.message === 'FIRST_MESSAGE') {
          // 第一条消息：前面没有可保留的上下文，按 Codex 语义开一个
          // 干净的空会话，只发送修改后的内容。
          const created = await createFreshSession()
          if (created) {
            await resendToActiveSession(current, newText, oldComposer, { freshSession: true })
            return
          }
        }
        await setComposerText(newText)
        const reason = error && error.message === 'FIRST_MESSAGE'
          ? '这是会话的第一条消息，且无法新建会话'
          : error && error.message === 'BOUNDARY_UNAVAILABLE'
            ? '拿不到被编辑消息之前的精确轮次边界'
            : `分叉失败：${error && error.message ? error.message : String(error)}`
        showToast(`${reason}；文本已放回输入框，请手动发送`)
        return
      }
      if (!forked) {
        await setComposerText(newText)
        showToast('无法自动分叉，文本已放回底部输入框，请手动发送')
        return
      }
      diag('fork ok', { next: 'resend in child' })
      showToast('已从这条消息之前分叉，正在发送修改后的内容…')
      await resendToActiveSession(current, newText, oldComposer, { freshSession: false })
    }

    /**
     * 把修改后的内容发到「当前活跃会话」。
     *
     * 分叉和新建会话两条路径共用这里，区别只在 freshSession：
     *  - 分叉出的子会话会继承历史，必须检查被编辑的消息是否也跟着进来了；
     *    如果进来了且改写失败，就**停手**，避免旧会话提交一次、新会话又提交一次。
     *  - 新建的空会话没有继承项，不需要这些检查。
     *
     * @param current - 编辑目标。
     * @param newText - 修改后的文本。
     * @param oldComposer - 切换前的输入框（用于判断是否已经换到新会话）。
     * @param options.freshSession - 是否是新建的空会话。
     */
    async function resendToActiveSession(current, newText, oldComposer, options) {
      const freshSession = options && options.freshSession === true
      if (!freshSession) {
        const transitioned = await waitForForkTransition(
          current.handles && current.handles.sessionId,
          current.host,
          oldComposer,
          !!(current.handles
            && !current.handles.sessions
            && typeof current.handles.forkAt === 'function'),
        )
        if (!transitioned) {
          await setComposerText(newText)
          showToast('未检测到新会话；文本已放回底部输入框，请确认后手动发送')
          return
        }
        const childSessionId = activeConversationSessionId()
        let inheritedRewritten = false
        try {
          inheritedRewritten = childSessionId
            ? await rewriteInheritedForkMessage(current, newText, childSessionId)
            : false
        } catch (error) {
          diag('fork inherited queue edit failed', { message: error && error.message })
        }
        if (inheritedRewritten) {
          showToast('已在新会话发送修改后的内容')
          return
        }
        // 锚点取的是「前一轮的 turn/end」，正常情况下被编辑的消息**不会**进入
        // 新会话，因此也不存在需要改写的继承项。只有确实发现「继承项还在、但
        // 改写失败」时才必须停手，避免重复提交。
        if (checkInheritedMessageStillPresent(current, childSessionId)) {
          diag('inherited message still present; refusing to double-submit')
          await setComposerText(newText)
          showToast('新会话仍带着继承的原消息，为避免重复提交，文本已放回输入框')
          return
        }
      }
      // 作为新会话里的全新一条发出——进入新会话的提交只发生这一次。
      if (!(await setComposerText(newText))) {
        showToast('新会话里没找到输入框，请手动粘贴发送')
        return
      }
      await delay(80)
      if (!submitComposer()) showToast('请在新会话输入框里按 Enter 发送')
      else diag('resent once in active session', { freshSession })
    }
    //#endregion

    //#region 插件体
    /**
     * 依赖的客户端服务。
     * sessions：分叉 / 新建会话 / 打开子会话。
     * conversation：队列消息的原地改写。
     * 两者都缺时插件仍能工作，只是会走「只回填 + 提示」的降级路径。
     */
    const inject = ['sessions', 'conversation']

    /**
     * 挂载 DOM 监听。
     * @param ctx - 客户端根上下文（可用 ctx.effect 注册清理）。
     */
    function apply(ctx) {
      if (wired || typeof document === 'undefined') return
      wired = true
      // 这两个服务才是「回到该消息重新走一遍」的正确入口：
      //   sessions.fork({sessionId, atSeq}) / sessions.create() / sessions.open(id)
      //   conversation.updateQueue(itemId, action)  ← 队列消息原地改写
      // 以前靠扫 React fiber 找会话对象，实测在真实环境里拿不到（会话对象藏在
      // cordis 闭包里，不在任何 props/hook 上），所以改为显式依赖注入。
      sessionsService = (ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null) || null
      conversationService = (ctx && typeof ctx.get === 'function' ? ctx.get('conversation') : null) || null
      diag('services', {
        sessions: sessionsService !== null,
        conversation: conversationService !== null,
        sessionsMethods: sessionsService === null ? null : ['fork','create','open','get','scope'].filter((m) => typeof sessionsService[m] === 'function'),
        conversationMethods: conversationService === null ? null : ['updateQueue','send','sendSession','fork'].filter((m) => typeof conversationService[m] === 'function'),
      })
      // Enter 拦截必须留在 capture 阶段且带 stopImmediatePropagation（见下方注释）。
      document.addEventListener('keydown', onCaptureKeyDown, true)
      // 铅笔靠原生操作栏的 CSS 显隐，这里只需要保证它被插进去、并在
      // React 重渲染把它清掉后补回来。
      startObserving()
      const dispose = () => {
        document.removeEventListener('keydown', onCaptureKeyDown, true)
        if (observer !== null) {
          observer.disconnect()
          observer = null
        }
        removeEditButtons()
        clearTarget()
        if (editorShell) editorShell.remove()
        editorShell = null
        if (editorLayer) editorLayer.remove()
        editorLayer = null
        editor = null
        sendButton = null
        if (toast) toast.remove()
        wired = false
      }
      if (ctx && typeof ctx.effect === 'function') ctx.effect(() => dispose, 'edit-resend: dom wiring')
      // 诊断入口：控制台里执行 __dshEditResend() 就能看到每条消息的
      // seq / 前一条 seq / 是否在队列里 / 拿到了哪些会话能力。
      // 排查「分叉边界不对」时，这一条命令就够了。
      try {
        globalThis.__dshEditResend = () => {
          const rows = userMessageHosts().map((host, index) => {
            const info = inspectConversation(host)
            const seq = messageSeqOf(info.node)
            const turn = turnInfoOf(info.node)
            const flow = flowInfoOf(host)
            return {
              index,
              seq,
              turn: turn && turn.turn,
              turnEndSeq: turn && turn.endSeq,
              boundarySeq: forkBoundaryBefore(info.node),
              flowKind: flow.kind,
              还在流转: flow.kind === 'steering' || seq === null,
              text: messageText(host).slice(0, 24),
              hasSession: info.session !== null,
              hasSnapshot: info.snapshot !== null,
              boundarySeq: forkBoundaryBefore(info.node, null),
              turnStatus: (() => {
                const turn = turnInfoOf(info.node)
                return turn ? turn.status : null
              })(),
              turnEndSeq: (() => {
                const turn = turnInfoOf(info.node)
                return turn ? turn.endSeq : null
              })(),
              hasSessions: !!(info.sessions),
              hasForkAt: typeof info.forkAt === 'function',
              sessionId: info.sessionId,
            }
          })
          const seqs = rows.map((row) => row.seq)
          const firstHost = userMessageHosts()[0]
          const probe = firstHost ? inspectConversation(firstHost).probe : []
          const report = {
            rows,
            probe,
            seqs,
            锚点对照: rows.map((row, index) => ({
              第几条: index + 1,
              它自己的seq: row.seq,
              所属轮次: row.turn,
              将被用作锚点的前一轮结束seq: row.boundarySeq,
            })),
            队列: (() => {
              const info = rows.length > 0 ? inspectConversation(userMessageHosts()[0]) : null
              const snapshot = info && info.session ? info.session.getSnapshot() : null
              return snapshot && Array.isArray(snapshot.queue)
                ? snapshot.queue.map((item) => ({ id: item.id, rpcId: item.rpcId, placement: item.placement, text: (item.text || item.preview || '').slice(0, 24) }))
                : null
            })(),
          }
          console.table(report.rows)
          console.info('[edit-resend] 完整诊断', report)
          return report
        }
      } catch (error) {
        /* 诊断入口失败不影响功能 */
      }
      if (typeof console !== 'undefined') console.debug('[dsh-edit-resend] ready — 控制台执行 __dshEditResend() 可查看诊断')
    }
    //#endregion

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
