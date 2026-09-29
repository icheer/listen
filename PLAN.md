# 听见（listen）— 项目规划 v1.1

> 给听障人士的移动端优先实时语音转写 Web 应用：说话人对着手机说话，屏幕上实时出字。
> 语音引擎：火山引擎「豆包流式语音识别大模型」（v3 协议，双向流式 WebSocket）。
> 部署：单个 Cloudflare Worker（同构参考 `../jev-decides`）。
> 实施步骤见 `CHECKLIST.md`。协议实测细节见 §4 与附录 A。
> v1.1 增补：**远程字聊**（双机气泡聊天室，§11；2026-09-29 拍板：上 Durable Object / 微信式气泡 / 两人封顶 / 对方固定显示「对方」）。

## 0. 产品定位与形态

- **目标用户**：听障人士 + 老年听障用户（低视力友好是硬需求）；使用场景是面对面沟通——家人、就医、办事窗口。
- **一句话**：打开网页 → 输入密码 → 点一个大按钮 → 屏幕实时显示对方说的话。
- **双模式（v1.1 起）**：① 面对面单机转写（主形态，如上）；② **远程字聊**——主机生成一次性邀请码/二维码，异地家人免密码加入文字聊天室，双方各持一机、各自转写、气泡分侧显示（设计与边界见 §11）。
- **核心体验指标**（按重要性排序）：
  1. **首字延迟**（说完一句话到第一个字出现）：目标 < 1.5s，常态 0.6–1.2s
  2. **跟字流畅度**：后续文字随语音连续上屏，无卡顿感
  3. **可读性**：字号够大、对比度够高、状态一眼可辨
  4. **稳定性**：长时间收音不断流、断网可恢复
- **命名**：听见（worker 名 `listen`），页面标题「听见 · 实时字幕」。

### 硬约束（设计前提）

1. 只用火山引擎一个 ASR 服务，端点 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`（双向流式优化版，已实测可用），resource id `volc.bigasr.sauc.duration`（账号已开通，已实测）。
2. 火山引擎凭证（APP ID / Access Token）**只存在 Worker secrets 里，永不下发前端**（见 §2 架构决策）。
3. 前端唯一依赖 Vue 3（**Options API 写法**）：副本 vendor 到 `src/vendor/vue.global.prod.js`（与 jev-decides 同版本 3.5.22），由 deploy.js **构建期内联**进单文件 HTML——无运行时 CDN（大陆访问 unpkg/jsdelivr 不稳），除此之外零第三方库、无构建框架。音频不经任何转码，采集即 16k PCM 直发。
4. 密码预先配置在环境变量 `ACCESS_PASSWORD`；用户输入密码换取**短时会话票据**（不是模型密钥）。
5. 移动端优先；必须 HTTPS（麦克风权限要求）；微信内置浏览器、iOS Safari ≥ 14.3 需可用。

## 1. 架构决策（含实测证据，2026-09-29 用真实凭据验证）

### 1.1 为什么不能「客户端直连火山引擎」

用户最初的设想是前端拿密钥直连模型端点（延迟最低）。**实测证明此路不通**：

| 实验 | 结果 |
| --- | --- |
| Header 鉴权握手（`X-Api-App-Key` 等 4 个 Header） | ✅ HTTP 101，全链路识别成功 |
| query 参数鉴权（`app_id`/`token`、Header 名做 query 键等 4 种变体） | ❌ 全部 400，`get resource id empty` |
| `Sec-WebSocket-Protocol` 夹带凭证 | ❌ 400 |

浏览器原生 WebSocket API **无法设置自定义请求头**（规范限制）。v3 大模型端点只认 Header 鉴权 → 直连不可能。
（老版 v2 端点 `/api/v2/asr` 支持 query 鉴权可直连，但那是非大模型的老 ASR，质量/标点/数字规范化差，且 Access Token 必须明文下发前端——已排除，用户已确认。）

### 1.2 采用架构：Worker 作透明 WebSocket 代理

```
┌─────────┐  HTTPS POST /api/auth {password}        ┌──────────────────┐
│ 浏览器   │ ──────────────────────────────────────▶ │ Cloudflare Worker │
│         │ ◀──────────────── ticket (12h) ───────── │  (本项目)          │
│ 麦克风 → │                                         │                  │
│ 16k PCM │  WebSocket /ws?ticket=xxx                │ fetch + Upgrade:  │
│ 二进制帧 │ ◀═════════ 纯字节透传，不解析 ═══════════▶ │ websocket + 4个鉴权 │
└─────────┘                                         │ Header → 上游      │
                                                    └────────┬─────────┘
                                                             │ wss (带 Header)
                                                    ┌────────▼─────────┐
                                                    │ 火山引擎 bigmodel │
                                                    │ _async (豆包大模型)│
                                                    └──────────────────┘
