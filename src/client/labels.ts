/**
 * 终端标签命名与 OSC 7 负载解析的纯函数：不依赖 DOM、React 与连接状态，
 * 便于隔离测试。
 *
 * @module dsh-remote-terminal/client-labels
 */

/**
 * 标签文字：取当前目录最后一段（如 myproj）。目录未知（占位或错误标签）
 * 时返回调用方给的占位文案；根目录与无斜杠输入按原样返回。
 *
 * @param cwd - 终端当前工作目录；空串表示未知。
 * @param fallback - 目录未知时使用的占位文案。
 * @returns 标签文字。
 */
export function tabLabel(cwd: string, fallback: string): string {
  if (cwd.length === 0) return fallback
  const trimmed = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd
  const index = trimmed.lastIndexOf('/')
  const name = index < 0 ? trimmed : trimmed.slice(index + 1)
  return name.length === 0 ? cwd : name
}

/**
 * 从 OSC 7（`file://host/path`）负载中提取路径；形状非法时返回 undefined。
 *
 * @param osc - OSC 7 的负载部分（不含 `ESC ] 7 ;` 与终止符）。
 * @returns 解码后的绝对路径；无法识别时返回 undefined。
 */
export function parseOsc7Cwd(osc: string): string | undefined {
  const prefix = 'file://'
  if (!osc.startsWith(prefix)) return undefined
  const rest = osc.slice(prefix.length)
  const pathStart = rest.indexOf('/')
  if (pathStart < 0) return undefined
  const encoded = rest.slice(pathStart)
  try {
    return decodeURIComponent(encoded)
  } catch {
    // 路径含非法转义序列（如字面 %xx）时按原样使用。
    return encoded
  }
}
