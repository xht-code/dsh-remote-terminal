/**
 * dsh-remote-terminal 宿主半体。
 *
 * 在宿主进程内维护一组 node-pty 终端会话，并把 WebSocket 升级路由挂到
 * 宿主 Web 服务器上：浏览器客户端经认证后 attach 会话，输入/resize 上行、
 * 输出/退出事件下行。会话独立于浏览器连接保活，刷新页面后可重新接入。
 *
 * 路由与会话表放在 Symbol.for 全局共享状态上按引用计数持有：同一装配若出现两个
 * fiber 并存的窗口期（例如同一插件被挂载两次），路由重复注册会与旧卸载撞车；
 * 引用计数让两端共享同一层，最后一个 fiber 卸载时才销毁路由并清杀全部 PTY。
 *
 * 注意这个窗口与下面的具名服务注册互斥：`ctx.reflect.provide` 对同名服务是硬冲突，
 * 只有旧 fiber 先释放名字，新 fiber 才注册得上。实测 DSH 的两条重载路径都是旧先新
 * （cordis-plugin-loader 先 dispose 再 start；cordis-plugin-hmr 先 registry.delete
 * 再重新挂载），因此正常热重载不会触发；一旦真出现并存窗口，本模块的 apply 会直接
 * 抛错（并归还自己那份引用），而不是让两个 fiber 同时代表共享层。
 *
 * @module dsh-remote-terminal
 */
