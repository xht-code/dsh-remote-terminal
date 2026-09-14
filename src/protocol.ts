/**
 * 宿主半体与客户端半体共用的 WebSocket 线格式与解析器。
 * 解析实现只有这一份，两端各自调用；本文件不依赖 node 或 DOM，
 * 保持纯函数以便隔离测试。
 *
 * @module dsh-remote-terminal/protocol
 */

/** 客户端 → 宿主消息。 */
export type ClientMessage =
  | {
      type: 'attach'
      /** 要接入的既有终端 id；缺省时创建新终端。 */
      terminalId?: string
      /** 新建终端的初始工作目录；缺省时使用宿主用户主目录。 */
      cwd?: string
      /** 初始列数。 */
      cols?: number
      /** 初始行数。 */
      rows?: number
      /**
       * 会话所属作用域（工作区）。只在新建时参与配额判定：每个作用域各自受
       * maxSessions 限制、互不挤占；缺省归入 default 桶。
       */
      scope?: string
      /** 客户端生成的关联令牌；新建终端的 attached/error 应答会原样回显。 */
      token?: string
      /**
       * 客户端已消费到的绝对输出偏移（见 {@link ServerMessage} 的 output.offset）。
       * 宿主只重放这之后的输出，客户端手里的画面因此可以接着长，不必清屏重放；
       * 缺省表示从头重放（全新客户端）。
       *
       * 报的必须是"客户端确实拥有的流位置"：本连接已收到的字节对应的位置，而不是
       * 对话流末尾——宿主只按它过滤缓冲里还留着的块，不做别的校验，报大了就会静默
       * 丢掉那段输出。缓冲被头部裁剪过时缺口补不回来，宿主会把还留着的内容整段重放。
       */
      since?: number
    }
  | { type: 'input'; terminalId: string; data: string }
  | { type: 'resize'; terminalId: string; cols: number; rows: number }
  | { type: 'close'; terminalId: string }
  | {
      /**
       * 列出宿主当前的会话快照。视图在每次连接就绪后请求一次，用来发现**不是
       * 自己创建**的会话（例如 dsh-local-preview 从「预览」页签拉起的服务进程），
       * 对账后逐个 attach，使它们以普通终端标签出现。
       */
      type: 'list'
      /** 关联令牌；sessions 应答原样回显。 */
      token?: string
    }

/**
 * 会话列举里的一条摘要：只带对账需要的身份——宿主会话 id 与所属作用域，
 * 不含输出（避免把重放缓冲带进控制帧）。标签名、cwd、退出状态一律由
 * attach 应答（`attached`）给出，同一份事实不铺两条读取链。
 */
export interface SessionSummary {
  /** 宿主会话 id。 */
  terminalId: string
  /** 会话所属作用域（工作区）；客户端据此决定落到哪个桶。 */
  scope: string
}

/** 宿主 → 客户端消息。 */
export type ServerMessage =
  | {
      type: 'attached'
      terminalId: string
      cwd: string
      exited: boolean
      exitCode: number | null
      /** 创建方指定的来源标签（如「预览 p4271」）；用户手工新建的会话缺省。 */
      label?: string
      /** attach 请求携带的关联令牌；无则缺省。 */
      token?: string
    }
  | {
      type: 'output'
      terminalId: string
      data: string
      /**
       * data 末字节在该会话输出流里的绝对偏移（会话创建起累计的 UTF-8 字节数）。
       * 客户端按它记账，重挂时把 {@link ClientMessage} 的 attach.since 报回来，
       * 宿主据此只补发缺口，既不重复也不需要清屏。
       */
      offset: number
    }
  | { type: 'exit'; terminalId: string; exitCode: number | null }
  | { type: 'closed'; terminalId: string }
  | {
      /**
       * 一次 attach 的重放已发完：客户端此刻的位置就是 offset。客户端据此把
       * 重建中的终端一次性显示出来——重放过程不必让用户看见。
       */
      type: 'synced'
      terminalId: string
      offset: number
    }
  | {
      /**
       * 会话列举应答：宿主当前的全部会话（含由别的插件创建的），每条只带
       * 对账需要的身份，标签名与退出状态由后续 attach 应答给出。
       */
      type: 'sessions'
      sessions: SessionSummary[]
      /** list 请求携带的关联令牌；无则缺省。 */
      token?: string
    }
  | {
      type: 'error'
      message: string
      /** attach 请求携带的关联令牌；无则缺省。 */
      token?: string
      /** 触发错误的会话 id（仅"会话不存在"类错误携带），供客户端剔除失效会话。 */
      terminalId?: string
    }

