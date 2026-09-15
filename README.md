# DSH Remote Terminal

[![npm version](https://img.shields.io/npm/v/dsh-remote-terminal)](https://www.npmjs.com/package/dsh-remote-terminal)
[![License: MIT](https://img.shields.io/github/license/xht-code/dsh-remote-terminal)](LICENSE)
[![Release](https://img.shields.io/github/v/release/xht-code/dsh-remote-terminal)](https://github.com/xht-code/dsh-remote-terminal/releases)
[![Stars](https://img.shields.io/github/stars/xht-code/dsh-remote-terminal)](https://github.com/xht-code/dsh-remote-terminal/stargazers)
[![Issues](https://img.shields.io/github/issues/xht-code/dsh-remote-terminal)](https://github.com/xht-code/dsh-remote-terminal/issues)

在 DSH (DeepSeek Harness) Web GUI 的会话视图栏（轨迹旁）新增「终端」tab：浏览器经 WebSocket 直连宿主 PTY shell，支持 `vim` / `htop` 等全屏程序、多标签页、按工作区分组、断线重连与会话保活。

- **npm**：<https://www.npmjs.com/package/dsh-remote-terminal>
- **仓库**：<https://github.com/xht-code/dsh-remote-terminal>

## 特性

- **会话视图栏内的完整终端**：多标签页，每个标签一个独立 PTY 会话；`vim` / `htop` / `tmux` 等全屏程序正常渲染，尺寸随窗口自适应；
- **按工作区分组**：每个工作区各有一组终端，互不干扰；新建终端的默认目录就是**当前工作区目录**，标签实时显示当前目录并随 `cd` 更新；
- **会话独立于浏览器保活**：刷新页面、切走视图、断线重连后自动挂回原会话；切走再切回**连画面都还在**，不会把历史重放一遍；不同标签页可同时挂接同一终端；
- **配额与回收**：每工作区 8 个、全部工作区合计 32 个终端上限（均可配）；逼近上限时先回收已退出的、再回收最久无人挂接的闲置终端，不会出现"终端打不开"；
- **背压与心跳**：消费不动输出的连接会被主动断开（客户端自动重连并重放），半开连接由心跳回收——宿主内存不会因终端刷屏无界增长；
- **与宿主同源**：复用 `dsh web` 的信任围栏与浏览器认证，未认证请求一律拒绝；界面样式与明暗主题跟随宿主。

## 解决的问题

DSH 的 Web GUI 只提供模型会话视图（聊天 / 轨迹），没有面向人的宿主 shell 入口。部署在服务器 / 无头机上、浏览器从其它设备访问时，缺少一个直接操作宿主工作区的终端——本插件补上这一块：远程浏览器里的终端等价于 SSH 进宿主，但集成在现有 GUI 会话视图栏内，随认证与界面样式一体。

## 环境要求

| 项 | 要求 |
| :-- | :-- |
| 宿主运行时 | 跟随 `dsh web` 的 Node.js（开发与验证使用 Node 24）；本包 `engines` 声明 `>=20` |
| DSH | 已在 `0.1.5-rc.1` 上实测；运行时依赖 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-subprocess`、`@deepseek-ai/schemastery` 由宿主提供 |
| shell | Linux / macOS 都用**账户里的登录 shell**（Linux 上通常是 bash，macOS 默认 zsh；fish 亦可）：先加载你自己的配置再注入 OSC 7 钩子以实时跟随目录（macOS 的 zsh / fish 按登录 shell 启动，`~/.zprofile` 与 macOS 的 `/etc/paths.d` PATH 构造都会生效）；Windows 走 PowerShell（不注入钩子，目录不实时跟随） |
| 浏览器 | 支持 WebSocket 的现代浏览器；xterm.js 及其样式随 bundle 打包，无需额外静态资源 |
| 反向代理 | 经代理访问需透传 WebSocket `Upgrade`（见「常见问题」） |

## 安装 / 更新

从 npm 安装（推荐）：

```bash
dsh plugin --profile web add dsh-remote-terminal
```

更新与卸载：

```bash
dsh plugin --profile web update dsh-remote-terminal@latest
dsh plugin --profile web remove dsh-remote-terminal
```

安装后**重启 `dsh web` 并刷新浏览器页面**。

<details>
<summary>从源码安装（开发 / 本地调试）</summary>

```bash
git clone https://github.com/xht-code/dsh-remote-terminal.git
cd dsh-remote-terminal
pnpm install && pnpm build
dsh plugin --profile web add link:"$PWD"
pnpm dev    # 可选：tsdown --watch；产物变化会被宿主热重载感知
```

以 `link:` 装入时宿主直接读取本仓库的 `lib/`，因此改动后需要 `pnpm build`（或让 `pnpm dev` 常驻）。
</details>

## 工作机制

本包同时是 DSH 的 **bundle 补丁**与**客户端插件**：`cordis.patch.yml` 把宿主半体插进 profile，`package.json` 的 `dsh.client` 声明客户端半体（`lib/client.js`，随 ModuleLoader 加载）。

**宿主半体**（`lib/index.mjs`）：
- 在 `webServer` 注册 WebSocket 升级路由（默认 `/api/remote-terminal/ws`），握手先过 `connection.requestRejection` 的信任围栏与浏览器认证，未认证一律拒绝；
- 用 **node-pty** 为每个会话启动一个交互 shell：Linux / macOS 都是**账户里的登录 shell**（`chsh` 的结果；查不到时退回 macOS `/bin/zsh`、其余 `/bin/bash`），Windows 是 PowerShell。cwd 上报钩子按 shell 类型注入，三者都**先让用户自己的配置生效**再挂钩子，于每个提示符前输出 OSC 7：bash 用 `--rcfile`（先 source `~/.bashrc`，再挂 `PROMPT_COMMAND`）、zsh 用 `ZDOTDIR`（先 source `~/.zshenv` / `~/.zprofile` / `~/.zshrc`，再挂 `precmd`）、fish 用 `--init-command`（它在用户的 `config.fish` 之后执行，只需挂一个 `fish_prompt` 事件函数；主机名用 fish 的 `$hostname` 保留变量，不依赖外部命令）。macOS 下 zsh / fish 按 `-l -i` 起**登录** shell，与 Terminal.app / iTerm2 一致（bash 见「限制」）。环境经 `scrubbedParentEnv()` 清洗（不泄漏凭据类变量；`DSH_*` 一并剔除，见「`DSH_*` 环境变量」）；
- 会话按 id 登记（id 为随机串，不做递增序号，避免宿主重启后旧 id 命中新会话）：支持同一浏览器连接**同时挂接多个会话**（多终端标签）；输出经环形缓冲（默认 2 MiB）保留，向所有挂接的客户端广播；退出后会话保留可重连回看，close 销毁时通知全部挂接者；
- 会话独立于浏览器连接保活：刷新页面 / 断线重连后重新 attach 已记录的会话集合；每条输出带**绝对偏移**（`output.offset`），客户端重挂时把已消费到的位置作为 `attach.since` 报回来，宿主**只补缺口**、不重放头部，一次 attach 的重放发完会补一个 `synced` 标记（`synced.offset` 即客户端当前所处位置）；不同标签页可同时挂接同一终端；
- 客户端报的 `since` 早于重放缓冲还留着的位置时（缓冲被裁剪过），宿主把还留着的内容全部重放，而不是当作"已消费"整段跳过：被裁掉的那段补不回来，但客户端不会因此把没收到过的内容记成已有；
- 会话集合按**工作区分桶**：新建、关闭、刷新恢复都只作用于当前工作区那组终端，切到别的工作区看到的是别的工作区自己的终端；宿主按同一个作用域键分别计算配额，一个工作区开满不影响别的工作区，另有总数上限兜底、防止跨工作区无限堆积；
- 会话数量上限分两层：**每个工作区默认 8**（`maxSessions`）、**全部工作区合计默认 32**（`maxSessionsTotal`，兜底）。某个工作区超限时，先回收该工作区里已退出的空挂接会话，仍不够则回收该工作区里最久无人挂接的闲置会话；总数触顶时先清掉任何工作区里已退出且无人挂接的，再回收全局最久闲置的那个（可能来自别的工作区，例如浏览器崩溃 / 关标签页留下的孤儿会话）。两层都无对象可回收时才拒绝新建并明确报错（文案区分「本工作区」与「总数」）；
- `close` 按**会话 id** 生效（标签关闭是宿主侧的事实，一处关掉处处收起）：任一知道 id 的连接都能关掉它——包括断线重连后那条尚未挂接它的新连接。若要求"本连接必须先挂接过"，用户在断线窗口里点的关闭就会随 pending 队列冲刷到宿主时被丢弃，终端随后被对账收养回来（关掉的终端复活、宿主侧进程继续跑）；
- 输出背压：单个连接的待发送缓冲超过阈值（4 MiB 与 `scrollbackMaxBytes` 的 8 倍取大）即断开该连接，客户端自动重连并按重放缓冲重新对齐——这类"活着但消费不动"的连接（网络拥塞、页面主线程卡死）心跳探测不到，不设阈值会让宿主内存无界增长；
- 半开连接由心跳回收（30s 一轮 ping/pong，未回 pong 即终止）：对端网络中断时不产生 close 事件，死连接会持续吃缓冲、并让会话的挂接集合永不为空而无法回收。

**客户端半体**（`lib/client.js`，随 ModuleLoader 加载）：
- 在 `conversation.view` 槽位注册 `terminal` 视图（order 11，紧邻轨迹的 10），视图标签本地化为「终端 / Terminal」；
- **终端实例活在视图之外**：DSH 的会话视图区只渲染当前激活的那个 view，切到轨迹再切回来组件是真的卸载重挂；xterm 实例、标签集合与 WebSocket 连接因此按**作用域**登记在视图之外的运行时里（`client/runtime`），切走只摘 DOM、切回原样贴回——终端画面、滚动位置与运行中的进程都不受影响，也不会因为一次视图切换就重放历史。**页内切换视图（页面仍可见）不再释放连接**：切回来零补发，TUI 程序（lazygit、vim 等）不会因为一次切换就重画一遍；只有页面真的被隐藏（切到浏览器其他标签页、最小化）才开始 60 秒宽限计时，到期释放连接，让宿主把无人挂接的会话按闲置回收（没有终端实例时立即释放）。代价是页内切走的连接会一直保持到页面被隐藏或视图回挂——该会话在此期间不会被宿主当闲置回收，配额吃紧时可以关掉它或调大 `maxSessions`；
- 视图用 **xterm.js**（随 bundle 打包）：页内以**标签栏管理多个终端**，「+」新建会话、标签 ✕ 销毁会话，每个标签独立 xterm 实例；输出直写 xterm、输入经 WebSocket 上行（超过 32 KiB 的粘贴自动分帧，不会撞上宿主单帧上限）；`ResizeObserver` + `FitAddon` 跟随容器尺寸，`onResize` 同步 PTY 尺寸；切换标签时补一次 fit（隐藏容器的尺寸无法测量，FitAddon 会跳过，不补则滞留旧尺寸）；
- 新建会话**先挂载 xterm、下一帧按实测尺寸 attach**：会话若先按默认 80×24 起 shell 再被 resize，窄屏上 readline 的重绘会和 xterm 的重排叠加，把提示符留成两条；
- **标签显示当前目录最后一段（如 myproj）并随 `cd` 实时更新**（解析 shell 钩子输出的 OSC 7）；状态条显示完整路径与会话 id；
- **终端按工作区分组**：每个工作区各有一组终端，标签、刷新恢复、重连都只在本工作区内；会话所属工作区取侧边栏分组的同一判定（工作区行账目上的 `sessionIds`），未归属任何工作区的会话共用一个 default 组，工作区注册表还没就绪时不建会话（避免把终端记到错误的组里）；
- **重挂只补缺口，重建才重放**：重连时按已消费偏移报 `since`，宿主只补缺口，并按当前尺寸补报一次 PTY 尺寸（断线期间的窗口缩放不会让 PTY 与视图尺寸脱节）；全新客户端（刷新页面、新浏览器标签页）没有画面可续，只能整段重放——重放期间终端先遮住，等 xterm 把排队的输出解析完（`synced`）再一次性显示当前画面，用户看到的是"终端还在那儿"，而不是历史又跑了一遍；重放中掉线也不会把没到手的内容记成已有：位置只随真正收到的输出帧推进；
- **失效会话的标签亮明原因，且不再持有失效 id**：会话被宿主回收后标签落地为错误态，输入与 resize 不再发往一个已经不存在的会话，该 id 也从本地登记里剔除、重连不会反复重试；关掉这个标签再点「+」即可拿到新终端；
- **回退新建一个运行时只做一次**：已知会话全部失效时视图会补一个新终端（否则用户面对一个空视图）；但同一运行时不再重复补——重连风暴里每次重连都会重放同一批失效会话，不设闸就会按重连节奏反复拉起 shell；用户主动点「+」不受此限；
- 主题跟随宿主的明暗标记（`body[data-ds-dark-theme]`），字体解析宿主代码字体变量；
- 默认工作目录 = **当前会话所属工作区**的宿主路径（判定口径与侧边栏的工作区分组一致：工作区行账目上的 `sessionIds` 归属）；会话未被任何工作区记录时不做武断猜测，交给宿主用用户主目录。

## 配置

插件零配置可用；以下配置项可选（经 host 侧 `Config` schema 校验，用户层可改为 `cordis.patch.yml` 中同名条目的 `config:` 覆盖）：

| 字段 | 默认 | 说明 |
| :-- | :-- | :-- |
| `shellPath` | 账户里的登录 shell（查不到时 macOS `/bin/zsh`、其余 `/bin/bash`）；Windows 默认 `powershell.exe` | 终端 shell 可执行文件 |
| `shellArgs` | 跟着实际要跑的 shell 算：`-i`；macOS 的 zsh / fish 为 `-l -i`；Windows 只有 PowerShell 才是 `-NoLogo -NoProfile` | shell 启动参数。显式指定 `shellPath` 或 `shellArgs` 后**不再注入 cwd 钩子**（标签与状态条停留于打开时的目录） |
| `maxSessions` | `8` | 每个工作区的终端会话上限（按作用域分别计算） |
| `maxSessionsTotal` | `32` | 全部工作区合计的终端会话总数上限（兜底；应不小于 `maxSessions`） |
| `scrollbackMaxBytes` | `2 * 1024 * 1024` | 每会话重放缓冲字节上限 |
| `wsPath` | `/api/remote-terminal/ws` | WebSocket 升级路由。**自定义需同时改客户端常量**：浏览器半体读不到宿主配置，只连 `protocol.ts` 里的 `DEFAULT_WS_PATH`；只改这里会让终端一直停在「连接中」 |

单帧上限（1 MiB）与单连接发送缓冲阈值（4 MiB 与 `scrollbackMaxBytes` 的 8 倍取大）是内部常量，不开放配置。

> **登录 shell（Linux / macOS）**：默认终端就是你平时用的那个 shell——账户里的登录 shell（`chsh` 的结果），因此 `~/.bashrc`、`~/.zshenv` / `~/.zprofile` / `~/.zshrc`、oh-my-zsh / prezto / starship 等照常加载；macOS 上 Apple 那条 "The default interactive shell is now zsh" 提示也不会再出现。**macOS 的 zsh / fish 按登录 shell 启动**（`-l -i`，与本机 Terminal.app / iTerm2 一致）：zsh 的 `~/.zprofile`（Homebrew `brew shellenv` 的常规落点）与 fish 的登录分支（按 macOS 的 `/etc/paths`、`/etc/paths.d` 构造 PATH）都只有登录 shell 才会执行；Linux 的 GUI 终端（GNOME Terminal / Konsole）是非登录交互 shell，保持一致。cwd 钩子的注入方式因 shell 而异：bash 用 `--rcfile`；zsh 没有 `--rcfile`，改用 `ZDOTDIR` 指向 0700 私有包装目录（回源 `.zshenv` / `.zprofile` 时先把 `ZDOTDIR` 交给你、回源后采纳你改过的新值再交还包装目录，所以把配置放 `~/.config/zsh` 的写法照常生效；回源 `.zshrc` 前则会还原成你的原值，prezto / zim 这类读 `$ZDOTDIR` 的框架照常工作）；fish 用 `--init-command`（本仓库在 fish 3.7 上实测），它在用户的 `config.fish` 之后执行，因此不需要回源任何配置。终端里起的子进程看到的都是正常环境。账户查不到（例如容器里 uid 不在 `/etc/passwd`）时会退回平台默认并打一条日志；想固定用别的 shell，就在 `cordis.patch.yml` 里显式写 `shellPath`。

在用户层 `cordis.patch.yml` 里覆盖（示例）：

```yaml
- id: remote-terminal
  config:
    maxSessions: 6          # 每个工作区
    maxSessionsTotal: 24    # 全部工作区合计
    scrollbackMaxBytes: 4194304
```

## 给别的插件用：`ctx.terminalSessions`

宿主半体把会话表作为 cordis 服务注册为 **`ctx.terminalSessions`**，让别的插件能把
一个长驻进程放进终端，而不必自己再写一套进程管理：

```ts
import { workspaceScope } from 'dsh-remote-terminal'

const sessionId = await ctx.terminalSessions.create({
  command: '/bin/sh',
  args: ['-c', 'pnpm dev'],
  cwd: '/path/to/app',
  // scope 决定会话落进哪个终端分桶，必须用 workspaceScope(workspaceId) 构造：
  // 传错或省略，会话会落进 default 桶，所属工作区的终端视图对账时看不见它。
  scope: workspaceScope(workspaceId),
  env: { DSH_MY_PLUGIN_BASE: '/preview/p4271/' },  // 调用方负责注入自己的上下文
  label: '预览 p4271',                             // 终端标签名（随 attached 下发）
})
ctx.terminalSessions.describe(sessionId)          // { exited, exitCode } | undefined
ctx.terminalSessions.close(sessionId)             // true=确实关掉了一个运行中的会话
```

约定：

- 拉起的会话与浏览器 attach 新建的终端**走同一条创建路径**，因此它会出现在会话
  快照里，终端视图**在连接就绪时对账一次**并自动 attach——它就是一个普通终端标签，
  以 `label` 作标签名，可看日志、可输入、可 Ctrl-C（视图已连着时新建的会话要等
  重连/切工作区/刷新才出现）；
- 对账只认「宿主有这个会话、本地没登记过」，**不区分来源、也不看是否已退出**：
  别的浏览器标签页里手工新建的终端同样会被收养（同一个工作区共用一组终端，关会话
  是宿主侧的事实，一处关掉处处收起）；已经退出的会话也照收养——服务崩掉时那段输出
  正是要看的东西，标签会带上退出标记，此时视图不再回退新建 shell；
- 类型：`ctx.terminalSessions` 的 `Context` 声明增强随本包提供，示例里的
  `import { workspaceScope } from 'dsh-remote-terminal'` 已经把它带进来了；只用到
  服务、不引用其它导出时，写一行 `import type {} from 'dsh-remote-terminal'`；
- 这类会话标记为 `external`：**不占用手工终端的 `maxSessions` 配额**（否则拉几个服务
  就会把用户的终端额度吃光），但仍受跨工作区的 `maxSessionsTotal` 兜底，且**配额吃紧
  时同样会被当作闲置会话回收**——持有方只能靠 `describe()` 发现会话已消失；
- 传了 `command` 就不套 shell 包装，也**不继承**配置里的 `shellArgs`：那批参数是
  交互式 shell 的语义（POSIX 的 `-i`、Windows 的 `-NoLogo -NoProfile`），塞给
  `pnpm dev` 会变成非法参数。要传参数请显式给 `args`；
- 服务随本插件的 fiber 卸载而注销，调用方用 `ctx.inject(['terminalSessions'], …)`
  拿即可把它当可选依赖。

## `DSH_*` 环境变量

终端会话的启动环境是 `scrubbedParentEnv()` 的结果：脱敏后的父进程环境，**剔除凭据类变量与全部 `DSH_*`**。这是 agent shell 的隔离约定，本插件刻意沿用——因此终端里**不会**有 `DSH_HOME`、`DSH_WEB_URL` 这类由 DSH 或插件发布的会话事实。

需要某个 `DSH_*` 值时，两种做法：

- **自己显式声明**：`DSH_MY_PLUGIN_BASE=/preview/p4271/ pnpm dev`，或写进 shell rc；
- **经 `ctx.terminalSessions.create({ env })` 拉起**：把值写进那个进程的 env，不经过交互式 shell，也就不受这里的影响。

> 为什么不做成「终端也继承注册表快照」：那会让终端页签与 bash / pwsh 工具的行为分叉（工具每次执行前 `ctx.shellEnv.collect()`，终端是长驻进程，只能在创建时取一次快照），并且给同一个变量引入两条来源。给业务进程传上下文的正解是**在拉起它的那一刻注入**，而不是改所有 shell 的环境。

## 常见问题

**看不到「终端」tab**
确认插件已装入当前 profile（profile 的 `package.json` 依赖与 `dsh.profile.bundles` 里应有 `dsh-remote-terminal`），装完需**重启 `dsh web`** 并刷新页面；刚升级过的话再强制刷新一次（旧 bundle 可能被浏览器缓存）。

**终端一直「连接中…」或反复重连**
多半是反向代理没有透传 WebSocket。nginx 示例：

```nginx
location /api/remote-terminal/ws {
    proxy_pass http://127.0.0.1:3080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;    # 空闲终端不要被代理掐断
}
```

**标签显示「终端会话不存在」**
宿主 `dsh web` 重启过（会话是宿主进程级的，重启即全部消失），或该终端被总数兜底回收（闲置最久的那个）。关掉这个标签重新新建即可。

**粘贴大段文本被截断**
分帧上限是 1 MiB，超过 32 KiB 的粘贴会自动分片，不会撞上限；但如果目标程序处于 tty 规范模式（例如 `cat`），单行超过 4095 字节仍会被行规程截断——这与 SSH / 本地终端的行为一致，不是插件限制。

**窗口/手机宽度下提示符重复**
已在 0.1.x 修复（会话按终端实测尺寸创建）；若仍复现，请附上 `dsh web` 版本与浏览器信息提 issue。

## 开发

```bash
pnpm install           # 安装依赖（native 模块 node-pty 需本机编译工具链）
pnpm build             # 产出 lib/index.mjs（宿主）+ lib/client.js（客户端）+ 类型声明
pnpm dev               # tsdown --watch，配合 link: 安装做本地调试
pnpm typecheck         # 宿主 / 客户端 / 测试三层类型检查
pnpm test              # 单元测试（vitest）：协议解析与粘贴分片、标签与 OSC 7 解析、
                       #   配置归一化与默认 shell 解析（含账户查不到时的退路、钉了 shellPath 时的
                       #   平台默认参数、空串 / YAML 空值）、shell 不可执行时的报错、shell 包装脚本
                       #   （有 zsh / fish 时按插件真实的 argv / env 喂给真实 shell，并在真实 PTY
                       #   里验证提示符上报与 cd 跟随；包装目录被外部清理后会重建）、会话分桶、
                       #   配额回收（分区 + 总数兜底）、
                       #   输出背压、
                       #   对外会话服务（拉起 / 配额隔离 / close 语义 / env 注入 /
                       #   总数吃紧时的清理与回收 / 错误分支）、会话快照对账判定、
                       #   输出偏移与 since 增量续接（含缓冲裁剪后的重放起点）、
                       #   客户端运行时（切走切回不重建 / 页内切视图不释放连接 /
                       #   页面隐藏后按宽限期续接 / 重放期间先遮住画面 / 新建与关闭标签 /
                       #   回退新建只做一次 / 无归属错误不影响健康终端 / 缺口提示）、
                       #   浏览器半体的依赖边界
pnpm test:integration  # 集成验证：构建后以假上下文装配插件，驱动真实 PTY + WebSocket
pnpm test:heartbeat    # 心跳回收验证（较慢，约 60–90s）：半开连接被终止且配额释放
```

> 宿主半体另外导出 `defaultShell` / `resolveConfig` / `shellWrapFiles` / `shellWrapInjection` / `FISH_INIT_COMMAND` / `releaseSharedState`：它们是宿主内部的决策与产物，导出只为让单测与集成脚本拿**真实**的 argv / env / 包装文件去验证（而不是照抄一份），不构成对外契约。

集成验证覆盖：握手认证拒绝、attach 与 token 回显、PTY 交互与 OSC 7 上报、退出会话重连与重放、多会话挂接与 close 销毁、失效会话报错、shell 包装临时目录私有性（0700）与卸载清理。

## 验证

1. 打开 Web GUI，进入任一工作区会话；
2. 会话视图栏出现「终端」tab（轨迹旁）；
3. 切换到终端，应看到 shell 提示符，`vim` / `htop` 等全屏程序正常渲染，窗口缩放时终端重排；
4. 点「+」新建多个终端标签、在标签间切换、用 ✕ 关闭终端；关闭后进程即被宿主终止；
5. 切到「轨迹」再切回「终端」：标签与画面原样还在，不重放、不闪；
6. 刷新页面后再次打开终端：已运行进程保持，画面直接呈现当前状态（重建期间不显示重放过程）；
7. 切换到另一个工作区，终端 tab 是那个工作区自己的那一组（互不影响）。

## 适用与限制

- **适用**：`dsh web` 部署在服务器 / 无头机上、浏览器从其它设备访问的场景；终端即宿主 shell 全权限（等效 SSH）。
- **限制**：
  - 浏览器载入的 WebSocket 不支持时终端不可用（现代浏览器均支持）；经反向代理访问需代理支持 WebSocket `Upgrade`；
  - **cwd 实时跟随只在默认 shell 下生效**（登录 shell 为 bash / zsh / fish 时注入钩子）：显式指定 `shellPath` / `shellArgs`，或登录 shell 认不出（sh、nu、nologin 等）时不注入钩子，标签与状态条保持打开时的目录；
  - **bash 不加载登录文件**（`/etc/profile`、`~/.bash_profile`、`~/.bash_login`、`~/.profile`）：`--rcfile` 与 `-l` 互斥（实测 `-l` 下 rcfile 不执行，把 `-l` 放在 `--rcfile` 前还会直接报无效选项），而 cwd 钩子只能靠 `--rcfile` 注入。只把 PATH 写在 `~/.bash_profile` 的 bash 用户请在 `~/.bashrc` 里也放一份；macOS 默认登录 shell 是 zsh，zsh 侧已按登录 shell 启动，不受此限；
  - 登录 shell 是 `nologin` / `/bin/false` 这类"不可登录"程序时（服务账户的常见加固），终端会**照实拉起它并立即退出**——与 SSH 语义一致；要绕过请在 `cordis.patch.yml` 里显式写 `shellPath`；
  - 登录 shell **已被卸载、路径指向目录**等明显不可用时，新建终端会明确报错并提示可显式配置 `shellPath`（而不是给一个一闪就退的终端）。这个预判只覆盖 POSIX 的绝对路径：相对路径与裸名要按子进程的 cwd / PATH 解析，词法预判会误杀能跑的配置，故不预判；
  - 会话是**宿主进程级**的：`dsh web` 重启后全部消失；
  - 断线或离开视图期间产生的输出超出重放缓冲（默认 2 MiB，从头滚掉的部分不再保留）时，缺口补不回来：续接的终端会从缓冲还留着的位置接着长，中间少一段（少掉的正是被裁掉的那一段，客户端已经持有的内容不会被重发），并在接缝处**写一行可见提示**说明缺少多少字节，而不是静默跳段；刷新页面则是整段重建，同样只拿得到缓冲里的内容；
  - 宿主半体不随浏览器热重载（DSH 只轮询 `lib/client.js`）：更新插件后请重启 `dsh web`，让两端来自同一份构建；两端协议不一致时终端可能停在空白画面（例如浏览器半体已更新、宿主仍是很早以前的版本），重启宿主即可恢复；
  - 同一个工作区的终端集合在浏览器标签页之间**共用**：关闭会即时广播收起，但别处新建的终端要等那个标签页下次连接（重连/刷新/切工作区）对账后才会出现；
  - 总数兜底回收可能动到别的工作区里闲置的终端——切回该工作区时那个标签会提示「终端会话不存在」，关掉重建即可。

## 安全说明

终端在**宿主用户权限**下执行任意命令——与直接 SSH 进宿主等价。仅允许已通过 `dsh web` 认证的浏览器会话连接；请勿在不可信网络公开暴露 `dsh web` 端口。

## 开源协议

本项目基于 [MIT](./LICENSE) 协议开源。

Copyright (c) 2026 xht-code