```

- **Worker 只做三件事**：① 校验 ticket → ② 用 secrets 里的凭证向上游发起带 Header 的 WebSocket 升级（这是浏览器做不到、Worker `fetch` 能做的关键点）→ ③ 两个方向的原样字节转发。不解析音频、不组装协议帧（协议帧全部由客户端构造，帧格式见 §4）。
- **延迟代价（诚实预期）**：相比理论直连多一跳「用户↔CF 边缘↔火山」。国内用户到 CF 边缘通常 30–80ms，CF 边缘（多为香港/日本）到火山（华北）约 30–80ms，**单方向增加约 50–150ms**。首字延迟预算分解见 §8。CF Workers 对 WebSocket 无请求时长硬限制，长连接可行。
- **安全收益**：火山凭证永不出 Worker；密码只换出短时票据；票据泄露最多 12h 且不能提取凭证。

### 1.3 与 jev-decides 的同与不同

沿用的约定：单 worker（`worker.js` + `src/app.html` + `src/style.css` + `src/deploy.js` 注入管线）、secrets 不进 wrangler.toml、`PLAN.md`+`CHECKLIST.md` 分阶段实施与验收、`.dev.vars` 本地开发。

不同点（有意为之）：① 同为 Vue3 Options API，但改为**构建期内联 vendored 副本**而非运行时 CDN（国内访问 unpkg/jsdelivr 不稳，内联省一次 DNS+TLS+往返，且整页可缓存）；② 无 KV、无数据库（v1 不需要，见 §6 滥用防护的取舍）；③ 前代项目 `../listen-old`（三年前基于讯飞 RTASR demo 手改的「听见」，真实给家人用过）——其 UX 结论经过实战验证，扬弃清单见 §4.0。

## 2. 火山引擎 v3 协议规范（已实测验证）

> 实测时间 2026-09-29，场景 t1–t4（gzip/raw 音频、bigmodel/bigmodel_async、full/single），全部成功。附录 A 有可复跑脚本。

### 2.1 连接

- 端点：`https://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`（Worker fetch 时用 https + `Upgrade: websocket`）
- Header：`X-Api-App-Key: <APP ID>`、`X-Api-Access-Key: <Access Token>`、`X-Api-Resource-Id: volc.bigasr.sauc.duration`、`X-Api-Connect-Id: <uuid>`（建议传，便于排障）
- 握手失败即 HTTP 4xx（400 参数/凭证格式错，403 服务未开通）。握手中 `Connection: Upgrade` 必须走 HTTP/1.1。

### 2.2 二进制帧格式（所有消息共用 4 字节头，大端）

```
byte0: 协议版本(4b)=0001 | 头大小(4b)=0001          → 0x11
byte1: 消息类型(4b)     | 类型相关标志(4b)
byte2: 序列化方式(4b)   | 压缩方式(4b)
byte3: 保留 = 0x00
之后: [flags 含 0001 时] 4 字节 sequence(signed int32) + 4 字节 payload 长度 + payload
```

| 消息类型 | byte1 高 4 位 | 客户端用法 |
| --- | --- | --- |
| full client request | 0b0001 | 会话首帧：JSON 配置。flags=0000，序列化=0001(JSON)，压缩=0001(gzip) 或 0000。帧头 `11 10 11 00`（gzip）或 `11 10 10 00`（raw） |
| audio only request | 0b0010 | 音频帧。序列化=0000，压缩 0000(raw PCM，已实测可用) 或 0001(gzip)。帧头 `11 20 00 00`（raw） |
| full server response | 0b1001 | 服务端响应。flags=0001（后随正 sequence）或 0011（最后一帧，sequence 为负） |
| error response | 0b1111 | 错误帧：头后直接 4 字节错误码 + 4 字节消息长度 + 消息文本 |

- 音频帧 flags：普通包 `0000`；**最后一包 `0010`**（不随 sequence）。实测发送 `11 22 01 00`（gzip 尾包）成功；raw 音频时尾包压缩位为 0。
- 服务端响应的压缩方式跟随客户端配置帧：配置帧 gzip → 响应也 gzip（需 gunzip）；配置帧 raw → 响应 raw。客户端按 byte2 低 4 位分支。
- sequence 是**响应计数器**（优化版端点只在结果变化时返回，序号不与输入包对齐），不要拿它对账。

### 2.3 配置帧 payload（JSON，本项目固定参数）

```json
{
  "user": { "uid": "listen-web" },
  "audio": { "format": "pcm", "rate": 16000, "bits": 16, "channel": 1 },
  "request": {
    "model_name": "bigmodel",
    "enable_punc": true,
    "enable_itn": true,
    "enable_ddc": false,
    "show_utterances": true,
    "result_type": "single"
  }
}
```

- `enable_punc` 标点；`enable_itn` 数字归一化（“三个”→“3个”）；`enable_ddc` 语义顺滑（去语气词）默认关——保留原文更接近原话，后续可在设置里开放。
- `result_type: "single"` 增量模式：响应只含新增/变化的 utterance，长会话不重传全量（实测确认）。
- `show_utterances: true` 才有 definite/interim 语义，渲染依赖它。

### 2.4 响应 payload（JSON）

```json
{
  "audio_info": { "duration": 2924 },
  "result": {
    "additions": { "log_id": "..." },
    "text": "…当前累计文本…",
    "utterances": [
      { "text": "她有三个孩子。", "definite": true,  "start_time": 200,  "end_time": 2820, "words": [...] },
      { "text": "今天天气",       "definite": false, "start_time": 2900, "end_time": 3400, "words": [...] }
    ]
  }
}
```

- **definite=true** → 该句已定稿，追加为正式行；**definite=false** → 句末进行中的草稿，灰色渲染、随时被替换。
- 一个响应可含 0..n 个 definite + 最多 1 个非 definite。客户端累积算法见 §5.3。
- `audio_info.duration`（毫秒）可用于会话时长展示。

