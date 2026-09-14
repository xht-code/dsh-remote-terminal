/**
 * 运行时 ↔ 真实宿主的端到端验证：这里**不替换连接层**，运行时用真实的
 * connection + 协议去连 harness 起的宿主（真实 PTY）。单测里那条假连接看不到
 * 序列化、重放切片与真实 shell 的配合，本文件把"切走再切回不重放"这条承诺
 * 在完整链路上钉住：断线前打一个只出现一次的标记，重挂后标记计数必须原样不变
 * （若宿主重放了历史，计数会翻倍）。
 *
 * @module dsh-remote-terminal/tests-client-transport
 */
import { homedir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket as NodeWebSocket } from 'ws'
import { sessionsServiceOf, startHost } from './harness.ts'
import type { HostHarness } from './harness.ts'

const itPosix = process.platform === 'win32' ? it.skip : it

const fakes = vi.hoisted(() => {
  /** 只保留运行时用到的成员：记录输出、暴露输入回调、可控地"解析完"写入队列。 */
  class FakeTerminal {
    cols = 80
    rows = 24
    readonly options: Record<string, unknown>
    readonly written: string[] = []
    private callbacks: Array<() => void> = []
    dataHandler: ((data: string) => void) | undefined

    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options }
    }

    readonly parser = { registerOscHandler: () => ({ dispose: () => {} }) }

    loadAddon(): void {}
    open(): void {}
    dispose(): void {}
    onResize(): { dispose(): void } { return { dispose: () => {} } }
    onData(handler: (data: string) => void): { dispose(): void } {
      this.dataHandler = handler
      return { dispose: () => { this.dataHandler = undefined } }
    }

    write(data: string, callback?: () => void): void {
      if (data.length > 0) this.written.push(data)
      if (callback !== undefined) this.callbacks.push(callback)
    }

    /** 模拟 xterm 把排队输出解析完（重建终端靠这个回调解除遮挡）。 */
    flush(): void {
      const callbacks = this.callbacks
      this.callbacks = []
      for (const callback of callbacks) callback()
    }

    /** 模拟用户敲键盘：走运行时注册的上行回调。 */
    typeInput(data: string): void {
      this.dataHandler?.(data)
    }

    /** 该终端至今收到的全部输出。 */
    output(): string {
      return this.written.join('')
    }
  }

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

  return { FakeTerminal, FakeElement, terminals: [] as unknown[] }
})

