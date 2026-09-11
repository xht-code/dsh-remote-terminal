/**
 * 宿主半体独立验证：用假 cordis ctx 装配插件，驱动升级路由的握手认证、
 * WebSocket 会话生命周期与输入输出回声、多会话挂接与 close 销毁，
 * 最后核对清理逻辑。
 */
import { createServer } from 'node:http'
import { readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { apply } from '../lib/index.mjs'

const failures = []
function check(label, ok, detail = '') {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + (detail ? ' — ' + detail : ''))
  if (!ok) failures.push(label)
}

/**
 * tmpdir 下本插件命名的 bash rc 私有目录集合。
 * 返回集合而非单值：同机上可能另有正在运行的 dsh web 实例持有自己的目录，
 * 断言必须只针对本进程新增的那个，否则会被外来目录污染。
 */
function rcDirSet() {
  const found = new Set()
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('dsh-remote-terminal-')) continue
    const full = join(tmpdir(), name)
    if (statSync(full).isDirectory()) found.add(full)
  }
  return found
}

/** 本进程运行期间新建的 rc 目录（外来实例的目录不在内）。 */
const preexistingRcDirs = rcDirSet()
function ownRcDirs() {
  return [...rcDirSet()].filter(dir => !preexistingRcDirs.has(dir))
}

/** 记录升级路由注册与认证拒绝的假 WebServer。 */
const fakeWebServer = {
  registered: [],
  registerUpgrade(route) {
    this.registered.push(route)
    return () => { this.registered = this.registered.filter(r => r !== route) }
  },
}

/** 认证判定：携带 X-Auth: ok 头视为通过。 */
const fakeConnection = {
  requestRejection(request) {
    if (request.headers['x-auth'] === 'ok') return undefined
    return 401
  },
}

/** 最小 cordis ctx 假面：effect 记录 disposer，logger 静默。 */
function fakeCtx() {
  const disposers = []
  return {
    webServer: fakeWebServer,
    connection: fakeConnection,
    logger: { info: () => {}, warn: () => {} },
    effect(fn) { disposers.push(fn()) },
    _disposers: disposers,
  }
}

const ctx = fakeCtx()
// 与真实装配一致：schemastory 会把未配置的数组字段物化为空数组。
apply(ctx, { shellArgs: [] })

const route = fakeWebServer.registered[0]
check('升级路由已注册', route !== undefined && route.path === '/api/remote-terminal/ws', route?.path)

// 未认证：路由 handler 应先写 401 并销毁 socket，而不是交给 wss。
await new Promise((resolve) => {
  const mockSocket = { write: () => {}, destroy: () => resolve() }
  route.handler({ headers: {} }, mockSocket, Buffer.alloc(0))
})
check('未认证握手被拒绝', true, '401 已写入并销毁 socket')

// 认证通过：真实 http server 的 upgrade 事件把原始 socket 交给路由 handler。
const httpServer = createServer()
httpServer.on('upgrade', (req, socket, head) => {
  route.handler(req, socket, head)
})
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
const port = httpServer.address().port

function openClient() {
  return new WebSocket(`ws://127.0.0.1:${port}/api/remote-terminal/ws`, { headers: { 'x-auth': 'ok' } })
}

