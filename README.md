# 听见（listen）

给听障人士的移动端优先实时语音转写 Web 应用。一部手机，说话即出字；异地家人也能扫码进来
用「文字聊天」的方式实时对话。面向 Cloudflare Workers 部署，整个服务端就是一个 Worker。

- **语音引擎**：火山引擎「豆包流式语音识别大模型」（v3 二进制协议，双向流式 WebSocket）
- **服务端**：单个 Cloudflare Worker——带鉴权的透明 WebSocket 代理 + 远程字聊房间（Durable Object）。
  火山凭证只存在 Worker secrets，永不下发前端
- **前端**：单文件 HTML（Vue 3 Options API + qrcode-generator，vendored 构建期内联，
  无运行时 CDN、无其他第三方依赖），PWA 可添加到主屏幕

规划与协议细节见 `PLAN.md`，实施进度见 `CHECKLIST.md`。

## 两种使用模式

### 1. 面对面单机转写（主形态）

一部手机放中间，屏幕实时出字。适合家人、就医、办事窗口等当面沟通场景。

### 2. 远程字聊（v1.1）

主机 ⚙ 菜单 → 远程字聊 → 生成一次性邀请码/二维码 → 异地家人**免密码**扫码（或微信长按识别
截图）加入 → 双方各持一机、各自转写，微信式气泡分侧显示（我右 / 对方左 + 名字标签，
草稿为半透明气泡，可同时说话互不干扰）。

- 适合**异地**家人（如听障老人 ↔ 远方孙辈）：像聊天室而非电话，双方都有思考反应的时间。
- 不支持同一房间双人各持一机（双麦克风串音会双转写）。
- 邀请码 10 分钟有效且一次性（首位加入即烧毁）；房间最长 2 小时、成员 2 人封顶；
  改密码即吊销全部房间。
- 费用提示：字聊期间**双方各占一条** ASR 流。

## 特性总览

**转写体验**
- 流式识别：草稿灰显实时增长，静音 ~1.5 秒自动「转正」为正式文本（不等服务端定稿）
- 续说拆行：转正后继续说，新增内容另起新行，不改写已转正的旧句；服务端改写早前文字时
  按最长公共前缀剥离，不会出现重复句
- 断线重连：指数退避自动重连，切网/后台恢复后已出文字不丢；历史记录一屏一记录，
  多次开始/停止只累计同一条

**适老化**
- 十二档 vh 字号（-2 ~ 9，默认 5），A- / A+ 大按钮即时调节并记忆
- 底部通栏三态主按钮（开始 / 正在听写·计秒 / 正在结束），开始/停止震动反馈
- 明暗双主题：跟随系统 + 按时段兜底 + 手动切换
- 已隔离微信「标准/大/特大」字号与系统字体对页面文字的影响；禁用双击/双指缩放

**稳定性与费用护栏**
- 票据 12 小时有效，过期用保存的密码静默续期（全程无感）
- 页面切后台/息屏超过 5 分钟自动停止听写（回前台提示、及时回来可取消）
- 单条识别会话 120 分钟硬顶（`MAX_SESSION_MINUTES` 可调）

**远程字聊**
- 二维码（微信长按识别可用）/ 6 位邀请码双入口，一次性 + 限时
- 气泡三重编码：对齐方向、颜色、名字标签；双方草稿（半透明气泡）并存，同时说话互不干扰
- 断线自动重连 + 服务器补发（backlog），定稿不丢；主机挂断 / 到期 / 退出各路径双端正确收尾
- 主机侧自动落历史（`我：` / `对方：` 前缀，说话人切换处空行）

**隐私与安全**
- 火山凭证只存 Worker secrets，代码 / 前端 / 日志零出现；Worker 只透传字节，不解析音频
- 密码 → HMAC 票据；`/api/auth` per-IP 防爆破（10 次失败锁 15 分钟）；
  `/ws` per-ticket 并发上限 2；`/api/join` per-IP 20 次/分钟
- 历史与草稿只存本机 localStorage，服务端不留存转写内容

## 架构

```
浏览器（16k PCM, AudioWorklet 降采样）
   │ wss /ws?ticket=（app 票据 或 房间 token）
   ▼
Cloudflare Worker（本仓库 worker.js）
   ├─ 验票 → 拨号火山 bigmodel_async（鉴权 Header）→ 双向原样字节透传
   ├─ POST /api/auth（密码 → 票据）、/api/room（建房）、/api/join（一次性邀请码）
   └─ ChatRoom Durable Object（每邀请码一个）：纯 JSON 文字中继、存储、心跳、到期关房
```

前端由 `src/deploy.js` 在构建期整体注入 `worker.js`（内联 CSS 与 vendored JS），
部署产物 = 一个 `worker.js` 文件。

## 部署

**先决条件**：

