import { changedFile } from './progress'
import type { Loose } from './progress'
import type { Activity, ChangedFile, FoundPaths, Run, RunStatus, Turn } from '../types'

// 사람이 낸 요청의 출처. 나머지(task-notification, scheduled-trigger, peer, channel …)는
// 엔진이나 다른 세션이 넣는 글이라 "마지막 요청"으로 치지 않는다.
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])

export const MAX_TURNS = 20

/**
 * 사람이 낸 요청인가 (R-1). 플러그인이 낸 글은 이 모드가 낸 것(패널에서 고른 제안)만 친다.
 * 다른 플러그인이 스스로 넣는 글(자동으로 이어 돌리는 훅 등)은 사람의 요청이 아니다.
 */
export function isPersonRequest(origin: { kind: string; name?: string }, self: string): boolean {
  return origin.kind === 'plugin' ? origin.name === self : PERSON_ORIGINS.has(origin.kind)
}

export function startRun(turnId: string, request: string, startedAt: number): Run {
  return { turnId, request, status: 'running', startedAt, durationMs: null, activities: [], files: [], hasSteps: false }
}

export type TurnEnd = { history: Turn[]; run: Run | null }

export type Ended = {
  turnId: string
  reason: 'answer' | Exclude<RunStatus, 'running'>
  answer: string
  endedAt: number
  durationMs: number
}

/**
 * 본 세션 턴 하나가 끝났을 때 기억할 값.
 * 정상 종료만 기록에 더한다. 중단·오류·거절은 상태만 남기고 기록을 그대로 둔다 (R-2, R-5).
 */
export function endTurn(ended: Ended, run: Run | null, request: string, history: Turn[]): TurnEnd {
  // 요청 없이 시작한 턴(백그라운드 작업 완료 뒤의 이어 돌기)은 run.request가 직전 요청이다.
  const asked = run?.request ?? request
  if (ended.reason === 'answer') {
    const turn: Turn = {
      request: asked,
      answer: ended.answer,
      endedAt: ended.endedAt,
      durationMs: ended.durationMs,
      files: run?.files ?? [],
      // 경로와 저장소는 턴이 끝난 뒤에 찾아 덧쓴다. 찾는 일이 턴의 끝을 붙잡지 않게 한다.
      paths: {},
      repo: null,
    }

    return { history: [...history, turn].slice(-MAX_TURNS), run: null }
  }
  const failed: Run = {
    ...(run ?? startRun(ended.turnId, asked, ended.endedAt - ended.durationMs)),
    status: ended.reason,
    durationMs: ended.durationMs,
    activities: [],
  }

  return { history, run: failed }
}

export type Clipped = { lines: string[]; hidden: number }

const MAX_REQUEST_LINES = 8

