/**
 * 心跳回收验证（较慢，约 60–90s）：模拟"能连上但从不回 pong"的半开客户端，
 * 验证宿主按心跳终止它，并因此释放被它占住的会话配额。
 *
 * 判定逻辑（maxSessions=1、shell 用 /bin/true 使会话立即退出）：
 *   1. A（autoPong: false）attach → term-1 创建并立刻退出；
 *   2. 心跳终止 A → 死挂接从会话清除 → term-1 满足"已退出且无人挂接"；
 *   3. B attach → 应拿到新会话 term-2。
 * 若心跳失效，A 的死挂接会一直留在 clients 里，term-1 无法回收，
 * 在 maxSessions=1 下 B 必然收到"会话数已达上限"错误。
 */
import { createServer } from 'node:http'
import { WebSocket } from 'ws'
import { apply } from '../lib/index.mjs'

const failures = []
function check(label, ok, detail = '') {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + (detail ? ' — ' + detail : ''))
  if (!ok) failures.push(label)
}

const fakeWebServer = {
  registered: [],
  registerUpgrade(route) {
    this.registered.push(route)
    return () => { this.registered = this.registered.filter(r => r !== route) }
  },
}
const fakeConnection = { requestRejection: (request) => (request.headers['x-auth'] === 'ok' ? undefined : 401) }
const ctx = {
  webServer: fakeWebServer,
  connection: fakeConnection,
  logger: { info: () => {}, warn: (m) => console.log('WARN', m) },
  effect(fn) { this._dispose = fn() },
  // 真 cordis 的 Service 基类经 ctx.reflect.provide 注册自身，调用时 this 是
  // reflect 对象，所以必须回写闭包里的 ctx（写 this 会让 ctx.terminalSessions
  // 读不到）。
  reflect: {
    provide(name, value) {
      ctx[name] = value
      return () => { delete ctx[name] }
    },
  },
}

// /bin/true 忽略 -i 并立即退出：会话创建后马上进入 exited 状态。
apply(ctx, { shellPath: '/bin/true', maxSessions: 1 })

const route = fakeWebServer.registered[0]
const httpServer = createServer()
httpServer.on('upgrade', (req, socket, head) => route.handler(req, socket, head))
await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
const port = httpServer.address().port
const url = `ws://127.0.0.1:${port}/api/remote-terminal/ws`

/** 等一个事件，超时抛错。 */
function once(emitter, event, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' 超时')), timeoutMs)
    emitter.once(event, (...args) => { clearTimeout(timer); resolve(args) })
  })
}

// 1) 半开客户端 A：能收消息但从不回 pong。
const a = new WebSocket(url, { headers: { 'x-auth': 'ok' }, autoPong: false })
let termId = ''
a.on('message', (data) => {
  const msg = JSON.parse(String(data))
  if (msg.type === 'attached') termId = msg.terminalId
})
await once(a, 'open', 5000, 'A 连接')
a.send(JSON.stringify({ type: 'attach', cwd: process.env.HOME, cols: 80, rows: 24, token: 'a' }))
const startedAt = Date.now()
check('A 取得会话', await new Promise((resolve) => {
  const timer = setInterval(() => { if (termId !== '') { clearInterval(timer); resolve(true) } }, 50)
  setTimeout(() => { clearInterval(timer); resolve(false) }, 5000)
}), termId)

// 2) 等待心跳终止 A（心跳 30s 一轮，最多两轮判定）。
await once(a, 'close', 90_000, 'A 被心跳终止')
check('半开连接被心跳终止', true, Math.round((Date.now() - startedAt) / 1000) + 's')

// 3) 新客户端应能新建会话：证明 term-1 已被回收，死挂接未残留。
const b = new WebSocket(url, { headers: { 'x-auth': 'ok' } })
let second = ''
let limitError = ''
b.on('message', (data) => {
  const msg = JSON.parse(String(data))
  if (msg.type === 'attached') second = msg.terminalId
  if (msg.type === 'error') limitError = msg.message
})
await once(b, 'open', 5000, 'B 连接')
b.send(JSON.stringify({ type: 'attach', cwd: process.env.HOME, cols: 80, rows: 24, token: 'b' }))
await new Promise(resolve => setTimeout(resolve, 1500))
check('终止后配额已释放，可新建会话', second !== '' && limitError === '', second || limitError)

b.close()
ctx._dispose()
httpServer.close()
if (failures.length > 0) {
  console.error('\n失败项：' + failures.join(', '))
  process.exit(1)
}
console.log('\n心跳回收验证通过')
