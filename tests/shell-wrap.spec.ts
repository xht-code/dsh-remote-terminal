/**
 * shell 包装的验证，三层：
 * 1. 结构断言：不依赖任何 shell；
 * 2. 接线断言：argv / env 由插件自己的 `shellWrapInjection` 与 `defaultShell`
 *    产出（不是测试自己拼的），因此参数顺序、注入变量与真实运行完全一致；
 * 3. 真实行为断言：喂给真实 zsh / fish（macOS 自带 zsh；装了 fish 才有，找不到
 *    就整体跳过，而不是假装通过），其中提示符断言跑在真实 PTY 里，验证钩子确实
 *    在**每个提示符前**触发并跟随 `cd`。
 *
 * @module dsh-remote-terminal/tests-shell-wrap
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { spawn as spawnPty } from 'node-pty'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FISH_INIT_COMMAND, defaultShell, shellWrapFiles, shellWrapInjection } from '../src/index.ts'

/**
 * 在 PATH（以及 /bin）里找一个 shell 可执行文件。
 *
 * @param executable - 可执行文件名（`zsh` / `fish`）。
 * @returns 绝对路径；找不到时为 undefined。
 */
function findShell(executable: string): string | undefined {
  if (process.platform === 'win32') return undefined
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, executable)
    if (existsSync(candidate)) return candidate
  }
  const fixed = join('/bin', executable)
  return existsSync(fixed) ? fixed : undefined
}

/**
 * 等一个同步判定成立。
 *
 * @param predicate - 判定。
 * @param timeoutMs - 超时上限。
 * @returns 是否在时限内成立。
 */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return predicate()
}

/**
 * 在真实 PTY 里跑一个交互 shell，等首个提示符上报后 `cd` 进 probe 目录，返回累计输出。
 *
 * @param file - shell 可执行文件。
 * @param argv - 启动参数（按插件的方式组装）。
 * @param env - 终端环境（按插件的方式组装）。
 * @param cwd - 会话工作目录。
 * @param probeDir - 要 `cd` 进去的目录名（相对 cwd）。
 * @returns PTY 累计输出。
 */
async function drivePrompt(file: string, argv: string[], env: Record<string, string>, cwd: string, probeDir: string): Promise<string> {
  const pty = spawnPty(file, argv, { name: 'xterm-256color', cols: 100, rows: 30, cwd, env })
  let output = ''
  pty.onData((chunk) => { output += chunk })
  try {
    if (!await waitUntil(() => output.includes('\u001b]7;'), 8000)) {
      throw new Error('首个提示符没有上报 OSC 7，已收到：' + JSON.stringify(output.slice(-400)))
    }
    pty.write('cd ' + probeDir + '\n')
    if (!await waitUntil(() => output.includes('/' + probeDir + '\u001b\\'), 8000)) {
      throw new Error('cd 之后没有上报新的 OSC 7，已收到：' + JSON.stringify(output.slice(-400)))
    }
    return output
  } finally {
    pty.kill()
  }
}

const zshPath = findShell('zsh')
const fishPath = findShell('fish')