import { randomBytes } from 'node:crypto'
import { accessSync, constants, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import { spawn as spawnPty } from 'node-pty'
import type { IPty } from 'node-pty'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { ClientMessage, ServerMessage, SessionSummary } from './protocol.ts'
import {
  DEFAULT_SCOPE,
  DEFAULT_WS_PATH,
  MAX_COLS,
  MAX_FRAME_BYTES,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  parseClientMessage,
} from './protocol.ts'

/** 插件名（同时作为 Cordis 插件 id）。 */
export const name = 'dsh-remote-terminal'

/** 声明依赖的服务：Web 服务器提供升级路由，Connection 提供握手认证。 */
export const inject = ['webServer', 'connection'] as const

/** 对外暴露的终端会话服务名（`ctx.terminalSessions`）。 */
export const TERMINAL_SESSIONS_SERVICE = 'terminalSessions'

/**
 * 作用域键的构造与缺省值：`ctx.terminalSessions.create({ scope })` 必须传这套键，
 * 否则会话会落进别的桶、终端视图对账时看不见它。两端共用同一套键，故从宿主入口
 * 一并导出，调用方不必自己拼 `workspace:` 前缀。
 */
export { DEFAULT_SCOPE, workspaceScope } from './protocol.ts'

/** 插件配置。全部字段可选；运行时经 {@link resolveConfig} 补齐默认值。 */
export interface Config {
  /** 终端 shell 可执行文件路径；缺省用账户里的登录 shell（Windows 为 PowerShell）。 */
  shellPath?: string
  /** shell 启动参数；缺省跟着实际要跑的 shell 算（见 {@link defaultShell}）。 */
  shellArgs?: string[]
  /** 同时存活的终端会话上限；按**每个工作区**分别计算，互不挤占。 */
  maxSessions?: number
  /**
   * 全部工作区同时存活的终端会话总数上限（兜底）：达到时优先回收任何工作区里
   * 无客户端挂接的终端（先已退出的，再最久闲置的）。取值应不小于 maxSessions。
   */
  maxSessionsTotal?: number
  /** 每个会话保留的重放缓冲字节上限。 */
  scrollbackMaxBytes?: number
  /** WebSocket 升级路由的绝对路径。 */
  wsPath?: string
}

/** Cordis 配置模式。上限类字段必须为正：0 或负数会让终端永远建不出来。 */
export const Config: z<Config> = z.object({
  shellPath: z.string().required(false),
  shellArgs: z.array(z.string()).required(false),
  maxSessions: z.number().min(1).default(8),
  maxSessionsTotal: z.number().min(1).default(32),
  scrollbackMaxBytes: z.number().min(1).default(2 * 1024 * 1024),
  wsPath: z.string().default(DEFAULT_WS_PATH),
})

/** 默认交互 shell 的钩子包装方式：决定 cwd 上报钩子怎么注入。 */
export type ShellWrap = 'bash' | 'zsh' | 'fish'

/** 补齐默认值后的运行时配置。 */
export interface ResolvedConfig {
  shellPath: string
  shellArgs: string[]
  /**
   * 默认交互 shell 的钩子包装方式：`bash` 走 `--rcfile`、`zsh` 走 `ZDOTDIR`、
   * `fish` 走 `--init-command`，三者都是"先让用户自己的配置生效，再注入 cwd
   * 上报钩子"。自定义 shell，以及登录 shell 不认识的类型（sh、nu 等），为
   * undefined——终端照常可用，只失去 cwd 实时上报（标签名与状态条停留于打开时
   * 的目录）。
   */
  shellWrap: ShellWrap | undefined
  /** 登录 shell 取不到、退回平台默认时的说明（供宿主打一条日志）；正常为 undefined。 */
  shellWarning: string | undefined
  maxSessions: number
  maxSessionsTotal: number
  scrollbackMaxBytes: number
  wsPath: string
}

/** 登录 shell 的查询结果：拿不到时带上原因，由调用方决定退回什么、要不要告警。 */
interface LoginShellLookup {
  /** 账户数据库里的登录 shell；查不到或未记录时为 null。 */
  shell: string | null
  /** 只能退回平台默认时的原因；查到或平台用不上登录 shell 时为 undefined。 */
  failure: string | undefined
}

/**
 * 账户数据库里记录的登录 shell（Linux / macOS 上即 `chsh` 改写的那一项）。
 *
 * Windows 没有这个概念（终端固定用 PowerShell），不去查账户；容器里 uid 不在
 * `/etc/passwd` 时 Node 的 `userInfo()` 会直接抛错（实测 `uv_os_get_passwd`
 * 返回 ENOENT），这里收成"查不到 + 原因"，而不是让插件加载整个失败。
 *
 * @returns 登录 shell 与查询失败原因。
 */
function currentLoginShell(): LoginShellLookup {
  if (process.platform === 'win32') return { shell: null, failure: undefined }
  try {
    const shell = userInfo().shell
    if (shell === null || shell.length === 0) return { shell: null, failure: '账户未记录登录 shell' }
    return { shell, failure: undefined }
  } catch (error) {
    return { shell: null, failure: String(error) }
  }
}

/**
 * 按平台解析默认交互 shell：
 * - Linux / macOS 用账户里的登录 shell：终端就该是你平时用的那个 shell，
 *   提示符、别名与 PATH 才和你自己开的终端一致；
 * - 账户查不到或未记录登录 shell 时退回平台默认（macOS `/bin/zsh`、其余
 *   `/bin/bash`）；
 * - Windows 默认用 PowerShell（不加载用户 profile，目录不实时跟随）。
 *
 * 默认启动参数跟着**实际要跑的 shell** 算：Windows 上只有真用 PowerShell 时才套
 * `-NoLogo -NoProfile`，钉成 Git Bash 之类的 shell 就不套——`bash -NoLogo` 会以
 * "无效的选项"直接退出（实测），要标志请自己写 `shellArgs`。
 *
 * macOS 下 zsh / fish 按**登录 shell** 启动（`-l -i`）：本机终端（Terminal.app /
 * iTerm2）就是登录 shell，只有登录 shell 才会读 `~/.zprofile`（Homebrew 的
 * `brew shellenv` 通常写在这里），fish 也只有登录 shell 才会按 macOS 的
 * `/etc/paths`、`/etc/paths.d` 构造 PATH（见 fish 自带的 `config.fish` 里
 * `status --is-login` 那一段）。Linux 的 GUI 终端（GNOME Terminal / Konsole）
 * 是非登录交互 shell，保持一致。bash 不在其列：`--rcfile` 与 `-l` 互斥（实测
 * `-l` 下 rcfile 不执行，把 `-l` 放在 `--rcfile` 前还会直接报无效选项），
 * 因此 bash 仍以非登录方式启动，`~/.bash_profile` 不加载（见 README 限制一节）。
 *
 * @param platform - 目标平台。
 * @param loginShell - 账户里的登录 shell（POSIX）或钉住的 shell 路径；没有时为 null。
 * @returns 默认 shell 路径、启动参数，以及该 shell 的包装方式（{@link ShellWrap}；
 *   认不出的 shell 为 undefined）。
 */
export function defaultShell(
  platform: NodeJS.Platform,
  loginShell: string | null,
): { shellPath: string; shellArgs: string[]; shellWrap: ShellWrap | undefined } {
  if (platform === 'win32') {
    const shellPath = loginShell !== null && loginShell.length > 0 ? loginShell : 'powershell.exe'
    return {
      shellPath,
      shellArgs: isPowerShell(shellPath) ? ['-NoLogo', '-NoProfile'] : [],
      shellWrap: undefined,
    }
  }
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  const shellPath = loginShell !== null && loginShell.length > 0 ? loginShell : fallback
  const shellWrap = shellWrapOf(shellPath)
  const loginShellArgs = platform === 'darwin' && (shellWrap === 'zsh' || shellWrap === 'fish')
  return { shellPath, shellArgs: loginShellArgs ? ['-l', '-i'] : ['-i'], shellWrap }
}

/**
 * 取路径末段作为可执行文件名；Windows 的分隔符是 `\`，两种都认。
 *
 * @param shellPath - shell 路径。
 * @returns 可执行文件名（不含目录）。
 */
function executableName(shellPath: string): string {
  return shellPath.slice(Math.max(shellPath.lastIndexOf('/'), shellPath.lastIndexOf('\\')) + 1)
}

/**
 * 该路径是否就是 PowerShell（`powershell.exe` / `pwsh` 及其带 `.exe` 的形态）：
 * 只有它才认 `-NoLogo -NoProfile`。
 *
 * @param shellPath - shell 路径。
 * @returns 是 PowerShell 时为 true。
 */
function isPowerShell(shellPath: string): boolean {
  const name = executableName(shellPath).toLowerCase()
  return name === 'powershell' || name === 'powershell.exe' || name === 'pwsh' || name === 'pwsh.exe'
}

/**
 * 按可执行文件名判定默认 shell 的包装方式：路径取末段比对，`/bin/zsh` 与
 * `/opt/homebrew/bin/bash` 都能认出来。认不出的 shell（sh、nu、nologin 等）
 * 没有通用的注入入口，返回 undefined。
 *
 * @param shellPath - 已解析出的 shell 路径。
 * @returns 包装方式；无法注入时为 undefined。
 */
function shellWrapOf(shellPath: string): ShellWrap | undefined {
  const executable = executableName(shellPath)
  if (executable === 'bash') return 'bash'
  if (executable === 'zsh') return 'zsh'
  if (executable === 'fish') return 'fish'
  return undefined
}

/**
 * 归一化插件配置。
 *
 * @param config - 用户配置（经 schema 校验，字段可缺省）。
 * @returns 补齐默认值后的运行时配置。
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const login = currentLoginShell()
  // schemastery 会把未配置的数组字段物化为空数组，YAML 里写了键却不给值则是 null：
  // 缺省 / 空 / null 三种形态一律按"未提供"处理。否则会出现"用了默认 shell 却按
  // 已配置处理、于是不注入钩子"这种半吊子状态，甚至读 `.length` 直接抛错。
  const pinnedPath = typeof config.shellPath === 'string' && config.shellPath.length > 0
    ? config.shellPath
    : undefined
  const configuredArgs = Array.isArray(config.shellArgs) && config.shellArgs.length > 0
    ? config.shellArgs
    : undefined
  // 平台默认值跟着**实际要跑的 shell** 算：钉了 shellPath 就是它，否则是账户里的
  // 登录 shell。否则 macOS 上会错配——账户是 bash 而钉了 zsh / fish 时少了 `-l`
  // （丢掉 `~/.zprofile` 与 fish 的 macOS PATH 构造），账户是 zsh 而钉了 bash 时
  // 又多出 `-l`（bash 侧靠 `--rcfile` 挂钩子，与 `-l` 互斥）。
  const shell = defaultShell(process.platform, pinnedPath ?? login.shell)
  const usesDefaults = pinnedPath === undefined && configuredArgs === undefined
  return {
    // 钉过的路径显式优先；平台默认值只在前者缺省时兜底。
    shellPath: pinnedPath ?? shell.shellPath,
    shellArgs: configuredArgs ?? shell.shellArgs,
    // 包装按默认 shell 的类型注入；显式指定 shellPath / shellArgs 时无从假设语义
    // （`--norc` 之类的自定义参数本就意在绕开配置），一律不注入。
    shellWrap: usesDefaults ? shell.shellWrap : undefined,
    // 只在确实用了平台默认路径时才告警：用户自己钉了 shellPath 时，登录 shell 查
    // 不到与他无关。
    shellWarning: pinnedPath === undefined && login.failure !== undefined
      ? '无法确定账户的登录 shell（' + login.failure + '），已退回 ' + shell.shellPath
      : undefined,
    maxSessions: config.maxSessions ?? 8,
    maxSessionsTotal: config.maxSessionsTotal ?? 32,
    scrollbackMaxBytes: config.scrollbackMaxBytes ?? 2 * 1024 * 1024,
    wsPath: config.wsPath ?? DEFAULT_WS_PATH,
  }
}

/** 宿主 Web 服务器的窄化面：本插件只注册升级路由。 */
interface WebServerLike {
  registerUpgrade(route: {
    path: string
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
  }): () => void
}

/** Connection 服务的窄化面：本插件只在握手时做信任与浏览器认证判定。 */
interface ConnectionLike {
  requestRejection(request: {
    headers: IncomingMessage['headers']
  }): 401 | 403 | undefined
}

/** 重放缓冲里的一块输出及其在会话流里的绝对结束偏移。 */
interface ScrollbackChunk {
  text: string
  /** 该块末字节的绝对偏移（从会话创建起累计），用于按 since 精确续接。 */
  end: number
}

/** 一个宿主持有的 PTY 终端会话。 */
interface TerminalSession {
  id: string
  pty: IPty
  cwd: string
  /** 所属作用域（工作区）：maxSessions 配额按它分别计算。 */
  scope: string
  exited: boolean
  exitCode: number | null
  /** 重放缓冲：node-pty 的 UTF-8 已解码字符串块，按到达顺序重放。 */
  scrollback: ScrollbackChunk[]
  scrollbackBytes: number
  /** 会话创建以来输出过的总字节数；也是下一条输出的绝对起始偏移。 */
  produced: number
  clients: Set<WebSocket>
  /** 最近一次挂接集合清空的时刻（新建时视为空闲）：配额吃紧时据此回收孤儿会话。 */
  idleSince: number
  /** 来源标签（如「预览 p4271」）：由创建方指定，用于终端标签的显示名。 */
  label: string | undefined
  /**
   * 是否由别的插件（预览页签）拉起：这类进程占用的是预览自己的配额，
   * 不计入用户手工终端的 maxSessions，否则预览开的服务会把终端额度吃光。
   */
  external: boolean
}

/** 每个 WebSocket 连接的挂接状态：一个连接可同时挂接多个会话。 */
interface ClientState {
  attachedSessionIds: Set<string>
  /** 心跳存活标记：发 ping 时置 false，收到 pong 置 true。 */
  alive: boolean
}

/** 跨热重载共享的运行层：路由、会话表与连接句柄按引用计数持有。 */
interface SharedState {
  ctx: Context
  config: ResolvedConfig
  refs: number
  wss: WebSocketServer
  sessions: Map<string, TerminalSession>
  routeDisposer: (() => void) | undefined
  /** 已生成的 shell 包装：私有目录 + 该类型要注入的入口（bash 的 rc 文件 / zsh 的 ZDOTDIR）。 */
  shellWrap: { kind: ShellWrap; dir: string; entry: string } | undefined
  /** 半开连接回收的心跳定时器。 */
  heartbeat: NodeJS.Timeout | undefined
}

const sharedStateKey = Symbol.for('dsh-remote-terminal.shared-state')

/** 共享运行层所在的全局槽位（`Symbol.for` 保证跨热重载的模块实例看到同一层）。 */
function sharedStateSlot(): Record<PropertyKey, SharedState | undefined> {
  return globalThis as unknown as Record<PropertyKey, SharedState | undefined>
}

/** 全局连接表：close 事件与心跳需要按连接反查挂接状态。 */
const connectedClients = new WeakMap<WebSocket, ClientState>()

/** 心跳周期：一个周期内未回 pong 的连接视为半开。 */
const HEARTBEAT_INTERVAL_MS = 30_000

/** 单个客户端待发送缓冲的下限阈值（字节）；实际阈值见 {@link clientSendBufferLimit}。 */
const MIN_CLIENT_SEND_BUFFER_BYTES = 4 * 1024 * 1024

/**
 * bash rc 包装内容：先加载用户 rc（保持对话二中"拿到自己的提示符与别名"的
 * 语义），再追加 PROMPT_COMMAND 钩子，在每个提示符前输出 OSC 7
 * （file://host/path）供客户端实时更新工作目录。钩子以追加方式接在用户
 * 已有 PROMPT_COMMAND 之前，保证总会执行。
 */
const BASH_RC_WRAPPER = [
  '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
  `__dsh_rt_report_cwd() { printf '\\033]7;file://%s%s\\033\\\\' "\${HOSTNAME:-localhost}" "$PWD"; }`,
  'PROMPT_COMMAND="__dsh_rt_report_cwd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"',
].join('\n') + '\n'

/**
 * zsh 包装脚本读用户配置所用的私有环境变量：ZDOTDIR 被本插件改写前的真实值。
 * 用户自己的 `.zshenv` / `.zshrc` 在 ZDOTDIR 指向包装目录后已不可见，
 * 包装脚本靠它回源。
 */
const ZSH_USER_ZDOTDIR_ENV = '__DSH_RT_USER_ZDOTDIR'

/**
 * zsh 没有 `--rcfile`，唯一能在用户配置之外插一脚的入口是 **ZDOTDIR**：zsh 每读
 * 一个启动文件都按**当前** `$ZDOTDIR` 定位，所以把 ZDOTDIR 指到私有包装目录后，
 * 用户那几份文件就不再被 zsh 自动加载，改由包装脚本按同样的时机回源：
 *
 * - `.zshenv` 对所有 zsh（含非交互）都执行，用户常在这里设 PATH；
 * - `.zprofile` 只对**登录** shell 执行（macOS 下按 `-l` 启动，见
 *   {@link defaultShell}），是 Homebrew `brew shellenv` 一类的所在地；
 * - `.zshrc` 只对交互 shell 执行，是提示符、别名、补全与各框架（oh-my-zsh /
 *   prezto / zim）的所在地。
 *
 * 两份"回源型"包装（`.zshenv` / `.zprofile`）都做三件事：把 ZDOTDIR 临时交给用户
 * （配置里读 `$ZDOTDIR` 的地方才拿得到自己的目录）、回源、再把 ZDOTDIR **交还**
 * 包装目录（否则 zsh 会顺着用户的新 ZDOTDIR 去找下一个启动文件，我们的
 * `.zshrc` 就轮不到了）。回源后若用户改了 ZDOTDIR（"把配置放 `~/.config/zsh`"
 * 的标准做法），一律采纳新值，`ZDOTDIR` 与私有变量都跟着更新，后续回源用新目录。
 *
 * `.zshrc` 包装则先把 ZDOTDIR 还原成用户原值再回源，否则
 * `source "${ZDOTDIR:-$HOME}/…"` 这类框架初始化会去包装目录里找文件。
 * `.zlogin` 不需要包装：它在 `.zshrc` 之后才执行，那时 ZDOTDIR 已是用户原值，
 * zsh 自己就会去用户目录取。回源之后才挂 cwd 上报钩子，于是钩子不会被用户自己的
 * `precmd` 定义顶掉；`add-zsh-hook` 追加到 precmd 队列尾，用户已有的钩子仍按原
 * 顺序先跑。
 *
 * @param fileName - 要回源的启动文件名。
 * @returns 该文件的包装内容。
 */
function zshSourceWrapper(fileName: '.zshenv' | '.zprofile'): string {
  return [
    `if [ -n "$${ZSH_USER_ZDOTDIR_ENV}" ]; then`,
    '  __dsh_rt_wrap_zdotdir="$ZDOTDIR"',
    `  ZDOTDIR="$${ZSH_USER_ZDOTDIR_ENV}"`,
    `  if [ -f "$ZDOTDIR/${fileName}" ]; then`,
    `    . "$ZDOTDIR/${fileName}"`,
    '  fi',
    `  if [ -n "$ZDOTDIR" ]; then`,
    `    ${ZSH_USER_ZDOTDIR_ENV}="$ZDOTDIR"`,
    '  fi',
    '  ZDOTDIR="$__dsh_rt_wrap_zdotdir"',
    '  unset __dsh_rt_wrap_zdotdir',
    'fi',
  ].join('\n') + '\n'
}

const ZSH_ZSHENV_WRAPPER = zshSourceWrapper('.zshenv')

const ZSH_ZPROFILE_WRAPPER = zshSourceWrapper('.zprofile')

const ZSH_ZSHRC_WRAPPER = [
  `ZDOTDIR="$${ZSH_USER_ZDOTDIR_ENV}"`,
  `unset ${ZSH_USER_ZDOTDIR_ENV}`,
  '',
  'if [ -f "$ZDOTDIR/.zshrc" ]; then',
  '  . "$ZDOTDIR/.zshrc"',
  'fi',
  '',
  `__dsh_rt_report_cwd() { printf '\\033]7;file://%s%s\\033\\\\' "\${HOSTNAME:-localhost}" "$PWD"; }`,
  'autoload -Uz add-zsh-hook',
  'add-zsh-hook precmd __dsh_rt_report_cwd',
].join('\n') + '\n'

/**
 * fish 的启动注入命令：作为 `--init-command`（`-C`）的实参传入，不落盘。
 *
 * fish 的 `-C` 在读完用户的 `config.fish` **之后**执行（实测），所以这里不需要
 * 回源任何配置——用户自己的提示符、别名与插件已经生效，只补一个提示符钩子。
 * 也不用 `XDG_CONFIG_HOME` 那类"换个目录再回源"的做法：那个变量不只影响 fish，
 * 会把整个会话里所有 XDG 应用都指到私有目录去。
 *
 * `--on-event fish_prompt` 是 fish 每次绘制提示符前触发的事件，等价于 bash 的
 * `PROMPT_COMMAND` / zsh 的 `precmd`；事件函数与用户自己的提示符函数互不干扰。
 * 主机名用 fish 的保留变量 `$hostname`（官方就是为去掉对 `hostname` 可执行文件
 * 的依赖而提供），既不 fork 也不受 PATH 影响；它为空时输出仍是合法的
 * `file:///path`，客户端照常解析出路径。
 *
 * 导出以便单测把生成结果喂给真实 fish 验证。
 */
export const FISH_INIT_COMMAND = [
  'function __dsh_rt_report_cwd --on-event fish_prompt',
  `    printf '\\033]7;file://%s%s\\033\\\\' "$hostname" "$PWD"`,
  'end',
].join('\n') + '\n'

/**
 * 按 shell 类型生成包装文件（文件名 → 内容）。
 *
 * bash 只有一份 rc 文件，经 `--rcfile` 注入；zsh 是一整个 ZDOTDIR 目录，靠改写
 * 环境变量生效（登录 shell 下 `.zprofile` 会被读到，非登录时它只是躺在目录里）；
 * fish 不落盘（见 {@link FISH_INIT_COMMAND}）。导出以便单测与集成脚本把生成结果
 * 喂给真实 shell 验证。
 *
 * @param kind - 包装类型；fish 不需要文件，故不接受。
 * @returns 要写进私有包装目录的文件。
 */
export function shellWrapFiles(kind: 'bash' | 'zsh'): Record<string, string> {
  if (kind === 'bash') return { 'bash-rc.sh': BASH_RC_WRAPPER }
  return {
    '.zshenv': ZSH_ZSHENV_WRAPPER,
    '.zprofile': ZSH_ZPROFILE_WRAPPER,
    '.zshrc': ZSH_ZSHRC_WRAPPER,
  }
}

/**
 * 把 shell 包装接到启动参数与环境变量上（纯函数，便于单测直接喂给真实 shell）。
 *
 * bash 走 `--rcfile`；zsh 走 ZDOTDIR（同时把用户真实配置目录交给包装脚本回源）；
 * fish 走 `-C`。`entry` 缺失表示包装没生成出来，此时不注入任何东西。
 *
 * @param kind - 包装类型。
 * @param entry - 包装入口：bash 的 rc 文件路径、zsh 的 ZDOTDIR 目录；fish 不需要（传 undefined）。
 * @param parentEnv - 终端将要使用的环境（zsh 用它取用户真实配置目录）。
 * @returns 要前置到启动参数里的项，以及要叠加到环境上的变量。
 */
export function shellWrapInjection(
  kind: ShellWrap,
  entry: string | undefined,
  parentEnv: Record<string, string>,
): { args: string[]; env: Record<string, string> } {
  if (kind === 'fish') return { args: ['-C', FISH_INIT_COMMAND], env: {} }
  if (entry === undefined) return { args: [], env: {} }
  if (kind === 'bash') return { args: ['--rcfile', entry], env: {} }
  return { args: [], env: { [ZSH_USER_ZDOTDIR_ENV]: userZdotdirOf(parentEnv), ZDOTDIR: entry } }
}

/**
 * 取用户真实的 zsh 配置目录，语义与 zsh 自己的 `${ZDOTDIR:-$HOME}` 一致。
 *
 * @param env - 终端进程将要使用的环境。
 * @returns 用户配置目录。
 */
function userZdotdirOf(env: Record<string, string>): string {
  const zdotdir = env.ZDOTDIR
  if (zdotdir !== undefined && zdotdir.length > 0) return zdotdir
  const home = env.HOME
  if (home !== undefined && home.length > 0) return home
  return homedir()
}

/** 把数值夹取到闭区间内。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max)
}

/** 经当前 fiber 的 logger 发出告警。 */
function warn(state: SharedState, message: string): void {
  state.ctx.logger?.warn?.('[' + name + '] ' + message)
}

/** 经当前 fiber 的 logger 发出调试信息。 */
function info(state: SharedState, message: string): void {
  state.ctx.logger?.info?.('[' + name + '] ' + message)
}

/**
 * 尽力删除一个 shell 包装私有目录：删不掉只记一条日志，不打断调用方
 * （卸载与"写失败后回收半成品"都不该因为一个删不掉的临时目录而失败）。
 *
 * @param state - 共享运行层。
 * @param dir - 要删除的目录。
 * @param failurePrefix - 失败日志的前缀。
 */
function removeWrapDir(state: SharedState, dir: string, failurePrefix: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    warn(state, failurePrefix + String(error))
  }
}

