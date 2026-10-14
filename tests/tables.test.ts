import { expect, test } from 'claude-code/testing'

import { columnPercents, splitTables } from '../hooks/tables'

test('보고 글을 마크다운 조각과 표 조각으로 나눈다 (R-29)', () => {
  const report = [
    '결과예요.',
    '| 항목 | 결과 | 근거 |',
    '| --- | :---: | ---: |',
    '| 원인 | ✅ 확정 | 커밋에만 있음 |',
    '| Expo 쪽 수정판 | 56.0.0부터 |',
    '',
    '끝.',
  ].join('\n')
  expect(splitTables(report)).toEqual([
    { kind: 'markdown', text: '결과예요.' },
    {
      kind: 'table',
      header: ['항목', '결과', '근거'],
      rows: [
        ['원인', '✅ 확정', '커밋에만 있음'],
        ['Expo 쪽 수정판', '56.0.0부터', ''],
      ],
    },
    { kind: 'markdown', text: '\n끝.' },
  ])
})

test('양 끝 세로줄 없는 표와 이스케이프한 세로줄을 읽는다 (R-29)', () => {
  expect(splitTables('a | b\n--- | ---\n`x \\| y` | z | 넘침')).toEqual([{ kind: 'table', header: ['a', 'b'], rows: [['`x | y`', 'z']] }])
})

test('표가 아닌 글과 울타리 코드블록 안의 표는 마크다운으로 둔다 (R-29)', () => {
  const kept = ['a | b 는 둘 중 하나다', '', '```', '| 항목 | 결과 |', '| --- | --- |', '| 원인 | 확정 |', '```', '| 칸 수가 | 다른 |', '| --- |'].join('\n')
  expect(splitTables(kept)).toEqual([{ kind: 'markdown', text: kept }])
})

test('열 폭은 글 길이를 따르되 너무 넓거나 좁지 않고, 합이 100을 넘지 않는다 (R-29)', () => {
  const percents = columnPercents(['항목', '결과', '근거'], [['원인', '✅', 'media3 1.9.0에서 getAllocator()가 없어지고 getAllocator(PlayerId)로 바뀜']])
  expect(percents.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(100)
  expect(percents[2]).toBeGreaterThan(percents[0] ?? 0)
  expect(Math.min(...percents)).toBeGreaterThan(5)
})
