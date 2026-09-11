/**
 * 本插件对宿主槽位与本地化类型表的声明增强。
 *
 * `declare module` 的类型增强只有被纳入编译程序才生效：集中在本模块并由
 * 使用方显式 `import type {}`，这样组件被 IDE 单独打开（未加载插件入口）
 * 时仍能解析出 terminal 命名空间，不会退化成 "不满足约束 never"。
 *
 * @module dsh-remote-terminal/client-contract
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'

/** 本插件本地化命名空间（terminal）的词典键集合。 */
export type TerminalLocaleKey =
  | 'view.terminal'
  | 'status.connecting'
  | 'status.exited'
  | 'status.exitedCode'
  | 'status.close'
  | 'status.new'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** 会话视图栏的视图条目；本插件注册终端视图。 */
    'conversation.view': {
      kind: 'list'
      scope: 'session'
      owner: { children?: never }
    }
  }
  interface SessionStandardProps {
    /** 当前会话 id（由 ui-session 装配）。 */
    sessionId: string
  }
  interface GlobalStandardProps {
    /** 工作区注册表选择 hook（由 ui-workspace 装配）。 */
    useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>
  }
  interface LocaleNamespaceMap {
    terminal: TerminalLocaleKey
  }
}