describe('shellWrapFiles', () => {
  it('bash 只有一份 rc 文件，zsh 是一整个 ZDOTDIR 目录（含登录用的 .zprofile）', () => {
    expect(Object.keys(shellWrapFiles('bash'))).toEqual(['bash-rc.sh'])
    expect(Object.keys(shellWrapFiles('zsh'))).toEqual(['.zshenv', '.zprofile', '.zshrc'])
  })

  it('两类包装都先回源用户自己的配置，再挂 cwd 上报钩子', () => {
    const bash = shellWrapFiles('bash')['bash-rc.sh']
    expect(bash).toContain('. "$HOME/.bashrc"')
    expect(bash).toContain('PROMPT_COMMAND="__dsh_rt_report_cwd')
    const zsh = shellWrapFiles('zsh')
    expect(zsh['.zshenv']).toContain('. "$ZDOTDIR/.zshenv"')
    expect(zsh['.zprofile']).toContain('. "$ZDOTDIR/.zprofile"')
    expect(zsh['.zshrc']).toContain('. "$ZDOTDIR/.zshrc"')
    expect(zsh['.zshrc']).toContain('add-zsh-hook precmd __dsh_rt_report_cwd')
  })

  it('zsh 的回源型包装把 ZDOTDIR 交还包装目录，并采纳用户改过的新值', () => {
    // 回源时把 ZDOTDIR 交给用户，用户配置里读 $ZDOTDIR 的地方才拿得到自己的目录；
    // 交还则是为了下一个启动文件（.zshrc）仍落在包装目录里。
    for (const file of ['.zshenv', '.zprofile']) {
      const wrapper = shellWrapFiles('zsh')[file]
      expect(wrapper).toContain('__dsh_rt_wrap_zdotdir="$ZDOTDIR"')
      expect(wrapper).toContain('ZDOTDIR="$__dsh_rt_wrap_zdotdir"')
      expect(wrapper).toContain('__DSH_RT_USER_ZDOTDIR="$ZDOTDIR"')
    }
  })

  it('fish 不落盘：钩子以事件函数注入，不碰用户自己的 fish_prompt', () => {
    expect(FISH_INIT_COMMAND).toContain('function __dsh_rt_report_cwd --on-event fish_prompt')
    expect(FISH_INIT_COMMAND).toContain("printf '\\033]7;file://%s%s\\033\\\\'")
    expect(FISH_INIT_COMMAND).not.toContain('function fish_prompt')
    // 主机名取 fish 的保留变量，不调用外部 hostname（PATH 里没有它时会在每个
    // 会话启动时吐一段报错）。
    expect(FISH_INIT_COMMAND).toContain('"$hostname"')
    expect(FISH_INIT_COMMAND).not.toContain('(hostname)')
  })
})

describe('shellWrapInjection', () => {
  it('bash 用 --rcfile，zsh 用 ZDOTDIR（并把用户真实配置目录交给包装脚本）', () => {
    expect(shellWrapInjection('bash', '/wrap/bash-rc.sh', { HOME: '/home/u' }))
      .toEqual({ args: ['--rcfile', '/wrap/bash-rc.sh'], env: {} })
    expect(shellWrapInjection('zsh', '/wrap/zdotdir', { HOME: '/home/u' }))
      .toEqual({ args: [], env: { __DSH_RT_USER_ZDOTDIR: '/home/u', ZDOTDIR: '/wrap/zdotdir' } })
    // 用户显式设了 ZDOTDIR 时按 zsh 自己的 ${ZDOTDIR:-$HOME} 语义取它。
    expect(shellWrapInjection('zsh', '/wrap/zdotdir', { HOME: '/home/u', ZDOTDIR: '/cfg' }).env.__DSH_RT_USER_ZDOTDIR)
      .toBe('/cfg')
  })

  it('fish 用 -C 内联注入，不需要包装目录', () => {
    expect(shellWrapInjection('fish', undefined, {})).toEqual({ args: ['-C', FISH_INIT_COMMAND], env: {} })
  })

  it('包装没生成出来时不注入任何东西（终端退回无钩子的交互 shell）', () => {
    expect(shellWrapInjection('bash', undefined, {})).toEqual({ args: [], env: {} })
    expect(shellWrapInjection('zsh', undefined, {})).toEqual({ args: [], env: {} })
  })
})