### 2.5 错误码与会话生命周期（实测 + 官方文档）

| 错误码 | 含义 | 客户端处置 |
| --- | --- | --- |
| 45000001 | 请求参数不合法 | 不重试，提示配置错误（开发期 bug） |
| 45000002 | 音频为空/过短 | 忽略，等下一包 |
| 45000081 | **等包超时**（客户端停发音频太久） | 自动重连（新会话），已定稿文本保留 |
| 45000151 | 音频格式不匹配 | 不重试，检查采样率/位深 |
| 55000031 | 并发超限 | 3s 后重连 |

- **服务端行为（实测）**：收到最后一包（flags 0010）→ 回最终响应（flags 0011，definite 全部定稿）→ **服务端主动关闭连接**（code 1000, reason "finish last sequence"）。
- 一条连接 = 一个会话；只要不发尾包、持续供音频，连接可长时间保持（本项目由 Worker 的会话时长上限兜底）。
- 停止收音流程：发尾包（若无待发数据，附 100ms 静音数据）→ 等 flags 0011 最终响应 → 服务端关闭 → 停麦克风。

## 3. Worker API 设计

```
GET  /                      → 单文件前端（deploy.js 注入，Cache-Control 短缓存）
GET  /favicon.svg           → 内联 SVG 图标
GET  /manifest.webmanifest  → PWA manifest（Phase 6）
POST /api/auth              → 鉴权换票
POST /api/room              → 建字聊房间（凭 host ticket）→ {code, token, joinUrl, …}（§11）
POST /api/join              → 访客用一次性 code 换 room token（§11）
GET  /j/:code               → 访客落地页（同一份前端，按路径进访客模式）（§11）
GET  /room/:code?token=     → 房间 WebSocket → ChatRoom DO 文本中继（§11）
GET  /ws?ticket=<ticket>    → WebSocket 升级 → 代理到火山引擎（v1.1 起也接受 room token，§11）
```

### 3.1 `POST /api/auth`

- body：`{"password": "..."}`；`ACCESS_PASSWORD` 环境变量比对（常量时间比较）。
- 成功：`{"ticket": "...", "expiresAt": 1696000000000}`。
- ticket = `b64url(JSON{ jti, exp }) + "." + b64url(HMAC-SHA256(payload, key))`；key = `SHA256(ACCESS_PASSWORD + "listen-ticket-v1")`——**改密码即吊销全部存量 ticket**，无需额外 secret。
- TTL 12 小时（长对话场景不宜太短）。jti 用 `crypto.randomUUID()`。
- 防爆破：内存计数 per-IP（10 次失败锁 15 分钟；per-isolate 尽力而为，够用）。
- 失败：401 `{"error": "密码不对，请重试"}`。

### 3.2 `GET /ws?ticket=...`（核心代理）

1. 校验 ticket（HMAC + exp）→ 失败返回 401（客户端据此静默重新 `/api/auth`）。
2. `fetch(VOLC_ENDPOINT, { headers: { Upgrade: websocket, X-Api-App-Key, X-Api-Access-Key, X-Api-Resource-Id, X-Api-Connect-Id: jti } })`；若响应无 `webSocket` → 502 `{"error":"服务配置错误"}`（凭证/服务问题，文案区分于网络问题）。
3. `upstream.webSocket.accept()`；`new WebSocketPair()` 建客户端侧；双向 `message` 事件原样转发（ArrayBuffer 直传，不 inspect）。
4. 双向 close/error 传播（带 code/reason）。
5. 会话时长兜底：连接首包时间 + `MAX_SESSION_MINUTES`（默认 120，env 可调）超时 → close(1008, "session limit")。计费按音频时长，这是成本护栏。
6. 环境变量：`ACCESS_PASSWORD`、`VOLC_APP_ID`、`VOLC_ACCESS_TOKEN`、（可选）`VOLC_RESOURCE_ID`（默认 `volc.bigasr.sauc.duration`）、`VOLC_ENDPOINT`（默认优化版端点）、`MAX_SESSION_MINUTES`（默认 120）。

## 4. 前端设计

### 4.0 对 listen-old（前代「听见」）的扬弃

前代项目是讯飞 RTASR demo 手改版（Vue 2 + ScriptProcessor + 讯飞私有协议），给家人真实使用过，UX 结论可信。继承与弃用如下：

**继承（实战验证过的 UX）**

| 项 | 旧版做法 | 本项目 |
| --- | --- | --- |
| 产品名 | 「听见」 | 沿用（用户已熟悉，页面标题同为「听见」） |
| 字号刻度 | **vh 单位 10 档**：4.2/5.0/…/11.4vh（0.8vh 步进），默认第 5 档 8.2vh（≈手机 55–70px），localStorage 持久化 | 原样沿用刻度与默认值——老年真实用户习惯不重学 |
| 布局 | 全屏转写区 + 底部通栏主按钮（状态+时长内嵌按钮文案：`开始听写` / `正在听写（12:34）` / `正在结束...`）+ 次级「清空」「复制」；字号 ± 浮动右上角 | 沿用此骨架，新增 ⚙ 菜单与草稿字灰显 |
| 密码门 | localStorage 记住 + 3 次失败踢出 | 保留「记住密码」默认开，改为正规密码屏（旧版用 `prompt()`） |
| 深色主题 | 按时段自动（19:00–7:00 深色） | 跟随系统偏好；系统无偏好时按时段兜底（沿用旧规则） |
| 转写持久化 | result 实时写 localStorage，刷新不丢 | 沿用：当前文本每 30s + pagehide 落盘，重载恢复 |
| 复制 | ClipboardJS | 改原生 `navigator.clipboard`（降级 execCommand） |

