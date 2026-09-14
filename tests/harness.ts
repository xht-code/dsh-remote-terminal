/**
 * 测试共用的宿主装配脚手架：假 cordis 上下文（升级路由 + 认证窄面）、
 * 真实 http server 与真实 WebSocket 客户端的等待辅助函数。
 *
 * @module dsh-remote-terminal/tests-harness
 */
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { WebSocket } from 'ws'
import type { Config, TerminalSessionsService } from '../src/index.ts'
import { apply } from '../src/index.ts'
import type { ServerMessage, SessionSummary } from '../src/protocol.ts'

/** 升级路由的窄面（与宿主 WebServer.registerUpgrade 的入参一致）。 */
export interface UpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

/** 假 cordis 上下文：只提供插件声明的 webServer / connection 两个服务。 */
export interface FakeCtx {
  webServer: { registerUpgrade(route: UpgradeRoute): () => void }
  connection: { requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined }
  logger: { info(message: string): void; warn(message: string): void }
  effect(fn: () => () => void): void
  /** 服务注册面：真 cordis 的 Service 基类经它把实例挂到上下文上。 */
  reflect: { provide(name: string, value: unknown): () => void }
  /** 服务注册的 disposer：真 cordis 里它们计入 fiber 的 effect，随卸载一起跑掉。 */
  serviceDisposers: Array<() => void>
  routes: UpgradeRoute[]
  /** 插件经 logger 打出的诊断信息，供断言回收等内部决策。 */
  logs: string[]
  dispose: (() => void) | undefined
}

/** 装配好的宿主：插件已 apply，http server 已在随机端口监听。 */
export interface HostHarness {
  ctx: FakeCtx
  url: string
  /** 卸载插件（清杀 PTY）并关闭 http server。 */
  stop(): void
}

/** 一条已连接的测试客户端：socket 与其收到的消息。 */
export interface TestClient {
  ws: WebSocket
  received: ServerMessage[]
}

/**
 * 已注册的服务名。真 cordis 的服务表按 isolate 作用域共享，不随 ctx 走：同一插件的
 * 两个 fiber 注册同名服务时，后一个当场抛错（reflect 的
 * `service "X" has been registered at <...>`）。假面照此办理，否则同一装配被重复
 * 挂载会在单测里被静默吞掉。
 */
const providedServices = new Set()

/** 创建只记录升级路由、认证一律通过的假上下文。 */
export function fakeCtx(): FakeCtx {
  const routes: UpgradeRoute[] = []
  const logs: string[] = []
  const serviceDisposers: Array<() => void> = []
  const ctx: FakeCtx = {
    webServer: {
      registerUpgrade(route) {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      },
    },
    connection: { requestRejection: () => undefined },
    logger: {
      info: (message) => { logs.push(message) },
      warn: (message) => { logs.push(message) },
    },
    effect(fn) { this.dispose = fn() },
    // 真 cordis 的 Service 基类经 ctx.reflect.provide 注册自身；假上下文把实例按
    // 名字挂到自身上，并交出摘除用的 disposer（由 stop 在卸载时执行）。
    reflect: {
      provide(name, value) {
        if (providedServices.has(name)) throw new Error('service "' + name + '" has been registered')
        providedServices.add(name)
        ;(ctx as unknown as Record<string, unknown>)[name] = value
        const dispose = () => {
          providedServices.delete(name)
          delete (ctx as unknown as Record<string, unknown>)[name]
        }
        serviceDisposers.push(dispose)
        return dispose
      },
    },
    serviceDisposers,
    routes,
    logs,
    dispose: undefined,
  }
  return ctx
}

/**
 * 装配插件并把真实 http server 挂到随机端口。
 *
 * @param config - 插件配置（经 resolveConfig 归一化）。
 * @returns 宿主句柄；调用方负责 stop。
 */