describe.skipIf(zshPath === undefined)('zsh 包装的真实行为', () => {
  // macOS 的默认决策：登录 shell（`-l -i`），因此 ~/.zprofile 也会被读到。
  const decision = defaultShell('darwin', '/bin/zsh')
  let root = ''
  let home = ''
  let wrapDir = ''
  let probe = ''

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-rt-zshwrap-'))
    home = join(root, 'home')
    wrapDir = join(root, 'zdotdir')
    probe = join(home, 'probe')
    mkdirSync(probe, { recursive: true })
    mkdirSync(wrapDir)
    // 非标准前缀安装的 zsh（例如本地解包出来的包）默认 fpath 里没有函数目录，
    // 于是缺 add-zsh-hook；常规安装本就有，这里按需补一条。
    const misc = join(dirname(dirname(zshPath ?? '')), 'share/zsh/functions/Misc')
    writeFileSync(join(home, '.zshenv'), [
      ...(existsSync(misc) ? [`fpath=(${misc} $fpath)`] : []),
      'export DSH_T_ZSHENV=loaded',
      '',
    ].join('\n'))
    writeFileSync(join(home, '.zprofile'), 'export DSH_T_ZPROFILE=loaded\n')
    writeFileSync(join(home, '.zshrc'), [
      'export DSH_T_ZSHRC=loaded',
      // 用户配置里读 $ZDOTDIR 的写法（prezto / zim 的初始化就是这样）必须拿到
      // 用户自己的目录，而不是包装目录。
      'export DSH_T_ZDOTDIR_IN_RC="$ZDOTDIR"',
      'autoload -Uz add-zsh-hook',
      '_dsh_t_user_hook() { : }',
      'add-zsh-hook precmd _dsh_t_user_hook',
      '',
    ].join('\n'))
    for (const [name, content] of Object.entries(shellWrapFiles('zsh'))) {
      writeFileSync(join(wrapDir, name), content, { mode: 0o600 })
    }
  })

  afterAll(() => {
    if (root.length > 0) rmSync(root, { recursive: true, force: true })
  })

  /**
   * 按插件的方式组装一次 zsh 启动。
   *
   * @param script - 追加的 `-c` 命令；缺省表示交互式启动。
   * @param baseHome - 用哪个 HOME（会话里的用户目录）；缺省是主 fixture 的那个。
   * @returns 可执行文件、参数与环境。
   */
  function zshStart(script?: string, baseHome = home): { file: string; argv: string[]; env: Record<string, string> } {
    const baseEnv = { HOME: baseHome, PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color' }
    const injection = shellWrapInjection('zsh', wrapDir, baseEnv)
    const argv = [...injection.args, ...decision.shellArgs]
    return {
      file: zshPath as string,
      argv: script === undefined ? argv : [...argv, '-c', script],
      env: { ...baseEnv, ...injection.env },
    }
  }

  it('回源用户的 .zshenv / .zprofile / .zshrc，还原 ZDOTDIR，并把钩子追加在用户钩子之后', () => {
    const start = zshStart('print -r "$DSH_T_ZSHENV|$DSH_T_ZPROFILE|$DSH_T_ZSHRC|$DSH_T_ZDOTDIR_IN_RC|$ZDOTDIR|${__DSH_RT_USER_ZDOTDIR-unset}|${precmd_functions}"')
    const out = execFileSync(start.file, start.argv, { cwd: home, encoding: 'utf8', env: start.env })
    expect(out.trim()).toBe(`loaded|loaded|loaded|${home}|${home}|unset|_dsh_t_user_hook __dsh_rt_report_cwd`)
  })

  it('用户在 .zshenv 里把 ZDOTDIR 指到别处（配置放 ~/.config/zsh 的写法）：照新目录回源、钩子照挂、私有变量不泄漏', () => {
    // zsh 每读一个启动文件都按当前 ZDOTDIR 定位：包装若不把 ZDOTDIR 交还回来，
    // 用户的 .zshrc 会被 zsh 直接读走，我们的包装 .zshrc 再也轮不到——钩子静默丢失、
    // 私有变量还会泄漏进会话环境。
    const movedHome = join(root, 'home-moved')
    const movedConfig = join(root, 'moved-config')
    mkdirSync(movedHome)
    mkdirSync(movedConfig)
    const misc = join(dirname(dirname(zshPath ?? '')), 'share/zsh/functions/Misc')
    writeFileSync(join(movedHome, '.zshenv'), [
      ...(existsSync(misc) ? [`fpath=(${misc} $fpath)`] : []),
      `export ZDOTDIR=${movedConfig}`,
      '',
    ].join('\n'))
    writeFileSync(join(movedConfig, '.zshrc'), [
      'export DSH_T_MOVED_RC=1',
      'autoload -Uz add-zsh-hook',
      '',
    ].join('\n'))
    const start = zshStart('print -r "$DSH_T_MOVED_RC|$ZDOTDIR|${__DSH_RT_USER_ZDOTDIR-unset}|${precmd_functions}"', movedHome)
    const out = execFileSync(start.file, start.argv, { cwd: movedHome, encoding: 'utf8', env: start.env })
    expect(out.trim()).toBe(`1|${movedConfig}|unset|__dsh_rt_report_cwd`)
  })

  it('钩子输出 OSC 7，且指向会话当前目录', () => {
    const start = zshStart('__dsh_rt_report_cwd')
    const out = execFileSync(start.file, start.argv, { cwd: home, encoding: 'utf8', env: start.env })
    expect(out.startsWith('\u001b]7;file://')).toBe(true)
    expect(out.endsWith(realpathSync(home) + '\u001b\\')).toBe(true)
  })

  it('真实 PTY 下每个提示符前都上报，且跟随 cd', async () => {
    const start = zshStart()
    const out = await drivePrompt(start.file, start.argv, start.env, home, 'probe')
    expect(out).toContain('\u001b]7;')
  })
})