**弃用（技术已过时或讯飞特有）**

- `createScriptProcessor`（已废弃、主线程卡顿）→ AudioWorklet
- 重采样写死 44100→16000 → 按 `AudioContext.sampleRate` 实际值计算（Android/iOS 多为 48000）
- 字节管线 `Array.from(Int8Array)` + `buffer.push(...)`（逐字节 JS 数组 + spread，GC 压力/栈风险）→ transferable `ArrayBuffer` 直传
- 40ms×1280B 分包（讯飞规范）→ 火山规范 200ms×6400B
- 5 分钟自动停止（讯飞计费约束）→ 不设客户端强制停止，改 Worker 120min 兜底（§3.2）
- 无断线重连、无 wakeLock、无中间结果渲染 → 本项目全部补上
- Vue 2（`new Vue({el})`）→ Vue 3 Options API（`createApp`）

### 4.1 屏幕与状态机

两屏：**密码门** → **主界面**。主界面状态机：

```
idle ──点开始──▶ connecting ──ws open──▶ listening ──点停止──▶ stopping ──最终响应+关闭──▶ idle
                    │                        │
                    └── 失败/断线 ◀──────────┘
                          │ 自动重连（指数退避 1s/2s/4s/8s/16s，最多 5 次）
                          ▼ 失败
                       error（显示人话错误 + 大号「重试」按钮）
```

- 重连成功 = 新会话，转写区插入一条浅色分隔（时间），已定稿文本保留继续往下滚。
- ticket 过期（/ws 返回 401）→ 用已保存密码静默换票再重连（无感）；密码也被清掉才回密码门。

### 4.2 音频采集管线（延迟关键路径）

```
getUserMedia({audio:{channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true}})
  → AudioContext (native 采样率 44.1/48k)
  → AudioWorklet（Blob URL 内联，单文件无外部文件）
      每 128 帧回调：Float32 → 累积 → 降采样到 16k（线性插值）→ Int16
      每 200ms（3200 样本/6400 字节）postMessage 一块
  → 主线程：ws.send(音频帧[11 20 00 00 + len + pcm])
```

- 200ms 分包是官方对双向流式的推荐值（Phase 4 验收时可 A/B 100ms 对比首字手感）。
- raw PCM 直发（实测可用），省掉浏览器 gzip，减少主线程开销；上行带宽 32KB/s，4G/WiFi 无压力。
- 配置帧需要 gzip（`CompressionStream('gzip')`，Chrome 80+/Safari 16.4+）；**降级**：不支持时发 raw JSON 配置帧（协议允许压缩位=0），两者实测均可，客户端按响应头压缩位分支解压（`DecompressionStream` 同理降级）。
- 连接打开顺序：`/ws` open → 发配置帧 → 启动音频管线；重连时麦克风不关，只重建 WS + 重发配置帧。
- ⚠️ 实现时勿照抄 `../listen-old` 的音频代码：ScriptProcessor、写死 44100、逐字节数组三条都是坑（详见 §4.0 弃用清单）。worklet 间通信一律 transferable `ArrayBuffer`，主线程只做 `ws.send`。

### 4.3 转写渲染算法

```
状态: finalLines[] (定稿行), interimText (草稿), committedKeys Set
onResponse(utterances):
  for u of utterances where u.definite:
      key = `${u.start_time}-${u.end_time}`
      if key not in committedKeys: finalLines.push({text: u.text}); committedKeys.add(key)
  interimText = (utterances 中最后一个非 definite)?.text ?? ""
渲染: finalLines 各一行（追加式 DOM，勿全量重绘）+ 末尾一行 interimText（灰色）
```

- 自动滚到底部；用户手指上滑查看历史时暂停自动滚动，回到底部（显示「↓ 回到最新」浮标）再恢复。
- 定稿行与草稿行都用 `text` 字段；`words` 时间戳 v1 不用。

### 4.4 适老化与无障碍（硬需求）

| 项 | 设计 |
| --- | --- |
| 字号调节 | **沿用旧版 vh 刻度**：10 档 4.2–11.4vh（0.8vh 步进，class `.font-0`…`.font-9`），默认 `fontSize=5`（8.2vh，手机上 ≈55–70px）。右上角浮动 A- / A+（即 `-`/`+`，触控 ≥48px），档位即时生效，localStorage `fontSize` 持久化（沿用旧版键名），行高 1.35 随动 |
| 状态可辨识 | 状态点 + **文字**（正在收音 / 连接中… / 出错了），不只靠颜色；红绿之外加图标形状差异 |
| 触控目标 | ≥ 48×48px；主按钮为底部通栏（高 ≥56px），次级按钮高 ≥48px |
| 震动反馈 | 开始/停止 `navigator.vibrate(50)`（支持时） |
| 屏幕常亮 | `navigator.wakeLock('screen')`，visibilitychange 重新获取——长对话手机不能灭屏，**核心需求** |
| 对比度 | 定稿字 vs 背景对比度 ≥ 7:1（AAA）；草稿字 4.5:1 |
| 深色模式 | 跟随 `prefers-color-scheme`；系统无偏好时按时段兜底（19:00–7:00 深色，沿用旧版规则）+ 手动切换，localStorage 记忆 |

