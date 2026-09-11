/**
 * 会话快照的对账决策：视图拿到宿主的会话列表后，该收养哪些、要不要回退新建
 * 首个终端。纯函数，不依赖 React、连接与存储，便于把这张真值表隔离测试。
 *
 * @module dsh-remote-terminal/client-reconcile
 */
import type { SessionSummary } from '../protocol.ts'

/** 一次对账的输入。 */
export interface ReconcileInput {
  /** 宿主快照的全部会话行（未按作用域过滤）。 */
  rows: readonly SessionSummary[]
  /** 当前视图的作用域（工作区）：只有同桶的会话才会被收养。 */
  scope: string
  /** 对账前本地已登记的会话 id（会话桶的内容）。 */
  known: readonly string[]
  /** 已挂载终端的 key：新建标签为 token，恢复与收养的为会话 id。 */
  mountedKeys: readonly string[]
}

/** 一次对账的结论。 */
export interface ReconcilePlan {
  /** 需要补 attach 的会话 id：保持快照顺序且已去重。 */
  adopt: string[]
  /** 本工作区对账后仍一个标签都没有，需要回退新建一个终端。 */
  needsFirstTerminal: boolean
}

/**
 * 规划一次对账。
 *
 * 收养判定只看身份（作用域 + 会话 id）：快照里没有"谁建的"、也没有退出状态这两
 * 维，所以别的浏览器标签页里手工新建的终端同样会被收养（同一个工作区共用一组终端，
 * 关会话是宿主侧的事实，一处关掉处处收起），已经退出的会话也照收养——预览拉起的
 * 服务崩掉时那段输出正是要看的东西。
 *
 * 回退新建只在"对账后本工作区不会有任何标签"时成立：本地已有登记（含本次刚收养
 * 的）、或已挂载了终端（含尚未拿到会话 id 的占位标签与错误标签），都不再新建。
 *
 * @param input - 快照、作用域与本地已知状态。
 * @returns 待收养的会话 id 与是否需要回退新建。
 */
export function planReconcile(input: ReconcileInput): ReconcilePlan {
  const known = new Set(input.known)
  const mounted = new Set(input.mountedKeys)
  const adopt: string[] = []
  for (const row of input.rows) {
    if (row.scope !== input.scope) continue
    if (mounted.has(row.terminalId)) continue
    if (known.has(row.terminalId)) continue
    // 先记账再收集：快照里万一出现重复行，也只 attach 一次。
    known.add(row.terminalId)
    adopt.push(row.terminalId)
  }
  // known 同时覆盖"对账前已登记"与"本次刚收养"，即旧实现里 hadKnown || adopted 的合并判断。
  const hasTerminal = known.size > 0 || mounted.size > 0
  return { adopt, needsFirstTerminal: !hasTerminal }
}
