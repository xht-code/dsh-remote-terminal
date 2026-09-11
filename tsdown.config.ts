import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { UserConfig } from 'tsdown'

/**
 * 类型全部来自 devDependencies 的 lockfile 安装，构建不依赖任何检出路径；
 * 运行时一律外部导入（neverBundle），实例由宿主进程提供。
 */

const PLUGIN_ID = 'dsh-remote-terminal'

/** 运行时由宿主提供、禁止打进产物的 host 包（与依赖声明对应）。 */
const HOST_NEVER_BUNDLE = [
  '@deepseek-ai/cordis',
  // cordis 的内部依赖，随其一起保持外部，避免被类型图连带打包。
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-subprocess',
]

// React 由宿主 UI 运行时提供；node-pty/ws 仅宿主半体使用，不进浏览器 bundle。
const CLIENT_NEVER_BUNDLE = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  ...HOST_NEVER_BUNDLE,
]

/** 浏览器 bundle 内联的 xterm 样式文本：构建期读取，运行时注入 <style>。 */
const require = createRequire(import.meta.url)
const XTERM_CSS = readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8')

/** Host side：Node ESM，产物 index.mjs + index.d.mts + sourcemap。 */
const hostConfig: UserConfig = {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2023',
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: true,
  deps: { neverBundle: HOST_NEVER_BUNDLE },
}

/** Client side：浏览器 CJS bundle，走 DSH ModuleLoader wrapper；d.ts 由 tsc 单独生成。 */
const clientConfig: UserConfig = {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    __XTERM_CSS__: JSON.stringify(XTERM_CSS),
  },
  deps: {
    neverBundle: CLIENT_NEVER_BUNDLE,
    alwaysBundle: (id: string) => !CLIENT_NEVER_BUNDLE.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [hostConfig, clientConfig] satisfies UserConfig[]
