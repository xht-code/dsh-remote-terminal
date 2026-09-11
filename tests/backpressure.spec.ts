import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { connect, once, sleep, startHost, waitFor } from './harness.ts'
import type { HostHarness, TestClient } from './harness.ts'

const itPosix = process.platform === 'win32' ? it.skip : it

/**
 * 停止/恢复消费对端数据：等价于网络拥塞或页面主线程卡死。
 * ws 未公开该 socket，但测试必须真正停止读取内核缓冲，只能取内部字段。
 */
function consuming(client: TestClient, enabled: boolean): void {
  const socket = (client.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket
  if (enabled) socket.resume()
  else socket.pause()
}

/** 等宿主打出某条诊断日志。 */
async function waitForLog(host: HostHarness, needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!host.ctx.logs.some(line => line.includes(needle))) {
    if (Date.now() > deadline) throw new Error('未等到宿主日志：' + needle + '（现有：' + host.ctx.logs.join(' | ') + '）')
    await sleep(50)
  }
}

describe('输出背压', () => {
  itPosix('客户端停止消费时断开该连接，而不是无界缓冲撑爆宿主', async () => {
    // scrollback 调小只是把阈值压到下限 4 MiB，让测试不必灌满默认的 16 MiB。
    const host = await startHost({ shellPath: '/bin/bash', shellArgs: ['--norc', '-i'], scrollbackMaxBytes: 4096, maxSessions: 2 })
    try {
      const slow = await connect(host.url)
      slow.ws.send(JSON.stringify({ type: 'attach', cwd: homedir(), cols: 80, rows: 24, token: 'slow' }))
      const attached = await waitFor(slow.received, message => message.type === 'attached' && message.token === 'slow')
      if (attached === undefined || attached.type !== 'attached') throw new Error('attach 未成功')

      // 先停止消费，再让终端开始无限输出：所有输出都只能堆在宿主侧。
      consuming(slow, false)
      slow.ws.send(JSON.stringify({ type: 'input', terminalId: attached.terminalId, data: 'yes dsh-remote-terminal\n' }))

      // 暂停期间客户端读不到任何字节（连 close 也读不到），判定信号只能取自宿主侧日志。
      await waitForLog(host, '待发送缓冲', 20_000)
      consuming(slow, true)
      await expect(once(slow.ws, 'close', 5000)).resolves.toBeUndefined()

      // 只断开慢连接，会话本身必须还在：换一条正常连接可以重新挂上。
      const healthy = await connect(host.url)
      healthy.ws.send(JSON.stringify({ type: 'attach', terminalId: attached.terminalId, token: 'healthy' }))
      const reattached = await waitFor(healthy.received, message => message.type === 'attached' && message.token === 'healthy')
      if (reattached === undefined || reattached.type !== 'attached') throw new Error('重挂失败')
      expect(reattached.exited).toBe(false)
      // 收工：终止刷屏进程，避免测试进程继续解析海量输出。
      healthy.ws.send(JSON.stringify({ type: 'input', terminalId: attached.terminalId, data: '\u0003' }))
      healthy.ws.close()
    } finally {
      host.stop()
    }
    // 需要等宿主侧缓冲涨到阈值，默认 5s 测试超时不够。
  }, 30_000)
})