/**
 * 取或创建跨热重载共享的运行层，并计入当前 fiber 的引用。
 *
 * @param ctx - 当前插件上下文（热重载后随最新 fiber 刷新）。
 * @param config - 当前 fiber 解析出的运行时配置。
 * @returns 共享运行层。
 */
function acquireSharedState(ctx: Context, config: ResolvedConfig): SharedState {
  const slot = sharedStateSlot()
  let state = slot[sharedStateKey]
  if (state === undefined) {
    state = {
      ctx,
      config,
      refs: 0,
      wss: new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES }),
      sessions: new Map(),
      routeDisposer: undefined,
      shellWrap: undefined,
      heartbeat: undefined,
    }
    slot[sharedStateKey] = state
    installConnectionHandlers(state)
    state.heartbeat = startHeartbeat(state)
  }
  // 配置与日志能力跟随最新装配层：热重载后的 spawn 与告警都走当前 fiber 的值。
  state.ctx = ctx
  state.config = config
  state.refs += 1
  if (state.routeDisposer === undefined) state.routeDisposer = registerUpgradeRoute(state)
  return state
}

/**
 * 释放当前 fiber 的引用；引用归零时销毁升级路由、断开全部连接并清杀
 * 全部 PTY 会话。
 *
 * 导出仅为让 `scripts/verify-host.mjs` 能断言「同一装配被重复挂载、注册失败时也要
 * 归还引用」这条不变式；生产路径只有 {@link apply} 的 teardown 会调用它。
 *
 * @param state - 共享运行层。
 */
