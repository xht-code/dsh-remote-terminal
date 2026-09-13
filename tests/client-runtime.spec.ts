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
    onData(): { dispose(): void } { return { dispose: () => {} } }
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
    fit(): void {}
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

/** 宿主对一次既有会话 attach 的标准应答：元信息 + 重放 + synced。 */
function replyAttached(connection: FakeConnection, terminalId: string, options: { token?: string; data?: string } = {}): void {
  connection.emit({
    type: 'attached',
    terminalId,
    cwd: '/srv/app',
    exited: false,
    exitCode: null,
    ...(options.token === undefined ? {} : { token: options.token }),
  })
  const data = options.data ?? ''
  if (data.length > 0) {
    connection.emit({ type: 'output', terminalId, data, offset: Buffer.byteLength(data) })
  }
  connection.emit({ type: 'synced', terminalId, offset: Buffer.byteLength(data) })
}

/** 取出某类上行消息。 */
function sentOfType<T extends ClientMessage['type']>(connection: FakeConnection, type: T): Array<Extract<ClientMessage, { type: T }>> {
  return connection.sent.filter(message => message.type === type) as Array<Extract<ClientMessage, { type: T }>>
}

beforeEach(() => {
  fakes.state.connections.length = 0
  fakes.state.terminals.length = 0
  frames.clear()
  nextFrameId = 1
  vi.useFakeTimers()
  const fakeDocument = { createElement: () => new fakes.FakeElement() }
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
    replyAttached(connection, 'term-new', { token })
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
})
