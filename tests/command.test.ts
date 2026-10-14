import type { RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { SECTION_ID } from '../hooks/nextBlock'
import { mountPane, runCommand, turn, world } from './world'

const COMPOSE = {
  model: 'claude-opus',
  promptModel: 'claude-opus',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
} as const

test('명령으로 여닫고, 닫은 뒤에는 스스로 열리지 않는다 (R-18, R-20)', async ($, on) => {
  const seen = await world($, on)
  await turn($, '첫 요청', '첫 보고')
  expect(seen.opened).toBe(1)

  // 닫아도 제안은 계속 쓴다고 알린다. 모델이 닫았다는 글만 읽고 제안을 빼먹지 않게 한다.
  expect(await runCommand($)).toContain('제안 블록은 계속 쓴다')
  expect(seen.closed).toBe(1)
  await turn($, '둘째 요청', '둘째 보고')
  expect(seen.opened).toBe(1)

  expect(await runCommand($)).toContain('열었다')
  expect(seen.opened).toBe(2)
  // 명령으로 열 때는 키보드 초점을 함께 달라고 한다.
  expect(seen.askedFocus).toBe(true)

  // 닫기 표시 등으로 패널이 사라졌어도 사용자가 닫은 것이 아니면 다음 턴에 다시 연다.
  seen.closed += 1
  await turn($, '셋째 요청', '셋째 보고')
  expect(seen.opened).toBe(3)
  // 스스로 열 때는 초점을 달라고 하지 않는다. 치던 글을 방해하지 않는다.
  expect(seen.askedFocus).toBe(false)
})

test('좁아서 놓이지 못하면 상태 줄에 여는 명령을 알린다 (R-20)', async ($, on) => {
  const seen = await world($, on, { isPlaced: false })
  await turn($, '요청', '보고')

  expect(seen.statuses.at(-1)).toContain('/turn-panel')
})

test('켜져 있으면 시스템 프롬프트에 제안 블록 지시문이 붙는다 (R-9)', async ($, on) => {
  await world($, on)
  const composed = await $.prompt.compose(COMPOSE)

  expect(composed.sections.map(section => section.id)).toEqual(['intro', SECTION_ID])
  expect(composed.sections.at(-1)?.scope).toBe('session')
  expect(composed.sections.at(-1)?.text).toContain('```next')
  expect(composed.sections.at(-1)?.text).toContain('근거')
})

test('off는 패널을 닫고 지시문을 빼고 스스로 열지 않는다. on은 되돌린다 (R-19)', async ($, on) => {
  const seen = await world($, on)
  await turn($, '첫 요청', '첫 보고')

  expect(await runCommand($, 'off')).toContain('껐다')
  expect(seen.closed).toBe(1)
  expect((await $.prompt.compose(COMPOSE)).sections.map(section => section.id)).toEqual(['intro'])
  await turn($, '둘째 요청', '둘째 보고')
  expect(seen.opened).toBe(1)

  // 명령의 답은 모델도 읽는다. 껐다는 글 뒤에 제안이 돌아왔다고 분명히 적는다.
  expect(await runCommand($, 'on')).toContain('다시 답변 끝에 제안 블록을 쓴다')
  expect(seen.opened).toBe(2)
  expect((await $.prompt.compose(COMPOSE)).sections.map(section => section.id)).toEqual(['intro', SECTION_ID])
})

test('꺼 둔 세션에서 인자 없이 치면 켜면서 연다 (R-19)', async ($, on) => {
  const seen = await world($, on)
  await runCommand($, 'off')
  expect(await runCommand($)).toContain('켰다')

  expect(seen.opened).toBe(1)
  expect((await $.prompt.compose(COMPOSE)).sections).toHaveLength(2)
})

test('모르는 인자에는 쓰는 법을 알린다', async ($, on) => {
  const seen = await world($, on)

  expect(await runCommand($, 'what')).toContain('쓰는 법')
  expect(seen.opened).toBe(0)
})

test('화면 없는 실행과 팀원 에이전트에는 지시문을 넣지 않는다 (R-22)', async ($, on) => {
  await world($, on)

  expect((await $.prompt.compose({ ...COMPOSE, traits: ['print'] })).sections).toHaveLength(1)
  expect((await $.prompt.compose({ ...COMPOSE, surfaces: [] })).sections).toHaveLength(1)
  expect((await $.prompt.compose({ ...COMPOSE, traits: ['teammate'] })).sections).toHaveLength(1)
})

test('대화 화면에서는 답변의 제안 블록을 빼고 그린다 (R-10)', async ($, on) => {
  const drawn: string[] = []
  // 엔진의 답변 그리기 자리에 선다. 모드가 고쳐 넘긴 글을 적는다.
  on('ui.render', { component: 'AssistantMessage' }, ($$, e) => {
    drawn.push(e.props.text)
    const { Text } = $$.ui.resolve(e)

    return h(Text, null, e.props.text) as RenderElement
  })
  await world($, on)
  const withBlock = '고쳤다.\n\n```next\n가 | 근거 => 가 해줘\n```'
  const broken = '고쳤다.\n\n```next\n화살표 없는 줄\n```'
  const draw = async (text: string): Promise<string | undefined> => {
    await $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: `m${drawn.length}`, props: { isFirstOfReply: true, text } } as never)

    return drawn.at(-1)
  }

  // 패널이 아직 없으면 가리지 않는다. 가린 글을 대신 보여 줄 곳이 없다.
  expect(await draw(withBlock)).toBe(withBlock)

  await turn($, '요청', withBlock)
  expect(await draw(withBlock)).toBe('고쳤다.')
  expect(await draw('블록 없는 답')).toBe('블록 없는 답')
  // 패널이 선택창으로 옮기지 못하는 블록은 그대로 둔다.
  expect(await draw(broken)).toBe(broken)
  // 패널의 기록에 들지 않은 글(도구 호출 사이의 중간 글 등)의 블록은 패널 어디에도 안 보이므로 그대로 둔다.
  const other = '중간 글.\n\n```next\n나 | 근거 => 나 해줘\n```'
  expect(await draw(other)).toBe(other)

  // 패널을 닫으면 다시 가리지 않는다.
  await runCommand($)
  expect(await draw(withBlock)).toBe(withBlock)
  await runCommand($)
  expect(await draw(withBlock)).toBe('고쳤다.')

  await runCommand($, 'off')
  expect(await draw(withBlock)).toBe(withBlock)
})

