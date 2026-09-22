# dsh-edit-resend — 插件文档

> 编辑一条已发送的用户消息，**就地**把它改成新内容，它之后的一切作废，
> AI 基于新内容重新回答。会话始终是同一个。

---

## 1. 插件位置

### 源码（唯一维护点）

```
/Users/ylf/Desktop/projects/dsh/edit-resend
```

### 安装位置（两个独立 DSH 实例）

| 实例 | 插件目录 | 说明 |
| --- | --- | --- |
| 桌面端内置（端口 `43129`，公网 `me.newmindchen.com`） | `~/Library/Application Support/dsh-desktop/harness/profiles/web/node_modules/dsh-edit-resend/` | 主要使用 |
| 独立 `dsh web`（端口 `3090`） | `~/.dsh/profiles/web/node_modules/dsh-edit-resend/` | 备用 |

> 两处都是**文件副本**（非软链接），改完源码必须同步过去：
> ```bash
> cd /Users/ylf/Desktop/projects/dsh/edit-resend
> for p in \
>   "$HOME/Library/Application Support/dsh-desktop/harness/profiles/web/node_modules/dsh-edit-resend" \
>   "$HOME/.dsh/profiles/web/node_modules/dsh-edit-resend"; do
>   [ -d "$p" ] && cp lib/client.js lib/index.js "$p/lib/"
> done
> ```

### 运行时产物位置

| 内容 | 位置 |
| --- | --- |
| 改写前的日志备份 | `~/Library/Application Support/dsh-desktop/harness/edit-resend-backups/` |
| 客户端诊断记录 | 浏览器控制台 `__dshEditResendLog`（最近 200 条） |
| 主机侧日志 | `~/Library/Logs/DSH Desktop/harness.log`（搜 `edit-resend` / `host half mounted`） |

---

## 2. 代码结构

```
edit-resend/
├── lib/
│   ├── client.js     浏览器半边（手写 __ModuleLoader__ bundle，无构建步骤）
│   └── index.js      主机半边（HTTP 端点 + surface replace + 备份）
├── cordis.patch.yml  loader 条目：把插件挂进插件树
├── package.json      包声明（dsh.bundle.patch / dsh.client.inject）
├── smoke.mjs         离线回归（mock DOM，51 项）
├── browser-test/     真实浏览器测试（真 React + CDP）
│   ├── index.html        测试页（复刻 DSH 的消息结构）
│   ├── cdp-test.mjs      CDP 驱动的端到端用例
│   ├── open-gui.mjs      用启动 token 登录真实 GUI
│   ├── diagnose-gui.mjs  在真实页面跑插件诊断
│   └── probe-session.mjs 探测会话/message 的 DOM 与 fiber 形状
└── README.md         使用 / 安装 / 禁用
```

> 规模：`lib/client.js` ≈ 1740 行，`lib/index.js` ≈ 300 行。

### 2.1 客户端半边（`lib/client.js`）

| 区域 | 职责 |
| --- | --- |
| `ensureEditButtons()` | 把铅笔按钮**插进 DSH 原生消息操作栏**（复制按钮那一行） |
| `MutationObserver` | 被动观察消息列表，React 重渲染后补回铅笔 |
| `startEdit()` | 进入编辑态：在原消息位置显示编辑器 |
| `rewriteInPlace()` | **发起改写**：`POST /edit-resend/rewrite`，带 `{sessionId, atSeq, text}` |
| `onCaptureKeyDown()` | capture 阶段拦 Enter（必须 `stopImmediatePropagation`） |
| `diag()` | 诊断记录，写入 `__dshEditResendLog` |

**为什么铅笔插进原生操作栏**（而不是自己画浮层）：
早期版本用「自己算坐标的浮层 + 鼠标热区」，会持续闪烁。根因是**反馈循环**——
位置锚定在原生复制按钮的实时 `getBoundingClientRect()` 上，而那个操作栏自带
80ms 显隐过渡，它的 rect 一变，铅笔就位移，热区跟着挪走，鼠标掉出热区 →
按钮隐藏 → 热区回位 → 又命中，自激。插进原生操作栏后，位置固定、显隐交给
原生 CSS，循环的前提消失。

### 2.2 主机半边（`lib/index.js`）

