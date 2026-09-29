# CLAUDE.md — 听见（listen）

给听障人士的实时语音转写 Web 应用（移动优先）。火山引擎豆包流式 ASR 大模型 + Cloudflare Worker WebSocket 透明代理 + Vue 3 Options API 单文件前端。

## 进度（改动后同步更新）

- [x] Phase 0 脚手架与注入管线（2026-09-29）
- [x] Phase 1 Worker 票据鉴权（2026-09-29）
- [x] Phase 2 WebSocket 代理——经本地 worker 全链路真实识别 PASS（2026-09-29）
- [x] Phase 3 浏览器音频链路——协议层/worklet 单测 19/19，应用逻辑 E2E 17/17（2026-09-29）
- [x] Phase 4 转写主界面——UI 交互经 obscura 验证（2026-09-29）
- [x] Phase 5 适老化与稳定性——逻辑全 E2E；**真机手测清单待用户**（2026-09-29）
- [x] Phase 6 历史 + PWA + 收尾（代码完成 2026-09-29）——**待办：`wrangler login` + `npm run deploy` + 自定义域名 + 真机全量回归**（CHECKLIST 最后两项保持未勾，验收人为用户）

规则：进度唯一真相源是 `CHECKLIST.md` 的勾选状态；完成一个 Phase 先跑验收再勾选，本文件只同步摘要。

## 常用命令

```bash
npm run dev        # 注入 + wrangler dev（localhost:8787，.dev.vars 提供 ACCESS_PASSWORD=test123 等密钥）
npm run deploy     # 注入 + wrangler deploy
node src/deploy.js --no-minify   # 调试：跳过压缩
node test/core-test.mjs          # 单测（无需服务）
node test/app-e2e.mjs            # 应用逻辑全链路 E2E（需 wrangler dev）
node test/ui-browser-test.mjs    # 浏览器渲染（需 obscura serve --port 9333）
node scripts/gen-icons.mjs       # 重生成 PWA 图标
./scripts/fix-workerd-glibc.sh   # wrangler dev 报 glibc 错时重跑（幂等）
```

## 架构速查

- **请求流**：浏览器 16k PCM → `wss /ws?ticket=` → Worker（验票 → fetch+鉴权 Header 拨号火山 `bigmodel_async`）→ 双向原样字节透传。Worker 不解析音频。
- **票据**：`b64url({jti,exp}) . b64url(HMAC-SHA256(payload, SHA256(ACCESS_PASSWORD+"listen-ticket-v1")))`，12h；改密码全吊销。`verifyTicket` 在 worker.js。
- **注入管线**：`src/deploy.js` 读 `src/app.html` → 内联 style.css → vendor Vue 以占位文本参与压缩后换回**未压缩**脚本块 → html-minifier-terser 压其余 → 转义 `` \ ` $ `` → 写 worker.js 的 `htmlContent` 标记区间。⚠️ `String.replace` 用变量内容做替换必须**函数形式**，否则 `$&` 等模式会静默损坏内容（Phase 0 踩过）。
- **协议帧**（大端，详见 PLAN.md §2——**以它为准，勿猜**）：配置 `11 10 11 00`（gzip）/`11 10 10 00`（raw）+ u32 长度 + JSON；音频 `11 20 00 00`（尾包 `11 22`）；响应 msgType `0b1001`（flags 含 1 → 后随 seq；`0011`=最终），错误 `0b1111`。响压缩跟随配置帧。
- **渲染算法**：`finalLines` + `committedKeys`（key=`start_time-end_time`）；重连/新会话必须重置 `committedKeys`（时间戳重新计数）。断线时进行中草稿落成定稿保留。
- **Vue 3 陷阱**：`_` 前缀的方法不会被代理进模板上下文（`@click="_foo()"` 静默失效），模板只引用不带下划线的方法（如 `answerModal`）；内部 `this._xxx` 不受影响。
- **obscura 无头浏览器**（本机 `/usr/local/bin`）：渲染验收用；页面级 WebSocket 不联网、localStorage 不跨 reload——WS/持久化链路要用 `test/app-e2e.mjs`（Node 沙箱）验证。

## 硬约束

1. 火山凭证只进 `wrangler secret`；`API_KEY.txt`/`.dev.vars` 已 gitignore，绝不入库、绝不进 wrangler.toml。
2. 前端唯一依赖 Vue 3（Options API），vendored 构建期内联，**无运行时 CDN、无第三方库**。
3. 协议帧格式/参数/错误码以 `PLAN.md` §2 为准（实测验证过），不要自行猜测字段名。
4. 音频管线勿照抄 `../listen-old`（ScriptProcessor/写死 44100/逐字节数组都是坑）。
5. UX 继承 listen-old：vh 十档字号（默认 5）、底部通栏三态主按钮；改交互前先读 PLAN.md §4.0。
