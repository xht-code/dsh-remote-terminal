import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { ServerMessage } from '../src/protocol.ts'
import { connect, sessionsServiceOf, startHost, waitFor, waitUntil } from './harness.ts'
import type { TestClient } from './harness.ts'

const itPosix = process.platform === 'win32' ? it.skip : it

/** 等一次 attach 的 synced 标记，返回它报出的客户端位置。 */
async function attachAndSync(client: TestClient, request: Record<string, unknown>): Promise<number> {
  client.ws.send(JSON.stringify(request))
  const synced = await waitFor(
    client.received,
    message => message.type === 'synced' && message.terminalId === request.terminalId,
  )
  if (synced === undefined || synced.type !== 'synced') throw new Error('等待 synced 超时')
  return synced.offset
}

/** 收集某会话的输出分片及其绝对偏移（与 harness 的事件收集并存）。 */
function collectOutput(client: TestClient, terminalId: string): Array<{ data: string; offset: number }> {
  const chunks: Array<{ data: string; offset: number }> = []
  client.ws.on('message', (raw) => {
    const message = JSON.parse(String(raw)) as ServerMessage
    if (message.type === 'output' && message.terminalId === terminalId) {
      chunks.push({ data: message.data, offset: message.offset })
    }
  })
  return chunks
}

/** 命令分两次写、中间隔 1 秒：宿主必然把它们读成两块，便于验证按块边界续接。 */
const TWO_STEP_COMMAND = 'printf AAAA; sleep 1; printf BBBB; sleep 30'

