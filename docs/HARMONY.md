# 鸿蒙 7 / HarmonyOS NEXT 专项说明

适用：HarmonyOS 5 / 6 / 7（纯血 NEXT），已在HarmonyOS 7.0.0.111 SP12 的约束下设计。HarmonyOS 2/3/4 因为还能侧载 APK，直接用原生 Android 客户端体验更好，本项目对它们不是必需。

## 版本判定

设置 → 关于手机 → 查看 HarmonyOS 版本。

| 版本 | AOSP 兼容层 | 能装 APK | 建议 |
| --- | --- | --- | --- |
| 2 / 3 / 4（含 4.2） | 有 | 能 | 直接侧载 Android 客户端 |
| 5 / 6 / 7（NEXT） | 无 | 不能 | 用浏览器方案，即本项目 |

判据：如果安装 APK 时提示「与此设备不兼容」或「解析软件包时出现问题」，且系统版本号是 5.x 以上，就是 NEXT 分支。

## 为什么 dsh-Go 在这里跑不起来

dsh-Go 是 Flutter + Android 原生应用，其「本机模式」在手机里跑一套 PRoot + Ubuntu + Node 的 Linux 运行环境。鸿蒙 NEXT 没有 Linux 内核兼容层，也没有 `ptrace` / `fork` / `exec` 这一套机制；卓易通这类容器是 Anco/LXC 用户态容器，会拦截 PRoot 依赖的系统调用。

公开 issue 里的实测：

- `ccch1mneyyy/dsh-Go#24`：HarmonyOS 7 + 卓易通，`getcwd() failed: Function not implemented`、`exec: /usr/local/bin/dsh: Bad address`。
- `ccch1mneyyy/dsh-Go#1099`：Mate 60 Pro / HarmonyOS 7.0.0.111 / 卓易通 1.0.10.93 / dsh-Go 1.0.15，App 能打开但本机引擎始终未连接。
- `ccch1mneyyy/dsh-Go#107`：论证 iOS / HarmonyOS NEXT 上只能做出「远程客户端」，做不出能跑引擎的原生端。

结论：在鸿蒙 7 上，PC 端跑引擎、手机端做交互是唯一现实的形态。本项目就是这条路线里最轻的一种。

## 浏览器能力边界

- HarmonyOS 7.0 的 ArkWeb 默认 Chromium M144，跑现代 Web 应用、WebSocket、SSE 没有问题。
- 华为浏览器 5.0+ 支持「网页添加至桌面」，可生成桌面快捷方式。
- 据 OpenPWA 2026-10-20 的厂商文档核验：HarmonyOS NEXT 的 manifest 安装、standalone 全屏显示、Web Push 均**没有**厂商文档记载。也就是说，不能指望网页在锁屏后收到系统推送。

因此本项目把通知拆成两层：

1. 前台：SSE + 页面内横幅 + 能力检测后的 Notification API（有则用，没有就降级）。
2. 锁屏：电脑侧 `DSHB_WEBHOOK` 推送到鸿蒙原生 IM（企业微信 / 飞书 / 钉钉），由 IM 的系统推送送达。

## 完整步骤

**电脑侧（两个终端）**

```bash
# 终端 A：DSH 官方命令。桥不会替你启动它
npx @deepseek-ai/dsh@next web --host <电脑局域网IP>
# 记下 http://<IP>:3080/?token=... 里的 token

# 终端 B
export DSHB_DSH_TOKEN='<上面的 token>'
export DSHB_BIND=0.0.0.0          # 仅可信局域网
npm start
# 记下终端打印的 8 位配对码
```

Windows PowerShell 用 `$env:DSHB_DSH_TOKEN='...'`、`$env:DSHB_BIND='0.0.0.0'`。

**手机侧**

1. 连同一 Wi-Fi，华为浏览器打开 `http://<电脑IP>:3443/__bridge/`。
2. 输入配对码 → 显示「已连接」。
3. 点「打开 DSH」进入完整界面。
4. 浏览器右下角菜单 → 「添加至桌面」，以后一键直达。
5. 在入口页点「发一条测试通知」，确认事件链路通。

**出门在外**

官方 `dsh web` 不能绑 `0.0.0.0`，纯局域网方案在离开 Wi-Fi 后失效。要跨网络，二选一：

- 在可信 HTTPS 隧道后运行桥，例如 Cloudflare 命名隧道指向 `http://127.0.0.1:3443`，然后设 `DSHB_ORIGIN=https://你的域名`。推荐命名隧道，固定域名；快速隧道地址会变且有限流。
- 直接给桥配 `DSHB_TLS_CERT` / `DSHB_TLS_KEY`，再自己处理可达性。

无论哪种，都不要把这个端口不加密地暴露到公网。

## 锁屏通知配置

在企业微信 / 飞书 / 钉钉里建一个群机器人，拿到 webhook 地址：

```bash
export DSHB_WEBHOOK='https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...'
```

桥会自动识别平台并组装对应 payload。其他平台收到通用 JSON：

```json
{ "title": "...", "body": "...", "kind": "approval", "ts": 1731600000000 }
```

需要别的格式时用 `DSHB_WEBHOOK_TEMPLATE`，例如：

```bash
export DSHB_WEBHOOK_TEMPLATE='{"text":"{title} - {body}"}'
```

注意：webhook 地址是凭据，只放在电脑侧环境变量里，不要提交进仓库，也不要写进手机的配对页。

## 排查清单（按顺序）

| 现象 | 检查 |
| --- | --- |
| 手机打不开入口页 | `DSHB_BIND` 是不是还停在 `127.0.0.1`；Windows 防火墙是否放行 3443；手机与电脑是否同网段 |
| 配对码报错 | 码 5 分钟过期且只能用一次；重启桥会生成新码 |
| 打开 DSH 报 502 | 终端 A 的 `dsh web` 是否还活着；`DSHB_UPSTREAM` 端口对不对 |
| 界面没适配小屏 | 上游是否返回 `text/html`；是否设了 `DSHB_INJECT=0`；浏览器控制台是否报 CSP 拦截 |
| 收不到锁屏通知 | `DSHB_WEBHOOK` 是否配置；入口页「状态」里 webhook 是否显示已配置；IM 平台是否限流 |
| WebSocket 反复重连 | 隧道是否支持 WebSocket 升级；反向代理是否保留 `Upgrade` / `Connection` 头 |

**证伪条件**：如果上面的检查都通过，但手机仍然打不开 DSH 会话、或审批按钮点了没反应，说明上游 DSH 版本的 UI/协议与这个启发式适配层不兼容。此时设 `DSHB_INJECT=0` 退化为纯代理；若纯代理也不通，本项目对你这个版本不适用，请改用装插件的方案。

## 已知限制

- 需要自己启动 `dsh web`。这是「不动 DSH 环境」的代价。
- 没有原生 App、没有原生推送、没有手机操控、不能在手机本机跑 DSH 引擎。
- 审批检测靠按钮文本关键词与可配置 CSS 选择器，是启发式，不是协议级保证；误报/漏报都可能发生，重要操作请回到电脑确认。
- 网页快捷方式在鸿蒙上是否全屏显示取决于浏览器版本，不由本项目控制。