export function releaseSharedState(state: SharedState): void {
  state.refs -= 1
  if (state.refs > 0) return
  state.routeDisposer?.()
  state.routeDisposer = undefined
  if (state.heartbeat !== undefined) {
    clearInterval(state.heartbeat)
    state.heartbeat = undefined
  }
  for (const client of state.wss.clients) client.terminate()
  for (const session of state.sessions.values()) {
    if (!session.exited) session.pty.kill()
  }
  state.sessions.clear()
  state.wss.close()
  if (state.shellWrap !== undefined) {
    removeWrapDir(state, state.shellWrap.dir, '清理 shell 包装临时目录失败：')
    state.shellWrap = undefined
  }
  const slot = sharedStateSlot()
  if (slot[sharedStateKey] === state) delete slot[sharedStateKey]
}

/**
 * 把升级路由挂到宿主 Web 服务器；握手先过 Connection 的信任围栏与浏览器
 * 认证，未认证请求以对应状态码拒绝并销毁 socket。
 *
 * @param state - 共享运行层。
 * @returns 移除该路由的 disposer。
 */
function registerUpgradeRoute(state: SharedState): () => void {
  const webServer = (state.ctx as unknown as { webServer: WebServerLike }).webServer
  return webServer.registerUpgrade({
    path: state.config.wsPath,
    handler: (req, socket, head) => {
      const connection = (state.ctx as unknown as { connection: ConnectionLike }).connection
      const rejection = connection.requestRejection({ headers: req.headers })
      if (rejection !== undefined) {
        socket.write(`HTTP/1.1 ${rejection} Unauthorized\r\nConnection: close\r\n\r\n`)
        socket.destroy()
        return
      }
      state.wss.handleUpgrade(req, socket, head, (ws) => {
        state.wss.emit('connection', ws, req)
      })
    },
  })
}

/**
 * 安装 WebSocket 连接处理器。连接建立时登记挂接状态，关闭时解除挂接。
 * 事件监听随 wss 常驻，仅在引用归零、wss.close() 后随其生命周期终止。
 *
 * @param state - 共享运行层。
 */
function installConnectionHandlers(state: SharedState): void {
  state.wss.on('connection', (ws) => {
    const client: ClientState = { attachedSessionIds: new Set(), alive: true }
    connectedClients.set(ws, client)
    ws.on('pong', () => {
      client.alive = true
    })
    ws.on('message', (raw) => {
      // ws v8 默认以 Buffer 交付文本帧；协议按 JSON 文本帧解析。
      const text = typeof raw === 'string'
        ? raw
        : raw instanceof Buffer
          ? raw.toString('utf8')
          : Buffer.from(raw as ArrayBuffer).toString('utf8')
      handleClientMessage(state, ws, client, text)
    })
    ws.on('close', () => {
      detachClient(state, ws, client)
    })
    ws.on('error', (error) => {
      warn(state, 'WebSocket 连接错误：' + String(error))
      ws.terminate()
    })
  })
}

/**
 * 启动半开连接回收：每周期向全部连接发一次 ping，浏览器在协议层自动回
 * pong；上一周期未回 pong 的连接视为半开并终止。
 *
 * 没有这层保护时，对端网络中断（拔线、休眠、NAT 超时）不会产生 close
 * 事件：连接长期滞留，其发送缓冲随终端输出持续增长；更麻烦的是挂在会话
 * 上的死连接让 clients 永不为空，退出回收与闲置回收都绕不过它，最终占满
 * maxSessions 配额。
 *
 * @param state - 共享运行层。
 * @returns 心跳定时器；调用方在释放共享层时清除。
 */
function startHeartbeat(state: SharedState): NodeJS.Timeout {
  const timer = setInterval(() => {
    for (const ws of state.wss.clients) {
      const client = connectedClients.get(ws)
      if (client === undefined) continue
      if (!client.alive) {
        ws.terminate()
        continue
      }
      client.alive = false
      if (ws.readyState === ws.OPEN) ws.ping()
    }
  }, HEARTBEAT_INTERVAL_MS)
  // 心跳不应阻止进程退出。
  timer.unref()
  return timer
}

/**
 * 分发一条客户端消息。非法消息向该连接回 error，不中断其它连接。
 *
 * @param state - 共享运行层。
 * @param ws - 来源连接。
 * @param client - 来源连接的挂接状态。
 * @param raw - 原始 WebSocket 帧负载。
 */