### 4.5 主界面布局（移动优先，沿用旧版骨架）

```
┌────────────────────────────┐
│ ⚙                [-] [+]    │  ← 左上菜单；右上字号浮动钮（≥48px 触控）
│                            │
│  转写文本行…（定稿，深色粗字）│  ← 全屏滚动区（flex-1）
│  转写文本行…                │
│  灰色草稿字…（进行中句）     │
│          [↓ 回到最新]（浮标） │
├────────────────────────────┤
│ [ ● 正在听写（12:34）      ] │  ← 底部通栏主按钮：
│ [   清空   ]  [   复制   ]  │     状态+时长内嵌（沿用旧版）
└────────────────────────────┘
```

- 主按钮三态文案（沿用旧版）：`开始听写`（绿）/ `● 正在听写（mm:ss）`（红 + 呼吸动画）/ `正在结束...`（禁用灰）；点击即开始/停止，`navigator.vibrate(50)` 震动反馈。
- 状态额外用颜色 + 圆点图标区分（不只靠颜色）；错误态主按钮变「重试」。
- ⚙ 菜单（收起面板）：复制全文、清空屏幕、历史记录、深色模式、退出密码。停止后转写文本留在屏上；再点开始 = 新会话往下追加（时间分隔行）。
- 草稿字灰显是旧版 textarea 做不到的升级（单色单块），Vue 渲染 `<p>` 列表 + 末尾草稿行实现。

### 4.6 转写持久化与历史记录（Phase 6）

- **刷新恢复（沿用旧版体验）**：当前屏幕文本每 30s + `pagehide` 写 localStorage `listen_draft`（`{text, savedAt}`），重载时恢复显示并顶部标注「上次内容 · 可清空」；点开始新会话后草稿归档进历史。
- 历史 localStorage `listen_sessions`：`[{id, startedAt, endedAt, text}]`，停止时落一条（text = 全部定稿行拼接）；上限 50 条、总量 < 2MB 超出删最旧。
- 历史面板：列表（起止时间 + 预览）→ 点开全文 → 复制 / 删除。

## 5. 视觉规范（token）

| token | 值 | 用途 |
| --- | --- | --- |
| `--surface` | `#FFFFFF` / 深色 `#121417` | 背景 |
| `--text-main` | `#0F172A` / `#F1F5F9` | 定稿文字（对 surface ≥7:1） |
| `--text-interim` | `#8A929E` / `#98A1AC` | 草稿文字 |
| `--brand` | `#0E7A5F`（深青绿） | 主按钮/收音状态 |
| `--danger` | `#C2410C`（暗橙红） | 停止按钮/错误 |
| `--divider` | `#E7E5E4` / `#2A2E33` | 分隔线/边框 |
| 字号阶梯 | **vh 十档**（转写区）：4.2 / 5.0 / 5.8 / 6.6 / 7.4 / 8.2 / 9.0 / 9.8 / 10.6 / 11.4vh，默认 8.2vh · 辅助信息（菜单/按钮）13–17px 固定 | |
| 圆角/间距 | 按钮 999px；卡片 12px；页边距 16px | |

- 字体：`system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`。
- 不做花哨动效；唯一动画是收音中主按钮呼吸（1.6s ease-in-out，弱视可感知）。

## 6. 安全与滥用防护

1. 火山凭证只进 `wrangler secret`，代码/前端/日志零出现；`API_KEY.txt` 必须 `.gitignore`。
2. 密码 → 短时 ticket（HMAC 防伪、12h 过期、改密全吊销）；ticket 只用于本 Worker 的 `/ws`，拿不到火山凭证。
3. `/api/auth` per-IP 防爆破（内存尽力而为）；`/ws` 并发上限 per ticket 2 条（内存 Map，尽力而为）。
4. 会话时长上限（默认 120 分钟）= 计费护栏（火山按时长计费）。
5. 明确不做（v1 取舍）：KV 全局限频、票据撤销列表——单人/小家庭场景收益低，复杂度高。后续要开放给更大群体再加。
6. 远程字聊的访客面（v1.1，§11.2）：一次性邀请码（10 分钟加入窗口）+ 房间 2h 硬顶 + 成员 2 封顶；访客 token 仅限房间与 ASR、拿不到密码级权限；改密码连坐吊销房间 token。

## 7. 性能预算（首字延迟分解）

```
语音结束 → AudioWorklet 攒满 200ms 包        ~200ms（固有大包延迟）
  + 采集→主线程→ws.send                       <5ms
  + 用户→CF 边缘 (1/2 RTT)                    20~80ms（国内↔CF）
  + Worker 转发 (fetch hop)                   ~5ms
  + CF 边缘→火山 (1/2 RTT)                    20~80ms
  + ASR 出首字 (模型)                         200~600ms
  + 返回路径 (同上两跳)                        40~160ms
─────────────────────────────────────────────
首字合计                                     ≈ 0.5~1.1s   目标 <1.5s ✅
```

