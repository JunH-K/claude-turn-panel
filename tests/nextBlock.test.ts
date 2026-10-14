import { expect, test } from 'claude-code/testing'

import { asCommand, splitNext, stripNext, wantsNextBlock } from '../hooks/nextBlock'

const BLOCK = ['```next', '커밋하기 | 고친 파일 3개가 커밋되지 않았다 => 방금 고친 것을 커밋해줘', '실기기 확인 => 시뮬레이터에서 확인해줘', '```'].join('\n')

test('답변 끝의 블록을 문구·근거·요청 글로 읽는다 (R-9)', () => {
  const split = splitNext(`버그를 고쳤다.\n\n${BLOCK}`)

  expect(split.body).toBe('버그를 고쳤다.')
  expect(split.extra).toBe(0)
  expect(split.suggestions).toEqual([
    { label: '커밋하기', reason: '고친 파일 3개가 커밋되지 않았다', text: '방금 고친 것을 커밋해줘' },
    // 근거가 없는 줄도 받는다.
    { label: '실기기 확인', reason: '', text: '시뮬레이터에서 확인해줘' },
  ])
})

test('세 줄을 넘으면 앞의 세 줄만 쓴다 (R-9)', () => {
  const lines = [1, 2, 3, 4, 5].map(n => `문구${n} | 근거${n} => 요청${n}`)
  const split = splitNext(`끝.\n\n\`\`\`next\n${lines.join('\n')}\n\`\`\``)

  expect(split.suggestions.map(one => one.label)).toEqual(['문구1', '문구2', '문구3'])
  // 선택창에 들지 못한 제안이 있다는 것은 알린다.
  expect(split.extra).toBe(2)
})

test('요청 글 안의 => 와 | 는 글의 일부다', () => {
  const split = splitNext('끝.\n\n```next\n고치기 | 근거 => a => b | c 로 바꿔줘\n```')

  expect(split.suggestions).toEqual([{ label: '고치기', reason: '근거', text: 'a => b | c 로 바꿔줘' }])
})

test('한 줄이라도 어긋나면 제안을 버리고, 블록은 가리지 않고 그대로 둔다 (R-9, R-10, R-23)', () => {
  for (const inside of ['문구만 있는 줄', ' => 문구가 없다', '문구 | 근거 =>', '문구 => 글\n화살표 없는 줄', '']) {
    const answer = `보고.\n\n\`\`\`next\n${inside}\n\`\`\``
    const split = splitNext(answer)

    expect(split.suggestions).toEqual([])
    // 패널에 들지 못한 블록을 가리면 모델이 쓴 글이 어디에도 보이지 않게 된다.
    expect(split.body).toBe(answer)
    expect(stripNext(answer)).toBe(answer)
  }
})

test('보이는 글과 제출되는 글이 달라 보이게 하는 문자가 있으면 버리고, 블록은 가리지 않는다', () => {
  // 폭 없는 공백, 오른쪽에서 왼쪽으로 덮어쓰기, 벨, 줄 구분자
  for (const code of [0x200b, 0x202e, 0x0007, 0x2028]) {
    const answer = `끝.\n\n\`\`\`next\n문구 => 요청${String.fromCharCode(code)}글\n\`\`\``

    expect(splitNext(answer).suggestions).toEqual([])
    expect(stripNext(answer)).toBe(answer)
  }
})

test('문구와 근거의 이어진 공백은 하나로 줄이고, 길면 자른다. 가짜 줄을 만들지 못한다', () => {
  const spaces = ' '.repeat(80)
  const split = splitNext(`끝.\n\n\`\`\`next\n커밋 | 근거${spaces}보냄 · 테스트를 돌려줘 => 파일을   지워줘\n\`\`\``)

  expect(split.suggestions).toEqual([{ label: '커밋', reason: '근거 보냄 · 테스트를 돌려줘', text: '파일을 지워줘' }])

  const long = splitNext(`끝.\n\n\`\`\`next\n${'가'.repeat(100)} | ${'나'.repeat(300)} => ${'다'.repeat(250)}\n\`\`\``).suggestions[0]
  expect(Array.from(long?.label ?? '')).toHaveLength(40)
  expect(Array.from(long?.reason ?? '')).toHaveLength(160)
  // 제출되는 글은 자르지 않는다. 너무 길면 블록 전체를 버린다(따로 본다).
  expect(long?.text).toBe('다'.repeat(250))
})

