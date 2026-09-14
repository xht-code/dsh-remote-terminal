import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { connect, sessionsServiceOf, sleep, startHost, waitFor } from './harness.ts'
import type { TestClient } from './harness.ts'
import type { ServerMessage } from '../src/protocol.ts'

/** 交互式 sh：不产生输出、不自行退出，适合表示"仍活着的闲置会话"。 */
const idleShell = { shellPath: '/bin/sh' }
const itPosix = process.platform === 'win32' ? it.skip : it

/**
 * 请求新建终端并等到应答。旧连接断开到宿主把它从挂接集合摘除之间有一个
 * 窗口，期间的 attach 会如实回"配额已满"——重试即可；若回收逻辑失效，
 * 重试到超时仍拿不到会话，测试照样失败。
 *
 * @param client - 已连接的测试客户端。
 * @param token - 关联令牌（重试复用，便于收集应答）。
 * @param timeoutMs - 重试总时限。
 * @param scope - 作用域（工作区）；缺省即 default 桶。
 * @returns attached 应答。
 */
async function attachNew(
  client: TestClient,
  token: string,
  timeoutMs = 10_000,
  scope?: string,
): Promise<Extract<ServerMessage, { type: 'attached' }>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    client.ws.send(JSON.stringify({ type: 'attach', cwd: homedir(), cols: 80, rows: 24, token, ...(scope === undefined ? {} : { scope }) }))
    const hit = await waitFor(
      client.received,
      message => (message.type === 'attached' || message.type === 'error') && message.token === token,
      2000,
    )
    if (hit !== undefined && hit.type === 'attached') return hit
    if (Date.now() > deadline) throw new Error('等待新建终端超时，最后一次应答：' + JSON.stringify(hit ?? null))
    await sleep(200)
  }
}

describe('会话配额回收', () => {
  itPosix('配额吃紧时回收无人挂接的闲置会话，终端不会永久卡死', async () => {
    const host = await startHost({ ...idleShell, maxSessions: 1 })
    try {
      const first = await connect(host.url)
      const firstAttached = await attachNew(first, 'first')
      const abandonedId = firstAttached.terminalId

      // 浏览器崩溃 / 关闭标签页：连接消失，会话无人挂接但仍在运行。
      first.ws.terminate()

      const second = await connect(host.url)
      const secondAttached = await attachNew(second, 'second')
      expect(secondAttached.terminalId).not.toBe(abandonedId)
      // 走的是闲置回收（会话还活着），不是"已退出会话"淘汰。
      expect(host.ctx.logs.some(line => line.includes('回收闲置终端会话'))).toBe(true)

      // 被回收的会话必须真的消失：attach 旧 id 应回"不存在"，而不是又被挂上。
      second.ws.send(JSON.stringify({ type: 'attach', terminalId: abandonedId }))
      const gone = await waitFor(second.received, message => message.type === 'error' && message.terminalId === abandonedId)
      expect(gone).toBeDefined()

      second.ws.close()
    } finally {
      host.stop()
    }
  })

  itPosix('仍有客户端挂接的会话不被回收，改为明确报错', async () => {
    const host = await startHost({ ...idleShell, maxSessions: 1 })
    try {
      const holder = await connect(host.url)
      const held = await attachNew(holder, 'holder')

      const blocked = await connect(host.url)
      blocked.ws.send(JSON.stringify({ type: 'attach', cwd: homedir(), cols: 80, rows: 24, token: 'blocked' }))
      const failure = await waitFor(blocked.received, message => message.type === 'error' && message.token === 'blocked')
      if (failure === undefined || failure.type !== 'error') throw new Error('未收到配额上限错误')
      expect(failure.message).toContain('上限')
      expect(blocked.received.some(message => message.type === 'attached')).toBe(false)

      // 挂接中的会话必须原封不动。
      holder.ws.send(JSON.stringify({ type: 'attach', terminalId: held.terminalId }))
      const reattached = await waitFor(holder.received, message => message.type === 'attached' && message.terminalId === held.terminalId)
      expect(reattached).toBeDefined()

      holder.ws.close()
      blocked.ws.close()
    } finally {
      host.stop()
    }
  })
})

describe('配额按工作区（作用域）分别计算', () => {
  itPosix('一个工作区开满不影响别的工作区', async () => {
    const host = await startHost({ ...idleShell, maxSessions: 1 })
    try {
      const alpha = await connect(host.url)
      const alphaTerm = await attachNew(alpha, 'alpha-1', 10_000, 'workspace:a')

      // a 已占满（maxSessions=1 且仍挂接着），b 与 default 各自还有自己的额度。
      const beta = await connect(host.url)
      const betaTerm = await attachNew(beta, 'beta-1', 10_000, 'workspace:b')
      expect(betaTerm.terminalId).not.toBe(alphaTerm.terminalId)
      const fallback = await connect(host.url)
      const fallbackTerm = await attachNew(fallback, 'default-1')
      expect(fallbackTerm.terminalId).not.toBe(alphaTerm.terminalId)

      // 只有 a 自己的额度用尽才会被拒。
      const blocked = await connect(host.url)
      blocked.ws.send(JSON.stringify({ type: 'attach', cwd: homedir(), cols: 80, rows: 24, token: 'alpha-2', scope: 'workspace:a' }))
      const failure = await waitFor(blocked.received, message => message.type === 'error' && message.token === 'alpha-2')
      if (failure === undefined || failure.type !== 'error') throw new Error('未收到配额上限错误')
      expect(failure.message).toContain('上限')

      alpha.ws.close()
      beta.ws.close()
      fallback.ws.close()
      blocked.ws.close()
    } finally {
      host.stop()
    }
  })

  itPosix('闲置回收只动本工作区的会话', async () => {
    const host = await startHost({ ...idleShell, maxSessions: 1 })
    try {
      // a 的会话被遗弃（浏览器崩溃 / 关标签页）：仍活着且无人挂接。
      const abandoned = await connect(host.url)
      const abandonedTerm = await attachNew(abandoned, 'a-1', 10_000, 'workspace:a')
      abandoned.ws.terminate()
      await sleep(300)

      // b 建自己的终端：b 的额度本来就是空的，不该借机回收 a 的闲置会话。
      const beta = await connect(host.url)
      await attachNew(beta, 'b-1', 10_000, 'workspace:b')
      expect(host.ctx.logs.some(line => line.includes('回收闲置终端会话'))).toBe(false)

      // a 自己额度吃紧时才回收它，且旧 id 真的消失。
      const alpha = await connect(host.url)
      const alphaTerm = await attachNew(alpha, 'a-2', 10_000, 'workspace:a')
      expect(alphaTerm.terminalId).not.toBe(abandonedTerm.terminalId)
      expect(host.ctx.logs.some(line => line.includes('作用域 workspace:a 配额已满，回收闲置终端会话'))).toBe(true)
      alpha.ws.send(JSON.stringify({ type: 'attach', terminalId: abandonedTerm.terminalId }))
      const gone = await waitFor(alpha.received, message => message.type === 'error' && message.terminalId === abandonedTerm.terminalId)
      expect(gone).toBeDefined()

      beta.ws.close()
      alpha.ws.close()
    } finally {
      host.stop()
    }
  })
})