优化手段（按需）：分包降到 100ms 实验；`enable_accelerate_text`（官方首字加速，略降准确率，设置里可开）；CF 部署区域观察（自定义域名对中国用户路由更优，见 §9）。

## 8. 边界与降级

| 情形 | 处置 |
| --- | --- |
| 麦克风权限拒绝 | 全屏引导：浏览器设置路径图解（微信/iOS Safari/Chrome 各一版文案），「重新授权」按钮 |
| 非安全上下文（http） | 检测 `isSecureContext`，提示需 HTTPS |
| 微信内置浏览器 | getUserMedia 现代版本可用；Phase 4 真机验收必须覆盖微信；若机型异常提示「…用系统浏览器打开」 |
| 断网/切后台 | WS 断开自动重连（后台时 AudioWorklet 停供 → 45000081，回前台重连）；iOS 后台音频挂起属预期 |
| 上游 502（凭证/服务问题） | 错误页提示「服务配置错误，联系管理员」，不自动重试 |
| 用户锁屏/来电 | 页面 visibilitychange → 恢复时检查连接并重连 |
| 数据清理 | 「清空屏幕」只清当前显示；历史按条删 |

## 9. 部署

```bash
# secrets（正式值，来自 API_KEY.txt / 自定密码）
npx wrangler secret put ACCESS_PASSWORD
npx wrangler secret put VOLC_APP_ID
npx wrangler secret put VOLC_ACCESS_TOKEN
node src/deploy.js && npx wrangler deploy
```

- 域名：`*.workers.dev` 在大陆可达性不稳定，**建议绑定自定义域名**（Cloudflare Zero Trust → Custom Domains），与 jev-decides 经验一致。
- 部署后冒烟：密码换票 → /ws 握手 → 手机真机转写。

## 10. 分期概览（细目见 CHECKLIST.md）

| Phase | 内容 | 关键验收 |
| --- | --- | --- |
| 0 | 脚手架与注入管线 | deploy.js 注入 + wrangler dev 出页面 |
| 1 | 票据鉴权 | curl 换票/防伪/防爆破 |
| 2 | WebSocket 代理 | node 脚本经本地 worker 全链路真实识别成功 |
| 3 | 浏览器音频链路 | 页面 console 看到增量识别 JSON |
| 4 | 转写主界面 | 真机中文连续对话 5 分钟不断流 |
| 5 | 适老化与稳定性 | 锁屏常亮/断网恢复/字号十档手测 |
| 6 | 历史 + PWA + 收尾 | 线上全流程回归 + README/CLAUDE.md |
| 7 | Durable Object 房间与后端（v1.1） | room-e2e 双客户端全场景（中继/一次性/过期/补发） |
| 8 | 前端字聊界面（气泡/邀请/访客） | app-e2e + ui-browser 扩展；真机双人冒烟 |
| 9 | 双端联调与收尾（v1.1） | 真机双端全流程（微信两种进入方式） |

---

## 11. 远程字聊（chat 模式，v1.1）

### 11.0 定位与场景边界

- **形态**：不是「打电话」，是**实时双向字聊房间**——两端各有麦克风 + 屏幕，各自跑一条 ASR 流，文字经房间中继互达。无通话压力、可回看、可导出；WiFi-only 无 SIM 设备可用；跨境零漫游。
- **目标场景**：异地家人——听障老人 ↔ 听力正常孙辈（典型：爷爷 ↔ 7 岁孙女）。
- **边界（明示不做）**：**不支持同房间两人各持一机**——两个麦克风互相串音，同一句话会被两条 ASR 流各转一遍。面对面继续用单机模式；邀请页明示「适合异地家人」。
- **架构红利**：线上**只传文字不传音频**——无回声、无 AEC、无音频带宽问题；每端麦克风只听面前的人。

### 11.1 架构：ASR 链路零改动 + 第二条纯文本 WS

```
主机（密码登入，菜单「远程字聊」）                访客（/j/邀请码，免密码）
  麦克风→16k PCM→ /ws ──代理──▶ 火山 ASR          麦克风→16k PCM→ /ws（凭 room token）
        │ 定稿/草稿                                    │ 定稿/草稿
        ▼                                              ▼
  本地气泡渲染 ──JSON──▶ /room/<code> ◀─ Durable Object「ChatRoom」 ─▶ 转发 ─▶ 对方气泡渲染
```

- 每端一条**现有** `/ws`（协议帧/并发槽/会话上限全复用；访客改用 room token 鉴权，见 §11.2）。
- 房间 = 每 code 一个 DO（`env.ROOM.idFromName(code)`），只中继 JSON 文本帧，**不碰音频字节**——已验证的识别管线与新增中继完全解耦。
- **为什么必须 DO**：异地两端落在不同 POP 的不同 isolate，模块级内存 Map 无法共享；`wrangler dev` 单实例会让内存方案「本地全绿、线上必坏」——这是本增补最大的隐性坑，已在架构上规避。

### 11.2 生命周期与安全参数

