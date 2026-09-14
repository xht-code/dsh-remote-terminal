/**
 * 终端视图：conversation.view 槽位的「终端」tab 主体。页内以标签栏管理
 * 多个终端会话；「+」新建终端，标签上的 ✕ 销毁会话（宿主导出 PTY）。
 *
 * 视图本身不持有终端：xterm 实例、标签集合与 WebSocket 连接都在按作用域
 * 登记的运行时里（见 runtime 模块），DSH 切换会话视图导致本组件卸载重挂时，
 * 终端只是被摘下再贴回面板，画面与输出都不受影响。
 *
 * 会话集合按**工作区**（作用域）分桶：标签、恢复与配额都只作用于当前工作区，
 * 切到别的工作区看到的是那一组终端（见 sessions 模块与 protocol 的 scope 约定）。
 *
 * @module dsh-remote-terminal/client-view
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only：拉入槽位/本地化类型表增强，单独编译本文件时也能解析 terminal 命名空间。
import type {} from './contract.ts'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { tabLabel } from './labels.ts'
import { DEFAULT_SCOPE, workspaceScope } from '../protocol.ts'
import { workspaceForSession } from './workspace.ts'
import { runtimeFor } from './runtime.ts'
import type { RuntimeState, TabState } from './runtime.ts'

/** 无运行时（作用域尚未确定）时的空状态；引用恒定，不会触发重复渲染。 */
const EMPTY_STATE: RuntimeState = { tabs: [], activeKey: null }

/** 无运行时时的空订阅。 */
const NOOP_UNSUBSCRIBE = (): void => {}

/** 终端 tab 的属性：框架注入的会话 id、工作区选择 hook 与本地化函数。 */
export interface TerminalViewProps {
  sessionId: string
  useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>
  t: TranslateNS<'terminal'>
}

/** 视图根容器：flex 撑满会话 view 区域。 */
const rootStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
  position: 'relative',
}

const tabRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '6px 12px',
  borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
  overflowX: 'auto',
  flex: 'none',
}

/** 标签外壳：承载选中态样式；内部是「切换」与「关闭」两个并列按钮。 */
const tabStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '3px 6px 3px 10px',
  fontSize: 12,
  lineHeight: '18px',
  borderRadius: 6,
  color: 'var(--dsw-alias-label-tertiary)',
  background: 'transparent',
  whiteSpace: 'nowrap',
}

const tabActiveStyle: CSSProperties = {
  ...tabStyle,
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-interactive-bg-hover)',
}

/** 标签切换按钮：无边框，外观完全由外壳承载。 */
const tabLabelStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: 0,
  font: 'inherit',
  color: 'inherit',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
}

const closeButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 16,
  height: 16,
  borderRadius: 4,
  fontSize: 10,
  lineHeight: 1,
  color: 'inherit',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
}

const addButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  borderRadius: 6,
  fontSize: 14,
  lineHeight: 1,
  color: 'var(--dsw-alias-label-tertiary)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
}

/** 终端面板：绝对定位叠放多个 xterm 容器，仅激活标签可见。 */
const panelStyle: CSSProperties = {
  position: 'relative',
  flex: 1,
  minHeight: 0,
}

/**
 * 终端视图组件：标签栏 + 多终端面板。终端的真实状态在按作用域登记的运行时里，
 * 本组件只负责把 holder 贴上/摘下，并把运行时状态渲染成标签栏与状态条。
 *
 * @param props - 框架注入的标准 props（见 {@link TerminalViewProps}）。
 * @returns 视图节点树。
 */