describe.skipIf(fishPath === undefined)('fish 注入的真实行为', () => {
  // Linux 的默认决策：非登录交互 shell（与 GNOME Terminal / Konsole 一致）。
  const decision = defaultShell('linux', '/usr/bin/fish')
  // macOS 的默认决策：登录 shell，fish 才会按 /etc/paths、/etc/paths.d 构造 PATH。
  const darwinDecision = defaultShell('darwin', '/opt/homebrew/bin/fish')
  let root = ''
  let home = ''
  let probe = ''

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-rt-fishwrap-'))
    home = join(root, 'home')
    probe = join(home, 'probe')
    mkdirSync(probe, { recursive: true })
    mkdirSync(join(home, '.config', 'fish'), { recursive: true })
    writeFileSync(join(home, '.config', 'fish', 'config.fish'), [
      'set -gx DSH_T_FISHCONFIG loaded',
      'function fish_prompt',
      '    echo -n "user-prompt> "',
      'end',
      '',
    ].join('\n'))
  })

  afterAll(() => {
    if (root.length > 0) rmSync(root, { recursive: true, force: true })
  })

  /**
   * 按插件的方式组装一次 fish 启动。
   *
   * @param script - 追加的 `-c` 命令；缺省表示交互式启动。
   * @param shellArgs - 用哪套启动参数（平台决策）；缺省 Linux 的非登录那套。
   * @param envPatch - 覆盖基础环境里的项（例如换成没有 hostname 的 PATH）。
   * @returns 可执行文件、参数与环境。
   */
  function fishStart(
    script?: string,
    shellArgs: string[] = decision.shellArgs,
    envPatch: Record<string, string> = {},
  ): { file: string; argv: string[]; env: Record<string, string> } {
    const baseEnv = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', ...envPatch }
    const injection = shellWrapInjection('fish', undefined, baseEnv)
    const argv = [...injection.args, ...shellArgs]
    return {
      file: fishPath as string,
      argv: script === undefined ? argv : [...argv, '-c', script],
      env: { ...baseEnv, ...injection.env },
    }
  }

  it('用户的 config.fish 已经生效，钩子绑在 fish_prompt 事件上', () => {
    const start = fishStart('echo $DSH_T_FISHCONFIG; functions __dsh_rt_report_cwd')
    const out = execFileSync(start.file, start.argv, { cwd: home, encoding: 'utf8', env: start.env })
    expect(out).toContain('loaded')
    expect(out).toContain('--on-event fish_prompt')
  })

  it('钩子输出 OSC 7，且指向会话当前目录', () => {
    const start = fishStart('__dsh_rt_report_cwd')
    const out = execFileSync(start.file, start.argv, { cwd: home, encoding: 'utf8', env: start.env })
    expect(out.startsWith('\u001b]7;file://')).toBe(true)
    expect(out.endsWith(realpathSync(home) + '\u001b\\')).toBe(true)
  })

  it('真实 PTY 下每个提示符前都上报，且跟随 cd', async () => {
    const start = fishStart()
    const out = await drivePrompt(start.file, start.argv, start.env, home, 'probe')
    expect(out).toContain('\u001b]7;')
  })

  it('macOS 决策下按登录 shell 启动（fish 的 login-only 分支才会跑）', () => {
    const start = fishStart('status --is-login; and echo LOGIN=yes; or echo LOGIN=no', darwinDecision.shellArgs)
    const out = execFileSync(start.file, start.argv, { cwd: home, encoding: 'utf8', env: start.env })
    expect(out).toContain('LOGIN=yes')
  })

  it('PATH 里没有 hostname 也不报错，OSC 7 照常输出', () => {
    const start = fishStart('__dsh_rt_report_cwd', decision.shellArgs, { PATH: '/nonexistent' })
    // spawnSync 才拿得到 stderr：旧实现调用外部 hostname，会在这里吐
    // "Unknown command: hostname"，且每个会话启动都来一遍。
    const result = spawnSync(start.file, start.argv, { cwd: home, encoding: 'utf8', env: start.env })
    expect(result.stderr).not.toContain('Unknown command')
    expect(result.stdout).toContain('\u001b]7;file://')
  })
})
