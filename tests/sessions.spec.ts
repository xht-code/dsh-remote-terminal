import { describe, expect, it } from 'vitest'
import { forgetSession, parseStoredSessions, rememberSession, sessionsOf } from '../src/client/sessions.ts'

describe('parseStoredSessions', () => {
  it('解析作用域 → 会话 id 列表', () => {
    const raw = JSON.stringify({ 'workspace:a': ['term-1', 'term-2'], default: ['term-9'] })
    expect(parseStoredSessions(raw)).toEqual({ 'workspace:a': ['term-1', 'term-2'], default: ['term-9'] })
  })

  it('形状不符的条目一律丢弃，不猜测', () => {
    const raw = JSON.stringify({
      'workspace:a': ['term-1', 7, '', null],
      'workspace:b': 'term-2',
      'workspace:c': [],
    })
    expect(parseStoredSessions(raw)).toEqual({ 'workspace:a': ['term-1'] })
  })

  it('无法解析或不是对象时视为空', () => {
    expect(parseStoredSessions(null)).toEqual({})
    expect(parseStoredSessions('{')).toEqual({})
    expect(parseStoredSessions(JSON.stringify(['term-1']))).toEqual({})
    expect(parseStoredSessions(JSON.stringify('term-1'))).toEqual({})
  })
})

describe('按工作区分桶的会话集合', () => {
  it('各作用域互不串台', () => {
    rememberSession('ws-a', 'term-1')
    rememberSession('ws-a', 'term-2')
    rememberSession('ws-b', 'term-3')
    expect(sessionsOf('ws-a')).toEqual(['term-1', 'term-2'])
    expect(sessionsOf('ws-b')).toEqual(['term-3'])
    expect(sessionsOf('ws-empty')).toEqual([])
  })

  it('重复登记不产生重复项，销毁只影响本作用域', () => {
    rememberSession('ws-dup', 'term-1')
    rememberSession('ws-dup', 'term-1')
    rememberSession('ws-dup', 'term-2')
    rememberSession('ws-other', 'term-9')
    expect(sessionsOf('ws-dup')).toEqual(['term-1', 'term-2'])
    forgetSession('ws-dup', 'term-1')
    expect(sessionsOf('ws-dup')).toEqual(['term-2'])
    expect(sessionsOf('ws-other')).toEqual(['term-9'])
  })

  it('销毁不存在的会话是安全的空操作', () => {
    forgetSession('ws-dup', 'term-404')
    forgetSession('ws-none', 'term-404')
    expect(sessionsOf('ws-dup')).toEqual(['term-2'])
  })
})