- 一个 [Cloudflare 账号](https://dash.cloudflare.com/)（免费计划即可，Durable Objects SQLite 免费额度可用）
- 火山引擎账号并开通「豆包流式语音识别大模型」，取得 **App ID** 与 **Access Token**
  （资源 ID 默认 `volc.bigasr.sauc.duration`，如需覆盖见下方配置表）

三个 secrets（缺一不可）：

| 名称 | 说明 |
| --- | --- |
| `ACCESS_PASSWORD` | 进入口令（改密码 = 吊销全部已发票据与房间） |
| `VOLC_APP_ID` | 火山引擎 App ID |
| `VOLC_ACCESS_TOKEN` | 火山引擎 Access Token |

### 方式一：Fork + Cloudflare Git 集成（推荐，免本地环境，push 即部署）

1. Fork 本仓库到自己的 GitHub；
2. Cloudflare Dashboard → **Workers & Pages → Create → Workers → Connect to Git**，选中 fork 的仓库；
3. 构建设置：
   - Build command：`npm install && npm run inject`
   - Deploy command：`npx wrangler deploy`
4. 首次部署后，在 Worker 的 **Settings → Variables and Secrets** 添加上述三个 Secret（类型选 Secret）；
5. 之后 push 到主分支即自动重新部署。

> 仓库里的 `worker.js` 已带注入好的前端，直接 `npx wrangler deploy` 也能跑；build 里保留
> `npm run inject` 是为了让 `src/` 的前端改动总是先注入再部署。

### 方式二：本地 wrangler CLI

```bash
git clone https://github.com/<你>/listen.git && cd listen
npm install

npx wrangler login
npx wrangler secret put ACCESS_PASSWORD
npx wrangler secret put VOLC_APP_ID
npx wrangler secret put VOLC_ACCESS_TOKEN

npm run deploy        # = npm run inject && npx wrangler deploy
```

### 方式三：Dashboard 粘贴（只适合临时体验，不推荐）

Workers → Create → 编辑器粘贴仓库里的 `worker.js` 全文，并在 Settings 里补三个 Secret。
⚠️ 需在 Dashboard 手动配置 Durable Object 绑定（class `ChatRoom`）与迁移，否则**远程字聊不可用**
（单机转写不受影响）。日常维护请用方式一/二。

### 部署后

- **强烈建议绑定自定义域名**（Custom Domains）：`*.workers.dev` 在大陆可达性不稳定；
- 冒烟验证：

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<域名>/api/auth \
     -H 'Content-Type: application/json' -d '{"password":"错误"}'   # 应 401
curl -s https://<域名>/manifest.webmanifest | head -3              # JSON 正常
# 真机（微信 + Safari + Chrome）：进入 → 开始听写 → 说中文出字 → 停止 → 历史可见
```

### 可选配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VOLC_RESOURCE_ID` | `volc.bigasr.sauc.duration` | 火山资源 ID |
| `VOLC_ENDPOINT` | `https://openspeech.bytedance.com/api/v3/sauc/bigmodel_async` | 火山接入点 |
| `MAX_SESSION_MINUTES` | `120` | 单条识别连接时长上限（计费护栏） |
| `JOIN_WINDOW_SECONDS` | `600` | 邀请码加入窗口 |
| `ROOM_TTL_MINUTES` | `120` | 字聊房间硬顶（DO alarm 到期关房清存储） |

## 费用

- **火山 ASR 按时长计费**：字聊期间双方各占一条流；页面后台超 5 分钟自动停止、
  会话 120 分钟硬顶均为护栏，避免忘记停止持续计费。
- **Cloudflare**：免费计划即可运行（Workers 请求额度 + Durable Objects SQLite 免费额度）；
  Worker 只透传音频字节，字聊房间只传文字。

## 本地开发

```bash
# 0) 依赖
npm install
cd test && npm install && cd ..   # 测试脚本依赖（test/ 不入库）

# 1) 本地密钥 .dev.vars（已 gitignore，不要提交）
cat > .dev.vars <<'EOF'
ACCESS_PASSWORD=test123
VOLC_APP_ID=<你的 APP ID>
VOLC_ACCESS_TOKEN=<你的 Access Token>
EOF

# 2) 注入前端到 worker.js 并起本地服务
npm run dev            # = node src/deploy.js && npx wrangler dev
#    打开 http://localhost:8787 ，密码 test123

# 3) 测试（另开终端，wrangler dev 需保持运行）
node test/core-test.mjs        # 协议帧构造/解析 + worklet DSP 单测（无需服务）
node test/app-e2e.mjs          # 应用逻辑全链路（真实识别 + 断线重连 + 持久化 + 字聊 + 静音转正）
node test/room-e2e.mjs         # 字聊后端（双客户端中继/一次性/过期/补发/关房；自起 :8788 短 TTL 实例）
node test/proto-test.mjs "ws://localhost:8787/ws?ticket=<ticket>"   # 经代理验证 /ws

# 浏览器渲染测试（可选，需 obscura serve --allow-private-network --port 9333）
node test/ui-browser-test.mjs
```

> 本机 wrangler dev 若报 glibc 过旧：跑一次 `./scripts/fix-workerd-glibc.sh`（幂等）。
> 改 PWA 图标：`node scripts/gen-icons.mjs`（重生成 `src/icons.js`）。

## 项目结构

```
worker.js          # Worker：前端注入宿主 + /api/auth 票据 + /ws 透明代理 + ChatRoom DO + manifest/图标
src/app.html       # 前端单页（listen-core 协议层 + listen-app Vue 应用，均可被测试提取）
src/style.css      # 设计 token（明/暗）+ vh 十二档字号 + 布局 + 字聊气泡
src/vendor/        # vue.global.prod.js / qrcode.min.js（vendored，deploy.js 内联，不压缩）
src/deploy.js      # 注入管线：内联 CSS → vendor 占位 → 压缩 → 转义 → 写 worker.js 标记区间
src/icons.js       # PWA 图标 base64（scripts/gen-icons.mjs 生成）
scripts/           # fix-workerd-glibc.sh / gen-icons.mjs
test/              # 协议/单测/E2E（不入库）
PLAN.md            # 架构实测结论 / 协议规范 / API / 前端与视觉设计（唯一真相源）
CHECKLIST.md       # 实施清单与勾选状态
```

## 边界与注意事项

- 必须 HTTPS（浏览器麦克风权限要求）；本地调试用 localhost 或局域网 HTTPS。
- 微信内打开可用（二维码支持「扫一扫」与截图长按识别两条路径）；iOS Safari ≥ 14.3。
- 远程字聊面向异地双方；同房间各持一机不适用（串音双转写）。
- 房间与票据均有硬性时效，服务端不持久化任何转写内容，历史只在本机。
