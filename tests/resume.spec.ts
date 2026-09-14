import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { ServerMessage } from '../src/protocol.ts'
import { connect, sessionsServiceOf, sleep, startHost, waitFor, waitUntil } from './harness.ts'
import type { TestClient } from './harness.ts'

const itPosix = process.platform === 'win32' ? it.skip : it

/** 一次 attach 的 synced 应答：重放结束时客户端在流里的绝对位置。 */
interface SyncedAt {
  offset: number
}

/**
 * 等一次 attach 的 synced 标记。
 *
 * @param client - 已连接的测试客户端。
 * @param request - attach 请求。
 * @returns synced 报出的绝对位置。
 */
async function attachAndSync(
  client: TestClient,
  request: Record<string, unknown>,
): Promise<SyncedAt> {
  client.ws.send(JSON.stringify(request))
  const synced = await waitFor(
    client.received,
    message => message.type === 'synced' && message.terminalId === request.terminalId,
  )
  if (synced === undefined || synced.type !== 'synced') throw new Error('等待 synced 超时')
  return { offset: synced.offset }
}

/**
 * 等重放帧收齐。重放是连续发完的，宿主在发完 synced 之前不会插入实时输出，因此
 * "synced 已到、帧还没到齐"只可能是异步送达的延迟；这里显式等齐，字节级断言才
 * 不会因为竞态而落空。
 *
 * @param chunks - 已挂在该会话上收集输出的数组。
 * @param expectedBytes - 期望收齐的字节数。
 * @param timeoutMs - 等待上限。
 * @returns 实际收齐的字节数；超时返回当时的值，由调用方断言。
 */