export async function startHost(config: Config): Promise<HostHarness> {
  const ctx = fakeCtx()
  apply(ctx as unknown as Context, config)
  const route = ctx.routes[0]
  if (route === undefined) {
    // 共享运行层是进程级单例：上一个宿主没卸载（例如用例超时被掐断、finally 没跑）时
    // 路由不会重复注册，这里给出可诊断的原因，而不是让调用方对着空数组发懵。
    throw new Error('升级路由未注册：共享运行层可能仍被上一个未卸载的宿主持有')
  }
  const server = createServer()
  server.on('upgrade', (req, socket, head) => {
    // 与真宿主一致：升级路由按 path 匹配。若对任意路径都放行，"客户端连错路径"
    // 的回归也会在用例里连上，把该能力的守卫测成绿的。
    if ((req.url ?? '').split('?')[0] !== route.path) {
      socket.destroy()
      return
    }
    void route.handler(req, socket, head)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('监听地址不可用')
  // 地址按插件实际注册的路径拼。
  return {
    ctx,
    url: `ws://127.0.0.1:${address.port}${route.path}`,
    stop() {
      // 与真 cordis 的卸载一致：先跑插件的 effect（teardown），再摘掉服务注册。
      ctx.dispose?.()
      for (const dispose of ctx.serviceDisposers.splice(0)) dispose()
      server.close()
    },
  }
}

/**
 * 打开一条客户端连接，并收集其非 output 消息。
 * output 体量可达每分钟数百 MB，收集会撑爆测试进程，因此只留协议事件；
 * 需要按输出断言的用例自行在 socket 上加 output 监听。
 *
 * @param url - 宿主升级路由地址。
 * @returns 已连接的客户端句柄（received 随消息到达增长）。
 */
export async function connect(url: string): Promise<TestClient> {
  const ws = new WebSocket(url)
  const received: ServerMessage[] = []
  ws.on('error', () => {})
  ws.on('message', (data) => {
    const message = JSON.parse(String(data)) as ServerMessage
    if (message.type !== 'output') received.push(message)
  })
  await once(ws, 'open', 5000)
  return { ws, received }
}

/** 等一个事件，超时抛错。 */
export function once(emitter: { once(event: string, listener: (...args: never[]) => void): unknown }, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(event + ' 超时')), timeoutMs)
    emitter.once(event, () => { clearTimeout(timer); resolve() })
  })
}

/** 固定等待：给跨进程（PTY / TCP）的事件留出送达时间。 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 取宿主上下文上的终端会话服务（`ctx.terminalSessions`）。
 *
 * @param host - 已装配的宿主句柄。
 * @returns 会话服务实例。
 */
export function sessionsServiceOf(host: HostHarness): TerminalSessionsService {
  const service = (host.ctx as unknown as Record<string, unknown>).terminalSessions
  if (service === undefined) throw new Error('终端会话服务未注册到上下文')
  return service as TerminalSessionsService
}

/**
 * 经协议请求一次会话快照（发送 `list` 控制消息并等 `sessions` 应答）。
 *
 * @param client - 已连接的测试客户端。
 * @param token - 关联令牌，用于把应答与本次请求对上。
 * @param timeoutMs - 等待上限；默认值刻意小于 vitest 的用例超时（5s），好让等待先以
 * 断言形式失败、走完用例的 finally 清理。
 * @returns 快照里的会话摘要。
 */
export async function listSessions(client: TestClient, token: string, timeoutMs = 4000): Promise<SessionSummary[]> {
  client.ws.send(JSON.stringify({ type: 'list', token }))
  const hit = await waitFor(
    client.received,
    message => message.type === 'sessions' && message.token === token,
    timeoutMs,
  )
  if (hit === undefined || hit.type !== 'sessions') throw new Error('等待会话快照超时')
  return hit.sessions
}

/**
 * 等收到第一条满足条件的消息。
 *
 * @param received - 客户端已收到的消息集合。
 * @param predicate - 命中判定。
 * @param timeoutMs - 超时上限，超时返回 undefined。
 * @returns 命中的消息；超时为 undefined。
 */
export async function waitFor(
  received: ServerMessage[],
  predicate: (message: ServerMessage) => boolean,
  timeoutMs = 5000,
): Promise<ServerMessage | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = received.find(predicate)
    if (hit !== undefined) return hit
    if (Date.now() > deadline) return undefined
    await sleep(50)
  }
}

/**
 * 等一个同步判定成立。
 *
 * @param predicate - 命中判定。
 * @param timeoutMs - 超时上限；默认值刻意小于 vitest 的用例超时（5s），好让等待
 * 先以断言形式失败、走完用例的 finally 清理，而不是被测试框架掐断。
 * @returns 判定是否在时限内成立；超时返回 false，由调用方断言并给出带现场的说明。
 */
export async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await sleep(50)
  }
}
