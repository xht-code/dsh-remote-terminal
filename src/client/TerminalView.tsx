/**
 * 终端视图：conversation.view 槽位的「终端」tab 主体。页内以标签栏管理
 * 多个终端会话，每个标签对应一个宿主 PTY 会话与独立 xterm 实例；
 * 「+」新建终端，标签上的 ✕ 销毁会话（宿主导出 PTY）。视图卸载时断开
 * 连接但保留宿主会话，重新挂载时按已知会话集合重新 attach 恢复全部标签。
 *
 * 会话集合按**工作区**（作用域）分桶：标签、恢复与配额都只作用于当前工作区，
 * 切到别的工作区看到的是那一组终端（见 sessions 模块与 protocol 的 scope 约定）。
 *
 * @module dsh-remote-terminal/client-view
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TranslateNS, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only：拉入槽位/本地化类型表增强，单独编译本文件时也能解析 terminal 命名空间。
import type {} from './contract.ts'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { connectTerminal } from './connection.ts'
import type { TerminalConnection } from './connection.ts'
import { currentTheme, readCodeFontFamily } from './theme.ts'
import { parseOsc7Cwd, tabLabel } from './labels.ts'
import { DEFAULT_SCOPE, workspaceScope } from '../protocol.ts'
import { workspaceForSession } from './workspace.ts'
import { forgetSession, rememberSession, sessionsOf } from './sessions.ts'

/** 单个终端标签的展示状态。 */
interface TabState {
  /** 标签稳定标识：新建标签为 token，恢复的会话为会话 id；挂载与切换都按它索引。 */
  key: string
  /** 宿主会话 id；attach 应答到达前为空。 */
  terminalId: string | null
  cwd: string
  exited: boolean
  exitCode: number | null
  error: string | null
}

/** 已挂载的 xterm 实例及其 DOM 宿主。 */
interface MountedTerminal {
  terminal: Terminal
  fit: FitAddon
  holder: HTMLDivElement
  /** 宿主会话 id；新建标签先挂载、应答到达后补齐，输入/resize 事件据此上行。 */
  terminalId: string | null
  /** xterm 事件/解析器注册句柄；销毁实例前显式释放。 */
  disposables: { dispose(): void }[]
}

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
 * 终端视图组件：标签栏 + 多终端面板。
 *
 * @param props - 框架注入的标准 props（见 {@link TerminalViewProps}）。
 * @returns 视图节点树。
 */
