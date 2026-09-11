/**
 * dsh-remote-terminal 宿主半体。
 *
 * 在宿主进程内维护一组 node-pty 终端会话，并把 WebSocket 升级路由挂到
 * 宿主 Web 服务器上：浏览器客户端经认证后 attach 会话，输入/resize 上行、
 * 输出/退出事件下行。会话独立于浏览器连接保活，刷新页面后可重新接入。
 *
 * 路由与会话表放在 Symbol.for 全局共享状态上按引用计数持有：cordis 热重载
 * 的窗口期是"新 fiber 先 apply、旧 fiber 后卸载"，若路由注册绑死单一 fiber
 * 生命周期，旧卸载会与重复注册抛错相撞；引用计数让两端在窗口期共享同一层，
 * 最后一个 fiber 卸载时才销毁路由并清杀全部 PTY。
 *
 * @module dsh-remote-terminal
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import { spawn as spawnPty } from 'node-pty'
import type { IPty } from 'node-pty'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { ClientMessage, ServerMessage } from './protocol.ts'
import { DEFAULT_SCOPE, MAX_COLS, MAX_FRAME_BYTES, MAX_ROWS, MIN_COLS, MIN_ROWS, parseClientMessage } from './protocol.ts'

/** 插件名（同时作为 Cordis 插件 id）。 */
export const name = 'dsh-remote-terminal'

/** 声明依赖的服务：Web 服务器提供升级路由，Connection 提供握手认证。 */
export const inject = ['webServer', 'connection'] as const

/** 插件配置。全部字段可选；运行时经 {@link resolveConfig} 补齐默认值。 */
export interface Config {
  /** 终端 shell 可执行文件路径；缺省按平台选 bash/powershell。 */
  shellPath?: string
  /** shell 启动参数；缺省按平台选交互式无配置参数。 */
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
  wsPath: z.string().default('/api/remote-terminal/ws'),
})

/** 补齐默认值后的运行时配置。 */
export interface ResolvedConfig {
  shellPath: string
  shellArgs: string[]
  /** 是否对默认 bash 注入 --rcfile 包装（cwd 实时上报的前提）。 */
  injectBashRc: boolean
  maxSessions: number
  maxSessionsTotal: number
  scrollbackMaxBytes: number
  wsPath: string
}

/**
 * 按平台解析 shell 默认值：POSIX 用交互式 bash（加载用户 rc 配置，
 * 让人拿到自己的提示符与别名；不沿用 agent 终端刻意隔离的干净环境），
 * Windows 用 PowerShell。
 */
function defaultShell(): { shellPath: string; shellArgs: string[] } {
  if (process.platform === 'win32') {
    return { shellPath: 'powershell.exe', shellArgs: ['-NoLogo', '-NoProfile'] }
  }
  return { shellPath: '/bin/bash', shellArgs: ['-i'] }
}

/**
 * 归一化插件配置。
 *
 * @param config - 用户配置（经 schema 校验，字段可缺省）。
 * @returns 补齐默认值后的运行时配置。
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const shell = defaultShell()
  // schemastory 会把未配置的数组字段物化为空数组：空数组与未提供等价。
  const useDefaultShell = config.shellPath === undefined
    && (config.shellArgs === undefined || config.shellArgs.length === 0)
  return {
    shellPath: config.shellPath !== undefined && config.shellPath.length > 0 ? config.shellPath : shell.shellPath,
    shellArgs: config.shellArgs !== undefined && config.shellArgs.length > 0 ? config.shellArgs : shell.shellArgs,
    // --rcfile 包装只对默认 bash 语义成立；自定义 shell 时无从注入。
    injectBashRc: useDefaultShell && process.platform !== 'win32',
    maxSessions: config.maxSessions ?? 8,
    maxSessionsTotal: config.maxSessionsTotal ?? 32,
    scrollbackMaxBytes: config.scrollbackMaxBytes ?? 2 * 1024 * 1024,
    wsPath: config.wsPath ?? '/api/remote-terminal/ws',
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
  scrollback: string[]
  scrollbackBytes: number
  clients: Set<WebSocket>
  /** 最近一次挂接集合清空的时刻（新建时视为空闲）：配额吃紧时据此回收孤儿会话。 */
  idleSince: number
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
  /** 已生成的 bash rc 私有目录（0700，内含 rc.sh）；未生成时为 undefined。 */
  bashRcDir: string | undefined
  /** 半开连接回收的心跳定时器。 */
  heartbeat: NodeJS.Timeout | undefined
}

