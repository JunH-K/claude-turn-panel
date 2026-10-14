import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

export const PLUGIN = 'turn-panel'
export const PANE_ID = 'turn-panel'
export const CWD = '/work/app'
export const START = 1_800_000_000_000

export const PANE_PROPS = {
  title: '턴 패널',
  isFocused: true,
  bodyColumns: 64,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
} as const

export type World = {
  clock: MockClock
  opened: number
  closed: number
  /** 마지막으로 연 패널이 키보드 초점을 달라고 했는가 */
  askedFocus: boolean
  statuses: (string | undefined)[]
  isPlaced: boolean
  /** 모드가 낸 요청 글 */
  submitted: string[]
  /** 모드가 낸 요청 가운데 사용자의 글로(틀 없이) 낸 것 */
  asUser: string[]
  /** 여기 든 글의 요청은 다른 훅이 막은 것처럼 들어가지 못한다 */
  blocked: Set<string>
  /** 모드가 실행한 명령 */
  ran: { command: string; args: string }[]
  /** 모드가 입력란에 채운 글 */
  filled: string[]
  toasts: string[]
  /** 이 세션에 있는 슬래시 명령 이름 */
  commands: string[]
  /** 모드가 실행한 외부 명령 줄 */
  calls: string[][]
  /** 실제로 있는 파일들 (절대 경로) */
  files: Set<string>
  /** 모드가 들여다본 경로 */
  statted: string[]
  /** 모드가 목록을 읽은 폴더 */
  listed: string[]
  /** 바로가기: 경로 → 가리키는 실제 경로 */
  links: Record<string, string>
  /** `git remote get-url origin`이 내는 글. null이면 git 폴더가 아니다 */
  remote: string | null
  /** cmux의 칸들 */
  surfaces: { ref: string; type: 'terminal' | 'browser'; url?: string }[]
  /** 이름이 여기 있는 명령은 시작하지 못한다 (실행 파일 없음) */
  missing: Set<string>
  /** 도구 호출의 바닥이 돌려줄 값. 도구 이름 → 결과 */
  toolResults: Record<string, unknown>
  /** 참이면 파일 확인이 끝나지 않는다 (응답 없는 네트워크 드라이브) */
  isStatStuck: boolean
  /** 입력란의 흐린 제안으로 끝까지 간 글 (R-30) */
  suggested: string[]
  /** 도구가 도는 동안 부를 것. 값을 돌려주면 그것이 호출의 답이다 */
  onTool: ((call: { tool: string; id: string }) => Promise<unknown> | unknown) | null
}

