import { expect, test } from 'claude-code/testing'

import {
  MAX_TURNS,
  addFile,
  agoText,
  beginActivity,
  endActivity,
  endTurn,
  enrichTurn,
  isPersonRequest,
  moveView,
  requestLines,
  seatOf,
  startRun,
  tookText,
} from '../hooks/record'
import type { Ended } from '../hooks/record'
import type { Turn } from '../types'

const DONE: Ended = { turnId: 't1', reason: 'answer', answer: '보고', endedAt: 5000, durationMs: 2000 }

function past(count: number): Turn[] {
  return Array.from({ length: count }, (_, index) => ({
    request: `요청 ${index}`,
    answer: `보고 ${index}`,
    endedAt: index,
    durationMs: 1,
    files: [],
    paths: {},
    repo: null,
  }))
}

test('사람이 낸 글과 이 모드가 낸 글만 요청으로 친다 (R-1)', () => {
  expect(isPersonRequest({ kind: 'composer' }, 'turn-panel')).toBe(true)
  expect(isPersonRequest({ kind: 'plugin', name: 'turn-panel' }, 'turn-panel')).toBe(true)
  expect(isPersonRequest({ kind: 'plugin', name: 'other' }, 'turn-panel')).toBe(false)
  expect(isPersonRequest({ kind: 'task-notification' }, 'turn-panel')).toBe(false)
})

test('정상 종료한 턴은 요청·보고·바뀐 파일과 함께 기록에 더한다 (R-2)', () => {
  const run = { ...startRun('t1', '고쳐줘', 3000), files: [{ path: '/work/app/a.ts', isNew: true }] }
  const ended = endTurn(DONE, run, '고쳐줘', [])

  expect(ended.run).toBeNull()
  expect(ended.history).toEqual([
    { request: '고쳐줘', answer: '보고', endedAt: 5000, durationMs: 2000, files: [{ path: '/work/app/a.ts', isNew: true }], paths: {}, repo: null },
  ])
})

test('기록은 최근 20턴만 둔다 (R-2)', () => {
  const ended = endTurn(DONE, startRun('t1', '새 요청', 0), '새 요청', past(MAX_TURNS))

  expect(ended.history).toHaveLength(MAX_TURNS)
  expect(ended.history[0]?.request).toBe('요청 1')
  expect(ended.history.at(-1)?.request).toBe('새 요청')
})

test('중단·오류·거절은 상태만 남기고 기록을 그대로 둔다 (R-5)', () => {
  const history = past(2)
  for (const reason of ['aborted', 'error', 'refusal'] as const) {
    const running = beginActivity(startRun('t1', '하다 만 요청', 3000), { id: 'c1', label: '명령 실행 중', target: 'npm test' })
    const ended = endTurn({ ...DONE, reason }, running, '하다 만 요청', history)

    expect(ended.history).toBe(history)
    // 끝난 턴에는 도는 호출이 없다.
    expect(ended.run).toMatchObject({ request: '하다 만 요청', status: reason, durationMs: 2000, activities: [] })
  }
})

test('겹쳐 도는 도구 호출은 저마다 줄을 갖고, 끝난 호출의 줄만 지운다 (R-6)', () => {
  let run = startRun('t1', '요청', 0)
  run = beginActivity(run, { id: 'bash', label: '명령 실행 중', target: 'npm test' })
  run = beginActivity(run, { id: 'read', label: '파일 읽는 중', target: 'a.ts' })
  expect(run.activities.at(-1)?.id).toBe('read')

  // 뒤에 시작한 호출이 먼저 끝나도 아직 도는 호출의 줄은 남는다.
  run = endActivity(run, 'read')
  expect(run.activities).toEqual([{ id: 'bash', label: '명령 실행 중', target: 'npm test' }])
  run = endActivity(run, 'bash')
  expect(run.activities).toEqual([])
  // 모르는 id를 지워도 터지지 않는다.
  expect(endActivity(run, 'none').activities).toEqual([])
})

