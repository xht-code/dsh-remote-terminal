/**
 * 终端运行时：一个作用域（工作区）一份，活在 React 视图之外。
 *
 * DSH 的会话视图区只渲染当前激活的那个 view（切换时上一个是真的卸载），而终端
 * 画面与 PTY 会话都不该跟着视图来回重建：xterm 实例、标签集合与 WebSocket 连接
 * 因此由本模块按作用域持有，视图只负责把 holder 贴到面板上、把状态渲染成标签栏。
 * 切走再切回时终端原样还在，不重放、不闪。
 *
 * 断线与释放后重新挂接按绝对输出偏移续接（见 protocol 的 output.offset 与
 * attach.since）：客户端报出已消费到的位置，宿主只补缺口，画面原地长出来，
 * 既不会重放整段历史，也不会漏掉离开期间产生的输出。全新客户端（刷新页面、
 * 新浏览器标签页）没有画面可续，只能整段重放——期间终端先遮住，重放解析完
 * （synced）再一次性显示，用户看到的是当前画面而不是"又跑一遍"的过程。
 *
 * @module dsh-remote-terminal/client-runtime
 */

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { ClientMessage, ServerMessage } from '../protocol.ts'
import { connectTerminal } from './connection.ts'
import type { TerminalConnection } from './connection.ts'
import { planReconcile } from './reconcile.ts'
import { currentTheme, readCodeFontFamily } from './theme.ts'
import { parseOsc7Cwd } from './labels.ts'
import { forgetSession, rememberSession, sessionsOf } from './sessions.ts'

/**
 * 连接就绪时向宿主索要会话快照的关联令牌。对账要等这条应答才能判定"本工作区到底
 * 有没有终端"，所以首个终端的回退新建也挂在它上面（见 `sessions` 分支）。
 */
const RECONCILE_TOKEN = 'reconcile'

/**
 * 视图卸下后连接继续保活的时长：这段时间内切回视图完全无感（连接没断、输出没停）。
 * 超过之后释放连接，让宿主重新把该会话视为闲置、配额吃紧时可以回收；下次挂回
 * 时按偏移续接，缺口由宿主的重放缓冲补齐。
 */
const DETACHED_CONNECTION_TTL_MS = 60_000

/** 单个终端标签的展示状态。 */
export interface TabState {
  /** 标签稳定标识：新建标签为 token，恢复的会话为会话 id；挂载与切换都按它索引。 */
  key: string
  /** 宿主会话 id；attach 应答到达前为空。 */
  terminalId: string | null
  cwd: string
  /** 创建方指定的来源标签（如「预览 p4271」）：有则以它作标签名，没有再退回 cwd。 */
  label: string | null
  exited: boolean
  exitCode: number | null
  error: string | null
}

/** 视图渲染所需的状态：标签列表与当前激活项。 */
export interface RuntimeState {
  tabs: readonly TabState[]
  activeKey: string | null
}

/** 已挂载的 xterm 实例及其 DOM 宿主。 */
interface MountedTerminal {
  terminal: Terminal
  fit: FitAddon
  holder: HTMLDivElement
  /** 宿主会话 id；新建标签先挂载、应答到达后补齐，输入/resize 事件据此上行。 */
  terminalId: string | null
  /** 已消费到的绝对输出偏移；重挂时作为 attach.since 报给宿主。 */
  consumed: number
  /** 重放解析完成前先遮住画面，避免把"重放过程"显示给用户。 */
  revealed: boolean
  /** xterm 事件/解析器注册句柄；销毁实例前显式释放。 */
  disposables: { dispose(): void }[]
}

/**
 * 一个作用域的终端运行时。视图通过 {@link attachPanel} / {@link detachPanel}
 * 借出画面，通过 {@link subscribe} 订阅标签状态。
 */
export class ScopeRuntime {
  /** 本运行时对应的作用域键（工作区）。 */
  readonly scope: string

