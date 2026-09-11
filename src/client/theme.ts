/**
 * xterm 主题：跟随宿主的明暗标记（body 的 data-ds-dark-theme 属性）切换
 * 两套色板；字体从宿主的 --ds-font-family-code 变量解析实际字体族。
 *
 * @module dsh-remote-terminal/client-theme
 */
import type { ITheme } from '@xterm/xterm'

/** 亮色终端色板（ANSI 16 色，取自标准 xterm 色系）。 */
const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#1f2328',
  cursorAccent: '#ffffff',
  selectionBackground: '#b6d7ff',
  black: '#000000',
  red: '#c62828',
  green: '#1b5e20',
  yellow: '#9e7d00',
  blue: '#1565c0',
  magenta: '#6a1b9a',
  cyan: '#00695c',
  white: '#424242',
  brightBlack: '#6e6e6e',
  brightRed: '#e53935',
  brightGreen: '#2e7d32',
  brightYellow: '#b8860b',
  brightBlue: '#1e88e5',
  brightMagenta: '#8e24aa',
  brightCyan: '#00897b',
  brightWhite: '#9e9e9e',
}

/** 暗色终端色板（与宿主的暗色底 --dsh-boot-bg: #151517 呼应）。 */
const DARK_THEME: ITheme = {
  background: '#151517',
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  cursorAccent: '#151517',
  selectionBackground: '#3a3d42',
  black: '#1f2430',
  red: '#ff5f56',
  green: '#2fb457',
  yellow: '#e6c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#abb2bf',
  brightBlack: '#5c6370',
  brightRed: '#ff7b72',
  brightGreen: '#7ee787',
  brightYellow: '#f2cc60',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#a5d6ff',
  brightWhite: '#f0f0f0',
}

/** 宿主暗色标记属性名（ui-layout 的 ThemePresenter 负责维护）。 */
const DARK_ATTR = 'data-ds-dark-theme'

/** 当前是否处于暗色主题。 */
function isDarkTheme(): boolean {
  return document.body.hasAttribute(DARK_ATTR)
}

/** 当前应使用的 xterm 色板。 */
export function currentTheme(): ITheme {
  return isDarkTheme() ? DARK_THEME : LIGHT_THEME
}

/**
 * 解析宿主代码字体为可用的字体族字符串。CSS 变量可能带 fallback 链，
 * 直接读变量文本不可靠，因此用探针元素让浏览器解析后再取计算值。
 *
 * @returns 计算后的字体族；解析失败时回退等宽字体。
 */
export function readCodeFontFamily(): string {
  const probe = document.createElement('span')
  probe.style.position = 'fixed'
  probe.style.visibility = 'hidden'
  probe.style.fontFamily = 'var(--ds-font-family-code)'
  document.body.appendChild(probe)
  const font = getComputedStyle(probe).fontFamily
  probe.remove()
  return font.length > 0 ? font : 'monospace'
}
