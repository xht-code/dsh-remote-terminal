/**
 * 浏览器半体的边界约束：`src/client/**` 会被打进 `lib/client.js` 交给浏览器执行，
 * 而测试与 typecheck 都跑在 Node 里——`types: ["node"]` 让 node 全局在类型上也
 * 存在，于是"客户端代码里写了 Buffer / process"这种错误在本机一路绿灯，直到浏览器
 * 里抛 ReferenceError（终端画面全空）才暴露。
 *
 * 这里用最笨但确定的方式把它挡在提交前：直接读源码，禁止 node 专属全局与内建模块。
 *
 * @module dsh-remote-terminal/tests-client-bundle
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** 客户端半体的源码目录（相对本测试文件）。 */
const CLIENT_DIR = fileURLToPath(new URL('../src/client', import.meta.url))

/** 客户端半体的源码目录根（相对本测试文件）：协议文件也在其中。 */
const SOURCE_DIR = fileURLToPath(new URL('../src', import.meta.url))

/**
 * 会被打进浏览器 bundle 的源码文件；新增文件需同步登记，否则约束会被绕过。
 * `protocol.ts` 由宿主半体与浏览器半体共用，且会被内联进 `lib/client.js`，
 * 因此同样受这里的约束（它当前只用纯字符串与数值运算）。
 */
const CLIENT_SOURCES = [
  'client/TerminalView.tsx',
  'client/connection.ts',
  'client/contract.ts',
  'client/index.ts',
  'client/labels.ts',
  'client/reconcile.ts',
  'client/runtime.ts',
  'client/sessions.ts',
  'client/theme.ts',
  'client/workspace.ts',
  'protocol.ts',
] as const

/**
 * 浏览器里不存在的 node 全局。`process` 只在构建期被 tsdown 的 define 替换
 * （`process.env.NODE_ENV`），运行时出现其它用法同样是错的。
 */
const FORBIDDEN_GLOBALS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /\bBuffer\s*[.[]/, why: '浏览器没有 Buffer（含 globalThis.Buffer）；字节数用 TextEncoder 自己算' },
  { pattern: /(^|[^.\w])__dirname\b/, why: '浏览器没有 __dirname' },
  { pattern: /(^|[^.\w])__filename\b/, why: '浏览器没有 __filename' },
  { pattern: /(^|[^.\w])global\s*[.[]/, why: '浏览器用 globalThis' },
  // process.env.NODE_ENV 会被 tsdown 的 define 在构建期替换掉，是唯一的合法用法。
  { pattern: /(^|[^.\w])process\s*\.(?!env\s*\.\s*NODE_ENV\b)/, why: '浏览器没有 process；只有 process.env.NODE_ENV 会被构建期替换' },
]

/** node 内建模块：客户端 bundle 里不该出现（打包进来会拖入 node 桩或直接失败）。 */
const FORBIDDEN_MODULES = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)['"](node:[^'"]+)['"]/

describe('浏览器半体的依赖边界', () => {
  it('客户端源码目录下的文件都已登记：新增文件不会绕过守卫', () => {
    const files = readdirSync(CLIENT_DIR)
      .filter(name => name.endsWith('.ts') || name.endsWith('.tsx'))
      .map(name => 'client/' + name)
      .sort()
    const registered = CLIENT_SOURCES.filter(name => name.startsWith('client/')).slice().sort()
    expect(files).toEqual(registered)
  })

  for (const file of CLIENT_SOURCES) {
    it(`${file} 不引用 node 专属全局与内建模块`, () => {
      // 断言依赖的是源码文本：注释里提到这些名字是允许的，只看代码行。
      const source = readFileSync(`${SOURCE_DIR}/${file}`, 'utf8')
      const code = source
        .split('\n')
        .filter(line => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .join('\n')

      for (const { pattern, why } of FORBIDDEN_GLOBALS) {
        const hit = pattern.exec(code)
        expect(hit, `${file} 命中 ${String(hit?.[0])}：${why}`).toBeNull()
      }
      const moduleHit = FORBIDDEN_MODULES.exec(code)
      expect(moduleHit, `${file} 引用了 node 内建模块 ${String(moduleHit?.[1])}`).toBeNull()
    })
  }
})
