/**
 * 钉了 `shellPath` 时，平台默认启动参数必须跟着**实际要跑的 shell** 走，而不是账户
 * 里的登录 shell：否则 macOS 上会双向错配——账户是 bash 而钉了 zsh / fish 时丢掉
 * `-l`（失去 `~/.zprofile` 与 fish 的 macOS PATH 构造），账户是 zsh 而钉了 bash 时
 * 又多出 `-l`（bash 侧靠 `--rcfile` 挂钩子，与 `-l` 互斥）。
 *
 * macOS 是唯一有差异的平台，这里覆盖 `process.platform`；账户登录 shell 用模块 mock
 * 造出来，不依赖跑测试的机器。Windows 的钉路径行为（路径不被盖掉、非 PowerShell
 * 不套 `-NoLogo -NoProfile`）也在这里覆盖。
 *
 * @module dsh-remote-terminal/tests-config-pinned
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

const account = vi.hoisted(() => ({ shell: '/bin/bash' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, userInfo: () => ({ shell: account.shell }) }
})

const { resolveConfig } = await import('../src/index.ts')

const originalPlatform = process.platform
Object.defineProperty(process, 'platform', { value: 'darwin' })

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

describe('macOS 下钉了 shellPath 时的默认启动参数', () => {
  it('账户是 bash、钉了 zsh / fish：按登录 shell 起（-l -i）', () => {
    account.shell = '/bin/bash'
    expect(resolveConfig({ shellPath: '/opt/homebrew/bin/zsh' }).shellArgs).toEqual(['-l', '-i'])
    expect(resolveConfig({ shellPath: '/opt/homebrew/bin/fish' }).shellArgs).toEqual(['-l', '-i'])
  })

  it('账户是 zsh、钉了 bash：不多给 -l', () => {
    account.shell = '/bin/zsh'
    expect(resolveConfig({ shellPath: '/bin/bash' }).shellArgs).toEqual(['-i'])
  })

  it('没钉 shellPath 时仍按账户里的登录 shell 算', () => {
    account.shell = '/bin/zsh'
    expect(resolveConfig({}).shellPath).toBe('/bin/zsh')
    expect(resolveConfig({}).shellArgs).toEqual(['-l', '-i'])
  })

  it('显式给了 shellArgs 就原样用，不再套平台默认', () => {
    account.shell = '/bin/zsh'
    expect(resolveConfig({ shellPath: '/bin/bash', shellArgs: ['--norc', '-i'] }).shellArgs).toEqual(['--norc', '-i'])
  })

  it('Windows 下钉了 shellPath 仍然用钉的那个（平台默认固定是 PowerShell，不能盖掉）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      account.shell = '/bin/bash'
      expect(resolveConfig({ shellPath: 'C:/Git/bin/bash.exe' }).shellPath).toBe('C:/Git/bin/bash.exe')
      expect(resolveConfig({}).shellPath).toBe('powershell.exe')
      // -NoLogo -NoProfile 只对 PowerShell 成立，钉了别的 shell 不能塞过去。
      expect(resolveConfig({ shellPath: 'C:/Git/bin/bash.exe' }).shellArgs).toEqual([])
      expect(resolveConfig({ shellPath: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' }).shellArgs)
        .toEqual(['-NoLogo', '-NoProfile'])
      expect(resolveConfig({}).shellArgs).toEqual(['-NoLogo', '-NoProfile'])
    } finally {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
    }
  })
})