| 参数 | 值 | 说明 |
| --- | --- | --- |
| 邀请码 code | 6 字符，字母表去掉 0/O/1/I（32⁶ ≈ 10⁹） | crypto 随机；可扫码也可手输（老人友好） |
| 加入窗口 | 建房起 10 分钟（env `JOIN_WINDOW_SECONDS` 默认 600） | 过期 → 访客落地页「邀请已过期，请对方重新发起」 |
| 一次性 | 首位访客成功换取 token 即烧毁 code | 截图外泄也失效；访客退出后不能换人，需重开新房 |
| 房间硬顶 | 建房起 2 小时（env `ROOM_TTL_MINUTES` 默认 120），DO `alarm()` 到点关闭并清存储 | 访客 ASR 费用上界 |
| 成员 | 2 封顶（host + guest 各一 slot；**同 role 重连顶替旧连接**，close 4000 replaced） | v1 决策 |
| room token | `{scope:'room', room, role, jti, exp: hardEnd}`，双段式同 app 票据 | host 建房即发；guest 在 `/api/join` 换取；有效期内可重复用于重连 |
| token 密钥 | `SHA256(ACCESS_PASSWORD + "listen-room-v1")`（与 app 票据不同域字符串） | **改密码连坐吊销全部房间**（顺带收益，零额外代码） |
| 访客权限 | 仅 `/room/<code>` 与 `/ws`（ASR，同样受并发槽/会话上限约束）；无密码、无历史、无主界面、无 ⚙ | 最坏损失 = 2h ASR 时长 |
| 断线重连 | token 有效期内可重连；DO 保留最近 200 条定稿，重连 `welcome` 全量补发 | 定稿不丢；interim 丢即丢 |
| `/api/join` 限流 | per-IP 20 次/分钟（内存尽力而为） | 防 code 爆破（熵 30 bit 之外的保险） |

### 11.3 房间消息协议（JSON 文本帧）

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| C→S | `{"t":"line","kind":"final"\|"interim","key","text"}` | 只发**自己的** ASR 结果；final 由 DO 记账（seq++ / 存储 / 转发），interim 转发即弃（不存不排序） |
| C→S | `{"t":"bye"}` / `{"t":"ping"}` | 主动离开 / 客户端每 25s 心跳（静默期防空闲断连），DO 回 `pong` |
| S→C | `{"t":"welcome","role","peerOnline","backlog":[…]}` | 建连即回；backlog = 全部已存定稿（权威序），客户端**整体重建**气泡列表 |
| S→C | `{"t":"line","from":"host"\|"guest","kind","key","text","seq"}` | 接收端 `from` ≠ 自己 → 对方侧气泡；seq 为 DO 单调计数（信息性，留作未来排序需要） |
| S→C | `{"t":"presence","online":bool}` | 对方加入/离开（「对方已加入」「对方已离开」系统消息） |
| S→C | `{"t":"room_closed","reason"}` / `{"t":"pong"}` / `{"t":"error","msg"}` | 房间到期或主机结束 / 心跳回应 / 错误人话文案 |

**渲染规则（双端对称 = §4.3 算法 × 两侧）**：definite 追加实气泡；interim 显示为该侧**半透明 ghost 气泡**，同侧新 final 到达即清空该侧 ghost（ghost 替换不依赖 key 相等——definite 的 key 与 interim 的不保证一致）；双方 ghost 并存互不干扰（同聊天应用「正在输入」位，天然容纳同时说话）。排序按到达序；罕见双端顺序不一致在聊天语义下无害。

### 11.4 前端设计（气泡 + 三屏）

- **气泡布局（三重编码，无障碍）**：对齐为主（我右 / 对方左）、颜色为辅（我 = brand 底白字；对方 = surface 底 + 边框）、名字标签兜底（对方气泡上方小字「对方」——颜色不作唯一区分，老年男性色盲率 ~8%）。vh 十档字号沿用；气泡 max-width 85%，大字号只增高不破版。居中系统消息（「对方已加入」「连接已恢复」）复用 session-divider 样式。
- **三屏**：① 主机**邀请屏**——QR 大图 + 6 位码大字 + 倒计时 + 「等待对方加入…」；过期 → 「重新生成」；② **聊天屏**（双端同构）——滚动气泡区 + 底部主麦克风按钮（三态文案复用）+ 「结束」(host) /「退出」(guest)（自绘确认模态框复用）+ A-/A+ 与自动滚动/回到最新复用；③ 访客**落地屏**（`/j/<code>` → 「加入字聊」大按钮 → `/api/join`）。
- **访客端极简**：无密码门、无历史、无 ⚙；保留 A-/A+ 与系统主题跟随；**麦克风拒绝 → 只读模式**（仍可看对方气泡，界面不挡）。
- **QR**：vendored `qrcode-generator`（MIT，~15KB，构建期内联——deploy.js 的第二个 vendor 占位符，机制与 Vue 相同）；画 canvas → `toDataURL` → `<img>`——**微信长按识别只认 `<img>`，canvas 不触发**。QR 内容 = `${location.origin}/j/${code}`。
- **引擎复用**：音频/协议/重连引擎不动；把 ASR 定稿/草稿输出抽象为**双消费者**（单机模式喂 `finalLines`，字聊模式喂 `chatLines` + 发房间）。从菜单进入字聊时若正在单机收音，先确认停止。
- **历史**：字聊会话在 host 侧 60s + pagehide upsert 进 `listen_sessions`（文本行 `我：` / `对方：` 前缀）；访客设备不落任何存储。字聊期间不写 `listen_draft`、不显示草稿横幅。
- **挂断语义**：host「结束」= 关房（双方收 `room_closed` 退回）；guest「退出」= 离开（host 收 presence offline）；host pagehide/断网不立即关房（可重连），DO alarm 兜底。

