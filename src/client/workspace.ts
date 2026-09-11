/**
 * 会话 → 工作区的纯函数：判定口径与 ui-workspace 的分组一致（工作区行账目上
 * 的 sessionIds 归属），不依赖 React、DOM 与连接状态，便于隔离测试。
 *
 * @module dsh-remote-terminal/client-workspace
 */

/** 判定归属所需的工作区行窄面。 */
export interface WorkspaceMembershipView {
  /** 工作区标识：终端会话集合按它分桶。 */
  readonly workspaceId: string
  /** 工作区的宿主目录路径。 */
  readonly path: string
  /** 账目上归属该工作区的会话 id。 */
  readonly sessionIds: readonly string[]
}

/**
 * 取账目上归属该会话的工作区。
 *
 * @param items - 工作区注册表快照的工作区行。
 * @param sessionId - 当前会话 id。
 * @returns 归属的工作区行；会话未被任何工作区记录时为 undefined。
 */
export function workspaceForSession(
  items: readonly WorkspaceMembershipView[],
  sessionId: string,
): WorkspaceMembershipView | undefined {
  return items.find(item => item.sessionIds.some(id => id === sessionId))
}