  private connection: TerminalConnection | null = null
  private panel: HTMLElement | null = null
  private workspacePath: (() => string | undefined) | null = null
  private readonly mounted = new Map<string, MountedTerminal>()
  /**
   * 已发出 attach、还没收到 attached/error 的会话 id。回退新建"一个终端都没有"的
   * 判定必须把它们算进来：恢复多个会话时，失效会话的错误会先于存活会话的 attached
   * 到达，只看挂载记录会误判成"本工作区没有任何终端"，凭空多开一个 shell。
   */
  private readonly pendingAttaches = new Set<string>()
  private tabs: readonly TabState[] = []
  private activeKey: string | null = null
  private state: RuntimeState = { tabs: [], activeKey: null }
  private readonly listeners = new Set<() => void>()
  private fallbackUsed = false
  private nextToken = 1
  private nextErrorKey = 1
  private releaseTimer: number | undefined
  private fitFrame: number | undefined

  /**
   * 建立一个作用域运行时；调用方经 {@link runtimeFor} 取用，不要直接构造。
   *
   * @param scope - 作用域键（工作区）。
   */
  constructor(scope: string) {
    this.scope = scope
  }

  /**
   * 订阅标签状态变化。
   *
   * @param listener - 状态变化时调用。
   * @returns 取消订阅。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 取当前状态；引用只在状态确实变化时更换，可直接交给
   * `useSyncExternalStore` 作快照。
   *
   * @returns 标签列表与激活项。
   */
  getState(): RuntimeState {
    return this.state
  }

  /**
   * 视图挂上：把全部 holder 贴回面板，必要时（重）建连接。
   *
   * @param panel - 承载终端容器的面板元素。
   * @param workspacePath - 取新建终端默认目录的回调（工作区注册表异步就绪，故按需读）。
   */
  attachPanel(panel: HTMLElement, workspacePath: () => string | undefined): void {
    this.panel = panel
    this.workspacePath = workspacePath
    if (this.releaseTimer !== undefined) {
      window.clearTimeout(this.releaseTimer)
      this.releaseTimer = undefined
    }
    for (const mounted of this.mounted.values()) panel.appendChild(mounted.holder)
    this.syncVisibility()
    // holder 已回到面板（元素有尺寸）再同步样式：隐藏期间宿主换过的主题/字体在这里补齐。
    this.syncTheme()
    if (this.connection === null) this.openConnection()
    this.fitActive()
  }

  /** 视图卸下：只摘 DOM，终端实例与连接都留着；连接宽限一段时间后再释放。 */
  detachPanel(): void {
    this.panel = null
    // workspacePath 刻意保留：宽限期内连接仍会收消息，对账回退可能在此刻建会话
    //（例如另一个浏览器关掉了本工作区最后一个终端，随后连接重连）。此时用最后一次
    // 已知的工作区目录，别把终端开到宿主用户主目录去。回调读的是视图的 ref，视图
    // 卸载后它的值仍是最后渲染的那个工作区路径。
    for (const mounted of this.mounted.values()) mounted.holder.remove()
    // 没有任何终端实例就没什么可保活的：直接释放连接，不必占着配额。
    if (this.mounted.size === 0) {
      this.releaseConnection()
      return
    }
    if (this.releaseTimer === undefined) {
      this.releaseTimer = window.setTimeout(() => {
        this.releaseConnection()
      }, DETACHED_CONNECTION_TTL_MS)
    }
  }

  /**
   * 新建终端：先挂标签并挂载 xterm，下一帧尺寸稳定后再按该尺寸建会话。
   * 若先按默认 80×24 建会话，窄屏上 shell 会先按 80 列打印提示符、再被
   * resize 触发 readline 重绘，屏幕上就留下两条提示符。
   */
  newTab(): void {
    const connection = this.connection
    if (connection === null) return
    const token = 'new-' + this.nextToken++
    this.patchTabs(prev => [...prev, {
      key: token, terminalId: null, cwd: '', label: null, exited: false, exitCode: null, error: null,
    }])
    this.setActiveKey(token)
    this.mountTerminal(token, null)
    window.requestAnimationFrame(() => {
      const mounted = this.mounted.get(token)
      // 挂载记录才是"标签还在"的同步事实：tabs 要等 React 提交渲染才更新，而
      // 这一帧往往早于那次提交（关标签同理，removeTab 会同步删掉记录）。
      if (mounted === undefined) return
      connection.send({
        type: 'attach',
        cwd: this.workspacePath?.() ?? undefined,
        cols: mounted.terminal.cols,
        rows: mounted.terminal.rows,
        scope: this.scope,
        token,
      })
    })
  }

