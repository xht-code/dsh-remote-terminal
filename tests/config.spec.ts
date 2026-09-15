import { userInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { Config as PluginConfig, defaultShell, resolveConfig } from '../src/index.ts'

const isWindows = process.platform === 'win32'

/**
 * 账户里的登录 shell；查不到（容器里 uid 不在 passwd）时为 null。
 *
 * @returns 登录 shell 路径或 null。
 */
function accountShell(): string | null {
  if (isWindows) return null
  try {
    return userInfo().shell
  } catch {
    return null
  }
}

describe('resolveConfig', () => {
  it('fills platform defaults when nothing is configured', () => {
    const resolved = resolveConfig({})
    expect(resolved.maxSessions).toBe(8)
    expect(resolved.maxSessionsTotal).toBe(32)
    expect(resolved.scrollbackMaxBytes).toBe(2 * 1024 * 1024)
    expect(resolved.wsPath).toBe('/api/remote-terminal/ws')
    if (isWindows) {
      expect(resolved.shellPath).toBe('powershell.exe')
      expect(resolved.shellArgs).toEqual(['-NoLogo', '-NoProfile'])
      expect(resolved.shellWrap).toBeUndefined()
    } else {
      // 默认 shell 就是账户里的登录 shell（开发机上是 /bin/bash 或 /bin/zsh），
      // 账户查不到时才退回平台默认。平台矩阵在 defaultShell 的用例里逐个钉住，
      // 这里验证 resolveConfig 确实把账户查询接到了默认值上。
      const expected = defaultShell(process.platform, accountShell())
      expect(resolved.shellPath).toBe(expected.shellPath)
      expect(resolved.shellArgs).toEqual(expected.shellArgs)
      expect(resolved.shellWrap).toBe(expected.shellWrap)
      expect(resolved.shellWarning).toBeUndefined()
    }
  })

  it('treats a schemastery-materialized empty shellArgs as unset', () => {
    // schema 会把未配置的数组字段物化为 []，归一化必须与"未提供"等价，
    // 否则真实装配下会静默丢掉默认 shell 参数。
    const materialized = PluginConfig({})
    expect(materialized.shellArgs).toEqual([])
    expect(resolveConfig(materialized)).toEqual(resolveConfig({}))
  })

  it('把空串 / YAML 空值也按"未提供"处理，不留半吊子状态', () => {
    // shellPath: '' 曾经会用默认 shell 却不注入钩子（"选路径"和"决定钩子"两处判据
    // 不一致）；shellPath:（YAML 空值 = null）更会直接读 .length 抛错、整个装配失败。
    expect(resolveConfig({ shellPath: '' })).toEqual(resolveConfig({}))
    expect(resolveConfig({ shellPath: null as unknown as string })).toEqual(resolveConfig({}))
    expect(resolveConfig({ shellArgs: null as unknown as string[] })).toEqual(resolveConfig({}))
  })

  it('keeps an explicit shellPath and stops injecting the shell wrapper', () => {
    const resolved = resolveConfig({ shellPath: '/usr/bin/zsh' })
    expect(resolved.shellPath).toBe('/usr/bin/zsh')
    expect(resolved.shellWrap).toBeUndefined()
  })

  it('keeps explicit shellArgs and stops injecting the shell wrapper', () => {
    const resolved = resolveConfig({ shellArgs: ['--norc', '-i'] })
    expect(resolved.shellArgs).toEqual(['--norc', '-i'])
    expect(resolved.shellWrap).toBeUndefined()
  })

  it('honours numeric and path overrides', () => {
    const resolved = resolveConfig({ maxSessions: 2, maxSessionsTotal: 5, scrollbackMaxBytes: 1024, wsPath: '/api/custom/ws' })
    expect(resolved.maxSessions).toBe(2)
    expect(resolved.maxSessionsTotal).toBe(5)
    expect(resolved.scrollbackMaxBytes).toBe(1024)
    expect(resolved.wsPath).toBe('/api/custom/ws')
  })
})

describe('defaultShell', () => {
  it('Linux / macOS 都用账户里的登录 shell，而不是硬编码 bash', () => {
    // macOS 自 10.15 起默认 zsh：硬编码 /bin/bash 会让用户看到 Apple 的弃用
    // 提示，且看不到自己的 zsh 配置；Linux 上登录 shell 是 zsh 的人同理。
    // macOS 的 zsh / fish 按**登录** shell 启动（本机 Terminal.app / iTerm2 就是）：
    // zsh 的 ~/.zprofile（brew shellenv 常写在这里）与 fish 的 macOS PATH 构造
    // （fish 自带 config.fish 里 `status --is-login` 那段读 /etc/paths.d）都只在
    // 登录 shell 下执行。
    expect(defaultShell('darwin', '/bin/zsh')).toEqual({ shellPath: '/bin/zsh', shellArgs: ['-l', '-i'], shellWrap: 'zsh' })
    expect(defaultShell('darwin', '/opt/homebrew/bin/fish')).toEqual({ shellPath: '/opt/homebrew/bin/fish', shellArgs: ['-l', '-i'], shellWrap: 'fish' })
    expect(defaultShell('linux', '/usr/bin/zsh')).toEqual({ shellPath: '/usr/bin/zsh', shellArgs: ['-i'], shellWrap: 'zsh' })
    expect(defaultShell('linux', '/usr/bin/fish')).toEqual({ shellPath: '/usr/bin/fish', shellArgs: ['-i'], shellWrap: 'fish' })
    expect(defaultShell('linux', '/opt/homebrew/bin/bash')).toEqual({ shellPath: '/opt/homebrew/bin/bash', shellArgs: ['-i'], shellWrap: 'bash' })
  })

  it('macOS 的 bash 不套登录语义：--rcfile 与 -l 互斥（实测 -l 下 rcfile 不执行）', () => {
    expect(defaultShell('darwin', '/bin/bash')).toEqual({ shellPath: '/bin/bash', shellArgs: ['-i'], shellWrap: 'bash' })
  })

  it('账户查不到或未记录登录 shell 时退回平台默认', () => {
    expect(defaultShell('darwin', null)).toEqual({ shellPath: '/bin/zsh', shellArgs: ['-l', '-i'], shellWrap: 'zsh' })
    expect(defaultShell('linux', null)).toEqual({ shellPath: '/bin/bash', shellArgs: ['-i'], shellWrap: 'bash' })
  })

  it('认不出的登录 shell 不注入包装（终端可用，只失去 cwd 实时上报）', () => {
    expect(defaultShell('linux', '/usr/sbin/nologin')).toEqual({ shellPath: '/usr/sbin/nologin', shellArgs: ['-i'], shellWrap: undefined })
    expect(defaultShell('darwin', '/usr/local/bin/nu')).toEqual({ shellPath: '/usr/local/bin/nu', shellArgs: ['-i'], shellWrap: undefined })
  })

  it('Windows 默认 PowerShell；钉了别的 shell 就不套 PowerShell 的标志', () => {
    // -NoLogo -NoProfile 只对 PowerShell 成立：塞给 Git Bash 会让它以"无效的选项"
    // 直接退出（实测 `bash -NoLogo` → bash: -N: 无效的选项）。
    expect(defaultShell('win32', null)).toEqual({ shellPath: 'powershell.exe', shellArgs: ['-NoLogo', '-NoProfile'], shellWrap: undefined })
    expect(defaultShell('win32', 'C:/Git/bin/bash.exe')).toEqual({ shellPath: 'C:/Git/bin/bash.exe', shellArgs: [], shellWrap: undefined })
    expect(defaultShell('win32', 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'))
      .toEqual({ shellPath: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', shellArgs: ['-NoLogo', '-NoProfile'], shellWrap: undefined })
    expect(defaultShell('win32', 'pwsh.exe')).toEqual({ shellPath: 'pwsh.exe', shellArgs: ['-NoLogo', '-NoProfile'], shellWrap: undefined })
  })
})

describe('Config validation', () => {
  it('materializes numeric and path defaults through the schema', () => {
    const validated = PluginConfig({})
    expect(validated.maxSessions).toBe(8)
    expect(validated.maxSessionsTotal).toBe(32)
    expect(validated.scrollbackMaxBytes).toBe(2 * 1024 * 1024)
    expect(validated.wsPath).toBe('/api/remote-terminal/ws')
  })

  it('accepts an explicit shell specification', () => {
    const validated = PluginConfig({ shellPath: '/bin/bash', shellArgs: ['-i'], maxSessions: 3 })
    expect(validated.shellPath).toBe('/bin/bash')
    expect(validated.shellArgs).toEqual(['-i'])
    expect(validated.maxSessions).toBe(3)
  })

  it('rejects non-positive bounds instead of letting them disable terminals', () => {
    // maxSessions=0 会让每次 attach 都撞上限，且错误文案与事实不符，在配置层拦下。
    expect(() => PluginConfig({ maxSessions: 0 })).toThrow()
    expect(() => PluginConfig({ maxSessions: -1 })).toThrow()
    expect(() => PluginConfig({ scrollbackMaxBytes: 0 })).toThrow()
    expect(() => PluginConfig({ maxSessionsTotal: 0 })).toThrow()
    expect(() => PluginConfig({ maxSessionsTotal: -3 })).toThrow()
  })
})