function ran(exitCode: number, stdout: string) {
  return { value: { exitCode, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

function answerProcess(seen: World, argv: readonly string[]) {
  seen.calls.push([...argv])
  const [name, a, b, c, d] = argv
  if (name === undefined || seen.missing.has(name)) {
    return { deny: `${name}: 실행 파일을 찾지 못했다` }
  }
  if (name === 'git') {
    return seen.remote === null ? ran(128, 'fatal: not a git repository') : ran(0, seen.remote)
  }
  if (name === 'cmux' && a === 'list-panels') {
    return ran(0, JSON.stringify({ surfaces: seen.surfaces }))
  }
  if (name === 'cmux' && a === 'browser' && b === 'open') {
    const ref = `surface:${seen.surfaces.length + 1}`
    seen.surfaces.push({ ref, type: 'browser', url: c })

    return ran(0, `OK surface=${ref} pane=pane:9 placement=split`)
  }
  if (name === 'cmux' && a === 'browser' && b === '--surface' && d === 'navigate') {
    const surface = seen.surfaces.find(one => one.ref === c && one.type === 'browser')
    if (surface === undefined) {
      return ran(1, 'Error: invalid_params: 브라우저 작업 실패')
    }
    surface.url = argv[5]

    return ran(0, 'OK')
  }

  return ran(0, '')
}

export type Init = {
  isPlaced?: boolean
  inCmux?: boolean
  isInteractive?: boolean
  /** 엔진이 저장해 둔 이 세션의 대화. 다시 연 세션이면 있다 (R-32) */
  messages?: unknown[]
}

// 지금 테스트의 시계. 턴이 끝난 뒤 모드가 기다리지 않고 돌려 둔 일(경로 찾기, 패널 열기)을 마저 돌릴 때 쓴다.
let clock: MockClock | null = null

/**
 * 엔진 자리에 서는 바닥 훅들을 깔고 세션을 시작한다. 모드가 부른 것을 적어 둔다.
 * 바닥 훅은 테스트가 `$`를 처음 부르기 전에 깔아야 하므로 여기서 한꺼번에 깐다.
 */
export async function world($: Engine, on: On, init: Init = {}): Promise<World> {
  const seen: World = {
    clock: mock.clock(on, { now: START }),
    opened: 0,
    closed: 0,
    askedFocus: false,
    statuses: [],
    isPlaced: init.isPlaced ?? true,
    submitted: [],
    asUser: [],
    blocked: new Set(),
    ran: [],
    filled: [],
    toasts: [],
    commands: ['turn-panel', 'review'],
    calls: [],
    files: new Set(),
    statted: [],
    listed: [],
    links: {},
    remote: 'git@github.com:acme/app.git',
    surfaces: [{ ref: 'surface:1', type: 'terminal' }],
    missing: new Set(),
    toolResults: {},
    suggested: [],
    isStatStuck: false,
    onTool: null,
  }
  mock.env(on, { HOME: '/home/me', ...((init.inCmux ?? true) ? { CMUX_WORKSPACE_ID: 'workspace-uuid' } : {}) })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.cwd', () => ({ value: CWD }))
  on('process.run', (_, e) => answerProcess(seen, e.argv))
  on('fs.list', (_, e) => {
    const dir = (e.path ?? CWD).replace(/\/+$/, '')
    seen.listed.push(dir)
    if (seen.isStatStuck) {
      return new Promise<never>(() => {})
    }
    // 있는 파일과 바로가기에서 이 폴더의 바로 아래 항목을 만든다.
    const entries = new Map<string, { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const path of [...seen.files, ...Object.keys(seen.links)]) {
      if (!path.startsWith(`${dir}/`)) {
        continue
      }
      const [name = '', ...rest] = path.slice(dir.length + 1).split('/')
      const isLink = rest.length === 0 && Object.hasOwn(seen.links, path)
      entries.set(name, { name, kind: rest.length > 0 ? 'dir' : isLink ? 'other' : 'file', size: 1, mtimeMs: 0, isLink })
    }

    return entries.size === 0 && dir !== CWD ? { deny: 'ENOENT' } : { value: [...entries.values()] }
  })
  on('fs.stat', (_, e) => {
    seen.statted.push(e.path)
    if (seen.isStatStuck) {
      return new Promise<never>(() => {})
    }

    if (e.path === CWD) {
      return { value: { kind: 'dir' as const, size: 1, mtimeMs: 0, isLink: false, realPath: CWD } }
    }
    const target = seen.links[e.path] ?? e.path

    return seen.files.has(e.path) || seen.files.has(target)
      ? { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: target !== e.path, realPath: target } }
      : { deny: 'ENOENT' }
  })
  on('prompt.submit', (_, e) => {
    if (seen.blocked.has(e.text)) {
      return { drop: '막힌 요청' }
    }
    if (e.origin.kind === 'plugin') {
      seen.submitted.push(e.text)
      if (e.origin.asUser === true) {
        seen.asUser.push(e.text)
      }
    }

    return { text: e.text }
  })
  on('command.run', (_, e) => {
    seen.ran.push({ command: e.command, args: e.args })

    return {}
  })
  on('command.list', () => ({
    value: seen.commands.map(name => ({ name, description: name, source: 'user' as const })),
  }))
  on('prompt.suggest', (_, e) => {
    seen.suggested.push(e.text)

    return { isShown: true }
  })
  on('session.messages', () => ({ value: (init.messages ?? []) as never }))
  on('prompt.fill', (_, e) => {
    seen.filled.push(e.text)

    return { isFilled: true }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: '엔진의 글', scope: 'shared' as const }] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', async (_, e) => {
    const own = await seen.onTool?.({ tool: String(e.tool), id: e.tool_use_id })

    return (own ?? { result: seen.toolResults[String(e.tool)] ?? {} }) as never
  })
  on('ui.open', (_, e) => {
    seen.opened += 1
    seen.askedFocus = e.focus === true

    return { value: seen.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: '터미널이 좁다' } }
  })
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value:
      seen.opened > seen.closed
        ? [{ id: PANE_ID, title: '턴 패널', isShown: true, isFocused: false, isPlaced: seen.isPlaced }]
        : [],
  }))
  on('ui.close', () => {
    seen.closed += 1

    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  clock = seen.clock
  const isInteractive = init.isInteractive ?? true
  await $.session.start({ cwd: CWD, surface: isInteractive ? 'terminal' : null, isInteractive })

  return seen
}

let turns = 0

/** 사람이 요청을 낸다. 턴이 시작한 데까지다. */
export async function ask($: Engine, text: string): Promise<string> {
  turns += 1
  const turnId = `turn-${turns}`
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text, turnId })
  await clock?.settle()

  return turnId
}

/** 도는 턴이 정상 종료한다. */
export async function answer($: Engine, turnId: string, text: string, durationMs: number = 10_000): Promise<void> {
  await $.turn.complete({ answer: text, durationMs, isAborted: false, turnId, reason: 'answer' })
  // 모드는 경로 찾기와 패널 열기를 기다리지 않고 턴을 끝낸다. 테스트는 그 일이 끝난 뒤를 본다.
  await clock?.settle()
  // 제안이 바뀐 직후의 누름은 버려지므로, 사람이 제안을 읽을 만큼 시간이 지난 뒤로 옮긴다.
  await clock?.advance(2000)
}

/** 사람이 요청을 내고 본 세션 턴이 정상 종료한다. */
export async function turn($: Engine, text: string, reply: string, durationMs: number = 10_000): Promise<void> {
  await answer($, await ask($, text), reply, durationMs)
}

export async function mountPane($: Engine, surface: 'terminal' | 'desktop' | 'mobile' | 'vscode' = 'terminal', isFocused: boolean = true) {
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE_ID, props: { ...PANE_PROPS, isFocused } })
}

/** 사용자가 `/turn-panel 인자`를 친다. */
export async function runCommand($: Engine, args: string = ''): Promise<string | undefined> {
  const done = await $.command.run({
    command: 'turn-panel',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })

  return done.text
}