  /**
   * 关闭标签：向宿主请求销毁会话后本地移除。
   *
   * @param key - 标签稳定标识。
   */
  closeTab(key: string): void {
    const tab = this.tabs.find(entry => entry.key === key)
    if (tab !== undefined && tab.terminalId !== null) this.send({ type: 'close', terminalId: tab.terminalId })
    this.removeTab(key)
  }

  /**
   * 切换激活标签，并让它在显示之后重新适配尺寸。
   *
   * @param key - 标签稳定标识。
   */
  activate(key: string): void {
    this.setActiveKey(key)
    this.fitActive()
  }

  /**
   * 在下一帧适配激活终端。隐藏容器的尺寸解析为 NaN，FitAddon 会静默跳过，
   * 因此窗口在标签隐藏期间缩放后该标签会滞留旧尺寸；切回时必须在显示之后补一次。
   */
  fitActive(): void {
    if (this.fitFrame !== undefined) window.cancelAnimationFrame(this.fitFrame)
    this.fitFrame = window.requestAnimationFrame(() => {
      this.fitFrame = undefined
      this.mounted.get(this.activeKey ?? '')?.fit.fit()
    })
  }

  /** 面板尺寸变化时对所有已挂载终端重新适配。 */
  fitAll(): void {
    for (const { fit } of this.mounted.values()) fit.fit()
  }

  /**
   * 同步主题与字体到所有已挂载终端。除了宿主切换主题时的现场调用，视图重新挂上
   * 时也必须调一次：终端实例跨视图保活，而观察者随视图卸载而断开，隐藏期间换的
   * 主题/字体会没人通知（此前每次重挂都会重建终端，刚好掩盖了这一点）。
   */
  syncTheme(): void {
    const theme = currentTheme()
    const fontFamily = readCodeFontFamily()
    for (const { terminal } of this.mounted.values()) {
      terminal.options.theme = theme
      terminal.options.fontFamily = fontFamily
    }
  }

  /** 建立连接：连接就绪时恢复本工作区已知会话，并要一次会话快照用于对账。 */
  private openConnection(): void {
    const connection = connectTerminal()
    this.connection = connection
    connection.subscribe(message => this.handleMessage(message))
    connection.onOpen(() => {
      for (const sessionId of sessionsOf(this.scope)) {
        this.pendingAttaches.add(sessionId)
        connection.send({ type: 'attach', terminalId: sessionId, ...this.sinceOf(sessionId) })
      }
      // 快照用于发现不是本视图创建的会话（预览页签拉起的服务进程等）：对账后逐个
      // attach，它们就会以普通终端标签出现。首个终端的回退新建也等这次应答。
      connection.send({ type: 'list', token: RECONCILE_TOKEN })
    })
    connection.start()
  }

  /** 释放连接：会话在宿主侧因此重新变为无人挂接，可被配额回收；终端画面留在本地。 */
  private releaseConnection(): void {
    if (this.releaseTimer !== undefined) {
      window.clearTimeout(this.releaseTimer)
      this.releaseTimer = undefined
    }
    // 连接没了就不会再有 attached/error 回来，在途记录必须一并清掉，
    // 否则它们会永久挡住"本工作区没有终端"的回退新建。
    this.pendingAttaches.clear()
    this.connection?.close()
    this.connection = null
  }

  /** 发送一条客户端消息；连接不在时静默丢弃（控制类消息由下一次 attach 重新对齐）。 */
  private send(message: ClientMessage): void {
    this.connection?.send(message)
  }

  /**
   * 已消费偏移：画面还在手上时把位置报给宿主，让它只补发缺口；没有画面可续
   * （全新挂载）时不带 since，由宿主整段重放。
   */
  private sinceOf(terminalId: string): { since?: number } {
    const mounted = this.mountFor(terminalId)
    if (mounted === undefined || mounted.consumed === 0) return {}
    return { since: mounted.consumed }
  }

  /** 按宿主会话 id 取挂载记录（消息分发用；标签已移除时为 undefined）。 */
  private mountFor(terminalId: string): MountedTerminal | undefined {
    for (const mounted of this.mounted.values()) {
      if (mounted.terminalId === terminalId) return mounted
    }
    return undefined
  }

