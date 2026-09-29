# 听见（listen）

给听障人士的移动端优先实时语音转写 Web 应用：说话人对着手机说话，屏幕实时显示文字。
面向面对面沟通场景（家人、就医、办事窗口），适老化是硬需求（vh 十档大字号）。

- **语音引擎**：火山引擎「豆包流式语音识别大模型」（v3 二进制协议，双向流式 WebSocket）
- **部署**：单个 Cloudflare Worker，作为带鉴权的透明 WebSocket 代理（火山凭证永不下发前端）
- **前端**：单文件 HTML（Vue 3 Options API，vendored 构建期内联，无运行时 CDN、无其他依赖）

规划与协议细节见 `PLAN.md`，实施进度见 `CHECKLIST.md`。

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
node test/app-e2e.mjs          # 应用逻辑全链路（经本地 worker 真实识别 + 断线重连 + 持久化）
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
worker.js          # Worker：前端注入宿主 + /api/auth 票据 + /ws 透明代理 + manifest/图标
src/app.html       # 前端单页（listen-core 协议层 + listen-app Vue 应用，均可被测试提取）
src/style.css      # 设计 token（明/暗）+ vh 十档字号 + 布局
src/vendor/        # vue.global.prod.js（vendored，deploy.js 内联，不压缩）
src/deploy.js      # 注入管线：内联 CSS → vendor 占位 → 压缩 → 转义 → 写 worker.js 标记
src/icons.js       # PWA 图标 base64（scripts/gen-icons.mjs 生成）
scripts/           # fix-workerd-glibc.sh / gen-icons.mjs
test/              # 协议/单测/E2E（不入库）
API_KEY.txt        # 火山凭证（gitignore，绝不入库）
```

## 安全要点

- 火山凭证只存在 Worker secrets（`wrangler secret put`），代码/前端/日志零出现
- 密码 → 12h HMAC 票据；改密码即吊销全部存量票据
- `/api/auth` per-IP 防爆破（10 次失败锁 15 分钟）；`/ws` per-ticket 并发上限 2
- 会话时长上限 120 分钟（`MAX_SESSION_MINUTES` 可调）= 计费护栏
