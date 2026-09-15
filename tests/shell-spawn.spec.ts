/**
 * shell 起不来时的报错要能自解释；能起来的 shell 不能被这套校验误伤。
 *
 * node-pty 对不存在或不可执行的 shell 不抛错，只是让进程立刻以 1 退出（实测），
 * 界面上表现为"终端一闪就退"。登录 shell 由账户决定、可能指向已卸载的程序，
 * 因此插件在起进程前先校验，把失败变成一条能指出出路的错误。
 *
 * 校验必须覆盖两类"不可执行"：路径不存在/没有执行位（ENOENT / EACCES），以及
 * **不是普通文件**——目录能通过 `accessSync(X_OK)`（对目录而言那是"可搜索"位），
 * 只在 spawn 之后以 exit 1 暴露，正是要消除的那种静默失败。
 *
 * 同时不能误杀：相对路径要按**会话 cwd** 解析（node-pty 是子进程 chdir 之后才
 * exec 的），拿宿主进程 cwd 判断会把本来跑得起来的相对 shell 报成不可用。
 *
 * @module dsh-remote-terminal/tests-shell-spawn
 */
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connect, startHost, waitFor, waitUntil } from './harness.ts'

const itPosix = process.platform === 'win32' ? it.skip : it

/**
 * tmpdir 下本插件命名的包装私有目录集合（与 scripts/verify-host.mjs 同一口径）。
 *
 * @returns 目录绝对路径集合。
 */
function wrapDirs(): Set<string> {
  const found = new Set<string>()
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('dsh-remote-terminal-')) continue
    const full = join(tmpdir(), name)
    if (statSync(full).isDirectory()) found.add(full)
  }
  return found
}

/**
 * 用一个不可用的 shellPath 新建终端，返回宿主回给客户端的错误文案。
 *
 * @param shellPath - 要配置的 shell 路径。
 * @returns 错误消息。
 */
async function attachError(shellPath: string): Promise<string> {
  const host = await startHost({ shellPath })
  try {
    const client = await connect(host.url)
    client.ws.send(JSON.stringify({ type: 'attach', cwd: homedir(), cols: 80, rows: 24, token: 'bad-shell' }))
    const hit = await waitFor(
      client.received,
      message => message.type === 'error' && message.token === 'bad-shell',
      4000,
    )
    expect(hit).toBeDefined()
    // 会话表里不留半成品：失败的创建不该占住配额。
    expect(host.ctx.logs.some(line => line.includes('已创建终端会话'))).toBe(false)
    return hit?.type === 'error' ? hit.message : ''
  } finally {
    host.stop()
  }
}

describe('shell 不可执行时', () => {
  itPosix('路径不存在：attach 回一条带 shellPath 出路的错误，而不是让终端一闪就退', async () => {
    const message = await attachError('/nonexistent/dsh-remote-shell')
    expect(message).toContain('/nonexistent/dsh-remote-shell')
    expect(message).toContain('shellPath')
  })

  itPosix('路径是目录：同样被拦下，而不是起出一个立刻退出的会话', async () => {
    const message = await attachError('/usr/bin')
    expect(message).toContain('/usr/bin')
    expect(message).toContain('不是普通文件')
    expect(message).toContain('shellPath')
  })
})

describe('shell 的路径合法时', () => {
  itPosix('相对路径不做预判（内核按物理目录解析，词法解析复刻不了），照常能起终端', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rt-relshell-'))
    writeFileSync(join(root, 'probe-shell'), '#!/bin/sh\necho REL_SHELL_OK\n', { mode: 0o755 })
    const host = await startHost({ shellPath: './probe-shell' })
    try {
      const client = await connect(host.url)
      let output = ''
      client.ws.on('message', (data) => {
        const message = JSON.parse(String(data)) as { type: string; data?: string }
        if (message.type === 'output') output += message.data ?? ''
      })
      client.ws.send(JSON.stringify({ type: 'attach', cwd: root, cols: 80, rows: 24, token: 'rel-shell' }))
      const hit = await waitFor(
        client.received,
        message => (message.type === 'attached' || message.type === 'error') && message.token === 'rel-shell',
        4000,
      )
      // 用宿主进程 cwd（或任何词法解析）去判断相对路径，会把这个明明能跑的 shell
      // 报成"不可执行"：node-pty 是子进程 chdir 到会话目录之后才 exec 的。
      expect(hit?.type).toBe('attached')
      expect(await waitUntil(() => output.includes('REL_SHELL_OK'), 4000)).toBe(true)
    } finally {
      host.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  itPosix('软链指向的绝对路径照常通过（/bin/sh、Homebrew 的 zsh 都是软链）', async () => {
    const host = await startHost({ shellPath: '/usr/bin/sh' })
    try {
      const client = await connect(host.url)
      client.ws.send(JSON.stringify({ type: 'attach', cwd: homedir(), cols: 80, rows: 24, token: 'link-shell' }))
      const hit = await waitFor(
        client.received,
        message => (message.type === 'attached' || message.type === 'error') && message.token === 'link-shell',
        4000,
      )
      expect(hit?.type).toBe('attached')
    } finally {
      host.stop()
    }
  })
})

describe('包装目录被外部清理后', () => {
  itPosix('新会话会重建包装，cwd 上报不会静默失效', async () => {
    const before = wrapDirs()
    const host = await startHost({})
    try {
      const attachAndWaitOsc = async (token: string): Promise<boolean> => {
        const client = await connect(host.url)
        let output = ''
        client.ws.on('message', (data) => {
          const message = JSON.parse(String(data)) as { type: string; data?: string }
          if (message.type === 'output') output += message.data ?? ''
        })
        client.ws.send(JSON.stringify({ type: 'attach', cwd: homedir(), cols: 80, rows: 24, token }))
        await waitFor(client.received, message => message.type === 'attached' && message.token === token, 5000)
        return waitUntil(() => output.includes('\u001b]7;'), 6000)
      }

      expect(await attachAndWaitOsc('before-clean')).toBe(true)

      // 登录 shell 为 fish 时不落盘，这次就不会有目录可删。
      const created = [...wrapDirs()].filter(dir => !before.has(dir))
      expect(created.length).toBeLessThanOrEqual(1)
      const stale = created[0]
      if (stale === undefined) return

      // 模拟 systemd-tmpfiles / tmpfs 把 /tmp 下的私有目录清掉：缓存若不校验，
      // 之后的新会话会一直用不存在的入口，连用户自己的配置都静默不加载。
      // 注：/tmp 是跨 worker 共享的，这里删的是"本用例开始后新出现"的那个目录；
      // 即使撞上并行跑的其他用例，它们也只是下次建会话时重建（测试里没有任何断言
      // 依赖包装目录的存在或数量），不会互相干扰。
      rmSync(stale, { recursive: true, force: true })
      expect(await attachAndWaitOsc('after-clean')).toBe(true)
      expect([...wrapDirs()].some(dir => !before.has(dir))).toBe(true)
    } finally {
      host.stop()
    }
  })
})
