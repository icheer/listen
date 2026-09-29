# 听见（listen）实施清单（CHECKLIST）

> 供 Coding Agent 分步实施。规划依据：`PLAN.md`（架构实测结论 §1 / 协议规范 §2 / API §3 / 前端 §4 / 视觉 §5）。

## 执行规则（必须遵守）

1. **按 Phase 顺序执行，不跳批、不合并批**。
2. **每完成一个 Phase**：先跑该 Phase 的「验收」，全部通过后，把该 Phase 内所有 `- [ ]` 勾选为 `- [x]`，再开始下一个 Phase。验收不通过必须先修复，禁止提前勾选。
3. 勾选动作 = 直接编辑本文件，把对应任务的 `[ ]` 改为 `[x]`。
4. 同构参考 `../jev-decides`：`src/deploy.js` 注入管线、worker 骨架、secrets 纪律直接照搬适配；其 Vue 走运行时 CDN（本项目改为 vendored 构建期内联）与 KV 绑定（本项目无）不照搬。UX 与反面教材参考 `../listen-old`（扬弃清单 PLAN.md §4.0）。
5. 火山引擎凭证在 `API_KEY.txt`（**绝不入库、绝不进 wrangler.toml**，本地调试写 `.dev.vars`）。
6. 协议帧格式、参数、错误码一律以 `PLAN.md` §2 为准（已实测验证），不要自行猜测字段名。
7. 前端仅依赖 Vue 3（Options API 写法，vendored 内联），除此外**不引入任何第三方库、不使用运行时 CDN**；音频管线勿照抄 listen-old（坑见 PLAN.md §4.0 弃用清单）。

---

## Phase 0 · 脚手架与注入管线