vi.mock('@xterm/xterm', () => ({
  Terminal: class extends fakes.FakeTerminal {
    constructor(options?: Record<string, unknown>) {
      super(options)
      fakes.terminals.push(this)
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}))

vi.mock('../src/client/theme.ts', () => ({
  currentTheme: () => ({ background: '#000' }),
  readCodeFontFamily: () => 'monospace',
}))

type FakeTerminal = InstanceType<typeof fakes.FakeTerminal>

/** 帧回调（运行时的 requestAnimationFrame）：由测试显式推进。 */
const frames = new Map<number, () => void>()
let nextFrameId = 1

/** 定时器（运行时的连接宽限释放）：由测试显式触发，避免真等 60 秒。 */
const timers = new Map<number, () => void>()
let nextTimerId = 1

function pump(): void {
  const pendingFrames = [...frames.values()]
  frames.clear()
  for (const frame of pendingFrames) frame()
  for (const terminal of fakes.terminals as FakeTerminal[]) terminal.flush()
}

/** 触发挂起的连接宽限定时器（视图卸下 60 秒后释放连接那条路径）。 */
function releaseDetachedConnection(): void {
  const pending = [...timers.values()]
  timers.clear()
  for (const timer of pending) timer()
}

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

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** 轮询判定；每轮先推进帧/解析回调，press 用于反复重试上行输入。 */
async function waitFor(check: () => boolean, press?: () => void, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    pump()
    press?.()
    if (check()) return true
    if (Date.now() > deadline) return false
    await sleep(25)
  }
}

/** 统计子串出现次数：重放历史会让它翻倍。 */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

let host: HostHarness | undefined

beforeEach(() => {
  fakes.terminals.length = 0
  frames.clear()
  timers.clear()
  nextFrameId = 1
  nextTimerId = 1
  const fakeWindow = {
    location: { protocol: 'http:', host: '127.0.0.1:0' },
    requestAnimationFrame: (callback: () => void) => {
      const id = nextFrameId++
      frames.set(id, callback)
      return id
    },
    cancelAnimationFrame: (id: number) => { frames.delete(id) },
    setTimeout: (handler: () => void) => {
      const id = nextTimerId++
      timers.set(id, handler)
      return id
    },
    clearTimeout: (id: number) => { timers.delete(id) },
  }
  pageHidden = false
  Object.assign(globalThis, {
    window: fakeWindow,
    document: {
      createElement: () => new fakes.FakeElement(),
      get visibilityState(): string { return pageHidden ? 'hidden' : 'visible' },
      addEventListener: (type: string, listener: () => void): void => {
        if (type === 'visibilitychange') visibilityListeners.push(listener)
      },
    },
    // 浏览器里文本帧的 event.data 就是字符串，node 的 ws 同样如此（已实测）。
    WebSocket: NodeWebSocket,
  })
})

afterEach(() => {
  host?.stop()
  host = undefined
})

describe('运行时与真实宿主', () => {
  itPosix('切走再切回：连接重建后按偏移续接，历史不重放', async () => {
    host = await startHost({ shellPath: '/bin/bash', shellArgs: ['--norc', '-i'], maxSessions: 4 })
    // 真实连接层按 window.location 拼 WebSocket 地址，这里指向 harness 起的宿主。
    const port = new URL(host.url).port
    ;(globalThis as unknown as { window: { location: { host: string } } }).window.location.host = '127.0.0.1:' + port

    const { runtimeFor } = await import('../src/client/runtime.ts')
    const runtime = runtimeFor('workspace:transport')
    runtime.attachPanel(createPanel(), () => homedir())

    // 首连：对账判定本工作区没有终端 → 回退新建一个真实 PTY。
    const opened = await waitFor(() => runtime.getState().tabs.some(tab => tab.terminalId !== null))
    expect(opened, '首个终端未建立').toBe(true)
    const first = fakes.terminals[0] as FakeTerminal | undefined
    if (first === undefined) throw new Error('运行时没有挂载终端')

    // 打一个标记：命令回显里只有 UNIQ%s，标记本体只会由命令输出产生一次。
    // 此刻挂接已完成（标签已有会话 id），输入必定送达，因此只按一次——反复重按会
    // 让真实 shell 把同一条命令执行多次，基线也就不再是"一次"。
    first.typeInput("printf 'UNIQ%s\\n' -A\n")
    const sawMarker = await waitFor(() => first.output().includes('UNIQ-A'))
    expect(sawMarker, '标记未回显，实际输出：' + JSON.stringify(first.output())).toBe(true)

    // 第二个终端：确认多标签在真实链路上也正常。
    runtime.newTab()
    const twoTabs = await waitFor(() => runtime.getState().tabs.filter(tab => tab.terminalId !== null).length === 2)
    expect(twoTabs, '第二个终端未建立').toBe(true)
    const second = fakes.terminals[1] as FakeTerminal | undefined
    if (second === undefined) throw new Error('第二个终端未挂载')

    // 基线取在断开之前：此后再出现的 UNIQ-A 只可能来自"宿主重放历史"。
    const markerCount = countOf(first.output(), 'UNIQ-A')
    expect(markerCount, '基线应为一次执行，实际输出：' + JSON.stringify(first.output())).toBe(1)

    // 视图切走：连接宽限 60 秒后释放（用测试定时器直接触发）。
    runtime.detachPanel()
    // 只有页面被隐藏（用户真的离开）才会按宽限期释放连接。
    hidePage()
    releaseDetachedConnection()
    await sleep(50)

    // 切回：新建连接 → 按 since 续接（两个终端都续）。输入只在挂接成功后才会被宿主接受，
    // 因此这里反复重试，直到标记出现——它同时证明重挂确实完成了。
    runtime.attachPanel(createPanel(), () => homedir())
    // 重挂完成前输入会被丢弃（连接未就绪时 input 不入队），因此用唯一后缀反复重试：
    // 只有执行成功的那次会打印自己的标记，不会污染 UNIQ-A 的计数。
    let attempt = 0
    const pressB = () => {
      attempt += 1
      first.typeInput("printf 'UNIQ%s\\n' -B" + attempt + '\n')
    }
    const resumed = await waitFor(() => /UNIQ-B\d/.test(first.output()), pressB)
    expect(resumed, '重挂后输入未能送达宿主').toBe(true)

    // 核心断言：断线前的历史没有被重放（重放会让标记计数翻倍）。
    expect(countOf(first.output(), 'UNIQ-A')).toBe(markerCount)
    // 终端实例与标签都没重建。
    expect(fakes.terminals).toHaveLength(2)
    expect(runtime.getState().tabs.map(tab => tab.terminalId)).toHaveLength(2)

    // 宿主侧仍是同两个会话，没有被重新创建。
    const ids = runtime.getState().tabs.map(tab => tab.terminalId)
    for (const id of ids) {
      expect(id).not.toBeNull()
      expect(sessionsServiceOf(host).describe(String(id))).toBeDefined()
    }

    // 收工：释放连接，避免测试结束后留下重连定时器。
    runtime.detachPanel()
    // 只有页面被隐藏（用户真的离开）才会按宽限期释放连接。
    hidePage()
    releaseDetachedConnection()
    await sleep(50)
  })

  itPosix('离开期间的输出：续接时补齐且只补一次', async () => {
    host = await startHost({ shellPath: '/bin/bash', shellArgs: ['--norc', '-i'], maxSessions: 2 })
    const port = new URL(host.url).port
    ;(globalThis as unknown as { window: { location: { host: string } } }).window.location.host = '127.0.0.1:' + port

    const { runtimeFor } = await import('../src/client/runtime.ts')
    const runtime = runtimeFor('workspace:transport-gap')
    runtime.attachPanel(createPanel(), () => homedir())
    const opened = await waitFor(() => runtime.getState().tabs.some(tab => tab.terminalId !== null))
    expect(opened, '首个终端未建立').toBe(true)
    const terminal = fakes.terminals[0] as FakeTerminal | undefined
    if (terminal === undefined) throw new Error('运行时没有挂载终端')

    // 排队一条 2 秒后才打印的命令，等它的回显出现（证明 bash 已收到），然后立刻断开：
    // 这段输出只可能由续接补发。
    terminal.typeInput("(sleep 2; printf 'UNIQ%s\\n' -C) &\n")
    const queued = await waitFor(() => terminal.output().includes("printf 'UNIQ%s"))
    expect(queued, '命令未送达宿主').toBe(true)

    runtime.detachPanel()
    // 只有页面被隐藏（用户真的离开）才会按宽限期释放连接。
    hidePage()
    releaseDetachedConnection()
    // 等这条命令在宿主侧产生输出（此时客户端已挂断，输出只进了宿主的重放缓冲）。
    await sleep(2600)
    expect(terminal.output()).not.toContain('UNIQ-C')

    runtime.attachPanel(createPanel(), () => homedir())
    const replayed = await waitFor(() => terminal.output().includes('UNIQ-C'))
    expect(replayed, '离开期间的输出未被补发，实际输出：' + JSON.stringify(terminal.output())).toBe(true)
    // 只补一次：既不漏（上面已断言），也不重（重复补发会让计数变 2）。
    expect(countOf(terminal.output(), 'UNIQ-C')).toBe(1)

    runtime.detachPanel()
    // 只有页面被隐藏（用户真的离开）才会按宽限期释放连接。
    hidePage()
    releaseDetachedConnection()
    await sleep(50)
  })
})