export function TerminalView({ sessionId, useWorkspaces, t }: TerminalViewProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(new Map<string, MountedTerminal>())
  const connectionRef = useRef<TerminalConnection | null>(null)
  const nextTokenRef = useRef(1)
  const nextErrorKeyRef = useRef(1)
  // 恢复的会话全部失效后是否已回退新建（只允许一次，避免错误风暴下连环开新会话）。
  const fallbackRef = useRef(false)
  const [tabs, setTabs] = useState<TabState[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [fontFamily] = useState(readCodeFontFamily)

  // 订阅回调只挂载一次，运行时状态经 ref 读取；终端的存在与否一律以挂载记录
  // （mountedRef）为准——它同步更新，而 tabs 要等 React 提交渲染。
  const activeKeyRef = useRef(activeKey)
  activeKeyRef.current = activeKey
  /** 当前连接对应的作用域；为 null 表示还没连过，用于识别作用域切换。 */
  const scopeRef = useRef<string | null>(null)

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
  // 工作区注册表异步就绪：订阅回调与新建请求经 ref 读最新值，避免首挂空快照。
  const workspacePathRef = useRef(workspacePath)
  workspacePathRef.current = workspacePath

  useEffect(() => {
    // 作用域未知（工作区注册表还在 pending）时先不连接：此时建会话会记错桶。
    if (scope === undefined) return
    const panel = panelRef.current
    if (panel === null) return

    // 会话被移到别的工作区：当前挂着的终端不属于新作用域，整体切到新作用域的集合。
    if (scopeRef.current !== null && scopeRef.current !== scope) {
      setTabs([])
      setActiveKey(null)
      // 失效回退"只允许一次"是上一次连接的约束，跟着作用域一起重置。
      fallbackRef.current = false
    }
    scopeRef.current = scope

    const connection = connectTerminal()
    connectionRef.current = connection

    const unsubscribe = connection.subscribe((message) => {
      switch (message.type) {
        case 'attached': {
          // 登记到当前工作区的桶里：刷新与重连时按桶恢复。
          rememberSession(scope, message.terminalId)
          // 带 token：新建的会话落地到对应占位标签（xterm 在发 attach 前就已挂好）。
          if (message.token !== undefined) {
            const token = message.token
            const mounted = mountedRef.current.get(token)
            if (mounted === undefined) {
              // 占位标签已被用户关闭：会话已建成，直接销毁以免残留。
              connection.send({ type: 'close', terminalId: message.terminalId })
              break
            }
            mounted.terminalId = message.terminalId
            // 占位标签可能还没渲染出来（attach 在下一帧就发出，React 提交不保证更早），
            // 因此按 key 补齐而不是只做 map。
            setTabs(prev => prev.some(tab => tab.key === token)
              ? prev.map(tab => tab.key === token
                ? { ...tab, terminalId: message.terminalId, cwd: message.cwd, exited: message.exited, exitCode: message.exitCode }
                : tab)
              : [...prev, { key: token, terminalId: message.terminalId, cwd: message.cwd, exited: message.exited, exitCode: message.exitCode, error: null }])
            break
          }
          // 无 token：恢复的既有会话（重连/重挂载），补建缺失标签。
          const mounted = mountedRef.current.get(message.terminalId)
          if (mounted !== undefined) {
            // 断线重连（视图未卸载）：宿主接下来会把重放缓冲再发一遍。先清空既有
            // 画面，否则历史会被追加在旧内容之后，屏幕上出现两份。
            mounted.terminal.reset()
            // 断线期间的窗口缩放产生过一条 resize，它在 attach 之前被宿主丢弃
            //（那时还没挂接），这里按当前尺寸补报一次。
            connection.send({
              type: 'resize',
              terminalId: message.terminalId,
              cols: mounted.terminal.cols,
              rows: mounted.terminal.rows,
            })
            break
          }
          setActiveKey(current => current ?? message.terminalId)
          mountTerminal(connection, message.terminalId, message.terminalId)
          setTabs(prev => prev.some(tab => tab.key === message.terminalId)
            ? prev
            : [...prev, { key: message.terminalId, terminalId: message.terminalId, cwd: message.cwd, exited: message.exited, exitCode: message.exitCode, error: null }])
          break
        }
        case 'output': {
          const key = keyForTerminal(message.terminalId)
          if (key !== undefined) mountedRef.current.get(key)?.terminal.write(message.data)
          break
        }
        case 'exit': {
          setTabs(prev => prev.map(tab =>
            tab.terminalId === message.terminalId ? { ...tab, exited: true, exitCode: message.exitCode } : tab,
          ))
          break
        }
        case 'closed': {
          forgetSession(scope, message.terminalId)
          const key = keyForTerminal(message.terminalId)
          if (key !== undefined) removeTab(key)
          break
        }
        case 'error': {
          // attach 失败（如数量上限）：错误归属到对应占位标签并落地为错误态。
          // 判定同样只看挂载记录：标签可能还没渲染出来。
          if (message.token !== undefined && mountedRef.current.has(message.token)) {
            markTabError(message.token, message.message)
            break
          }
          // 恢复的已知会话已失效（如宿主重启）：从当前工作区的桶里剔除，
          // 避免每次重连重试；既有标签要亮明原因（否则会停在"连接中"），
          // 若当前一个终端都没有则回退新建一个，避免整个视图无声卡住。
          if (message.terminalId !== undefined) {
            forgetSession(scope, message.terminalId)
            const failedKey = keyForTerminal(message.terminalId)
            if (failedKey !== undefined) markTabError(failedKey, message.message)
            if (mountedRef.current.size === 0 && !fallbackRef.current) {
              fallbackRef.current = true
              addTab(scope)
            }
            break
          }
          if (mountedRef.current.size === 0) {
            // 首次自动 attach 被拒（如工作目录不可用）：连终端实例都没有，
            // 建一个错误占位标签亮明原因。
            const key = 'err-' + nextErrorKeyRef.current++
            setTabs(prev => prev.length === 0
              ? [{ key, terminalId: null, cwd: '', exited: false, exitCode: null, error: message.message }]
              : prev)
            setActiveKey(current => current ?? key)
            break
          }
          // 无归属错误显示到激活终端（激活项已不在时取第一个挂载的终端）。
          const activeKey = activeKeyRef.current !== null && mountedRef.current.has(activeKeyRef.current)
            ? activeKeyRef.current
            : mountedRef.current.keys().next().value
          if (activeKey === undefined) break
          markTabError(activeKey, message.message)
          break
        }
      }
    })

    // 建会话的时机由视图决定：会话必须按终端实际尺寸创建，而尺寸要等 xterm 挂载
    // 后才能测到，所以连接就绪只负责恢复当前工作区已知的会话，首个终端走 addTab。
    const unobserve = connection.onOpen(() => {
      const known = sessionsOf(scope)
      if (known.length === 0) {
        if (mountedRef.current.size === 0) addTab(scope)
        return
      }
      for (const sessionId of known) connection.send({ type: 'attach', terminalId: sessionId })
    })
    connection.start()
    return () => {
      unobserve()
      unsubscribe()
      connection.close()
      for (const { terminal, holder, disposables } of mountedRef.current.values()) {
        for (const disposable of disposables) disposable.dispose()
        terminal.dispose()
        holder.remove()
      }
      mountedRef.current.clear()
      connectionRef.current = null
    }
    // 连接与订阅跟随作用域（工作区）重建；fontFamily 以首挂快照为准。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  /**
   * 按宿主会话 id 反查标签 key（消息分发用；标签已移除时返回 undefined）。
   * 扫描挂载记录而不是渲染态 tabs：宿主会把 attached 与首批输出连着发来，
   * 中间不保证夹着一次 React 渲染。
   */
  const keyForTerminal = (terminalId: string): string | undefined => {
    for (const [key, mounted] of mountedRef.current) {
      if (mounted.terminalId === terminalId) return key
    }
    return undefined
  }

  /**
   * 把错误落到指定标签上；标签还没渲染出来时按挂载记录补齐，避免错误无处显示
   * 而标签停在"连接中"。
   *
   * @param key - 标签稳定标识。
   * @param error - 要展示的错误文案。
   */
  const markTabError = (key: string, error: string): void => {
    const terminalId = mountedRef.current.get(key)?.terminalId ?? null
    setTabs(prev => prev.some(tab => tab.key === key)
      ? prev.map(tab => tab.key === key ? { ...tab, error } : tab)
      : [...prev, { key, terminalId, cwd: '', exited: false, exitCode: null, error }])
  }

  /**
   * 挂载一个新的 xterm 实例到面板，并接线输入/resize 上行。
   *
   * @param connection - 当前连接句柄。
   * @param key - 标签稳定标识。
   * @param terminalId - 已知的宿主会话 id；新建标签先挂载、应答后再补。
   */
  const mountTerminal = (connection: TerminalConnection, key: string, terminalId: string | null = null): void => {
    const panel = panelRef.current
    if (panel === null || mountedRef.current.has(key)) return
    const holder = document.createElement('div')
    holder.className = 'dsh-rt-term'
    holder.style.cssText = 'position:absolute;inset:0;padding:0 12px 12px;'
    panel.appendChild(holder)
    const terminal = new Terminal({
      fontFamily,
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'block',
      macOptionIsMeta: true,
      scrollback: 10000,
      theme: currentTheme(),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(holder)
    const mounted: MountedTerminal = { terminal, fit, holder, terminalId, disposables: [] }
    // 默认 bash 经 --rcfile 注入的钩子会在每个提示符前输出 OSC 7 上报 cwd，
    // 解析后实时刷新标签与状态条（自定义 shell 无此序列则保持 attach 时的值）。
    mounted.disposables.push(terminal.parser.registerOscHandler(7, (osc) => {
      const cwd = parseOsc7Cwd(osc)
      if (cwd !== undefined) {
        setTabs(prev => prev.map(tab => tab.key === key ? { ...tab, cwd } : tab))
      }
      return true
    }))
    // 会话 id 在应答到达后才补齐：事件回调按挂载记录的当前值上行。
    mounted.disposables.push(terminal.onData((data) => {
      if (mounted.terminalId !== null) connection.send({ type: 'input', terminalId: mounted.terminalId, data })
    }))
    mounted.disposables.push(terminal.onResize(({ cols, rows }) => {
      if (mounted.terminalId !== null) connection.send({ type: 'resize', terminalId: mounted.terminalId, cols, rows })
    }))
    mountedRef.current.set(key, mounted)
    // 容器刚插入面板时尺寸可能尚未稳定，下一帧再 fit 一次。
    window.requestAnimationFrame(() => {
      if (mountedRef.current.get(key) === mounted) mounted.fit.fit()
    })
  }

  /** 移除标签：销毁 xterm 实例并从列表删除；主动关闭时由调用方先发 close。 */
  const removeTab = (key: string): void => {
    const mounted = mountedRef.current.get(key)
    if (mounted !== undefined) {
      for (const disposable of mounted.disposables) disposable.dispose()
      mounted.terminal.dispose()
      mounted.holder.remove()
      mountedRef.current.delete(key)
    }
    setTabs(prev => prev.filter(tab => tab.key !== key))
    setActiveKey(current => {
      if (current !== key) return current
      // 下一个激活项同样取挂载记录：它同步反映"还有哪些终端"，不依赖本次渲染。
      return mountedRef.current.keys().next().value ?? null
    })
  }

  /**
   * 新建终端：先挂标签并挂载 xterm，下一帧尺寸稳定后再按该尺寸建会话。
   * 若先按默认 80×24 建会话，窄屏上 shell 会先按 80 列打印提示符、再被
   * resize 触发 readline 重绘，屏幕上就留下两条提示符。
   *
   * @param scope - 新会话所属作用域（工作区）：宿主按它分别计算配额。
   */
  const addTab = (scope: string): void => {
    const connection = connectionRef.current
    if (connection === null) return
    const token = 'new-' + nextTokenRef.current++
    setTabs(prev => [...prev, { key: token, terminalId: null, cwd: '', exited: false, exitCode: null, error: null }])
    setActiveKey(token)
    mountTerminal(connection, token)
    window.requestAnimationFrame(() => {
      const mounted = mountedRef.current.get(token)
      // 挂载记录才是"标签还在"的同步事实：tabs 要等 React 提交渲染才更新，而
      // 这一帧往往早于那次提交（关标签同理，removeTab 会同步删掉记录）。
      if (mounted === undefined) return
      connection.send({
        type: 'attach',
        cwd: workspacePathRef.current,
        cols: mounted.terminal.cols,
        rows: mounted.terminal.rows,
        scope,
        token,
      })
    })
  }

  /** 主动关闭标签：向宿主请求销毁会话后本地移除。 */
  const closeTab = (tab: TabState): void => {
    if (tab.terminalId !== null) connectionRef.current?.send({ type: 'close', terminalId: tab.terminalId })
    removeTab(tab.key)
  }

  // 面板尺寸变化时对所有已挂载终端重新 fit。
  useEffect(() => {
    const panel = panelRef.current
    if (panel === null) return
    const observer = new ResizeObserver(() => {
      for (const { fit } of mountedRef.current.values()) fit.fit()
    })
    observer.observe(panel)
    return () => observer.disconnect()
  }, [])

  // 主题切换时同步所有已挂载终端。
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const theme = currentTheme()
      for (const { terminal } of mountedRef.current.values()) terminal.options.theme = theme
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => observer.disconnect()
  }, [])

  // 仅激活标签的容器可见。隐藏容器的尺寸解析为 NaN，FitAddon 会静默跳过，
  // 因此窗口在标签隐藏期间缩放后该标签会滞留旧尺寸；切回时必须在显示之后
  // 补一次 fit，顺带把新尺寸同步给对应 PTY。
  useEffect(() => {
    for (const [key, mounted] of mountedRef.current) {
      mounted.holder.style.display = key === activeKey ? '' : 'none'
    }
    if (activeKey === null) return
    const mounted = mountedRef.current.get(activeKey)
    if (mounted === undefined) return
    const frame = window.requestAnimationFrame(() => {
      // 落帧时可能已再次切换或卸载，确认仍是同一激活项再 fit。
      if (mountedRef.current.get(activeKey) === mounted) mounted.fit.fit()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [tabs, activeKey])

  const activeTab = tabs.find(tab => tab.key === activeKey) ?? tabs[0] ?? null

  return (
    <div style={rootStyle}>
      <div style={tabRowStyle}>
        {tabs.map(tab => (
          <div
            key={tab.key}
            style={tab.key === activeTab?.key ? tabActiveStyle : tabStyle}
          >
            <button
              type="button"
              style={tabLabelStyle}
              onClick={() => setActiveKey(tab.key)}
              title={tab.cwd.length > 0 ? tab.cwd : undefined}
              aria-current={tab.key === activeTab?.key}
            >
              <span>{tab.terminalId === null ? t('view.terminal') : tabLabel(tab.cwd, t('view.terminal'))}</span>
              {tab.exited && <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>●</span>}
            </button>
            <button
              type="button"
              aria-label={t('status.close')}
              title={t('status.close')}
              style={closeButtonStyle}
              onClick={() => closeTab(tab)}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          style={scope === undefined ? { ...addButtonStyle, opacity: 0.5 } : addButtonStyle}
          aria-label={t('status.new')}
          // 作用域未知时不建会话：此刻建出来的终端不知道该归哪个工作区。
          disabled={scope === undefined}
          onClick={() => { if (scope !== undefined) addTab(scope) }}
        >
          +
        </button>
      </div>
      <StatusBar tab={activeTab} t={t} />
      <div style={panelStyle} ref={panelRef}>
        {/* xterm 容器由 mountTerminal 直接挂到面板；React 不接管其生命周期。 */}
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
