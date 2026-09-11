import { describe, expect, it } from 'vitest'
import { DEFAULT_SCOPE, MAX_INPUT_CHUNK_CHARS, parseClientMessage, parseServerMessage, splitInputChunks, workspaceScope } from '../src/protocol.ts'

describe('parseClientMessage', () => {
  it('parses a minimal attach without any optional field', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'attach' }))).toEqual({ type: 'attach' })
  })

  it('parses attach with every optional field', () => {
    const raw = JSON.stringify({
      type: 'attach', terminalId: 'term-1', cwd: '/srv/app', cols: 120, rows: 40, scope: 'workspace:a', token: 'new-7',
    })
    expect(parseClientMessage(raw)).toEqual({
      type: 'attach', terminalId: 'term-1', cwd: '/srv/app', cols: 120, rows: 40, scope: 'workspace:a', token: 'new-7',
    })
  })

  it('parses input, resize and close', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'input', terminalId: 'term-1', data: 'ls\n' })))
      .toEqual({ type: 'input', terminalId: 'term-1', data: 'ls\n' })
    expect(parseClientMessage(JSON.stringify({ type: 'resize', terminalId: 'term-1', cols: 100, rows: 30 })))
      .toEqual({ type: 'resize', terminalId: 'term-1', cols: 100, rows: 30 })
    expect(parseClientMessage(JSON.stringify({ type: 'close', terminalId: 'term-1' })))
      .toEqual({ type: 'close', terminalId: 'term-1' })
  })

  it('drops unknown fields instead of passing them through', () => {
    const raw = JSON.stringify({ type: 'input', terminalId: 'term-1', data: 'ls\n', inject: 'rm -rf /' })
    expect(parseClientMessage(raw)).toEqual({ type: 'input', terminalId: 'term-1', data: 'ls\n' })
  })

  it('rejects malformed envelopes', () => {
    expect(parseClientMessage('not json')).toBeUndefined()
    expect(parseClientMessage(JSON.stringify(null))).toBeUndefined()
    expect(parseClientMessage(JSON.stringify(['attach']))).toBeUndefined()
    expect(parseClientMessage(JSON.stringify({}))).toBeUndefined()
    expect(parseClientMessage(JSON.stringify({ type: 'unknown' }))).toBeUndefined()
    expect(parseClientMessage(42)).toBeUndefined()
  })

  it('rejects wrong field types', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'attach', cols: '80' }))).toBeUndefined()
    expect(parseClientMessage(JSON.stringify({ type: 'attach', rows: null }))).toBeUndefined()
    expect(parseClientMessage(JSON.stringify({ type: 'attach', terminalId: 7 }))).toBeUndefined()
    expect(parseClientMessage(JSON.stringify({ type: 'attach', token: 7 }))).toBeUndefined()
    expect(parseClientMessage(JSON.stringify({ type: 'attach', scope: 7 }))).toBeUndefined()
    expect(parseClientMessage(JSON.stringify({ type: 'input', terminalId: 'term-1' }))).toBeUndefined()
    expect(parseClientMessage(JSON.stringify({ type: 'input', terminalId: 'term-1', data: 1 }))).toBeUndefined()
    expect(parseClientMessage(JSON.stringify({ type: 'resize', terminalId: 'term-1', cols: 100 }))).toBeUndefined()
    expect(parseClientMessage(JSON.stringify({ type: 'resize', terminalId: 'term-1', rows: 30 }))).toBeUndefined()
    expect(parseClientMessage(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))).toBeUndefined()
    expect(parseClientMessage(JSON.stringify({ type: 'close' }))).toBeUndefined()
  })
})