describe('输出偏移与增量续接', () => {
  itPosix('全新客户端拿到整段重放，偏移是会话流里的绝对位置', async () => {
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: [] })
    try {
      const sessionId = await sessionsServiceOf(host).create({
        command: '/bin/sh', args: ['-c', TWO_STEP_COMMAND], cwd: homedir(),
      })

      // 先挂一个客户端，等两次输出都产生出来，后续用例才有稳定的历史可续。
      const warm = await connect(host.url)
      const warmChunks = collectOutput(warm, sessionId)
      await attachAndSync(warm, { type: 'attach', terminalId: sessionId, token: 'warm' })
      const produced = await waitUntil(() => warmChunks.map(chunk => chunk.data).join('').includes('BBBB'))
      expect(produced, '两次输出未能产生').toBe(true)

      const fresh = await connect(host.url)
      const freshChunks = collectOutput(fresh, sessionId)
      const syncedAt = await attachAndSync(fresh, { type: 'attach', terminalId: sessionId, token: 'fresh' })

      const replayed = freshChunks.map(chunk => chunk.data).join('')
      expect(replayed).toContain('AAAA')
      expect(replayed).toContain('BBBB')
      // 偏移严格递增，且每次都等于已收字节数的累计——客户端据此报 since 才对得上块边界。
      let cumulative = 0
      for (const chunk of freshChunks) {
        cumulative += Buffer.byteLength(chunk.data)
        expect(chunk.offset).toBe(cumulative)
      }
      expect(syncedAt).toBe(cumulative)

      fresh.ws.close()
      warm.ws.close()
    } finally {
      host.stop()
    }
  })

  itPosix('带 since 重挂只补缺口：不重放头部，也不重复已消费的块', async () => {
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: [] })
    try {
      const sessionId = await sessionsServiceOf(host).create({
        command: '/bin/sh', args: ['-c', TWO_STEP_COMMAND], cwd: homedir(),
      })

      const first = await connect(host.url)
      const firstChunks = collectOutput(first, sessionId)
      await attachAndSync(first, { type: 'attach', terminalId: sessionId, token: 'first' })
      const produced = await waitUntil(() => firstChunks.map(chunk => chunk.data).join('').includes('BBBB'))
      expect(produced, '两次输出未能产生').toBe(true)
      expect(firstChunks.length).toBeGreaterThan(1)

      // 以倒数第二块结束处为界：界前的字节客户端已经消化过，界后的必须一块不少地补上。
      const boundaryIndex = firstChunks.length - 2
      const boundary = firstChunks[boundaryIndex]
      if (boundary === undefined) throw new Error('分片数量不足')
      const expectedTail = firstChunks.slice(boundaryIndex + 1).map(chunk => chunk.data).join('')

      const resumed = await connect(host.url)
      const resumedChunks = collectOutput(resumed, sessionId)
      const syncedAt = await attachAndSync(resumed, { type: 'attach', terminalId: sessionId, token: 'resume', since: boundary.offset })

      expect(resumedChunks.map(chunk => chunk.data).join('')).toBe(expectedTail)
      expect(resumedChunks.map(chunk => chunk.data).join('')).not.toContain('AAAA')
      expect(syncedAt).toBe(firstChunks[firstChunks.length - 1]?.offset)

      resumed.ws.close()
      first.ws.close()
    } finally {
      host.stop()
    }
  })

  itPosix('since 追上当前位置时没有可补的内容，synced 仍报出当前位置', async () => {
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: [] })
    try {
      const sessionId = await sessionsServiceOf(host).create({
        command: '/bin/sh', args: ['-c', TWO_STEP_COMMAND], cwd: homedir(),
      })

      const first = await connect(host.url)
      const firstChunks = collectOutput(first, sessionId)
      const current = await attachAndSync(first, { type: 'attach', terminalId: sessionId, token: 'first' })
      const produced = await waitUntil(() => firstChunks.map(chunk => chunk.data).join('').includes('BBBB'))
      expect(produced, '两次输出未能产生').toBe(true)
      // 挂上之后再产生的输出同样会实时推来，因此以最后一块的偏移为当前位置。
      const total = firstChunks[firstChunks.length - 1]?.offset ?? current

      const resumed = await connect(host.url)
      const resumedChunks = collectOutput(resumed, sessionId)
      const syncedAt = await attachAndSync(resumed, { type: 'attach', terminalId: sessionId, token: 'caught-up', since: total })

      expect(resumedChunks).toEqual([])
      expect(syncedAt).toBe(total)

      resumed.ws.close()
      first.ws.close()
    } finally {
      host.stop()
    }
  })

  itPosix('离开期间产生的输出：续接时按边界补齐，不漏也不重', async () => {
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: [] })
    try {
      const sessionId = await sessionsServiceOf(host).create({
        command: '/bin/sh', args: ['-c', TWO_STEP_COMMAND], cwd: homedir(),
      })

      // 目击者：始终挂着，用来判断"离开期间"的第二段输出确实产生了。
      const witness = await connect(host.url)
      const witnessChunks = collectOutput(witness, sessionId)
      await attachAndSync(witness, { type: 'attach', terminalId: sessionId, token: 'witness' })

      // 离开的客户端：只看到第一段就断开，断点即它的最后一块边界。
      const away = await connect(host.url)
      const awayChunks = collectOutput(away, sessionId)
      await attachAndSync(away, { type: 'attach', terminalId: sessionId, token: 'away' })
      const sawFirst = await waitUntil(() => awayChunks.map(chunk => chunk.data).join('').includes('AAAA'))
      expect(sawFirst, '第一段输出未到达').toBe(true)
      const boundary = awayChunks[awayChunks.length - 1]?.offset
      if (boundary === undefined) throw new Error('离开前没有任何输出分片')
      away.ws.close()

      const sawSecond = await waitUntil(() => witnessChunks.map(chunk => chunk.data).join('').includes('BBBB'))
      expect(sawSecond, '离开期间的第二段输出未产生').toBe(true)

      const resumed = await connect(host.url)
      const resumedChunks = collectOutput(resumed, sessionId)
      const syncedAt = await attachAndSync(resumed, { type: 'attach', terminalId: sessionId, token: 'resumed', since: boundary })

      const replayed = resumedChunks.map(chunk => chunk.data).join('')
      expect(replayed).toContain('BBBB')
      expect(replayed).not.toContain('AAAA')
      // 续接起点 + 补发字节 = 会话当前总长度（目击者看到的最后一个偏移）。
      expect(syncedAt).toBe(boundary + Buffer.byteLength(replayed))
      expect(syncedAt).toBe(witnessChunks[witnessChunks.length - 1]?.offset)

      resumed.ws.close()
      witness.ws.close()
    } finally {
      host.stop()
    }
  })

  itPosix('缓冲已被头部裁剪时从还留着的位置重放，偏移仍是绝对位置', async () => {
    // 16 字节的缓冲装不下两块输出：第一块必然被裁掉，只留最后一块。
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: [], scrollbackMaxBytes: 16, maxSessions: 2 })
    try {
      const sessionId = await sessionsServiceOf(host).create({
        command: '/bin/sh',
        args: ['-c', "printf AAAAAAAAAAAAAAAAAAAA; sleep 1; printf BBBBBBBBBBBBBBBBBBBB; sleep 30"],
        cwd: homedir(),
      })

      const first = await connect(host.url)
      const firstChunks = collectOutput(first, sessionId)
      await attachAndSync(first, { type: 'attach', terminalId: sessionId, token: 'trim' })
      const sawSecond = await waitUntil(() => firstChunks.map(chunk => chunk.data).join('').includes('BBBBBBBBBBBBBBBBBBBB'))
      expect(sawSecond, '第二段输出未产生').toBe(true)

      const fresh = await connect(host.url)
      const freshChunks = collectOutput(fresh, sessionId)
      await attachAndSync(fresh, { type: 'attach', terminalId: sessionId, token: 'after-trim' })

      const replayed = freshChunks.map(chunk => chunk.data).join('')
      expect(replayed).toContain('BBBBBBBBBBBBBBBBBBBB')
      expect(replayed).not.toContain('AAAAAAAAAAAAAAAAAAAA')
      // 缓冲相对偏移会被裁剪重置，绝对偏移不会：首块之前还有已被裁掉的历史。
      const head = freshChunks[0]
      if (head === undefined) throw new Error('裁剪后没有可重放的内容')
      expect(head.offset).toBeGreaterThan(Buffer.byteLength(head.data))

      fresh.ws.close()
      first.ws.close()
    } finally {
      host.stop()
    }
  })
})