- [x] 创建 `wrangler.toml`：`name = "listen"`、`main = "worker.js"`、`compatibility_date = "2024-09-01"`（无 KV、无额外绑定；注释里列出全部 secrets 名，见 PLAN.md §3.2）
- [x] 创建 `.gitignore`：`.dev.vars`、`.wrangler/`、`node_modules/`、`API_KEY.txt`、`test/`
- [x] 创建 `worker.js` 骨架：模块导出 `fetch`，含 `getHtmlContent()`（`let htmlContent = \`<!doctype html><html><body>PLACEHOLDER</body></html>\`; // htmlContent FINISHED` 标记区间，同 jev-decides）、`GET /` 返回注入 HTML（`Cache-Control: public, max-age=300`）、其余路径 404
- [x] 创建 `src/app.html`：`<!doctype html>` + 移动 viewport（含 `viewport-fit=cover`）+ `<link rel="stylesheet" href="style.css">` + `<script src="vendor/vue.global.prod.js"></script>` 占位 + 根挂载点 `<div id="app">听见</div>` + Vue3 Options API 空应用（`createApp({data(){...}, methods:{}}).mount('#app')`），页面显示「听见」标题
- [x] 下载 Vue3 到 `src/vendor/vue.global.prod.js`：`curl -L https://unpkg.com/vue@3.5.22/dist/vue.global.prod.js -o src/vendor/vue.global.prod.js`（与 jev-decides 同版本；校验文件非 404 页，约 130KB）
- [x] 创建 `src/style.css`：CSS 变量 token（PLAN.md §5 全表：明/暗双色、vh 字号十档 class `.font-0`…`.font-9`、圆角间距）+ reset + 移动优先单列布局（PC ≥768px 居中 `max-width: 720px`）
- [x] 复制 `../jev-decides/src/deploy.js` 适配为本项目：读 `app.html` → 内联 `style.css` → **内联 `vendor/vue.global.prod.js` 为独立 `<script>` 块（原样嵌入，不经过 terser 压缩，替换掉 `<script src="vendor/...">` 标签）** → 压缩其余 HTML/应用脚本（`html-minifier-terser`，`--no-minify` 跳过）→ 转义 `` \ ` $ `` → 替换 `worker.js` 标记区间
- [x] 创建 `package.json`（scripts: `inject` / `inject:dev` / `dev` / `deploy`，devDependencies 仅 `html-minifier-terser`）并 `npm install`
- [x] 创建 `README.md` 占位（Phase 6 补全）
- [x] 创建 `test/` 目录：放 `PLAN.md` 附录 A 脚本为 `test/proto-test.mjs`（凭证改读环境变量），后续 Phase 2 验收用

**验收**：
```bash
node src/deploy.js            # 注入成功、字符统计
npx wrangler dev              # 本地起服务 http://localhost:8787
curl -s http://localhost:8787/ | grep -o "听见"          # 命中
curl -s http://localhost:8787/ | grep -c "vue.global"    # ≥1（Vue 已内联）
ls -la src/vendor/vue.global.prod.js                     # ~130KB
git status --porcelain        # API_KEY.txt 被 ignore，不出现在待提交列表
# 手测：浏览器打开能看到「听见」标题（Vue 挂载成功，无控制台报错）
```

## Phase 1 · Worker 票据鉴权

- [x] `POST /api/auth`：读 body `{"password":...}`（上限 4KB）与 `ACCESS_PASSWORD` 常量时间比对（`crypto.subtle.timingSafeEqual` 或等长比较）→ 失败 401 `{"error":"密码不对，请重试"}`
- [x] ticket 签发：`b64url({jti: crypto.randomUUID(), exp: Date.now()+12*3600*1000}) + "." + b64url(HMAC-SHA256(payload, SHA256(ACCESS_PASSWORD + "listen-ticket-v1")))`，返回 `{"ticket", "expiresAt"}`
- [x] ticket 校验函数 `verifyTicket(ticket)`：split → 重算 HMAC → 比较（时间安全）→ 解 payload → `exp` 检查；任何一步失败返回 null（供 `/ws` 复用）
- [x] 防爆破：模块级 `Map`（ip → {fails, lockedUntil}），10 次失败锁 15 分钟；IP 取 `CF-Connecting-IP`，缺省用 `x-forwarded-for`
- [x] `GET /favicon.svg`：内联 SVG（耳朵/声波图形，brand 色）
- [x] 所有 `/api/*` 响应加 `Cache-Control: no-store`；错误响应统一 `{"error": "人话中文"}`
- [x] `.dev.vars`：从 `API_KEY.txt` 抄入 `VOLC_APP_ID` / `VOLC_ACCESS_TOKEN`，另设 `ACCESS_PASSWORD=test123`（该文件已 gitignore）

**验收**（`npx wrangler dev` 起着；`.dev.vars` 改动后重启）：
```bash
# 正确密码 → 拿到 ticket（三段式 base64url 字符串）
curl -s -X POST http://localhost:8787/api/auth -H 'Content-Type: application/json' -d '{"password":"test123"}'
# 错误密码 → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8787/api/auth -H 'Content-Type: application/json' -d '{"password":"nope"}'
# 篡改 ticket（改末位字符）→ 无 /ws 可测时先确认 verifyTicket 单元逻辑：篡改后 HMAC 不匹配
# 防爆破：连打 11 次错误密码 → 第 11 次 429
for i in $(seq 1 11); do curl -s -o /dev/null -w "%{http_code} " -X POST http://localhost:8787/api/auth -H 'Content-Type: application/json' -d '{"password":"nope"}'; done
```

## Phase 2 · WebSocket 代理（核心链路）

- [x] `GET /ws?ticket=` 处理：`verifyTicket` 失败 → 401（不升级）；成功取 jti 作 `X-Api-Connect-Id`
- [x] 出站拨号：`fetch(env.VOLC_ENDPOINT || 'https://openspeech.bytedance.com/api/v3/sauc/bigmodel_async', {headers: {Upgrade:'websocket', 'X-Api-App-Key': env.VOLC_APP_ID, 'X-Api-Access-Key': env.VOLC_ACCESS_TOKEN, 'X-Api-Resource-Id': env.VOLC_RESOURCE_ID || 'volc.bigasr.sauc.duration', 'X-Api-Connect-Id': jti}})`
- [x] 拨号结果无 `webSocket` → 502 `{"error":"语音服务连接失败"}`（含上游 status 便于排查，注意不回传凭证）
- [x] `new WebSocketPair()`：客户端侧随 `new Response(null, {status:101, webSocket: client})` 返回；`upstream.webSocket.accept()`；两侧 `message` 事件原样 `send(e.data)`（二进制 ArrayBuffer 直传，禁止 String 化）
- [x] 双向 close/error 传播（对端 code/reason 透传；error 时 close 对端 1011）
- [x] 会话时长兜底：连接内闭包记录首条消息时间戳，每条消息检查超 `MAX_SESSION_MINUTES`（默认 120）→ 双向 close(1008)
- [x] per-ticket 并发上限 2：模块级 `Map`（jti → 活跃数），accept 时 +1、close 时 -1，超限 close(1013)

**验收**（核心里程碑——经本地 worker 全链路真实识别）：
```bash
npx wrangler dev &
# 1. 换票
TICKET=$(curl -s -X POST http://localhost:8787/api/auth -H 'Content-Type: application/json' -d '{"password":"test123"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).ticket))")
# 2. 错误票据 → 401
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8787/ws?ticket=tampered.sig"
# 3. 把 test/proto-test.mjs 的连接改为 new WebSocket("ws://localhost:8787/ws?ticket=$TICKET")（Node≥22 原生 WS，或继续用 ws 包）
#    运行后能看到 seq 递增的识别 JSON、末帧 definite:true、close 1000
node test/proto-test.mjs
```

## Phase 3 · 浏览器音频链路（先跑通，后接 UI）

- [x] Vue 应用骨架（Options API）：`data()` 含 `state/screen/ticket/finalLines/interimText/fontSize/...`；WebSocket、AudioContext、worklet、音频缓冲等**重资源放模块级变量**（不进 data，避免响应式代理性能坑）；方法 `connectSession/startListening/stopListening/handleFrame` 等骨架先立好
- [x] `connectSession()`：POST /api/auth（密码从 localStorage `listen_password`，「记住密码」默认开）→ `new WebSocket("wss://"+location.host+"/ws?ticket="+ticket)`；401 且无保存密码 → 显示密码门
- [x] 配置帧构造（PLAN.md §2.3 参数、§2.2 帧头 `11 10 11 00`）：JSON → `CompressionStream('gzip')`；不支持时 raw JSON 帧（`11 10 10 00`，记 `configWasGzip`）
- [x] 麦克风：`getUserMedia`（PLAN.md §4.2 约束集）；权限拒绝 → 引导文案（含微信/iOS/Chrome 路径）；`isSecureContext` 检查
- [x] AudioWorklet 内联（Blob URL）：Float32 → 降采样 16k（线性插值）→ Int16 → 每 200ms postMessage `{int16: ArrayBuffer}`
- [x] 主循环：worklet 消息 → 音频帧（`11 20 00 00` + u32 长度 + pcm）→ `ws.send`（bufferedAmount > 1MB 时告警丢弃并标记连接劣化）
- [x] 响应解析：按 §2.2 解 4 字节头 → msgType 0b1001/0b1111 分支 → 压缩位为 1 时 `DecompressionStream('gzip')` 解压 → `JSON.parse`；本 Phase 仅 `console.log` 增量结果（下个 Phase 接 UI）
- [x] 停止流程：发尾包（flags 0010，无待发数据时附 100ms 静音）→ 收到 flags 0011 后等服务端 close → 停 worklet、关 AudioContext、停麦克风流**验收**：
```
浏览器开 DevTools console，点页面上的临时「开始」调试按钮：
1. 对手机/电脑说话 → console 持续输出 {type:'resp', payload:{result:{text:'…', utterances:[…]}}}，utterances 的 text 随语音增长
2. 点「停止」→ 输出末帧 flags=0011 definite=true → WS close 1000
3. 手机微信内打开（需 HTTPS 或本地局域网调试）→ 麦克风授权正常、同样出字
4. 断网 5s 再恢复 → 自动重连后继续出字（新会话）
```

## Phase 4 · 转写主界面

- [x] 状态机（PLAN.md §4.1）：`idle/connecting/listening/stopping/error`；主按钮三态文案内嵌状态与时长：`开始听写` / `● 正在听写（mm:ss）` / `正在结束...`（沿用旧版文案，时长本地计时即可）
- [x] 布局骨架（PLAN.md §4.5）：全屏滚动转写区 + 底部通栏主按钮（三态：绿/红+呼吸动画/灰禁用）+ 次级「清空」「复制」按钮；左上 ⚙ 菜单、右上浮动 `-`/`+` 字号钮（≥48px 触控）；开始/停止 `navigator.vibrate(50)`
- [x] 转写渲染：`finalLines` 用 `v-for` + `:key`（definite 去重 key = `start_time-end_time`，算法照抄 PLAN.md §4.3）渲染 `<p>` 列表 + 末尾草稿行（`--text-interim` 灰色）；错误态主按钮变「重试」
- [x] 自动滚动：新内容滚到底（`$nextTick` 后 `scrollTop = scrollHeight`）；用户上滑取消自动滚，出现「↓ 回到最新」浮标，点按恢复
- [x] 字号调节：浮动 `-`/`+`，**vh 十档 4.2–11.4vh**（class `.font-0`…`.font-9`，PLAN.md §5），默认 `fontSize=5`（`.font-5` = 8.2vh，沿用旧版默认），localStorage `fontSize` 持久化（沿用旧版键名）
- [x] ⚙ 菜单：复制全文（`navigator.clipboard`，降级 `execCommand`）、清空屏幕（确认）、退出密码（清 localStorage 票据+密码）；深色模式项 Phase 5 补
- [x] 密码门屏：大输入框 + 显示/隐藏 + 「记住密码」勾选（默认开）+ 大按钮「进入」；错误信息内联红字
- [x] 深色模式：`prefers-color-scheme` 自动；系统无偏好时按时段兜底（19:00–7:00 深色，沿用旧版规则）+ 菜单手动切换，localStorage `listen_theme`

**验收**（真机，微信 + Safari/Chrome 各一）：
```
1. 中文连续对话 5 分钟：首字 <1.5s（人感），跟字连贯，无断流；草稿字灰显、定稿后变深色
2. 字号十档切换即时生效且刷新后保持；默认档在 5.5 寸屏一行约 6-8 字可读（老人视角）
3. 底部主按钮三态正常：开始/正在听写（计秒）/正在结束（禁用）；停止后再开始 → 新会话有分隔线，旧文保留可滚动
4. 复制全文 → 粘贴完整含定稿文本
```

## Phase 5 · 适老化与稳定性

- [x] `navigator.wakeLock('screen')`：listening 时申请，`visibilitychange` 回前台重申请，失焦释放重逻辑兜底
- [x] 自动重连：非正常断开（45000081/网络/1006）→ 指数退避 1s/2s/4s/8s/16s 最多 5 次 → 仍失败显示 error 屏 + 大「重试」按钮；重连成功插入时间分隔行
- [x] ticket 过期静默续期：/ws 401 → 有保存密码则自动 `/api/auth` 换票重连（全程无感），无密码回密码门
- [x] 错误文案人话化（映射表）：麦克风拒绝/非 HTTPS/服务配置错误(502)/网络问题/会话超时(1008，提示重开)/并发超限(1013)
- [x] 会话分隔行样式（小字灰色时间）；`pagehide` 时尽力触发停止流程
- [x] iOS Safari 真机回归：AudioContext 需用户手势内 resume（开始按钮点击链路里启动）

**验收**（手测清单）：
```
□ 开飞行模式 10s 再关 → 5 次退避内自动恢复，已出文字不丢
□ 收音中锁屏 3 分钟再亮屏 → 仍在收音（wakeLock 生效）
□ 拒绝麦克风 → 引导文案 + 「重新授权」
□ 断网超 31s（>5 次退避）→ error 屏 + 重试按钮可用
□ 真机连续收音 30 分钟无断流、无内存暴涨（DevTools 观察 DOM 行数与 bufferedAmount）
```

## Phase 6 · 历史 + PWA + 部署收尾

- [x] 刷新恢复（沿用旧版体验，PLAN.md §4.6）：当前文本每 30s + `pagehide` 写 localStorage `listen_draft`（`{text, savedAt}`），重载时恢复显示并顶部标注「上次内容 · 可清空」；点开始新会话后草稿归档进历史
- [x] 历史落库：停止时存 localStorage `listen_sessions`（`{id, startedAt, endedAt, text}`，上限 50 条 / 2MB 删最旧）；listening 每 60s 与 `pagehide` 时也落（upsert）
- [x] 历史面板（⚙ 菜单进入）：列表（起止时间 + 首行预览）→ 详情全文 → 复制 / 删除单条 / 清空全部（确认）
- [x] PWA：`GET /manifest.webmanifest`（name 听见、display standalone、theme/背景色、icons 192/512）+ 图标实现（`src/icons.js` 内嵌 base64 PNG，worker 加两条路由；或项目内生成 PNG 由 deploy.js 注入路由——选一种，勿引外部资源）；`apple-touch-icon` 与 `apple-mobile-web-app-capable` meta
- [x] `README.md` 补全：产品简介、本地开发（.dev.vars、deploy 注入、wrangler dev）、部署（secrets 三条 + 自定义域名建议 + 冒烟步骤）
- [x] 创建 `CLAUDE.md`：项目概述、进度区（Phase 勾选状态同步规则）、开发命令、架构摘要（注入管线 / 票据 / WS 代理 / 协议帧速查）、硬约束（凭证纪律 / Vue vendored 内联无运行时 CDN / 协议以 PLAN.md §2 为准）
- [ ] 线上部署：三条 `wrangler secret put`（正式密码 + API_KEY.txt 凭证）→ `npm run deploy` → 绑定自定义域名（避免 workers.dev 大陆可达性问题）
- [ ] 线上全量回归：真机（微信 + Safari + Chrome）按 Phase 4/5 验收单重跑核心项

**验收**：
```bash
curl -s https://<域名>/manifest.webmanifest | head -3      # JSON 正常
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<域名>/api/auth -H 'Content-Type: application/json' -d '{"password":"错误"}'   # 401
# 真机：完整走一遍 开始→对话→停止→历史可见→复制；添加到主屏幕后图标/全屏正常
```

---

# v1.1 · 远程字聊（设计：PLAN.md §11；2026-09-29 拍板：DO / 气泡 / 两人 / 「对方」）

## Phase 7 · Durable Object 房间与后端

- [x] `wrangler.toml`：`[durable_objects.bindings]`（name ROOM / class ChatRoom）+ `[[migrations]] tag="v1" new_sqlite_classes=["ChatRoom"]`（PLAN.md §11.6）；`worker.js` 改为同时导出 `ChatRoom` 类与默认 fetch（导出形状 `{ default: {fetch}, ChatRoom }`，注入标记区间不受影响）
- [x] room token 签发/校验：`{scope:'room', room, role, jti, exp}`，HMAC 域字符串 `listen-room-v1`（key = `SHA256(ACCESS_PASSWORD + 域)`，改密码连坐吊销）；复用现有 b64url/HMAC 工具函数；`verifyTicket` 扩展为双格式（app 票据 | room token），`/ws` 两者都收且 room token 同样进 `ticketConns` 并发槽
- [x] `POST /api/room`（body `{ticket}`，须为 app 票据）：生成 6 位 code（字母表去 0/O/1/I，crypto 随机）→ `idFromName(code)` 调 DO 初始化（`joinDeadline = now + JOIN_WINDOW_SECONDS(默认600)`、`hardEnd = now + ROOM_TTL_MINUTES(默认120)*60s`、`consumed=false`）→ 返回 `{code, token(host room token), joinUrl, joinDeadline, hardEnd}`
- [x] `POST /api/join`（body `{code}`，per-IP 20 次/分钟限流，内存 Map）：DO `claimJoin` → 房间存在且未关闭未烧毁且在加入窗口内 → 烧毁 code + 签发 guest room token（exp=hardEnd）→ `{token, hardEnd}`；否则 404 人话文案（「邀请码不存在或已过期」/「邀请码已被使用」）
- [x] `GET /j/:code`：返回同一份注入 HTML（前端按路径 `/j/<code>` 进访客模式；code 大小写归一）
- [x] `GET /room/:code?token=`：Worker 校验签名/exp/`room` 与路径一致 → `stub.fetch` 转发（role 经内部 header 传递，DO 信任 Worker 附加头）
- [x] `ChatRoom` DO：`/init`（POST，Worker 内部）与 `/claim`（POST，返回 {ok, hardEnd} 或失败原因）；`/ws` 升级 → 成员表（role→ws；同 role 重连先 close 旧连接 4000 "replaced"）→ 发 `welcome {role, peerOnline, backlog}`；消息处理：`line.final` → seq++ + 存 storage（上限 200 条）+ 转发对端（对端离线时照存）；`line.interim` → 仅对端在线时转发；`ping`→`pong`；`bye`→close(1000)；断开 → 清成员表 + 对端 `presence offline`；`alarm()`（init 时 `setAlarm(hardEnd)`）→ 双端 `room_closed` + `storage.deleteAll()`
- [x] 新建 `test/room-e2e.mjs`（真实 wrangler dev，`ws` 包双客户端）：建房→加入→双向 line 交换（host→guest、guest→host，seq 单调）；interim 即时转发；一次性 join（第二次 /api/join 404）；过期 code 拒绝；成员顶替（同 role 二连，旧连接 4000）；断开重连 backlog 补发；ping/pong；`room_closed`（对 `:8788` 第二实例 `--var JOIN_WINDOW_SECONDS:3 --var ROOM_TTL_MINUTES:1` 验证短 TTL 生命周期）

**验收**：
```bash
npx wrangler dev &                    # :8787 主实例（.dev.vars 照旧）
node test/room-e2e.mjs                # 全部场景 PASS（含自动起/收 :8788 短 TTL 实例）
# 回归：node test/core-test.mjs && node test/app-e2e.mjs   # /ws 双格式改造不破坏现有链路
```

## Phase 8 · 前端字聊界面（气泡 + 邀请 + 访客）

- [x] vendor `qrcode-generator`（MIT）到 `src/vendor/qrcode.min.js`（约 15KB）；`src/deploy.js` 泛化 vendor 内联：循环替换**所有** `vendor/*.js` script 标签为占位符、压缩后按原样换回（机制与 Vue 相同，**替换一律函数形式**）
- [x] `src/style.css`：`.chat` 滚动区、`.bubble.me`（右，brand 底白字）/`.bubble.them`（左，surface 底+边框 + 上方小字「对方」）/`.bubble.ghost`（半透明）、居中系统消息（复用 session-divider）、邀请屏与访客落地屏样式；气泡 max-width 85%，字号沿用 `.font-0…9`
- [x] 引擎双消费者抽象：ASR definite/interim 输出可挂「单机渲染（finalLines）」或「字聊渲染（chatLines + 发房间）」两套消费者；进入字聊时若正在单机收音 → 先弹确认模态框停止
- [x] 房间 WS 客户端（模块级变量，同 ASR 引擎风格）：连接 `/room/<code>?token=`、退避重连 1/2/4/8s、`welcome` backlog 整体重建 chatLines、`line`/`presence`/`room_closed` 分发、每 25s `ping` + 60s 无消息看门狗；心跳/重连不触碰音频管线
- [x] 主机邀请屏：⚙ 菜单新增「远程字聊」→ `POST /api/room` → QR（canvas→`toDataURL`→`<img>`，微信长按识别只认 img）+ 6 位码大字 + 倒计时 + 「等待对方加入…」；窗口过期 → 「重新生成」；对方加入（presence）→ 双端自动切聊天屏
- [x] 聊天屏（双端同构）：气泡区（我右/对方左+「对方」标签/ghost 半透明/居中系统消息）+ 底部主麦克风按钮三态复用 + 「结束」(host)/「退出」(guest)（自绘确认模态框复用）+ A-/A+、自动滚动/回到最新、wakeLock 全部复用
- [x] 访客路径：`location.pathname` 匹配 `/j/<code>` → 落地屏（「加入字聊」大按钮；过期/已用人话文案 + 「请对方重新发起」）→ `POST /api/join` → 聊天屏；无密码门/无历史/无 ⚙（保留 A-/A+ 与系统主题）；麦克风拒绝 → **只读模式**（toast 提示一次，界面不挡）
- [x] 字聊历史（host 侧）：60s + pagehide upsert `listen_sessions`（行前缀 `我：`/`对方：`）；字聊期间不写 `listen_draft`、不显示草稿横幅；挂断/到期/退回 → 结束会话落库
- [x] 测试扩展：`test/app-e2e.mjs` 加字聊场景（真实 `/api/room` + `/api/join` + `/room` WS 经 wrangler dev；host 喂真实音频出真字，guest 侧用房间协议注入模拟行；断言 chatLines 双侧/ghost 替换/重连补发/挂断落库）；`test/ui-browser-test.mjs` 加渲染用例（邀请屏 QR `<img>` 存在 + 倒计时、聊天屏气泡左右/名字/ghost、访客落地屏、只读降级）

**验收**：
```bash
node src/deploy.js && node test/core-test.mjs && node test/app-e2e.mjs && node test/ui-browser-test.mjs
# 手测（真机×2，或一机 + 无痕窗口）：
# 1. 主机生成邀请 → 另一设备扫码/输码 → 双端自动进聊天屏（「对方已加入」）
# 2. 两端同时说话 → 双 ghost 并存、各自定稿成实气泡、左右与名字正确
# 3. 访客飞行模式 10s 恢复 → 定稿不丢（backlog 补发），系统消息「连接已恢复」
# 4. host 结束 / guest 退出 → 双端正确退回；host 历史出现「我：/对方：」全文
```

## Phase 9 · 双端联调与收尾（v1.1）

- [ ] 真机双端全流程联调：微信「扫一扫」直接扫码 + 微信内**截图二维码长按识别**两条进入路径（`<img>` 渲染）；iOS Safari + Android Chrome 各一
- [ ] 同时说话 2 分钟稳定性：双端各自 ASR 会话互不影响、房间心跳不断、无消息丢失
- [ ] 边界路径走查：2h 上限提示、host 结束、guest 退出、邀请过期「重新生成」、访客只读模式、host 断网重连
- [x] `README.md` 补远程字聊章节（使用流程 / 场景边界「适合异地家人」/ 费用提示：双端各一条 ASR 流）；`CLAUDE.md` 架构速查补 DO 房间/room token/消息协议 + 进度同步
- [x] 注入体积复查：单文件 HTML 增量 ~15KB（QR vendor）+ 聊天 UI；确认 `max-age=300` 缓存策略仍适用

**验收**（真机双端）：
```
□ 微信截图二维码 → 长按识别 → 打开链接 → 「加入字聊」成功进入
□ 孙女端正常说话 → 爷爷端大字号气泡 <1.5s 看到草稿在长；反向同理
□ 断网恢复 / 锁屏回来 → 不丢定稿、自动恢复、出现「连接已恢复」系统消息
□ host 结束字聊 → 双端退出；主机历史里完整对话（我：/对方：前缀）可复制
```

---

## v1.1.2 · 体验修复（2026-09-29 真机反馈）

## Phase 10 · FOUC / 历史一屏一记录 / 静音草稿转正

- [x] FOUC：根容器 `v-cloak` + CSS `[v-cloak]{display:none!important}`（Vue 挂载后自动移除属性，模板花括号不再闪现）
- [x] 历史一屏一记录：`sessionId` 跨多次开始/停止复用（`clearScreen` 才终结、开新条目）；恢复的草稿并入当前屏幕这条记录（删除 `_archiveDraft` 的 `d-` 独立归档路径）；`startedAt` 取首段时刻（`sessionStartAt`）
- [x] 静音草稿转正（单机 + 字聊双模式，PLAN.md §4.3 增补）：
  - worklet 每块附带 RMS（`{int16, rms}`）；`rms>300` 记有声；`listening && 有草稿 && 静音≥1500ms` → 本地转正（400ms 轮询 timer）
  - 对账防双份：转正行 key=`p<nonce>-<interimStart>`（nonce 每 ASR 会话轮换）；服务端 definite 同 `start_time` 原位替换、区间覆盖删除、文本前缀兜底
  - 字聊：转正发 `line final`，对账广播 `revise`；DO 存储/对端/backlog 同步原位修正（worker.js ChatRoom 增 revise 处理）
- [x] **v1.1.3 防复活修复（2026-09-29 真机 bug：一句「你好，能听到我说话吗」重复 3 遍）**：静音期服务端周期性重发同句草稿导致 ghost 反复复活→反复转正。修复：① `_applyResult` 同 start_time 草稿且已转正 → 原位更新行、ghost 不复活；② `_promoteInterim` 同 key 原位更新不加行；③ 定稿对账同 start_time 多条只留一条。测试：app-e2e 场景6 第二轮（重发抑制）+ 6b（字聊同款），59/59
- [x] **v1.1.4 续说拆行（2026-09-29 真机反馈：对方发言后我续说，草稿不应改写旧的绿色气泡）**：转正后服务端仍视作同句（同 start_time）→ `splitOverlap` 前缀剥离已转正文本，旧行全部不动、新增部分从底部新 ghost 开始、静音后转正为新行（延续 key 加轮次后缀）；整句定稿剩余部分落新行/唯一行补标点原位升级；空 utterances 响应（配置 ACK）不清 ghost。测试：app-e2e 场景6 第二轮（全合成重发抑制）+ 第三轮（续说拆行）+ 6b，64/64
- [x] **v1.1.6 前台 45000081 主动重连（2026-09-29 真机反馈：全程前台、切网一次后误报「后台太久，正在重连」）**：根因=切网致上行中断 → 服务端等包超时 45000081；旧文案按后台场景写死（误导）、且前台时只 toast 被动等服务端 close（半死连接可能等不到）。修复：文案改「连接中断了，正在自动重连」（两场景皆准）；前台（visibilityState=visible）收到即 `_closeWs` + 主动重连，后台维持回前台再连。测试：app-e2e 场景8 注入真实错误帧（11 F0 00 00 + u32be code），70/70
- [x] **v1.1.7 续说改写防重复（2026-09-29 真机 bug：一句话转正后不久续说下一句，上一句重新变草稿，最终两句一模一样）**：根因链=① 服务端续说时偶发改写这句早前的文字 → 严格前缀剥离（splitOverlap）失败 → 草稿回退全量（旧句复活成 ghost）→ 静音转正成重复行；② 整句 definite 走非前缀对账时，延续轮次 key（`p<nonce>-<st>-<轮次>`）被 `Number()` 整串解析得 NaN → 同句旧行永远匹配不上、删不掉 → 两句并存。修复三层：草稿剥离改 `stripLcp`（归一化最长公共前缀，改写多少剥多少，ghost 永不回退全量）；定稿非前缀对账解析延续 key 用 `/^(\d+)/` 只取首段数字；`_promoteInterim` 兜底（同句已转正内容完全覆盖草稿时不加行只清草稿）。测试：app-e2e 场景6 第四轮（单机：LCP 剥离/延续行/合并一句）+ 6b 第二轮（字聊：revise 带 双 drop），80/80
- [x] **v1.1.5 体验三项（2026-09-29 用户提出）**：① 页面不可见（切后台/息屏）持续 5 分钟 → 自动停止听写（计费护栏；字聊只停收音、房间保留；回前台 toast 提示、及时回来取消；`_onVisibility` 方法化便于测试，`__debugSetHiddenStop` 覆盖时长）② 字聊历史/复制：说话人切换处插空行（`chatText`）③ 字号新增 `-2`/`-1` 最小两档 2.6/3.4vh（class `.font--2`/`.font--1`，旧档位语义不变，A- 下限放宽——注意模板 disabled 与 decFont 守卫两端同步改）。测试：app-e2e 场景7（自动停止+取消）+ 场景4 空行断言，68/68
- [x] **v1.1.8 屏蔽外部字号与手势缩放（2026-09-29 用户提出）**：① `html,body` 加 `-webkit-text-size-adjust:100%; text-size-adjust:100%`——微信内「标准/大/特大」字号与系统字体大小不再放大应用文字（应用内有自己的十二档字号，老的特大档会把布局撑坏）；② viewport meta 加 `maximum-scale=1, user-scalable=no`，禁双击/双指缩放页面。测试：ui-browser 28/28（注入产物含两条 CSS 属性与新 meta 已验证）
- [x] 测试：core-test worklet RMS 断言；app-e2e 场景5（一屏一记录）+ 场景6/6b（单机/字聊静音转正+对账，真实 ASR 验证 duck 只出现一次）；room-e2e revise 中继/backlog 修正用例

**验收**：
```bash
node test/core-test.mjs && node test/room-e2e.mjs && node test/app-e2e.mjs && node test/ui-browser-test.mjs
# 20/20 + 30/30 + 80/80 + 28/28（2026-09-29 v1.1.7 全绿）
# 真机手测（待用户）：说话停顿 ~1.5s 草稿即转正变深色；继续说则新草稿另起一行；
# 停止后无重复句；字聊对端看到气泡先无标点、随后原位更新为带标点终稿
```