describe('parseServerMessage', () => {
  it('parses attached with and without the correlation token', () => {
    const base = { type: 'attached', terminalId: 'term-1', cwd: '/srv/app', exited: false, exitCode: null }
    expect(parseServerMessage(JSON.stringify(base))).toEqual(base)
    expect(parseServerMessage(JSON.stringify({ ...base, token: 'new-7' })))
      .toEqual({ ...base, token: 'new-7' })
  })

  it('carries the creator label of a session when there is one', () => {
    const base = { type: 'attached', terminalId: 'term-1', cwd: '/srv/app', exited: false, exitCode: null }
    expect(parseServerMessage(JSON.stringify({ ...base, label: '预览 p4271' })))
      .toEqual({ ...base, label: '预览 p4271' })
    expect(parseServerMessage(JSON.stringify({ ...base, label: 7 }))).toBeUndefined()
  })

  it('accepts both null and numeric exit codes', () => {
    const base = { type: 'attached', terminalId: 'term-1', cwd: '/srv/app', exited: true }
    expect(parseServerMessage(JSON.stringify({ ...base, exitCode: null })))
      .toEqual({ ...base, exitCode: null })
    expect(parseServerMessage(JSON.stringify({ ...base, exitCode: 0 })))
      .toEqual({ ...base, exitCode: 0 })
  })

  it('parses output, exit, closed and error', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'output', terminalId: 'term-1', data: 'hi' })))
      .toEqual({ type: 'output', terminalId: 'term-1', data: 'hi' })
    expect(parseServerMessage(JSON.stringify({ type: 'exit', terminalId: 'term-1', exitCode: null })))
      .toEqual({ type: 'exit', terminalId: 'term-1', exitCode: null })
    expect(parseServerMessage(JSON.stringify({ type: 'closed', terminalId: 'term-1' })))
      .toEqual({ type: 'closed', terminalId: 'term-1' })
    expect(parseServerMessage(JSON.stringify({ type: 'error', message: 'boom' })))
      .toEqual({ type: 'error', message: 'boom' })
    expect(parseServerMessage(JSON.stringify({ type: 'error', message: 'gone', terminalId: 'term-9', token: 'new-7' })))
      .toEqual({ type: 'error', message: 'gone', terminalId: 'term-9', token: 'new-7' })
  })

  it('drops unknown fields instead of passing them through', () => {
    const raw = JSON.stringify({ type: 'output', terminalId: 'term-1', data: 'hi', extra: true })
    expect(parseServerMessage(raw)).toEqual({ type: 'output', terminalId: 'term-1', data: 'hi' })
  })

  it('rejects malformed envelopes and wrong field types', () => {
    expect(parseServerMessage('not json')).toBeUndefined()
    expect(parseServerMessage(JSON.stringify({}))).toBeUndefined()
    expect(parseServerMessage(JSON.stringify({ type: 'unknown' }))).toBeUndefined()
    expect(parseServerMessage(null)).toBeUndefined()
    expect(parseServerMessage(JSON.stringify({ type: 'attached', terminalId: 'term-1', cwd: '/srv', exited: 'no', exitCode: null }))).toBeUndefined()
    expect(parseServerMessage(JSON.stringify({ type: 'attached', terminalId: 'term-1', cwd: '/srv', exited: true, exitCode: '0' }))).toBeUndefined()
    expect(parseServerMessage(JSON.stringify({ type: 'output', terminalId: 'term-1' }))).toBeUndefined()
    expect(parseServerMessage(JSON.stringify({ type: 'exit', terminalId: 'term-1' }))).toBeUndefined()
    expect(parseServerMessage(JSON.stringify({ type: 'closed' }))).toBeUndefined()
    expect(parseServerMessage(JSON.stringify({ type: 'error' }))).toBeUndefined()
    expect(parseServerMessage(JSON.stringify({ type: 'error', message: 'x', token: 7 }))).toBeUndefined()
    expect(parseServerMessage(JSON.stringify({ type: 'error', message: 'x', terminalId: 7 }))).toBeUndefined()
  })
})

describe('splitInputChunks', () => {
  it('keeps short input as a single chunk without copying', () => {
    const data = 'ls -la\n'
    expect(splitInputChunks(data)).toEqual([data])
  })

  it('splits an oversized paste into ordered chunks of the size limit', () => {
    const data = 'x'.repeat(MAX_INPUT_CHUNK_CHARS * 2 + 5)
    const chunks = splitInputChunks(data)
    expect(chunks).toHaveLength(3)
    expect(chunks.map(chunk => chunk.length)).toEqual([MAX_INPUT_CHUNK_CHARS, MAX_INPUT_CHUNK_CHARS, 5])
    expect(chunks.join('')).toBe(data)
  })

  it('never cuts a surrogate pair in half', () => {
    // 让分片边界正好落在 emoji 的代理对之间：放大到边界后再验证还原。
    const prefix = 'x'.repeat(MAX_INPUT_CHUNK_CHARS - 1)
    const data = prefix + '🙂'.repeat(3)
    const chunks = splitInputChunks(data)
    expect(chunks.join('')).toBe(data)
    for (const chunk of chunks) {
      const first = chunk.charCodeAt(0)
      const last = chunk.charCodeAt(chunk.length - 1)
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }
  })

  it('treats input of exactly the limit as one chunk', () => {
    expect(splitInputChunks('y'.repeat(MAX_INPUT_CHUNK_CHARS))).toHaveLength(1)
  })
})

describe('作用域键', () => {
  it('默认桶与工作区桶的构造两端共用同一套键', () => {
    expect(DEFAULT_SCOPE).toBe('default')
    expect(workspaceScope('be8cb357-54ea-42b5-b396-2c714cc7bf30')).toBe('workspace:be8cb357-54ea-42b5-b396-2c714cc7bf30')
    expect(workspaceScope('default')).not.toBe(DEFAULT_SCOPE)
  })
})
