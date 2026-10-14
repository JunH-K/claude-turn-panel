import { expect, test } from 'claude-code/testing'

import { INSTRUCTION, ghostOf } from '../hooks/nextBlock'
import { restoreTurns } from '../hooks/record'
import { mountPane, runCommand, turn, world } from './world'

const block = (...lines: string[]): string => ['고쳤다.', '', '```next', ...lines, '```'].join('\n')

test('첫 제안의 요청 글을 흐린 제안으로 띄운다. 슬래시 명령이면 띄우지 않는다 (R-30)', () => {
  expect(ghostOf(block('확인 | 실기기는 안 봤다 => 시뮬레이터에서 확인해줘', '커밋 | 안 했다 => 커밋해줘'))).toBe('시뮬레이터에서 확인해줘')
  expect(ghostOf(block('리뷰 | 인증을 건드렸다 => /review 12'))).toBeNull()
  expect(ghostOf('제안 없는 답')).toBeNull()
})

test('턴이 끝나면 첫 제안을 입력란의 흐린 제안으로 띄운다 (R-30)', async ($, on) => {
  const seen = await world($, on)
  await turn($, '고쳐줘', block('확인 | 실기기는 안 봤다 => 시뮬레이터에서 확인해줘'))

  expect(seen.suggested.at(-1)).toBe('시뮬레이터에서 확인해줘')
})

test('엔진이 짐작한 흐린 제안을 첫 제안으로 바꿔 넣고, 끄면 그대로 둔다 (R-30)', async ($, on) => {
  const seen = await world($, on)
  await turn($, '고쳐줘', block('확인 | 실기기는 안 봤다 => 시뮬레이터에서 확인해줘'))

  await $.prompt.suggest({ text: '엔진의 짐작', origin: { kind: 'suggestion' } } as never)
  expect(seen.suggested.at(-1)).toBe('시뮬레이터에서 확인해줘')

  await runCommand($, 'off')
  await $.prompt.suggest({ text: '엔진의 짐작', origin: { kind: 'suggestion' } } as never)
  expect(seen.suggested.at(-1)).toBe('엔진의 짐작')
})

test('끈 세션과 슬래시 명령 제안은 흐린 제안을 띄우지 않는다 (R-30, R-19)', async ($, on) => {
  const seen = await world($, on)
  await turn($, '봐줘', block('리뷰 | 인증을 건드렸다 => /review 12'))
  expect(seen.suggested).toEqual([])

  await runCommand($, 'off')
  await turn($, '고쳐줘', block('확인 | 실기기는 안 봤다 => 시뮬레이터에서 확인해줘'))
  expect(seen.suggested).toEqual([])
})

test('지시문은 질문으로 끝난 답에도 답 고르기 블록을 쓰게 하고, 되돌리기 어려운 승인은 빼게 한다 (R-31)', () => {
  expect(INSTRUCTION).toContain('질문하고 답을 기다리며 끝내는 답변에도 블록을 쓴다')
  expect(INSTRUCTION).toContain('push, 배포, 삭제, 외부 전송을 승인하는 답은 넣지 않는다')
  expect(INSTRUCTION).not.toContain('사용자에게 질문하고 답을 기다리는 답변, 그리고')
})

const SAVED = [
  { role: 'user', text: '로그인 버그 고쳐줘', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 't1', tool: 'Edit', input: { file_path: '/work/app/src/a.ts' }, result: { filePath: '/work/app/src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok' }] },
  { role: 'assistant', text: '고쳤다. #12 참고', toolUses: [] },
  { role: 'user', text: '<command-name>/model</command-name>', toolUses: [] },
  { role: 'user', text: '[Request interrupted by user]', toolUses: [] },
  { role: 'user', text: '테스트도 돌려줘', toolUses: [] },
  { role: 'assistant', text: '돌렸다. 모두 통과.', toolUses: [] },
  { role: 'user', text: '중단된 요청', toolUses: [] },
] as const

test('저장된 대화에서 사람이 친 요청과 그 턴의 마지막 답을 턴으로 되살린다 (R-32)', () => {
  const turns = restoreTurns(SAVED as never)

  expect(turns.map(turn => [turn.request, turn.answer])).toEqual([
    ['로그인 버그 고쳐줘', '고쳤다. #12 참고'],
    ['테스트도 돌려줘', '돌렸다. 모두 통과.'],
  ])
  expect(turns[0]?.files).toEqual([{ path: '/work/app/src/a.ts', isNew: false }])
  expect(turns.every(turn => turn.isRestored === true)).toBe(true)
  expect(restoreTurns([])).toEqual([])
})

test('다시 연 세션은 패널에 지난 턴을 "이전 실행"으로 보인다 (R-32)', async ($, on) => {
  await world($, on, { messages: [...SAVED] })
  const pane = await mountPane($)

  expect(await pane.find({ type: 'Text', text: '테스트도 돌려줘' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '이전 실행' })).toBeDefined()
  expect((await pane.find({ key: 'report' }))?.text).toContain('돌렸다. 모두 통과.')
})