function handleClientMessage(state: SharedState, ws: WebSocket, client: ClientState, raw: unknown): void {
  const message = parseClientMessage(raw)
  if (message === undefined) {
    sendServerMessage(state, ws, { type: 'error', message: '无法解析的消息' })
    return
  }
  switch (message.type) {
    case 'attach':
      // 显式接住拒绝：handleAttach 内含 await，任何抛出都不该变成未处理拒绝
      // 拖垮宿主进程；失败原因回给发起连接。
      void handleAttach(state, ws, client, message).catch((error: unknown) => {
        warn(state, 'attach 处理失败：' + String(error))
        sendServerMessage(state, ws, {
          type: 'error',
          message: '终端创建失败：' + String(error),
          ...(message.token === undefined ? {} : { token: message.token }),
        })
      })
      break
    case 'input': {
      const session = attachedSession(state, client, message.terminalId)
      if (session === undefined || session.exited) return
      try {
        session.pty.write(message.data)
      } catch (error) {
        // 与 resize 相同：onExit 派发前的 fd 释放窗口内 write 可能抛 EBADF。
        info(state, '终端会话 ' + session.id + ' write 失败：' + String(error))
      }
      break
    }
    case 'resize': {
      const session = attachedSession(state, client, message.terminalId)
      if (session === undefined || session.exited) return
      try {
        session.pty.resize(clamp(message.cols, MIN_COLS, MAX_COLS), clamp(message.rows, MIN_ROWS, MAX_ROWS))
      } catch (error) {
        // PTY 在 onExit 派发前已释放 fd 的竞态窗口内 resize 会抛 EBADF，此时忽略。
        info(state, '终端会话 ' + session.id + ' resize 失败：' + String(error))
      }
      break
    }
    case 'close': {
      disposeSession(state, message.terminalId)
      break
    }
    case 'list': {
      sendServerMessage(state, ws, {
        type: 'sessions',
        sessions: listSessions(state),
        ...(message.token === undefined ? {} : { token: message.token }),
      })
      break
    }
  }
}

/**
 * 列出宿主当前的全部会话摘要。
 *
 * 客户端在连接就绪后请求一次，用来发现**不是自己创建**的会话——例如
 * `dsh-local-preview` 从「预览」页签拉起的服务进程——然后逐个 attach，
 * 使它们以普通终端标签出现。摘要只给对账需要的身份（会话 id + 所属作用域），
 * 标签名与退出状态由 attach 应答给出。
 *
 * @param state - 共享运行层。
 * @returns 按创建顺序排列的会话摘要。
 */
export function listSessions(state: SharedState): SessionSummary[] {
  return [...state.sessions.values()].map(session => ({
    terminalId: session.id,
    scope: session.scope,
  }))
}

/**
 * 单个客户端的待发送缓冲上限：超过即说明对端已经消费不动输出（网络拥塞、
 * 页面主线程卡死、休眠），继续 send 只会让宿主进程内存无界增长——这类连接
 * 心跳探测不到，pong 由浏览器网络层应答。
 *
 * 阈值必须高于 attach 时的重放总量：重放是整段 scrollbackMaxBytes 文本，
 * JSON 转义会把每个控制字符膨胀到 6 倍，否则正常客户端会被自己的重放内容
 * 误判成慢客户端。
 *
 * @param state - 共享运行层。
 * @returns 字节上限。
 */
function clientSendBufferLimit(state: SharedState): number {
  return Math.max(MIN_CLIENT_SEND_BUFFER_BYTES, state.config.scrollbackMaxBytes * 8)
}

/**
 * 向单个连接发送一条已序列化的消息。缓冲超限时断开该连接：客户端会自动
 * 重连并对已记录的会话重新 attach，按重放缓冲重新对齐画面。
 *
 * @param state - 共享运行层。
 * @param ws - 目标连接。
 * @param serialized - 已序列化的服务端消息。
 */
function sendSerialized(state: SharedState, ws: WebSocket, serialized: string): void {
  if (ws.readyState !== ws.OPEN) return
  const limit = clientSendBufferLimit(state)
  if (ws.bufferedAmount > limit) {
    warn(state, '客户端待发送缓冲达 ' + ws.bufferedAmount + ' 字节（上限 ' + limit + '），断开连接以重新同步')
    ws.terminate()
    return
  }
  ws.send(serialized)
}

/**
 * 向单个连接发送一条服务端消息。
 *
 * @param state - 共享运行层。
 * @param ws - 目标连接。
 * @param message - 服务端消息。
 */
function sendServerMessage(state: SharedState, ws: WebSocket, message: ServerMessage): void {
  sendSerialized(state, ws, JSON.stringify(message))
}

/**
 * 向会话的全部连接广播一条服务端消息。
 *
 * @param state - 共享运行层。
 * @param session - 目标会话。
 * @param message - 服务端消息。
 */
function broadcast(state: SharedState, session: TerminalSession, message: ServerMessage): void {
  const serialized = JSON.stringify(message)
  for (const client of session.clients) sendSerialized(state, client, serialized)
}

/** 取当前连接挂接的指定会话；未挂接或会话已不存在时返回 undefined。 */
function attachedSession(state: SharedState, client: ClientState, sessionId: string): TerminalSession | undefined {
  if (!client.attachedSessionIds.has(sessionId)) return undefined
  return state.sessions.get(sessionId)
}

/**
 * 处理 attach：接入既有会话或新建会话。terminalId 指向不存在的会话时
 * 显式报错而不是静默新建，避免拼错 id 后开出意料之外的终端。
 * 一个连接可以先后挂接多个会话（多终端标签），不做互斥。
 *
 * @param state - 共享运行层。
 * @param ws - 来源连接。
 * @param client - 来源连接的挂接状态。
 * @param message - 已校验的 attach 消息。
 */
async function handleAttach(
  state: SharedState,
  ws: WebSocket,
  client: ClientState,
  message: Extract<ClientMessage, { type: 'attach' }>,
): Promise<void> {
  const existing = message.terminalId === undefined ? undefined : state.sessions.get(message.terminalId)
  if (existing !== undefined) {
    attachClient(state, existing, ws, client, message.token, message.since)
    return
  }
  if (message.terminalId !== undefined) {
    sendServerMessage(state, ws, {
      type: 'error',
      message: '终端会话不存在：' + message.terminalId,
      terminalId: message.terminalId,
      ...(message.token === undefined ? {} : { token: message.token }),
    })
    return
  }

  const cwd = await resolveCwd(state, message.cwd)
  if (cwd === undefined) {
    sendServerMessage(state, ws, {
      type: 'error',
      message: '工作目录不可用：' + (message.cwd ?? homedir()),
      ...(message.token === undefined ? {} : { token: message.token }),
    })
    return
  }

  // 目录校验期间连接可能已断开：此刻创建会话会留下无人挂接的僵尸会话，
  // 它收不到 closed，只能等配额吃紧时被当作闲置会话回收。
  if (ws.readyState !== ws.OPEN) {
    info(state, '连接在 attach 处理期间断开，跳过创建终端')
    return
  }

  // 配额分两层：先按作用域（工作区）判定，再用跨工作区的总数上限兜底。手工终端的
  // 配额只管手工终端：external 会话（别的插件拉起的长驻进程）既不占分子，也不能
  // 被这条路径回收——让不占额度的会话去偿还额度，等于把别人的 dev server 杀掉。
  const scope = message.scope ?? DEFAULT_SCOPE
  evictExitedSessions(state, scope, false)
  if (sessionsInScope(state, scope, false).length >= state.config.maxSessions
    && !reclaimIdleSession(state, scope, false)) {
    sendServerMessage(state, ws, {
      type: 'error',
      message: '本工作区的终端会话数已达上限（' + state.config.maxSessions + '），且全部会话都在使用中，请先关闭一个终端',
      ...(message.token === undefined ? {} : { token: message.token }),
    })
    return
  }
  if (state.sessions.size >= state.config.maxSessionsTotal) {
    // 总数兜底：先清掉任何工作区里已退出且无人挂接的，再回收最久闲置的那个。
    evictExitedSessions(state)
    if (state.sessions.size >= state.config.maxSessionsTotal && !reclaimIdleSession(state)) {
      sendServerMessage(state, ws, {
        type: 'error',
        message: '终端会话总数已达上限（' + state.config.maxSessionsTotal + '，跨全部工作区），且没有可回收的闲置终端，请先关闭一个终端',
        ...(message.token === undefined ? {} : { token: message.token }),
      })
      return
    }
  }

  const session = createSession(state, {
    scope,
    cwd,
    cols: clamp(message.cols ?? 80, MIN_COLS, MAX_COLS),
    rows: clamp(message.rows ?? 24, MIN_ROWS, MAX_ROWS),
  })
  state.sessions.set(session.id, session)
  info(state, '已创建终端会话 ' + session.id + '（scope=' + scope + '，cwd=' + session.cwd + '）')
  attachClient(state, session, ws, client, message.token)
}