  /** 按宿主会话 id 反查标签 key（标签已移除时返回 undefined）。 */
  private keyForTerminal(terminalId: string): string | undefined {
    for (const [key, mounted] of this.mounted) {
      if (mounted.terminalId === terminalId) return key
    }
    return undefined
  }

  /**
   * 把错误落到指定标签上；标签还没渲染出来时按挂载记录补齐，避免错误无处显示
   * 而标签停在"连接中"。
   *
   * @param key - 标签稳定标识。
   * @param error - 要展示的错误文案。
   */
  private markTabError(key: string, error: string): void {
    const terminalId = this.mounted.get(key)?.terminalId ?? null
    this.patchTabs(prev => prev.some(tab => tab.key === key)
      ? prev.map(tab => tab.key === key ? { ...tab, error } : tab)
      : [...prev, { key, terminalId, cwd: '', label: null, exited: false, exitCode: null, error }])
  }

  /**
   * 挂载一个新的 xterm 实例，并接线输入/resize 上行。holder 是否在面板里由
   * {@link syncVisibility} 统一安排：视图卸下期间实例照常收输出，只是不显示。
   *
   * @param key - 标签稳定标识。
   * @param terminalId - 已知的宿主会话 id；新建标签先挂载、应答后再补。
   */
  private mountTerminal(key: string, terminalId: string | null): void {
    if (this.mounted.has(key)) return
    const holder = document.createElement('div')
    holder.className = 'dsh-rt-term'
    holder.style.cssText = 'position:absolute;inset:0;padding:0 12px 12px;'
    const terminal = new Terminal({
      fontFamily: readCodeFontFamily(),
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'block',
      macOptionIsMeta: true,
      scrollback: 10000,
      theme: currentTheme(),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(holder)
    const mounted: MountedTerminal = { terminal, fit, holder, terminalId, consumed: 0, revealed: false, disposables: [] }
    // 默认 bash 经 --rcfile 注入的钩子会在每个提示符前输出 OSC 7 上报 cwd，
    // 解析后实时刷新标签与状态条（自定义 shell 无此序列则保持 attach 时的值）。
    mounted.disposables.push(terminal.parser.registerOscHandler(7, (osc) => {
      const cwd = parseOsc7Cwd(osc)
      if (cwd !== undefined) {
        this.patchTabs(prev => prev.map(tab => tab.key === key ? { ...tab, cwd } : tab))
      }
      return true
    }))
    // 会话 id 在应答到达后才补齐：事件回调按挂载记录的当前值上行。
    mounted.disposables.push(terminal.onData((data) => {
      if (mounted.terminalId !== null) this.send({ type: 'input', terminalId: mounted.terminalId, data })
    }))
    mounted.disposables.push(terminal.onResize(({ cols, rows }) => {
      if (mounted.terminalId !== null) this.send({ type: 'resize', terminalId: mounted.terminalId, cols, rows })
    }))
    this.mounted.set(key, mounted)
    // 视图卸下期间（连接还在宽限期内）也可能新建终端：holder 先不上面板，
    // 等下次 attachPanel 统一贴回去。
    if (this.panel !== null) this.panel.appendChild(holder)
    this.syncVisibility()
    // 容器刚插入面板时尺寸可能尚未稳定，下一帧再 fit 一次。
    window.requestAnimationFrame(() => {
      if (this.mounted.get(key) === mounted) mounted.fit.fit()
    })
  }

  /** 移除标签：销毁 xterm 实例并从列表删除；主动关闭时由调用方先发 close。 */
  private removeTab(key: string): void {
    const mounted = this.mounted.get(key)
    if (mounted !== undefined) {
      for (const disposable of mounted.disposables) disposable.dispose()
      mounted.terminal.dispose()
      mounted.holder.remove()
      this.mounted.delete(key)
    }
    this.patchTabs(prev => prev.filter(tab => tab.key !== key))
    if (this.activeKey === key) {
      // 下一个激活项同样取挂载记录：它同步反映"还有哪些终端"，不依赖本次渲染。
      this.setActiveKey(this.mounted.keys().next().value ?? null)
    }
  }

  /**
   * 显示一个重建中的终端：重放期间画面先遮住，等此前排队的输出全部解析完
   * （空写只是取一个"队列已清空"的回调）再一次性显示当前画面。
   *
   * @param key - 标签稳定标识。
   * @param mounted - 对应挂载记录。
   */
  private reveal(key: string, mounted: MountedTerminal): void {
    if (mounted.revealed) return
    mounted.terminal.write('', () => {
      if (this.mounted.get(key) !== mounted) return
      mounted.revealed = true
      this.syncVisibility()
    })
  }

  /** holder 的显示安排：非激活标签不占位，未重放完的终端遮住。 */
  private syncVisibility(): void {
    for (const [key, mounted] of this.mounted) {
      mounted.holder.style.display = key === this.activeKey ? '' : 'none'
      mounted.holder.style.visibility = mounted.revealed ? '' : 'hidden'
    }
  }

  /** 更新标签列表并通知订阅者。 */
  private patchTabs(update: (prev: readonly TabState[]) => readonly TabState[]): void {
    this.tabs = update(this.tabs)
    this.publish()
  }

  /** 切换激活项并通知订阅者。 */
  private setActiveKey(key: string | null): void {
    if (this.activeKey === key) return
    this.activeKey = key
    this.publish()
  }

  /** 快照换成新对象（引用变化即状态变化）并派发给订阅者。 */
  private publish(): void {
    this.state = { tabs: this.tabs, activeKey: this.activeKey }
    this.syncVisibility()
    for (const listener of this.listeners) listener()
  }

  /** 分发一条服务端消息。 */
  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'attached': {
        // 登记到当前工作区的桶里：刷新与重连时按桶恢复。
        rememberSession(this.scope, message.terminalId)
        this.pendingAttaches.delete(message.terminalId)
        // 带 token：新建的会话落地到对应占位标签（xterm 在发 attach 前就已挂好）。
        if (message.token !== undefined) {
          const token = message.token
          const mounted = this.mounted.get(token)
          if (mounted === undefined) {
            // 占位标签已被用户关闭：会话已建成，直接销毁以免残留。
            this.send({ type: 'close', terminalId: message.terminalId })
            break
          }
          mounted.terminalId = message.terminalId
          // 占位标签可能还没渲染出来（attach 在下一帧就发出，React 提交不保证更早），
          // 因此按 key 补齐而不是只做 map。
          this.patchTabs(prev => prev.some(tab => tab.key === token)
            ? prev.map(tab => tab.key === token
              ? { ...tab, terminalId: message.terminalId, cwd: message.cwd, label: message.label ?? null, exited: message.exited, exitCode: message.exitCode }
              : tab)
            : [...prev, { key: token, terminalId: message.terminalId, cwd: message.cwd, label: message.label ?? null, exited: message.exited, exitCode: message.exitCode, error: null }])
          break
        }
        // 无 token：既有会话（重连/重挂）。画面还在就只补报尺寸，宿主接下来只会
        // 补发缺口，因此既不清屏也不重放；画面丢了才建标签接整段重放。
        const mounted = this.mountFor(message.terminalId)
        if (mounted !== undefined) {
          // 断线期间的窗口缩放产生过一条 resize，它在 attach 之前被宿主丢弃
          //（那时还没挂接），这里按当前尺寸补报一次。
          this.send({
            type: 'resize',
            terminalId: message.terminalId,
            cols: mounted.terminal.cols,
            rows: mounted.terminal.rows,
          })
          break
        }
        if (this.activeKey === null) this.setActiveKey(message.terminalId)
        this.mountTerminal(message.terminalId, message.terminalId)
        this.patchTabs(prev => prev.some(tab => tab.key === message.terminalId)
          ? prev
          : [...prev, { key: message.terminalId, terminalId: message.terminalId, cwd: message.cwd, label: message.label ?? null, exited: message.exited, exitCode: message.exitCode, error: null }])
        break
      }
      case 'output': {
        const mounted = this.mountFor(message.terminalId)
        if (mounted === undefined) break
        // 记账先于写入：重挂时按它报 since，宿主据此只补缺口。
        mounted.consumed = message.offset
        mounted.terminal.write(message.data)
        break
      }
      case 'synced': {
        const mounted = this.mountFor(message.terminalId)
        if (mounted === undefined) break
        mounted.consumed = message.offset
        const key = this.keyForTerminal(message.terminalId)
        if (key !== undefined) this.reveal(key, mounted)
        break
      }
      case 'exit': {
        this.patchTabs(prev => prev.map(tab =>
          tab.terminalId === message.terminalId ? { ...tab, exited: true, exitCode: message.exitCode } : tab,
        ))
        break
      }
      case 'closed': {
        forgetSession(this.scope, message.terminalId)
        this.pendingAttaches.delete(message.terminalId)
        const key = this.keyForTerminal(message.terminalId)
        if (key !== undefined) this.removeTab(key)
        break
      }
      case 'error': {
        // attach 失败（如数量上限）：错误归属到对应占位标签并落地为错误态。
        // 判定同样只看挂载记录：标签可能还没渲染出来。
        if (message.token !== undefined) {
          const mounted = this.mounted.get(message.token)
          if (mounted !== undefined) {
            this.markTabError(message.token, message.message)
            this.reveal(message.token, mounted)
            break
          }
        }
        // 恢复的已知会话已失效（如宿主重启）：从当前工作区的桶里剔除，
        // 避免每次重连重试；既有标签要亮明原因（否则会停在"连接中"），
        // 若当前一个终端都没有则回退新建一个，避免整个视图无声卡住。
        if (message.terminalId !== undefined) {
          forgetSession(this.scope, message.terminalId)
          this.pendingAttaches.delete(message.terminalId)
          const failedKey = this.keyForTerminal(message.terminalId)
          if (failedKey !== undefined) {
            this.markTabError(failedKey, message.message)
            const mounted = this.mounted.get(failedKey)
            if (mounted !== undefined) this.reveal(failedKey, mounted)
          }
          // 还有 attach 在路上就说明本工作区并非"一个终端都没有"：它们的应答
          // 马上就到，此刻新建只会多出一个用户没要的 shell。
          if (this.mounted.size === 0 && this.pendingAttaches.size === 0 && !this.fallbackUsed) {
            this.fallbackUsed = true
            this.newTab()
          }
          break
        }
        if (this.mounted.size === 0) {
          // 首次自动 attach 被拒（如工作目录不可用）：连终端实例都没有，
          // 建一个错误占位标签亮明原因。
          const key = 'err-' + this.nextErrorKey++
          this.patchTabs(prev => prev.length === 0
            ? [{ key, terminalId: null, cwd: '', label: null, exited: false, exitCode: null, error: message.message }]
            : prev)
          this.setActiveKey(this.activeKey ?? key)
          break
        }
        // 无归属错误显示到激活终端（激活项已不在时取第一个挂载的终端）。
        const activeKey = this.activeKey !== null && this.mounted.has(this.activeKey)
          ? this.activeKey
          : this.mounted.keys().next().value
        if (activeKey === undefined) break
        this.markTabError(activeKey, message.message)
        break
      }
      case 'sessions': {
        // 判定抽在 reconcile 模块里（纯函数，单独测试）：本工作区里宿主有、本地
        // 既没挂接也没登记过的会话才补 attach——已经在标签栏里的跳过，免得把用户
        // 刚关掉的标签又拉回来；别的工作区的跳过，否则切工作区时会看到不属于这里
        // 的终端。
        const plan = planReconcile({
          rows: message.sessions,
          scope: this.scope,
          known: sessionsOf(this.scope),
          mountedKeys: [...this.mounted.keys()],
        })
        for (const terminalId of plan.adopt) {
          rememberSession(this.scope, terminalId)
          this.pendingAttaches.add(terminalId)
          this.send({ type: 'attach', terminalId })
        }
        // 首个终端的回退新建必须等这次对账：本工作区里可能只有别的插件拉起的会话，
        // 抢在对账前建会话会让用户多出一个自己没要的 shell 标签。
        if (message.token !== RECONCILE_TOKEN) break
        if (!plan.needsFirstTerminal) break
        this.newTab()
        break
      }
    }
  }
}

/** 作用域 → 运行时的登记表；页面内由所有视图共享。 */
const runtimes = new Map<string, ScopeRuntime>()

/**
 * 取（或建立）某作用域的终端运行时。
 *
 * @param scope - 作用域键（工作区）。
 * @returns 该作用域的运行时。
 */
export function runtimeFor(scope: string): ScopeRuntime {
  let runtime = runtimes.get(scope)
  if (runtime === undefined) {
    runtime = new ScopeRuntime(scope)
    runtimes.set(scope, runtime)
  }
  return runtime
}
