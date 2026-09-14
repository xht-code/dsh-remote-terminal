/**
 * 浏览器侧 WebSocket 客户端：单条到宿主升级路由的连接，负责 attach、
 * 输入/resize/close 上行，输出/退出/closed 事件分发，以及断线后的
 * 指数退避重连。
 *
 * 连接只做传输与重连，不持有任何会话状态：会话集合的登记与恢复在 sessions
 * 模块（按工作区分桶），"何时新建终端、按什么尺寸新建、重挂时报什么 since"
 * 由运行时（见 runtime 模块）决定——会话要按终端实际尺寸创建，而尺寸只有
 * xterm 挂载后才测得到，所以建会话的时机不能留在连接层（见
 * {@link TerminalConnection.onOpen}）。
 *
 * @module dsh-remote-terminal/client-connection
 */
import type { ClientMessage, ServerMessage } from '../protocol.ts'
import { DEFAULT_WS_PATH, parseServerMessage, splitInputChunks } from '../protocol.ts'

/** 重连退避：首次 1s，每次翻倍，封顶 15s。 */
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 15000

/** 未连接时排队消息的上限；超出丢弃最旧条目。 */
const PENDING_LIMIT = 64

/** 一条服务端消息的监听器。 */
export type MessageListener = (message: ServerMessage) => void

/**
 * 浏览器侧终端连接句柄：只负责传输与重连。作用域运行时在视图挂上时
 * {@link start}，离开超过宽限期时 {@link close}；会话集合的登记、恢复与新建
 * 策略都在运行时与 sessions 模块里，连接对象本身不持有任何会话状态。
 */
export interface TerminalConnection {
  /** 开始连接；幂等，重复调用不产生第二条连接。 */
  start(): void
  /** 发送一条客户端消息；连接未就绪时控制类消息入队、按键输入丢弃。 */
  send(message: ClientMessage): void
  /** 订阅服务端消息。 */
  subscribe(listener: MessageListener): () => void
  /**
   * 订阅"连接就绪"（含每次重连）：回调里可以安全发送消息，用于恢复已知会话
   * 或新建首个终端。
   */
  onOpen(listener: () => void): () => void
  /** 主动关闭连接并停止重连。 */
  close(): void
}

class TerminalConnectionImpl implements TerminalConnection {
  private ws: WebSocket | undefined
  private listeners = new Set<MessageListener>()
  private openListeners = new Set<() => void>()
  private pending: ClientMessage[] = []
  private reconnectTimer: number | undefined
  private reconnectDelay = RECONNECT_BASE_MS
  private closed = false

  start(): void {
    if (this.closed || this.ws !== undefined) return
    this.open()
  }

  send(message: ClientMessage): void {
    if (this.closed) return
    // 大粘贴（xterm 整段一次交付）必须分帧：宿主按单帧上限拒收超限帧并断开
    // 连接，整段发送会让粘贴直接失败并触发一次重连。
    if (message.type === 'input') {
      // 断线期间的按键输入不回放：重连后补发历史输入会让 shell 收到用户并未
      // 在当前提示符下敲入的内容；终端断线的标准语义就是丢弃输入。
      if (this.isOpen()) {
        for (const chunk of splitInputChunks(message.data)) {
          this.sendNow({ type: 'input', terminalId: message.terminalId, data: chunk })
        }
      }
      return
    }
    if (this.isOpen()) {
      this.sendNow(message)
      return
    }
    // 连接尚未建立（首连/重连窗口）时入队，onopen 后统一冲刷；控制类消息
    // 数量有限，仍设上限防止长时间断线下的无界增长。
    this.pending.push(message)
    if (this.pending.length > PENDING_LIMIT) this.pending.shift()
  }

  subscribe(listener: MessageListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener)
    return () => {
      this.openListeners.delete(listener)
    }
  }

  close(): void {
    this.closed = true
    this.pending = []
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = undefined
  }

  /** 当前 socket 是否可立即写入。 */
  private isOpen(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN
  }

  /** 在已就绪的 socket 上发出一条消息；调用方负责确认连接可用。 */
  private sendNow(message: ClientMessage): void {
    this.ws?.send(JSON.stringify(message))
  }

  private open(): void {
    // 已关闭的连接不再重开：close() 与重连定时器之间只靠 clearTimeout 保证
    // 互斥，这里再挡一层，避免关闭后仍建立新 socket。
    if (this.closed) return
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(protocol + '//' + window.location.host + DEFAULT_WS_PATH)
    this.ws = ws

    ws.onopen = () => {
      this.reconnectDelay = RECONNECT_BASE_MS
      // 先冲刷连接建立前入队的消息（如用户抢在握手完成前点了「+」）。
      const pending = this.pending
      this.pending = []
      for (const message of pending) {
        if (this.isOpen()) this.sendNow(message)
      }
      // 恢复已知会话与新建首个终端都由视图在 onOpen 里决定：会话要按终端实际
      // 尺寸创建，而尺寸只有 xterm 挂载后才测得到。
      for (const listener of [...this.openListeners]) listener()
    }

    ws.onmessage = (event) => {
      const message = parseServerMessage(event.data)
      if (message === undefined) return
      for (const listener of this.listeners) listener(message)
    }

    ws.onclose = () => {
      this.ws = undefined
      if (this.closed) return
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = undefined
        this.open()
      }, this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
    }

    ws.onerror = () => {
      // 错误后必然触发 onclose，重连由 close 分支接管。
      ws.close()
    }
  }
}

/**
 * 创建一条终端连接。
 *
 * @returns 连接句柄；调用方负责 start 与 close。
 */
export function connectTerminal(): TerminalConnection {
  return new TerminalConnectionImpl()
}