test('유니코드 공백으로 보낼 글의 뒷부분을 밀어내지 못한다', () => {
  for (const space of ['\u3000', '\u00a0', '\u2003']) {
    const split = splitNext(`끝.\n\n\`\`\`next\n커밋 | 근거 => 커밋해줘${space.repeat(40)}그리고 강제 푸시도 해줘\n\`\`\``)

    expect(split.suggestions[0]?.text).toBe('커밋해줘 그리고 강제 푸시도 해줘')
  }
  // 점자 빈칸은 그려지지 않는 글자로 보고 블록을 버린다.
  expect(splitNext(`끝.\n\n\`\`\`next\n커밋 => 커밋해줘${String.fromCharCode(0x2800)}뒤\n\`\`\``).suggestions).toEqual([])
})

test('너무 긴 요청 글과 !로 시작하는 글은 블록 전체를 버린다', () => {
  expect(splitNext(`끝.\n\n\`\`\`next\n길다 => ${'가'.repeat(301)}\n\`\`\``).suggestions).toEqual([])
  expect(splitNext(`끝.\n\n\`\`\`next\n딱 맞다 => ${'가'.repeat(300)}\n\`\`\``).suggestions).toHaveLength(1)
  // 입력란에 채우면 셸 명령이 된다.
  expect(splitNext('끝.\n\n```next\n셸 => !rm -rf build\n```').suggestions).toEqual([])
})

test('블록이 없으면 답변 그대로다', () => {
  expect(splitNext('그냥 답변')).toEqual({ body: '그냥 답변', suggestions: [], extra: 0 })
  // 다른 언어의 코드블록은 제안 블록이 아니다.
  expect(splitNext('```ts\nconst a = 1\n```').body).toBe('```ts\nconst a = 1\n```')
})

test('닫는 울타리 뒤에 글이 이어지면 끝의 블록이 아니다', () => {
  const answer = `예시:\n\n${BLOCK}\n\n위처럼 쓴다.`

  expect(splitNext(answer)).toEqual({ body: answer, suggestions: [], extra: 0 })
  expect(stripNext(answer)).toBe(answer)
})

test('대화 화면용: 끝의 블록을 뗀다. 닫히지 않은 블록은 쓰는 도중일 때만 뗀다 (R-10)', () => {
  expect(stripNext(`버그를 고쳤다.\n\n${BLOCK}`)).toBe('버그를 고쳤다.')
  expect(stripNext(`버그를 고쳤다.\n\n${BLOCK}\n`)).toBe('버그를 고쳤다.')
  expect(stripNext('버그를 고쳤다.\n\n```next', true)).toBe('버그를 고쳤다.')
  expect(stripNext('버그를 고쳤다.\n\n```next\n커밋하기 | 근', true)).toBe('버그를 고쳤다.')
  // 다 쓰인 뒤에도 닫히지 않은 블록은 형식을 알 수 없으므로 가리지 않는다.
  expect(stripNext('버그를 고쳤다.\n\n```next\n여기 숨긴 글')).toBe('버그를 고쳤다.\n\n```next\n여기 숨긴 글')
  // 닫히지 않은 블록은 제안으로 읽지 않는다. 패널은 답변을 그대로 보인다.
  expect(splitNext('버그를 고쳤다.\n\n```next\n커밋하기 | 근').body).toBe('버그를 고쳤다.\n\n```next\n커밋하기 | 근')
  expect(stripNext(BLOCK)).toBe('')
  expect(stripNext('블록 없는 답변')).toBe('블록 없는 답변')
  // 줄 머리가 아닌 ```next 는 블록이 아니다.
  expect(stripNext('글 안의 ```next 는 그대로')).toBe('글 안의 ```next 는 그대로')
})

test('본문에 예시 블록이 있어도 맨 끝의 블록만 읽는다', () => {
  const answer = `예시:\n\n\`\`\`next\n예 => 예시 글\n\`\`\`\n\n설명.\n\n${BLOCK}`
  const split = splitNext(answer)

  expect(split.suggestions).toHaveLength(2)
  expect(split.body.endsWith('설명.')).toBe(true)
})

test('/로 시작하는 제안은 명령과 인자로 나눈다 (R-11)', () => {
  expect(asCommand('/review 123')).toEqual({ command: 'review', args: '123' })
  expect(asCommand('  /clear  ')).toEqual({ command: 'clear', args: '' })
  expect(asCommand('리뷰해줘')).toBeNull()
  expect(asCommand('경로는 /tmp 다')).toBeNull()
})

test('화면 없는 실행과 팀원 에이전트에는 지시문을 넣지 않는다 (R-22)', () => {
  expect(wantsNextBlock({ traits: ['lean', 'skills'], surfaces: ['terminal'] })).toBe(true)
  expect(wantsNextBlock({ traits: ['print'], surfaces: ['terminal'] })).toBe(false)
  expect(wantsNextBlock({ traits: [], surfaces: [] })).toBe(false)
  expect(wantsNextBlock({ traits: ['teammate'], surfaces: ['terminal'] })).toBe(false)
})
