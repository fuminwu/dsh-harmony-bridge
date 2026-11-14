# dsh-harmony-bridge

**让鸿蒙手机连回电脑上的 DeepSeek Harness，不装插件、不改 DSH 配置、不启停 DSH。**

A zero-intrusion mobile bridge for DeepSeek Harness. Built for HarmonyOS NEXT / HarmonyOS 7 browsers, works in any modern browser. One independent Node process, zero runtime dependencies.

[简体中文](#简体中文) · [English](#english)

---

## 简体中文

### 为什么做这个

HarmonyOS 5/6/7（纯血 NEXT）移除了 AOSP 兼容层，只运行 HAP 应用。这带来两个硬事实：

- 社区客户端 dsh-Go 只发布 Android APK，系统层装不上；通过卓易通容器运行时，其 PRoot 引擎依赖的 `ptrace` / `seccomp` 被宿主拦截，本机引擎起不来（见 dsh-Go issue #24、#1099，其中 #1099 为 HarmonyOS 7.0.0.111 实测）。
- 鸿蒙浏览器的 ArkWeb 内核可以跑 Web 应用，也支持「添加到桌面」；但厂商文档没有记载 Web Push / manifest 安装 / standalone 全屏等能力，锁屏收不到网页推送。

于是剩下两条路：装插件改 DSH，或者只靠局域网 `dsh web`。前者侵入环境，后者界面挤、没通知、出门就断。这个项目走第三条：**一个完全独立的反向代理进程**，把已有的 `dsh web` 安全地搬到手机浏览器上，补上触屏适配、设备配对和通知兜底。

### 取长补短

| 借鉴对象 | 取它的长 | 补它的短 |
| --- | --- | --- |
| 官方 `dsh web` | 零安装、token 鉴权、同源原生 UI、完整会话与工具 | 桌面布局挤进小屏 → 注入启发式移动适配层；工具长输出折叠 |
| dsh-mobile | 设备配对、独立凭据、触屏优先、局域网/远程分离 | 必须装进 DSH 当插件 → 改成外部代理，全程不碰 `~/.dsh` |
| ds-harness-remote | Host 只出站、端到端加密、随处可连 | 依赖第三方托管中继 → 通道由你自己选，桥不内置任何中继服务 |
| IM 桥接插件 | 锁屏通知、聊天里直接审批 | 要 bot 账号、要装插件、看不见执行过程 → 改成可选 webhook，不动 DSH |
| dsh-Go | 折叠执行过程、插话、移动优先交互 | 鸿蒙装不了 → 浏览器里做得到的一部分（折叠、通知）先做，做不到的不假装做得到 |

**明确没做的**：本机运行 DSH 引擎、手机操控（读屏/点按）、原生 HAP、原生推送、中途插话。这些要么在鸿蒙 NEXT 上物理不可行，要么需要侵入 DSH 或自研中继服务。见「已知限制」。

### 架构

```
鸿蒙 7 手机（华为浏览器 / 添加到桌面）
   │  HTTPS 或可信局域网 + 一次性配对码
   ▼
dsh-harmony-bridge（独立 Node 进程，零依赖）
   ├─ 配对鉴权：一次性码 → 独立设备令牌（HMAC-SHA256，HttpOnly Cookie）
   ├─ HTTP 反向代理：原样转发，只在 text/html 里注入一行 shim 引用
   ├─ WebSocket 升级：原始 TCP 隧道，不解析、不改写任何帧
   ├─ 事件总线：SSE 给前台 + 可选 webhook 给锁屏通知
   └─ PWA 壳：只缓存静态资源，绝不缓存 DSH 会话数据
   │  DSH 的 token 只在电脑侧注入上游请求，不下发到手机
   ▼
已有的 `dsh web`（127.0.0.1:3080 或你指定的地址）
```

桥**不读写 `~/.dsh`、不装插件、不改配置、不启动或停止 DSH、不解析 DSH 内部协议**。它只是一个带鉴权的反向代理。

### 快速开始

前置：Node.js 20+；电脑上已经能跑 `dsh web`（或任何 DSH Web 上游）。

```bash
git clone https://github.com/fuminwu/dsh-harmony-bridge.git
cd dsh-harmony-bridge
npm test                 # 先跑测试，不需要启动真实 DSH

# 终端 A：你自己的 DSH Web（官方命令，桥不会替你启动）
npx @deepseek-ai/dsh@next web --host <你的局域网IP>
# 记下它打印的 http://<IP>:3080/?token=... 里的 token

# 终端 B：桥
export DSHB_DSH_TOKEN='上一步的 token'      # Windows PowerShell: $env:DSHB_DSH_TOKEN='...'
export DSHB_BIND=0.0.0.0                    # 仅在可信局域网；默认 127.0.0.1
npm start
```

终端会打印一个 8 位一次性配对码。手机连同一 Wi-Fi，用浏览器打开 `http://<电脑IP>:3443/__bridge/`，输入配对码。

- 点「打开 DSH」进入完整 Web UI；华为浏览器菜单里可「添加至桌面」
- 鸿蒙专项步骤、通知配置、排查清单见 [docs/HARMONY.md](docs/HARMONY.md)

> 只想本地验证、不联网：`DSHB_BIND` 保持 `127.0.0.1`，在同一台电脑浏览器打开 `http://127.0.0.1:3443/__bridge/`。

### 配置

全部通过环境变量，见 [`.env.example`](.env.example)。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSHB_BIND` | `127.0.0.1` | 监听地址。默认只本机，最安全 |
| `DSHB_PORT` | `3443` | 桥端口 |
| `DSHB_UPSTREAM` | `http://127.0.0.1:3080` | 已有的 DSH Web 地址，不允许带路径前缀 |
| `DSHB_DSH_TOKEN` | 空 | `dsh web` 打印的 token。**只留电脑侧**，不下发手机 |
| `DSHB_WEBHOOK` | 空 | 锁屏通知地址。自动识别企业微信 / 飞书 / 钉钉，其余发通用 JSON |
| `DSHB_WEBHOOK_TEMPLATE` | 空 | 自定义 JSON 模板，支持 `{title}` `{body}` `{kind}` |
| `DSHB_ORIGIN` | 空 | 走公网隧道时填你的 HTTPS 源，严格校验 Origin |
| `DSHB_TLS_CERT` / `DSHB_TLS_KEY` | 空 | 直接由桥提供 HTTPS（两个必须同时给） |
| `DSHB_INJECT` | `1` | 设 `0` 关闭移动适配注入，退化为纯代理 |
| `DSHB_NOTIFY_SELECTORS` | 空 | 额外观察的 CSS 选择器，命中即触发通知 |
| `DSHB_AUTO_OPEN` | `0` | 设 `1` 则配对后直接跳进 DSH |

### 安全模型

- **两个 token 分离**：DSH 上游 token 只存在于电脑进程内存；手机拿的是独立 HMAC 设备令牌，泄露了也不会直接拿到 DSH 的 token。
- **配对码**：随机 8 位、5 分钟有效、一次性、不写入日志文件。
- **默认只监听回环**。要跨设备必须显式改 `DSHB_BIND`；官方 `dsh web` 本身拒绝绑 `0.0.0.0`，这个设计是故意的。
- **Cookie**：`HttpOnly` + `SameSite=Strict`，转发前从请求里剔除，不会漏给上游。
- **Origin 校验**：配对、通知等状态变更接口拒绝跨站来源；走隧道时建议设 `DSHB_ORIGIN`。
- **Service Worker 只缓存 PWA 壳**，DSH 的会话、文件、API、WebSocket 一律不缓存。
- **不记录请求体、token 或会话内容**。

配对设备能完整操作你的 DSH（读写文件、执行命令）。请只在自己的设备上配对，不要把这个端口裸奔到公网；需要公网访问请套一层可信 HTTPS 隧道，并设 `DSHB_ORIGIN`。设备丢失时重启桥即可——签名密钥每次启动重新生成，所有已签发的设备令牌立即失效，手机需要重新配对。

### 已知限制 / 怎么判断它不适用

- **必须有一个已经在跑的 DSH Web 上游**。这是「零侵入」的代价：桥不替你启动 DSH。如果你只用 DSH Desktop 且从不以 web 模式运行，桥连不上——这是硬前提，不是 bug。
- **移动适配和审批检测是启发式的 DOM 观察**，不解析 DSH 协议。DSH 改版后可能失效；用 `DSHB_NOTIFY_SELECTORS` 自己补选择器，或设 `DSHB_INJECT=0` 退化为纯代理。判据：注入后页面仍能正常发消息、能看到 `/__bridge/shim.js` 被加载，就算适配有效。
- **如果上游页面带严格 CSP**，`/__bridge/shim.js` 可能被浏览器拦截。此时功能退化为「带鉴权的移动代理」，通知不会触发。
- **鸿蒙浏览器没有可靠的 Web Push**，锁屏通知必须靠 `DSHB_WEBHOOK`，且取决于 IM 平台自己的送达能力，不保证必达。
- **纯 HTTP 局域网**不加密。跨网络请开 `DSHB_TLS_*` 或套 HTTPS 隧道。
- 一次只代理一个上游；没有多主机切换、没有会话迁移、没有原生 App。

### 路线图

- [ ] 可插拔远程通道（Cloudflare 命名隧道 / 自建 FRP 的一键配置脚本，仍不侵入 DSH）
- [ ] 更多通知模板（Telegram / 自定义签名头）
- [ ] 鸿蒙原生 HAP 壳的可行性评估（需要签名与真机验收，不承诺）

### 关系与致谢

- 本项目**不是** DeepSeek 官方产品，与 DeepSeek 无关联。
- 本项目**不是** dsh-Go 的衍生作品：没有复制其任何代码，因此采用 MIT 而非 AGPL-3.0。思路上参考了其公开 README 与 issue 中关于鸿蒙 NEXT 的技术边界讨论。
- 感谢 dsh-mobile、ds-harness-remote、dsh-im 等项目公开文档所揭示的设计空间；本项目不依赖、不修改它们。
- 许可证：[MIT](LICENSE)

---

## English

A standalone, dependency-free reverse proxy that makes an existing `dsh web` instance usable from a HarmonyOS NEXT phone browser, without installing any DSH plugin or touching `~/.dsh`.

- One-shot pairing code on the host, independent HMAC device token on the phone; the upstream DSH token never leaves the host.
- HTTP proxying plus raw WebSocket tunneling (frames are never parsed), with an optional injected mobile shim for small screens, collapsed long tool output and approval detection.
- Optional webhook relay (WeCom / Feishu / DingTalk / generic JSON) fills the gap left by the lack of Web Push in HarmonyOS browsers.
- PWA shell caches static assets only. By default it binds to `127.0.0.1`.

```bash
npm test
DSHB_DSH_TOKEN='<token printed by dsh web>' npm start
# open http://127.0.0.1:3443/__bridge/ and enter the printed pairing code
```

Requirements: Node.js 20+, and a running `dsh web` upstream. The bridge never starts, stops or configures DSH. It is a heuristic DOM-based adapter, not a DSH protocol client; UI changes upstream may require updated selectors. See [docs/HARMONY.md](docs/HARMONY.md) for the HarmonyOS 7 walkthrough.

Not affiliated with DeepSeek. Not derived from dsh-Go. MIT licensed.