/**
 * 校验工作目录：显式 cwd 必须是存在的目录，未提供时使用宿主用户主目录。
 * 目录不存在或不可访问时返回 undefined，由调用方向客户端报错。
 *
 * @param state - 共享运行层。
 * @param requested - 客户端请求的 cwd，可为空。
 * @returns 通过校验的目录；失败时返回 undefined。
 */
async function resolveCwd(state: SharedState, requested: string | undefined): Promise<string | undefined> {
  const candidate = requested === undefined || requested.length === 0 ? homedir() : requested
  try {
    const s = await stat(candidate)
    if (s.isDirectory()) return candidate
  } catch (error) {
    warn(state, '工作目录探测失败：' + candidate + '（' + String(error) + '）')
  }
  return undefined
}

/**
 * 取某作用域（工作区）内的会话。
 *
 * @param state - 共享运行层。
 * @param scope - 作用域键。
 * @returns 该作用域内的会话列表。
 */
function sessionsInScope(state: SharedState, scope: string, includeExternal = true): TerminalSession[] {
  return [...state.sessions.values()].filter(session =>
    session.scope === scope && (includeExternal || !session.external))
}

/**
 * 回收已退出且无人挂接的会话，为新建会话腾出配额（不触碰 PTY：进程已经结束）。
 *
 * @param state - 共享运行层。
 * @param scope - 限定作用域；缺省表示跨全部工作区（总数上限兜底时用）。
 * @param includeExternal - 是否连 external 会话一起清；手工配额路径传 false，
 * 否则会把另一个插件还没来得及读取的退出码一并抹掉。
 */
function evictExitedSessions(state: SharedState, scope?: string, includeExternal = true): void {
  for (const [id, session] of state.sessions) {
    if (scope !== undefined && session.scope !== scope) continue
    if (!includeExternal && session.external) continue
    if (session.exited && session.clients.size === 0) state.sessions.delete(id)
  }
}

/**
 * 配额吃紧时回收一个无人挂接的会话（最久空闲者优先）。
 *
 * 浏览器崩溃、关闭标签页都会留下这类孤儿会话：新页面已无从知道它的 id
 * （会话集合记在随标签页销毁的 sessionStorage 里），它自己也不会退出，于是
 * 永久占住一个配额。挂接集合非空的会话一律不动。
 *
 * @param state - 共享运行层。
 * @param scope - 限定作用域；缺省表示跨全部工作区（总数上限兜底时用）。
 * @param includeExternal - 是否把 external 会话也当作回收候选；手工配额路径传
 * false，只回收手工终端——external 不占该额度，就不能被它回收。总数兜底路径
 * 传 true，接受「可能回收掉别人的长驻进程」这一代价（持有方只能靠 `describe()`
 * 发现会话已消失）。
 * @returns 是否回收成功；候选范围内全部会话都在使用中时为 false。
 */
function reclaimIdleSession(state: SharedState, scope?: string, includeExternal = true): boolean {
  let victim: TerminalSession | undefined
  for (const session of state.sessions.values()) {
    if (scope !== undefined && session.scope !== scope) continue
    if (!includeExternal && session.external) continue
    if (session.clients.size > 0) continue
    if (victim === undefined || session.idleSince < victim.idleSince) victim = session
  }
  if (victim === undefined) return false
  const idleSeconds = Math.round((Date.now() - victim.idleSince) / 1000)
  info(state, (scope === undefined ? '总数上限已满' : '作用域 ' + scope + ' 配额已满')
    + '，回收闲置终端会话 ' + victim.id
    + '（scope=' + victim.scope + '，已 ' + idleSeconds + ' 秒无客户端挂接）')
  disposeSession(state, victim.id)
  return true
}

/**
 * 分配一个不可预测的会话 id。不能用递增序号：客户端会把会话集合持久化到
 * sessionStorage，页面刷新后按 id 重新 attach，而宿主重启会让序号从 1 重新
 * 开始——旧 id 会命中新会话，静默串到别人的终端上。
 *
 * @param state - 共享运行层。
 * @returns 未被占用的会话 id。
 */
function createSessionId(state: SharedState): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = 'term-' + randomBytes(6).toString('hex')
    if (!state.sessions.has(id)) return id
  }
  throw new Error('无法分配终端会话 id')
}

/**
 * 生成 shell 包装（惰性、幂等），返回该类型要注入的入口：bash 是 rc 文件路径，
 * zsh 是 ZDOTDIR 目录；生成失败时返回 undefined，此时会话退回不带包装的交互式
 * shell（仅失去 cwd 实时上报）。文件写在进程私有的 0700 临时目录内，不落在可
 * 预测的共享路径上。
 *
 * @param state - 共享运行层。
 * @param kind - 包装类型；fish 不落盘，故不接受。
 * @returns 注入入口；不可用时为 undefined。
 */
function ensureShellWrap(state: SharedState, kind: 'bash' | 'zsh'): string | undefined {
  const existing = state.shellWrap
  // 缓存命中还要求包装文件仍在：宿主长跑期间 /tmp 可能被外部清理（systemd-tmpfiles
  // 默认会清、tmpfs 重启即空、也可能被手动清），继续用不存在的入口会让 shell 静默地
  // 连用户自己的配置一起不加载。
  if (existing !== undefined && existing.kind === kind
    && Object.keys(shellWrapFiles(kind)).every(name => existsSync(join(existing.dir, name)))) {
    return existing.entry
  }
  // 目录按 shell 类型复用（热重载换了默认 shell 时不必重建，两类文件互不干扰）；
  // 目录也一并校验，只清理本次新建的那一个，复用中的目录还有别的会话在用。
  let dir = existing !== undefined && existsSync(existing.dir) ? existing.dir : undefined
  let createdDir = false
  try {
    if (dir === undefined) {
      // mkdtemp 建 0700 私有目录：若直接把可预测文件名写进共享 /tmp，他人可
      // 预置同名符号链接，令 writeFileSync 跟随软链截断任意目标文件。
      dir = mkdtempSync(join(tmpdir(), 'dsh-remote-terminal-'))
      createdDir = true
    }
    for (const [name, content] of Object.entries(shellWrapFiles(kind))) {
      writeFileSync(join(dir, name), content, { mode: 0o600 })
    }
    // zsh 的入口是目录本身（ZDOTDIR），bash 的入口是目录里那份 rc 文件。
    const entry = kind === 'zsh' ? dir : join(dir, 'bash-rc.sh')
    state.shellWrap = { kind, dir, entry }
    return entry
  } catch (error) {
    // 写失败就不留半成品：目录是本函数刚建的，这里直接回收，免得每次重试再攒一个。
    if (createdDir && dir !== undefined) removeWrapDir(state, dir, '回收半成品 shell 包装目录失败：')
    warn(state, '写入 ' + kind + ' 包装失败，cwd 实时上报不可用：' + String(error))
    return undefined
  }
}

/** 创建一个终端会话的请求（交互式 shell 与外部拉起的进程共用）。 */
interface SpawnSessionRequest {
  /** 所属作用域（工作区）：maxSessions 配额按它分别计算。 */
  scope: string
  /** 已校验的工作目录。 */
  cwd: string
  /** 初始列数。 */
  cols: number
  /** 初始行数。 */
  rows: number
  /** 要运行的可执行文件；缺省即配置里的交互式 shell。 */
  command?: string
  /** 可执行文件的参数；传了 `command` 时缺省为空数组，不继承 shell 的交互式参数。 */
  args?: string[]
  /** 额外环境变量，叠加在脱敏父环境之上（`DSH_*` 不在其中，需由调用方显式给出）。 */
  env?: Record<string, string>
  /** 来源标签（如「预览 p4271」），显示为终端标签名。 */
  label?: string
  /** 由别的插件拉起：不计入手工终端的配额。 */
  external?: boolean
}