describe('跨工作区总数上限（兜底）', () => {
  itPosix('总数达到上限且无闲置可回收时明确报错', async () => {
    const host = await startHost({ ...idleShell, maxSessions: 2, maxSessionsTotal: 3 })
    try {
      const alpha = await connect(host.url)
      const alpha1 = await attachNew(alpha, 'a-1', 10_000, 'workspace:a')
      const alpha2 = await attachNew(alpha, 'a-2', 10_000, 'workspace:a')
      const beta = await connect(host.url)
      await attachNew(beta, 'b-1', 10_000, 'workspace:b')
      expect(new Set([alpha1.terminalId, alpha2.terminalId]).size).toBe(2)

      // 三个会话都挂接着：总数 3/3，没有可回收的闲置终端。
      const blocked = await connect(host.url)
      blocked.ws.send(JSON.stringify({ type: 'attach', cwd: homedir(), cols: 80, rows: 24, token: 'c-1', scope: 'workspace:c' }))
      const failure = await waitFor(blocked.received, message => message.type === 'error' && message.token === 'c-1')
      if (failure === undefined || failure.type !== 'error') throw new Error('未收到总数上限错误')
      expect(failure.message).toContain('总数已达上限')
      expect(blocked.received.some(message => message.type === 'attached')).toBe(false)

      alpha.ws.close()
      beta.ws.close()
      blocked.ws.close()
    } finally {
      host.stop()
    }
  })

  itPosix('总数吃紧时回收别的工作区里无人挂接的闲置终端', async () => {
    const host = await startHost({ ...idleShell, maxSessions: 2, maxSessionsTotal: 3 })
    try {
      // a 用满自己的额度后浏览器崩溃：两个会话都成了无人挂接的闲置终端。
      const alpha = await connect(host.url)
      const abandoned1 = await attachNew(alpha, 'a-1', 10_000, 'workspace:a')
      const abandoned2 = await attachNew(alpha, 'a-2', 10_000, 'workspace:a')
      alpha.ws.terminate()
      await sleep(300)

      const beta = await connect(host.url)
      await attachNew(beta, 'b-1', 10_000, 'workspace:b')

      // c 新建时总数已满：回收 a 里最久闲置的那个（先创建的那个），c 拿到新会话。
      const gamma = await connect(host.url)
      const gammaTerm = await attachNew(gamma, 'c-1', 10_000, 'workspace:c')
      expect([abandoned1.terminalId, abandoned2.terminalId]).not.toContain(gammaTerm.terminalId)
      expect(host.ctx.logs.some(line => line.includes('总数上限已满，回收闲置终端会话'))).toBe(true)
      // 回收发生在 a 的桶里，且只回收了一个。
      expect(host.ctx.logs.some(line => line.includes('总数上限已满，回收闲置终端会话 ' + abandoned1.terminalId))).toBe(true)

      gamma.ws.send(JSON.stringify({ type: 'attach', terminalId: abandoned2.terminalId, token: 'reclaim-2' }))
      const survivor = await waitFor(gamma.received, message => message.type === 'attached' && message.token === 'reclaim-2')
      expect(survivor).toBeDefined()

      beta.ws.close()
      gamma.ws.close()
    } finally {
      host.stop()
    }
  })
})

describe('close 不要求本连接挂接过该会话', () => {
  itPosix('知道 id 的连接就能关掉它，挂接者据此收起标签', async () => {
    const host = await startHost({ ...idleShell, maxSessions: 2 })
    try {
      const owner = await connect(host.url)
      const sessionId = (await attachNew(owner, 'owner')).terminalId

      // 另一个窗口（或重连后的新连接）知道 id 即可关闭：断线窗口里入队的 close 会
      // 在重连时先于 attach 冲刷到宿主，若要求"本连接挂接过"就会被丢弃——用户关掉
      // 的终端会复活、宿主侧那个 shell 也永远没人关。
      const other = await connect(host.url)
      other.ws.send(JSON.stringify({ type: 'close', terminalId: sessionId }))
      await waitFor(owner.received, message => message.type === 'closed' && message.terminalId === sessionId)
      expect(sessionsServiceOf(host).describe(sessionId)).toBeUndefined()

      owner.ws.close()
      other.ws.close()
    } finally {
      host.stop()
    }
  })
})
