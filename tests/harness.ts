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
import type { Config } from '../src/index.ts'
import { apply } from '../src/index.ts'
import type { ServerMessage } from '../src/protocol.ts'

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

/** 创建只记录升级路由、认证一律通过的假上下文。 */
export function fakeCtx(): FakeCtx {
  const routes: UpgradeRoute[] = []
  const logs: string[] = []
  return {
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
    routes,
    logs,
    dispose: undefined,
  }
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
  if (route === undefined) throw new Error('升级路由未注册')
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { void route.handler(req, socket, head) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('监听地址不可用')
  return {
    ctx,
    url: `ws://127.0.0.1:${address.port}/api/remote-terminal/ws`,
    stop() {
      ctx.dispose?.()
      server.close()
    },
  }
}

/**
 * 打开一条客户端连接，并收集其非 output 消息。
 * output 体量可达每分钟数百 MB，收集会撑爆测试进程，因此只留协议事件。
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
