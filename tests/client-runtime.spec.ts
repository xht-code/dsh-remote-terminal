/**
 * 客户端运行时的行为测试：用假的 xterm、假连接与假 DOM 驱动运行时，覆盖
 * 「切走再切回不重建终端」「连接释放后按 since 续接」「重建期间先遮住画面」
 * 这几条只靠宿主测试覆盖不到的逻辑。
 *
 * 运行时是纯客户端代码（xterm + DOM），这里把两侧依赖都替换成可控替身，
 * 只让运行时自己的状态机跑在真实实现上。替身必须建在 vi.hoisted 里：
 * vi.mock 会被提升到文件顶部，工厂里不能引用尚未初始化的顶层变量。
 *
 * @module dsh-remote-terminal/tests-client-runtime
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage, ServerMessage } from '../src/protocol.ts'
import { runtimeFor } from '../src/client/runtime.ts'
import type { RuntimeState } from '../src/client/runtime.ts'
import { rememberSession, sessionsOf } from '../src/client/sessions.ts'

const fakes = vi.hoisted(() => {
  /** xterm 替身：记录写入内容，并让测试显式触发"排队输出已解析完"的回调。 */
  class FakeTerminal {
    cols = 80
    rows = 24
    readonly options: Record<string, unknown>
    readonly written: string[] = []
    private callbacks: Array<() => void> = []
    private osc7Handler: ((data: string) => boolean) | undefined
    /** 最近注册的上行输入处理器：用例用它模拟用户敲键。 */
    onDataHandler: ((data: string) => void) | undefined

    readonly parser = {
      registerOscHandler: (_code: number, handler: (data: string) => boolean) => {
        this.osc7Handler = handler
        return { dispose: () => { this.osc7Handler = undefined } }
      },
    }

    /** 与 xterm 一致：构造时传入的选项直接生效（主题/字体在创建那一刻就位）。 */
    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options }
    }

    loadAddon(): void {}
    open(): void {}
    reset(): void { this.written.length = 0 }
    dispose(): void {}
    onData(handler: (data: string) => void): { dispose(): void } {
      this.onDataHandler = handler
      return { dispose: () => { this.onDataHandler = undefined } }
    }
    onResize(): { dispose(): void } { return { dispose: () => {} } }

    write(data: string, callback?: () => void): void {
      if (data.length > 0) this.written.push(data)
      if (callback !== undefined) this.callbacks.push(callback)
    }

    /** 模拟 xterm 把此前排队的输出解析完。 */
    flush(): void {
      const callbacks = this.callbacks
      this.callbacks = []
      for (const callback of callbacks) callback()
    }

    /** 模拟 shell 在提示符前输出 OSC 7 上报工作目录。 */
    reportCwd(path: string): void {
      this.osc7Handler?.('file://host' + path)
    }
  }

  /** 最小 DOM 元素替身：只实现运行时用到的那几个成员。 */
  class FakeElement {
    className = ''
    readonly style: Record<string, string> = {}
    readonly children: FakeElement[] = []
    private parent: FakeElement | null = null

    appendChild(child: FakeElement): FakeElement {
      if (child.parent === this) return child
      child.remove()
      child.parent = this
      this.children.push(child)
      return child
    }

    remove(): void {
      const parent = this.parent
      if (parent === null) return
      parent.children.splice(parent.children.indexOf(this), 1)
      this.parent = null
    }
  }

  return {
    FakeTerminal,
    FakeElement,
    /** 运行时建立的连接与仍存活的终端，供断言取用（终端 dispose 后从表里移除）。 */
    state: {
      connections: [] as unknown[],
      terminals: [] as unknown[],
      /** 宿主当前的主题与代码字体：用例可改写以模拟切换。 */
      theme: { background: '#000' } as Record<string, unknown>,
      fontFamily: 'monospace',
      /** FitAddon.fit 的调用次数：面板内容盒变化必须收敛成一次重排。 */
      fits: 0,
    },
  }
})