| 区域 | 职责 |
| --- | --- |
| `apply()` | 注册 HTTP 路由 `POST /edit-resend/rewrite` |
| `handleRewrite()` | 校验参数 → 查会话 → 判空闲 → 备份 → 改写 → 唤醒 |
| `rewriteFrom()` | 计算替换范围（这条消息 → surface 末尾） |
| `appendReplacement()` | `session.append('user/message', msg, { surfaceOp, sourceEventSeqs })` |
| `backupSessionLog()` | 改前把会话日志复制到 `edit-resend-backups/` |

**核心机制：surface replace**

DSH 的会话日志只追加、没有"删除历史"的接口，但内部有 surface replace
（compaction 与 tool-result-pruner 用的就是它）：

```js
boundary = 第一个 turn/end >= atSeq      // fork 的切点
session.append('user/message', newMessage, {
  surfaceOp: { op: 'replace', startSeq, endSeq },   // 盖掉这段
  sourceEventSeqs: [...被盖住的全部节点],            // 必需，否则一致性校验拒绝
})
```

被盖掉的节点仍在日志里（可回滚），但**模型可见的 surface 上不再有它们**。

---

## 3. 功能规格

| # | 规则 |
| --- | --- |
| 1 | **就地改写**：不新建会话、不分叉、不切换页面 |
| 2 | **保留前文**：被编辑消息之前的内容原样保留 |
| 3 | **其后清空**：原助手回复、工具调用、后续消息全部不再显示 |
| 4 | **改写什么就是什么**：不出现 `/rewind` 之类的包装 |
| 5 | **跟第几条无关**：任意位置的消息行为一致 |
| 6 | **只在空闲时**：Agent 正在回答时拒绝，等这轮结束 |
| 7 | **只提交一次**：不会旧一次、新一次 |
| 8 | **失败不擅自发送**：回填输入框 + 说明原因 |

### 边界

- **会话第一条** → 同样就地改写（结果是整个会话从这条重新开始），**不新建会话**
- **排队中的消息** → 改队列里那条（走 DSH 原生 `updateQueue`）
- **改前自动备份**日志，出问题能还原

---

## 4. 修改日志

### 2026-09-21 初版

- 浮层按钮 + 鼠标坐标热区 → **持续闪烁**（反馈循环，见 2.1）
- 改为注入原生操作栏；尺寸跟随复制按钮；提示文案「编辑」

### 分叉边界（三处连错）

1. `fork({atSeq})` 的切点是「第一个 `turn/end >= atSeq`」，穿 `seq - 1` 命中的是
   **包含该消息那一轮**的结束点 → 消息仍留在种子里
   → 改为锚定**前一轮的 `turn/end`**
2. `forkBefore()` 读了一个已改名的字段（`boundarySeq`），`atSeq` 恒为 `undefined`
   → 直接抛错降级 → **表现为"像直接把新消息发出去"**
3. `forkBoundaryBefore()` 要求 `candidate.status === 'closed'`。真机上该状态字符串
   不叫这个名字 → 跳过全部候选 → 边界恒为 null → 每次编辑都降级
   → 改为「只要有 `turn/end` 就用它」

### 会话对象拿不到（关键转折）

诊断显示 `hasSession: false`、`hasSessions: false`。扫了 **5184 个 React fiber**
都找不到会话对象——它在 cordis 闭包里，不在任何 props/hook 上。

→ 改为声明依赖 + 运行时取：
```js
sessionsService = ctx.get('sessions')
conversationService = ctx.get('conversation')
```
真机验证拿到 `fork / create / open / scope` 与 `updateQueue / send / sendSession`。

### 判定误判（两处）

1. `pendingItemFor()` 用**包含**关系匹配队列项
   （`itemText.includes(needle)`）。编辑常常是把长文本删短，短文本必然被队列里的
   长文本包含 → **历史消息被误认成队列消息** → 走原地改写、不分叉
   → 收紧为「身份（rpcId）或规范化后全等」
2. `isFirstMessage: index === 0` 用 **DOM 位置**判断。消息虚拟化 / steering 消息
   类名不同时宿主收集不全，`indexOf` 返回 0 或 -1 → 中间那条被判成第一条
   → 最终**整个"第一条"特判被删除**（改写本就与第几条无关）

### 需求修正（用户明确）

