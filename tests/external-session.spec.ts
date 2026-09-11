import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SCOPE } from '../src/protocol.ts'
import { connect, listSessions, sessionsServiceOf, sleep, startHost, waitFor, waitUntil } from './harness.ts'
import type { TestClient } from './harness.ts'

const itPosix = process.platform === 'win32' ? it.skip : it

/** 等待上限：故意小于 vitest 的用例超时（5s），失败才会走完 finally 清理。 */
const WAIT_MS = 4000

describe('对外会话服务', () => {
  itPosix('拉起的进程进入会话表并带上来源标签', async () => {
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: [] })
    try {
      const sessionId = await sessionsServiceOf(host).create({
        command: '/bin/sh',
        args: ['-c', 'echo READY; sleep 30'],
        cwd: homedir(),
        env: { DSH_PREVIEW_BASE: '/preview/p4271/' },
        label: '预览 p4271',
      })
      expect(sessionId.length).toBeGreaterThan(0)

      // 通过协议对账：终端视图就靠这条路径发现不是自己创建的会话——摘要只带
      // 会话 id 与作用域，视图据此决定收养到哪个桶。
      const client = await connect(host.url)
      const sessions = await listSessions(client, 'after-create')
      const external = sessions.find(row => row.terminalId === sessionId)
      expect(external).toBeDefined()
      expect(external?.scope).toBe(DEFAULT_SCOPE)

      // 标签名与退出状态由 attach 应答给出（快照里不带，避免同一份事实两条读取链）。
      client.ws.send(JSON.stringify({ type: 'attach', terminalId: sessionId, token: 'label' }))
      const attached = await waitFor(
        client.received,
        message => message.type === 'attached' && message.token === 'label',
        WAIT_MS,
      )
      if (attached === undefined || attached.type !== 'attached') throw new Error('等待 attach 应答超时')
      expect(attached.label).toBe('预览 p4271')
      expect(attached.exited).toBe(false)
      client.ws.close()
    } finally {
      host.stop()
    }
  })

  itPosix('外部会话不占手工终端的配额，也不会被这条配额回收', async () => {
    // maxSessions=1：手工终端只能有一个；若 external 计入本工作区额度，下面第二个
    // 手工终端就会撞上限。
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: [], maxSessions: 1 })
    let holder: TestClient | undefined
    try {
      const externalId = await sessionsServiceOf(host).create({
        command: '/bin/sh',
        args: ['-c', 'sleep 30'],
        cwd: homedir(),
        label: '外部会话',
      })

      // 先把 external 挂到一个客户端上：不让它处于「无人挂接」的闲置态，否则即使
      // 实现把它计入了配额，配额回收也会把它当闲置会话杀掉、放行后面的手工 attach，
      // 用例就测不出任何东西（这正是这条用例此前失效的原因）。
      holder = await connect(host.url)
      holder.ws.send(JSON.stringify({ type: 'attach', terminalId: externalId, token: 'hold' }))
      const held = await waitFor(holder.received, message => message.type === 'attached' && message.token === 'hold', WAIT_MS)
      expect(held).toBeDefined()

      const client = await connect(host.url)
      try {
        client.ws.send(JSON.stringify({ type: 'attach', cwd: homedir(), cols: 80, rows: 24, token: 'manual' }))
        const attached = await waitFor(
          client.received,
          message => (message.type === 'attached' || message.type === 'error') && message.token === 'manual',
          WAIT_MS,
        )
        expect(attached?.type).toBe('attached')

        // 手工配额吃紧时，被回收的只能是手工终端，绝不能是别的插件的长驻进程。
        expect(sessionsServiceOf(host).describe(externalId)).toBeDefined()
      } finally {
        client.ws.close()
      }

      // 回收口径要与配额口径一致：即便 external 是最久空闲的那个，手工配额也不该动
      // 它。先关掉 holder 让它变成彻底闲置（无人挂接的 external），再要一个手工终端。
      holder.ws.close()
      holder = undefined

      const reclaimer = await connect(host.url)
      try {
        reclaimer.ws.send(JSON.stringify({ type: 'attach', cwd: homedir(), cols: 80, rows: 24, token: 'second' }))
        const second = await waitFor(
          reclaimer.received,
          message => message.type === 'attached' || message.type === 'error',
          WAIT_MS,
        )
        // 两个手工终端挤在 maxSessions=1 里：宿主要么回收闲置的手工终端放行，要么
        // 明确报错；无论哪种，闲置的 external 都必须活着。
        expect(second).toBeDefined()
        expect(sessionsServiceOf(host).describe(externalId)).toBeDefined()
      } finally {
        reclaimer.ws.close()
      }
    } finally {
      holder?.ws.close()
      host.stop()
    }
  })

  itPosix('close 关掉进程并通知已挂接的连接', async () => {
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: [] })
    try {
      const sessionId = await sessionsServiceOf(host).create({
        command: '/bin/sh',
        args: ['-c', 'sleep 30'],
        cwd: homedir(),
      })

      const client = await connect(host.url)
      client.ws.send(JSON.stringify({ type: 'attach', terminalId: sessionId, token: 'attach' }))
      const attached = await waitFor(client.received, message => message.type === 'attached' && message.token === 'attach', WAIT_MS)
      expect(attached).toBeDefined()

      expect(sessionsServiceOf(host).close(sessionId)).toBe(true)
      const closed = await waitFor(client.received, message => message.type === 'closed' && message.terminalId === sessionId, WAIT_MS)
      expect(closed).toBeDefined()
      // 已关闭的会话不应再出现在快照里。
      expect((await listSessions(client, 'after-close')).some(row => row.terminalId === sessionId)).toBe(false)
      client.ws.close()
    } finally {
      host.stop()
    }
  })

  itPosix('进程自己退出后 close 不再报告"关掉了运行中的会话"', async () => {
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: [] })
    try {
      const sessionId = await sessionsServiceOf(host).create({
        command: '/bin/sh',
        args: ['-c', 'exit 3'],
        cwd: homedir(),
      })
      // 先挂接再等退出：进程可能在连接建立前就已结束，此前广播的 exit 收不到，
      // 而 attach 应答会按当前状态把 exit 补一遍。
      const client = await connect(host.url)
      client.ws.send(JSON.stringify({ type: 'attach', terminalId: sessionId, token: 'attach' }))
      await waitFor(client.received, message => message.type === 'attached' && message.token === 'attach', WAIT_MS)
      const exit = await waitFor(client.received, message => message.type === 'exit' && message.terminalId === sessionId, WAIT_MS)
      expect(exit).toBeDefined()
      expect(sessionsServiceOf(host).close(sessionId)).toBe(false)
      client.ws.close()
    } finally {
      host.stop()
    }
  })

  itPosix('注入的环境变量真的进了进程', async () => {
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: [] })
    try {
      const service = sessionsServiceOf(host)
      const printed: string[] = []
      const sessionId = await service.create({
        command: '/bin/sh',
        args: ['-c', 'echo "BASE=[$DSH_PREVIEW_BASE]"; sleep 30'],
        cwd: homedir(),
        env: { DSH_PREVIEW_BASE: '/preview/injected/' },
      })

      // 直接读会话的输出：attach 会把已有回放一次性补齐。
      const client = await connect(host.url)
      client.ws.on('message', (data) => {
        const message = JSON.parse(String(data)) as { type: string; terminalId?: string; data?: string }
        if (message.type === 'output' && message.terminalId === sessionId) printed.push(message.data ?? '')
      })
      client.ws.send(JSON.stringify({ type: 'attach', terminalId: sessionId, token: 'read' }))
      await waitFor(client.received, message => message.type === 'attached' && message.token === 'read', WAIT_MS)
      const sawEnv = await waitUntil(() => printed.join('').includes('BASE=[/preview/injected/]'), WAIT_MS)
      expect(sawEnv, '未见注入的环境变量，实际输出：' + JSON.stringify(printed.join(''))).toBe(true)
      client.ws.close()
    } finally {
      host.stop()
    }
  })

  itPosix('只给 command 不给 args 时不继承交互 shell 的参数', async () => {
    // shellArgs 是交互式 shell 的语义（POSIX 下是 -i）。若外部命令继承了它，
    // /bin/echo 会把 -i 打出来——业务进程（pnpm dev 等）则会被塞进一个非法参数。
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: ['-i'] })
    try {
      const sessionId = await sessionsServiceOf(host).create({ command: '/bin/echo', cwd: homedir() })

      const client = await connect(host.url)
      const printed: string[] = []
      client.ws.on('message', (data) => {
        const message = JSON.parse(String(data)) as { type: string; terminalId?: string; data?: string }
        if (message.type === 'output' && message.terminalId === sessionId) printed.push(message.data ?? '')
      })
      client.ws.send(JSON.stringify({ type: 'attach', terminalId: sessionId, token: 'args' }))
      await waitFor(client.received, message => message.type === 'attached' && message.token === 'args', WAIT_MS)
      // 等进程收尾：echo 无参数时输出的是空行，有参数时输出参数本身。
      const settled = await waitUntil(() => client.received.some(
        message => message.type === 'exit' && message.terminalId === sessionId,
      ))
      expect(settled).toBe(true)
      const output = printed.join('')
      expect(output.trim(), 'echo 收到了不该有的参数，实际输出：' + JSON.stringify(output)).toBe('')
      client.ws.close()
    } finally {
      host.stop()
    }
  })

  it('从未存在的会话：describe 返回 undefined，close 返回 false', async () => {
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: [] })
    try {
      const service = sessionsServiceOf(host)
      expect(service.describe('term-never-existed')).toBeUndefined()
      expect(service.close('term-never-existed')).toBe(false)
    } finally {
      host.stop()
    }
  })

  itPosix('工作目录不可用时 create 抛错，调用方据此回显原因', async () => {
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: [] })
    try {
      const missing = join(tmpdir(), 'dsh-rt-missing-' + String(process.pid) + '-' + String(Date.now()))
      await expect(sessionsServiceOf(host).create({ command: '/bin/sh', cwd: missing }))
        .rejects.toThrow(/工作目录不可用/)
    } finally {
      host.stop()
    }
  })

  itPosix('总数吃紧时先清已退出的会话，清不动才回收闲置的', async () => {
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: [], maxSessionsTotal: 2 })
    let holder: TestClient | undefined
    try {
      const service = sessionsServiceOf(host)
      // 顺序很重要：先建"活着但无人挂接"的，再建"自己退出且无人挂接"的。这样两者
      // 都在回收候选里时，最久闲置的是活的那个——只有真的先清已退出会话，它才活得
      // 下来；否则这条断言就会抓到"直接回收闲置"的回归。
      const liveId = await service.create({ command: '/bin/sh', args: ['-c', 'sleep 30'], cwd: homedir() })
      await sleep(25)
      const exitedId = await service.create({ command: '/bin/sh', args: ['-c', 'exit 0'], cwd: homedir() })
      expect(await waitUntil(() => service.describe(exitedId)?.exited === true, WAIT_MS)).toBe(true)
      // 此刻总数已到上限，这一次 create 必须走"先清已退出"的分支。
      const freshId = await service.create({ command: '/bin/sh', args: ['-c', 'sleep 30'], cwd: homedir() })
      expect(service.describe(exitedId), '已退出的会话该被腾掉').toBeUndefined()
      expect(service.describe(liveId), '活着的会话不该被回收').toBeDefined()
      expect(service.describe(freshId)).toBeDefined()

      // 两个都活着且都挂着客户端：没有可回收对象，create 要明确报错而不是硬塞。
      holder = await connect(host.url)
      for (const [terminalId, token] of [[liveId, 'hold-live'], [freshId, 'hold-fresh']] as const) {
        holder.ws.send(JSON.stringify({ type: 'attach', terminalId, token }))
        const attached = await waitFor(holder.received, message => message.type === 'attached' && message.token === token, WAIT_MS)
        expect(attached).toBeDefined()
      }
      await expect(service.create({ command: '/bin/sh', args: ['-c', 'sleep 30'], cwd: homedir() }))
        .rejects.toThrow(/总数已达上限/)
    } finally {
      holder?.ws.close()
      host.stop()
    }
  })

  itPosix('总数吃紧时回收最久闲置的会话，持有方靠 describe 发现它已消失', async () => {
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: [], maxSessionsTotal: 2 })
    try {
      const service = sessionsServiceOf(host)
      const oldest = await service.create({ command: '/bin/sh', args: ['-c', 'sleep 30'], cwd: homedir() })
      // 拉开时间差，让"最久闲置"有唯一解（idleSince 是毫秒时间戳）。
      await sleep(25)
      const newer = await service.create({ command: '/bin/sh', args: ['-c', 'sleep 30'], cwd: homedir() })
      // 两者都无人挂接，到上限后 create 仍应成功：回收最久闲置者腾出名额。
      const fresh = await service.create({ command: '/bin/sh', args: ['-c', 'sleep 30'], cwd: homedir() })
      expect(service.describe(oldest), '最久闲置的会话该被回收').toBeUndefined()
      expect(service.describe(newer)).toBeDefined()
      expect(service.describe(fresh)).toBeDefined()
    } finally {
      host.stop()
    }
  })
})
