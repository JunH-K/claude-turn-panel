import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register } from 'claude-code'

import type { FoundPaths } from '../types'
import { Panel } from './Panel'
import { absolutePath, pathCandidates, repoOf, safeUrl } from './links'
import { INSTRUCTION, SECTION_ID, asCommand, ghostOf, splitNext, stripNext, wantsNextBlock } from './nextBlock'
import type { Suggestion } from './nextBlock'
import { editorArgv, fallbackArgv, isEditor, isInside, isOk, navigateArgv, walkOf, openArgv, openedSurface } from './open'
import type { Editor, Ran, Walk } from './open'
import { activityOf, applyTaskTool, changedFile, isAllDone, isTaskTool } from './progress'
import type { Loose } from './progress'
import { MAX_TURNS, addFile, beginActivity, endActivity, endTurn, enrichTurn, isPersonRequest, moveView, restoreTurns, startRun } from './record'

const PANE = 'turn-panel'
const COMMAND = 'turn-panel'
const TITLE = '턴 패널'
// 패널이 원하는 본문 폭. 사용자가 직접 맞춘 폭이 있으면 그것이 이긴다 (R-21).
const COLUMNS = 64
const USAGE = '쓰는 법: /turn-panel (열기·닫기) · /turn-panel off (끄기) · /turn-panel on (켜기)'

const request = atom({ plugin: 'turn-panel', key: 'request' } as const, '')
const run = atom({ plugin: 'turn-panel', key: 'run' } as const, null)
const steps = atom({ plugin: 'turn-panel', key: 'steps' } as const, [])
const history = atom({ plugin: 'turn-panel', key: 'history' } as const, [])
const view = atom({ plugin: 'turn-panel', key: 'view' } as const, null)
const picked = atom({ plugin: 'turn-panel', key: 'picked' } as const, null)
const isEditing = atom({ plugin: 'turn-panel', key: 'isEditing' } as const, false)
const isClosed = atom({ plugin: 'turn-panel', key: 'isClosed' } as const, false)
const isOff = atom({ plugin: 'turn-panel', key: 'isOff' } as const, false)
const isPaneUp = atom({ plugin: 'turn-panel', key: 'isPaneUp' } as const, false)
const now = atom({ plugin: 'turn-panel', key: 'now' } as const, 0)
const cwd = atom({ plugin: 'turn-panel', key: 'cwd' } as const, '')
const browser = atom({ plugin: 'turn-panel', key: 'browser' } as const, null)

const PROCESS_TIMEOUT_MS = 5000
// 파일 하나를 확인하는 데 기다리는 시간. 응답 없는 네트워크 드라이브의 경로가 나머지를 붙잡지 않게 한다.
const STAT_TIMEOUT_MS = 2000
// 제안이 바뀐 직후의 누름은 버린다. 읽던 제안이 손가락 밑에서 새 제안으로 바뀌는 것을 막는다.
const SETTLE_MS = 1500
// 끝난 턴의 "n분 전"은 이 간격으로만 다시 그린다. 도는 턴의 경과 시간은 초마다 그린다.
const IDLE_TICK_MS = 30_000

// 기록은 덤이다. 여기서 난 실패가 도구 호출이나 턴을 막지 않게 삼킨다 (R-23).
async function quiet(work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch {
    // 패널이 한 박자 늦게 그려질 뿐이다.
  }
}

// 정해진 시간 안에 끝나면 그 값을, 아니면 null을 돌려준다. 실패도 null이다.
function within<T>($: EngineInterface, work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise(resolve => {
    const timer = $.clock.after(ms, () => resolve(null))
    work.then(
      value => {
        timer.cancel()
        resolve(value)
      },
      () => {
        timer.cancel()
        resolve(null)
      },
    )
  })
}

// 시작하지 못했거나 응답이 없으면 null. 패널은 그대로 돈다 (R-23).
async function runProcess($: EngineInterface, argv: string[]): Promise<Ran | null> {
  try {
    return await $.process.run(argv, { timeoutMs: PROCESS_TIMEOUT_MS })
  } catch {
    return null
  }
}