/**
 * 创建并挂载一个 PTY 会话：spawn 后立即接线输出与退出事件，返回
 * 尚未写入会话表的会话对象（发布由调用方完成）。
 *
 * 传了 `command` 时不套 shell 包装：包装只为交互式 shell 的提示符钩子存在，
 * 拉起的业务进程（dev server 等）不需要、也不该继承那套 `-i` 语义。
 *
 * @param state - 共享运行层。
 * @param request - 会话参数。
 * @returns 新会话。
 */
function createSession(state: SharedState, request: SpawnSessionRequest): TerminalSession {
  const runsCommand = request.command !== undefined
  const file = request.command ?? state.config.shellPath
  // node-pty 对不存在或不可执行的 shell **不抛错**，只是让进程立刻以 1 退出
  // （实测），在终端上表现为"一闪就退"、看不出原因。登录 shell 由账户决定，可能
  // 指向已卸载的程序，所以这里先校验一次，把失败变成一条能指出出路的错误。
  //
  // 只校验 POSIX 的**绝对**路径：
  // - 账户里的登录 shell 必然是绝对路径，这就是本校验的主要目标；
  // - 相对路径的真实含义要按"子进程 chdir 之后的物理目录"解析（node-pty 是先
  //   chdir 再 execvp），而 path.resolve 是纯词法的：cwd 含软链、或路径里带 `..`
  //   时两者会指向不同文件，判断错了比不判断更糟（误杀能跑的配置 / 放行跑不起来的）；
  // - 裸名（Windows 的 powershell.exe、POSIX 的 `zsh`）要按 PATH 查找，同理不预判；
  // - Windows 的 X_OK 语义与 POSIX 不同，也不在这里判断。
  if (!runsCommand && process.platform !== 'win32' && isAbsolute(file)) {
    let reason: string | undefined
    try {
      // 目录也能通过 X_OK（对目录来说它是"可搜索"位），所以先确认是普通文件；
      // statSync 跟随符号链接，软链到普通文件（/bin/sh、Homebrew 的 zsh）照常通过。
      if (!statSync(file).isFile()) reason = '不是普通文件'
      else accessSync(file, constants.X_OK)
    } catch (error) {
      reason = String(error)
    }
    if (reason !== undefined) {
      throw new Error('shell 不可执行：' + file + '（' + reason + '）'
        + '；可在 cordis.patch.yml 里为 remote-terminal 显式配置 shellPath 指向可用的 shell')
    }
  }
  // 拉起外部命令时不继承 shellArgs：那批参数是交互式 shell 的语义（POSIX 的
  // `-i`、Windows 的 `-NoLogo -NoProfile`），塞给业务进程会让 `pnpm dev` 变成
  // `pnpm dev -i`。
  let args = request.args ?? (runsCommand ? [] : state.config.shellArgs)
  // 脱敏父环境（剔除凭据类与全部 DSH_*）：终端不继承 agent shell 的会话事实，
  // 需要 DSH_* 的值请走 create({ env }) 注入，或在 shell 里自己显式 export。
  const env: Record<string, string> = { ...scrubbedParentEnv(), ...request.env }
  const wrap = runsCommand ? undefined : state.config.shellWrap
  if (wrap !== undefined) {
    // fish 不落盘（`-C` 内联），bash / zsh 的包装文件写在私有临时目录里。
    const entry = wrap === 'fish' ? undefined : ensureShellWrap(state, wrap)
    if (wrap === 'fish' || entry !== undefined) {
      const injection = shellWrapInjection(wrap, entry, env)
      args = [...injection.args, ...args]
      Object.assign(env, injection.env)
    }
  }
  // id 先于 spawn 分配：id 分配是唯一会在 spawn 之后抛出的步骤，放在前面才不会
  // 留下没人持有、也没人杀得掉的 PTY。
  const id = createSessionId(state)
  const pty = spawnPty(file, args, {
    name: 'xterm-256color',
    cols: request.cols,
    rows: request.rows,
    cwd: request.cwd,
    env,
  })
  const session: TerminalSession = {
    id,
    pty,
    cwd: request.cwd,
    scope: request.scope,
    exited: false,
    exitCode: null,
    scrollback: [],
    scrollbackBytes: 0,
    produced: 0,
    clients: new Set(),
    idleSince: Date.now(),
    label: request.label,
    external: request.external === true,
  }
  pty.onData((chunk) => {
    appendScrollback(state, session, chunk)
    broadcast(state, session, { type: 'output', terminalId: session.id, data: chunk, offset: session.produced })
  })
  pty.onExit(({ exitCode, signal }) => {
    // 与宿主 LocalTerminalHandle 的语义一致：信号杀死时退出码记为 null。
    session.exited = true
    session.exitCode = signal === undefined || signal === 0 ? exitCode : null
    broadcast(state, session, { type: 'exit', terminalId: session.id, exitCode: session.exitCode })
    info(state, '终端会话 ' + session.id + ' 已退出（exitCode=' + String(session.exitCode) + '）')
  })
  return session
}

/** 把一条输出追加进会话的重放缓冲，超出字节上限时从头部丢弃。 */
function appendScrollback(state: SharedState, session: TerminalSession, chunk: string): void {
  const bytes = Buffer.byteLength(chunk)
  session.produced += bytes
  session.scrollback.push({ text: chunk, end: session.produced })
  session.scrollbackBytes += bytes
  while (session.scrollbackBytes > state.config.scrollbackMaxBytes && session.scrollback.length > 1) {
    const removed = session.scrollback.shift()
    if (removed === undefined) break
    session.scrollbackBytes -= Buffer.byteLength(removed.text)
  }
}

/**
 * 把连接挂到会话上并完成重放握手：先发 attached 元信息，再重放缓冲
 * 输出，最后补发已退出状态与 synced 标记。同一连接可挂接多个会话。
 *
 * `since` 给出客户端已消费到的绝对偏移时只重放此后的块：客户端手里的画面
 * （以及终端的解析状态）因此可以原地续上，不必清屏重放整段历史。块按偏移
 * 精确对齐，客户端报的位置只要取自 output.offset 就落在块边界上，重放的起点
 * 因此不重不漏。客户端报的位置早于缓冲还留着的第一块时（缓冲被裁剪过），
 * 那些块一律重放：被裁掉的那段补不回来，但还留着的内容不会漏发。
 *
 * @param state - 共享运行层。
 * @param session - 目标会话。
 * @param ws - 来源连接。
 * @param client - 来源连接的挂接状态。
 * @param token - attach 请求携带的关联令牌；缺省不回显。
 * @param since - 客户端已消费到的绝对偏移；缺省表示从头重放。
 */
function attachClient(
  state: SharedState,
  session: TerminalSession,
  ws: WebSocket,
  client: ClientState,
  token?: string,
  since?: number,
): void {
  // 已关闭的连接不得进入挂接集合：死连接会让会话的 clients 永不为空，
  // 该会话退出后也无法被 evictExitedSessions 回收。
  if (ws.readyState !== ws.OPEN) return
  session.clients.add(ws)
  client.attachedSessionIds.add(session.id)
  sendServerMessage(state, ws, {
    type: 'attached',
    terminalId: session.id,
    cwd: session.cwd,
    exited: session.exited,
    exitCode: session.exitCode,
    ...(session.label === undefined ? {} : { label: session.label }),
    ...(token === undefined ? {} : { token }),
  })
  // 逐块重放而不是拼成一整帧：整帧会高达十数 MB（JSON 转义把控制字符膨胀到
  // 6 倍），既让客户端一次吞下巨量文本，也让发送缓冲只在帧与帧之间才有检查点。
  for (const chunk of session.scrollback) {
    if (since !== undefined && chunk.end <= since) continue
    sendServerMessage(state, ws, { type: 'output', terminalId: session.id, data: chunk.text, offset: chunk.end })
  }
  if (session.exited) {
    sendServerMessage(state, ws, { type: 'exit', terminalId: session.id, exitCode: session.exitCode })
  }
  // 重放与随后的实时输出之间没有穿插（同一次事件循环里同步发完），因此这里报出
  // 的位置就是客户端拿到 synced 时的确切位置。
  sendServerMessage(state, ws, { type: 'synced', terminalId: session.id, offset: session.produced })
}

/**
 * 解除连接的挂接：从会话的客户端集合中移除。连接关闭时遍历其全部
 * 挂接会话逐个解除；会话因此变为无人挂接时记录空闲起点，供配额回收判定。
 *
 * @param state - 共享运行层。
 * @param ws - 来源连接。
 * @param client - 来源连接的挂接状态。
 */