### 11.5 边界与降级

| 情形 | 处置 |
| --- | --- |
| 访客麦克风拒绝 | 只读模式：仍收对方气泡，提示一次不挡界面 |
| 任一端断网 | 房间 WS 退避重连（1/2/4/8s）；成功后 backlog 全量补发，定稿不丢 |
| 心跳看门狗 | 60s 无任何房间消息（含 pong）→ 视为断线走重连 |
| 加入窗口过期 / code 已用 | 落地屏人话文案：「邀请已过期，请对方重新发起」 |
| 房间 2h 到期 | DO alarm 关房，双端 toast「字聊已到时长上限」+ 退回 |
| DO 重启（极端） | meta/backlog 在 DO storage（SQLite）可恢复；成员 WS 断开重连；重连失败 → 提示重新邀请 |
| 主机改密码 | 房间 token 全部失效（HMAC 域密钥随密码），自然关房 |
| 双方 ghost 同时在长 | 预期行为：左右各一条半透明气泡，互不覆盖 |

### 11.6 部署面变化

```toml
[durable_objects.bindings]
name = "ROOM"
class_name = "ChatRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatRoom"]
```

- worker.js 导出 `{ default: { fetch }, ChatRoom }`；SQLite 后端 DO 免费计划可用；现有 Git 构建部署流程不变（`wrangler deploy` 自动应用 migration）。
- DO 内部：成员表（role → ws）、`meta`（created/joinDeadline/hardEnd/consumed/closed）与最近 200 条定稿存 `state.storage`，重启可恢复；`alarm()` 兜底 hardEnd 关房并 `deleteAll()` 清理残留。

---

## 附录 A · 已验证的协议测试脚本（Phase 2 验收直接复用）

> 运行：`cd test && npm i ws && node test.mjs t1`（t1=t3=t4 已跑通；t3 为优化版端点）。
> 经 Worker 代理验收时：把 `new WebSocket(ENDPOINT, {headers})` 换成 `new WebSocket("ws://localhost:8787/ws?ticket=...")`（Node ≥22 原生 WebSocket 即可，不需要 `ws` 包），其余不变。

```javascript
import WebSocket from 'ws';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// 凭证从环境变量读，勿硬编码
const APP_ID = process.env.VOLC_APP_ID, ACCESS_TOKEN = process.env.VOLC_ACCESS_TOKEN;
const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';

const pcm = readFileSync('ldctest.wav').subarray(44); // s16le/16k/mono 测试语音

const fullClientRequest = (o) => {          // 帧头 11 10 11 00 + gzip JSON
  const p = gzipSync(Buffer.from(JSON.stringify(o)));
  const s = Buffer.alloc(4); s.writeUInt32BE(p.length);
  return Buffer.concat([Buffer.from([0x11, 0x10, 0x11, 0x00]), s, p]);
};
const audioPacket = (chunk, isLast) => {    // 帧头 11 2F 00 00（raw PCM），尾包 flags=0010
  const h = Buffer.from([0x11, (0b0010 << 4) | (isLast ? 0b0010 : 0), 0x00, 0x00]);
  const s = Buffer.alloc(4); s.writeUInt32BE(chunk.length);
  return Buffer.concat([h, s, chunk]);
};
function parseFrame(buf) {
  const t = buf[1] >> 4, flags = buf[1] & 15, comp = buf[2] & 15;
  let off = 4;
  if (t === 0b1111) { const code = buf.readUInt32BE(off), n = buf.readUInt32BE(off + 4);
    return { type: 'error', code, msg: buf.subarray(off + 8, off + 8 + n).toString() }; }
  if (flags & 1) off += 4;
  const n = buf.readUInt32BE(off); let p = buf.subarray(off + 4, off + 4 + n);
  if (comp === 1) p = gunzipSync(p);
  return { type: 'resp', flags, payload: JSON.parse(p) };
}

const ws = new WebSocket(ENDPOINT, { headers: {
  'X-Api-App-Key': APP_ID, 'X-Api-Access-Key': ACCESS_TOKEN,
  'X-Api-Resource-Id': 'volc.bigasr.sauc.duration', 'X-Api-Connect-Id': randomUUID(),
}});
ws.on('open', () => {
  ws.send(fullClientRequest({
    user: { uid: 'listen-test' },
    audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
    request: { model_name: 'bigmodel', enable_punc: true, show_utterances: true, result_type: 'single' },
  }));
  const CHUNK = 6400; let off = 0;               // 200ms 一包
  const timer = setInterval(() => {
    const last = off + CHUNK >= pcm.length;
    ws.send(audioPacket(pcm.subarray(off, Math.min(off + CHUNK, pcm.length)), last));
    off += CHUNK; if (last) clearInterval(timer);
  }, 100);
});
ws.on('message', (d) => console.log(JSON.stringify(parseFrame(d), null, 0).slice(0, 300)));
ws.on('close', (c, r) => { console.log('close', c, r.toString()); process.exit(0); });
setTimeout(() => process.exit(1), 20000);
```

实测输出（t3，优化版端点）要点：seq 连续递增且只在结果变化时返回；末帧 flags `0011`、`definite:true`；随后服务端 close 1000 "finish last sequence"。
