import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SCOPE, workspaceScope } from '../src/index.ts'
import { planReconcile } from '../src/client/reconcile.ts'
import { connect, listSessions, sessionsServiceOf, startHost } from './harness.ts'

const itPosix = process.platform === 'win32' ? it.skip : it

/** 预览页签所在工作区；作用域键一律经 workspaceScope 构造，与消费方用法一致。 */
const WORKSPACE_ID = 'w1'

describe('外部会话与视图对账的契约', () => {
  itPosix('带作用域拉起的会话会被同工作区的视图收养', async () => {
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: [] })
    const client = await connect(host.url)
    try {
      const sessionId = await sessionsServiceOf(host).create({
        command: '/bin/sh',
        args: ['-c', 'sleep 30'],
        cwd: homedir(),
        env: { DSH_PREVIEW_BASE: '/preview/p4271/' },
        label: '预览 p4271',
        scope: workspaceScope(WORKSPACE_ID),
      })

      // 快照与判定都走公开面：协议问宿主，纯函数按同一套作用域键决定收养。
      const rows = await listSessions(client, 'scoped')
      const plan = planReconcile({ rows, scope: workspaceScope(WORKSPACE_ID), known: [], mountedKeys: [] })
      expect(plan.adopt).toContain(sessionId)
    } finally {
      client.ws.close()
      host.stop()
    }
  })

  itPosix('不带作用域时落进 default 桶：工作区视图不会收养它', async () => {
    const host = await startHost({ shellPath: '/bin/sh', shellArgs: [] })
    const client = await connect(host.url)
    try {
      const sessionId = await sessionsServiceOf(host).create({
        command: '/bin/sh',
        args: ['-c', 'sleep 30'],
        cwd: homedir(),
      })

      const rows = await listSessions(client, 'unscoped')
      const plan = planReconcile({ rows, scope: workspaceScope(WORKSPACE_ID), known: [], mountedKeys: [] })
      expect(plan.adopt).not.toContain(sessionId)
      expect(rows.find(row => row.terminalId === sessionId)?.scope).toBe(DEFAULT_SCOPE)
    } finally {
      client.ws.close()
      host.stop()
    }
  })
})
