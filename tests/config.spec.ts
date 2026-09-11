import { describe, expect, it } from 'vitest'
import { Config as PluginConfig, resolveConfig } from '../src/index.ts'

const isWindows = process.platform === 'win32'

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
      expect(resolved.injectBashRc).toBe(false)
    } else {
      expect(resolved.shellPath).toBe('/bin/bash')
      expect(resolved.shellArgs).toEqual(['-i'])
      expect(resolved.injectBashRc).toBe(true)
    }
  })

  it('treats a schemastery-materialized empty shellArgs as unset', () => {
    // schema 会把未配置的数组字段物化为 []，归一化必须与"未提供"等价，
    // 否则真实装配下会静默丢掉默认 shell 参数。
    const materialized = PluginConfig({})
    expect(materialized.shellArgs).toEqual([])
    expect(resolveConfig(materialized)).toEqual(resolveConfig({}))
  })

  it('keeps an explicit shellPath and stops injecting the bash rc wrapper', () => {
    const resolved = resolveConfig({ shellPath: '/usr/bin/zsh' })
    expect(resolved.shellPath).toBe('/usr/bin/zsh')
    expect(resolved.injectBashRc).toBe(false)
  })

  it('keeps explicit shellArgs and stops injecting the bash rc wrapper', () => {
    const resolved = resolveConfig({ shellArgs: ['--norc', '-i'] })
    expect(resolved.shellArgs).toEqual(['--norc', '-i'])
    expect(resolved.injectBashRc).toBe(false)
  })

  it('honours numeric and path overrides', () => {
    const resolved = resolveConfig({ maxSessions: 2, maxSessionsTotal: 5, scrollbackMaxBytes: 1024, wsPath: '/api/custom/ws' })
    expect(resolved.maxSessions).toBe(2)
    expect(resolved.maxSessionsTotal).toBe(5)
    expect(resolved.scrollbackMaxBytes).toBe(1024)
    expect(resolved.wsPath).toBe('/api/custom/ws')
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