vi.mock('../src/client/connection.ts', () => ({
  connectTerminal: () => {
    const listeners: Array<(message: ServerMessage) => void> = []
    const openListeners: Array<() => void> = []
    const connection = {
      sent: [] as ClientMessage[],
      closed: false,
      emit(message: ServerMessage) { for (const listener of listeners) listener(message) },
      open() { for (const listener of openListeners) listener() },
      start() {},
      send(message: ClientMessage) { connection.sent.push(message) },
      subscribe(listener: (message: ServerMessage) => void) { listeners.push(listener); return () => {} },
      onOpen(listener: () => void) { openListeners.push(listener); return () => {} },
      close() { connection.closed = true },
    }
    fakes.state.connections.push(connection)
    return connection
  },
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class extends fakes.FakeTerminal {
    constructor(options?: Record<string, unknown>) {
      super(options)
      fakes.state.terminals.push(this)
    }

    override dispose(): void {
      super.dispose()
      const index = fakes.state.terminals.indexOf(this)
      if (index >= 0) fakes.state.terminals.splice(index, 1)
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {
      fakes.state.fits += 1
    }
  },
}))

vi.mock('../src/client/theme.ts', () => ({
  currentTheme: () => fakes.state.theme,
  readCodeFontFamily: () => fakes.state.fontFamily,
}))

type FakeTerminal = InstanceType<typeof fakes.FakeTerminal>
type FakeElement = InstanceType<typeof fakes.FakeElement>
type FakeConnection = (typeof fakes.state.connections)[number] & {
  sent: ClientMessage[]
  closed: boolean
  emit(message: ServerMessage): void
  open(): void
}

/** 帧回调队列：运行时的 requestAnimationFrame 由测试显式推进。 */
const frames = new Map<number, () => void>()
let nextFrameId = 1

/** 触发当前排队的帧回调（运行时用它延后 fit 与新建会话）。 */
function flushFrames(): void {
  const pending = [...frames.values()]
  frames.clear()
  for (const callback of pending) callback()
}

/** 建一个可与运行时对接的面板元素。 */
function createPanel(): HTMLElement {
  return new fakes.FakeElement() as unknown as HTMLElement
}

/** 页面可见性（fake document 用）：默认可见，切到浏览器其他标签页时才置为隐藏。 */
let pageHidden = false

/** visibilitychange 监听器：客户端模块级只注册一次，跨用例保留。 */
const visibilityListeners: Array<() => void> = []

/** 模拟页面被隐藏（切到浏览器其他标签页、最小化）。 */
function hidePage(): void {
  pageHidden = true
  for (const listener of [...visibilityListeners]) listener()
}

/** 模拟页面恢复可见。 */
function showPage(): void {
  pageHidden = false
  for (const listener of [...visibilityListeners]) listener()
}

/** 取面板里的 holder；运行时按挂载顺序追加。 */
function holderOf(panel: HTMLElement): FakeElement {
  const holder = (panel as unknown as FakeElement).children[0]
  if (holder === undefined) throw new Error('面板里没有终端容器')
  return holder
}

/** 取最近一次建立的连接。 */
function lastConnection(): FakeConnection {
  const connection = fakes.state.connections[fakes.state.connections.length - 1]
  if (connection === undefined) throw new Error('运行时还没建立连接')
  return connection as FakeConnection
}

/** 取最近一次挂载的终端替身。 */
function lastTerminal(): FakeTerminal {
  const terminal = fakes.state.terminals[fakes.state.terminals.length - 1]
  if (terminal === undefined) throw new Error('运行时还没挂载终端')
  return terminal as FakeTerminal
}

/**
 * 发一次 attach 应答：attached 之后按给定位置发重放内容与 synced——宿主对一次
 * attach 的应答就是这样一串。
 *
 * @param connection - 假连接。
 * @param terminalId - 会话 id。
 * @param replayEnd - 本次重放结束的绝对偏移（也是 synced 报出的位置）。
 * @param options.token - 关联令牌（新建终端时给出）；缺省即"恢复既有会话"。
 * @param options.replayData - 本次重放发出的内容。
 */
function replayWindow(
  connection: FakeConnection,
  terminalId: string,
  replayEnd: number,
  options: { token?: string; replayData?: string } = {},
): void {
  connection.emit({
    type: 'attached',
    terminalId,
    cwd: '/srv/app',
    exited: false,
    exitCode: null,
    ...(options.token === undefined ? {} : { token: options.token }),
  })
  if (options.replayData !== undefined && options.replayData.length > 0) {
    connection.emit({ type: 'output', terminalId, data: options.replayData, offset: replayEnd })
  }
  connection.emit({ type: 'synced', terminalId, offset: replayEnd })
}

/**
 * 宿主对一次"恢复既有会话"attach 的标准应答：重放内容从 0 开始。
 *
 * @param connection - 假连接。
 * @param terminalId - 会话 id。
 * @param options.data - 本次重放的内容。
 * @param options.replayEnd - 重放结束时客户端在流里的绝对位置；缺省即内容长度。
 */
function replyAttached(
  connection: FakeConnection,
  terminalId: string,
  options: { data?: string; replayEnd?: number } = {},
): void {
  const data = options.data ?? ''
  replayWindow(connection, terminalId, options.replayEnd ?? Buffer.byteLength(data), { replayData: data })
}

/** 取出某类上行消息。 */
function sentOfType<T extends ClientMessage['type']>(connection: FakeConnection, type: T): Array<Extract<ClientMessage, { type: T }>> {
  return connection.sent.filter(message => message.type === type) as Array<Extract<ClientMessage, { type: T }>>
}

beforeEach(() => {
  fakes.state.connections.length = 0
  fakes.state.terminals.length = 0
  fakes.state.fits = 0
  frames.clear()
  nextFrameId = 1
  vi.useFakeTimers()
  const fakeDocument = {
    createElement: () => new fakes.FakeElement(),
    get visibilityState(): string { return pageHidden ? 'hidden' : 'visible' },
    addEventListener: (type: string, listener: () => void): void => {
      if (type === 'visibilitychange') visibilityListeners.push(listener)
    },
  }
  pageHidden = false
  const fakeWindow = {
    requestAnimationFrame: (callback: () => void) => {
      const id = nextFrameId++
      frames.set(id, callback)
      return id
    },
    cancelAnimationFrame: (id: number) => { frames.delete(id) },
    setTimeout: (handler: () => void, timeout?: number) => globalThis.setTimeout(handler, timeout),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
  }
  Object.assign(globalThis, { document: fakeDocument, window: fakeWindow })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('终端运行时', () => {
  it('切走再切回：终端实例与画面都留着，不重发 attach', () => {
    const runtime = runtimeFor('workspace:keepalive')
    const first = createPanel()
    runtime.attachPanel(first, () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    replyAttached(connection, 'term-1', { data: 'hello' })
    lastTerminal().flush()
    flushFrames()

    expect(runtime.getState().tabs.map(tab => tab.terminalId)).toEqual(['term-1'])
    expect(holderOf(first).style.visibility).toBe('')
    const holder = holderOf(first)

    // 视图切走再切回：DSH 会真的卸载组件，运行时只摘 DOM。
    runtime.detachPanel()
    expect(first.children).toEqual([])
    const second = createPanel()
    runtime.attachPanel(second, () => '/srv/app')

    expect(fakes.state.connections).toHaveLength(1)
    expect(fakes.state.terminals).toHaveLength(1)
    expect(sentOfType(connection, 'attach')).toHaveLength(0)
    expect(lastTerminal().written).toEqual(['hello'])
    // 同一个 holder 贴到新面板上：终端实例与画面都没重建。
    expect(holderOf(second)).toBe(holder)
    expect(holderOf(second).style.display).toBe('')
  })

  it('面板内容盒变化时重排全部已挂载终端', () => {
    // 视图把面板的 ResizeObserver 接到这个入口；输入框长高改的是面板 padding，观察
    // content-box 同样会通知。这条路径断掉的话，让位变了终端却不重排，最后一行会被输入框盖住。
    const runtime = runtimeFor('workspace:refit')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    replyAttached(connection, 'term-1', { data: 'hello' })
    lastTerminal().flush()
    flushFrames()
    const before = fakes.state.fits

    runtime.fitAll()

    expect(fakes.state.fits).toBe(before + 1)
  })

  it('重放期间先遮住画面，输出解析完才显示', () => {
    const runtime = runtimeFor('workspace:reveal')
    const panel = createPanel()
    runtime.attachPanel(panel, () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    replyAttached(connection, 'term-1', { data: 'history' })

    // 宿主已把重放发完，但 xterm 还在解析：此刻不该显示半截画面。
    expect(holderOf(panel).style.visibility).toBe('hidden')
    lastTerminal().flush()
    expect(holderOf(panel).style.visibility).toBe('')
    expect(lastTerminal().written).toEqual(['history'])
  })

  it('连接宽限期结束后重挂：按已消费偏移续接，不重建终端也不重放', async () => {
    const runtime = runtimeFor('workspace:resume')
    const panel = createPanel()
    runtime.attachPanel(panel, () => '/srv/app')
    const first = lastConnection()
    first.open()
    replyAttached(first, 'term-1', { data: 'part-one' })
    lastTerminal().flush()

    runtime.detachPanel()
    // 页面被隐藏（用户真的离开了）才开始计宽限时长。
    hidePage()
    // 宽限期内连接不断：宿主侧会话仍视为在用，切回来完全无感。
    await vi.advanceTimersByTimeAsync(59_000)
    expect(first.closed).toBe(false)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(first.closed).toBe(true)

    runtime.attachPanel(createPanel(), () => '/srv/app')
    const second = lastConnection()
    expect(second).not.toBe(first)
    second.open()

    expect(sentOfType(second, 'attach')).toEqual([
      { type: 'attach', terminalId: 'term-1', since: Buffer.byteLength('part-one') },
    ])
    expect(fakes.state.terminals).toHaveLength(1)
    expect(lastTerminal().written).toEqual(['part-one'])
  })

  it('多字节输出按 UTF-8 字节数记账：位置不是字符数', async () => {
    const runtime = runtimeFor('workspace:utf8')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const first = lastConnection()
    first.open()
    // 9 个字符、UTF-8 下 14 字节（"终端" 各 3 字节，"." 与 "-"、"txt" 各 1 字节）。
    // 宿主按字节计偏移，客户端若按字符数记账就会报小 5，重挂时重发已收到的内容。
    const text = 'terminal-终端.txt'
    const bytes = Buffer.byteLength(text)
    expect(bytes).toBeGreaterThan(text.length)
    replyAttached(first, 'term-1', { data: text })
    lastTerminal().flush()

    runtime.detachPanel()
    hidePage()
    await vi.advanceTimersByTimeAsync(61_000)
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const second = lastConnection()
    second.open()
    expect(sentOfType(second, 'attach')).toEqual([{ type: 'attach', terminalId: 'term-1', since: bytes }])
  })

  it('关掉的标签先请求宿主销毁，宿主的 closed 广播再把它从桶里剔除', () => {
    const runtime = runtimeFor('workspace:closed-tab')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    replyAttached(connection, 'term-1', { data: 'history' })
    lastTerminal().flush()
    expect(sessionsOf('workspace:closed-tab')).toContain('term-1')

    runtime.closeTab('term-1')

    // 关标签即请求宿主销毁，本地立刻移除标签与 xterm；会话登记则等宿主的 closed
    // 广播才剔除——它是"宿主侧会话已销毁"的唯一事实来源。
    expect(sentOfType(connection, 'close')).toEqual([{ type: 'close', terminalId: 'term-1' }])
    expect(runtime.getState().tabs).toEqual([])
    expect(sessionsOf('workspace:closed-tab')).toContain('term-1')

    // 宿主确认销毁：登记随之剔除，此后重连不再把它 attach 回来。
    connection.emit({ type: 'closed', terminalId: 'term-1' })
    expect(sessionsOf('workspace:closed-tab')).not.toContain('term-1')
    const attachesBefore = sentOfType(connection, 'attach').length
    connection.open()
    expect(sentOfType(connection, 'attach')).toHaveLength(attachesBefore)
    expect(runtime.getState().tabs).toEqual([])

    runtime.detachPanel()
  })

  it('占位标签已关闭时到达的 token 错误不落到别的终端上', () => {
    const runtime = runtimeFor('workspace:orphan-error')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    replyAttached(connection, 'term-healthy', { data: 'keep-me' })
    lastTerminal().flush()

    // 用户点「+」建占位标签，随后在宿主应答之前把它关掉。
    runtime.newTab()
    flushFrames()
    const token = sentOfType(connection, 'attach').find(message => message.token !== undefined)?.token
    if (token === undefined) throw new Error('新建终端未发出 attach')
    runtime.closeTab(String(runtime.getState().tabs.find(tab => tab.key === token)?.key ?? token))

    // 带 token 的失败应答此刻没有归属对象：绝不能改写场上那个健康终端。
    connection.emit({ type: 'error', message: '本工作区的终端会话数已达上限', token })

    const healthy = runtime.getState().tabs.find(tab => tab.key === 'term-healthy')
    expect(healthy?.terminalId).toBe('term-healthy')
    expect(healthy?.error).toBeNull()
    // 画面与输入都还活着：output 仍写入，输入仍上行。
    connection.emit({ type: 'output', terminalId: 'term-healthy', data: 'more', offset: Buffer.byteLength('keep-more') })
    expect(lastTerminal().written.join('')).toContain('more')
    const before = sentOfType(connection, 'input').length
    lastTerminal().onDataHandler?.('ls\n')
    expect(sentOfType(connection, 'input')).toHaveLength(before + 1)

    runtime.detachPanel()
  })

  it('重放中途断线：位置按已收到的帧推进，下一次重挂不重放也不跳过', async () => {
    const runtime = runtimeFor('workspace:half-replay')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const first = lastConnection()
    first.open()
    // 首挂正常完成：手上是 [0, 8)。
    replyAttached(first, 'term-1', { data: 'B'.repeat(8) })
    lastTerminal().flush()

    // 断线宽限期结束后重挂，宿主开始重放但**只发了一半连接就断了**：没有 synced。
    runtime.detachPanel()
    hidePage()
    await vi.advanceTimersByTimeAsync(61_000)
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const second = lastConnection()
    second.open()
    expect(sentOfType(second, 'attach')).toEqual([{ type: 'attach', terminalId: 'term-1', since: 8 }])
    second.emit({ type: 'attached', terminalId: 'term-1', cwd: '/srv/app', exited: false, exitCode: null })
    second.emit({ type: 'output', terminalId: 'term-1', data: 'C'.repeat(20), offset: 28 })
    runtime.detachPanel()
    hidePage()
    await vi.advanceTimersByTimeAsync(61_000)

    // 再挂：位置按已收到的帧记成 28（那半截确实到手了），宿主只补 28 之后的内容；
    // 既不会重放已有的，也不会跳过没收到过的。
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const third = lastConnection()
    third.open()
    expect(sentOfType(third, 'attach')).toEqual([{ type: 'attach', terminalId: 'term-1', since: 28 }])
    replayWindow(third, 'term-1', 100, { replayData: 'D'.repeat(72) })
    lastTerminal().flush()

    runtime.detachPanel()
    hidePage()
    await vi.advanceTimersByTimeAsync(61_000)
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const fourth = lastConnection()
    fourth.open()
    expect(sentOfType(fourth, 'attach')).toEqual([{ type: 'attach', terminalId: 'term-1', since: 100 }])
  })

  it('离线期间缓冲又往前裁剪：位置按宿主报出的重放末尾记，不虚报也不倒退', async () => {
    const runtime = runtimeFor('workspace:regap')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const first = lastConnection()
    first.open()
    // 首挂：拿到 [0, 20) 这段完整前缀。
    replyAttached(first, 'term-1', { data: 'B'.repeat(20) })
    lastTerminal().flush()

    runtime.detachPanel()
    hidePage()
    await vi.advanceTimersByTimeAsync(61_000)
    expect(first.closed).toBe(true)

    // 重挂：客户端按自己的记账报 since=20，而宿主缓冲早已滚过这个位置，只发还留着的
    // [40, 60)。中间那 20 字节永远拿不到了（缺口），因此位置必须记成宿主报出的
    // 60——记成请求值 20 等于声称持有没收到过的字节，此后每次重挂都会跳过一整段。
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const second = lastConnection()
    second.open()
    expect(sentOfType(second, 'attach')).toEqual([{ type: 'attach', terminalId: 'term-1', since: 20 }])
    replayWindow(second, 'term-1', 60, { replayData: 'C'.repeat(20) })
    lastTerminal().flush()

    runtime.detachPanel()
    hidePage()
    await vi.advanceTimersByTimeAsync(61_000)
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const third = lastConnection()
    third.open()
    expect(sentOfType(third, 'attach')).toEqual([{ type: 'attach', terminalId: 'term-1', since: 60 }])
  })

  it('全新标签页没有画面可续：不带 since，重建后整段重放', () => {
    const runtime = runtimeFor('workspace:fresh')
    const panel = createPanel()
    runtime.attachPanel(panel, () => '/srv/app')
    const connection = lastConnection()
    connection.open()

    // 宿主快照对账后逐个 attach——此时本地既没有挂载也没有偏移。
    connection.emit({ type: 'sessions', sessions: [{ terminalId: 'term-9', scope: 'workspace:fresh' }], token: 'reconcile' })
    expect(sentOfType(connection, 'attach')).toEqual([{ type: 'attach', terminalId: 'term-9' }])

    replyAttached(connection, 'term-9', { data: 'full-history' })
    lastTerminal().flush()
    expect(lastTerminal().written).toEqual(['full-history'])
    expect(holderOf(panel).style.visibility).toBe('')
  })

  it('新建终端按占位标签建会话，关标签时请求宿主销毁', () => {
    const runtime = runtimeFor('workspace:newtab')
    const panel = createPanel()
    runtime.attachPanel(panel, () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    connection.emit({ type: 'sessions', sessions: [], token: 'reconcile' })

    // 该工作区一个终端都没有：对账后回退新建一个。
    expect(sentOfType(connection, 'attach')).toHaveLength(0)
    flushFrames()
    const created = sentOfType(connection, 'attach')
    expect(created).toHaveLength(1)
    const token = created[0]?.token
    expect(token).toMatch(/^new-\d+$/)
    expect(created[0]).toMatchObject({ cwd: '/srv/app', scope: 'workspace:newtab' })

    if (token === undefined) throw new Error('新建终端缺少关联令牌')
    replayWindow(connection, 'term-new', 0, { token })
    expect(runtime.getState().tabs.map(tab => tab.terminalId)).toEqual(['term-new'])

    runtime.closeTab(String(runtime.getState().tabs[0]?.key))
    expect(sentOfType(connection, 'close')).toEqual([{ type: 'close', terminalId: 'term-new' }])
    expect(runtime.getState().tabs).toEqual([])
    expect(fakes.state.terminals).toHaveLength(0)
  })

  it('视图卸下期间对账回退建会话：仍用最后已知的工作区目录', () => {
    const runtime = runtimeFor('workspace:detached-cwd')
    const panel = createPanel()
    runtime.attachPanel(panel, () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    replyAttached(connection, 'term-1', { data: 'hi' })
    lastTerminal().flush()
    flushFrames()

    // 切走视图，但连接仍在宽限期内，宿主消息照常到达。
    runtime.detachPanel()
    // 另一个浏览器把本工作区最后一个终端关掉了。
    connection.emit({ type: 'closed', terminalId: 'term-1' })
    expect(runtime.getState().tabs).toEqual([])

    // 连接重连后对账：本工作区一个终端都没有 → 回退新建，cwd 必须还是工作区目录。
    connection.emit({ type: 'sessions', sessions: [], token: 'reconcile' })
    flushFrames()
    const created = sentOfType(connection, 'attach')
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ cwd: '/srv/app', scope: 'workspace:detached-cwd' })
  })

  it('重连重挂既有会话：补报一次尺寸，不重建终端也不清画面', () => {
    const runtime = runtimeFor('workspace:resize')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    replyAttached(connection, 'term-1', { data: 'hello' })
    lastTerminal().flush()

    // 断线期间宿主丢弃了那条 resize，重挂后按当前尺寸补报一次。
    connection.emit({ type: 'attached', terminalId: 'term-1', cwd: '/srv/app', exited: false, exitCode: null })

    expect(sentOfType(connection, 'resize')).toEqual([{ type: 'resize', terminalId: 'term-1', cols: 80, rows: 24 }])
    expect(fakes.state.terminals).toHaveLength(1)
    expect(runtime.getState().tabs).toHaveLength(1)
    expect(lastTerminal().written).toEqual(['hello'])

    // 宿主广播的 closed 要同时把会话从桶里剔掉，否则下次连接还会重挂它。
    connection.emit({ type: 'closed', terminalId: 'term-1' })
    expect(sessionsOf('workspace:resize')).not.toContain('term-1')
    expect(runtime.getState().tabs).toEqual([])
  })

  it('占位标签在应答前被关掉：会话建好后立刻请求销毁，不留孤儿 PTY', () => {
    const runtime = runtimeFor('workspace:orphan')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    runtime.newTab()
    flushFrames()

    const token = sentOfType(connection, 'attach')[0]?.token
    if (token === undefined) throw new Error('新建终端未发出 attach')
    // 此刻还没有会话 id，本地关掉不会上行任何 close。
    runtime.closeTab(String(runtime.getState().tabs[0]?.key))
    expect(sentOfType(connection, 'close')).toEqual([])

    connection.emit({ type: 'attached', terminalId: 'term-orphan', cwd: '/srv/app', exited: false, exitCode: null, token })
    expect(sentOfType(connection, 'close')).toEqual([{ type: 'close', terminalId: 'term-orphan' }])
    expect(runtime.getState().tabs).toEqual([])
    expect(fakes.state.terminals).toHaveLength(0)
  })

  it('隐藏期间宿主切了主题/字体：重新挂上视图时补同步', () => {
    const runtime = runtimeFor('workspace:theme')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    replyAttached(connection, 'term-1')
    const terminal = lastTerminal()
    expect(terminal.options.theme).toEqual({ background: '#000' })
    expect(terminal.options.fontFamily).toBe('monospace')

    // 视图切走：终端实例保活，而主题观察者随视图断开。
    runtime.detachPanel()
    fakes.state.theme = { background: '#fff' }
    fakes.state.fontFamily = 'Fira Code'

    runtime.attachPanel(createPanel(), () => '/srv/app')
    expect(terminal.options.theme).toEqual({ background: '#fff' })
    expect(terminal.options.fontFamily).toBe('Fira Code')
  })

  it('恢复多个会话时先到的失效错误不触发回退新建', () => {
    rememberSession('workspace:partial-stale', 'term-stale')
    rememberSession('workspace:partial-stale', 'term-alive')
    const runtime = runtimeFor('workspace:partial-stale')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    expect(sentOfType(connection, 'attach')).toEqual([
      { type: 'attach', terminalId: 'term-stale' },
      { type: 'attach', terminalId: 'term-alive' },
    ])

    // 失效会话的错误先到：此刻存活会话的 attached 还在路上。
    connection.emit({ type: 'error', message: '终端会话不存在：term-stale', terminalId: 'term-stale' })
    flushFrames()
    expect(sentOfType(connection, 'attach')).toHaveLength(2)

    replyAttached(connection, 'term-alive')
    expect(runtime.getState().tabs.map(tab => tab.terminalId)).toEqual(['term-alive'])
  })

  it('恢复的会话全部失效时，仍在最后一个结果到达后回退新建一个', () => {
    rememberSession('workspace:all-stale', 'term-x')
    rememberSession('workspace:all-stale', 'term-y')
    const runtime = runtimeFor('workspace:all-stale')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const connection = lastConnection()
    connection.open()

    connection.emit({ type: 'error', message: '终端会话不存在：term-x', terminalId: 'term-x' })
    flushFrames()
    expect(sentOfType(connection, 'attach')).toHaveLength(2)

    connection.emit({ type: 'error', message: '终端会话不存在：term-y', terminalId: 'term-y' })
    flushFrames()
    const attaches = sentOfType(connection, 'attach')
    expect(attaches).toHaveLength(3)
    expect(attaches[2]?.token).toMatch(/^new-\d+$/)
  })

  it('OSC 7 上报的目录实时更新到标签状态', () => {
    const runtime = runtimeFor('workspace:cwd')
    const panel = createPanel()
    runtime.attachPanel(panel, () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    replyAttached(connection, 'term-1')

    lastTerminal().reportCwd('/srv/app/src')
    expect(runtime.getState().tabs[0]?.cwd).toBe('/srv/app/src')
  })

  it('状态变化通知订阅者并更换快照引用，退订后不再通知', () => {
    const runtime = runtimeFor('workspace:notify')
    const seen: RuntimeState[] = []
    const unsubscribe = runtime.subscribe(() => seen.push(runtime.getState()))
    const before = runtime.getState()

    runtime.attachPanel(createPanel(), () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    replyAttached(connection, 'term-1')

    expect(seen.length).toBeGreaterThan(0)
    // 引用必须更换：useSyncExternalStore 靠它判断要不要重渲染。
    expect(runtime.getState()).not.toBe(before)
    expect(new Set(seen).size).toBeGreaterThan(1)

    unsubscribe()
    const notified = seen.length
    connection.emit({ type: 'exit', terminalId: 'term-1', exitCode: 0 })
    expect(seen.length).toBe(notified)
  })

  it('切换标签换激活项，非激活 holder 不占位', () => {
    const runtime = runtimeFor('workspace:activate')
    const panel = createPanel()
    runtime.attachPanel(panel, () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    replyAttached(connection, 'term-a')
    replyAttached(connection, 'term-b')
    flushFrames()

    const tabs = runtime.getState().tabs
    expect(tabs).toHaveLength(2)
    const holders = (panel as unknown as FakeElement).children
    expect(holders).toHaveLength(2)

    const firstKey = String(tabs[0]?.key)
    const secondKey = String(tabs[1]?.key)
    expect(runtime.getState().activeKey).toBe(firstKey)

    runtime.activate(secondKey)
    expect(runtime.getState().activeKey).toBe(secondKey)
    expect(holders[0]?.style.display).toBe('none')
    expect(holders[1]?.style.display).toBe('')

    runtime.activate(firstKey)
    expect(runtime.getState().activeKey).toBe(firstKey)
    expect(holders[0]?.style.display).toBe('')
    expect(holders[1]?.style.display).toBe('none')
  })

  it('新建失败：错误落到占位标签并把它显示出来', () => {
    const runtime = runtimeFor('workspace:error-token')
    const panel = createPanel()
    runtime.attachPanel(panel, () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    runtime.newTab()
    flushFrames()

    const token = sentOfType(connection, 'attach')[0]?.token
    if (token === undefined) throw new Error('新建终端未发出 attach')
    connection.emit({ type: 'error', message: '本工作区的终端会话数已达上限', token })

    expect(runtime.getState().tabs[0]?.error).toBe('本工作区的终端会话数已达上限')
    // 遮住的终端必须被放出来，否则错误只留在状态条、画面一片空白。
    lastTerminal().flush()
    expect(holderOf(panel).style.visibility).toBe('')
  })

  it('失效的已知会话：从桶里剔除且不再重挂，没有终端时回退新建', () => {
    const runtime = runtimeFor('workspace:error-known')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    connection.emit({
      type: 'sessions',
      sessions: [{ terminalId: 'term-gone', scope: 'workspace:error-known' }],
      token: 'reconcile',
    })
    expect(sentOfType(connection, 'attach')).toEqual([{ type: 'attach', terminalId: 'term-gone' }])
    expect(sessionsOf('workspace:error-known')).toContain('term-gone')

    connection.emit({ type: 'error', message: '终端会话不存在：term-gone', terminalId: 'term-gone' })

    // 剔除是"不再每次连接都重试"的关键：留在桶里会被 onOpen 反复重挂。
    expect(sessionsOf('workspace:error-known')).not.toContain('term-gone')
    flushFrames()
    const attaches = sentOfType(connection, 'attach')
    expect(attaches).toHaveLength(2)
    expect(attaches[1]?.token).toMatch(/^new-\d+$/)
  })

  it('错误标签不保留失效的会话 id：输入不再上行，也关不掉一个不存在的会话', () => {
    const runtime = runtimeFor('workspace:error-heal')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    replyAttached(connection, 'term-heal')
    expect(runtime.getState().tabs[0]?.terminalId).toBe('term-heal')

    connection.emit({ type: 'error', message: '终端会话不存在：term-heal', terminalId: 'term-heal' })
    // 失效会话 id 必须从标签上摘掉：留着会让标签带着"已挂接"的假象，并让输入
    // 继续发往一个宿主侧已经不存在的会话。
    expect(runtime.getState().tabs[0]?.terminalId).toBeNull()
    expect(runtime.getState().tabs[0]?.error).toBe('终端会话不存在：term-heal')

    const before = sentOfType(connection, 'input').length
    lastTerminal().onDataHandler?.('ls\n')
    expect(sentOfType(connection, 'input')).toHaveLength(before)

    // 关掉这个错误标签只做本地移除：宿主侧那个会话已经不存在，不该再为它发 close。
    runtime.closeTab('term-heal')
    expect(sentOfType(connection, 'close')).toEqual([])
    expect(runtime.getState().tabs).toEqual([])
  })

  it('重连风暴：本运行时只回退新建一次，不按重连节奏反复拉起 shell', () => {
    rememberSession('workspace:storm', 'term-storm')
    const runtime = runtimeFor('workspace:storm')
    runtime.attachPanel(createPanel(), () => '/srv/app')

    const first = lastConnection()
    first.open()
    // 第一次：已知会话已失效，回退新建一个终端，并用它接上。
    first.emit({ type: 'error', message: '终端会话不存在：term-storm', terminalId: 'term-storm' })
    flushFrames()
    const newCount = (connection: FakeConnection): number =>
      sentOfType(connection, 'attach').filter(message => message.token?.startsWith('new-') === true).length
    expect(newCount(first)).toBe(1)
    const fallbackToken = sentOfType(first, 'attach').find(message => message.token?.startsWith('new-'))?.token
    if (fallbackToken === undefined) throw new Error('回退新建未发出 attach')
    first.emit({ type: 'attached', terminalId: 'term-fallback', cwd: '/srv/app', exited: false, exitCode: null, token: fallbackToken })
    first.emit({ type: 'synced', terminalId: 'term-fallback', offset: 0 })
    // 用户把它关掉：本工作区又回到"一个终端都没有"。
    first.emit({ type: 'closed', terminalId: 'term-fallback' })
    flushFrames()

    // 连接断开重来：同样是"已知会话失效 + 没有终端"，但本次运行时的回退额度
    // 已经用掉了——否则每次重连都会凭空多出一个 shell。
    runtime.detachPanel()
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const second = lastConnection()
    second.open()
    second.emit({ type: 'error', message: '终端会话不存在：term-storm', terminalId: 'term-storm' })
    flushFrames()
    expect(newCount(second)).toBe(0)

    // 用户主动点「+」不受这道闸影响。
    runtime.newTab()
    flushFrames()
    expect(newCount(second)).toBe(1)
  })

  it('对账空快照也只回退新建一次：重连不会按节奏一次次拉起 shell', () => {
    const runtime = runtimeFor('workspace:reconcile-gate')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const first = lastConnection()
    first.open()
    const newCount = (connection: FakeConnection): number =>
      sentOfType(connection, 'attach').filter(message => message.token?.startsWith('new-') === true).length

    // 首次对账：本工作区一个终端都没有 → 回退新建一个。
    first.emit({ type: 'sessions', sessions: [], token: 'reconcile' })
    flushFrames()
    expect(newCount(first)).toBe(1)

    // 用户把它关掉，宿主侧又回到"一个终端都没有"。此后每次重连都要重新对账，
    // 但闸门已经用过——不设闸就会按重连节奏反复凭空建 shell。
    const token = sentOfType(first, 'attach').find(message => message.token?.startsWith('new-'))?.token
    if (token === undefined) throw new Error('回退新建未发出 attach')
    runtime.closeTab(String(token))
    runtime.detachPanel()
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const second = lastConnection()
    second.open()
    second.emit({ type: 'sessions', sessions: [], token: 'reconcile' })
    flushFrames()
    expect(newCount(second)).toBe(0)
  })

  it('无归属错误只写文案：健康终端的会话绑定、输入与关闭都不受影响', () => {
    const runtime = runtimeFor('workspace:unowned-error')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    replyAttached(connection, 'term-live', { data: 'keep' })
    lastTerminal().flush()

    // 宿主对无法解析的上行帧回的 error 既无 token 也无 terminalId：它与本标签的
    // 会话无关，绝不能把会话绑定摘掉——否则画面还在，输入、resize 与关闭却全部失效。
    connection.emit({ type: 'error', message: '无法解析的消息' })

    const tab = runtime.getState().tabs.find(entry => entry.key === 'term-live')
    expect(tab?.terminalId).toBe('term-live')
    expect(tab?.error).toBe('无法解析的消息')

    connection.emit({ type: 'output', terminalId: 'term-live', data: 'more', offset: 8 })
    expect(lastTerminal().written.join('')).toContain('more')
    const before = sentOfType(connection, 'input').length
    lastTerminal().onDataHandler?.('ls\n')
    expect(sentOfType(connection, 'input')).toHaveLength(before + 1)
    runtime.closeTab('term-live')
    expect(sentOfType(connection, 'close')).toEqual([{ type: 'close', terminalId: 'term-live' }])
  })

  it('页内切换视图不释放连接，页面被隐藏才按宽限期释放', async () => {
    const runtime = runtimeFor('workspace:visibility')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const connection = lastConnection()
    connection.open()
    replyAttached(connection, 'term-1', { data: 'hello' })
    lastTerminal().flush()

    // 页内切走（页面仍可见）：终端保活。用户随时会切回来，断线重连会让切回时补发
    // 离开期间的输出（TUI 程序看起来像"重放"），所以这里不再开始释放计时。
    runtime.detachPanel()
    await vi.advanceTimersByTimeAsync(61_000)
    expect(connection.closed).toBe(false)

    runtime.attachPanel(createPanel(), () => '/srv/app')
    expect(connection.closed).toBe(false)
    expect(fakes.state.connections).toHaveLength(1)

    // 页面被隐藏（切到浏览器其他标签页、最小化）：用户可能真的走了，宽限期后释放
    // 连接，宿主因此能把该会话按闲置回收。
    runtime.detachPanel()
    hidePage()
    await vi.advanceTimersByTimeAsync(61_000)
    expect(connection.closed).toBe(true)
    showPage()
  })

  it('重放起点晚于请求位置：写入一行缺口提示，位置不虚报', async () => {
    const runtime = runtimeFor('workspace:gap-notice')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const first = lastConnection()
    first.open()
    replyAttached(first, 'term-1', { data: 'B'.repeat(20) })
    lastTerminal().flush()

    // 离开期间输出被裁剪：重挂时报 since=20，而宿主只能从 40 开始重放。
    runtime.detachPanel()
    hidePage()
    await vi.advanceTimersByTimeAsync(61_000)
    runtime.attachPanel(createPanel(), () => '/srv/app')
    showPage()
    const second = lastConnection()
    second.open()
    expect(sentOfType(second, 'attach')).toEqual([{ type: 'attach', terminalId: 'term-1', since: 20 }])

    // 重放第一帧：末偏移 60、本帧 20 字节 → 起点 40，中间 20 字节被裁掉、补不回来。
    second.emit({ type: 'attached', terminalId: 'term-1', cwd: '/srv/app', exited: false, exitCode: null })
    second.emit({ type: 'output', terminalId: 'term-1', data: 'C'.repeat(20), offset: 60 })
    second.emit({ type: 'synced', terminalId: 'term-1', offset: 60 })
    lastTerminal().flush()

    const written = lastTerminal().written.join('')
    expect(written).toContain('中间缺少约')
    // 提示写在缺口之后、重放内容之前，正好落在画面接缝处。
    expect(written.indexOf('中间缺少约')).toBeLessThan(written.indexOf('C'.repeat(20)))

    // 位置仍按宿主报出的偏移记：下一次重挂从 60 续接。
    runtime.detachPanel()
    hidePage()
    await vi.advanceTimersByTimeAsync(61_000)
    runtime.attachPanel(createPanel(), () => '/srv/app')
    showPage()
    const third = lastConnection()
    third.open()
    expect(sentOfType(third, 'attach')).toEqual([{ type: 'attach', terminalId: 'term-1', since: 60 }])
  })

  it('不带 since 的重建/收养：前缀已被裁掉时同样提示缺口', () => {
    const runtime = runtimeFor('workspace:gap-adopt')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const connection = lastConnection()
    connection.open()

    // 对账收养一个别的插件拉起的会话：这条 attach 不带 since（客户端没有它的画面）。
    connection.emit({ type: 'sessions', sessions: [{ terminalId: 'term-ext', scope: 'workspace:gap-adopt' }], token: 'reconcile' })
    expect(sentOfType(connection, 'attach')).toEqual([{ type: 'attach', terminalId: 'term-ext' }])

    // 它的重放缓冲早已滚过开头：第一帧末偏移 100、本帧 20 字节 → 起点 80，前 80 字节丢了。
    connection.emit({ type: 'attached', terminalId: 'term-ext', cwd: '/srv/app', exited: false, exitCode: null })
    connection.emit({ type: 'output', terminalId: 'term-ext', data: 'X'.repeat(20), offset: 100 })
    connection.emit({ type: 'synced', terminalId: 'term-ext', offset: 100 })
    lastTerminal().flush()

    const written = lastTerminal().written.join('')
    expect(written).toContain('中间缺少约')
    expect(written.indexOf('中间缺少约')).toBeLessThan(written.indexOf('X'.repeat(20)))
  })

  it('重放中途断线：下一个窗口按新位置重新判定缺口', async () => {
    const runtime = runtimeFor('workspace:gap-window')
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const first = lastConnection()
    first.open()
    replyAttached(first, 'term-1', { data: 'A'.repeat(20) })
    lastTerminal().flush()

    // 第一次重挂：宿主从 40 开始重放而客户端只到 20，缺口 20 字节 → 提示；重放中途断开。
    runtime.detachPanel()
    hidePage()
    await vi.advanceTimersByTimeAsync(61_000)
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const second = lastConnection()
    second.open()
    second.emit({ type: 'attached', terminalId: 'term-1', cwd: '/srv/app', exited: false, exitCode: null })
    second.emit({ type: 'output', terminalId: 'term-1', data: 'B'.repeat(20), offset: 60 })
    expect(lastTerminal().written.join('').match(/中间缺少约/g)).toHaveLength(1)

    // 第二次重挂：位置已推进到 60，而宿主又裁过一段（从 80 起），缺口按新位置重新判定。
    runtime.detachPanel()
    hidePage()
    await vi.advanceTimersByTimeAsync(61_000)
    runtime.attachPanel(createPanel(), () => '/srv/app')
    const third = lastConnection()
    third.open()
    third.emit({ type: 'attached', terminalId: 'term-1', cwd: '/srv/app', exited: false, exitCode: null })
    third.emit({ type: 'output', terminalId: 'term-1', data: 'C'.repeat(20), offset: 100 })
    third.emit({ type: 'synced', terminalId: 'term-1', offset: 100 })
    lastTerminal().flush()

    expect(lastTerminal().written.join('').match(/中间缺少约/g)).toHaveLength(2)
  })
})