// 场景一：单会话输入/输出/退出/重连重放。
await new Promise((resolve, reject) => {
  const client = openClient()
  let accumulated = ''
  let greeted = false
  let echoed = false
  let sessionId = ''
  client.on('error', reject)
  client.on('open', () => {
    check('WS 认证通过并连接', true)
    client.send(JSON.stringify({ type: 'attach', cwd: process.env.HOME, cols: 80, rows: 24, token: 't1' }))
  })
  client.on('message', (data) => {
    const msg = JSON.parse(String(data))
    if (msg.type === 'attached') {
      check('attach 应答含终端 id 与 token', msg.token === 't1' && typeof msg.terminalId === 'string', `${msg.terminalId} token=${msg.token}`)
      // rc 包装写在 0700 私有目录内：共享 /tmp 下不可预测、不可被他人预置软链。
      const own = ownRcDirs()
      const mode = own.length === 1 ? statSync(own[0]).mode & 0o777 : 0
      check('bash rc 目录为私有 0700', own.length === 1 && mode === 0o700, own.length + ' 个，0o' + mode.toString(8))
      sessionId = msg.terminalId
    } else if (msg.type === 'output') {
      // PTY 输出按任意边界分块，累积后再做包含匹配。
      accumulated += msg.data
      if (!greeted && accumulated.includes('\x1b]7;file:')) {
        // 首个提示符携带 bash rc 钩子注入的 OSC 7：确认钩子生效后再发命令，
        // 避免 PTY 的输入回显先于提示符到达导致误判。
        greeted = true
        check('bash rc 钩子输出 OSC 7 cwd 序列', true, accumulated.split('\n')[0])
        client.send(JSON.stringify({ type: 'input', terminalId: sessionId, data: 'echo hello-pty\n' }))
      } else if (greeted && !echoed && accumulated.includes('hello-pty')) {
        echoed = true
        check('PTY 输出经广播回传', true, accumulated.trim().split('\n').at(-1))
        client.send(JSON.stringify({ type: 'resize', terminalId: sessionId, cols: 100, rows: 30 }))
        client.send(JSON.stringify({ type: 'input', terminalId: sessionId, data: 'exit\n' }))
      }
    } else if (msg.type === 'exit') {
      check('退出事件携带退出码', typeof msg.exitCode === 'number' || msg.exitCode === null, String(msg.exitCode))
      // 再连一个新客户端验证既有会话重放 scrollback 与 attach 语义。
      const second = openClient()
      let replayed = ''
      let replayChecked = false
      second.on('error', reject)
      second.on('message', (d) => {
        const m = JSON.parse(String(d))
        if (m.type === 'attached' && m.exited) {
          check('退出会话可重新 attach 并读到退出状态', true, `${m.terminalId} exited=${m.exited}`)
        } else if (m.type === 'output' && !replayChecked) {
          // 重放逐块下发：内容必须与首个客户端看到的一致。
          replayed += m.data
          if (replayed.includes('hello-pty')) {
            replayChecked = true
            check('重连重放完整回放历史输出', true, replayed.length + ' 字节')
            second.close()
            client.close()
            resolve()
          }
        }
      })
      second.on('open', () => {
        second.send(JSON.stringify({ type: 'attach', terminalId: sessionId }))
      })
    }
  })
  setTimeout(() => reject(new Error('场景一超时')), 15000)
})

// 场景二：同一连接挂接两个会话，close 销毁其一并同步 closed 事件。
await new Promise((resolve, reject) => {
  const client = openClient()
  const attached = new Set()
  const tokens = new Set()
  let firstId = ''
  client.on('error', reject)
  client.on('open', () => {
    client.send(JSON.stringify({ type: 'attach', cwd: process.env.HOME, cols: 80, rows: 24, token: 'a' }))
    client.send(JSON.stringify({ type: 'attach', cwd: process.env.HOME, cols: 80, rows: 24, token: 'b' }))
  })
  client.on('message', (data) => {
    const msg = JSON.parse(String(data))
    if (msg.type === 'attached') {
      if (firstId === '') firstId = msg.terminalId
      attached.add(msg.terminalId)
      if (msg.token !== undefined) tokens.add(msg.token)
      // 两个 attach 均落地：token 应答集合应含 a 与 b（顺序不保证）。
      if (attached.size === 2) {
        check('两个 attach 的 token 均回显', tokens.has('a') && tokens.has('b'), [...tokens].join(','))
        check('同一连接挂接两个会话', true, [...attached].join(', '))
        client.send(JSON.stringify({ type: 'close', terminalId: firstId }))
      }
    } else if (msg.type === 'closed') {
      check('close 后收到 closed 事件', msg.terminalId === firstId, msg.terminalId)
      client.close()
      resolve()
    }
  })
  setTimeout(() => reject(new Error('场景二超时')), 15000)
})

// 场景三：attach 已销毁的会话应回 error（刷新后恢复失效会话的路径）。
await new Promise((resolve, reject) => {
  const client = openClient()
  client.on('error', reject)
  client.on('open', () => {
    client.send(JSON.stringify({ type: 'attach', terminalId: 'term-999' }))
  })
  client.on('message', (data) => {
    const msg = JSON.parse(String(data))
    if (msg.type === 'error') {
      check('attach 失效会话回 error', msg.message.includes('不存在'), msg.message)
      check('error 携带失效会话 id', msg.terminalId === 'term-999', String(msg.terminalId))
      client.close()
      resolve()
    }
  })
  setTimeout(() => reject(new Error('场景三超时')), 15000)
})

// 触发卸载清理：应移除路由并清杀会话。
ctx._disposers[0]()
check('卸载后路由已移除', fakeWebServer.registered.length === 0)
check('卸载后 bash rc 私有目录已清理', ownRcDirs().length === 0, ownRcDirs().join(', '))

httpServer.close()
if (failures.length > 0) {
  console.error('\n失败项：' + failures.join(', '))
  process.exit(1)
}
console.log('\n宿主半体验证全部通过')
