import { describe, expect, it } from 'vitest'
import { planReconcile } from '../src/client/reconcile.ts'
import type { ReconcileInput } from '../src/client/reconcile.ts'

/** 构造一行快照。 */
function row(terminalId: string, scope = 'workspace:w1'): { terminalId: string; scope: string } {
  return { terminalId, scope }
}

/** 以当前工作区为空桶、无挂载终端的默认前提规划一次对账。 */
function plan(input: Partial<ReconcileInput> & { rows: ReconcileInput['rows'] }) {
  return planReconcile({ scope: 'workspace:w1', known: [], mountedKeys: [], ...input })
}

describe('对账判定', () => {
  it('收养本工作区里既没登记也没挂接的会话，并保持快照顺序', () => {
    expect(plan({ rows: [row('term-a'), row('term-b')] })).toEqual({
      adopt: ['term-a', 'term-b'],
      needsFirstTerminal: false,
    })
  })

  it('跳过别的工作区的会话', () => {
    expect(plan({ rows: [row('term-a'), row('term-b', 'workspace:w2'), row('term-c', 'default')] })).toEqual({
      adopt: ['term-a'],
      needsFirstTerminal: false,
    })
  })

  it('跳过已经在标签栏里的会话：挂接记录按 key 命中', () => {
    // 占位标签的 key 是 token，恢复与收养的标签 key 是会话 id，两种都要认。
    expect(plan({ rows: [row('term-a'), row('term-b')], mountedKeys: ['term-a', 'new-3'] })).toEqual({
      adopt: ['term-b'],
      needsFirstTerminal: false,
    })
  })

  it('跳过本地已登记的会话（刚关掉的标签不会被拉回来）', () => {
    expect(plan({ rows: [row('term-a'), row('term-b')], known: ['term-a'] })).toEqual({
      adopt: ['term-b'],
      needsFirstTerminal: false,
    })
  })

  it('同一会话在快照里重复出现也只收养一次', () => {
    expect(plan({ rows: [row('term-a'), row('term-a')] }).adopt).toEqual(['term-a'])
  })

  it('本工作区一个终端都不会有时才回退新建', () => {
    expect(plan({ rows: [] }).needsFirstTerminal).toBe(true)
    // 快照里全是别的工作区的会话：过滤后无标签，同样要新建。
    expect(plan({ rows: [row('term-a', 'workspace:w2')] }).needsFirstTerminal).toBe(true)
  })

  it('已有登记、已收养或已挂载任一成立就不回退新建', () => {
    // 本地已登记（本次没有可收养的）。
    expect(plan({ rows: [], known: ['term-a'] }).needsFirstTerminal).toBe(false)
    // 本地登记已被宿主清掉，但快照里有可收养的。
    expect(plan({ rows: [row('term-a')] }).needsFirstTerminal).toBe(false)
    // 只有占位标签与错误标签（还没拿到会话 id）也算"已有终端"。
    expect(plan({ rows: [], mountedKeys: ['new-1', 'err-0'] }).needsFirstTerminal).toBe(false)
  })
})