function detachClient(state: SharedState, ws: WebSocket, client: ClientState): void {
  const now = Date.now()
  for (const sessionId of client.attachedSessionIds) {
    const session = state.sessions.get(sessionId)
    if (session === undefined) continue
    session.clients.delete(ws)
    if (session.clients.size === 0) session.idleSince = now
  }
  client.attachedSessionIds.clear()
}

/**
 * 销毁一个终端会话：终止 PTY、从会话表移除，并通知所有仍挂接该会话
 * 的连接（其它标签页/浏览器窗口也要同步收起该终端）。
 *
 * @param state - 共享运行层。
 * @param sessionId - 要销毁的会话 id。
 */
function disposeSession(state: SharedState, sessionId: string): void {
  const session = state.sessions.get(sessionId)
  if (session === undefined) return
  state.sessions.delete(sessionId)
  if (!session.exited) session.pty.kill()
  broadcast(state, session, { type: 'closed', terminalId: sessionId })
  // 挂接集合同步除名：否则长生命周期连接会随会话反复开关单调积累已销毁的 id。
  for (const ws of session.clients) {
    connectedClients.get(ws)?.attachedSessionIds.delete(sessionId)
  }
  session.clients.clear()
  info(state, '终端会话 ' + sessionId + ' 已销毁')
}

/** 由别的插件拉起的进程的创建请求。 */
export interface ExternalSpawnRequest {
  /** 要运行的可执行文件。 */
  command: string
  /** 可执行文件的参数。 */
  args?: string[]
  /** 工作目录；缺省为用户主目录。 */
  cwd?: string
  /**
   * 额外环境变量，叠加在脱敏父环境之上；也是 `DSH_*` 事实进入进程的唯一通道
   * （脱敏父环境剔除全部 `DSH_*`）。预览用它注入 `DSH_PREVIEW_BASE`。
   */
  env?: Record<string, string>
  /** 来源标签（如「预览 p4271」），显示为终端标签名。 */
  label?: string
  /** 所属作用域（工作区）；缺省归入 default 桶。 */
  scope?: string
  /** 初始列数。 */
  cols?: number
  /** 初始行数。 */
  rows?: number
}

/**
 * 拉起一个由别的插件持有的会话。
 *
 * 与浏览器 attach 新建的终端走同一条 `createSession` 路径，因此它会出现在
 * `listSessions()` 里，终端视图对账后自动 attach——「预览」页签拉起的 dev server
 * 于是就是一个普通终端标签，可看日志、可输入、可 Ctrl-C。
 *
 * 这类会话标记为 `external`：它占用的是调用方自己的配额，不计入手工终端的
 * `maxSessions`，否则预览开几个服务就会把用户的终端额度吃光。
 *
 * @param state - 共享运行层。
 * @param request - 创建参数。
 * @returns 新会话 id。
 * @throws 工作目录不可用时抛出，调用方据此回显原因。
 */
export async function spawnExternalSession(state: SharedState, request: ExternalSpawnRequest): Promise<string> {
  const cwd = await resolveCwd(state, request.cwd)
  if (cwd === undefined) throw new Error('工作目录不可用：' + (request.cwd ?? homedir()))
  if (state.sessions.size >= state.config.maxSessionsTotal) {
    evictExitedSessions(state)
    if (state.sessions.size >= state.config.maxSessionsTotal && !reclaimIdleSession(state)) {
      throw new Error('终端会话总数已达上限（' + state.config.maxSessionsTotal + '），无法拉起新进程')
    }
  }
  const session = createSession(state, {
    scope: request.scope ?? DEFAULT_SCOPE,
    cwd,
    cols: clamp(request.cols ?? 120, MIN_COLS, MAX_COLS),
    rows: clamp(request.rows ?? 30, MIN_ROWS, MAX_ROWS),
    command: request.command,
    ...(request.args === undefined ? {} : { args: request.args }),
    ...(request.env === undefined ? {} : { env: request.env }),
    ...(request.label === undefined ? {} : { label: request.label }),
    external: true,
  })
  state.sessions.set(session.id, session)
  info(state, '已拉起外部会话 ' + session.id + '（' + request.command + '，cwd=' + cwd + '）')
  return session.id
}

/**
 * 关闭一个外部会话（已退出的会话只做清理，不重复广播）。
 *
 * @param state - 共享运行层。
 * @param sessionId - 目标会话 id。
 * @returns 确实关闭了一个未退出的会话时为 true。
 */
export function closeExternalSession(state: SharedState, sessionId: string): boolean {
  const session = state.sessions.get(sessionId)
  if (session === undefined) return false
  const wasRunning = !session.exited
  disposeSession(state, sessionId)
  return wasRunning
}

/**
 * 宿主对外暴露的终端会话入口。
 *
 * 注册为 `ctx.terminalSessions`，由别的插件（如 `dsh-local-preview`）在需要把
 * 一个长驻进程放到终端里时使用；本包自己不再多一份进程管理。
 */
export class TerminalSessionsService extends Service {
  private readonly sessions: SharedState

  /**
   * 注册服务。
   *
   * @param ctx - 宿主上下文（服务随该 fiber 卸载）。
   * @param sessions - 跨热重载共享的运行层。
   */
  constructor(ctx: Context, sessions: SharedState) {
    super(ctx, TERMINAL_SESSIONS_SERVICE)
    this.sessions = sessions
  }

  /**
   * 拉起一个长驻进程并把它登记为终端会话。
   *
   * @param request - 创建参数。
   * @returns 新会话 id，可直接用于关闭或让前端 attach。
   */
  async create(request: ExternalSpawnRequest): Promise<string> {
    return await spawnExternalSession(this.sessions, request)
  }

  /**
   * 关闭一个本服务拉起的会话。
   *
   * @param sessionId - 目标会话 id。
   * @returns 关掉了一个仍在运行的会话时为 true；会话不存在或已退出为 false。
   */
  close(sessionId: string): boolean {
    return closeExternalSession(this.sessions, sessionId)
  }

  /**
   * 读一个会话的当前状态。
   *
   * @param sessionId - 目标会话 id。
   * @returns 是否已退出与退出码；会话不存在（已被销毁或从未存在）时为 undefined。
   */
  describe(sessionId: string): { exited: boolean; exitCode: number | null } | undefined {
    const session = this.sessions.sessions.get(sessionId)
    if (session === undefined) return undefined
    return { exited: session.exited, exitCode: session.exitCode }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * 终端会话服务（由本插件注册）。消费方 `import` 本包任意导出即带上这条声明；
     * 只用到服务时写 `import type {} from 'dsh-remote-terminal'` 即可。
     */
    terminalSessions: TerminalSessionsService
  }
}

/**
 * 安装插件：获取共享运行层并把生命周期计入引用。
 *
 * @param ctx - 当前插件上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config = {}): void {
  // 装配失败时新 fiber 无权代表共享层，要把上下文交还给失败前的持有者。这里存的
  // 必须是当时的值：acquireSharedState 会就地覆写共享层自己的 ctx/config，存对象
  // 引用会把覆写后的结果读回来。
  const existing = sharedStateSlot()[sharedStateKey]
  const previousOwner = existing === undefined ? undefined : { ctx: existing.ctx, config: existing.config }
  const resolved = resolveConfig(config)
  const state = acquireSharedState(ctx, resolved)
  if (resolved.shellWarning !== undefined) warn(state, resolved.shellWarning)
  try {
    // 对外服务：别的插件用它把长驻进程放进终端（服务随本 fiber 卸载而注销）。
    new TerminalSessionsService(ctx, state)
  } catch (error) {
    // 装配失败就没有 fiber 会来卸载，抢在抛错前把这层的引用还掉：否则共享运行层
    // 的引用计数永远不归零，升级路由、心跳与全部 PTY 会活到进程结束。
    releaseSharedState(state)
    // 引用归零时共享层已随之销毁；仍被前一个持有者持有才需要交还 ctx/config，
    // 否则那层会拿着一个已失效的 fiber 发日志、做握手判定。
    if (previousOwner !== undefined) {
      state.ctx = previousOwner.ctx
      state.config = previousOwner.config
    }
    throw error
  }
  ctx.effect(() => () => {
    releaseSharedState(state)
  }, name + ': teardown')
}
