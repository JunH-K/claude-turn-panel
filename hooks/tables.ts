// 보고 글을 마크다운 조각과 표 조각으로 나눈다 (R-29).
// 엔진의 Markdown은 패널 안의 표도 터미널 폭에 맞춰 그려서, 패널보다 긴 줄이 꺾여 표가 깨진다.
// 그래서 표는 패널이 칸 상자로 직접 그린다.

const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})(.*)$/
const DELIMITER_CELL = /^:?-+:?$/
const MIN_WEIGHT = 4
const MAX_WEIGHT = 40

export type Segment =
  | { kind: 'markdown'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }

// 이스케이프하지 않은 `|`로 칸을 나눈다. 줄 양 끝의 `|`는 칸이 아니다.
function cellsOf(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) {
    body = body.slice(1)
  }
  if (body.endsWith('|') && !body.endsWith('\\|')) {
    body = body.slice(0, -1)
  }
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < body.length; i += 1) {
    const char = body.charAt(i)
    if (char === '\\' && body.charAt(i + 1) === '|') {
      cell += '|'
      i += 1
    } else if (char === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += char
    }
  }
  cells.push(cell.trim())

  return cells
}

function isRow(line: string): boolean {
  return line.includes('|') && line.trim() !== '' && !/^ {4,}|^\t/.test(line)
}

function isDelimiter(line: string, count: number): boolean {
  if (!line.includes('|') && count > 1) {
    return false
  }
  const cells = cellsOf(line)

  return cells.length === count && cells.every(cell => DELIMITER_CELL.test(cell))
}

/** 표 조각과 그 사이의 마크다운 조각. 울타리 코드블록 안의 표는 마크다운으로 둔다. */
export function splitTables(markdown: string): Segment[] {
  const lines = markdown.split('\n')
  const segments: Segment[] = []
  let text: string[] = []
  let fence: { mark: string; length: number } | null = null
  const flush = (): void => {
    if (text.join('').trim() !== '') {
      segments.push({ kind: 'markdown', text: text.join('\n') })
    }
    text = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const found = FENCE_LINE.exec(line)
    const marks = found?.[1] ?? ''
    if (fence !== null) {
      if (marks.startsWith(fence.mark) && marks.length >= fence.length && (found?.[2] ?? '').trim() === '') {
        fence = null
      }
      text.push(line)
      i += 1
      continue
    }
    if (marks !== '' && !(marks.startsWith('`') && (found?.[2] ?? '').includes('`'))) {
      fence = { mark: marks.charAt(0), length: marks.length }
      text.push(line)
      i += 1
      continue
    }
    const header = isRow(line) ? cellsOf(line) : null
    if (header === null || !isDelimiter(lines[i + 1] ?? '', header.length)) {
      text.push(line)
      i += 1
      continue
    }
    const rows: string[][] = []
    i += 2
    while (i < lines.length && isRow(lines[i] ?? '') && !FENCE_LINE.test(lines[i] ?? '')) {
      // 칸 수는 머리글에 맞춘다. 모자라면 빈 칸, 넘치면 버린다(GFM과 같다).
      const cells = cellsOf(lines[i] ?? '')
      rows.push(header.map((_, index) => cells[index] ?? ''))
      i += 1
    }
    flush()
    segments.push({ kind: 'table', header, rows })
  }
  flush()

  return segments
}

// 한 칸이 화면에서 차지할 폭. 한글·한자 같은 넓은 글자는 두 칸으로 센다.
function cellWidth(text: string): number {
  let width = 0
  for (const char of text) {
    width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(char) ? 2 : 1
  }

  return width
}

/** 열마다 줄 폭(퍼센트). 글이 긴 열이 넓지만, 한 열이 너무 넓거나 좁지 않게 한다. 합은 100을 넘지 않는다. */
export function columnPercents(header: string[], rows: string[][]): number[] {
  const weights = header.map((cell, index) => {
    const longest = Math.max(cellWidth(cell), ...rows.map(row => cellWidth(row[index] ?? '')))

    return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, longest))
  })
  const total = weights.reduce((sum, weight) => sum + weight, 0)

  return weights.map(weight => Math.floor((weight / total) * 100))
}
