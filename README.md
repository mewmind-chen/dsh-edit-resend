# dsh-edit-resend

DSH（DeepSeek Harness）用户插件：把一条已发送的用户消息拿回**原位修改**，它之后的一切作废，AI 基于新内容重新回答。**不新建会话、不分叉、不切换页面**——改成什么，那条消息就变成什么。

- 用户气泡旁的原生操作栏里多一支铅笔（和「复制」同一行、同一套显隐）
- 点铅笔 → 原位编辑器 → Enter 发送，Esc 取消，Shift+Enter 换行
- 排队中的消息走 DSH 原生 `updateQueue` 原地改写
- 改写前自动备份会话日志，可回滚

## 原理

| 一半 | 机制 |
| --- | --- |
| 主机（`lib/index.js`） | `POST /edit-resend/rewrite` 路由；用 DSH 内部的 **surface replace**（compaction 同款）把 `[被编辑消息, surface 末尾]` 从模型可见历史盖掉，再用 `agent.wakeDriver()` 唤醒重答，全程只产生一条用户消息 |
| 客户端（`lib/client.js`） | 铅笔插进原生操作栏；改写成功后在 DOM 层藏掉被盖住的消息行、被编辑行换新文本（DSH 的 transcript 按设计只追加，replace 事件是纯模型侧的，屏幕必须由插件接管）；镜像记录落 `localStorage`，刷新后重放 |

要点：只在 Agent 空闲时改写；失败不擅自发送，回填输入框并说明原因；`Option+Enter` 发送可在 toast 里看到定位数据（atSeq/范围/新 seq/轮次），截屏即可排查。

## 安装

```bash
cd "$HOME/Library/Application Support/dsh-desktop/harness/profiles/web"
pnpm add --save-prod "file:/path/to/dsh-edit-resend"
```

把 `"dsh-edit-resend"` 加入 profile `package.json` 的 `dsh.profile.bundles`。插件自带的 `cordis.patch.yml` 会把自己挂进插件树——**不要**在 profile 根目录的 `cordis.patch.yml` 里再 insert 一次，同名条目挂两次会让整个 Harness 起不来。

改完后生效方式：`lib/client.js` 刷新页面；`lib/index.js` 重启桌面端。

自查（不启动服务，期望计数为 1）：

```bash
cd "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh"
DSH_HOME="$HOME/Library/Application Support/dsh-desktop/harness" \
  node lib/bin.js --profile web --dump-config > /tmp/dump.txt
grep -c "id: edit-resend" /tmp/dump.txt
```

## 验证

```bash
pnpm test          # mock DOM 离线冒烟（60 项）
pnpm test:real     # 真依赖回归：直连桌面端本体的 dsh-session + dsh-llm（10 项）
```

`test:real` 需要 `node_modules/@deepseek-ai/{dsh-llm,dsh-session}` 指向桌面端本体：

```bash
mkdir -p node_modules/@deepseek-ai
ln -s "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-llm" node_modules/@deepseek-ai/dsh-llm
ln -s "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-session" node_modules/@deepseek-ai/dsh-session
```

真实浏览器测试见 `browser-test/`（需调试 Chrome 在 9222 监听）。

## 排查

- 成功 toast 长按：`Option+Enter` 发送，toast 里带出定位数据
- 主机落盘日志：`$DSH_HOME/edit-resend-debug.log`（改写备份在 `$DSH_HOME/edit-resend-backups/`）
- 客户端诊断：控制台 `__dshEditResendLog`（最近 200 条）、`__dshEditResend().rows`

开发过程笔记见 [`DOCS.md`](./DOCS.md)。

## 协议

MIT，见 [`LICENSE`](./LICENSE)。