- ~~编辑第一条 → 新建空上下文会话~~ → **什么情况都不新建会话**
- ~~排队中也允许编辑~~ → **只在会话结束后才能改写**
- ~~分叉出新会话~~ → **就在原会话里把后面抹掉，不换会话**

### 通道方案（命令 → HTTP）

第一版用主机命令 `/rewind` 作为「客户端 → 主机」的通道，失败两次：

1. `inject: ['commands', 'agents']` —— cordis 的规矩是**声明的服务只要有一个
   解析不到，插件就停在等待态，`apply()` 永不执行**。日志里 `host half mounted`
   出现 0 次，`/rewind` 从未注册 → 用户输入的 `/rewind` 被当成普通消息发给模型，
   模型开始到处搜 "rewind 是什么"
2. 即使注册成功，命令也不合适：会显示在界面上、且要靠输入框提交（绑不住会话）

→ 改为**插件自己注册 HTTP 端点**（`dsh-client-hmr` / `dsh-client-modules` 同款）：

```js
ctx.webServer.register({
  kind: 'prefix', path: '/edit-resend',
  handler: (req, res) => { /* 直接操作 http 响应 */ },
})
```

客户端 `fetch('/edit-resend/rewrite', { body: { sessionId, atSeq, text } })`。
**不经过命令系统、界面上无中间物、sessionId 显式绑定**。

### 发错会话（严重 bug，已修）

早期提交用「找屏幕上的输入框 + 派发 Enter」，这发出去的是**当前活跃会话**的消息，
不是"我正在编辑的那条所属会话"。流程中**没有任何会话校验** → 用户在会话 A 编辑、
切到会话 B 后回车，内容就落进了 B。

→ 改为请求里显式带 `sessionId`，由服务端按会话定位；客户端不再碰输入框。

---

## 5. 安装 / 禁用 / 回滚

### 安装（bundles 路线，当前采用）

1. 插件列入 `profiles/web/package.json` 的 `dsh.profile.bundles`
2. 插件自带的 `cordis.patch.yml` 里 `insert` 一条 `edit-resend`（**必须有**：
   bundles 列表只决定"加载哪个补丁层"，真正挂载靠这条 insert）
3. **不要在 profile 根目录的 `cordis.patch.yml` 里再 insert 一次** ——
   同一个 id 挂两次会让整个 Harness 起不来（报「组件被重复定义」）

### 改完后如何生效

| 改了什么 | 需要 |
| --- | --- |
| `lib/client.js` | **刷新页面** |
| `lib/index.js` | **重启桌面端**（HTTP 路由在启动时注册） |
| profile 配置 | 重启桌面端 |

### 自查（不启动服务）

```bash
cd "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh"
DSH_HOME="$HOME/Library/Application Support/dsh-desktop/harness" \
  node lib/bin.js --profile web --dump-config > /tmp/dump.txt
grep -c "id: edit-resend" /tmp/dump.txt   # 期望 1
```

### 禁用 / 卸载

profile 的 `cordis.patch.yml` 末尾加：

```yaml
- id: edit-resend
  disabled: true
```

### 回滚一次改写

改写前已自动备份，直接还原：

```bash
ls -t "$HOME/Library/Application Support/dsh-desktop/harness/edit-resend-backups/" | head
# 把对应文件复制回原会话目录（去掉时间戳后的文件名）
```

---

## 6. 验证

```bash
cd /Users/ylf/Desktop/projects/dsh/edit-resend
node smoke.mjs                 # 离线回归，期望 51/51
```

真实浏览器（需调试 Chrome 在 9222）：

```bash
cd browser-test
python3 -m http.server 8791 --bind 127.0.0.1   # 一个终端
node cdp-test.mjs                              # 另一个终端
```

> 两套测试**不要并行跑**：HTTP 服务器与 CDP 抢资源，会假报失败。

### 排查

浏览器控制台：

```js
copy(JSON.stringify(__dshEditResendLog, null, 1))   // 完整判定链
__dshEditResend().rows                              // 每条消息的 seq / 轮次
```

主机侧：

```bash
grep -o "edit-resend[^\"]\{0,80\}" ~/Library/Logs/DSH\ Desktop/harness.log | tail
```

关键字段：

- `services` → 注入的服务拿没拿到
- `rewriteInPlace` → 请求发了什么（`sessionId` / `atSeq`）
- `rewriteInPlace result` → 服务端返回了什么（`ok` / `reason`）