async function waitForChunkBytes(
  chunks: ReadonlyArray<{ data: string }>,
  expectedBytes: number,
  timeoutMs = 3000,
): Promise<number> {
  const total = (): number => chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.data), 0)
  const deadline = Date.now() + timeoutMs
  while (total() < expectedBytes && Date.now() < deadline) await sleep(20)
  return total()
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
      // 缓冲没被裁剪：重放覆盖从流开头开始的完整前缀，已收字节数就是位置。
      expect(syncedAt.offset).toBe(cumulative)

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
      expect(syncedAt.offset).toBe(firstChunks[firstChunks.length - 1]?.offset)

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
      expect(syncedAt.offset).toBe(total)

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
      const syncedAt = await attachAndSync(
        resumed,
        { type: 'attach', terminalId: sessionId, token: 'resumed', since: boundary },
      )

      const replayed = resumedChunks.map(chunk => chunk.data).join('')
      expect(replayed).toContain('BBBB')
      expect(replayed).not.toContain('AAAA')
      // 续接起点 + 补发字节 = 会话当前总长度（目击者看到的最后一个偏移）。
      expect(syncedAt.offset).toBe(boundary + Buffer.byteLength(replayed))
      expect(syncedAt.offset).toBe(witnessChunks[witnessChunks.length - 1]?.offset)

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
      const syncedAt = await attachAndSync(
        fresh,
        { type: 'attach', terminalId: sessionId, token: 'after-trim' },
      )

      const replayed = freshChunks.map(chunk => chunk.data).join('')
      expect(replayed).toContain('BBBBBBBBBBBBBBBBBBBB')
      expect(replayed).not.toContain('AAAAAAAAAAAAAAAAAAAA')
      // 缓冲相对偏移会被裁剪重置，绝对偏移不会：首块之前还有已被裁掉的历史。
      const head = freshChunks[0]
      if (head === undefined) throw new Error('裁剪后没有可重放的内容')
      expect(head.offset).toBeGreaterThan(Buffer.byteLength(head.data))

      // 被裁掉的那段补不回来，但还留着的内容一块不少地重放，且偏移仍是流里的绝对
      // 位置：重放末尾就是首块的末尾（客户端据此报 since 才不会跳过后续输出）。
      const receivedBytes = await waitForChunkBytes(freshChunks, Buffer.byteLength(replayed))
      expect(receivedBytes).toBe(Buffer.byteLength(replayed))
      expect(syncedAt.offset).toBe(head.offset)

      fresh.ws.close()
      first.ws.close()
    } finally {
      host.stop()
    }
  })

  itPosix('客户端报的位置早于缓冲头部时，从缓冲还留着的地方重放而不是整段跳过', async () => {
    // 同上：第一块（20 字节）必然被裁掉，缓冲里只剩第二块。
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

      // since=0 表示客户端"只消费到第 0 字节"，而第 0..20 已被裁掉：宿主不把这个
      // 位置当成"已消费"整段跳过，而是把还留着的内容全部重放——拿不全，但不会
      // 什么都不给，也不会把客户端没有的字节记成已有。
      const resumed = await connect(host.url)
      const resumedChunks = collectOutput(resumed, sessionId)
      const syncedAt = await attachAndSync(
        resumed,
        { type: 'attach', terminalId: sessionId, token: 'stale-since', since: 0 },
      )

      const replayed = resumedChunks.map(chunk => chunk.data).join('')
      expect(replayed).toContain('BBBBBBBBBBBBBBBBBBBB')
      const receivedBytes = await waitForChunkBytes(resumedChunks, Buffer.byteLength('BBBBBBBBBBBBBBBBBBBB'))
      // 缓冲里只剩第二块（20 字节），重放末尾是流里的绝对位置 40（前 20 已被裁掉）。
      expect(receivedBytes).toBe(20)
      expect(syncedAt.offset).toBe(40)

      resumed.ws.close()
      first.ws.close()
    } finally {
      host.stop()
    }
  })

  itPosix('客户端离线期间缓冲又往前裁剪：同一位置重挂两次都拿到同一段，不会被跳过', async () => {
    // 缓冲只装得下一块（16 字节 < 20）：每产生一块，前一块就被裁掉。
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: [], scrollbackMaxBytes: 16, maxSessions: 2 })
    try {
      const sessionId = await sessionsServiceOf(host).create({
        command: '/bin/sh',
        args: ['-c', 'printf BBBBBBBBBBBBBBBBBBBB; sleep 2; printf CCCCCCCCCCCCCCCCCCCC; sleep 2; printf DDDDDDDDDDDDDDDDDDDD; sleep 30'],
        cwd: homedir(),
      })

      // 目击者全程挂着，用来判定全部三段输出确实产生了。
      const witness = await connect(host.url)
      const witnessChunks = collectOutput(witness, sessionId)
      await attachAndSync(witness, { type: 'attach', terminalId: sessionId, token: 'witness' })
      const sawAll = await waitUntil(() => {
        const text = witnessChunks.map(chunk => chunk.data).join('')
        return text.includes('BBBBBBBBBBBBBBBBBBBB')
          && text.includes('CCCCCCCCCCCCCCCCCCCC')
          && text.includes('DDDDDDDDDDDDDDDDDDDD')
      })
      expect(sawAll, '三段输出未全部产生').toBe(true)

      // 客户端此刻报的是一个早于缓冲头部的位置（它以为自己的画面从流开头算起，而
      // 缓冲早已滚到只剩最后一块）。宿主只能从还留着的位置重放。
      const first = await connect(host.url)
      const firstChunks = collectOutput(first, sessionId)
      const firstAt = await attachAndSync(
        first,
        { type: 'attach', terminalId: sessionId, token: 'stale-1', since: 0 },
      )
      const firstReplay = firstChunks.map(chunk => chunk.data).join('')
      expect(firstReplay).not.toBe('')
      first.ws.close()

      // 同一个位置再挂一次（真实场景里客户端正是按自己的记账反复重连）。这一段必须
      // 原样再来一遍：宿主不会把早于缓冲头部的位置当成"已消费"，还留着的内容每次
      // 都重放；否则被裁掉的那段之后的内容会永远不再出现在客户端面前。
      const second = await connect(host.url)
      const secondChunks = collectOutput(second, sessionId)
      const secondAt = await attachAndSync(
        second,
        { type: 'attach', terminalId: sessionId, token: 'stale-2', since: 0 },
      )
      const secondReplay = secondChunks.map(chunk => chunk.data).join('')
      expect(secondReplay).toBe(firstReplay)
      expect(secondAt).toEqual(firstAt)

      second.ws.close()
      witness.ws.close()
    } finally {
      host.stop()
    }
  })
})