test('끝난 턴에 뒤늦게 찾은 경로와 저장소를 덧쓴다. 다른 턴은 건드리지 않는다 (R-14)', () => {
  const history = past(3)
  const paths = { 'src/a.ts': '/work/app/src/a.ts' }
  const enriched = enrichTurn(history, 1, '보고 1', paths, 'acme/app')

  expect(enriched[1]).toMatchObject({ paths, repo: 'acme/app' })
  expect(enriched[0]).toBe(history[0])
  expect(enriched[2]).toBe(history[2])
  // 그 턴이 이미 기록에서 밀려났으면 그대로다.
  expect(enrichTurn(history, 99, '없는 보고', paths, 'acme/app')).toEqual(history)
})

test('요청 없이 시작한 턴은 직전 요청을 쓴다', () => {
  expect(endTurn(DONE, null, '직전 요청', []).history[0]?.request).toBe('직전 요청')
})

test('요청 글은 줄바꿈을 살리고 이어진 빈 줄을 하나로 줄이며, 길면 접는다 (R-4)', () => {
  expect(requestLines('첫 줄\n\n둘째 줄\n\n\n셋째 줄\n\n')).toEqual({ lines: ['첫 줄', '', '둘째 줄', '', '셋째 줄'], hidden: 0 })
  expect(requestLines('\n\n한 줄  \n')).toEqual({ lines: ['한 줄'], hidden: 0 })
  expect(requestLines('')).toEqual({ lines: [], hidden: 0 })

  const long = requestLines(Array.from({ length: 12 }, (_, index) => `줄 ${index + 1}`).join('\n'))
  expect(long.lines).toHaveLength(8)
  expect(long.hidden).toBe(4)
})

test('걸린 시간과 지난 시간을 말로 적는다 (R-5)', () => {
  expect(tookText(900)).toBe('0초')
  expect(tookText(38_000)).toBe('38초')
  expect(tookText(134_000)).toBe('2분 14초')
  expect(tookText(120_000)).toBe('2분')
  expect(tookText(3_900_000)).toBe('1시간 5분')
  expect(tookText(-5)).toBe('0초')

  expect(agoText(1000, 30_000)).toBe('방금')
  expect(agoText(0, 180_000)).toBe('3분 전')
  expect(agoText(0, 2 * 3_600_000)).toBe('2시간 전')
  expect(agoText(0, 3 * 86_400_000)).toBe('3일 전')
  // 시계가 뒤로 간 것처럼 보여도 음수를 내지 않는다.
  expect(agoText(5000, 1000)).toBe('방금')
})

test('같은 파일은 한 번만 적고, 새 파일 표시는 한 번 붙으면 남는다 (R-8)', () => {
  const once = addFile([], { path: '/a.ts', isNew: true })
  const twice = addFile(once, { path: '/a.ts', isNew: false })
  const other = addFile(twice, { path: '/b.ts', isNew: false })

  expect(twice).toEqual([{ path: '/a.ts', isNew: true }])
  expect(other).toHaveLength(2)
  expect(addFile([{ path: '/c.ts', isNew: false }], { path: '/c.ts', isNew: true })).toEqual([{ path: '/c.ts', isNew: true }])
})

test('넘겨 볼 자리는 기록 뒤에 도는 턴의 자리가 하나 더 있다 (R-16)', () => {
  expect(seatOf(null, 0, false)).toEqual({ at: 0, total: 0, isLive: false })
  expect(seatOf(null, 3, false)).toEqual({ at: 2, total: 3, isLive: false })
  expect(seatOf(null, 3, true)).toEqual({ at: 3, total: 4, isLive: true })
  expect(seatOf(1, 3, true)).toEqual({ at: 1, total: 4, isLive: false })
  // 기록이 줄어 자리가 사라졌으면 맨 끝으로 당긴다.
  expect(seatOf(9, 3, false)).toEqual({ at: 2, total: 3, isLive: false })
})

test('p와 n은 끝에서 멈추고, 맨 끝에 닿으면 최신을 따라간다 (R-16)', () => {
  expect(moveView(null, -1, 3, false)).toBe(1)
  expect(moveView(1, -1, 3, false)).toBe(0)
  expect(moveView(0, -1, 3, false)).toBe(0)
  expect(moveView(1, 1, 3, false)).toBeNull()
  expect(moveView(null, 1, 3, false)).toBeNull()
  expect(moveView(null, -1, 3, true)).toBe(2)
  expect(moveView(null, -1, 0, false)).toBeNull()
})