async function isInCmux($: EngineInterface): Promise<boolean> {
  // 변수 이름은 글자 그대로 쓴다. 엔진이 모드가 읽는 변수를 목록으로 보일 수 있어야 한다.
  return ((await $.env.get('CMUX_WORKSPACE_ID')) ?? '') !== ''
}

// 주소를 지금 워크스페이스의 브라우저 칸에서 연다 (R-15).
// 이 세션이 연 칸이 있으면 그 칸의 주소를 바꾸고, 없거나 닫혔으면 새 칸을 연다.
// 사용자가 따로 열어 둔 브라우저 칸은 건드리지 않는다.
async function openWeb($: EngineInterface, raw: string): Promise<void> {
  // 단추든 본문 링크 누름이든 여기서 한 번 더 검사한다.
  const url = safeUrl(raw)
  if (url === null) {
    $.ui.toast('http(s) 주소가 아니어서 열지 않았다')

    return
  }
  if (!(await isInCmux($))) {
    // cmux 밖에서는 링크 상자의 단추만 여기로 온다. 맥의 기본 브라우저로 연다.
    if ((await runProcess($, ['open', url]))?.exitCode !== 0) {
      $.ui.toast(`링크를 열지 못했다: ${url}`)
    }

    return
  }
  const known = await read($, browser)
  if (known !== null && isOk(await runProcess($, navigateArgv(known, url)))) {
    return
  }
  const opened = openedSurface(await runProcess($, openArgv(url)))
  await update($, browser, () => opened)
  if (opened === null) {
    $.ui.toast(`cmux로 링크를 열지 못했다: ${url}`)
  }
}

// 파일을 연다 (R-15, R-25, R-27). 세션 폴더 안의 파일은 편집기로, 밖의 파일은 글 편집기로만 연다.
// 편집기 명령이 없어도 글 편집기로 연다. 파일의 기본 앱으로는 열지 않는다.
async function openFile($: EngineInterface, editor: Editor, path: string, line: number | null): Promise<void> {
  // 바로가기를 다 푼 실제 경로로 판단한다. 폴더 안의 이름이 밖을 가리키는 바로가기일 수 있다.
  const file = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  if (file === undefined || file.kind !== 'file' || file.realPath === undefined) {
    $.ui.toast(`파일이 없어 열지 않았다: ${path}`)

    return
  }
  const root = await $.fs.stat(await rootOf($), { resolve: true }).catch(() => undefined)
  const inside = root?.realPath !== undefined && isInside(file.realPath, root.realPath)
  const argv = inside ? editorArgv(editor, file.realPath, line) : null
  if (!inside) {
    $.ui.toast('세션 폴더 밖의 파일이라 글 편집기로 연다')
  }
  if (argv !== null && (await runProcess($, argv))?.exitCode === 0) {
    return
  }
  const fallback = fallbackArgv(file.realPath)
  if (fallback !== null && (await runProcess($, fallback))?.exitCode === 0) {
    return
  }
  $.ui.toast(`파일을 열지 못했다: ${path}`)
}

// 패널을 스스로 연다. 터미널이 좁아 놓이지 못하면 여는 명령을 상태 줄에 알린다 (R-20).
async function showPane($: EngineInterface): Promise<void> {
  if ((await read($, isOff)) || (await read($, isClosed))) {
    return
  }
  // 이미 놓여 있으면 다시 열지 않는다. 사용자가 다른 패널을 보고 있어도 건드리지 않는다.
  const isPlaced =
    (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced) ||
    (await $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS })).isPlaced
  // 좁아서 못 놓였다가 넓어져 놓인 뒤에는 안내를 지운다. 안내대로 명령을 치면 열린 패널이 닫힌다.
  $.ui.status(isPlaced ? undefined : `/${COMMAND} 로 턴 패널 열기`)
  await update($, isPaneUp, () => isPlaced)
}

