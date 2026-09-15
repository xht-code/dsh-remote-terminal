/**
 * 登录 shell 取不到时的退路：容器里 uid 不在 `/etc/passwd` 时 Node 的
 * `userInfo()` 会直接抛错（实测 uv_os_get_passwd 返回 ENOENT），插件必须退回
 * 平台默认并留下可诊断的告警，而不是让整个装配失败。
 *
 * `userInfo()` 的抛错没法在真实环境里按需制造，这里用模块 mock 造出来；同一个
 * 文件里的 `resolveConfig` 因此走的是"账户查不到"这条分支，与 tests/config.spec.ts
 * 里的正常路径互补。
 *
 * @module dsh-remote-terminal/tests-shell-fallback
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    userInfo: () => {
      throw new Error('A system error occurred: uv_os_get_passwd returned ENOENT')
    },
  }
})

const { resolveConfig } = await import('../src/index.ts')

describe.skipIf(process.platform === 'win32')('账户里查不到登录 shell 时', () => {
  it('退回平台默认，并把原因与退路写进 shellWarning', () => {
    const fallback = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
    const resolved = resolveConfig({})
    expect(resolved.shellPath).toBe(fallback)
    expect(resolved.shellWrap).toBe(fallback === '/bin/zsh' ? 'zsh' : 'bash')
    expect(resolved.shellWarning).toContain('uv_os_get_passwd')
    expect(resolved.shellWarning).toContain(fallback)
  })

  it('用户自己钉了 shellPath 时不告警：账户查不到与他无关', () => {
    const resolved = resolveConfig({ shellPath: '/usr/bin/zsh' })
    expect(resolved.shellPath).toBe('/usr/bin/zsh')
    expect(resolved.shellWarning).toBeUndefined()
  })
})