test('패널을 놓지 못한 세션에서는 제안 블록을 가리지 않는다 (R-10)', async ($, on) => {
  const drawn: string[] = []
  on('ui.render', { component: 'AssistantMessage' }, ($$, e) => {
    drawn.push(e.props.text)
    const { Text } = $$.ui.resolve(e)

    return h(Text, null, e.props.text) as RenderElement
  })
  await world($, on, { isPlaced: false })
  const text = '고쳤다.\n\n```next\n가 | 근거 => 가 해줘\n```'
  await turn($, '요청', text)
  await $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: 'm1', props: { isFirstOfReply: true, text } } as never)

  expect(drawn).toEqual([text])
})

test('좁아서 못 놓였다가 놓인 뒤에는 상태 줄 안내를 지운다 (R-20)', async ($, on) => {
  const seen = await world($, on, { isPlaced: false })
  await turn($, '첫 요청', '첫 보고')
  expect(seen.statuses.at(-1)).toContain('/turn-panel')

  // 터미널이 넓어져 엔진이 패널을 놓았다.
  seen.isPlaced = true
  await turn($, '둘째 요청', '둘째 보고')
  expect(seen.statuses.at(-1)).toBeUndefined()
})

test('화면 없는 실행에서는 아무 일도 하지 않는다 (R-22)', async ($, on) => {
  const seen = await world($, on, { isInteractive: false })
  await turn($, '요청', '보고.\n\n```next\n가 | 근거 => 가 해줘\n```')

  expect(seen.opened).toBe(0)
  expect(seen.calls).toEqual([])
  expect((await $.prompt.compose(COMPOSE)).sections).toHaveLength(1)
})

test('/clear 는 패널의 기록도 비운다', async ($, on) => {
  await world($, on)
  await turn($, '첫 요청', '첫 보고')
  await $.session.end({ reason: 'clear', sessionId: 'session-1' } as never)
  const pane = await mountPane($)

  expect(await pane.find({ type: 'Text', text: /아직 끝난 턴이 없다/ })).toBeDefined()
})