// 세션 폴더. 세션이 시작할 때 적어 두지 못했으면(모드가 턴 도중에 다시 불린 경우 등) 지금 묻는다.
async function rootOf($: EngineInterface): Promise<string> {
  const known = await read($, cwd)
  if (known !== '') {
    return known
  }
  const asked = await $.session.cwd()
  await update($, cwd, () => asked)

  return asked
}

// 폴더의 목록. 한 번 찾는 동안 같은 폴더는 한 번만 읽는다. 제때 답하지 않으면 null이다.
function listOf($: EngineInterface, dir: string, lists: Map<string, Promise<FsEntry[] | null>>): Promise<FsEntry[] | null> {
  const known = lists.get(dir)
  if (known !== undefined) {
    return known
  }
  const listed = within($, $.fs.list(dir), STAT_TIMEOUT_MS)
  lists.set(dir, listed)

  return listed
}

// 바로가기를 지나지 않고 닿는 보통 파일인가. 목록은 항목 자체의 종류를 알려 주고 바로가기를 따라가지 않는다.
// `fs.stat`은 따라가므로, `/net/…`을 가리키는 바로가기를 확인만 해도 마운트가 일어난다 (R-14).
async function isPlainFile($: EngineInterface, walk: Walk, lists: Map<string, Promise<FsEntry[] | null>>): Promise<boolean> {
  let dir = walk.base
  for (const [index, name] of walk.parts.entries()) {
    const entry = (await listOf($, dir, lists))?.find(found => found.name === name)
    const wanted = index === walk.parts.length - 1 ? 'file' : 'dir'
    if (entry === undefined || entry.isLink || entry.kind !== wanted) {
      return false
    }
    dir = `${dir}/${name}`
  }

  return true
}

// 보고 본문에 적힌 경로 가운데 실제로 있는 파일을 찾는다 (R-14).
async function findPaths($: EngineInterface, body: string, root: string): Promise<FoundPaths> {
  const candidates = pathCandidates(body)
  if (candidates.length === 0) {
    return {}
  }
  const home = (await $.env.get('HOME')) ?? ''
  const found: FoundPaths = {}
  const lists = new Map<string, Promise<FsEntry[] | null>>()
  await Promise.all(
    candidates.map(async candidate => {
      const absolute = absolutePath(candidate, root, home)
      const walk = absolute === null ? null : walkOf(absolute, root, home)
      // 없는 경로, 바로가기를 지나는 경로, 제때 답하지 않는 경로는 글자 그대로 둔다.
      if (absolute !== null && walk !== null && (await isPlainFile($, walk, lists))) {
        found[candidate] = absolute
      }
    }),
  )

  return found
}

// 세션 폴더의 GitHub 저장소. GitHub가 아니거나 git 폴더가 아니면 null (R-14).
async function findRepo($: EngineInterface, root: string): Promise<string | null> {
  if (root === '') {
    return null
  }
  const ran = await runProcess($, ['git', '-C', root, 'remote', 'get-url', 'origin'])

  return ran === null || ran.exitCode !== 0 ? null : repoOf(ran.stdout)
}

async function move($: EngineInterface, step: -1 | 1): Promise<void> {
  const past = await read($, history)
  const current = await read($, run)
  await update($, view, at => moveView(at, step, past.length, current !== null))
}

// 세션 폴더의 저장소는 세션 동안 바뀌지 않는다고 보고 한 번만 구한다.
let repo: { root: string; name: string | null } | null = null
// 누른 제안을 보내는 중인가. 거의 동시에 온 두 누름이 둘 다 나가지 않게 한다.
let isPicking = false
// 입력란에 흐린 제안으로 띄운 첫 제안. 다음 턴이 시작하면 지운다 (R-30).
let ghost: string | null = null