/** 엔터로 나눠 쓴 요청을 그릴 줄로 정리한다: 줄바꿈은 살리고, 이어진 빈 줄은 하나로, 길면 접는다 (R-4). */
export function requestLines(text: string, max: number = MAX_REQUEST_LINES): Clipped {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line === '' && (lines.length === 0 || lines.at(-1) === '')) {
      continue
    }
    lines.push(line)
  }
  while (lines.at(-1) === '') {
    lines.pop()
  }
  if (lines.length <= max) {
    return { lines, hidden: 0 }
  }

  return { lines: lines.slice(0, max), hidden: lines.length - max }
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 걸린 시간: "38초", "2분 14초", "1시간 5분" (R-5). */
export function tookText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) {
    return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}분 ${seconds}초` : `${minutes}분`
  }

  return `${seconds}초`
}

/** 끝난 지 얼마나 됐는가: "방금", "3분 전", "2시간 전", "3일 전" (R-5). */
export function agoText(endedAt: number, now: number): string {
  const passed = Math.max(0, now - endedAt)
  if (passed < MINUTE) {
    return '방금'
  }
  if (passed < HOUR) {
    return `${Math.floor(passed / MINUTE)}분 전`
  }
  if (passed < DAY) {
    return `${Math.floor(passed / HOUR)}시간 전`
  }

  return `${Math.floor(passed / DAY)}일 전`
}

const STATUS_WORDS: Record<Exclude<RunStatus, 'running'>, string> = {
  aborted: '중단됨',
  error: '오류',
  refusal: '모델이 거절함',
}

/** 정상 종료하지 못한 턴의 상태 말 (R-5). */
export function failedText(status: Exclude<RunStatus, 'running'>): string {
  return STATUS_WORDS[status]
}

/** 끝난 턴에 뒤늦게 찾은 경로와 저장소를 덧쓴다 (R-14). 그 턴이 이미 기록에서 밀려났으면 그대로다. */
export function enrichTurn(history: Turn[], endedAt: number, answer: string, paths: FoundPaths, repo: string | null): Turn[] {
  return history.map(turn => (turn.endedAt === endedAt && turn.answer === answer ? { ...turn, paths, repo } : turn))
}

/** 도구 호출이 시작했다: 그 줄을 더한다. 같은 id가 다시 오면 덧쓴다 (R-6). */
export function beginActivity(run: Run, activity: Activity): Run {
  return { ...run, activities: [...run.activities.filter(one => one.id !== activity.id), activity] }
}

/** 도구 호출이 끝났다: 그 호출의 줄만 지운다. 함께 도는 다른 호출의 줄은 둔다 (R-6). */
export function endActivity(run: Run, id: string): Run {
  return { ...run, activities: run.activities.filter(one => one.id !== id) }
}

/** 같은 파일은 한 번만 적는다. 새로 만든 파일이라는 표시는 한 번 붙으면 남는다 (R-8). */
export function addFile(files: ChangedFile[], file: ChangedFile): ChangedFile[] {
  const found = files.find(one => one.path === file.path)
  if (found === undefined) {
    return [...files, file]
  }

  return found.isNew || !file.isNew ? files : files.map(one => (one.path === file.path ? { ...one, isNew: true } : one))
}

/**
 * 넘겨 볼 자리 (R-16). 기록의 턴들 뒤에, 도는 턴이나 정상 종료하지 못한 턴이 있으면 그 자리가 하나 더 있다.
 * `view`가 null이면 맨 끝이다.
 */
export type Seat = { at: number; total: number; isLive: boolean }

export function seatOf(view: number | null, historyLength: number, hasRun: boolean): Seat {
  const total = historyLength + (hasRun ? 1 : 0)
  const last = Math.max(0, total - 1)
  const at = view === null ? last : Math.min(last, Math.max(0, view))

  return { at, total, isLive: hasRun && at === historyLength }
}

/** `p`·`n`으로 옮긴 뒤의 `view`. 맨 끝에 닿으면 null(최신을 따라간다)로 돌린다. */
export function moveView(view: number | null, step: -1 | 1, historyLength: number, hasRun: boolean): number | null {
  const seat = seatOf(view, historyLength, hasRun)
  const next = Math.min(Math.max(0, seat.total - 1), Math.max(0, seat.at + step))

  return next >= seat.total - 1 ? null : next
}

/** 저장된 대화의 한 줄. `$.session.messages()`가 주는 모양에서 쓰는 것만 (R-32). */
export type PastMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly { tool: string; input: Record<string, unknown>; result?: unknown }[]
  toolResults?: readonly unknown[]
}

// 사람이 친 요청인가. 도구 결과, 명령 출력·안내, 중단 표시는 아니다.
function isTypedRequest(message: PastMessage): boolean {
  const text = message.text.trim()

  return (
    message.role === 'user' &&
    text !== '' &&
    (message.toolResults?.length ?? 0) === 0 &&
    !text.startsWith('<') &&
    !text.startsWith('[Request interrupted') &&
    !text.startsWith('Caveat:')
  )
}

function looseOf(value: unknown): Loose {
  return typeof value === 'object' && value !== null ? (value as Loose) : {}
}

/**
 * 저장된 대화에서 최근 턴들을 되살린다 (R-32). 사람이 친 요청 하나가 턴 하나이고, 그 턴의 마지막 답 글이 보고다.
 * 답 글 없이 끝난 턴(중단 등)은 뺀다. 끝난 시각과 걸린 시간은 대화에 없어 0으로 두고 `isRestored`로 표시한다.
 */
export function restoreTurns(messages: readonly PastMessage[]): Turn[] {
  const turns: Turn[] = []
  let current: { request: string; answer: string; files: ChangedFile[] } | null = null
  const close = (): void => {
    if (current !== null && current.answer.trim() !== '') {
      turns.push({ request: current.request, answer: current.answer, endedAt: 0, durationMs: 0, files: current.files, paths: {}, repo: null, isRestored: true })
    }
  }
  for (const message of messages) {
    if (isTypedRequest(message)) {
      close()
      current = { request: message.text.trim(), answer: '', files: [] }
      continue
    }
    if (current === null || message.role !== 'assistant') {
      continue
    }
    if (message.text.trim() !== '') {
      current.answer = message.text
    }
    for (const use of message.toolUses) {
      const file = changedFile(use.tool, looseOf(use.input), looseOf(use.result))
      if (file !== null) {
        current.files = addFile(current.files, file)
      }
    }
  }
  close()

  return turns.slice(-MAX_TURNS)
}
