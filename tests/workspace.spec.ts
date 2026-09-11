import { describe, expect, it } from 'vitest'
import { workspaceForSession } from '../src/client/workspace.ts'

const items = [
  { workspaceId: 'ws-alpha', path: '/srv/alpha', sessionIds: ['s-1', 's-2'] },
  { workspaceId: 'ws-beta', path: '/srv/beta', sessionIds: ['s-3'] },
]

describe('workspaceForSession', () => {
  it('按账目归属取当前会话的工作区（同时给出分桶用的 workspaceId 与目录）', () => {
    expect(workspaceForSession(items, 's-1')).toEqual(items[0])
    expect(workspaceForSession(items, 's-3')).toEqual(items[1])
  })

  it('多工作区下按会话判定，不退化成长度或下标猜测', () => {
    expect(workspaceForSession(items, 's-2')?.workspaceId).toBe('ws-alpha')
    expect(items.length).toBeGreaterThan(1)
  })

  it('会话未被任何工作区记录时返回 undefined', () => {
    expect(workspaceForSession(items, 's-9')).toBeUndefined()
    expect(workspaceForSession([], 's-1')).toBeUndefined()
  })

  it('工作区行没有会话时不影响其它行的判定', () => {
    const withEmptyRow = [{ workspaceId: 'ws-empty', path: '/srv/empty', sessionIds: [] }, ...items]
    expect(workspaceForSession(withEmptyRow, 's-3')?.path).toBe('/srv/beta')
  })
})