// 고른 제안을 다음 턴으로 보낸다. `/`로 시작하면 명령으로, 아니면 사용자 글로 낸다 (R-11).
// 고쳐서 보내기가 켜져 있으면 보내지 않고 입력란에 채운다 (R-12).
async function pick($: EngineInterface, suggestion: Suggestion): Promise<void> {
  // 두 번 눌러 같은 요청이 두 번 들어가지 않게, 이미 고른 뒤의 누름은 버린다.
  if (isPicking || (await read($, picked)) !== null) {
    return
  }
  isPicking = true
  try {
    const latest = (await read($, history)).at(-1)
    if (latest !== undefined && (await $.clock.now()) - latest.endedAt < SETTLE_MS) {
      $.ui.toast('제안이 방금 바뀌었다. 보낼 글을 확인하고 다시 누른다')

      return
    }
    const { text } = suggestion
    if (await read($, isEditing)) {
      await update($, isEditing, () => false)
      // 채우면 키보드가 입력란으로 돌아간다(실제 세션에서 확인). 못 채웠을 때만 알린다.
      if (!(await $.prompt.fill({ text })).isFilled) {
        $.ui.toast('입력란에 채우지 못했다')
      }

      return
    }
    // 슬래시 명령은 실행하지 않고 입력란에 채운다. 모델이 쓴 명령이 키 한 번에 돌지 않게,
    // 사용자가 Enter를 치는 것을 두 번째 확인으로 삼는다. 명령은 플러그인 설치까지 할 수 있다.
    if (asCommand(text) !== null) {
      const filled = await $.prompt.fill({ text })
      $.ui.toast(filled.isFilled ? '명령을 입력란에 채웠다. 확인하고 Enter로 실행한다' : '입력란에 채우지 못했다')

      return
    }

    await update($, picked, () => suggestion.label)
    // 모드가 스스로 낸 요청은 이 모드의 prompt.submit 훅에 오지 않으므로 여기서 적는다 (R-1).
    const before = await read($, request)
    await update($, request, () => text)
    const entered = await $.prompt.submit({ text, asUser: true })
    if (entered.drop !== undefined) {
      // 다른 훅이 요청을 막았다. 나가지 않았으니 되돌리고 알린다.
      await update($, request, () => before)
      await update($, picked, () => null)
      $.ui.toast(`제안이 막혀 나가지 않았다: ${suggestion.label}`)
    }
  } catch {
    // 보내지 못했으면 다시 고를 수 있게 선택창을 되돌린다.
    await quiet(() => update($, picked, () => null))
    $.ui.toast(`제안을 보내지 못했다: ${suggestion.label}`)
  } finally {
    isPicking = false
  }
}

// 패널의 누름을 처리한다. 실패는 삼키지 않고 알린다 (R-23).
function act($: EngineInterface, work: () => Promise<unknown>): void {
  work().catch(() => $.ui.toast('패널의 누름을 처리하지 못했다'))
}

// 화면이 읽는 시각을 갱신한다. 도는 턴은 초마다, 끝난 턴은 드문드문 (R-5).
async function tick($: EngineInterface): Promise<void> {
  if (await read($, isOff)) {
    return
  }
  const at = await $.clock.now()
  const current = await read($, run)
  if (current?.status === 'running' || at - (await read($, now)) >= IDLE_TICK_MS) {
    await update($, now, () => at)
  }
}

// 끝난 턴의 보고에서 경로와 저장소를 찾아 그 턴에 덧쓴다. 턴이 끝난 뒤에 따로 돈다 (R-14, R-23).
async function enrich($: EngineInterface, endedAt: number, answer: string): Promise<void> {
  const root = await rootOf($)
  if (repo === null || repo.root !== root) {
    repo = { root, name: await findRepo($, root) }
  }
  const paths = await findPaths($, splitNext(answer).body, root)
  const name = repo.name
  if (name !== null || Object.keys(paths).length > 0) {
    await update($, history, turns => enrichTurn(turns, endedAt, answer, paths, name))
  }
}

// 기록이 비어 있을 때만 되살린다. 되살린 사이에 새 턴이 끝났으면 그 턴을 뒤에 둔다 (R-32).
async function restore($: EngineInterface): Promise<void> {
  if ((await read($, history)).length > 0) {
    return
  }
  const restored = restoreTurns(await $.session.messages())
  if (restored.length === 0) {
    return
  }
  await update($, history, turns => [...restored, ...turns].slice(-MAX_TURNS))
  const last = restored.at(-1)
  if (last !== undefined) {
    await enrich($, last.endedAt, last.answer)
  }
}

