/**
 * dsh-remote-terminal 客户端半体：在会话视图栏注册「终端」tab（紧邻轨迹），
 * 主体是 xterm 终端视图。宿主模块表直接应答 react 与平台槽位包，xterm 及
 * 其 addon 随本 bundle 打包，样式以注入 <style> 的方式下发。
 *
 * @module dsh-remote-terminal/client
 */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only：拉入槽位/本地化类型表增强（see contract.ts）。
import type { TerminalLocaleKey } from './contract.ts'
import { TerminalView } from './TerminalView.tsx'

/** 本插件的本地化命名空间。 */
const NS = 'terminal'

/** 简化中文词典（键集源头）。 */
const zh: Record<TerminalLocaleKey, string> = {
  'view.terminal': '终端',
  'status.connecting': '连接中…',
  'status.exited': 'shell 已退出',
  'status.exitedCode': 'shell 已退出（退出码 {code}）',
  'status.close': '关闭终端',
  'status.new': '新建终端',
}

/** 英文词典（键集合与中文一致，缺键由类型检查拦下）。 */
const en: Record<TerminalLocaleKey, string> = {
  'view.terminal': 'Terminal',
  'status.connecting': 'Connecting…',
  'status.exited': 'shell exited',
  'status.exitedCode': 'shell exited (code {code})',
  'status.close': 'Close terminal',
  'status.new': 'New terminal',
}

/** 宿主 SlotRegistry 的窄面：本插件只用 inject/register 两个入口。 */
interface SlotRegistry {
  inject(name: string, callback: () => () => void): () => void
  register(options: unknown, component: unknown): () => void
}

/** 客户端上下文：本插件只消费槽位、本地化服务与 fiber 生命周期。 */
interface ClientContext {
  slots: SlotRegistry
  locale: {
    register(ns: string, dict: Record<string, Record<string, string>>): () => void
    bind(ns: string): Translate
  }
  /** 在当前 fiber 上登记清理回调（cordis 的 effect 窄面）。 */
  effect(disposer: () => (() => void) | void, label?: string): void
}

/** 声明客户端所需的槽位与本地化服务。 */
export const inject = ['slots', 'locale'] as const

/** 终端视图自身的布局样式（xterm 官方 CSS 随 bundle 注入）。 */
const VIEW_CSS = [
  // 容器尺寸由 mountTerminal 落成内联样式（随视图保活，不经过 React 渲染）。
  '.dsh-rt-term .xterm {',
  '  height: 100%;',
  '}',
  '.dsh-rt-status {',
  '  display: flex;',
  '  align-items: center;',
  '  gap: 8px;',
  '  padding: 6px 12px;',
  '  font-size: 12px;',
  '  line-height: 18px;',
  '  color: var(--dsw-alias-label-tertiary);',
  '  border-bottom: 0.5px solid var(--dsw-alias-border-l3);',
  '}',
  '.dsh-rt-status-error {',
  '  color: var(--dsw-alias-state-error-primary);',
  '}',
  '.dsh-rt-status-dot {',
  '  width: 6px;',
  '  height: 6px;',
  '  border-radius: 50%;',
  '  background: var(--dsw-alias-state-success-primary);',
  '  flex: none;',
  '}',
  '.dsh-rt-status-error .dsh-rt-status-dot {',
  '  background: var(--dsw-alias-state-error-primary);',
  '}',
  '.dsh-rt-status-text {',
  '  flex: 1;',
  '  min-width: 0;',
  '  overflow: hidden;',
  '  text-overflow: ellipsis;',
  '  white-space: nowrap;',
  '}',
  '.dsh-rt-status-id {',
  '  font-family: var(--ds-font-family-code);',
  '  flex: none;',
  '}',
].join('\n')

const XTERM_STYLE_TAG = 'dsh-remote-terminal/xterm'

// 样式注入必须脱离 React 渲染树（模块级副作用）：若以组件节点渲染，每次
// 渲染的 DOM 幂等检查会让 React 把该节点当作"不再渲染"而卸载/重挂。
declare const __XTERM_CSS__: string
if (
  typeof document !== 'undefined'
  && document.querySelector('style[data-plugin-css="' + XTERM_STYLE_TAG + '"]') === null
) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-remote-terminal'
  tag.dataset.pluginCss = XTERM_STYLE_TAG
  tag.textContent = __XTERM_CSS__ + VIEW_CSS
  document.head.appendChild(tag)
}

/**
 * 注册终端视图 tab。
 *
 * @param ctx - 提供槽位与本地化服务的客户端上下文。
 */
export function apply(ctx: ClientContext): void {
  // register 返回的 disposer 必须交还 fiber：locale 运行时对同一 (ns, locale)
  // 重复注册直接抛错，热重载会先卸载旧 fiber 再 apply——丢掉 disposer 会让
  // 第二次注册失败，终端 tab 消失且只能靠整页刷新恢复。
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-remote-terminal: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject(
    'conversation.view',
    () => ctx.slots.register({
      name: 'conversation.view',
      id: 'terminal',
      // 紧邻轨迹（order 10）之后的视图槽位。
      order: 11,
      locale: NS,
      label: () => t('view.terminal'),
    }, TerminalView),
  )
}
