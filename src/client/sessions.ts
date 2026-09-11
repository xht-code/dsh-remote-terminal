/**
 * 终端会话集合的按作用域登记：一个作用域（= 一个工作区）对应一组宿主会话 id。
 * 模块级状态在页面内由所有视图共享，并持久化到 sessionStorage，页面刷新后按
 * 作用域恢复各自的终端。作用域键由视图构造（`workspace:<id>`，未归属工作区的
 * 会话共用一个 default 桶）。
 *
 * @module dsh-remote-terminal/client-sessions
 */

/** sessionStorage 键：按作用域分组的已知会话集合。 */
const STORAGE_KEY = 'dsh-remote-terminal.sessions-by-scope'

/**
 * 解析持久化负载：`作用域 → 会话 id 列表`，形状不符的条目一律丢弃。
 *
 * @param raw - sessionStorage 里的原始字符串；不存在时为 null。
 * @returns 作用域到会话 id 列表的映射；无法解析时为空对象。
 */
export function parseStoredSessions(raw: string | null): Record<string, string[]> {
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const result: Record<string, string[]> = {}
  for (const [scope, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue
    const ids = value.filter((id): id is string => typeof id === 'string' && id.length > 0)
    if (ids.length > 0) result[scope] = ids
  }
  return result
}

/** sessionStorage 的窄面；经 globalThis 取，模块本身不依赖 DOM 类型。 */
interface WebStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 当前环境的 sessionStorage；不可用（非浏览器、隐私模式）时为 undefined。 */
function storage(): WebStorageLike | undefined {
  return (globalThis as { sessionStorage?: WebStorageLike }).sessionStorage
}

/** 作用域 → 该作用域内的宿主会话 id（插入顺序即创建顺序）。 */
const known = new Map<string, Set<string>>()

/** 读取持久化负载；不可用（隐私模式等）时视为空。 */
function readStored(): Record<string, string[]> {
  try {
    return parseStoredSessions(storage()?.getItem(STORAGE_KEY) ?? null)
  } catch {
    // 隐私模式下 sessionStorage 可能不可用；只影响刷新后的恢复。
    return {}
  }
}

for (const [scope, ids] of Object.entries(readStored())) known.set(scope, new Set(ids))

/** 写回持久化负载；不可用时静默（同上）。 */
function persist(): void {
  const target = storage()
  if (target === undefined) return
  try {
    const payload: Record<string, string[]> = {}
    for (const [scope, ids] of known) {
      if (ids.size > 0) payload[scope] = [...ids]
    }
    if (Object.keys(payload).length === 0) target.removeItem(STORAGE_KEY)
    else target.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // 隐私模式下 sessionStorage 可能不可用；只影响刷新后的恢复。
  }
}

/**
 * 取某作用域内已知的宿主会话 id。
 *
 * @param scope - 作用域键（工作区）。
 * @returns 该作用域内的会话 id；无记录时为空数组。
 */
export function sessionsOf(scope: string): string[] {
  return [...(known.get(scope) ?? [])]
}

/**
 * 记录某作用域内新创建的会话 id。已登记过的直接返回：重连/重挂载会对同一批
 * 会话反复 attach，没必要每次都重写存储。
 *
 * @param scope - 作用域键（工作区）。
 * @param sessionId - 宿主会话 id。
 */
export function rememberSession(scope: string, sessionId: string): void {
  let ids = known.get(scope)
  if (ids === undefined) {
    ids = new Set()
    known.set(scope, ids)
  }
  if (ids.has(sessionId)) return
  ids.add(sessionId)
  persist()
}

/**
 * 移除某作用域内已销毁的会话 id；本就不存在时不重写存储。
 *
 * @param scope - 作用域键（工作区）。
 * @param sessionId - 宿主会话 id。
 */
export function forgetSession(scope: string, sessionId: string): void {
  if (known.get(scope)?.delete(sessionId) !== true) return
  persist()
}
