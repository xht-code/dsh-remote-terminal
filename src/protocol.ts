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
    }
  | { type: 'input'; terminalId: string; data: string }
  | { type: 'resize'; terminalId: string; cols: number; rows: number }
  | { type: 'close'; terminalId: string }

/** 宿主 → 客户端消息。 */
export type ServerMessage =
  | {
      type: 'attached'
      terminalId: string
      cwd: string
      exited: boolean
      exitCode: number | null
      /** attach 请求携带的关联令牌；无则缺省。 */
      token?: string
    }
  | { type: 'output'; terminalId: string; data: string }
  | { type: 'exit'; terminalId: string; exitCode: number | null }
  | { type: 'closed'; terminalId: string }
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
        || !optionalString(message.token)) return undefined
      return {
        type: 'attach',
        ...(message.terminalId === undefined ? {} : { terminalId: message.terminalId }),
        ...(message.cwd === undefined ? {} : { cwd: message.cwd }),
        ...(message.cols === undefined ? {} : { cols: message.cols }),
        ...(message.rows === undefined ? {} : { rows: message.rows }),
        ...(message.scope === undefined ? {} : { scope: message.scope }),
        ...(message.token === undefined ? {} : { token: message.token }),
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
        || !optionalString(message.token)) return undefined
      return {
        type: 'attached',
        terminalId: message.terminalId,
        cwd: message.cwd,
        exited: message.exited,
        exitCode: message.exitCode,
        ...(message.token === undefined ? {} : { token: message.token }),
      }
    }
    case 'output': {
      if (typeof message.terminalId !== 'string' || typeof message.data !== 'string') return undefined
      return { type: 'output', terminalId: message.terminalId, data: message.data }
    }
    case 'exit': {
      if (typeof message.terminalId !== 'string' || !nullableNumber(message.exitCode)) return undefined
      return { type: 'exit', terminalId: message.terminalId, exitCode: message.exitCode }
    }
    case 'closed': {
      if (typeof message.terminalId !== 'string') return undefined
      return { type: 'closed', terminalId: message.terminalId }
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
