import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { ServerMessage } from '../src/protocol.ts'
import { apply } from '../src/index.ts'

/**
 * 把 stat 延迟 200ms：attach 的 await 窗口被人为撑开，使"目录校验期间连接
 * 已断开"这一竞态可确定性复现，而不是靠时序碰运气。
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      await new Promise(resolve => setTimeout(resolve, 200))
      return actual.stat(...args)
    },
  }
})

/** 升级路由的窄面（与宿主 WebServer.registerUpgrade 的入参一致）。 */
interface UpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

/** 假 cordis 上下文：只提供插件声明的 webServer / connection 两个服务。 */
interface FakeCtx {
  webServer: { registerUpgrade(route: UpgradeRoute): () => void }
  connection: { requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined }
  logger: { info(): void; warn(): void }
  effect(fn: () => () => void): void
  reflect: { provide(name: string, value: unknown): () => void }
  routes: UpgradeRoute[]
  dispose: (() => void) | undefined
}

function fakeCtx(): FakeCtx {
  const routes: UpgradeRoute[] = []
  return {
    webServer: {
      registerUpgrade(route) {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      },
    },
    connection: { requestRejection: request => (request.headers['x-auth'] === 'ok' ? undefined : 401) },
    logger: { info: () => {}, warn: () => {} },
    effect(fn) { this.dispose = fn() },
    // 真 cordis 的 Service 基类构造时经此注册自身；本用例不消费该服务，接住即可。
    reflect: { provide: () => () => {} },
    routes,
    dispose: undefined,
  }
}

/** 等一个事件，超时抛错。 */
function once(emitter: { once(event: string, listener: (...args: never[]) => void): unknown }, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(event + ' 超时')), timeoutMs)
    emitter.once(event, () => { clearTimeout(timer); resolve() })
  })
}

/** 固定等待：让被延迟的 stat 解析并走完守卫分支。 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('attach 竞态', () => {
  it('目录校验期间连接断开则不创建会话，配额不被僵尸会话占用', async () => {
    const ctx = fakeCtx()
    // maxSessions=1：只要 A 留下了会话，B 就会撞上限，判定因此互斥且明确。
    apply(ctx as unknown as Context, { shellPath: '/bin/true', maxSessions: 1 })
    const route = ctx.routes[0]
    if (route === undefined) throw new Error('升级路由未注册')

    const httpServer = createServer()
    httpServer.on('upgrade', (req, socket, head) => { void route.handler(req, socket, head) })
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('监听地址不可用')
    const url = `ws://127.0.0.1:${address.port}/api/remote-terminal/ws`

    // A：发出 attach 后立刻断开（此刻宿主正卡在被延迟的 stat 上）。
    const a = new WebSocket(url, { headers: { 'x-auth': 'ok' } })
    await once(a, 'open', 5000)
    a.send(JSON.stringify({ type: 'attach', cwd: homedir(), cols: 80, rows: 24, token: 'a' }))
    a.terminate()
    await sleep(500)

    // B：应当能创建会话（证明 A 那次 attach 没有创建任何会话，配额未被僵尸占用）。
    const b = new WebSocket(url, { headers: { 'x-auth': 'ok' } })
    const received: ServerMessage[] = []
    b.on('message', (data) => { received.push(JSON.parse(String(data)) as ServerMessage) })
    await once(b, 'open', 5000)
    b.send(JSON.stringify({ type: 'attach', cwd: homedir(), cols: 80, rows: 24, token: 'b' }))
    await sleep(800)

    const attached = received.find(message => message.type === 'attached')
    const failure = received.find(message => message.type === 'error')
    expect(failure?.message).toBeUndefined()
    expect(attached?.terminalId).toMatch(/^term-[0-9a-f]{12}$/)

    b.close()
    ctx.dispose?.()
    httpServer.close()
  })
})