/** 列数合法区间（node-pty 与 xterm.js 的公共可行域）。 */
export const MIN_COLS = 2
export const MAX_COLS = 500
/** 行数合法区间。 */
export const MIN_ROWS = 2
export const MAX_ROWS = 300

/** 单条 input 消息的文本分片上限（UTF-16 码元）。 */
export const MAX_INPUT_CHUNK_CHARS = 32 * 1024

/**
 * attach 未带 scope 时的作用域键（未归属任何工作区的会话共用它）。
 * 作用域是终端会话集合与配额的分组维度：客户端按它分桶，宿主按它分别计算
 * maxSessions，两端必须用同一套键，故常量与构造函数都放在这里。
 */
export const DEFAULT_SCOPE = 'default'

/**
 * 工作区对应的作用域键。
 *
 * @param workspaceId - 工作区标识。
 * @returns 作用域键。
 */
export function workspaceScope(workspaceId: string): string {
  return 'workspace:' + workspaceId
}

/**
 * 宿主接受的单帧字节上限。必须大于 {@link MAX_INPUT_CHUNK_CHARS}，为 JSON
 * 信封与转义留出余量；单帧上限存在的意义是给解析内存兜底，而不是卡住输入。
 */
export const MAX_FRAME_BYTES = 1024 * 1024

/**
 * WebSocket 升级路由的默认路径，同时是宿主 `Config.wsPath` 的默认值。
 * 两端共用本常量，避免同一个默认路径出现第二份硬编码；宿主把它配成别的值时
 * 浏览器半体连不上——它读不到宿主配置，只会连本常量。
 */
export const DEFAULT_WS_PATH = '/api/remote-terminal/ws'

/**
 * 把一条输入文本切成不超过 {@link MAX_INPUT_CHUNK_CHARS} 的分片。
 * xterm 的粘贴是整段一次交付、WebSocket 单帧又受宿主上限约束，因此大粘贴
 * 必须分帧上行；分片不在代理对中间切断，否则半个代理项会被编码成替换字符。
 *
 * @param data - 上行输入文本。
 * @returns 保持原顺序的分片序列；短输入原样返回单元素数组。
 */
export function splitInputChunks(data: string): string[] {
  if (data.length <= MAX_INPUT_CHUNK_CHARS) return [data]
  const chunks: string[] = []
  let offset = 0
  while (offset < data.length) {
    let end = Math.min(offset + MAX_INPUT_CHUNK_CHARS, data.length)
    const last = data.charCodeAt(end - 1)
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end += 1
    chunks.push(data.slice(offset, end))
    offset = end
  }
  return chunks
}

/** 解析一条 JSON 文本帧；非对象或非法 JSON 返回 undefined。 */
function parseJsonObject(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  return parsed as Record<string, unknown>
}

/** 校验可选字符串字段：缺省通过，出现则必须是字符串。 */
function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

/** 校验可选数值字段：缺省通过，出现则必须是有限数值。 */
function optionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

/** 校验可空数值字段：null 或有限数值。 */
function nullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

/**
 * 校验并解析一条客户端消息；形状非法时返回 undefined。
 *
 * @param raw - WebSocket 文本帧负载（或等价字符串）。
 * @returns 已校验消息；非法输入为 undefined。
 */