export function TerminalView({ sessionId, useWorkspaces, t }: TerminalViewProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null)

  // 终端按工作区分桶：作用域键取当前会话所属工作区（与侧边栏分组同一判定），
  // 未归属任何工作区的会话共用一个 default 桶。注册表还在 pending 时先不建连接，
  // 否则会把终端记到错误的桶里再搬家；注册表报错则不再等，直接用 default 桶。
  const scope = useWorkspaces((snapshot) => {
    const owner = workspaceForSession(snapshot.items, sessionId)
    if (owner !== undefined) return workspaceScope(owner.workspaceId)
    return snapshot.phase === 'pending' && snapshot.state !== 'error' ? undefined : DEFAULT_SCOPE
  })
  // 新建终端的默认工作目录 = 当前会话所属工作区的宿主路径。
  const workspacePath = useWorkspaces((snapshot) => workspaceForSession(snapshot.items, sessionId)?.path)
  // 工作区注册表异步就绪：新建请求经 ref 读最新值，避免首挂的空快照。
  const workspacePathRef = useRef(workspacePath)
  workspacePathRef.current = workspacePath

  // 作用域未知时没有运行时，视图先空着（「+」也停用）：此刻建会话会记错桶。
  const runtime = useMemo(() => (scope === undefined ? undefined : runtimeFor(scope)), [scope])
  const state = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => (runtime === undefined ? NOOP_UNSUBSCRIBE : runtime.subscribe(onStoreChange)),
      [runtime],
    ),
    useCallback(() => runtime?.getState() ?? EMPTY_STATE, [runtime]),
  )

  useEffect(() => {
    const panel = panelRef.current
    if (runtime === undefined || panel === null) return
    runtime.attachPanel(panel, () => workspacePathRef.current)
    return () => runtime.detachPanel()
  }, [runtime])

  // 面板尺寸变化时对所有已挂载终端重新 fit。
  useEffect(() => {
    const panel = panelRef.current
    if (runtime === undefined || panel === null) return
    const observer = new ResizeObserver(() => runtime.fitAll())
    observer.observe(panel)
    return () => observer.disconnect()
  }, [runtime])

  // 主题切换时同步所有已挂载终端。
  useEffect(() => {
    if (runtime === undefined) return
    const observer = new MutationObserver(() => runtime.syncTheme())
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => observer.disconnect()
  }, [runtime])

  // 激活标签显示之后再 fit：隐藏容器的尺寸解析为 NaN，此刻 fit 才有意义。
  useEffect(() => {
    runtime?.fitActive()
  }, [runtime, state])

  const activeTab = state.tabs.find(tab => tab.key === state.activeKey) ?? state.tabs[0] ?? null

  return (
    <div style={rootStyle}>
      <div style={tabRowStyle}>
        {state.tabs.map(tab => (
          <div
            key={tab.key}
            style={tab.key === activeTab?.key ? tabActiveStyle : tabStyle}
          >
            <button
              type="button"
              style={tabLabelStyle}
              onClick={() => runtime?.activate(tab.key)}
              title={tab.cwd.length > 0 ? tab.cwd : undefined}
              aria-current={tab.key === activeTab?.key}
            >
              <span>{tab.label ?? tabLabel(tab.cwd, t('view.terminal'))}</span>
              {tab.exited && <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>●</span>}
            </button>
            <button
              type="button"
              aria-label={t('status.close')}
              title={t('status.close')}
              style={closeButtonStyle}
              onClick={() => runtime?.closeTab(tab.key)}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          style={runtime === undefined ? { ...addButtonStyle, opacity: 0.5 } : addButtonStyle}
          aria-label={t('status.new')}
          // 作用域未知时不建会话：此刻建出来的终端不知道该归哪个工作区。
          disabled={runtime === undefined}
          onClick={() => runtime?.newTab()}
        >
          +
        </button>
      </div>
      <StatusBar tab={activeTab} t={t} />
      <div style={panelStyle} ref={panelRef}>
        {/* xterm 容器由运行时的 mountTerminal 直接挂到面板；React 不接管其生命周期。 */}
      </div>
    </div>
  )
}

/**
 * 状态条：展示激活标签的工作目录、退出或错误信息。
 */
function StatusBar({ tab, t }: { tab: TabState | null; t: TranslateNS<'terminal'> }): ReactNode {
  let text: string
  let tone: 'muted' | 'error' = 'muted'
  if (tab === null) {
    text = t('status.connecting')
  } else if (tab.error !== null) {
    text = tab.error
    tone = 'error'
  } else if (tab.terminalId === null) {
    text = t('status.connecting')
  } else if (tab.exited) {
    text = tab.exitCode === null ? t('status.exited') : t('status.exitedCode', { code: String(tab.exitCode) })
    tone = 'error'
  } else {
    text = tab.cwd
  }
  return (
    <div className={'dsh-rt-status ' + (tone === 'error' ? 'dsh-rt-status-error' : '')}>
      <span className="dsh-rt-status-dot" />
      <span className="dsh-rt-status-text">{text}</span>
      {tab?.terminalId !== null && tab !== null && <span className="dsh-rt-status-id">{tab.terminalId}</span>}
    </div>
  )
}