export const register: Register = (on, options) => {
  const editor: Editor = isEditor(options.editor) ? options.editor : 'webstorm'
  // 환경변수는 세션 동안 바뀌지 않는다. 그릴 때마다 묻지 않게 한 번 읽어 둔다.
  let inCmux: boolean | null = null
  // 사람이 화면 앞에 있는 세션인가. 화면 없는 실행(`claude -p`, SDK)에서는 아무 일도 하지 않는다.
  let isActive = true

  on('session.start', async ($, e, next) => {
    isActive = e.isInteractive
    await $.command.register({
      name: COMMAND,
      description: '요청과 완료 보고를 묶어 보여 주는 턴 패널을 열거나 닫는다. off·on으로 끄고 켠다',
      argumentHint: '[on|off]',
      immediate: true,
    })
    if (isActive) {
      await quiet(async () => {
        const at = await $.clock.now()
        await update($, cwd, () => e.cwd)
        await update($, now, () => at)
      })
      $.clock.every(1000, () => void quiet(() => tick($)))
      // 다시 연 세션이면 저장된 대화에서 지난 턴을 되살린다. 새 세션은 대화가 비어 있다 (R-32).
      void quiet(() => restore($))
    }

    return next(e)
  })

  // `/clear`는 대화를 비운다. 패널의 기록도 함께 비운다. 켜고 끈 것과 닫은 것은 그대로 둔다.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await quiet(async () => {
        await update($, request, () => '')
        await update($, run, () => null)
        await update($, steps, () => [])
        await update($, history, () => [])
        await update($, view, () => null)
        await update($, picked, () => null)
        await update($, isEditing, () => false)
      })
    }

    return next(e)
  })

  // turn.start가 이 값을 읽으므로 next보다 먼저 적는다. 요청이 막혀 들어가지 못하면 되돌린다.
  on('prompt.submit', async ($, e, next) => {
    if (!isActive || !isPersonRequest(e.origin, $.plugin.name)) {
      return next(e)
    }
    let before: string | null = null
    await quiet(async () => {
      before = await read($, request)
      await update($, request, () => e.text)
    })
    const entered = await next(e)
    const restored = before as string | null
    if (entered.drop !== undefined && restored !== null) {
      await quiet(() => update($, request, current => (current === e.text ? restored : current)))
    }

    return entered
  })

  // 본 세션이 답변 끝에 제안 블록을 붙이도록 시스템 프롬프트에 구역을 더한다 (R-9).
  // 턴마다 불리므로 끈 턴에는 구역이 빠진다 (R-19).
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!isActive || !wantsNextBlock(e) || (await read($, isOff))) {
      return composed
    }

    return { sections: [...composed.sections, { id: SECTION_ID, text: INSTRUCTION, scope: 'session' as const }] }
  })

  on('turn.start', async ($, e, next) => {
    if (isActive && e.agentId === undefined) {
      ghost = null
    }
    if (isActive) {
      await quiet(async () => {
        const asked = await read($, request)
        const at = await $.clock.now()
        await update($, run, () => startRun(e.turnId, asked, at))
        await update($, now, () => at)
        await update($, view, () => null)
        await update($, isEditing, () => false)
      })
      // 패널을 여는 일은 기다리지 않는다. 턴의 시작을 붙잡지 않는다 (R-23).
      void quiet(() => showPane($))
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!isActive) {
      return next(e)
    }
    const tool = String(e.tool)
    const input = e as unknown as Loose
    const id = e.tool_use_id
    // 하위 에이전트의 호출은 본 세션의 "지금 하는 일"이 아니다. 고친 파일만 모은다.
    const isMain = e.agentId === undefined
    if (isMain) {
      const activity = { id, ...activityOf(tool, input) }
      await quiet(() => update($, run, current => (current?.status === 'running' ? beginActivity(current, activity) : current)))
    }
    try {
      const ran = await next(e)
      await quiet(async () => {
        if (ran.deny !== undefined || ran.isError === true) {
          return
        }
        const result = (typeof ran.result === 'object' && ran.result !== null ? ran.result : {}) as Loose
        const file = changedFile(tool, input, result)
        const hasSteps = isMain && isTaskTool(tool)
        if (file !== null || hasSteps) {
          await update($, run, current =>
            current?.status === 'running'
              ? { ...current, files: file === null ? current.files : addFile(current.files, file), hasSteps: current.hasSteps || hasSteps }
              : current,
          )
        }
        if (hasSteps) {
          // 지금 값에 덧대어 쓴다. 함께 도는 호출들이 서로의 줄을 지우지 않는다.
          await update($, steps, current => applyTaskTool(current, tool, input, result))
        }
      })

      return ran
    } finally {
      // 호출이 실패해 던져도 제 줄은 지운다. 함께 도는 다른 호출의 줄은 둔다.
      if (isMain) {
        await quiet(() => update($, run, current => (current === null ? current : endActivity(current, id))))
      }
    }
  })

  on('turn.complete', async ($, e, next) => {
    // 하위 에이전트의 턴은 패널을 바꾸지 않는다 (R-1).
    if (isActive && e.agentId === undefined) {
      let endedAt: number | null = null
      await quiet(async () => {
        const at = await $.clock.now()
        const current = await read($, run)
        // 뒤에 시작한 턴의 기록이면 이 턴의 것이 아니다. 건드리지 않는다.
        const mine = current !== null && current.turnId === e.turnId ? current : null
        const ended = endTurn(
          { turnId: e.turnId, reason: e.reason, answer: e.answer, endedAt: at, durationMs: e.durationMs },
          mine,
          await read($, request),
          await read($, history),
        )
        await update($, history, () => ended.history)
        await update($, run, live => (live !== null && live.turnId !== e.turnId ? live : ended.run))
        await update($, now, () => at)
        await update($, view, () => null)
        await update($, isEditing, () => false)
        if (e.reason === 'answer') {
          endedAt = at
          await update($, picked, () => null)
          if (isAllDone(await read($, steps))) {
            await update($, steps, () => [])
          }
        }
      })
      // 패널 열기와 경로·저장소 찾기는 기다리지 않는다. 느린 파일 시스템이 턴의 끝을 붙잡지 않는다 (R-23).
      void quiet(() => showPane($))
      const at = endedAt as number | null
      if (at !== null) {
        void quiet(() => enrich($, at, e.answer))
        // 첫 제안을 입력란의 흐린 제안으로 띄운다. Tab으로 받으면 입력란에 채워진다 (R-30).
        void quiet(async () => {
          ghost = (await read($, isOff)) ? null : ghostOf(e.answer)
          if (ghost !== null) {
            await $.prompt.suggest({ text: ghost })
          }
        })
      }
    }

    return next(e)
  })

  // 엔진이 스스로 짐작한 흐린 제안은 첫 제안으로 바꿔 넣는다. 모드를 끄면 엔진의 짐작을 그대로 둔다 (R-30).
  on('prompt.suggest', async ($, e, next) => {
    const mine = ghost
    if (isActive && mine !== null && e.origin.kind === 'suggestion') {
      let isOn = false
      await quiet(async () => {
        isOn = !(await read($, isOff))
      })
      if (isOn) {
        return next({ ...e, text: mine })
      }
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const isShown = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
    if (arg === 'off') {
      await update($, isOff, () => true)
      await update($, isPaneUp, () => false)
      $.ui.status(undefined)
      if (isShown) {
        await $.ui.close({ id: PANE })
      }

      return { text: '턴 패널을 껐다. 이 세션에서는 패널이 열리지 않고, 답변 끝의 제안 블록도 쓰지 않는다. /turn-panel on 으로 다시 켠다.' }
    }
    if (arg !== '' && arg !== 'on') {
      return { text: USAGE }
    }
    // 인자 없이 쳤는데 열려 있으면 닫는다 (R-18).
    if (arg === '' && isShown && !(await read($, isOff))) {
      await update($, isClosed, () => true)
      await update($, isPaneUp, () => false)
      await $.ui.close({ id: PANE })

      return { text: '턴 패널을 닫았다. 다시 열 때까지 스스로 열리지 않는다. 답변 끝의 제안 블록은 계속 쓴다.' }
    }
    // 여는 것은 켜는 것이기도 하다: 꺼 둔 세션에서 패널을 열면 기능도 돌아온다.
    const wasOff = await read($, isOff)
    await update($, isOff, () => false)
    await update($, isClosed, () => false)
    // 입력란이 비어 있으면 패널이 키보드를 쥔 채 열린다. 아니면 ctrl+x tab으로 간다.
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true, columns: COLUMNS })
    await update($, isPaneUp, () => opened.isPlaced)
    $.ui.status(undefined)
    // 명령의 답은 모델도 읽는다. 껐다는 글을 읽은 모델이 켠 뒤에도 제안을 빼먹지 않게, 돌아왔다고 분명히 적는다.
    const done = wasOff ? '턴 패널을 켰다. 이제부터 다시 답변 끝에 제안 블록을 쓴다.' : '턴 패널을 열었다.'

    return { text: opened.isPlaced ? done : `${done} 다만 패널을 놓지 못했다: ${opened.reason}` }
  })

  // 패널이 닫힌다. 사용자가 닫기 표시나 닫기 키로 닫았으면 다시 열 때까지 스스로 열지 않는다.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    await quiet(async () => {
      await update($, isPaneUp, () => false)
      if (e.origin.kind === 'person') {
        await update($, isClosed, () => true)
      }
    })

    return next(e)
  })

  // 대화 화면에서는 제안 블록을 빼고 그린다. 저장된 답변은 그대로다 (R-10).
  // 가리는 것은 패널이 대신 보여 줄 때뿐이다: 패널이 놓여 있고, 그 답변이 패널의 기록에 든 턴의 최종 답변일 때.
  // 도구 호출 사이의 중간 글이나 기록에 들지 않은 답변의 블록은 패널 어디에도 안 보이므로 그대로 둔다.
  // 닫히지 않은 블록은 턴이 도는 동안(아직 쓰는 중)만 가린다.
  // 상태를 읽으므로 패널이 닫히거나 열리고, 턴이 끝나 기록이 바뀌면 이미 그린 답변도 다시 그려진다.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!isActive || e.props.isSummary === true) {
      return next(e)
    }
    const isStreaming = (await read($, run))?.status === 'running'
    const text = stripNext(e.props.text, isStreaming)
    if (text === e.props.text || !(await read($, isPaneUp))) {
      return next(e)
    }
    const shown = e.props.text.trimEnd()
    const isRecorded = (await read($, history)).some(turn => turn.answer.trimEnd().endsWith(shown))
    const isUnclosed = !shown.endsWith('```')

    return isRecorded || (isStreaming && isUnclosed) ? next({ ...e, props: { ...e.props, text } }) : next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    inCmux ??= await isInCmux($)

    return Panel(
      $.ui.resolve(e),
      {
        history: await read($, history),
        run: await read($, run),
        steps: await read($, steps),
        view: await read($, view),
        picked: await read($, picked),
        isEditing: await read($, isEditing),
        now: await read($, now),
        cwd: await read($, cwd),
        isFocused: e.props.isFocused,
        // 모드가 여는 브라우저 칸과 편집기는 세션이 도는 맥에 뜬다. 원격 화면에서는 보는 쪽이 링크를 열게 둔다 (R-28).
        canOpenWeb: inCmux && e.surface === 'terminal',
        isTerminal: e.surface === 'terminal',
      },
      {
        onPick: suggestion => act($, () => pick($, suggestion)),
        onMove: step => act($, () => move($, step)),
        onEdit: () => act($, () => update($, isEditing, editing => !editing)),
        onOpenWeb: url => act($, () => openWeb($, url)),
        onOpenFile: (path, line) => act($, () => openFile($, editor, path, line)),
      },
    )
  })
}