const sharedStateKey = Symbol.for('dsh-remote-terminal.shared-state')

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
 * 取或创建跨热重载共享的运行层，并计入当前 fiber 的引用。
 *
 * @param ctx - 当前插件上下文（热重载后随最新 fiber 刷新）。
 * @param config - 当前 fiber 解析出的运行时配置。
 * @returns 共享运行层。
 */
function acquireSharedState(ctx: Context, config: ResolvedConfig): SharedState {
  const globals = globalThis as unknown as Record<PropertyKey, SharedState | undefined>
  let state = globals[sharedStateKey]
  if (state === undefined) {
    state = {
      ctx,
      config,
      refs: 0,
      wss: new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES }),
      sessions: new Map(),
      routeDisposer: undefined,
      bashRcDir: undefined,
      heartbeat: undefined,
    }
    globals[sharedStateKey] = state
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
 * @param state - 共享运行层。
 */
function releaseSharedState(state: SharedState): void {
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
  if (state.bashRcDir !== undefined) {
    try {
      rmSync(state.bashRcDir, { recursive: true, force: true })
    } catch (error) {
      warn(state, '清理 bash rc 临时目录失败：' + String(error))
    }
    state.bashRcDir = undefined
  }
  const globals = globalThis as unknown as Record<PropertyKey, SharedState | undefined>
  if (globals[sharedStateKey] === state) delete globals[sharedStateKey]
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
  }
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
    attachClient(state, existing, ws, client, message.token)
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

  // 配额分两层：先按作用域（工作区）判定，再用跨工作区的总数上限兜底。
  const scope = message.scope ?? DEFAULT_SCOPE
  evictExitedSessions(state, scope)
  if (sessionsInScope(state, scope).length >= state.config.maxSessions && !reclaimIdleSession(state, scope)) {
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

  const session = createSession(state, scope, cwd, clamp(message.cols ?? 80, MIN_COLS, MAX_COLS), clamp(message.rows ?? 24, MIN_ROWS, MAX_ROWS))
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
function sessionsInScope(state: SharedState, scope: string): TerminalSession[] {
  return [...state.sessions.values()].filter(session => session.scope === scope)
}

/**
 * 回收已退出且无人挂接的会话，为新建会话腾出配额。
 *
 * @param state - 共享运行层。
 * @param scope - 限定作用域；缺省表示跨全部工作区（总数上限兜底时用）。
 */
function evictExitedSessions(state: SharedState, scope?: string): void {
  for (const [id, session] of state.sessions) {
    if (scope !== undefined && session.scope !== scope) continue
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
 * @returns 是否回收成功；候选范围内全部会话都在使用中时为 false。
 */
function reclaimIdleSession(state: SharedState, scope?: string): boolean {
  let victim: TerminalSession | undefined
  for (const session of state.sessions.values()) {
    if (scope !== undefined && session.scope !== scope) continue
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
 * 生成 bash rc 包装文件（惰性、幂等），返回其路径；生成失败时返回
 * undefined，此时会话退回普通交互式 bash（仅失去 cwd 实时上报）。
 * 文件写在进程私有的 0700 临时目录内，不落在可预测的共享路径上。
 *
 * @param state - 共享运行层。
 * @returns rc 文件路径；不可用时为 undefined。
 */
function ensureBashRc(state: SharedState): string | undefined {
  if (state.bashRcDir !== undefined) return join(state.bashRcDir, 'rc.sh')
  try {
    // mkdtemp 建 0700 私有目录：若直接把可预测文件名写进共享 /tmp，他人可
    // 预置同名符号链接，令 writeFileSync 跟随软链截断任意目标文件。
    const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-terminal-'))
    const file = join(dir, 'rc.sh')
    writeFileSync(file, BASH_RC_WRAPPER, { mode: 0o600 })
    state.bashRcDir = dir
    return file
  } catch (error) {
    warn(state, '写入 bash rc 包装失败，cwd 实时上报不可用：' + String(error))
    return undefined
  }
}

/**
 * 创建并挂载一个 PTY 会话：spawn 后立即接线输出与退出事件，返回
 * 尚未写入会话表的会话对象（发布由调用方完成）。
 *
 * @param state - 共享运行层。
 * @param scope - 会话所属作用域（工作区）。
 * @param cwd - 已校验的初始工作目录。
 * @param cols - 初始列数。
 * @param rows - 初始行数。
 * @returns 新会话。
 */
function createSession(state: SharedState, scope: string, cwd: string, cols: number, rows: number): TerminalSession {
  let shellPath = state.config.shellPath
  let shellArgs = state.config.shellArgs
  if (state.config.injectBashRc) {
    const rcPath = ensureBashRc(state)
    if (rcPath !== undefined) shellArgs = ['--rcfile', rcPath, ...shellArgs]
  }
  // id 先于 spawn 分配：id 分配是唯一会在 spawn 之后抛出的步骤，放在前面才不会
  // 留下没人持有、也没人杀得掉的 PTY。
  const id = createSessionId(state)
  const pty = spawnPty(shellPath, shellArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: scrubbedParentEnv(),
  })
  const session: TerminalSession = {
    id,
    pty,
    cwd,
    scope,
    exited: false,
    exitCode: null,
    scrollback: [],
    scrollbackBytes: 0,
    clients: new Set(),
    idleSince: Date.now(),
  }
  pty.onData((chunk) => {
    appendScrollback(state, session, chunk)
    broadcast(state, session, { type: 'output', terminalId: session.id, data: chunk })
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
  session.scrollback.push(chunk)
  session.scrollbackBytes += Buffer.byteLength(chunk)
  while (session.scrollbackBytes > state.config.scrollbackMaxBytes && session.scrollback.length > 1) {
    const removed = session.scrollback.shift()
    if (removed === undefined) break
    session.scrollbackBytes -= Buffer.byteLength(removed)
  }
}

/**
 * 把连接挂到会话上并完成重放握手：先发 attached 元信息，再重放缓冲
 * 输出，最后补发已退出状态。同一连接可挂接多个会话。
 *
 * @param state - 共享运行层。
 * @param session - 目标会话。
 * @param ws - 来源连接。
 * @param client - 来源连接的挂接状态。
 * @param token - attach 请求携带的关联令牌；缺省不回显。
 */
function attachClient(state: SharedState, session: TerminalSession, ws: WebSocket, client: ClientState, token?: string): void {
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
    ...(token === undefined ? {} : { token }),
  })
  if (session.scrollback.length > 0) {
    // 逐块重放而不是拼成一整帧：整帧会高达十数 MB（JSON 转义把控制字符膨胀到
    // 6 倍），既让客户端一次吞下巨量文本，也让发送缓冲只在帧与帧之间才有检查点。
    for (const chunk of session.scrollback) {
      sendServerMessage(state, ws, { type: 'output', terminalId: session.id, data: chunk })
    }
  }
  if (session.exited) {
    sendServerMessage(state, ws, { type: 'exit', terminalId: session.id, exitCode: session.exitCode })
  }
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

/**
 * 安装插件：获取共享运行层并把生命周期计入引用。
 *
 * @param ctx - 当前插件上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const state = acquireSharedState(ctx, resolveConfig(config))
  ctx.effect(() => () => {
    releaseSharedState(state)
  }, name + ': teardown')
}
