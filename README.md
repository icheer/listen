# 听见（listen）

给听障人士的移动端优先实时语音转写 Web 应用：说话人对着手机说话，屏幕实时显示文字。
面向面对面沟通场景（家人、就医、办事窗口），适老化是硬需求（vh 十档大字号）。

- **语音引擎**：火山引擎「豆包流式语音识别大模型」（v3 二进制协议，双向流式 WebSocket）
- **部署**：单个 Cloudflare Worker，作为带鉴权的透明 WebSocket 代理（火山凭证永不下发前端）
- **前端**：单文件 HTML（Vue 3 Options API，vendored 构建期内联，无运行时 CDN、无其他依赖）

规划与协议细节见 `PLAN.md`，实施进度见 `CHECKLIST.md`。

## 两种模式

1. **面对面单机转写**（主形态）：一部手机放中间，屏幕实时出字。
2. **远程字聊**（v1.1）：主机 ⚙ 菜单 → 远程字聊 → 生成一次性邀请码/二维码 → 异地家人
   **免密码**扫码（或微信长按识别截图）加入 → 双方各持一机、各自转写，微信式气泡分侧显示
   （我右/对方左 + 名字标签，草稿为半透明气泡，可同时说话互不干扰）。
   - 适合**异地**家人（如听障老人 ↔ 远方孙辈）；不支持同房间双人各持一机（双麦克风串音会双转写）。
   - 安全边界：邀请码 10 分钟有效且一次性（首位加入即烧毁）、房间最长 2 小时、成员 2 人封顶；
     访客无密码级权限（仅房间 + 自己的转写通道）；改密码即吊销全部房间。
   - 费用提示：字聊期间**双方各占一条** ASR 流。
   - 房间中继 = 每 invite 码一个 Durable Object（SQLite 存储，免费计划可用），只传文字不传音频。

## 本地开发

```bash
# 0) 依赖
npm install
cd test && npm install && cd ..   # 测试脚本依赖（test/ 不入库）

# 1) 本地密钥 .dev.vars（已 gitignore，不要提交）
#    火山凭证抄自 API_KEY.txt（该文件绝不入库）
cat > .dev.vars <<'EOF'
ACCESS_PASSWORD=test123
VOLC_APP_ID=<你的 APP ID>
VOLC_ACCESS_TOKEN=<你的 Access Token>
EOF

# 2) 注入前端到 worker.js 并起本地服务
npm run dev            # = node src/deploy.js && npx wrangler dev
#    打开 http://localhost:8787 ，密码 test123

# 3) 测试（另开终端，wrangler dev 需要保持运行）
node test/core-test.mjs        # 协议帧构造/解析 + worklet DSP 单测（无需服务）
node test/proto-test.mjs       # 直连火山全链路（需 VOLC_APP_ID/VOLC_ACCESS_TOKEN 环境变量）
node test/app-e2e.mjs          # 应用逻辑全链路（经本地 worker 真实识别 + 断线重连 + 持久化 + 远程字聊）
node test/room-e2e.mjs         # 远程字聊后端（双客户端中继/一次性/过期/补发/关房；自起 :8788 短 TTL 实例）
node test/proto-test.mjs "ws://localhost:8787/ws?ticket=<ticket>"   # 经代理验证 /ws

# 浏览器渲染测试（可选，需 obscura serve --allow-private-network --port 9333）
node test/ui-browser-test.mjs
```

> 本机 wrangler dev 若报 glibc 过旧：跑一次 `./scripts/fix-workerd-glibc.sh`（幂等）。
> 改 PWA 图标：`node scripts/gen-icons.mjs`（重生成 `src/icons.js`）。

## 部署

```bash
npx wrangler login
npx wrangler secret put ACCESS_PASSWORD    # 正式进入口令（改密码 = 吊销全部已发票据）
npx wrangler secret put VOLC_APP_ID        # 来自 API_KEY.txt
npx wrangler secret put VOLC_ACCESS_TOKEN  # 来自 API_KEY.txt
npm run deploy                              # = node src/deploy.js && npx wrangler deploy
```

- **自定义域名强烈建议**：`*.workers.dev` 在大陆可达性不稳定（Cloudflare Zero Trust → Custom Domains）。
- 部署后冒烟：
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<域名>/api/auth \
       -H 'Content-Type: application/json' -d '{"password":"错误"}'   # 应 401
  curl -s https://<域名>/manifest.webmanifest | head -3              # JSON 正常
  # 真机（微信 + Safari + Chrome）：进入 → 开始听写 → 说中文出字 → 停止 → 历史可见
  ```

## 结构

```
worker.js          # Worker：前端注入宿主 + /api/auth 票据 + /ws 透明代理 + ChatRoom DO + manifest/图标
src/app.html       # 前端单页（listen-core 协议层 + listen-app Vue 应用，均可被测试提取）
src/style.css      # 设计 token（明/暗）+ vh 十档字号 + 布局 + 字聊气泡
src/vendor/        # vue.global.prod.js / qrcode.min.js（vendored，deploy.js 内联，不压缩）
src/deploy.js      # 注入管线：内联 CSS → vendor 占位 → 压缩 → 转义 → 写 worker.js 标记
src/icons.js       # PWA 图标 base64（scripts/gen-icons.mjs 生成）
scripts/           # fix-workerd-glibc.sh / gen-icons.mjs
test/              # 协议/单测/E2E（不入库）
API_KEY.txt        # 火山凭证（gitignore，绝不入库）
```

## 安全要点

- 火山凭证只存在 Worker secrets（`wrangler secret put`），代码/前端/日志零出现
- 密码 → 12h HMAC 票据；改密码即吊销全部存量票据（含远程字聊房间 token）
- `/api/auth` per-IP 防爆破（10 次失败锁 15 分钟）；`/ws` per-ticket 并发上限 2；`/api/join` per-IP 20 次/分钟
- 远程字聊：邀请码一次性 + 10 分钟窗口；房间 2h 硬顶（DO alarm 关房清存储）；成员 2 封顶
- 会话时长上限 120 分钟（`MAX_SESSION_MINUTES` 可调）= 计费护栏