export function parseClientMessage(raw: unknown): ClientMessage | undefined {
  const message = parseJsonObject(raw)
  if (message === undefined) return undefined
  switch (message.type) {
    case 'attach': {
      if (!optionalString(message.terminalId)
        || !optionalString(message.cwd)
        || !optionalNumber(message.cols)
        || !optionalNumber(message.rows)
        || !optionalString(message.scope)
        || !optionalString(message.token)
        || !optionalNumber(message.since)
        || (message.since !== undefined && message.since < 0)) return undefined
      return {
        type: 'attach',
        ...(message.terminalId === undefined ? {} : { terminalId: message.terminalId }),
        ...(message.cwd === undefined ? {} : { cwd: message.cwd }),
        ...(message.cols === undefined ? {} : { cols: message.cols }),
        ...(message.rows === undefined ? {} : { rows: message.rows }),
        ...(message.scope === undefined ? {} : { scope: message.scope }),
        ...(message.token === undefined ? {} : { token: message.token }),
        ...(message.since === undefined ? {} : { since: message.since }),
      }
    }
    case 'input': {
      if (typeof message.terminalId !== 'string' || typeof message.data !== 'string') return undefined
      return { type: 'input', terminalId: message.terminalId, data: message.data }
    }
    case 'resize': {
      if (typeof message.terminalId !== 'string'
        || !optionalNumber(message.cols) || !optionalNumber(message.rows)
        || message.cols === undefined || message.rows === undefined) return undefined
      return { type: 'resize', terminalId: message.terminalId, cols: message.cols, rows: message.rows }
    }
    case 'close': {
      if (typeof message.terminalId !== 'string') return undefined
      return { type: 'close', terminalId: message.terminalId }
    }
    case 'list': {
      if (!optionalString(message.token)) return undefined
      return {
        type: 'list',
        ...(message.token === undefined ? {} : { token: message.token }),
      }
    }
    default:
      return undefined
  }
}

/**
 * 校验并解析一条服务端消息；形状非法时返回 undefined。
 *
 * @param raw - WebSocket 文本帧负载（或等价字符串）。
 * @returns 已校验消息；非法输入为 undefined。
 */
export function parseServerMessage(raw: unknown): ServerMessage | undefined {
  const message = parseJsonObject(raw)
  if (message === undefined) return undefined
  switch (message.type) {
    case 'attached': {
      if (typeof message.terminalId !== 'string' || typeof message.cwd !== 'string'
        || typeof message.exited !== 'boolean'
        || !nullableNumber(message.exitCode)
        || !optionalString(message.label)
        || !optionalString(message.token)) return undefined
      return {
        type: 'attached',
        terminalId: message.terminalId,
        cwd: message.cwd,
        exited: message.exited,
        exitCode: message.exitCode,
        ...(message.label === undefined ? {} : { label: message.label }),
        ...(message.token === undefined ? {} : { token: message.token }),
      }
    }
    case 'output': {
      if (typeof message.terminalId !== 'string'
        || typeof message.data !== 'string'
        || !optionalNumber(message.offset)
        || message.offset === undefined) return undefined
      return { type: 'output', terminalId: message.terminalId, data: message.data, offset: message.offset }
    }
    case 'exit': {
      if (typeof message.terminalId !== 'string' || !nullableNumber(message.exitCode)) return undefined
      return { type: 'exit', terminalId: message.terminalId, exitCode: message.exitCode }
    }
    case 'closed': {
      if (typeof message.terminalId !== 'string') return undefined
      return { type: 'closed', terminalId: message.terminalId }
    }
    case 'synced': {
      if (typeof message.terminalId !== 'string'
        || !optionalNumber(message.offset)
        || message.offset === undefined) return undefined
      return { type: 'synced', terminalId: message.terminalId, offset: message.offset }
    }
    case 'sessions': {
      if (!Array.isArray(message.sessions) || !optionalString(message.token)) return undefined
      const sessions: SessionSummary[] = []
      for (const entry of message.sessions as unknown[]) {
        if (typeof entry !== 'object' || entry === null) return undefined
        const row = entry as Record<string, unknown>
        if (typeof row.terminalId !== 'string' || typeof row.scope !== 'string') return undefined
        sessions.push({ terminalId: row.terminalId, scope: row.scope })
      }
      return {
        type: 'sessions',
        sessions,
        ...(message.token === undefined ? {} : { token: message.token }),
      }
    }
    case 'error': {
      if (typeof message.message !== 'string'
        || !optionalString(message.token)
        || !optionalString(message.terminalId)) return undefined
      return {
        type: 'error',
        message: message.message,
        ...(message.token === undefined ? {} : { token: message.token }),
        ...(message.terminalId === undefined ? {} : { terminalId: message.terminalId }),
      }
    }
    default:
      return undefined
  }
}
